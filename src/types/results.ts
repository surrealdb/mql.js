import type { ObjectId } from "../object-id.ts";
import type { Document } from "./documents.ts";

/** Result of `Collection.insertOne`. */
export interface InsertOneResult {
	acknowledged: boolean;
	insertedId: ObjectId | string | number;
}

/** Result of `Collection.insertMany`. */
export interface InsertManyResult {
	acknowledged: boolean;
	insertedCount: number;
	insertedIds: Record<number, ObjectId | string | number>;
}

/** Result of `Collection.updateOne` and `Collection.updateMany`. */
export interface UpdateResult {
	acknowledged: boolean;
	matchedCount: number;
	modifiedCount: number;
	upsertedId: ObjectId | string | number | null;
	upsertedCount: number;
}

/** Result of `Collection.deleteOne` and `Collection.deleteMany`. */
export interface DeleteResult {
	acknowledged: boolean;
	deletedCount: number;
}

/**
 * Result of `Collection.findOneAndUpdate`, `Collection.findOneAndDelete`,
 * or `Collection.findOneAndReplace` when `includeResultMetadata` is `true`.
 *
 * Mirrors MongoDB's `ModifyResult` (mongodb.d.ts:5480). `lastErrorObject` is
 * where the command reports what the write did — `{n, updatedExisting}`, plus
 * `upserted` when a document was created. That is the only place an upsert is
 * visible, since `value` is `null` for the "before" of a document that did not
 * previously exist.
 */
export interface ModifyResult<TSchema extends Document = Document> {
	value: TSchema | null;
	lastErrorObject?: Document;
	ok: number;
}

/**
 * Result of `Collection.bulkWrite`, which this driver declares and does not
 * implement — see `src/unsupported.ts`.
 *
 * Nothing produces one yet, so the shape is fixed against MongoDB's
 * `BulkWriteResult` class (mongodb.d.ts:1112) rather than guessed: the counts
 * and id maps it exposes as readonly fields, and no `acknowledged` — that field
 * belongs to `InsertOneResult` and friends, and a real `BulkWriteResult` has
 * never carried one. Getting that wrong now would mean changing the type on the
 * day it becomes producible, which is the breaking change this settles ahead of
 * 1.0.0. The methods MongoDB's class also exposes (`isOk`, `getWriteErrors`, …)
 * are left out until there is an implementation behind them; adding them later
 * is additive.
 */
export interface BulkWriteResult {
	/** Number of documents inserted. */
	readonly insertedCount: number;
	/** Number of documents matched for update. */
	readonly matchedCount: number;
	/** Number of documents modified. */
	readonly modifiedCount: number;
	/** Number of documents deleted. */
	readonly deletedCount: number;
	/** Number of documents upserted. */
	readonly upsertedCount: number;
	/** Ids of inserted documents, keyed by the index of the originating model. */
	readonly insertedIds: Record<number, ObjectId | string | number>;
	/** Ids of upserted documents, keyed by the index of the originating model. */
	readonly upsertedIds: Record<number, ObjectId | string | number>;
}

/**
 * Result of `Admin.listDatabases`. Mirrors MongoDB's `ListDatabasesResult`
 * (mongodb.d.ts:5385).
 *
 * `sizeOnDisk`, `empty`, `totalSize` and `totalSizeMb` are optional in MongoDB's
 * own type and are omitted here: SurrealDB reports no per-database size, and
 * MongoDB itself omits them for `listDatabases({nameOnly: true})`.
 */
export interface ListDatabasesResult {
	databases: ({
		name: string;
		sizeOnDisk?: number;
		empty?: boolean;
	} & Document)[];
	totalSize?: number;
	totalSizeMb?: number;
	ok: 1 | 0;
}
