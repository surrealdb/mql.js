/**
 * MongoDB index specifications ⇄ SurrealDB index definitions.
 *
 * Two translations live here, and they are not inverses of each other:
 *
 *   - forward: a caller's `IndexSpecification` plus `CreateIndexesOptions`
 *     becomes a `DEFINE INDEX` statement;
 *   - back: `INFO FOR TABLE … STRUCTURE` becomes the `IndexDescriptionInfo`
 *     records `listIndexes` reports.
 *
 * The DDL loses information the caller supplied — SurrealDB B-tree indexes are
 * bidirectional, so a `-1` direction has nowhere to go, and a compound key's
 * `FIELDS a, b` cannot say which of the two was descending. Rather than
 * reverse-engineering a key that would be wrong, every index this driver
 * defines carries its original specification as JSON in the SurrealDB
 * `COMMENT`, and the read path prefers that over what it can infer. An index
 * defined outside this driver has no such metadata, so its key is inferred from
 * the columns and index kind instead, with every direction reported as
 * ascending — which is what those indexes actually serve.
 */

import {
	MongoCompatibilityError,
	MongoInvalidArgumentError,
} from "../errors.ts";
import { escapeFieldPath, escapeIdentifier } from "../surreal/sql/escape.ts";
import { isIdField, SURREAL_ID_FIELD } from "../translators/filter/id-field.ts";
import type {
	CreateIndexesOptions,
	IndexDescriptionInfo,
	IndexDirection,
	IndexKey,
	IndexSpecification,
} from "../types.ts";

/** The name MongoDB gives the index on `_id` that every collection has. */
export const ID_INDEX_NAME = "_id_";

/**
 * A resolved index key.
 *
 * A `Map`, not a plain object, because compound-index column order decides which
 * queries the index can serve, and a plain object hoists integer-like keys ahead
 * of the rest. `createIndex([['2024', 1], ['tag', 1]])` therefore keeps the
 * caller's column order all the way to `FIELDS`, and the direction of each
 * column survives into the reported metadata rather than being resorted.
 */
export type ResolvedIndexKey = Map<string, IndexDirection>;

/** The two SurrealDB index kinds this driver can define. */
export type IndexKind = "btree" | "fulltext";

/** A caller's index request, resolved and validated. */
export interface ResolvedIndexDefinition {
	/** MongoDB index name, either supplied or generated from the key. */
	readonly name: string;
	/** The caller's key, exactly as given. */
	readonly key: ResolvedIndexKey;
	/** Which SurrealDB index kind serves this key. */
	readonly kind: IndexKind;
	/** Indexed field paths, with `_id` rewritten to SurrealDB's `id` column. */
	readonly columns: readonly string[];
	readonly unique: boolean;
	readonly sparse: boolean;
	readonly comment: unknown;
}

// ---------------------------------------------------------------------------
// Specification normalisation
// ---------------------------------------------------------------------------

/**
 * True for the direction position of a `[field, direction]` tuple.
 *
 * Mirrors the official driver's `isIndexDirection` (mongodb 7.5.0,
 * `lib/operations/indexes.js`) rather than `IndexDirection` itself — the driver
 * omits `'hashed'` there, so `createIndex(['h', 'hashed'])` is read as a
 * two-field list, not a hashed index. Diverging would change which fields get
 * indexed for the same input.
 */
function isDirectionPosition(value: unknown): boolean {
	return (
		typeof value === "number" ||
		value === "2d" ||
		value === "2dsphere" ||
		value === "text" ||
		value === "geoHaystack"
	);
}

function isSingleIndexTuple(value: unknown): value is [string, IndexDirection] {
	return (
		Array.isArray(value) && value.length === 2 && isDirectionPosition(value[1])
	);
}

/** Fold one specification entry into the key being built. */
function mergeSpecEntry(key: ResolvedIndexKey, entry: unknown): void {
	if (typeof entry === "string") {
		key.set(entry, 1);
		return;
	}
	if (Array.isArray(entry)) {
		key.set(entry[0] as string, (entry[1] as IndexDirection) ?? 1);
		return;
	}
	const pairs =
		entry instanceof Map
			? entry
			: entry !== null && typeof entry === "object"
				? Object.entries(entry as IndexKey)
				: [];
	for (const [field, direction] of pairs) key.set(field, direction);
}

/**
 * Collapse any of the documented `IndexSpecification` forms into one ordered
 * key. Mirrors the official driver's `constructIndexDescriptionMap`, including
 * its rule that a bare field name means ascending.
 */
export function resolveIndexKey(spec: IndexSpecification): ResolvedIndexKey {
	const key: ResolvedIndexKey = new Map();
	const entries =
		!Array.isArray(spec) || isSingleIndexTuple(spec) ? [spec] : spec;

	for (const entry of entries as readonly unknown[]) {
		mergeSpecEntry(key, entry);
	}

	return key;
}

/**
 * Auto-generate an index name from its key, using MongoDB's own
 * `field_1_other_-1` convention. SurrealDB accepts the resulting `-1` once the
 * name is backtick-escaped, so there is no reason to spell it differently and
 * diverge from the names every MongoDB tool expects.
 */
export function generateIndexName(key: ResolvedIndexKey): string {
	return [...key].map(([field, dir]) => `${field}_${dir}`).join("_");
}

/** `{ field: direction }` view of a resolved key, for reporting and metadata. */
export function keyToObject(key: ResolvedIndexKey): IndexKey {
	return Object.fromEntries(key) as IndexKey;
}

// ---------------------------------------------------------------------------
// Option policy
// ---------------------------------------------------------------------------

/*
 * Options accepted and then ignored, and why each is inert rather than
 * unsupported. None of them can change which documents an index matches, so
 * ignoring one cannot produce a wrong answer — which is what separates them from
 * the rejected options below.
 *
 *   - `background`: MongoDB 4.2 removed background builds, so the option is a
 *     no-op there too. SurrealDB's `CONCURRENTLY` is deliberately not wired up
 *     to it: that returns before the index is usable, whereas `createIndex`
 *     promises the opposite.
 *   - `version`, `textIndexVersion`, `2dsphereIndexVersion`: on-disk format
 *     selectors for index implementations SurrealDB does not have.
 *   - `commitQuorum`: replica-set index-build acknowledgement, with no
 *     SurrealDB equivalent to acknowledge.
 *   - `storageEngine`: per-index storage tuning, never observable in results.
 *   - `bits`, `min`, `max`, `bucketSize`: geospatial tuning, reachable only
 *     alongside a `2d`/`geoHaystack` key — and those keys are rejected before
 *     any of these would be read.
 */

/**
 * Options that cannot be honoured, and would change results if ignored. Each
 * message names the option and why SurrealDB cannot serve it.
 */
const REJECTED_OPTIONS: ReadonlyArray<{
	readonly option: keyof CreateIndexesOptions;
	readonly applies: (value: unknown) => boolean;
	readonly reason: string;
}> = [
	{
		option: "expireAfterSeconds",
		applies: (value) => value !== undefined,
		reason:
			"SurrealDB indexes have no TTL clause, so documents would never expire",
	},
	{
		option: "partialFilterExpression",
		applies: (value) => value !== undefined,
		reason:
			"SurrealDB indexes cover every record in the table, so the filter would be ignored and a unique index would reject writes the filter excludes",
	},
	{
		option: "collation",
		applies: (value) => value !== undefined,
		reason:
			"SurrealDB compares strings by code point, so a locale-aware index would report the wrong equality and ordering",
	},
	{
		option: "weights",
		applies: (value) => value !== undefined,
		reason:
			"SurrealDB scores full-text matches with BM25 and takes no per-field weights",
	},
	{
		option: "default_language",
		applies: (value) => value !== undefined,
		reason:
			"stemming is chosen by the SurrealDB analyzer, not per index, so the language would be ignored",
	},
	{
		option: "language_override",
		applies: (value) => value !== undefined,
		reason:
			"SurrealDB analyzers cannot switch language per record, so the field would be ignored",
	},
	{
		option: "wildcardProjection",
		applies: (value) => value !== undefined,
		reason:
			"SurrealDB has no wildcard index, so only the named fields can be indexed",
	},
	{
		option: "hidden",
		applies: (value) => value === true,
		reason:
			"SurrealDB always offers an index to its query planner, so the index would stay in use",
	},
	{
		// MongoDB's default is non-sparse, but it expresses that default by
		// *omitting* the option — so only an explicit `false` is a request this
		// driver has to refuse. SurrealDB indexes skip records missing the field,
		// which is sparse behaviour, and a unique index therefore admits several
		// records with no value where MongoDB would raise E11000 on the second.
		option: "sparse",
		applies: (value) => value === false,
		reason:
			"SurrealDB indexes always skip records missing the indexed field, so a non-sparse index cannot be built",
	},
];

/** Index types MongoDB defines that SurrealDB cannot serve. */
const REJECTED_DIRECTIONS: Readonly<Record<string, string>> = {
	"2d": "SurrealDB has no legacy-coordinate index",
	"2dsphere": "SurrealDB has no geospatial index, so $near cannot be indexed",
	geoHaystack:
		"geoHaystack indexes were removed in MongoDB 5.0 and SurrealDB has no equivalent",
	hashed: "SurrealDB has no hashed index",
};

/**
 * Reject every option this driver cannot honour, so an unsupported request
 * fails at the call site instead of producing an index that quietly does
 * something else.
 */
function assertSupportedIndexOptions(
	options: CreateIndexesOptions | undefined,
): void {
	if (!options) return;

	for (const rule of REJECTED_OPTIONS) {
		if (rule.applies(options[rule.option])) {
			throw new MongoCompatibilityError(
				`Index option '${rule.option}' is not supported: ${rule.reason}`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Key validation
// ---------------------------------------------------------------------------

/**
 * Decide which SurrealDB index kind serves `key`, rejecting anything that would
 * otherwise be silently downgraded to an ordinary B-tree index.
 */
function resolveIndexKind(key: ResolvedIndexKey): IndexKind {
	let textFields = 0;

	for (const [field, direction] of key) {
		if (field.includes("$**")) {
			throw new MongoCompatibilityError(
				`Wildcard index key '${field}' is not supported: SurrealDB has no wildcard index, so name each field explicitly`,
			);
		}

		if (direction === "text") {
			textFields += 1;
			continue;
		}

		const rejection = REJECTED_DIRECTIONS[String(direction)];
		if (rejection) {
			throw new MongoCompatibilityError(
				`Index type '${direction}' on field '${field}' is not supported: ${rejection}`,
			);
		}

		if (direction !== 1 && direction !== -1) {
			throw new MongoInvalidArgumentError(
				`Unsupported index direction for field '${field}': ${JSON.stringify(direction)}. Expected 1, -1 or 'text'`,
			);
		}
	}

	if (textFields === 0) return "btree";

	// SurrealDB has no way to combine a full-text column with an ordinary one in
	// a single index, and splitting the spec would answer `$text` and range
	// queries with two indexes the caller never asked for.
	if (textFields !== key.size) {
		throw new MongoCompatibilityError(
			"A text index cannot be combined with other index types in one specification: define the text fields and the ordinary fields as separate indexes",
		);
	}

	return "fulltext";
}

/**
 * Resolve and validate a caller's `createIndex` arguments.
 *
 * Everything that can be rejected is rejected here, before any statement
 * reaches the server, so a bad request never half-applies.
 */
export function resolveIndexDefinition(
	spec: IndexSpecification,
	options?: CreateIndexesOptions,
): ResolvedIndexDefinition {
	const key = resolveIndexKey(spec);
	if (key.size === 0) {
		throw new MongoInvalidArgumentError("Index keys cannot be empty");
	}

	assertSupportedIndexOptions(options);
	assertValidIdIndexKey(key);
	const kind = resolveIndexKind(key);

	const name = options?.name ?? generateIndexName(key);
	if (options?.name === ID_INDEX_NAME && !isIdIndexKey(key)) {
		throw new MongoInvalidArgumentError(
			`The index name '${ID_INDEX_NAME}' is reserved for the _id index, which must have key pattern { _id: 1 }`,
		);
	}

	return {
		name,
		key,
		kind,
		// `_id` is MongoDB's name for an identity SurrealDB keeps in `id`, so an
		// index on `_id` has to point at the column that actually exists.
		columns: [...key.keys()].map((field) =>
			isIdField(field) ? SURREAL_ID_FIELD : field,
		),
		unique: options?.unique === true,
		sparse: options?.sparse === true,
		comment: options?.comment,
	};
}

/** True when `key` is the implicit `_id` index every collection already has. */
export function isIdIndexKey(key: ResolvedIndexKey): boolean {
	return key.size === 1 && key.get("_id") === 1;
}

/**
 * Reject an `_id` index key MongoDB would reject. Only `{_id: 1}` is legal;
 * every other direction is an error there rather than a new index.
 */
function assertValidIdIndexKey(key: ResolvedIndexKey): void {
	if (key.size === 1 && key.has("_id") && key.get("_id") !== 1) {
		throw new MongoInvalidArgumentError(
			`The field 'key' for an _id index must be { _id: 1 }, but got ${JSON.stringify(keyToObject(key))}`,
		);
	}
}

// ---------------------------------------------------------------------------
// COMMENT metadata
// ---------------------------------------------------------------------------

/**
 * Format version of the JSON this driver stores in a SurrealDB `COMMENT`.
 *
 * Present so a comment written by this driver is distinguishable from one a
 * human wrote, and so a future format change can be recognised rather than
 * mis-parsed.
 */
const METADATA_VERSION = 1;

/**
 * What a driver-defined index records about itself.
 *
 * The `COMMENT` clause is the only per-index storage SurrealDB offers, so the
 * driver's bookkeeping and the caller's own `comment` option share it: both live
 * as fields of one JSON object, and neither overwrites the other.
 */
interface IndexMetadata {
	/** Metadata format version; marks this comment as driver-written. */
	mql: number;
	/** The MongoDB index name, which may differ from the SurrealDB one. */
	name: string;
	/** The caller's key verbatim, including `-1` and `"text"` directions. */
	key: IndexKey;
	unique?: boolean;
	sparse?: boolean;
	/** The caller's `comment` option, kept intact alongside the metadata. */
	comment?: unknown;
}

/** Build the JSON payload for an index's `COMMENT` clause. */
export function encodeIndexMetadata(
	definition: ResolvedIndexDefinition,
): string {
	const metadata: IndexMetadata = {
		mql: METADATA_VERSION,
		name: definition.name,
		key: keyToObject(definition.key),
	};
	if (definition.unique) metadata.unique = true;
	if (definition.sparse) metadata.sparse = true;
	if (definition.comment !== undefined) metadata.comment = definition.comment;
	return JSON.stringify(metadata);
}

/**
 * Read back a `COMMENT` written by `encodeIndexMetadata`.
 *
 * Anything else — a hand-written comment, a future format, malformed JSON — is
 * reported as absent so the caller falls back to inferring the key from the
 * index definition itself.
 */
function decodeIndexMetadata(
	comment: string | undefined,
): IndexMetadata | null {
	if (!comment) return null;
	try {
		const parsed: unknown = JSON.parse(comment);
		const key: unknown = (parsed as IndexMetadata | null)?.key;
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			(parsed as IndexMetadata).mql !== METADATA_VERSION ||
			typeof (parsed as IndexMetadata).name !== "string" ||
			// `typeof null` is `"object"`, and an array is one too, so both are
			// excluded explicitly — a blob whose key is unusable must not be trusted
			// for the name and options either.
			typeof key !== "object" ||
			key === null ||
			Array.isArray(key)
		) {
			return null;
		}
		return parsed as IndexMetadata;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

/**
 * SurrealDB index name for one physical index of a definition.
 *
 * A single-column definition maps one-to-one, so it keeps the MongoDB name. A
 * multi-field text index cannot: SurrealDB rejects `FULLTEXT` over more than
 * one column (`Expected one column, found 2`), so the definition becomes one
 * index per field, and each needs its own name. The MongoDB name stays in the
 * metadata, which is what `listIndexes` groups on and reports.
 */
function physicalIndexName(
	definition: ResolvedIndexDefinition,
	column: string,
): string {
	return definition.kind === "fulltext" && definition.columns.length > 1
		? `${definition.name}_${column}`
		: definition.name;
}

/**
 * Every SurrealDB index name a definition will occupy, in column order.
 *
 * More than one only for a multi-field text index. Callers check these against
 * the names already defined before emitting anything, because a `DEFINE INDEX`
 * that fails partway through the set leaves the earlier ones behind.
 */
export function physicalIndexNames(
	definition: ResolvedIndexDefinition,
): string[] {
	return definition.columns.map((column) =>
		physicalIndexName(definition, column),
	);
}

/** One `DEFINE INDEX` statement plus the bindings it needs. */
export interface IndexStatement {
	readonly sql: string;
	readonly bindings: Record<string, unknown>;
}

/**
 * Build the `DEFINE INDEX` statements for a definition — one per physical
 * index, in column order.
 *
 * The metadata goes in as a bound parameter rather than a quoted literal, so a
 * comment containing quotes or backslashes needs no escaping and cannot break
 * out of the statement.
 */
export function buildIndexStatements(
	definition: ResolvedIndexDefinition,
	escapedTable: string,
	fullTextClause: string,
): IndexStatement[] {
	const metadata = encodeIndexMetadata(definition);

	if (definition.kind === "fulltext") {
		return definition.columns.map((column) => ({
			sql: `DEFINE INDEX ${escapeIdentifier(physicalIndexName(definition, column))} ON ${escapedTable} FIELDS ${escapeFieldPath(column)} ${fullTextClause} COMMENT $mqlIndexMeta`,
			bindings: { mqlIndexMeta: metadata },
		}));
	}

	const fields = definition.columns.map(escapeFieldPath).join(", ");
	const unique = definition.unique ? " UNIQUE" : "";
	return [
		{
			sql: `DEFINE INDEX ${escapeIdentifier(definition.name)} ON ${escapedTable} FIELDS ${fields}${unique} COMMENT $mqlIndexMeta`,
			bindings: { mqlIndexMeta: metadata },
		},
	];
}

// ---------------------------------------------------------------------------
// Reading server definitions
// ---------------------------------------------------------------------------

/**
 * One entry of `INFO FOR TABLE … STRUCTURE`'s `indexes` array.
 *
 * `STRUCTURE` is used in preference to the default `INFO FOR TABLE`, which
 * reports each index as its `DEFINE INDEX` source text: the structured form
 * hands over the columns, the index kind and the comment as separate fields,
 * so nothing has to be recovered by parsing SurrealQL. Available since 3.0.
 */
export interface SurrealIndexInfo {
	name: string;
	cols: string[];
	/** `""` for a plain index, `"UNIQUE"`, or a `FULLTEXT …` clause. */
	index: string;
	comment?: string;
}

/** A physical SurrealDB index paired with the MongoDB index it belongs to. */
export interface PhysicalIndex {
	/** SurrealDB index name, as `REMOVE INDEX` needs it. */
	readonly physicalName: string;
	/** MongoDB index name, which several physical indexes may share. */
	readonly name: string;
}

/** The MongoDB view of a table's indexes, and the SurrealDB indexes behind it. */
export interface IndexInventory {
	/** MongoDB descriptions, `_id_` first. */
	readonly descriptions: IndexDescriptionInfo[];
	/** Every SurrealDB index, tagged with the MongoDB index it implements. */
	readonly physical: readonly PhysicalIndex[];
}

/** Description of the `_id` index every MongoDB collection reports. */
function idIndexDescription(): IndexDescriptionInfo {
	return { name: ID_INDEX_NAME, key: { _id: 1 } };
}

/**
 * Infer a key for an index this driver did not define.
 *
 * Only the columns and the kind are knowable, so every B-tree column is
 * reported ascending. That is not a guess about the caller's intent — it is what
 * the index serves, since a SurrealDB B-tree index has no direction.
 */
function inferKey(info: SurrealIndexInfo): IndexKey {
	const isFullText = info.index.startsWith("FULLTEXT");
	const key: IndexKey = {};
	for (const column of info.cols) {
		key[column === SURREAL_ID_FIELD ? "_id" : column] = isFullText ? "text" : 1;
	}
	return key;
}

/** MongoDB description of one SurrealDB index. */
function describeOne(
	info: SurrealIndexInfo,
	metadata: IndexMetadata | null,
): IndexDescriptionInfo {
	const description: IndexDescriptionInfo = {
		name: metadata?.name ?? info.name,
		key: metadata?.key ?? inferKey(info),
	};

	if (metadata ? metadata.unique : info.index === "UNIQUE") {
		description.unique = true;
	}
	if (metadata?.sparse) description.sparse = true;

	// An index defined outside this driver keeps whatever comment it carries, so
	// nothing the server holds is dropped on the way out.
	const comment = metadata ? metadata.comment : info.comment;
	if (comment !== undefined) description.comment = comment;

	return description;
}

/**
 * Turn `INFO FOR TABLE … STRUCTURE` output into MongoDB index descriptions.
 *
 * Physical indexes sharing a MongoDB name — the per-field indexes of a
 * multi-field text index — collapse into the single description MongoDB would
 * report for them.
 */
export function describeIndexes(
	infos: readonly SurrealIndexInfo[],
): IndexInventory {
	const descriptions: IndexDescriptionInfo[] = [idIndexDescription()];
	const physical: PhysicalIndex[] = [];
	const seen = new Map<string, IndexDescriptionInfo>();

	for (const info of infos) {
		const metadata = decodeIndexMetadata(info.comment);
		const description = describeOne(info, metadata);
		physical.push({ physicalName: info.name, name: description.name });

		// SurrealDB maintains record identity itself, so no index it reports is
		// the `_id` index — but a hand-written `DEFINE INDEX \`_id_\`` can claim
		// the name MongoDB reserves for it. Reporting it would list `_id_` twice
		// and, in the compact `indexInformation` shape, replace the real `_id`
		// entry with whatever that index covers. It stays in `physical`, so
		// `dropIndexes` still removes it.
		if (description.name === ID_INDEX_NAME) continue;

		const existing = seen.get(description.name);
		if (existing) {
			// A later part of a multi-field text index: its fields extend the key
			// already reported for the MongoDB index they jointly implement.
			Object.assign(existing.key, description.key);
			continue;
		}

		seen.set(description.name, description);
		descriptions.push(description);
	}

	return { descriptions, physical };
}

/** The compact `indexInformation()` shape: name → `[field, direction]` pairs. */
export function toCompactIndexInformation(
	descriptions: readonly IndexDescriptionInfo[],
): Record<string, [string, IndexDirection][]> {
	const compact: Record<string, [string, IndexDirection][]> = {};
	for (const description of descriptions) {
		compact[description.name] = Object.entries(description.key) as [
			string,
			IndexDirection,
		][];
	}
	return compact;
}
