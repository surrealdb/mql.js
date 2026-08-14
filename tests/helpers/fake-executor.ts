/**
 * In-memory `QueryExecutor` for unit tests.
 *
 * Records every `query` call and returns a programmable queue of responses.
 * Lets us assert exactly which SurrealQL strings + bindings the operation
 * modules produce without spinning up a real database.
 */

import type {
	QueryExecutor,
	StatementOutcome,
} from "../../src/surreal/query-executor.ts";

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
	/** Queued per-statement outcomes returned in order from `queryEach()`. */
	private readonly outcomes: readonly StatementOutcome[][] = [];
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

	/**
	 * Push the outcomes the next `queryEach()` reports.
	 *
	 * Separate from `enqueue` because the two answer different questions: a
	 * `queryEach` caller is asking what each statement did, and half of the point is
	 * that some of them failed.
	 */
	enqueueOutcomes(values: readonly StatementOutcome[]): this {
		(this.outcomes as StatementOutcome[][]).push([...values]);
		return this;
	}

	/** Shorthand: every statement in the next `queryEach()` applied. */
	enqueueAllOk(count: number, value: unknown = null): this {
		return this.enqueueOutcomes(
			Array.from({ length: count }, () => ({
				ok: true,
				value,
				error: undefined,
			})),
		);
	}

	/** Configure a hook that fires for every `query()` call. */
	onQuery(fn: (q: RecordedQuery) => void): this {
		this.queryHook = fn;
		return this;
	}

	/**
	 * The last statement's result, which for the fake is the next queued response:
	 * nothing here splits a batch into frames, so a test asserting on a `$lookup`
	 * queues the answer it wants and reads the SQL to check the shape.
	 */
	async queryLast<T = unknown>(
		sql: string,
		bindings?: Record<string, unknown>,
	): Promise<T> {
		return this.query<T>(sql, bindings);
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

	async queryEach(
		sql: string,
		bindings?: Record<string, unknown>,
	): Promise<readonly StatementOutcome[]> {
		const recorded: RecordedQuery = { sql, bindings };
		this.queries.push(recorded);
		this.queryHook?.(recorded);
		const queued = (this.outcomes as StatementOutcome[][]).shift();
		if (queued) return queued;
		// Nothing queued: every statement applied, one outcome per statement, which
		// is what an operation that only counts them expects.
		const statements = sql.split(";").filter((part) => part.trim().length > 0);
		return statements.map(() => ({
			ok: true,
			value: null,
			error: undefined,
		}));
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}
