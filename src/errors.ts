/**
 * MongoDB-compatible error hierarchy.
 *
 * The class names, inheritance and numeric codes mirror the official
 * `mongodb` driver, because error handling is load-bearing public API:
 * real-world code does `catch (e) { if (e.code === 11000) … }` and
 * `if (e instanceof MongoServerError) …`. Getting the shape wrong means
 * working MongoDB code silently stops catching what it used to.
 *
 * The spine is:
 *
 *     Error
 *       └── MongoError
 *             ├── MongoDriverError          — the driver's own fault
 *             │     ├── MongoAPIError       — the caller misused the API
 *             │     │     ├── MongoCompatibilityError
 *             │     │     ├── MongoInvalidArgumentError
 *             │     │     ├── MongoNotConnectedError
 *             │     │     ├── MongoCursorExhaustedError
 *             │     │     ├── MongoCursorInUseError
 *             │     │     ├── MongoTopologyClosedError
 *             │     │     ├── MongoExpiredSessionError
 *             │     │     └── MongoTransactionError
 *             │     ├── MongoRuntimeError
 *             │     ├── MongoParseError
 *             │     └── MongoOperationTimeoutError
 *             ├── MongoServerError          — the server rejected it
 *             │     ├── MongoBulkWriteError
 *             │     └── MongoWriteConcernError
 *             ├── MongoNetworkError
 *             │     └── MongoNetworkTimeoutError
 *             └── MongoSystemError
 *                   └── MongoServerSelectionError
 */

/**
 * Numeric MongoDB error codes this driver produces.
 *
 * Only the codes that can actually arise from a SurrealDB-backed driver are
 * listed. `code` is what applications branch on, so each mapping is chosen to
 * match what a real MongoDB server would have returned for the same mistake.
 */
export const MongoErrorCode = {
	/** A value was the right type but out of range or otherwise invalid. */
	BadValue: 2,
	/** A failure with no more specific code — MongoDB's own catch-all. */
	UnknownError: 8,
	/** The command or query could not be parsed. */
	FailedToParse: 9,
	/** The connection is not authorised to perform the operation. */
	Unauthorized: 13,
	/** Credentials were rejected. */
	AuthenticationFailed: 18,
	/** The target namespace (database or collection) does not exist. */
	NamespaceNotFound: 26,
	/** No index with the requested name exists on the collection. */
	IndexNotFound: 27,
	/** The target namespace already exists. */
	NamespaceExists: 48,
	/** The command's options are not valid for the target. */
	InvalidOptions: 72,
	/** An index with the requested key already exists under another name. */
	IndexOptionsConflict: 85,
	/** An index with the requested name already exists with a different spec. */
	IndexKeySpecsConflict: 86,
	/** The operation exceeded its `maxTimeMS` budget. */
	MaxTimeMSExpired: 50,
	/** The command is not recognised by the server. */
	CommandNotFound: 59,
	/** The namespace argument was empty, or of the wrong type. */
	InvalidNamespace: 73,
	/** The deployment is not running as a replica-set member. */
	NoReplicationEnabled: 76,
	/** A concurrent transaction wrote the same data first. */
	WriteConflict: 112,
	/** The deployment is not a replica set, so the requested guarantee is unavailable. */
	NotAReplicaSet: 123,
	/** A unique index rejected the write. */
	DuplicateKey: 11000,
	/** A schema validator or assertion rejected the document. */
	DocumentValidationFailure: 121,
	/** The referenced transaction is not active. */
	NoSuchTransaction: 251,
	/** A command was missing a field its definition requires. */
	IDLFailedToParse: 40414,
} as const;

export type MongoErrorCodeValue =
	(typeof MongoErrorCode)[keyof typeof MongoErrorCode];

/**
 * Labels a `MongoError` can carry, as `MongoErrorLabel` in the official driver.
 *
 * A label says what a caller may *do* about a failure, which is why the
 * transaction retry loop keys off labels rather than classes. Only the two
 * transaction labels are produced by this driver — the rest describe replica-set
 * and change-stream mechanics that have no referent here — but the whole set is
 * declared so `hasErrorLabel(MongoErrorLabel.RetryableWriteError)` still
 * type-checks against code written for `mongodb`.
 */
export const MongoErrorLabel = {
	/** The write may be retried as-is. */
	RetryableWriteError: "RetryableWriteError",
	/** The whole transaction may be retried from the beginning. */
	TransientTransactionError: "TransientTransactionError",
	/** The commit may or may not have been applied. */
	UnknownTransactionCommitResult: "UnknownTransactionCommitResult",
	/** A change stream may be resumed after this failure. */
	ResumableChangeStreamError: "ResumableChangeStreamError",
	/** The failure happened during the connection handshake. */
	HandshakeError: "HandshakeError",
	/** The connection pool should be cleared. */
	ResetPool: "ResetPool",
	/** No write was performed, so a retry cannot duplicate one. */
	NoWritesPerformed: "NoWritesPerformed",
} as const;

export type MongoErrorLabel =
	(typeof MongoErrorLabel)[keyof typeof MongoErrorLabel];

/** Human-readable `codeName` for each numeric code, as MongoDB reports it. */
const CODE_NAMES: Record<number, string> = {
	2: "BadValue",
	8: "UnknownError",
	9: "FailedToParse",
	13: "Unauthorized",
	18: "AuthenticationFailed",
	26: "NamespaceNotFound",
	27: "IndexNotFound",
	48: "NamespaceExists",
	50: "MaxTimeMSExpired",
	59: "CommandNotFound",
	72: "InvalidOptions",
	73: "InvalidNamespace",
	76: "NoReplicationEnabled",
	85: "IndexOptionsConflict",
	86: "IndexKeySpecsConflict",
	112: "WriteConflict",
	11000: "DuplicateKey",
	121: "DocumentValidationFailure",
	123: "NotAReplicaSet",
	251: "NoSuchTransaction",
	40414: "IDLFailedToParse",
};

/** The `codeName` MongoDB pairs with a numeric error code, if known. */
export function codeNameFor(code: number | undefined): string | undefined {
	return code === undefined ? undefined : CODE_NAMES[code];
}

/** Base class for all MongoDB-compatible errors. */
export class MongoError extends Error {
	/** Numeric error code, when available. */
	code?: number;

	/** @internal Labels attached to this error (see `hasErrorLabel`). */
	private readonly _errorLabels!: Set<string>;

	constructor(message: string, options?: { cause?: unknown }) {
		// `cause` is passed through so the originating SurrealDB error stays
		// reachable instead of being flattened into a string.
		super(message, options as ErrorOptions | undefined);
		this.name = "MongoError";
		// Non-enumerable so driver bookkeeping does not show up when an error is
		// logged, inspected, or JSON-serialised by application code.
		Object.defineProperty(this, "_errorLabels", {
			value: new Set<string>(),
			enumerable: false,
			writable: false,
			configurable: false,
		});
	}

	/** Labels describing this error, e.g. `TransientTransactionError`. */
	get errorLabels(): string[] {
		return [...this._errorLabels];
	}

	/** True when this error carries `label`. */
	hasErrorLabel(label: string): boolean {
		return this._errorLabels.has(label);
	}

	/** @internal Attach a label. */
	addErrorLabel(label: string): void {
		this._errorLabels.add(label);
	}
}

// ---------------------------------------------------------------------------
// Driver-side errors
// ---------------------------------------------------------------------------

/**
 * Base class for errors originating in the driver rather than the server.
 */
export class MongoDriverError extends MongoError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "MongoDriverError";
	}
}

/** Errors caused by incorrect use of the driver's public API. */
export class MongoAPIError extends MongoDriverError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "MongoAPIError";
	}
}

/** An unexpected internal failure that is not the caller's fault. */
export class MongoRuntimeError extends MongoDriverError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "MongoRuntimeError";
	}
}

/** A connection string (or other driver input) could not be parsed. */
export class MongoParseError extends MongoDriverError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "MongoParseError";
	}
}

/** An operation exceeded its client-side timeout budget. */
export class MongoOperationTimeoutError extends MongoDriverError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "MongoOperationTimeoutError";
	}
}

/**
 * Thrown when the connected server cannot support the driver — most notably a
 * SurrealDB release older than the minimum this driver targets.
 */
export class MongoCompatibilityError extends MongoAPIError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "MongoCompatibilityError";
	}
}

/** An argument was missing, of the wrong type, or mutually exclusive. */
export class MongoInvalidArgumentError extends MongoAPIError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "MongoInvalidArgumentError";
	}
}

/** Thrown when an operation is attempted without an active connection. */
export class MongoNotConnectedError extends MongoAPIError {
	constructor(
		message = "MongoClient must be connected before performing this operation",
	) {
		super(message);
		this.name = "MongoNotConnectedError";
	}
}

/** Thrown when iterating a cursor that is already exhausted or closed. */
export class MongoCursorExhaustedError extends MongoAPIError {
	constructor(message = "Cursor is exhausted or has been closed") {
		super(message);
		this.name = "MongoCursorExhaustedError";
	}
}

/** Thrown when a cursor is reconfigured after iteration has begun. */
export class MongoCursorInUseError extends MongoAPIError {
	constructor(message = "Cursor is already initialized") {
		super(message);
		this.name = "MongoCursorInUseError";
	}
}

/** Thrown when the client has been closed. */
export class MongoTopologyClosedError extends MongoAPIError {
	constructor(message = "Topology is closed") {
		super(message);
		this.name = "MongoTopologyClosedError";
	}
}

/** Thrown when a session is used after `endSession()`. */
export class MongoExpiredSessionError extends MongoAPIError {
	constructor(message = "Cannot use a session that has ended") {
		super(message);
		this.name = "MongoExpiredSessionError";
	}
}

/** Thrown for invalid transaction state transitions and unsupported usage. */
export class MongoTransactionError extends MongoAPIError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "MongoTransactionError";
	}
}

/**
 * Client-side validation / usage errors.
 *
 * @deprecated Not a class in the official driver. Prefer `MongoAPIError` or one
 * of its subclasses — `MongoInvalidArgumentError`, `MongoParseError`,
 * `MongoCursorInUseError` — so error handling written against `mongodb`
 * narrows correctly. Retained under `MongoAPIError` so existing
 * `catch (e) { if (e instanceof MongoClientError) … }` keeps working.
 */
export class MongoClientError extends MongoAPIError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "MongoClientError";
	}
}

// ---------------------------------------------------------------------------
// Server-side errors
// ---------------------------------------------------------------------------

/** A single write failure, as reported inside `MongoServerError.writeErrors`. */
export interface WriteError {
	index: number;
	code: number;
	errmsg: string;
	/** The offending key pattern, for duplicate-key failures. */
	keyPattern?: Record<string, number>;
	/** The offending key value, for duplicate-key failures. */
	keyValue?: Record<string, unknown>;
}

export interface MongoServerErrorOptions {
	code?: number;
	codeName?: string;
	cause?: unknown;
	keyPattern?: Record<string, number>;
	keyValue?: Record<string, unknown>;
	writeErrors?: WriteError[];
	errInfo?: Record<string, unknown>;
}

/**
 * Errors returned by the server (query failures, constraint violations, …).
 *
 * Carries the same fields the official driver surfaces, so `err.code`,
 * `err.codeName` and — for duplicate keys — `err.keyPattern` / `err.keyValue`
 * are all populated rather than left `undefined`.
 */
export class MongoServerError extends MongoError {
	/** Symbolic name matching `code`, e.g. `"DuplicateKey"`. */
	codeName?: string;

	/** The server's raw error message. */
	errmsg: string;

	/** Index key pattern that rejected the write (duplicate key only). */
	keyPattern?: Record<string, number>;

	/** Index key value that was rejected (duplicate key only). */
	keyValue?: Record<string, unknown>;

	/** Per-write failures for batched operations. */
	writeErrors?: WriteError[];

	/** Structured validation detail, when the server supplies it. */
	errInfo?: Record<string, unknown>;

	constructor(message: string, options?: MongoServerErrorOptions | number) {
		// The second parameter used to be a bare `code`; keep that working.
		const opts: MongoServerErrorOptions =
			typeof options === "number" ? { code: options } : (options ?? {});

		super(message, { cause: opts.cause });
		this.name = "MongoServerError";
		this.errmsg = message;
		this.code = opts.code;
		this.codeName = opts.codeName ?? codeNameFor(opts.code);
		if (opts.keyPattern) this.keyPattern = opts.keyPattern;
		if (opts.keyValue) this.keyValue = opts.keyValue;
		if (opts.writeErrors) this.writeErrors = opts.writeErrors;
		if (opts.errInfo) this.errInfo = opts.errInfo;
	}
}

/** What a partially applied batch managed to do, as MongoDB reports it. */
export interface BulkWriteOutcome {
	/** Documents that were written. */
	insertedCount: number;
	/** The `_id` of each written document, keyed by its index in the batch. */
	insertedIds: Record<number, unknown>;
	/**
	 * The counts only a `bulkWrite` can produce.
	 *
	 * Optional because `insertMany` raises this error too, and a batch of inserts
	 * has nothing to say about matches or deletions. A `bulkWrite` fills all of
	 * them in, so a caller who mixed models can still tell what landed.
	 */
	matchedCount?: number;
	modifiedCount?: number;
	deletedCount?: number;
	upsertedCount?: number;
	upsertedIds?: Record<number, unknown>;
}

/**
 * A batch write that partly succeeded.
 *
 * MongoDB reports a failed `insertMany` this way rather than as a plain error,
 * because "it failed" is not the whole answer: some documents are in the
 * collection and the caller has to know which. `writeErrors` names the ones that
 * were refused by their index in the batch, and `result` accounts for the rest.
 */
export class MongoBulkWriteError extends MongoServerError {
	/** What the batch did manage to write. */
	result: BulkWriteOutcome;

	/** One entry per refused document, in batch order. */
	declare writeErrors: WriteError[];

	constructor(
		message: string,
		options: MongoServerErrorOptions & {
			writeErrors: WriteError[];
			result: BulkWriteOutcome;
		},
	) {
		super(message, options);
		this.name = "MongoBulkWriteError";
		this.result = options.result;
		this.writeErrors = options.writeErrors;
	}

	/** Documents written before the batch stopped. */
	get insertedCount(): number {
		return this.result.insertedCount;
	}

	/** The `_id` of each written document, keyed by its index in the batch. */
	get insertedIds(): Record<number, unknown> {
		return this.result.insertedIds;
	}
}

/** A write succeeded but the requested write concern could not be satisfied. */
export class MongoWriteConcernError extends MongoServerError {
	constructor(message: string, options?: MongoServerErrorOptions) {
		super(message, options);
		this.name = "MongoWriteConcernError";
	}
}

// ---------------------------------------------------------------------------
// Network / topology errors
// ---------------------------------------------------------------------------

/** Network / connection errors. */
export class MongoNetworkError extends MongoError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "MongoNetworkError";
	}
}

/** A network operation timed out. */
export class MongoNetworkTimeoutError extends MongoNetworkError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "MongoNetworkTimeoutError";
	}
}

/** An error in the driver's view of the deployment. */
export class MongoSystemError extends MongoError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "MongoSystemError";
	}
}

/** No suitable server could be selected within the timeout. */
export class MongoServerSelectionError extends MongoSystemError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "MongoServerSelectionError";
	}
}
