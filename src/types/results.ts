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

/** Result of a bulk write operation. */
export interface BulkWriteResult {
	acknowledged: boolean;
	insertedCount: number;
	matchedCount: number;
	modifiedCount: number;
	deletedCount: number;
	upsertedCount: number;
	insertedIds: Record<number, ObjectId | string | number>;
	upsertedIds: Record<number, ObjectId | string | number>;
}
