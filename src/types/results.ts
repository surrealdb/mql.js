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
 */
export interface ModifyResult<TSchema extends Document = Document> {
	value: TSchema | null;
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
