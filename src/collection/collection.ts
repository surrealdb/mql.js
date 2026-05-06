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
import type { Db } from "../db/db.ts";
import { escapeIdentifier } from "../surreal/sql/escape.ts";
import {
	resolveDialect,
	type SurrealDialect,
} from "../translators/dialect/index.ts";
import type {
	CountDocumentsOptions,
	CreateIndexOptions,
	DeleteResult,
	Document,
	Filter,
	FindOneAndDeleteOptions,
	FindOneAndReplaceOptions,
	FindOneAndUpdateOptions,
	FindOptions,
	IndexDescription,
	IndexSpecification,
	InsertManyResult,
	InsertOneResult,
	ModifyResult,
	OptionalId,
	ReplaceOptions,
	UpdateFilter,
	UpdateOptions,
	UpdateResult,
	WithoutId,
} from "../types.ts";
import { IndexRegistry } from "./index-registry.ts";
import type { OperationContext } from "./operation-context.ts";
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
	createIndex as createIndexOp,
	dropIndex as dropIndexOp,
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

	/** Build the per-operation context once per call. */
	private context(): OperationContext {
		const dialect = this.resolveDialect();
		return {
			executor: this._db._client._executor,
			collectionName: this.collectionName,
			escapedTable: escapeIdentifier(this.collectionName),
			dialect,
			indexes: this._indexRegistry,
		};
	}

	private resolveDialect(): SurrealDialect {
		return resolveDialect(this._db._client.serverVersion);
	}

	// -----------------------------------------------------------------------
	// INSERT
	// -----------------------------------------------------------------------

	insertOne(doc: OptionalId<TSchema>): Promise<InsertOneResult> {
		return insertOneOp(this.context(), doc);
	}

	insertMany(docs: OptionalId<TSchema>[]): Promise<InsertManyResult> {
		return insertManyOp(this.context(), docs);
	}

	// -----------------------------------------------------------------------
	// FIND
	// -----------------------------------------------------------------------

	find(filter?: Filter<TSchema>, options?: FindOptions): FindCursor<TSchema> {
		const ctx = this.context();
		const runner: FindRunner<TSchema> = (state: FindCursorState) =>
			executeFindOp<TSchema>(ctx, state.filter, {
				sort: state.sort,
				limit: state.limit,
				skip: state.skip,
				projectionFields: state.projectionFields,
				projectionExcludeFields: state.projectionExcludeFields,
				projectionIncludeId: state.projectionIncludeId,
			});
		return new FindCursor<TSchema>(
			runner as FindRunner<Document>,
			filter as Document,
			options,
		);
	}

	findOne(
		filter?: Filter<TSchema>,
		options?: FindOptions,
	): Promise<TSchema | null> {
		return findOneOp<TSchema>(this.context(), filter, options);
	}

	// -----------------------------------------------------------------------
	// UPDATE
	// -----------------------------------------------------------------------

	updateOne(
		filter: Filter<TSchema>,
		update: UpdateFilter<TSchema>,
		options?: UpdateOptions,
	): Promise<UpdateResult> {
		return updateOneOp(this.context(), filter, update, options);
	}

	updateMany(
		filter: Filter<TSchema>,
		update: UpdateFilter<TSchema>,
		options?: UpdateOptions,
	): Promise<UpdateResult> {
		return updateManyOp(this.context(), filter, update, options);
	}

	// -----------------------------------------------------------------------
	// REPLACE
	// -----------------------------------------------------------------------

	replaceOne(
		filter: Filter<TSchema>,
		replacement: WithoutId<TSchema>,
		options?: ReplaceOptions,
	): Promise<UpdateResult> {
		return replaceOneOp(this.context(), filter, replacement, options);
	}

	// -----------------------------------------------------------------------
	// DELETE
	// -----------------------------------------------------------------------

	deleteOne(filter: Filter<TSchema>): Promise<DeleteResult> {
		return deleteOneOp(this.context(), filter);
	}

	deleteMany(filter?: Filter<TSchema>): Promise<DeleteResult> {
		return deleteManyOp(this.context(), filter);
	}

	// -----------------------------------------------------------------------
	// COUNT / DISTINCT
	// -----------------------------------------------------------------------

	countDocuments(
		filter?: Filter<TSchema>,
		options?: CountDocumentsOptions,
	): Promise<number> {
		return countDocumentsOp(this.context(), filter, options);
	}

	estimatedDocumentCount(): Promise<number> {
		return estimatedDocumentCountOp(this.context());
	}

	distinct<T = unknown>(key: string, filter?: Filter<TSchema>): Promise<T[]> {
		return distinctOp<T, TSchema>(this.context(), key, filter);
	}

	// -----------------------------------------------------------------------
	// INDEXES
	// -----------------------------------------------------------------------

	createIndex(
		spec: IndexSpecification,
		options?: CreateIndexOptions,
	): Promise<string> {
		return createIndexOp(this.context(), spec, options);
	}

	dropIndex(name: string): Promise<void> {
		return dropIndexOp(this.context(), name);
	}

	listIndexes(): IndexDescription[] {
		return listIndexesOp(this.context());
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
	findOneAndUpdate(
		filter: Filter<TSchema>,
		update: UpdateFilter<TSchema>,
		options?: FindOneAndUpdateOptions,
	): Promise<TSchema | ModifyResult<TSchema> | null> {
		return findOneAndUpdateOp(this.context(), filter, update, options);
	}

	findOneAndDelete(
		filter: Filter<TSchema>,
		options?: FindOneAndDeleteOptions,
	): Promise<TSchema | null>;
	findOneAndDelete(
		filter: Filter<TSchema>,
		options: FindOneAndDeleteOptions & { includeResultMetadata: true },
	): Promise<ModifyResult<TSchema>>;
	findOneAndDelete(
		filter: Filter<TSchema>,
		options?: FindOneAndDeleteOptions,
	): Promise<TSchema | ModifyResult<TSchema> | null> {
		return findOneAndDeleteOp(this.context(), filter, options);
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
	findOneAndReplace(
		filter: Filter<TSchema>,
		replacement: WithoutId<TSchema>,
		options?: FindOneAndReplaceOptions,
	): Promise<TSchema | ModifyResult<TSchema> | null> {
		return findOneAndReplaceOp(this.context(), filter, replacement, options);
	}
}

/** @internal Factory that avoids circular-import issues. */
export function createCollection<TSchema extends Document>(
	db: Db,
	name: string,
): Collection<TSchema> {
	return new Collection<TSchema>(db, name);
}
