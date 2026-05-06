/**
 * Driver port: the only seam through which the rest of the codebase talks
 * to SurrealDB. Implementations (real SDK adapter, in-memory fakes for
 * testing) can be swapped without touching translators or operations.
 */

import type { RecordId, Table } from "surrealdb";
import type { Document } from "../types.ts";

/**
 * A SurrealDB record id reference – either a typed `RecordId` object or
 * the string form (`table:id`).
 */
export type RecordIdLike = RecordId | string;

/**
 * Subset of the SurrealDB driver API used by the rest of the codebase.
 *
 * Wrapping the SDK behind this interface satisfies the Dependency
 * Inversion Principle: high-level operations depend on this abstraction
 * rather than the concrete `Surreal` class.
 */
export interface QueryExecutor {
	/**
	 * Run a SurrealQL statement (or batch) and return the result of the
	 * first statement only. Errors are mapped to `MongoServerError`.
	 */
	query<T = unknown>(
		sql: string,
		bindings?: Record<string, unknown>,
	): Promise<T>;

	/**
	 * Create a single record with the given content.
	 */
	createRecord(recordId: RecordIdLike, content: Document): Promise<void>;

	/**
	 * Bulk-insert records into a table.
	 */
	insertMany(table: Table | string, docs: Document[]): Promise<void>;

	/**
	 * The version reported by the connected SurrealDB server, if known.
	 */
	readonly serverVersion: string | undefined;

	/**
	 * Close the underlying connection.
	 */
	close(): Promise<void>;
}
