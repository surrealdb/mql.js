/**
 * A `QueryExecutor` bound to one SurrealDB transaction.
 *
 * This is the whole mechanism behind sessions: a statement routed here runs
 * inside the transaction and sees its uncommitted writes, while the same
 * statement routed through the base executor does not. Because it satisfies the
 * same port as `SurrealdbExecutor`, an operation needs no knowledge of sessions
 * at all — choosing this executor over that one is the entire difference.
 *
 * Two guarantees are added on top of the SDK handle:
 *
 *   - **serialisation.** MongoDB forbids concurrent operations on one
 *     transaction, and the SDK cheerfully interleaves them. Everything issued
 *     here queues behind whatever is already in flight, including the commit, so
 *     two overlapping writes apply in call order and a commit never lands
 *     between a statement's dispatch and its reply.
 *   - **single use.** The SDK handle is spent by `commit()` or `cancel()` and
 *     answers anything further with "Transaction not found". Reaching it in that
 *     state would report a server error for what is really a driver-side
 *     lifecycle mistake, so the spent handle is never dialled again.
 */

import { MongoTransactionError } from "../errors.ts";
import { mapQueryError } from "./error-mapper.ts";
import type { QueryExecutor } from "./query-executor.ts";

/**
 * The part of the SDK's `SurrealTransaction` this driver uses.
 *
 * Structural rather than nominal so unit tests can drive the state machine with
 * a handle that records calls instead of a live connection.
 */
export interface TransactionHandle {
	query<R extends unknown[] = unknown[]>(
		sql: string,
		bindings?: Record<string, unknown>,
	): PromiseLike<R>;
	commit(): Promise<void>;
	cancel(): Promise<void>;
}

/** An executor whose statements run inside a transaction it can settle. */
export interface TransactionScope extends QueryExecutor {
	/** Apply everything issued through this scope. */
	commit(): Promise<void>;
	/** Discard everything issued through this scope. */
	cancel(): Promise<void>;
	/** False once `commit()` or `cancel()` has been called. */
	readonly isLive: boolean;
}

export class TransactionExecutor implements TransactionScope {
	private readonly handle: TransactionHandle;
	private readonly _serverVersion: string | undefined;
	private _isLive = true;
	/** Tail of the serialisation chain: the last operation queued. */
	private tail: Promise<unknown> = Promise.resolve();

	constructor(handle: TransactionHandle, serverVersion: string | undefined) {
		this.handle = handle;
		this._serverVersion = serverVersion;
	}

	get serverVersion(): string | undefined {
		return this._serverVersion;
	}

	get isLive(): boolean {
		return this._isLive;
	}

	async query<T = unknown>(
		sql: string,
		bindings?: Record<string, unknown>,
	): Promise<T> {
		return this.enqueue(async () => {
			this.assertLive("run a statement in");
			try {
				const results = await this.handle.query<[T]>(sql, bindings);
				return results[0];
			} catch (err) {
				throw mapQueryError(err);
			}
		});
	}

	async commit(): Promise<void> {
		return this.enqueue(async () => {
			this.assertLive("commit");
			// Marked spent before the round trip rather than after: a commit that
			// fails mid-flight has still consumed the handle, and a retry against it
			// would report "Transaction not found" instead of the real failure.
			this._isLive = false;
			try {
				await this.handle.commit();
			} catch (err) {
				throw mapQueryError(err);
			}
		});
	}

	async cancel(): Promise<void> {
		return this.enqueue(async () => {
			this.assertLive("abort");
			this._isLive = false;
			try {
				await this.handle.cancel();
			} catch (err) {
				throw mapQueryError(err);
			}
		});
	}

	/**
	 * Discard the transaction.
	 *
	 * The port's `close()` means "release what this executor holds", and what a
	 * transaction holds is uncommitted work — not the connection, which outlives
	 * it and belongs to the client.
	 */
	async close(): Promise<void> {
		if (this._isLive) await this.cancel();
	}

	/**
	 * Queue `work` behind everything already in flight.
	 *
	 * A failed predecessor must not stall the queue — an aborted statement is
	 * followed by the abort that cleans up after it — so the chain advances on
	 * rejection as well as on fulfilment.
	 */
	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const result = this.tail.then(work, work);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private assertLive(action: string): void {
		if (this._isLive) return;
		throw new MongoTransactionError(
			`Cannot ${action} a transaction that has already been committed or aborted`,
		);
	}
}
