/**
 * The SDK adapter's streamed read, against a stub of the part of `Surreal` it
 * uses. What a live server does with the stream is the integration suite's to
 * show; what is pinned here is what this adapter asks of the SDK.
 */

import { describe, expect, test } from "bun:test";
import { type Surreal, ValidationError } from "surrealdb";
import { MongoServerError } from "../../../src/errors.ts";
import type { ScopedExecutor } from "../../../src/surreal/database-scope.ts";
import type { StreamedFrame } from "../../../src/surreal/row-stream.ts";
import { SurrealdbExecutor } from "../../../src/surreal/surrealdb-executor.ts";

const valueFrame = (query: number, row: unknown): StreamedFrame => ({
	query,
	value: row,
	isValue: () => true,
	isError: () => false,
});
const errorFrame = (query: number, error: unknown): StreamedFrame => ({
	query,
	error,
	isValue: () => false,
	isError: () => true,
});

interface Stub {
	surreal: Surreal;
	/** Every `query()` made, with whether it was then streamed or awaited. */
	calls: {
		sql: string;
		bindings: unknown;
		streamed: boolean;
		signal?: AbortSignal;
	}[];
}

/**
 * A `Surreal` whose queries can be streamed (`signal(...).stream()`) or awaited.
 * `stream` supplies the frames; `buffered` is what awaiting answers.
 */
function stub(options: {
	stream: () => AsyncIterable<StreamedFrame>;
	buffered?: unknown[];
}): Stub {
	const calls: Stub["calls"] = [];
	const surreal = {
		query(sql: string, bindings?: unknown) {
			const call: Stub["calls"][number] = { sql, bindings, streamed: false };
			calls.push(call);
			// A real promise with the SDK query's other methods attached, as the
			// transaction tests build theirs: awaiting it answers whole.
			const query: Promise<unknown> & {
				signal(signal: AbortSignal): unknown;
				stream(): AsyncIterable<StreamedFrame>;
			} = Object.assign(Promise.resolve(options.buffered ?? []), {
				signal(signal: AbortSignal) {
					call.signal = signal;
					return query;
				},
				stream() {
					call.streamed = true;
					return options.stream();
				},
			});
			return query;
		},
	} as unknown as Surreal;
	return { surreal, calls };
}

async function collect<T>(rows: AsyncIterableIterator<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const row of rows) out.push(row);
	return out;
}

const framesOf = (frames: StreamedFrame[]) => () => ({
	async *[Symbol.asyncIterator]() {
		yield* frames;
	},
});

describe("SurrealdbExecutor.queryRows", () => {
	test("streams the statement's rows, and nothing is sent before the first read", async () => {
		const { surreal, calls } = stub({
			stream: framesOf([valueFrame(0, "a"), valueFrame(0, "b")]),
		});
		const rows = new SurrealdbExecutor(surreal).queryRows("SELECT 1", { x: 1 });
		expect(calls).toEqual([]);

		expect(await collect(rows)).toEqual(["a", "b"]);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			sql: "SELECT 1",
			bindings: { x: 1 },
			streamed: true,
		});
	});

	test("hands the SDK a signal, which is what stops the server", async () => {
		const { surreal, calls } = stub({
			stream: framesOf([valueFrame(0, "a"), valueFrame(0, "b")]),
		});
		const rows = new SurrealdbExecutor(surreal).queryRows("SELECT 1");
		await rows.next();
		expect(calls[0]?.signal?.aborted).toBe(false);

		await rows.return?.();
		expect(calls[0]?.signal?.aborted).toBe(true);
	});

	test("a scoped statement streams the frame after its USE DB, never the USE's own answer", async () => {
		const { surreal, calls } = stub({
			stream: framesOf([
				valueFrame(0, { namespace: "ns", database: "other" }),
				valueFrame(1, "doc"),
			]),
		});
		const view = new SurrealdbExecutor(surreal).forDatabase("other");

		expect(await collect(view.queryRows("SELECT 1"))).toEqual(["doc"]);
		expect(calls[0]?.sql).toBe("USE DB `other`; SELECT 1");
	});

	test("a failed statement is thrown in this driver's taxonomy", async () => {
		const { surreal } = stub({
			stream: framesOf([errorFrame(0, new Error("boom"))]),
		});
		const err = await new SurrealdbExecutor(surreal)
			.queryRows("SELECT 1")
			.next()
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(MongoServerError);
	});
});

describe("SurrealdbExecutor.queryRows – a server at its stream limit", () => {
	const cap = () =>
		new ValidationError({
			kind: "Validation",
			message: "Too many concurrent streaming queries",
		} as never);

	const refused = () => ({
		[Symbol.asyncIterator]: () => ({
			next: async () => {
				throw cap();
			},
		}),
	});

	test("is read whole instead of failing a cursor MongoDB would allow", async () => {
		const { surreal, calls } = stub({
			stream: refused,
			buffered: [["a", "b"]],
		});
		const rows = new SurrealdbExecutor(surreal).queryRows("SELECT 1");

		expect(await collect(rows)).toEqual(["a", "b"]);
		// Once streamed and refused, once asked for whole.
		expect(calls.map((c) => c.streamed)).toEqual([true, false]);
		expect(calls[1]?.sql).toBe("SELECT 1");
	});

	test("the buffered read keeps the database prefix and takes the frame after it", async () => {
		const { surreal } = stub({
			stream: refused,
			buffered: [{ database: "other" }, ["doc"]],
		});
		const view = new SurrealdbExecutor(surreal).forDatabase("other");
		expect(await collect(view.queryRows("SELECT 1"))).toEqual(["doc"]);
	});

	test("any other validation failure still fails the cursor", async () => {
		const { surreal, calls } = stub({
			stream: () => ({
				[Symbol.asyncIterator]: () => ({
					next: async () => {
						throw new ValidationError({
							kind: "Validation",
							message: "Specify a namespace",
						} as never);
					},
				}),
			}),
			buffered: [["a"]],
		});
		await expect(
			new SurrealdbExecutor(surreal).queryRows("SELECT 1").next(),
		).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});
});

/**
 * Answers with `value` at once when there is nothing to wait on, and otherwise
 * parks until the first of `signals` aborts, then rejects with its reason — what
 * the SDK does with a signal it was given.
 */
function parkOnSignals<T>(
	signals: readonly AbortSignal[],
	value: T,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (signals.length === 0) return resolve(value);
		const stop = () => reject(signals.find((s) => s.aborted)?.reason);
		for (const signal of signals) {
			if (signal.aborted) return stop();
			signal.addEventListener("abort", stop, { once: true });
		}
	});
}

describe("SurrealdbExecutor – a caller's AbortSignal", () => {
	/**
	 * A stub whose statements park until the signal handed to `.signal()` aborts,
	 * and then reject with whatever the SDK rejects with — the signal's own
	 * reason, which is the SDK's documented behaviour.
	 */
	function parkedStub() {
		const calls: { sql: string; signals: AbortSignal[]; streamed: boolean }[] =
			[];
		const surreal = {
			query(sql: string) {
				const call = { sql, signals: [] as AbortSignal[], streamed: false };
				calls.push(call);

				const settle = <T>(value: T) => parkOnSignals(call.signals, value);

				// Rebuilt after each `.signal()`: the promise is made when the caller
				// has finished chaining, as the SDK's awaitable query settles only once
				// it is awaited.
				const make = () => {
					const first = settle([[{ a: 1 }]]);
					// A chain the caller replaced with a longer one is never awaited, and
					// the SDK would never have sent it; it must not report an unhandled
					// rejection when its signal aborts.
					first.catch(() => undefined);
					const query: Promise<unknown> & {
						signal(s: AbortSignal): unknown;
						responses(): Promise<unknown>;
						stream(): AsyncIterable<StreamedFrame>;
					} = Object.assign(first, {
						signal(signal: AbortSignal) {
							call.signals.push(signal);
							return make();
						},
						responses: () => settle([{ success: true, result: [{ a: 1 }] }]),
						stream() {
							call.streamed = true;
							return {
								[Symbol.asyncIterator]: () => ({
									next: () =>
										settle<IteratorResult<StreamedFrame>>({
											done: true,
											value: undefined,
										}),
								}),
							};
						},
					});
					return query;
				};
				return make();
			},
		} as unknown as Surreal;
		return { surreal, calls };
	}

	const abortWith = (reason: unknown) => {
		const controller = new AbortController();
		controller.abort(reason);
		return controller.signal;
	};

	test("an already-aborted signal sends nothing, and rejects with its reason", async () => {
		const reason = new Error("stop");
		const { surreal, calls } = parkedStub();
		const executor = new SurrealdbExecutor(surreal).withSignal(
			abortWith(reason),
		);

		await expect(executor.query("SELECT 1")).rejects.toBe(reason);
		await expect(executor.queryLast("SELECT 1")).rejects.toBe(reason);
		await expect(executor.queryEach("SELECT 1")).rejects.toBe(reason);
		await expect(executor.queryRows("SELECT 1").next()).rejects.toBe(reason);
		expect(calls).toEqual([]);
	});

	test("the signal is handed to the SDK, so a statement can be stopped", async () => {
		const controller = new AbortController();
		const { surreal, calls } = parkedStub();
		const executor = new SurrealdbExecutor(surreal).withSignal(
			controller.signal,
		);

		const pending = executor.query("SELECT 1");
		await Promise.resolve();
		expect(calls[0]?.signals).toEqual([controller.signal]);

		const reason = new Error("too slow");
		controller.abort(reason);
		// The signal's own reason, untouched — not a MongoServerError made of it.
		await expect(pending).rejects.toBe(reason);
	});

	test("an AbortSignal.timeout() reads as its TimeoutError", async () => {
		const controller = new AbortController();
		const { surreal } = parkedStub();
		const pending = new SurrealdbExecutor(surreal)
			.withSignal(controller.signal)
			.queryEach("SELECT 1");
		await Promise.resolve();

		controller.abort(
			new DOMException("The operation timed out", "TimeoutError"),
		);
		const err = await pending.catch((e: unknown) => e);
		expect((err as DOMException).name).toBe("TimeoutError");
	});

	test("an abort while streaming rejects with the reason, even if the cursor released the stream first", async () => {
		// The cursor closes itself when its signal aborts, which returns the iterator
		// before the read it interrupted has thrown. That read still owes the reason.
		const controller = new AbortController();
		const { surreal } = parkedStub();
		const rows = new SurrealdbExecutor(surreal)
			.withSignal(controller.signal)
			.queryRows("SELECT 1");
		const pending = rows.next();
		await Promise.resolve();

		const reason = new Error("cancelled");
		controller.abort(reason);
		await rows.return?.();
		await expect(pending).rejects.toBe(reason);
	});

	test("a streamed query is stopped by both the stream's own signal and the caller's", async () => {
		const controller = new AbortController();
		const { surreal, calls } = parkedStub();
		const rows = new SurrealdbExecutor(surreal)
			.withSignal(controller.signal)
			.queryRows("SELECT 1");
		const pending = rows.next();
		await Promise.resolve();

		expect(calls[0]?.streamed).toBe(true);
		expect(calls[0]?.signals).toHaveLength(2);
		expect(calls[0]?.signals).toContain(controller.signal);

		controller.abort(new Error("x"));
		await pending.catch(() => undefined);
	});

	test("a failure with no abort is mapped as it always was", async () => {
		const surreal = {
			query: () =>
				Object.assign(Promise.reject(new Error("boom")), {
					signal() {
						return this;
					},
				}),
		} as unknown as Surreal;
		const controller = new AbortController();
		const err = await new SurrealdbExecutor(surreal)
			.withSignal(controller.signal)
			.query("SELECT 1")
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(MongoServerError);
	});

	test("a view addressed at another database keeps its signal, and the signal's view keeps its database", async () => {
		const { surreal, calls } = parkedStub();
		const base = new SurrealdbExecutor(surreal);
		const controllers = [new AbortController(), new AbortController()];

		const views = [
			(base.forDatabase("other") as ScopedExecutor).withSignal(
				controllers[0]?.signal as AbortSignal,
			),
			(
				base.withSignal(controllers[1]?.signal as AbortSignal) as ScopedExecutor
			).forDatabase("other"),
		];
		for (const [i, executor] of views.entries()) {
			const pending = executor.query("SELECT 1");
			await Promise.resolve();
			controllers[i]?.abort(new Error("done"));
			await pending.catch(() => undefined);
		}
		expect(calls.map((c) => c.sql)).toEqual([
			"USE DB `other`; SELECT 1",
			"USE DB `other`; SELECT 1",
		]);
		expect(calls[0]?.signals).toContain(controllers[0]?.signal as AbortSignal);
		expect(calls[1]?.signals).toContain(controllers[1]?.signal as AbortSignal);
	});

	test("without a signal nothing is handed to the SDK", async () => {
		const { surreal, calls } = parkedStub();
		await new SurrealdbExecutor(surreal).query("SELECT 1");
		expect(calls[0]?.signals).toEqual([]);
	});
});
