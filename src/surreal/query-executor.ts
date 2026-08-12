/**
 * Driver port: the only seam through which the rest of the codebase talks
 * to SurrealDB. Implementations (real SDK adapter, in-memory fakes for
 * testing) can be swapped without touching translators or operations.
 */

import type { RecordId } from "surrealdb";

/**
 * A SurrealDB record id reference – either a typed `RecordId` object or
 * the string form (`table:id`).
 */
export type RecordIdLike = RecordId | string;

/** What one statement of a multi-statement dispatch did. */
export interface StatementOutcome {
	/** Whether the statement applied. */
	readonly ok: boolean;
	/** The statement's result, when it applied. */
	readonly value: unknown;
	/** Why it did not, already translated to this driver's error taxonomy. */
	readonly error: unknown;
}

/**
 * Subset of the SurrealDB driver API used by the rest of the codebase.
 *
 * Wrapping the SDK behind this interface satisfies the Dependency
 * Inversion Principle: high-level operations depend on this abstraction
 * rather than the concrete `Surreal` class.
 *
 * Every read and write goes through `query`, including the inserts the SDK
 * offers shortcuts for: only a statement can carry the clauses a caller's
 * options become — `TIMEOUT` above all — so one path keeps the option policy
 * from applying to some writes and not others.
 */
export interface QueryExecutor {
	/**
	 * Run a SurrealQL statement (or batch) and return the result of the caller's
	 * first statement only. Errors are mapped to `MongoServerError`.
	 *
	 * "The caller's" rather than "the query's": an executor addressing a database
	 * other than the connected one sends a `USE DB` ahead of what it was given, and
	 * skipping that reply is its business rather than the caller's — see
	 * `src/surreal/database-scope.ts`.
	 */
	query<T = unknown>(
		sql: string,
		bindings?: Record<string, unknown>,
	): Promise<T>;

	/**
	 * Run every statement in `sql` and report each outcome, rather than throwing on
	 * the first failure.
	 *
	 * `query` is right for a statement whose failure is the whole operation's
	 * failure, which is nearly all of them. This exists for the one place where the
	 * failures *are* the answer: MongoDB's `insertMany` has to say which documents
	 * of a batch were refused and which were written, so the outcome of every
	 * statement is needed and not just the first one that went wrong.
	 *
	 * Statements sent this way are separate SurrealDB statements, so each runs in
	 * its own implicit transaction and one failing does not roll back the others —
	 * measured, and the whole reason this can express a partial batch at all.
	 */
	queryEach(
		sql: string,
		bindings?: Record<string, unknown>,
	): Promise<readonly StatementOutcome[]>;

	/**
	 * The version reported by the connected SurrealDB server, if known.
	 */
	readonly serverVersion: string | undefined;

	/**
	 * Close the underlying connection.
	 */
	close(): Promise<void>;
}
