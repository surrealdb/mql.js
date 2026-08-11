/**
 * Public entry point for `@surrealdb/mql`. Everything exported from here
 * forms the contract that downstream code may rely on; internals live in
 * `client/`, `db/`, `collection/`, `cursor/`, `surreal/`, and `translators/`.
 */

export { MongoClient } from "./client/mongo-client.ts";
export { Collection } from "./collection/collection.ts";
export { FindCursor } from "./cursor/find-cursor.ts";
export {
	ListIndexesCursor,
	type ListIndexesRunner,
} from "./cursor/list-indexes-cursor.ts";
export { Db } from "./db/db.ts";
export type {
	MongoErrorCodeValue,
	MongoServerErrorOptions,
	WriteError,
} from "./errors.ts";
export {
	codeNameFor,
	MongoAPIError,
	MongoClientError,
	MongoCompatibilityError,
	MongoCursorExhaustedError,
	MongoCursorInUseError,
	MongoDriverError,
	MongoError,
	MongoErrorCode,
	MongoExpiredSessionError,
	MongoInvalidArgumentError,
	MongoNetworkError,
	MongoNetworkTimeoutError,
	MongoNotConnectedError,
	MongoOperationTimeoutError,
	MongoParseError,
	MongoRuntimeError,
	MongoServerError,
	MongoServerSelectionError,
	MongoSystemError,
	MongoTopologyClosedError,
	MongoTransactionError,
	MongoWriteConcernError,
} from "./errors.ts";
export { ObjectId } from "./object-id.ts";
export type {
	BulkWriteResult,
	CollationOptions,
	CollectionInfo,
	CountDocumentsOptions,
	CreateIndexesOptions,
	CreateIndexOptions,
	DeleteResult,
	Document,
	DropIndexesOptions,
	Filter,
	FindOneAndDeleteOptions,
	FindOneAndReplaceOptions,
	FindOneAndUpdateOptions,
	FindOptions,
	IndexDescription,
	IndexDescriptionCompact,
	IndexDescriptionInfo,
	IndexDirection,
	IndexInformationOptions,
	IndexKey,
	IndexSpecification,
	InsertManyResult,
	InsertOneResult,
	ListIndexesOptions,
	ModifyResult,
	MongoClientOptions,
	OptionalId,
	Projection,
	ReplaceOptions,
	Sort,
	SortDirection,
	UpdateFilter,
	UpdateOptions,
	UpdateResult,
	WithoutId,
} from "./types.ts";
