/**
 * Public entry point for `@surrealdb/mql`. Everything exported from here
 * forms the contract that downstream code may rely on; internals live in
 * `client/`, `db/`, `collection/`, `cursor/`, `surreal/`, and `translators/`.
 */

export { MongoClient } from "./client/mongo-client.ts";
export { Collection } from "./collection/collection.ts";
export { FindCursor } from "./cursor/find-cursor.ts";
export { Db } from "./db/db.ts";
export {
	MongoAPIError,
	MongoClientError,
	MongoCompatibilityError,
	MongoCursorExhaustedError,
	MongoDriverError,
	MongoError,
	MongoNetworkError,
	MongoNotConnectedError,
	MongoServerError,
} from "./errors.ts";
export { ObjectId } from "./object-id.ts";
export type {
	BulkWriteResult,
	CollectionInfo,
	CountDocumentsOptions,
	DeleteResult,
	Document,
	Filter,
	FindOneAndDeleteOptions,
	FindOneAndReplaceOptions,
	FindOneAndUpdateOptions,
	FindOptions,
	InsertManyResult,
	InsertOneResult,
	ModifyResult,
	MongoClientOptions,
	OptionalId,
	Projection,
	ReplaceOptions,
	Sort,
	UpdateFilter,
	UpdateOptions,
	UpdateResult,
	WithoutId,
} from "./types.ts";
