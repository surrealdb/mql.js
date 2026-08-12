/**
 * MongoDB-compatible Collection facade.
 *
 * The class itself is thin — every CRUD method delegates to a focused
 * function in `src/collection/operations/` that takes an
 * `OperationContext`. That keeps the class's only responsibility "expose
 * the MongoDB Collection surface" while the per-operation modules stay
 * easy to test and extend.
 */

import type { FindCursorState, FindRunner } from "../cursor/find-cursor.ts";
import { FindCursor } from "../cursor/find-cursor.ts";
import { ListIndexesCursor } from "../cursor/list-indexes-cursor.ts";
import { listTableNames } from "../db/database-operations.ts";
import type { Db } from "../db/db.ts";
import { MongoAPIError } from "../errors.ts";
import { sessionExecutor } from "../session/client-session.ts";
import { escapeIdentifier } from "../surreal/sql/escape.ts";
import {
	resolveDialect,
	type SurrealDialect,
} from "../translators/dialect/index.ts";
import type {
	AggregateOptions,
	AggregationCursor,
	AnyBulkWriteOperation,
	BulkWriteOptions,
	BulkWriteResult,
	ChangeStream,
	ChangeStreamDocument,
	ChangeStreamOptions,
	CountDocumentsOptions,
	CreateIndexesOptions,
	DeleteOptions,
	DeleteResult,
	DistinctOptions,
	Document,
	DropCollectionOptions,
	DropIndexesOptions,
	EstimatedDocumentCountOptions,
	Filter,
	FindOneAndDeleteOptions,
	FindOneAndReplaceOptions,
	FindOneAndUpdateOptions,
	FindOptions,
	IndexDescription,
	IndexDescriptionCompact,
	IndexDescriptionInfo,
	IndexInformationOptions,
	IndexSpecification,
	InsertManyResult,
	InsertOneOptions,
	InsertOneResult,
	ListIndexesOptions,
	ListSearchIndexesCursor,
	ListSearchIndexesOptions,
	ModifyResult,
	OperationOptions,
	OptionalId,
	OrderedBulkOperation,
	RenameOptions,
	ReplaceOptions,
	SearchIndexDescription,
	UnorderedBulkOperation,
	UpdateFilter,
	UpdateOptions,
	UpdateResult,
	WithoutId,
} from "../types.ts";
import {
	AGGREGATION,
	BULK_WRITE,
	CHANGE_STREAMS,
	RENAME_COLLECTION,
	SEARCH_INDEXES,
	unsupported,
} from "../unsupported.ts";
import { IndexRegistry } from "./index-registry.ts";
import type { OperationContext } from "./operation-context.ts";
import type { AnyOperationOptions } from "./operation-options.ts";
import { assertSupportedOptions } from "./operation-options.ts";
import {
	countDocuments as countDocumentsOp,
	estimatedDocumentCount as estimatedDocumentCountOp,
} from "./operations/count.ts";
import {
	deleteMany as deleteManyOp,
	deleteOne as deleteOneOp,
} from "./operations/delete.ts";
import { distinct as distinctOp } from "./operations/distinct.ts";
import {
	executeFind as executeFindOp,
	findOne as findOneOp,
} from "./operations/find.ts";
import {
	findOneAndDelete as findOneAndDeleteOp,
	findOneAndReplace as findOneAndReplaceOp,
	findOneAndUpdate as findOneAndUpdateOp,
} from "./operations/find-and-modify.ts";
import {
	createIndexes as createIndexesOp,
	createIndex as createIndexOp,
	dropIndexes as dropIndexesOp,
	dropIndex as dropIndexOp,
	indexExists as indexExistsOp,
	indexInformation as indexInformationOp,
	listIndexes as listIndexesOp,
} from "./operations/indexes.ts";
import {
	insertMany as insertManyOp,
	insertOne as insertOneOp,
} from "./operations/insert.ts";
import { replaceOne as replaceOneOp } from "./operations/replace.ts";
import {
	updateMany as updateManyOp,
	updateOne as updateOneOp,
} from "./operations/update.ts";

export class Collection<TSchema extends Document = Document> {
	/** The collection (table) name. */
	readonly collectionName: string;

	/** @internal */
	readonly _db: Db;

	/** @internal Owned index/text-field state. */
	private readonly _indexRegistry = new IndexRegistry();

	/** @internal */
	constructor(db: Db, name: string) {
		this._db = db;
		this.collectionName = name;
	}

	/**
	 * @internal Backwards-compatibility shim: integration tests still read
	 * `_textFields` directly. Returns a mutable array so historical
	 * test patterns ("expect _textFields to contain X") keep working.
	 */
	get _textFields(): string[] {
		return [...this._indexRegistry.textFields];
	}

	/**
	 * Build the per-operation context once per call.
	 *
	 * Asynchronous because of `session`: the executor an operation runs through is
	 * whatever that session says, and for a session in a transaction the first such
	 * question is what opens the transaction on the server. Resolving it here — per
	 * call, from the caller's own options — is the whole of honouring a session, and
	 * is why no operation module mentions one.
	 */
	private async context(
		options?: AnyOperationOptions,
	): Promise<OperationContext> {
		const client = this._db._client;
		const connection = this._db._connection;
		const executor = await sessionExecutor(
			options?.session,
			client,
			this._db.databaseName,
		);
		const inTransaction = executor !== connection;
		return {
			executor,
			inTransaction,
			connection,
			collectionName: this.collectionName,
			escapedTable: escapeIdentifier(this.collectionName),
			// Read after the executor, which for a session has just brought the
			// connection up: the dialect is chosen from the server's version.
			dialect: this.resolveDialect(),
			// A caller's transaction gets a throwaway registry. The index list it
			// would cache is provisional — an index its `createIndex` defined may
			// still be rolled back, and one its `dropIndex` removed may still come
			// back — so writing it into the collection's own cache would leave a
			// later `$text` expanding to fields that are not indexed, or refusing to
			// expand to fields that are.
			indexes: inTransaction ? new IndexRegistry() : this._indexRegistry,
			defaults: client.defaults,
		};
	}

	private resolveDialect(): SurrealDialect {
		return resolveDialect(this._db._client.serverVersion);
	}

	// -----------------------------------------------------------------------
	// INSERT
	// -----------------------------------------------------------------------

	async insertOne(
		doc: OptionalId<TSchema>,
		options?: InsertOneOptions,
	): Promise<InsertOneResult> {
		return insertOneOp(await this.context(options), doc, options);
	}

	async insertMany(
		docs: OptionalId<TSchema>[],
		options?: BulkWriteOptions,
	): Promise<InsertManyResult> {
		return insertManyOp(await this.context(options), docs, options);
	}

	// -----------------------------------------------------------------------
	// FIND
	// -----------------------------------------------------------------------

	find(filter?: Filter<TSchema>, options?: FindOptions): FindCursor<TSchema> {
		// The cursor owns `sort`/`limit`/`skip`/`projection`, since its chaining
		// methods can still change them; everything else the caller passed is
		// captured here and reaches the query untouched.
		//
		// The context is resolved inside the runner rather than here, because
		// `find()` hands back a cursor without awaiting anything: a session's
		// transaction is opened by the query, not by building the cursor — which is
		// also what lets a rewound cursor re-read the transaction's current view.
		const runner: FindRunner<TSchema> = async (state: FindCursorState) =>
			executeFindOp<TSchema>(
				await this.context(options),
				state.filter,
				{
					sort: state.sort,
					limit: state.limit,
					skip: state.skip,
					projectionFields: state.projectionFields,
					projectionExcludeFields: state.projectionExcludeFields,
					projectionIncludeId: state.projectionIncludeId,
				},
				options,
			);
		return new FindCursor<TSchema>(
			runner as FindRunner<Document>,
			filter as Document,
			options,
		);
	}

	async findOne(
		filter?: Filter<TSchema>,
		options?: FindOptions,
	): Promise<TSchema | null> {
		return findOneOp<TSchema>(await this.context(options), filter, options);
	}

	// -----------------------------------------------------------------------
	// UPDATE
	// -----------------------------------------------------------------------

	async updateOne(
		filter: Filter<TSchema>,
		update: UpdateFilter<TSchema>,
		options?: UpdateOptions,
	): Promise<UpdateResult> {
		return updateOneOp(await this.context(options), filter, update, options);
	}

	async updateMany(
		filter: Filter<TSchema>,
		update: UpdateFilter<TSchema>,
		options?: UpdateOptions,
	): Promise<UpdateResult> {
		return updateManyOp(await this.context(options), filter, update, options);
	}

	// -----------------------------------------------------------------------
	// REPLACE
	// -----------------------------------------------------------------------

	async replaceOne(
		filter: Filter<TSchema>,
		replacement: WithoutId<TSchema>,
		options?: ReplaceOptions,
	): Promise<UpdateResult> {
		return replaceOneOp(
			await this.context(options),
			filter,
			replacement,
			options,
		);
	}

	// -----------------------------------------------------------------------
	// DELETE
	// -----------------------------------------------------------------------

	async deleteOne(
		filter: Filter<TSchema>,
		options?: DeleteOptions,
	): Promise<DeleteResult> {
		return deleteOneOp(await this.context(options), filter, options);
	}

	async deleteMany(
		filter?: Filter<TSchema>,
		options?: DeleteOptions,
	): Promise<DeleteResult> {
		return deleteManyOp(await this.context(options), filter, options);
	}

	// -----------------------------------------------------------------------
	// COUNT / DISTINCT
	// -----------------------------------------------------------------------

	async countDocuments(
		filter?: Filter<TSchema>,
		options?: CountDocumentsOptions,
	): Promise<number> {
		return countDocumentsOp(await this.context(options), filter, options);
	}

	async estimatedDocumentCount(
		options?: EstimatedDocumentCountOptions,
	): Promise<number> {
		return estimatedDocumentCountOp(await this.context(options), options);
	}

	async distinct<T = unknown>(
		key: string,
		filter?: Filter<TSchema>,
		options?: DistinctOptions,
	): Promise<T[]> {
		return distinctOp<T, TSchema>(
			await this.context(options),
			key,
			filter,
			options,
		);
	}

	// -----------------------------------------------------------------------
	// INDEXES
	// -----------------------------------------------------------------------

	async createIndex(
		spec: IndexSpecification,
		options?: CreateIndexesOptions,
	): Promise<string> {
		return createIndexOp(await this.context(options), spec, options);
	}

	async createIndexes(
		specs: IndexDescription[],
		options?: CreateIndexesOptions,
	): Promise<string[]> {
		return createIndexesOp(await this.context(options), specs, options);
	}

	async dropIndex(
		name: string,
		options?: DropIndexesOptions,
	): Promise<Document> {
		return dropIndexOp(await this.context(options), name, options);
	}

	async dropIndexes(options?: DropIndexesOptions): Promise<boolean> {
		return dropIndexesOp(await this.context(options), options);
	}

	/**
	 * Cursor over the collection's indexes.
	 *
	 * Returns a cursor rather than an array because that is the shape MongoDB
	 * consumers write against — `await col.listIndexes().toArray()`.
	 */
	listIndexes(options?: ListIndexesOptions): ListIndexesCursor {
		// The gate — and the session — are resolved inside the runner rather than
		// here, so an option this driver refuses rejects the iteration the way
		// MongoDB's cursor reports a bad option: `listIndexes()` itself only ever
		// hands back a cursor.
		return new ListIndexesCursor(async () =>
			listIndexesOp(await this.context(options), options),
		);
	}

	/**
	 * The collection's indexes as an array, or as a compact
	 * `{ name: [[field, direction], …] }` map when `full` is `false`.
	 *
	 * `full` defaults to `true` here, which is the opposite of
	 * `indexInformation`'s default — matching the official driver, where the two
	 * methods differ in exactly that way.
	 */
	indexes(
		options: IndexInformationOptions & { full?: true },
	): Promise<IndexDescriptionInfo[]>;
	indexes(
		options: IndexInformationOptions & { full: false },
	): Promise<IndexDescriptionCompact>;
	indexes(
		options: IndexInformationOptions,
	): Promise<IndexDescriptionCompact | IndexDescriptionInfo[]>;
	indexes(options?: ListIndexesOptions): Promise<IndexDescriptionInfo[]>;
	async indexes(
		options?: IndexInformationOptions,
	): Promise<IndexDescriptionCompact | IndexDescriptionInfo[]> {
		return indexInformationOp(
			await this.context(options),
			options?.full ?? true,
			options,
		);
	}

	async indexExists(
		indexes: string | string[],
		options?: ListIndexesOptions,
	): Promise<boolean> {
		return indexExistsOp(await this.context(options), indexes, options);
	}

	indexInformation(
		options: IndexInformationOptions & { full: true },
	): Promise<IndexDescriptionInfo[]>;
	indexInformation(
		options?: IndexInformationOptions & { full?: false },
	): Promise<IndexDescriptionCompact>;
	indexInformation(
		options?: IndexInformationOptions,
	): Promise<IndexDescriptionCompact | IndexDescriptionInfo[]>;
	async indexInformation(
		options?: IndexInformationOptions,
	): Promise<IndexDescriptionCompact | IndexDescriptionInfo[]> {
		return indexInformationOp(
			await this.context(options),
			options?.full,
			options,
		);
	}

	// -----------------------------------------------------------------------
	// FIND-AND-MODIFY
	// -----------------------------------------------------------------------

	findOneAndUpdate(
		filter: Filter<TSchema>,
		update: UpdateFilter<TSchema>,
		options?: FindOneAndUpdateOptions,
	): Promise<TSchema | null>;
	findOneAndUpdate(
		filter: Filter<TSchema>,
		update: UpdateFilter<TSchema>,
		options: FindOneAndUpdateOptions & { includeResultMetadata: true },
	): Promise<ModifyResult<TSchema>>;
	async findOneAndUpdate(
		filter: Filter<TSchema>,
		update: UpdateFilter<TSchema>,
		options?: FindOneAndUpdateOptions,
	): Promise<TSchema | ModifyResult<TSchema> | null> {
		return findOneAndUpdateOp(
			await this.context(options),
			filter,
			update,
			options,
		);
	}

	findOneAndDelete(
		filter: Filter<TSchema>,
		options?: FindOneAndDeleteOptions,
	): Promise<TSchema | null>;
	findOneAndDelete(
		filter: Filter<TSchema>,
		options: FindOneAndDeleteOptions & { includeResultMetadata: true },
	): Promise<ModifyResult<TSchema>>;
	async findOneAndDelete(
		filter: Filter<TSchema>,
		options?: FindOneAndDeleteOptions,
	): Promise<TSchema | ModifyResult<TSchema> | null> {
		return findOneAndDeleteOp(await this.context(options), filter, options);
	}

	findOneAndReplace(
		filter: Filter<TSchema>,
		replacement: WithoutId<TSchema>,
		options?: FindOneAndReplaceOptions,
	): Promise<TSchema | null>;
	findOneAndReplace(
		filter: Filter<TSchema>,
		replacement: WithoutId<TSchema>,
		options: FindOneAndReplaceOptions & { includeResultMetadata: true },
	): Promise<ModifyResult<TSchema>>;
	async findOneAndReplace(
		filter: Filter<TSchema>,
		replacement: WithoutId<TSchema>,
		options?: FindOneAndReplaceOptions,
	): Promise<TSchema | ModifyResult<TSchema> | null> {
		return findOneAndReplaceOp(
			await this.context(options),
			filter,
			replacement,
			options,
		);
	}

	// -----------------------------------------------------------------------
	// COLLECTION LIFECYCLE AND INTROSPECTION
	// -----------------------------------------------------------------------

	/**
	 * Drop this collection.
	 *
	 * The same operation as `Db.dropCollection(collectionName)`, addressed from
	 * the collection.
	 */
	async drop(options?: DropCollectionOptions): Promise<boolean> {
		return this._db.dropCollection(this.collectionName, options);
	}

	/**
	 * The options this collection was created with.
	 *
	 * Always `{}`, and that is the answer rather than a placeholder: MongoDB
	 * reports `{}` for a collection created without any, and every option that
	 * would appear here — `capped`, `size`, `max`, `validator`, `viewOn`,
	 * `timeseries` — is refused by `createCollection`, so no collection this
	 * driver creates can have one. A collection that does not exist raises, as it
	 * does in MongoDB.
	 */
	async options(options?: OperationOptions): Promise<Document> {
		await this.assertExists(options);
		return {};
	}

	/**
	 * Whether this is a capped collection.
	 *
	 * Always `false`. SurrealDB has no fixed-size tables and
	 * `createCollection({capped: true})` is refused, so this is derived rather
	 * than assumed.
	 */
	async isCapped(options?: OperationOptions): Promise<boolean> {
		await this.assertExists(options);
		return false;
	}

	/**
	 * Raise MongoDB's own error when this collection does not exist.
	 *
	 * `options()` and `isCapped()` report *about* a collection rather than
	 * operating on one, and MongoDB refuses both for a namespace it cannot find —
	 * with a bare `MongoAPIError` carrying no code, measured against 8.2. That is
	 * the one place this driver's "a missing collection reads as empty" behaviour
	 * would give the wrong answer: `false` would claim the collection exists and
	 * is not capped.
	 */
	private async assertExists(options?: OperationOptions): Promise<void> {
		// The same gate every other method applies, so an option a caller believes
		// will apply is refused here too rather than dropped.
		assertSupportedOptions(options);
		const executor = await this._db._commandExecutor(options);
		const tables = await listTableNames(executor);
		if (!tables.includes(this.collectionName)) {
			throw new MongoAPIError(
				`collection ${this._db.databaseName}.${this.collectionName} not found`,
			);
		}
	}

	// -----------------------------------------------------------------------
	// NOT IMPLEMENTED
	//
	// Each of these is declared with the parameters and return type it will have
	// when it becomes real, so filling one in is additive rather than breaking —
	// which is why the signature is written as an overload and the body takes no
	// arguments. The declared signature is the API; the empty implementation says
	// that nothing about the call is even looked at before it is refused.
	// -----------------------------------------------------------------------

	/**
	 * Not implemented. MongoDB returns an `AggregationCursor` here without
	 * contacting the server, so this throws where MongoDB would not have failed
	 * until the cursor was iterated — see `src/unsupported.ts`.
	 */
	aggregate<T extends Document = Document>(
		pipeline?: Document[],
		options?: AggregateOptions,
	): AggregationCursor<T>;
	aggregate<T extends Document = Document>(): AggregationCursor<T> {
		throw unsupported("Collection.aggregate()", AGGREGATION);
	}

	/** Not implemented — see `src/unsupported.ts`. */
	bulkWrite(
		operations: readonly AnyBulkWriteOperation<TSchema>[],
		options?: BulkWriteOptions,
	): Promise<BulkWriteResult>;
	async bulkWrite(): Promise<BulkWriteResult> {
		throw unsupported("Collection.bulkWrite()", BULK_WRITE);
	}

	/**
	 * Not implemented. MongoDB returns a builder here without contacting the
	 * server, so this throws where MongoDB would not have failed until
	 * `execute()` — see `src/unsupported.ts`.
	 */
	initializeOrderedBulkOp(options?: BulkWriteOptions): OrderedBulkOperation;
	initializeOrderedBulkOp(): OrderedBulkOperation {
		throw unsupported("Collection.initializeOrderedBulkOp()", BULK_WRITE);
	}

	/**
	 * Not implemented. MongoDB returns a builder here without contacting the
	 * server, so this throws where MongoDB would not have failed until
	 * `execute()` — see `src/unsupported.ts`.
	 */
	initializeUnorderedBulkOp(options?: BulkWriteOptions): UnorderedBulkOperation;
	initializeUnorderedBulkOp(): UnorderedBulkOperation {
		throw unsupported("Collection.initializeUnorderedBulkOp()", BULK_WRITE);
	}

	/**
	 * Not implemented. MongoDB returns a `ChangeStream` here without contacting
	 * the server, so this throws where MongoDB would have surfaced the failure on
	 * the stream's `'error'` event — see `src/unsupported.ts`.
	 */
	watch<
		TLocal extends Document = TSchema,
		TChange extends Document = ChangeStreamDocument<TLocal>,
	>(
		pipeline?: Document[],
		options?: ChangeStreamOptions,
	): ChangeStream<TLocal, TChange>;
	watch<
		TLocal extends Document = TSchema,
		TChange extends Document = ChangeStreamDocument<TLocal>,
	>(): ChangeStream<TLocal, TChange> {
		throw unsupported("Collection.watch()", CHANGE_STREAMS);
	}

	/** Not implemented — see `src/unsupported.ts`. */
	rename(newName: string, options?: RenameOptions): Promise<Collection>;
	async rename(): Promise<Collection> {
		throw unsupported("Collection.rename()", RENAME_COLLECTION);
	}

	/**
	 * Not implemented. MongoDB returns a cursor here without contacting the
	 * server, so this throws where MongoDB would not have failed until the cursor
	 * was iterated — see `src/unsupported.ts`.
	 */
	listSearchIndexes(
		options?: ListSearchIndexesOptions,
	): ListSearchIndexesCursor;
	listSearchIndexes(
		name: string,
		options?: ListSearchIndexesOptions,
	): ListSearchIndexesCursor;
	listSearchIndexes(): ListSearchIndexesCursor {
		throw unsupported("Collection.listSearchIndexes()", SEARCH_INDEXES);
	}

	/** Not implemented — see `src/unsupported.ts`. */
	createSearchIndex(description: SearchIndexDescription): Promise<string>;
	async createSearchIndex(): Promise<string> {
		throw unsupported("Collection.createSearchIndex()", SEARCH_INDEXES);
	}

	/** Not implemented — see `src/unsupported.ts`. */
	createSearchIndexes(
		descriptions: SearchIndexDescription[],
	): Promise<string[]>;
	async createSearchIndexes(): Promise<string[]> {
		throw unsupported("Collection.createSearchIndexes()", SEARCH_INDEXES);
	}

	/** Not implemented — see `src/unsupported.ts`. */
	dropSearchIndex(name: string): Promise<void>;
	async dropSearchIndex(): Promise<void> {
		throw unsupported("Collection.dropSearchIndex()", SEARCH_INDEXES);
	}

	/** Not implemented — see `src/unsupported.ts`. */
	updateSearchIndex(name: string, definition: Document): Promise<void>;
	async updateSearchIndex(): Promise<void> {
		throw unsupported("Collection.updateSearchIndex()", SEARCH_INDEXES);
	}
}

/** @internal Factory that avoids circular-import issues. */
export function createCollection<TSchema extends Document>(
	db: Db,
	name: string,
): Collection<TSchema> {
	return new Collection<TSchema>(db, name);
}
