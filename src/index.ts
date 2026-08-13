/**
 * Public entry point for `@surrealdb/mql`. Everything exported from here
 * forms the contract that downstream code may rely on; internals live in
 * `client/`, `db/`, `collection/`, `cursor/`, `surreal/`, and `translators/`.
 */

export type { Listener } from "./client/event-emitter.ts";
export { MqlEventEmitter } from "./client/event-emitter.ts";
export type {
	MongoClientEvent,
	MongoClientEvents,
} from "./client/mongo-client.ts";
export { MongoClient } from "./client/mongo-client.ts";
export { Collection } from "./collection/collection.ts";
export { MONGODB_COMPATIBILITY_VERSION } from "./constants.ts";
export { FindCursor } from "./cursor/find-cursor.ts";
export {
	ListCollectionsCursor,
	type ListCollectionsRunner,
} from "./cursor/list-collections-cursor.ts";
export {
	ListIndexesCursor,
	type ListIndexesRunner,
} from "./cursor/list-indexes-cursor.ts";
export { Admin } from "./db/admin.ts";
export { Db } from "./db/db.ts";
export type {
	BulkWriteOutcome,
	MongoErrorCodeValue,
	MongoServerErrorOptions,
	WriteError,
} from "./errors.ts";
export {
	codeNameFor,
	MongoAPIError,
	MongoBulkWriteError,
	MongoClientError,
	MongoCompatibilityError,
	MongoCursorExhaustedError,
	MongoCursorInUseError,
	MongoDriverError,
	MongoError,
	MongoErrorCode,
	MongoErrorLabel,
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
export type { ObjectIdLike } from "./object-id.ts";
export { ObjectId } from "./object-id.ts";
export type {
	ClientSessionId,
	ClientSessionOptions,
	EndSessionOptions,
	TransactionOptions,
	WithSessionCallback,
	WithTransactionCallback,
} from "./session/client-session.ts";
export { ClientSession } from "./session/client-session.ts";
export { Transaction, TransactionState } from "./session/transaction.ts";
export type {
	AbstractCursorOptions,
	Auth,
	AuthMechanism,
	BSONSerializeOptions,
	BulkWriteOptions,
	BulkWriteResult,
	CollationOptions,
	CollectionInfo,
	CommandOperationOptions,
	CompressorName,
	CountDocumentsOptions,
	CreateIndexesOptions,
	CreateIndexOptions,
	DbStatsOptions,
	DeleteOptions,
	DeleteResult,
	DistanceBounds,
	DistinctOptions,
	Document,
	DriverInfo,
	DropIndexesOptions,
	EstimatedDocumentCountOptions,
	ExplainOptions,
	Filter,
	FindOneAndDeleteOptions,
	FindOneAndReplaceOptions,
	FindOneAndUpdateOptions,
	FindOptions,
	GeoJsonGeometry,
	GeospatialOperators,
	Hint,
	IndexDescription,
	IndexDescriptionCompact,
	IndexDescriptionInfo,
	IndexDirection,
	IndexInformationOptions,
	IndexKey,
	IndexSpecification,
	IndexSpecificationOptions,
	InsertManyResult,
	InsertOneOptions,
	InsertOneResult,
	ListDatabasesOptions,
	ListDatabasesResult,
	ListIndexesOptions,
	ModifyResult,
	MongoClientOptions,
	OperationOptions,
	OptionalId,
	PkFactory,
	Position,
	Projection,
	ReadConcernLevel,
	ReadConcernLike,
	ReadPreferenceLike,
	ReadPreferenceMode,
	ReconnectSettings,
	ReplaceOptions,
	RunCommandOptions,
	ServerApi,
	ServerApiVersion,
	ServerMonitoringMode,
	Sort,
	SortDirection,
	TagSet,
	UpdateFilter,
	UpdateOptions,
	UpdateResult,
	W,
	WithoutId,
	WriteConcernOptions,
	WriteConcernSettings,
} from "./types.ts";
