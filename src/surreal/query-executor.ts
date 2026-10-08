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
	 * Run a batch and return the result of its **last** statement.
	 *
	 * `query` answers with the caller's first statement, which is what nearly every
	 * operation wants, because nearly every operation sends one. A batch whose
	 * earlier statements exist to set something up needs the other end: an
	 * aggregation `$lookup` binds the outer rows and the matching foreign rows to
	 * `LET` variables and then reads them, so the answer is the third statement and
	 * the first two are working.
	 *
	 * Reading the last frame is right whether or not a `USE DB` prefix was added,
	 * since the prefix only ever goes in front.
	 */
	queryLast<T = unknown>(
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
	 * The rows of the caller's first statement, one at a time as they arrive.
	 *
	 * `query` hands back everything at once, which is what nearly every operation
	 * wants. A cursor that is read a row at a time wants the first rows while the
	 * rest are still being produced, and wants to be able to stop: `return()` on
	 * the iterator stops the statement on the server, so a consumer that has read
	 * what it needs does not leave rows being produced for nobody.
	 *
	 * Nothing is sent until the first `next()`. A failure — the statement's own, or
	 * a connection lost partway — is thrown from `next()` and can follow rows the
	 * caller has already been given, as a MongoDB `getMore` can.
	 *
	 * Only a statement that answers with a list belongs here; for anything else use
	 * `query`. Inside a transaction the rows are read whole and handed out from
	 * memory, because a transaction is serialised and a half-read stream would hold
	 * everything behind it.
	 */
	queryRows<T = unknown>(
		sql: string,
		bindings?: Record<string, unknown>,
	): AsyncIterableIterator<T>;

	/**
	 * This executor, with every statement it sends stopped by `signal`.
	 *
	 * A signal that is already aborted sends nothing and rejects with its reason;
	 * one that aborts while a statement is in flight rejects with the reason too —
	 * the signal's own, untouched, as MongoDB's driver does, so a caller can tell a
	 * `controller.abort()` from an `AbortSignal.timeout()`.
	 *
	 * What reaches the server depends on it. From SurrealDB 3.3.0, over a
	 * WebSocket, a query is cancelled there too and later statements do not run (a
	 * statement already running is not undone). Anywhere else the caller stops
	 * waiting and the statement runs to its end.
	 */
	withSignal(signal: AbortSignal): QueryExecutor;

	/**
	 * The version reported by the connected SurrealDB server, if known.
	 */
	readonly serverVersion: string | undefined;

	/**
	 * Close the underlying connection.
	 */
	close(): Promise<void>;
}
