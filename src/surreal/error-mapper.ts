/**
 * Centralised error translation: anything thrown by the underlying SurrealDB
 * SDK (or by network/auth issues) is converted to the corresponding
 * MongoDB-shaped error class.
 */

import { AuthenticationError, ServerError } from "surrealdb";
import { MongoNetworkError, MongoServerError } from "../errors.ts";

/** Normalise an unknown thrown value to a string message. */
function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Map an error thrown by `surrealdb.Surreal.query()`/`create()`/`insert()`
 * into a `MongoServerError`. Keeps existing `MongoServerError`s intact.
 */
export function mapQueryError(err: unknown): MongoServerError {
	if (err instanceof MongoServerError) return err;
	return new MongoServerError(messageOf(err));
}

/**
 * Map an error thrown by `surrealdb.Surreal.connect()` or by the connection
 * watchdog into the appropriate Mongo error class.
 */
export function mapConnectError(err: unknown): Error {
	if (err instanceof MongoNetworkError || err instanceof MongoServerError) {
		return err;
	}
	if (err instanceof AuthenticationError || err instanceof ServerError) {
		return new MongoServerError(err.message);
	}
	return new MongoNetworkError(
		`Failed to connect to SurrealDB: ${messageOf(err)}`,
	);
}
