/**
 * Which database a statement addresses.
 *
 * A SurrealDB connection is pointed at one database, and `MongoClient.db(name)`
 * asks for another one. SurrealQL answers that per statement: a leading
 * `USE DB other` switches the database for the statements sent with it and for
 * nothing else — the next query on the same connection is back on the connected
 * database, and a `USE` sent inside a transaction is confined to that one
 * dispatch too. Measured on SurrealDB 3.0, 3.1 and 3.2 alike. That is what lets
 * one connection serve every database a caller names, with no second session, no
 * extra round trip and nothing to re-establish after a reconnect.
 *
 * The prefix costs a result frame, and it shifts every frame after it along.
 * Emitting the prefix and deciding which frame to read are therefore the same
 * decision, and they are taken together here: `ScopedExecutor.query` writes the
 * prefix, computes the frame its caller's own statement landed in, and returns
 * that frame. An implementation supplies `dispatch`, which sends a statement and
 * hands back every frame without choosing between them — so no implementation
 * and no call site is in a position to read the wrong one.
 *
 * The connected database needs no prefix at all, which is the overwhelmingly
 * common case: `forDatabase(undefined)` hands back the same executor, so
 * `client.db()` and `client.db(<the connected database>)` emit exactly the
 * statement they always did.
 */

import type { QueryExecutor, StatementOutcome } from "./query-executor.ts";
import { escapeIdentifier } from "./sql/escape.ts";

/** A statement as it goes out, and the index of the frame holding its result. */
export interface ScopedStatement {
	/** The SurrealQL to send, database prefix included. */
	readonly sql: string;
	/** Index into the reply at which `sql`'s own first statement answers. */
	readonly frame: number;
}

/**
 * Address `sql` at `database`, or leave it alone for the connected one.
 *
 * `USE DB` is the strictest identifier position SurrealQL has, because it reads
 * its argument as an *expression* rather than as a name: bare `USE DB function`
 * is a parse error, and bare `USE DB INFO FOR DB` panics the server outright
 * (surrealdb/surrealdb-private#903). `escapeIdentifier` quoting every name is
 * what keeps a caller-supplied database name from reaching that — a quoted name
 * is only ever a name.
 *
 * Exported for the tests that pin the arithmetic: the frame index is only ever
 * correct because it is produced by whatever produced the prefix.
 */
export function scopeStatement(
	sql: string,
	database: string | undefined,
): ScopedStatement {
	if (database === undefined) return { sql, frame: 0 };
	return { sql: `USE DB ${escapeIdentifier(database)}; ${sql}`, frame: 1 };
}

/** Send a statement and return every frame of the reply. */
type Dispatch = (
	sql: string,
	bindings?: Record<string, unknown>,
) => Promise<readonly unknown[]>;

/** Send a statement and return what each of its statements did. */
type DispatchEach = (
	sql: string,
	bindings?: Record<string, unknown>,
) => Promise<readonly StatementOutcome[]>;

/**
 * A `QueryExecutor` that knows which database its statements address.
 *
 * `query` is deliberately not overridable: everything a subclass contributes is
 * in `dispatch`, which is handed a finished statement and returns the whole
 * reply.
 */
export abstract class ScopedExecutor implements QueryExecutor {
	/** The database statements are addressed at; `undefined` for the connected one. */
	protected readonly database: string | undefined;

	constructor(database: string | undefined) {
		this.database = database;
	}

	abstract get serverVersion(): string | undefined;

	abstract close(): Promise<void>;

	/** Send `sql` as given, returning one entry per statement in it. */
	protected abstract dispatch(
		sql: string,
		bindings?: Record<string, unknown>,
	): Promise<readonly unknown[]>;

	/**
	 * Send `sql` as given, returning what each statement in it did — including the
	 * ones that failed, which `dispatch` throws on.
	 */
	protected abstract dispatchEach(
		sql: string,
		bindings?: Record<string, unknown>,
	): Promise<readonly StatementOutcome[]>;

	async query<T = unknown>(
		sql: string,
		bindings?: Record<string, unknown>,
	): Promise<T> {
		const scoped = scopeStatement(sql, this.database);
		const frames = await this.dispatch(scoped.sql, bindings);
		return frames[scoped.frame] as T;
	}

	async queryEach(
		sql: string,
		bindings?: Record<string, unknown>,
	): Promise<readonly StatementOutcome[]> {
		const scoped = scopeStatement(sql, this.database);
		const outcomes = await this.dispatchEach(scoped.sql, bindings);
		// The prefix's own outcome belongs to this class, not to the caller — the
		// same reason `query` reads one frame rather than the first.
		return outcomes.slice(scoped.frame);
	}

	/**
	 * An executor addressing `database` over this one's connection.
	 *
	 * `undefined` means the connected database, so a caller that has not asked for
	 * another one is handed this executor back rather than a wrapper around it —
	 * which is also what makes "is this the connection or a transaction?"
	 * answerable by identity.
	 */
	forDatabase(database: string | undefined): QueryExecutor {
		if (database === this.database) return this;
		return new ScopedView(
			this,
			(sql, bindings) => this.dispatch(sql, bindings),
			(sql, bindings) => this.dispatchEach(sql, bindings),
			database,
		);
	}
}

/**
 * One executor seen as addressing a different database.
 *
 * It borrows the dispatch of the executor it came from, so a view of a
 * transaction is still that transaction — the same serialisation queue, the same
 * single-use handle — and a view of the connection is still that connection.
 * Nothing is allocated server-side, which is why these can be handed out per
 * database name and simply forgotten.
 */
class ScopedView extends ScopedExecutor {
	private readonly root: QueryExecutor;
	private readonly send: Dispatch;
	private readonly sendEach: DispatchEach;

	constructor(
		root: QueryExecutor,
		send: Dispatch,
		sendEach: DispatchEach,
		database: string | undefined,
	) {
		super(database);
		this.root = root;
		this.send = send;
		this.sendEach = sendEach;
	}

	get serverVersion(): string | undefined {
		// Read through rather than copied: the version is detected after connect,
		// which may be later than the `db(name)` that created this view.
		return this.root.serverVersion;
	}

	protected dispatch(
		sql: string,
		bindings?: Record<string, unknown>,
	): Promise<readonly unknown[]> {
		return this.send(sql, bindings);
	}

	protected dispatchEach(
		sql: string,
		bindings?: Record<string, unknown>,
	): Promise<readonly StatementOutcome[]> {
		return this.sendEach(sql, bindings);
	}

	async close(): Promise<void> {
		await this.root.close();
	}
}
