/**
 * Index operations: `createIndex(es)`, `dropIndex(es)`, `listIndexes`,
 * `indexes`, `indexExists` and `indexInformation`.
 *
 * The server is the source of truth for every one of them. That matters more
 * here than elsewhere: `Db.collection()` hands back a fresh `Collection` object
 * on each call, so anything remembered per instance is invisible to the next
 * caller, to a second process, and to the same process after a reconnect.
 *
 * `createIndex` reads the existing indexes before defining one, which MongoDB's
 * idempotency contract requires: re-creating an identical index is a successful
 * no-op, while reusing a name for a different specification is an error.
 * SurrealDB has neither behaviour — a repeated `DEFINE INDEX` fails with
 * `The index 'x' already exists` regardless of whether the spec matches — so the
 * comparison happens here.
 */

import {
	MongoErrorCode,
	MongoInvalidArgumentError,
	MongoServerError,
} from "../../errors.ts";
import { escapeIdentifier } from "../../surreal/sql/escape.ts";
import type {
	CreateIndexesOptions,
	Document,
	DropIndexesOptions,
	IndexDescription,
	IndexDescriptionCompact,
	IndexDescriptionInfo,
	IndexInformationOptions,
	IndexSpecification,
	ListIndexesOptions,
} from "../../types.ts";
import {
	buildIndexStatements,
	describeIndexes,
	ID_INDEX_NAME,
	type IndexInventory,
	isIdIndexKey,
	keyToObject,
	physicalIndexNames,
	type ResolvedIndexDefinition,
	resolveIndexDefinition,
	type SurrealIndexInfo,
	toCompactIndexInformation,
} from "../index-definition.ts";
import type { OperationContext } from "../operation-context.ts";
import { assertSupportedIndexOptions } from "../operation-options.ts";

/** Shape of the parts of `INFO FOR TABLE … STRUCTURE` this driver reads. */
interface TableStructure {
	indexes?: SurrealIndexInfo[];
}

/**
 * Read every index defined on the table, in MongoDB's reporting shape.
 *
 * A table with no indexes — including one that does not exist yet, which
 * SurrealDB reports identically — still yields the implicit `_id_` entry, the
 * way MongoDB reports it for a collection that has only ever been written to.
 *
 * Exported because the option gate needs it too: a caller's `hint` has to be
 * checked against the indexes that exist, since SurrealDB ignores a `WITH INDEX`
 * naming one that does not.
 */
export async function readIndexInventory(
	ctx: OperationContext,
): Promise<IndexInventory> {
	const structure = await ctx.executor.query<TableStructure>(
		`INFO FOR TABLE ${ctx.escapedTable} STRUCTURE`,
	);
	const inventory = describeIndexes(structure?.indexes ?? []);
	// Every read is also a chance to refresh the `$text` field list, which the
	// filter translator needs and which no single `Collection` instance can know.
	ctx.indexes.sync(inventory.descriptions);
	return inventory;
}

/** SurrealDB index names implementing the MongoDB index called `name`. */
function physicalNamesFor(inventory: IndexInventory, name: string): string[] {
	return inventory.physical
		.filter((index) => index.name === name)
		.map((index) => index.physicalName);
}

/**
 * True when an existing index is the one being requested.
 *
 * Compares exactly the fields MongoDB compares: the key (order included) and
 * the options that change what the index does. `comment` is excluded because
 * MongoDB treats it as command metadata and re-creating an index with a
 * different comment is a no-op there too.
 */
function isEquivalent(
	existing: IndexDescriptionInfo,
	definition: ResolvedIndexDefinition,
): boolean {
	const requested = keyToObject(definition.key);
	const existingFields = Object.keys(existing.key);
	const requestedFields = Object.keys(requested);

	if (existingFields.length !== requestedFields.length) return false;
	for (const [i, field] of requestedFields.entries()) {
		if (existingFields[i] !== field) return false;
		if (existing.key[field] !== requested[field]) return false;
	}

	return (
		(existing.unique === true) === definition.unique &&
		(existing.sparse === true) === definition.sparse
	);
}

/** Render an index for an error message, the way MongoDB renders one. */
function describeForError(
	name: string,
	key: Record<string, unknown>,
	unique: boolean,
): string {
	const options = unique ? { unique: true } : {};
	return JSON.stringify({ ...options, key, name });
}

/**
 * Define one already-validated index, or establish that it needs no work.
 *
 * Shared by `createIndex` and `createIndexes` so both get the same idempotency
 * and conflict behaviour.
 */
async function defineIndex(
	ctx: OperationContext,
	definition: ResolvedIndexDefinition,
): Promise<string> {
	// `{_id: 1}` names the index every collection already has. MongoDB accepts
	// the call, creates nothing, and hands back the generated name.
	if (isIdIndexKey(definition.key)) return definition.name;

	const inventory = await readIndexInventory(ctx);

	const sameName = inventory.descriptions.find(
		(existing) => existing.name === definition.name,
	);
	if (sameName) {
		if (isEquivalent(sameName, definition)) return definition.name;
		throw new MongoServerError(
			`An existing index has the same name as the requested index. Requested index: ${describeForError(definition.name, keyToObject(definition.key), definition.unique)}, existing index: ${describeForError(sameName.name, sameName.key, sameName.unique === true)}`,
			{ code: MongoErrorCode.IndexKeySpecsConflict },
		);
	}

	const sameKey = inventory.descriptions.find(
		(existing) =>
			existing.name !== ID_INDEX_NAME && isEquivalent(existing, definition),
	);
	if (sameKey) {
		throw new MongoServerError(
			`Index already exists with a different name: ${sameKey.name}`,
			{ code: MongoErrorCode.IndexOptionsConflict },
		);
	}

	// A definition occupies one SurrealDB name per physical index, which for a
	// multi-field text index is derived from the MongoDB name rather than equal to
	// it. Any of those already being taken has to be refused before the first
	// statement runs: `DEFINE INDEX` failing partway through the set would leave
	// the earlier indexes in place carrying metadata that claims the whole key, so
	// `listIndexes` would report fields that are not indexed and the retry would
	// find that index equivalent and succeed as a no-op.
	const taken = new Set(inventory.physical.map((index) => index.physicalName));
	const collision = physicalIndexNames(definition).find((physicalName) =>
		taken.has(physicalName),
	);
	if (collision) {
		throw new MongoServerError(
			`An existing index has the same name as the requested index. Requested index name: ${collision}`,
			{ code: MongoErrorCode.IndexKeySpecsConflict },
		);
	}

	if (definition.kind === "fulltext") {
		const ensureAnalyzer = ctx.dialect.ensureBlankAnalyzerSql();
		if (ensureAnalyzer) await ctx.executor.query(ensureAnalyzer);
	}

	const fullTextClause = `${ctx.dialect.fullTextKeyword} ANALYZER blank BM25 HIGHLIGHTS`;
	for (const statement of buildIndexStatements(
		definition,
		ctx.escapedTable,
		fullTextClause,
	)) {
		await ctx.executor.query(statement.sql, statement.bindings);
	}

	ctx.indexes.add(keyToObject(definition.key), definition.name);
	return definition.name;
}

// `async` rather than returning `defineIndex`'s promise directly, so a
// validation failure rejects the returned promise instead of throwing
// synchronously — `createIndex` never throws before its `await` in MongoDB.
export async function createIndex(
	ctx: OperationContext,
	spec: IndexSpecification,
	options?: CreateIndexesOptions,
): Promise<string> {
	assertSupportedIndexOptions(options);
	return defineIndex(ctx, resolveIndexDefinition(spec, options));
}

export async function createIndexes(
	ctx: OperationContext,
	specs: readonly IndexDescription[],
	options?: CreateIndexesOptions,
): Promise<string[]> {
	assertSupportedIndexOptions(options);

	if (specs.length === 0) {
		throw new MongoInvalidArgumentError(
			"createIndexes requires at least one index specification",
		);
	}

	// Resolve — and therefore validate — every entry before defining any of
	// them, so an unsupported option in the last spec cannot leave the earlier
	// ones already applied.
	const definitions = specs.map((spec) => {
		const { key, ...perIndex } = spec;
		return resolveIndexDefinition(key as IndexSpecification, {
			...options,
			...perIndex,
		});
	});

	const names: string[] = [];
	for (const definition of definitions) {
		names.push(await defineIndex(ctx, definition));
	}
	return names;
}

/**
 * Drop one index by name.
 *
 * Returns the `{nIndexesWas, ok}` command reply the official driver returns,
 * rather than nothing: callers read `nIndexesWas`, and a `Promise<void>` cannot
 * be widened later without breaking them.
 */
export async function dropIndex(
	ctx: OperationContext,
	name: string,
	options?: DropIndexesOptions,
): Promise<Document> {
	assertSupportedIndexOptions(options);

	if (name === ID_INDEX_NAME) {
		throw new MongoServerError("cannot drop _id index", {
			code: MongoErrorCode.InvalidOptions,
		});
	}

	const inventory = await readIndexInventory(ctx);
	const physicalNames = physicalNamesFor(inventory, name);
	if (physicalNames.length === 0) {
		throw new MongoServerError(`index not found with name [${name}]`, {
			code: MongoErrorCode.IndexNotFound,
		});
	}

	const nIndexesWas = inventory.descriptions.length;
	for (const physicalName of physicalNames) {
		await ctx.executor.query(
			`REMOVE INDEX ${escapeIdentifier(physicalName)} ON ${ctx.escapedTable}`,
		);
	}

	ctx.indexes.remove(name);
	return { nIndexesWas, ok: 1 };
}

/**
 * Drop every index except `_id_`, which MongoDB does not allow dropping.
 *
 * Returns `true` on success, matching the official driver's boolean reply. The
 * driver's `false` means "the collection does not exist", which has no analogue
 * here: SurrealDB reports an unwritten table and an empty one identically, so
 * there is nothing to distinguish and the answer is always `true`.
 */
export async function dropIndexes(
	ctx: OperationContext,
	options?: DropIndexesOptions,
): Promise<boolean> {
	assertSupportedIndexOptions(options);

	const inventory = await readIndexInventory(ctx);

	for (const index of inventory.physical) {
		await ctx.executor.query(
			`REMOVE INDEX ${escapeIdentifier(index.physicalName)} ON ${ctx.escapedTable}`,
		);
	}

	ctx.indexes.sync([]);
	return true;
}

/** Every index on the collection, `_id_` first. */
export async function listIndexes(
	ctx: OperationContext,
	options?: ListIndexesOptions,
): Promise<IndexDescriptionInfo[]> {
	assertSupportedIndexOptions(options);

	const { descriptions } = await readIndexInventory(ctx);
	return descriptions;
}

/**
 * True when every named index exists.
 *
 * MongoDB answers `false` for a missing name rather than raising, so a caller
 * can use this as the existence check it looks like.
 */
export async function indexExists(
	ctx: OperationContext,
	names: string | string[],
	options?: ListIndexesOptions,
): Promise<boolean> {
	const descriptions = await listIndexes(ctx, options);
	const existing = new Set(descriptions.map((d) => d.name));
	const wanted = Array.isArray(names) ? names : [names];
	return wanted.every((name) => existing.has(name));
}

export async function indexInformation(
	ctx: OperationContext,
	full: true,
	options?: IndexInformationOptions,
): Promise<IndexDescriptionInfo[]>;
export async function indexInformation(
	ctx: OperationContext,
	full?: false,
	options?: IndexInformationOptions,
): Promise<IndexDescriptionCompact>;
export async function indexInformation(
	ctx: OperationContext,
	full?: boolean,
	options?: IndexInformationOptions,
): Promise<IndexDescriptionCompact | IndexDescriptionInfo[]>;
export async function indexInformation(
	ctx: OperationContext,
	full?: boolean,
	options?: IndexInformationOptions,
): Promise<IndexDescriptionCompact | IndexDescriptionInfo[]> {
	const descriptions = await listIndexes(ctx, options);
	return full ? descriptions : toCompactIndexInformation(descriptions);
}

/**
 * Load the `$text` field list from the server into the operation context.
 *
 * Called on the query path when a filter uses `$text`, because the fields a
 * `$text` search expands to are a property of the collection, not of the
 * `Collection` object the caller happens to be holding.
 */
export async function loadTextFields(ctx: OperationContext): Promise<void> {
	await readIndexInventory(ctx);
}
