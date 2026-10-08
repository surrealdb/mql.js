/**
 * The SDK adapter's streamed read, against a stub of the part of `Surreal` it
 * uses. What a live server does with the stream is the integration suite's to
 * show; what is pinned here is what this adapter asks of the SDK.
 */

import { describe, expect, test } from "bun:test";
import { type Surreal, ValidationError } from "surrealdb";
import { MongoServerError } from "../../../src/errors.ts";
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
			const query = {
				signal(signal: AbortSignal) {
					call.signal = signal;
					return query;
				},
				stream() {
					call.streamed = true;
					return options.stream();
				},
				then(resolve: (value: unknown) => void) {
					resolve(options.buffered ?? []);
				},
			};
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
