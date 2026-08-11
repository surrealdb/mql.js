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

/**
 * Base class for errors originating in the driver rather than the server.
 *
 * Mirrors the official driver's hierarchy
 * (`MongoError` → `MongoDriverError` → `MongoAPIError` → …) so that
 * `instanceof` narrowing written against `mongodb` behaves the same here.
 */
export class MongoDriverError extends MongoError {
	constructor(message: string) {
		super(message);
		this.name = "MongoDriverError";
	}
}

/** Errors caused by incorrect use of the driver's public API. */
export class MongoAPIError extends MongoDriverError {
	constructor(message: string) {
		super(message);
		this.name = "MongoAPIError";
	}
}

/**
 * Thrown when the connected server cannot support the driver — most notably a
 * SurrealDB release older than the minimum this driver targets.
 */
export class MongoCompatibilityError extends MongoAPIError {
	constructor(message: string) {
		super(message);
		this.name = "MongoCompatibilityError";
	}
}

/**
 * Client-side validation / usage errors.
 *
 * @deprecated Not a class in the official driver. Prefer `MongoAPIError` (or
 * one of its subclasses) so error handling written against `mongodb` narrows
 * correctly. Retained — and re-parented under `MongoAPIError` — so existing
 * `catch (e) { if (e instanceof MongoClientError) … }` keeps working.
 */
export class MongoClientError extends MongoAPIError {
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
