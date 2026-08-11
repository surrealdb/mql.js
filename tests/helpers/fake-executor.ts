/**
 * In-memory `QueryExecutor` for unit tests.
 *
 * Records every `query` call and returns a programmable queue of responses.
 * Lets us assert exactly which SurrealQL strings + bindings the operation
 * modules produce without spinning up a real database.
 */

import type { QueryExecutor } from "../../src/surreal/query-executor.ts";

export interface RecordedQuery {
	sql: string;
	bindings: Record<string, unknown> | undefined;
}

export class FakeQueryExecutor implements QueryExecutor {
	serverVersion: string | undefined = undefined;

	readonly queries: RecordedQuery[] = [];
	closed = false;

	/** Queued responses returned in order from `query()`. */
	private readonly responses: unknown[] = [];
	/** Optional per-call hook; runs before the queued response is consumed. */
	private queryHook: ((q: RecordedQuery) => void) | undefined;

	/** Push `value` so the next (or N-th later) `query()` returns it. */
	enqueue(value: unknown): this {
		this.responses.push(value);
		return this;
	}

	enqueueMany(values: unknown[]): this {
		for (const v of values) this.responses.push(v);
		return this;
	}

	/** Configure a hook that fires for every `query()` call. */
	onQuery(fn: (q: RecordedQuery) => void): this {
		this.queryHook = fn;
		return this;
	}

	async query<T = unknown>(
		sql: string,
		bindings?: Record<string, unknown>,
	): Promise<T> {
		const recorded: RecordedQuery = { sql, bindings };
		this.queries.push(recorded);
		this.queryHook?.(recorded);
		if (this.responses.length === 0) {
			return undefined as T;
		}
		return this.responses.shift() as T;
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}
