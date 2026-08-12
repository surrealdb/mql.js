import type { ClientSession } from "../session/client-session.ts";
import type { Document } from "./documents.ts";

/**
 * Direction of a single sort key.
 *
 * Mirrors MongoDB's `SortDirection` (mongodb.d.ts, driver 7.5.0):
 * `1 | -1 | 'asc' | 'desc' | 'ascending' | 'descending'`. The long forms were
 * previously missing here, which let `{ field: 'ascending' }` fall through the
 * translator's `if (dir === 1 || dir === 'asc')` check and sort *descending* —
 * silently reversing the caller's intended order.
 *
 * `{ $meta: string }` is deliberately not modelled: mql.js has no `$meta` sort
 * support, so accepting it in the type would promise something we cannot honour.
 */
export type SortDirection =
	| 1
	| -1
	| "asc"
	| "desc"
	| "ascending"
	| "descending";

/** Sort specification: 1 = ascending, -1 = descending. */
export type Sort =
	| { [key: string]: SortDirection }
	| [string, SortDirection][]
	| string;

/** Projection specification: 1 = include, 0 = exclude. */
export type Projection = { [key: string]: 1 | 0 | boolean };

/**
 * Index-selection hint: an index name, an index key pattern, or
 * `{ $natural: 1 }` to force a full scan. Mirrors MongoDB's `Hint`
 * (mongodb.d.ts:5095).
 */
export type Hint = string | Document;

/** A write concern's `w` value. Mirrors mongodb.d.ts:8897. */
export type W = number | "majority";

/**
 * Write-concern settings. Mirrors MongoDB's `WriteConcernSettings`
 * (mongodb.d.ts:9022), deprecated aliases included, because a caller passing
 * `j`/`wtimeout`/`fsync` must be classified rather than silently tolerated.
 */
export interface WriteConcernSettings {
	/** Number of acknowledging nodes, or `"majority"`. */
	w?: W;
	/** Time limit for satisfying the write concern. */
	wtimeoutMS?: number;
	/** Require the write to reach the on-disk journal. */
	journal?: boolean;
	/** @deprecated Use `journal`. */
	j?: boolean;
	/** @deprecated Use `wtimeoutMS`. */
	wtimeout?: number;
	/** @deprecated Use `journal`. */
	fsync?: boolean | 1;
}

/** Read-concern levels MongoDB defines. Mirrors mongodb.d.ts:7657. */
export type ReadConcernLevel =
	| "local"
	| "majority"
	| "linearizable"
	| "available"
	| "snapshot";

/** A read concern, as a level or a `{ level }` wrapper. Mirrors mongodb.d.ts:7659. */
export type ReadConcernLike = ReadConcernLevel | { level: ReadConcernLevel };

/** Read-preference modes MongoDB defines. Mirrors mongodb.d.ts:7751. */
export type ReadPreferenceMode =
	| "primary"
	| "primaryPreferred"
	| "secondary"
	| "secondaryPreferred"
	| "nearest";

/** A read preference. Mirrors mongodb.d.ts:7738, minus the `ReadPreference` class. */
export type ReadPreferenceLike =
	| ReadPreferenceMode
	| { mode: ReadPreferenceMode };

/**
 * BSON serialisation settings every MongoDB operation accepts.
 *
 * Mirrors MongoDB's `BSONSerializeOptions` (mongodb.d.ts:965) so the whole
 * family is nameable and classifiable. `ignoreUndefined` is the one member with
 * a meaning here, because it decides what a caller's `undefined` becomes; the
 * rest describe a BSON encoder this driver does not have — it speaks CBOR and
 * never imports `bson` — and are therefore rejected rather than accepted and
 * ignored.
 */
export interface BSONSerializeOptions {
	/** Drop `undefined` object properties instead of storing them as `null`. Honoured. */
	ignoreUndefined?: boolean;
	/** Validate document keys during serialisation. Rejected — no BSON layer. */
	checkKeys?: boolean;
	/** Serialise JavaScript functions. Rejected — no BSON layer. */
	serializeFunctions?: boolean;
	/** Return raw BSON buffers instead of documents. Rejected — no BSON layer. */
	raw?: boolean;
	/** Deserialise `Long` as `bigint`. Rejected — no BSON layer. */
	useBigInt64?: boolean;
	/** Narrow 64-bit integers to `number`. Rejected — no BSON layer. */
	promoteLongs?: boolean;
	/** Return `Binary` as a Node `Buffer`. Rejected — no BSON layer. */
	promoteBuffers?: boolean;
	/** Promote BSON values to JavaScript equivalents. Rejected — no BSON layer. */
	promoteValues?: boolean;
	/** Return the named fields as raw buffers. Rejected — no BSON layer. */
	fieldsAsRaw?: Document;
	/** Return regular expressions as `BSONRegExp`. Rejected — no BSON layer. */
	bsonRegExp?: boolean;
	/** Validate UTF-8 while deserialising. Rejected — no BSON layer. */
	enableUtf8Validation?: boolean;
}

/**
 * Settings shared by every operation. Mirrors MongoDB's `OperationOptions`
 * (mongodb.d.ts:7476).
 */
export interface OperationOptions extends BSONSerializeOptions {
	/**
	 * Session the operation runs in. Honoured: when the session has a transaction
	 * in progress, the operation's statements run inside it and are committed or
	 * rolled back with it.
	 */
	session?: ClientSession;
	/** Internal retryable-write bookkeeping. Accepted, no effect. */
	willRetryWrite?: boolean;
	/** Which replica-set member to read from. Accepted, no effect — one node. */
	readPreference?: ReadPreferenceLike;
	/** Overall time budget for the operation, in milliseconds. Honoured. */
	timeoutMS?: number;
}

/** Write-concern carrier. Mirrors MongoDB's `WriteConcernOptions` (mongodb.d.ts:9016). */
export interface WriteConcernOptions {
	/** Durability the caller requires. Honoured by classification — see the README. */
	writeConcern?: WriteConcernSettings;
}

/** Explain-plan carrier. Mirrors MongoDB's `ExplainOptions` (mongodb.d.ts:4371). */
export interface ExplainOptions {
	/** Return a query plan instead of results. Rejected — no plan translation. */
	explain?: boolean | string | Document;
}

/**
 * Settings every command-backed operation accepts. Mirrors MongoDB's
 * `CommandOperationOptions` (mongodb.d.ts:3287).
 */
export interface CommandOperationOptions
	extends OperationOptions,
		WriteConcernOptions,
		ExplainOptions {
	/** Consistency the read requires. Accepted or rejected per level — see the README. */
	readConcern?: ReadConcernLike;
	/** Locale-aware string comparison. Rejected — SurrealDB compares by code point. */
	collation?: CollationOptions;
	/** Server-side time limit in milliseconds. Honoured, as `TIMEOUT`. */
	maxTimeMS?: number;
	/** Free-text comment attached to the operation. Accepted, no effect. */
	comment?: unknown;
	/** Run the command against another database. Rejected — would change the namespace. */
	dbName?: string;
	/** Database to authenticate against. Accepted, no effect after connecting. */
	authdb?: string;
}

/**
 * Cursor settings. Mirrors MongoDB's `AbstractCursorOptions`
 * (mongodb.d.ts:260); the fields it shares with `CommandOperationOptions` are
 * declared there.
 */
export interface AbstractCursorOptions {
	/** Documents per server response. Accepted, no effect — results arrive at once. */
	batchSize?: number;
	/** Time a tailable `getMore` waits for data. Accepted, no effect. */
	maxAwaitTimeMS?: number;
	/** Keep the cursor open past the end of a capped collection. Rejected. */
	tailable?: boolean;
	/** Block a tailable cursor waiting for new data. Rejected. */
	awaitData?: boolean;
	/** Prevent the server closing an idle cursor. Accepted, no effect. */
	noCursorTimeout?: boolean;
}

/** Options for `Collection.find` and `Collection.findOne`. */
export interface FindOptions
	extends Omit<CommandOperationOptions, "writeConcern">,
		AbstractCursorOptions {
	/** Fields to return. Honoured. */
	projection?: Projection;
	/** Result order. Honoured. */
	sort?: Sort;
	/** Maximum documents to return. Honoured. */
	limit?: number;
	/** Documents to skip. Honoured. */
	skip?: number;
	/** Index to use. Honoured, as `WITH INDEX`. */
	hint?: Hint;
	/** Whether the cursor may time out. Accepted, no effect. */
	timeout?: boolean;
	/** Return only index keys. Rejected — would return different documents. */
	returnKey?: boolean;
	/** Inclusive lower index bound. Rejected — no index-bound clause. */
	min?: Document;
	/** Exclusive upper index bound. Rejected — no index-bound clause. */
	max?: Document;
	/** Allow on-disk sorting. Accepted, no effect. */
	allowDiskUse?: boolean;
	/** Return only the first batch. Rejected — would truncate the result. */
	singleBatch?: boolean;
	/** Tolerate unavailable shards. Accepted, no effect — one node. */
	allowPartialResults?: boolean;
	/** Add `$recordId` to each document. Rejected — no such identity to report. */
	showRecordId?: boolean;
	/** `$$var` bindings for the query. Rejected — no expression compiler. */
	let?: Document;
	/** Oplog-scan optimisation. Accepted, no effect — ignored by MongoDB 4.4+ too. */
	oplogReplay?: boolean;
}

/** Options for `Collection.updateOne` and `Collection.updateMany`. */
export interface UpdateOptions extends CommandOperationOptions {
	/** Insert when nothing matches. Honoured. */
	upsert?: boolean;
	/** Filters for `$[identifier]` positional updates. Honoured. */
	arrayFilters?: Document[];
	/** Index to use. Honoured, as `WITH INDEX`. */
	hint?: Hint;
	/** Skip document validation. Rejected when `true` — `ASSERT`s cannot be bypassed. */
	bypassDocumentValidation?: boolean;
	/** `$$var` bindings for the update. Rejected — no expression compiler. */
	let?: Document;
}

/** Options for `Collection.replaceOne`. */
export interface ReplaceOptions extends CommandOperationOptions {
	/** Insert when nothing matches. Honoured. */
	upsert?: boolean;
	/** Which document to replace when several match. Honoured. */
	sort?: Sort;
	/** Index to use. Honoured, as `WITH INDEX`. */
	hint?: Hint;
	/** Skip document validation. Rejected when `true`. */
	bypassDocumentValidation?: boolean;
	/** `$$var` bindings for the replacement. Rejected — no expression compiler. */
	let?: Document;
}

/** Options for `Collection.findOneAndUpdate`. */
export interface FindOneAndUpdateOptions extends CommandOperationOptions {
	/** Fields to return. Honoured. */
	projection?: Projection;
	/** Which document to modify when several match. Honoured. */
	sort?: Sort;
	/** Insert when nothing matches. Honoured. */
	upsert?: boolean;
	/** Whether to return the document before or after the update. Honoured. */
	returnDocument?: "before" | "after";
	/** Return a `ModifyResult` wrapper instead of the document. Honoured. */
	includeResultMetadata?: boolean;
	/** Filters for `$[identifier]` positional updates. Honoured. */
	arrayFilters?: Document[];
	/** Index to use. Honoured, as `WITH INDEX`. */
	hint?: Hint;
	/** Skip document validation. Rejected when `true`. */
	bypassDocumentValidation?: boolean;
	/** `$$var` bindings for the update. Rejected — no expression compiler. */
	let?: Document;
}

/** Options for `Collection.findOneAndDelete`. */
export interface FindOneAndDeleteOptions extends CommandOperationOptions {
	/** Fields to return. Honoured. */
	projection?: Projection;
	/** Which document to delete when several match. Honoured. */
	sort?: Sort;
	/** Return a `ModifyResult` wrapper instead of the document. Honoured. */
	includeResultMetadata?: boolean;
	/** Index to use. Honoured, as `WITH INDEX`. */
	hint?: Hint;
	/** `$$var` bindings for the query. Rejected — no expression compiler. */
	let?: Document;
}

/** Options for `Collection.findOneAndReplace`. */
export interface FindOneAndReplaceOptions extends CommandOperationOptions {
	/** Fields to return. Honoured. */
	projection?: Projection;
	/** Which document to replace when several match. Honoured. */
	sort?: Sort;
	/** Insert when nothing matches. Honoured. */
	upsert?: boolean;
	/** Whether to return the document before or after the replacement. Honoured. */
	returnDocument?: "before" | "after";
	/** Return a `ModifyResult` wrapper instead of the document. Honoured. */
	includeResultMetadata?: boolean;
	/** Index to use. Honoured, as `WITH INDEX`. */
	hint?: Hint;
	/** Skip document validation. Rejected when `true`. */
	bypassDocumentValidation?: boolean;
	/** `$$var` bindings for the replacement. Rejected — no expression compiler. */
	let?: Document;
}

/** Options for `Collection.deleteOne` and `Collection.deleteMany`. */
export interface DeleteOptions extends CommandOperationOptions {
	/** Index to use. Honoured, as `WITH INDEX`. */
	hint?: Hint;
	/**
	 * Batch ordering. Accepted, no effect: each call emits one statement, so
	 * there is no batch whose order could matter.
	 */
	ordered?: boolean;
	/** `$$var` bindings for the query. Rejected — no expression compiler. */
	let?: Document;
}

/** Options for `Collection.insertOne`. */
export interface InsertOneOptions extends CommandOperationOptions {
	/** Skip document validation. Rejected when `true`. */
	bypassDocumentValidation?: boolean;
	/** Let the server assign `_id`. Rejected — `insertedId` would be unknowable. */
	forceServerObjectId?: boolean;
}

/** Options for `Collection.insertMany`. */
export interface BulkWriteOptions extends CommandOperationOptions {
	/** Skip document validation. Rejected when `true`. */
	bypassDocumentValidation?: boolean;
	/**
	 * Whether a failure stops the batch. Rejected when `false`: SurrealDB inserts
	 * a batch atomically, so the surviving documents `ordered: false` promises
	 * would never be written.
	 */
	ordered?: boolean;
	/** Let the server assign `_id`. Rejected — `insertedIds` would be unknowable. */
	forceServerObjectId?: boolean;
	/** `$$var` bindings for the insert. Rejected — no expression compiler. */
	let?: Document;
}

/**
 * Options for `Collection.countDocuments`.
 *
 * Extends the aggregate surface, as MongoDB's own `CountDocumentsOptions`
 * (mongodb.d.ts:3653) does — the count runs as an aggregation there.
 */
export interface CountDocumentsOptions extends CommandOperationOptions {
	/** Documents to skip before counting. Honoured. */
	skip?: number;
	/** Maximum documents to count. Honoured. */
	limit?: number;
	/** Index to use. Honoured, as `WITH INDEX`. */
	hint?: Hint;
	/** Documents per server response. Accepted, no effect. */
	batchSize?: number;
	/** Time a `getMore` waits for data. Accepted, no effect. */
	maxAwaitTimeMS?: number;
	/** Allow on-disk sorting. Accepted, no effect. */
	allowDiskUse?: boolean;
	/** Cursor configuration for the aggregate command. Accepted, no effect. */
	cursor?: Document;
	/** Skip document validation. Rejected when `true`. */
	bypassDocumentValidation?: boolean;
	/** Write the pipeline output to a collection. Rejected — would write data. */
	out?: string;
	/** `$$var` bindings for the pipeline. Rejected — no expression compiler. */
	let?: Document;
}

/**
 * Options for `Collection.estimatedDocumentCount`.
 *
 * MongoDB declares this as an interface whose only member, `maxTimeMS`, it
 * already inherits (mongodb.d.ts:4280); an alias says the same thing without a
 * body that adds nothing.
 */
export type EstimatedDocumentCountOptions = CommandOperationOptions;

/** Options for `Collection.distinct`. */
export interface DistinctOptions extends CommandOperationOptions {
	/** Index to use. Honoured, as `WITH INDEX`. */
	hint?: Hint;
}

/** Username and password, supplied outside the connection string. Mirrors mongodb.d.ts:635. */
export interface Auth {
	/** The username to authenticate with. */
	username?: string;
	/** The password to authenticate with. */
	password?: string;
}

/**
 * Authentication mechanisms MongoDB defines. Mirrors mongodb.d.ts:645.
 *
 * The password-based ones describe how a username and password are exchanged,
 * which SurrealDB's `signin` does its own way, so they are accepted and ignored.
 * The rest replace the password entirely and are rejected — see the README.
 */
export type AuthMechanism =
	| "DEFAULT"
	| "SCRAM-SHA-1"
	| "SCRAM-SHA-256"
	| "PLAIN"
	| "GSSAPI"
	| "MONGODB-AWS"
	| "MONGODB-OIDC"
	| "MONGODB-X509";

/** Wire-compression algorithms MongoDB names. Mirrors mongodb.d.ts:3378. */
export type CompressorName = "none" | "snappy" | "zlib" | "zstd";

/** Replica-set member tags used to steer reads. Mirrors mongodb.d.ts:8551. */
export type TagSet = { [key: string]: string };

/** Stable-API declaration. Mirrors mongodb.d.ts:8024. */
export interface ServerApi {
	version: ServerApiVersion;
	strict?: boolean;
	deprecationErrors?: boolean;
}

/** Stable-API versions MongoDB defines. Mirrors mongodb.d.ts:8031. */
export type ServerApiVersion = "1";

/** How the driver monitors servers. Mirrors mongodb.d.ts:8193. */
export type ServerMonitoringMode = "auto" | "poll" | "stream";

/** Wrapping-driver identification. Mirrors mongodb.d.ts:4236. */
export interface DriverInfo {
	name?: string;
	version?: string;
	platform?: string;
}

/** Custom `_id` generator. Mirrors mongodb.d.ts:7550. */
export interface PkFactory {
	createPk(): unknown;
}

/**
 * How the WebSocket engine behaves after an established connection drops.
 *
 * SurrealDB's own setting rather than a MongoDB one, mirroring the SDK's
 * `ReconnectOptions` so the whole shape is expressible without depending on the
 * SDK's types in this driver's public surface. Defaults to disabled, so a
 * dropped connection surfaces as an error instead of being papered over.
 */
export interface ReconnectSettings {
	/** How many attempts to make; `-1` for unlimited. */
	attempts?: number;
	/** Milliseconds to wait before the first attempt. */
	retryDelay?: number;
	/** Ceiling on the wait between attempts, in milliseconds. */
	retryDelayMax?: number;
	/** Factor the delay grows by after each failed attempt. */
	retryDelayMultiplier?: number;
	/** Fraction of the delay to randomise, to avoid synchronised retries. */
	retryDelayJitter?: number;
}

// ---------------------------------------------------------------------------
// Database-level options
// ---------------------------------------------------------------------------

/**
 * Options for `Db.collection`.
 *
 * Purely local: obtaining a `Collection` issues no command, so nothing here can
 * be honoured. The type exists so the same gate that guards the operations
 * refuses an option the caller believes will apply to them.
 */
export interface CollectionOptions extends CommandOperationOptions {}

/** Options for `Db.listCollections`. */
export interface ListCollectionsOptions extends CommandOperationOptions {
	/** Return only the collection names. Accepted, no effect on the shape. */
	nameOnly?: boolean;
	/** Documents per server response. Accepted, no effect. */
	batchSize?: number;
	/** Include pending collections. Accepted, no effect. */
	authorizedCollections?: boolean;
}

/**
 * Options for `Db.createCollection`.
 *
 * SurrealDB's `DEFINE TABLE` has no counterpart for MongoDB's collection
 * shaping, so the capped, validation, view and time-series families are all
 * rejected rather than accepted and forgotten — a caller who asks for a capped
 * collection and receives an ordinary one has been misled about the storage
 * they are writing to.
 */
export interface CreateCollectionOptions extends CommandOperationOptions {
	/** Fixed-size collection. Rejected: no equivalent. */
	capped?: boolean;
	/** Cap in bytes. Rejected: no equivalent. */
	size?: number;
	/** Cap in documents. Rejected: no equivalent. */
	max?: number;
	/** Document validator. Rejected: use SurrealDB `ASSERT` on the table. */
	validator?: Document;
	/** Validator strictness. Rejected: no equivalent. */
	validationLevel?: "off" | "strict" | "moderate";
	/** Validator failure action. Rejected: no equivalent. */
	validationAction?: "error" | "warn";
	/** Time-series configuration. Rejected: no equivalent. */
	timeseries?: Document;
	/** Time-series retention. Rejected: no TTL mechanism. */
	expireAfterSeconds?: number;
	/** Source collection for a view. Rejected: no equivalent. */
	viewOn?: string;
	/** View pipeline. Rejected: aggregation is not implemented. */
	pipeline?: Document[];
	/** Clustered index specification. Rejected: no equivalent. */
	clusteredIndex?: Document;
	/** Storage engine settings. Accepted, no effect. */
	storageEngine?: Document;
}

/** Options for `Db.dropCollection`. */
export interface DropCollectionOptions extends CommandOperationOptions {}

/** Options for `Db.dropDatabase`. */
export interface DropDatabaseOptions extends CommandOperationOptions {}

/**
 * Options for `Db.command` and `Admin.command`. Mirrors MongoDB's
 * `RunCommandOptions` (mongodb.d.ts:7900).
 *
 * Narrower than `CommandOperationOptions` because MongoDB's own `command()`
 * inherits nothing from the client: only a session, a read preference and a
 * timeout are read.
 */
export interface RunCommandOptions extends BSONSerializeOptions {
	/** Session the command runs in. Honoured for the commands that write. */
	session?: ClientSession;
	/** Which replica-set member to read from. Accepted, no effect — one node. */
	readPreference?: ReadPreferenceLike;
	/** Time budget in milliseconds. Honoured by the commands that query. */
	timeoutMS?: number;
}

/**
 * Options for `Db.stats` and the `dbStats` command. Mirrors MongoDB's
 * `DbStatsOptions` (mongodb.d.ts:4153).
 */
export interface DbStatsOptions extends CommandOperationOptions {
	/**
	 * Divisor for the reported sizes. Accepted, no effect: this driver reports no
	 * size fields, so there is nothing for it to scale.
	 */
	scale?: number;
}

/**
 * Options for `Admin.listDatabases`. Mirrors MongoDB's `ListDatabasesOptions`
 * (mongodb.d.ts:5375).
 */
export interface ListDatabasesOptions extends CommandOperationOptions {
	/** Predicate applied to the reply's `{name}` documents. Honoured. */
	filter?: Document;
	/** Return names only. Accepted, no effect — only names are reported anyway. */
	nameOnly?: boolean;
	/** Limit to databases the user may see. Accepted, no effect. */
	authorizedDatabases?: boolean;
}

/**
 * Options for the `MongoClient` constructor.
 *
 * The whole of MongoDB's `MongoClientOptions` surface (mongodb.d.ts:6023) is
 * modelled, plus the three SurrealDB-specific settings this driver adds
 * (`namespace`, `database`, `reconnect`). Every field is honoured, accepted and
 * ignored, or rejected with a reason — see `assertSupportedClientOptions` in
 * `src/client/client-options.ts` for the policy and the README for the table.
 *
 * The same classification applies to the equivalent connection-string
 * parameters, so `?w=0` and `{ writeConcern: { w: 0 } }` behave identically.
 */
export interface MongoClientOptions extends BSONSerializeOptions {
	// -- SurrealDB-specific ------------------------------------------------

	/** SurrealDB namespace to use. Defaults to "default". Honoured. */
	namespace?: string;
	/** SurrealDB database, overriding the one in the connection string. Honoured. */
	database?: string;
	/** Reconnect behaviour after a dropped connection. Honoured; disabled by default. */
	reconnect?: boolean | ReconnectSettings;

	// -- Transport ---------------------------------------------------------

	/** Encrypt the connection. Honoured — selects `wss://` / `https://`. */
	tls?: boolean;
	/** Alias for `tls`, which it must agree with. Honoured. */
	ssl?: boolean;
	/** Time allowed for the connection to become ready. Honoured. */
	connectTimeoutMS?: number;
	/** Time allowed to find a usable server. Honoured. */
	serverSelectionTimeoutMS?: number;
	/** Default time budget for every operation. Honoured, as `TIMEOUT`. */
	timeoutMS?: number;
	/** Time a socket may stall before failing. Rejected — use `timeoutMS`. */
	socketTimeoutMS?: number;
	/** Disable Nagle's algorithm. Accepted, no effect — the transport is not configurable. */
	noDelay?: boolean;
	/** Client certificate and key file. Rejected — the platform trust store is used. */
	tlsCertificateKeyFile?: string;
	/** Passphrase for `tlsCertificateKeyFile`. Rejected. */
	tlsCertificateKeyFilePassword?: string;
	/** Certificate-authority file. Rejected — the platform trust store is used. */
	tlsCAFile?: string;
	/** Certificate-revocation-list file. Rejected. */
	tlsCRLFile?: string;
	/** Accept an untrusted certificate. Rejected when `true` — validation cannot be relaxed. */
	tlsAllowInvalidCertificates?: boolean;
	/** Accept a mismatched hostname. Rejected when `true`. */
	tlsAllowInvalidHostnames?: boolean;
	/** Disable certificate checks entirely. Rejected when `true`. */
	tlsInsecure?: boolean;
	/** SOCKS5 proxy host. Rejected — the transport cannot be proxied. */
	proxyHost?: string;
	/** SOCKS5 proxy port. Rejected. */
	proxyPort?: number;
	/** SOCKS5 proxy username. Rejected. */
	proxyUsername?: string;
	/** SOCKS5 proxy password. Rejected. */
	proxyPassword?: string;
	/** Wire-compression algorithms to offer. Accepted, no effect. */
	compressors?: CompressorName[] | string;
	/** zlib compression level. Accepted, no effect. */
	zlibCompressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

	// -- Authentication ----------------------------------------------------

	/** Credentials, overriding the connection string's userinfo. Honoured. */
	auth?: Auth;
	/**
	 * Which SurrealDB user level to authenticate at. Honoured.
	 *
	 * Unset or `"admin"` signs in as a root user, as it does in MongoDB, where
	 * `admin` holds the server-level accounts. Any other value names a database
	 * whose own users are signed in against, inside the connection's namespace.
	 */
	authSource?: string;
	/** How credentials are exchanged. Accepted for password mechanisms, rejected otherwise. */
	authMechanism?: AuthMechanism;
	/** Extra properties for `authMechanism`. Accepted, no effect. */
	authMechanismProperties?: Document;

	// -- Topology ----------------------------------------------------------

	/** Replica-set name. Accepted, no effect — there is one node. */
	replicaSet?: string;
	/** Force a direct connection. Accepted, no effect — connections are always direct. */
	directConnection?: boolean;
	/** Treat the endpoint as a load balancer. Accepted, no effect. */
	loadBalanced?: boolean;
	/** Maximum SRV hosts to use. Rejected — `mongodb+srv://` needs an SRV lookup this driver has no way to perform. */
	srvMaxHosts?: number;
	/** SRV service name to query. Rejected — see `srvMaxHosts`. */
	srvServiceName?: string;
	/** Interval between server checks. Accepted, no effect — no topology to monitor. */
	heartbeatFrequencyMS?: number;
	/** Floor on the interval between server checks. Accepted, no effect. */
	minHeartbeatFrequencyMS?: number;
	/** Monitoring strategy. Accepted, no effect. */
	serverMonitoringMode?: ServerMonitoringMode;
	/** Latency window for choosing between servers. Accepted, no effect. */
	localThresholdMS?: number;

	// -- Connection pool ---------------------------------------------------

	/** Maximum pooled connections. Accepted, no effect — one multiplexed connection is used. */
	maxPoolSize?: number;
	/** Minimum pooled connections. Accepted, no effect. */
	minPoolSize?: number;
	/** Connections that may be established at once. Accepted, no effect. */
	maxConnecting?: number;
	/** Idle time before a pooled connection is retired. Accepted, no effect. */
	maxIdleTimeMS?: number;
	/** Time to wait for a pooled connection. Accepted, no effect — there is no queue. */
	waitQueueTimeoutMS?: number;

	// -- Read and write concern -------------------------------------------

	/** Consistency reads require. Accepted or rejected per level — see the README. */
	readConcern?: ReadConcernLike;
	/** Consistency reads require, as a bare level. Accepted or rejected per level. */
	readConcernLevel?: ReadConcernLevel;
	/** Which member to read from. Accepted, no effect — one node. */
	readPreference?: ReadPreferenceLike;
	/** Staleness a secondary may have. Accepted, no effect. */
	maxStalenessSeconds?: number;
	/** Tags a member must carry to be read from. Accepted, no effect. */
	readPreferenceTags?: TagSet[];
	/** Durability writes require. Accepted or rejected per value — see the README. */
	writeConcern?: WriteConcernSettings;
	/** @deprecated Use `writeConcern`. Classified the same way. */
	w?: W;
	/** @deprecated Use `writeConcern`. Classified the same way. */
	wtimeoutMS?: number;
	/** @deprecated Use `writeConcern`. Classified the same way. */
	journal?: boolean;

	// -- Retries -----------------------------------------------------------

	/** Retry a failed write once. Accepted, no effect — nothing is retried. */
	retryWrites?: boolean;
	/** Retry a failed read once. Accepted, no effect — nothing is retried. */
	retryReads?: boolean;
	/** Retries permitted while the server is overloaded. Accepted, no effect. */
	maxAdaptiveRetries?: number;
	/** Re-target operations while the server is overloaded. Accepted, no effect. */
	enableOverloadRetargeting?: boolean;

	// -- Identification and diagnostics -----------------------------------

	/** Application name reported to the server. Accepted, no effect — no metadata channel. */
	appName?: string;
	/** Wrapping-driver identification. Accepted, no effect. */
	driverInfo?: DriverInfo;
	/** Emit command-monitoring events. Rejected when `true` — there are no events to emit. */
	monitorCommands?: boolean;
	/** Where the driver logs. Accepted, no effect — this driver does not log. */
	mongodbLogPath?: "stderr" | "stdout";
	/** Per-component log severities. Accepted, no effect. */
	mongodbLogComponentSeverities?: Document;
	/** Maximum length of a logged document. Accepted, no effect. */
	mongodbLogMaxDocumentLength?: number;

	// -- Documents ---------------------------------------------------------

	/** Stable-API declaration. Accepted, no effect — no MongoDB command surface to version. */
	serverApi?: ServerApi | ServerApiVersion;
	/** Let the server assign `_id`. Rejected when `true` — `insertedId` would be unknowable. */
	forceServerObjectId?: boolean;
	/** Custom `_id` generator. Rejected — generated ids would not come from it. */
	pkFactory?: PkFactory;
	/** Client-side field-level encryption. Rejected — data would be stored in the clear. */
	autoEncryption?: Document;
}

/**
 * Direction, or type, of a single index key.
 *
 * Mirrors MongoDB's `IndexDirection` (mongodb.d.ts:5170) exactly, `number`
 * arm included. That arm makes the union effectively unchecked, so
 * `createIndex` validates the value at runtime and rejects anything it cannot
 * map onto a SurrealDB index — `1`, `-1` and `"text"` are the directions this
 * driver can serve.
 */
export type IndexDirection =
	| -1
	| 1
	| "2d"
	| "2dsphere"
	| "text"
	| "geoHaystack"
	| "hashed"
	| number;

/** A resolved index key: field path → direction, in column order. */
export type IndexKey = { [key: string]: IndexDirection };

/** One of the shapes an `IndexSpecification` may take. */
type IndexSpecificationEntry =
	| string
	| readonly [string, IndexDirection]
	| IndexKey
	| Map<string, IndexDirection>;

/**
 * Index specification accepted by `createIndex`.
 *
 * Mirrors MongoDB's `IndexSpecification` (mongodb.d.ts:5196), so every form the
 * official driver documents is accepted: `'e'`, `{a: 1, b: -1}`,
 * `[['c', 1], ['d', -1]]`, `['f', 'g']`, `[{h: 1}, {i: -1}]` and `Map`s.
 */
export type IndexSpecification =
	| IndexSpecificationEntry
	| readonly IndexSpecificationEntry[];

/**
 * Locale-aware string comparison settings.
 *
 * Mirrors MongoDB's `CollationOptions`. Named so consumers can reference the
 * type, but collation itself is rejected: SurrealDB compares strings by code
 * point, and quietly ignoring a locale would change which documents an index
 * considers equal.
 */
export interface CollationOptions {
	locale: string;
	caseLevel?: boolean;
	caseFirst?: string;
	strength?: number;
	numericOrdering?: boolean;
	alternate?: string;
	maxVariable?: string;
	backwards?: boolean;
	normalization?: boolean;
}

/**
 * The fields that describe the index itself, as opposed to the command that
 * creates it.
 *
 * Separated out because one entry of a `createIndexes` batch takes exactly
 * these — an `IndexDescription` describes an index, so a session or a time limit
 * has no place in it — while `createIndex` also takes the command surface. The
 * official driver draws the same line with a `Pick` (mongodb.d.ts:5147).
 *
 * The full `CreateIndexesOptions` surface from mongodb.d.ts:3718 is modelled,
 * because a silently dropped option is worse than a rejected one: a caller who
 * asks for a TTL index and gets a plain one has a data-retention bug, not a
 * compatibility gap. Each field is therefore honoured, deliberately ignored, or
 * rejected — see `assertSupportedIndexOptions` in
 * `src/collection/operation-options.ts` for the per-option policy and reasons.
 */
export interface IndexSpecificationOptions {
	/** Override the auto-generated index name. Honoured. */
	name?: string;
	/** Create a unique index. Honoured, as SurrealDB's `UNIQUE`. */
	unique?: boolean;
	/** Free-text comment stored with the index. Honoured. */
	comment?: unknown;
	/** Only index documents that contain the key. Honoured when `true`. */
	sparse?: boolean;
	/** Build the index in the background. Ignored, as on MongoDB 4.2+. */
	background?: boolean;
	/** Index format version. Ignored. */
	version?: number;
	/** Replica-set index-build acknowledgement. Ignored. */
	commitQuorum?: number | string;
	/** Per-index storage-engine configuration. Ignored. */
	storageEngine?: Document;
	/** Full-text index format version. Ignored. */
	textIndexVersion?: number;
	/** 2dsphere index format version. Ignored. */
	"2dsphereIndexVersion"?: number;
	/** Geohash precision for `2d` indexes. Ignored. */
	bits?: number;
	/** Lower co-ordinate bound for `2d` indexes. Ignored. */
	min?: number;
	/** Upper co-ordinate bound for `2d` indexes. Ignored. */
	max?: number;
	/** `geoHaystack` bucket width. Ignored. */
	bucketSize?: number;
	/** Seconds after which a document expires. Rejected — no TTL clause. */
	expireAfterSeconds?: number;
	/** Restrict the index to matching documents. Rejected. */
	partialFilterExpression?: Document;
	/** Locale-aware comparison. Rejected. */
	collation?: CollationOptions;
	/** Per-field full-text scoring weights. Rejected. */
	weights?: Document;
	/** Stemming language for a full-text index. Rejected. */
	default_language?: string;
	/** Field naming a per-document full-text language. Rejected. */
	language_override?: string;
	/** Hide the index from the query planner. Rejected when `true`. */
	hidden?: boolean;
	/** Fields a wildcard index covers. Rejected. */
	wildcardProjection?: Document;
}

/**
 * Options for `Collection.createIndex` and `Collection.createIndexes`.
 *
 * The index's own fields plus the command surface, which is what makes `session`
 * nameable on a typed call: `DEFINE INDEX` runs inside a caller's transaction and
 * is rolled back with it, so a caller creating an index as part of a migration
 * must be able to say so without casting. `writeConcern` is dropped as the
 * official driver drops it (mongodb.d.ts:3718) — index builds have no
 * per-command durability setting.
 */
export interface CreateIndexesOptions
	extends IndexSpecificationOptions,
		Omit<CommandOperationOptions, "writeConcern"> {}

/**
 * @deprecated Use `CreateIndexesOptions`, which is what the official driver
 * calls this. Retained as an alias so existing annotations keep compiling.
 */
export type CreateIndexOptions = CreateIndexesOptions;

/**
 * One index in a `createIndexes` batch.
 *
 * Mirrors MongoDB's `IndexDescription` (mongodb.d.ts:5147): the index-shaping
 * options with the key alongside them, and none of the command-level fields —
 * those belong to the `createIndexes` call, which takes one options object for
 * the whole batch.
 */
export interface IndexDescription extends IndexSpecificationOptions {
	key: IndexKey | Map<string, IndexDirection>;
}

/**
 * One index as reported by `listIndexes`.
 *
 * Mirrors MongoDB's `IndexDescriptionInfo` (mongodb.d.ts:5163). `v` is declared
 * because the official driver reports it, but this driver omits it: it is a
 * MongoDB on-disk format number with no SurrealDB counterpart, and a
 * plausible-looking `2` would be fabricated.
 */
export type IndexDescriptionInfo = Omit<IndexDescription, "key" | "version"> & {
	name: string;
	key: IndexKey;
	v?: number;
} & Document;

/**
 * The compact form `indexInformation()` returns: index name → its key as
 * `[field, direction]` pairs. Mirrors mongodb.d.ts:5158.
 */
export type IndexDescriptionCompact = Record<
	string,
	[name: string, direction: IndexDirection][]
>;

/**
 * Options for `Collection.listIndexes`, `indexes` and `indexExists`.
 *
 * Extends the command surface, as the driver's own
 * `AbstractCursorOptions`-derived type does (mongodb.d.ts:5406), so `session`
 * and the rest are nameable on a typed call rather than only reachable through
 * an untyped one.
 */
export interface ListIndexesOptions extends CommandOperationOptions {}

/** Options for `Collection.indexInformation`. Mirrors mongodb.d.ts:5173. */
export interface IndexInformationOptions extends ListIndexesOptions {
	/**
	 * When `true`, return full index descriptions instead of the compact
	 * name → key-pairs mapping.
	 */
	full?: boolean;
}

/**
 * Options for `Collection.dropIndex` and `Collection.dropIndexes`.
 *
 * Extends the command surface for the same reason `ListIndexesOptions` does: a
 * `session` has to be nameable on a typed call, since dropping an index inside a
 * caller's transaction is rolled back with it.
 */
export interface DropIndexesOptions extends CommandOperationOptions {}
