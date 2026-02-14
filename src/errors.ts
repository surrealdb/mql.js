/**
 * MongoDB-compatible error hierarchy.
 *
 * Provides familiar error types so that existing MongoDB error-handling
 * code (try/catch on MongoServerError, etc.) continues to work.
 */

/** Base class for all MongoDB-compatible errors. */
export class MongoError extends Error {
	/** Numeric error code, when available. */
	code?: number;

	constructor(message: string) {
		super(message);
		this.name = "MongoError";
	}
}

/** Errors returned by the SurrealDB server (query failures, constraint violations, etc.). */
export class MongoServerError extends MongoError {
	constructor(message: string, code?: number) {
		super(message);
		this.name = "MongoServerError";
		this.code = code;
	}
}

/** Client-side validation / usage errors. */
export class MongoClientError extends MongoError {
	constructor(message: string) {
		super(message);
		this.name = "MongoClientError";
	}
}

/** Network / connection errors. */
export class MongoNetworkError extends MongoError {
	constructor(message: string) {
		super(message);
		this.name = "MongoNetworkError";
	}
}

/** Thrown when iterating a cursor that is already exhausted or closed. */
export class MongoCursorExhaustedError extends MongoError {
	constructor() {
		super("Cursor is exhausted or has been closed");
		this.name = "MongoCursorExhaustedError";
	}
}

/** Thrown when an operation is attempted without an active connection. */
export class MongoNotConnectedError extends MongoClientError {
	constructor() {
		super("MongoClient must be connected before performing this operation");
		this.name = "MongoNotConnectedError";
	}
}
