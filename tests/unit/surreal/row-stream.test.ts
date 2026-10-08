/**
 * The iterators a cursor reads rows from, driven by scripted frames so every
 * path is pinned without a server.
 *
 * What a live server adds — that frames really arrive before the statement ends,
 * that `query_cancel` really stops it — is asserted by the integration suite
 * against a server that streams; what is asserted here is the logic around it:
 * which frames are rows, what a failure does, and above all what leaving does.
 */

import { describe, expect, test } from "bun:test";
import { ValidationError } from "surrealdb";
import { MongoServerError } from "../../../src/errors.ts";
import { isStreamCapRefusal } from "../../../src/surreal/error-mapper.ts";
import {
	bufferedRows,
	deferredRows,
	mapRows,
	rowsOrNoneWhen,
	type StreamedFrame,
	streamRows,
} from "../../../src/surreal/row-stream.ts";

const value = (query: number, row: unknown): StreamedFrame => ({
	query,
	value: row,
	isValue: () => true,
	isError: () => false,
});
const failure = (query: number, error: unknown): StreamedFrame => ({
	query,
	error,
	isValue: () => false,
	isError: () => true,
});
const done = (query: number): StreamedFrame => ({
	query,
	isValue: () => false,
	isError: () => false,
});

/** Frames handed out in order, recording what was asked of the source. */
function scripted(frames: StreamedFrame[]) {
	const state = {
		opened: 0,
		returned: 0,
		signal: undefined as AbortSignal | undefined,
	};
	const open = (signal: AbortSignal): AsyncIterable<StreamedFrame> => {
		state.opened += 1;
		state.signal = signal;
		return {
			[Symbol.asyncIterator]() {
				let index = 0;
				return {
					async next() {
						return index < frames.length
							? { done: false as const, value: frames[index++] }
							: { done: true as const, value: undefined };
					},
					async return() {
						state.returned += 1;
						return { done: true as const, value: undefined };
					},
				};
			},
		};
	};
	return { open, state };
}

/**
 * A source that never answers until its signal aborts, as a stream parked on a
 * server that is still working: the abort is what ends the read, by throwing.
 */
function parked() {
	const state = { opened: 0, aborted: false };
	const open = (signal: AbortSignal): AsyncIterable<StreamedFrame> => {
		state.opened += 1;
		return {
			[Symbol.asyncIterator]() {
				return {
					next: () =>
						new Promise<IteratorResult<StreamedFrame>>((_, reject) => {
							signal.addEventListener("abort", () => {
								state.aborted = true;
								reject(new DOMException("aborted", "AbortError"));
							});
						}),
					async return() {
						return { done: true as const, value: undefined };
					},
				};
			},
		};
	};
	return { open, state };
}

/** An iterator that hands out `row` forever and counts being released. */
function endless<T>(row: T): {
	rows: AsyncIterableIterator<T>;
	released: () => number;
} {
	let released = 0;
	const rows: AsyncIterableIterator<T> = {
		async next() {
			return { done: false as const, value: row };
		},
		async return() {
			released += 1;
			return { done: true as const, value: undefined };
		},
		[Symbol.asyncIterator]() {
			return rows;
		},
	};
	return { rows, released: () => released };
}

async function drain<T>(rows: AsyncIterableIterator<T>): Promise<T[]> {
	const out: T[] = [];
	for (;;) {
		const step = await rows.next();
		if (step.done) return out;
		out.push(step.value);
	}
}

describe("streamRows", () => {
	test("yields the rows of the wanted statement, in order", async () => {
		const { open } = scripted([
			value(1, "a"),
			value(1, "b"),
			done(1),
			value(1, "c"),
		]);
		expect(await drain(streamRows(open, 1))).toEqual(["a", "b", "c"]);
	});

	test("skips every other statement's rows — the USE DB's own answer is not a document", async () => {
		const { open } = scripted([
			value(0, { namespace: "ns", database: "other" }),
			done(0),
			value(1, "doc"),
			done(1),
		]);
		expect(await drain(streamRows(open, 1))).toEqual(["doc"]);
	});

	test("sends nothing until the first read", async () => {
		const { open, state } = scripted([value(0, "a")]);
		const rows = streamRows(open, 0);
		expect(state.opened).toBe(0);
		await rows.next();
		expect(state.opened).toBe(1);
	});

	test("an error frame is thrown, in this driver's own taxonomy", async () => {
		const { open } = scripted([failure(0, new Error("boom"))]);
		const err = await streamRows(open, 0)
			.next()
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(MongoServerError);
		expect((err as Error).message).toContain("boom");
	});

	test("an error frame for another statement is thrown too, not read past", async () => {
		// The USE DB in front failed: carrying on would answer from the wrong database.
		const { open } = scripted([
			failure(0, new Error("no such database")),
			value(1, "doc"),
		]);
		await expect(streamRows(open, 1).next()).rejects.toThrow(
			/no such database/,
		);
	});

	test("an error can follow rows the caller already has", async () => {
		const { open } = scripted([
			value(0, "a"),
			failure(0, new Error("timed out")),
		]);
		const rows = streamRows(open, 0);
		expect((await rows.next()).value).toBe("a");
		await expect(rows.next()).rejects.toThrow(/timed out/);
		// ...and the cursor is over: it does not retry the query.
		expect((await rows.next()).done).toBe(true);
	});

	test("an empty result ends at once", async () => {
		const { open } = scripted([done(0)]);
		expect((await streamRows(open, 0).next()).done).toBe(true);
	});

	test("return() before the first read opens nothing", async () => {
		const { open, state } = scripted([value(0, "a")]);
		const rows = streamRows(open, 0);
		await rows.return?.();
		expect((await rows.next()).done).toBe(true);
		expect(state.opened).toBe(0);
	});

	test("return() stops the query: the signal aborts and the frames are released", async () => {
		const { open, state } = scripted([value(0, "a"), value(0, "b")]);
		const rows = streamRows(open, 0);
		await rows.next();
		await rows.return?.();

		expect(state.signal?.aborted).toBe(true);
		expect(state.returned).toBe(1);
		expect((await rows.next()).done).toBe(true);
	});

	test("return() while a read is parked ends that read at once", async () => {
		// A generator's return() waits for the read it interrupts, which would make a
		// consumer that stopped early wait for the rows it no longer wants.
		const { open, state } = parked();
		const rows = streamRows(open, 0);
		const pending = rows.next();
		await Promise.resolve();

		const started = Date.now();
		await rows.return?.();
		const step = await pending;

		expect(step.done).toBe(true);
		expect(state.aborted).toBe(true);
		expect(Date.now() - started).toBeLessThan(500);
	});

	test("a consumer leaving is not reported as a failure", async () => {
		const { open } = parked();
		const rows = streamRows(open, 0);
		const pending = rows.next();
		await rows.return?.();
		await expect(pending).resolves.toEqual({ done: true, value: undefined });
	});

	test("a connection lost mid-read is thrown, since nobody left", async () => {
		const open = (): AsyncIterable<StreamedFrame> => ({
			[Symbol.asyncIterator]: () => ({
				next: async () => {
					throw new Error("socket closed");
				},
			}),
		});
		await expect(streamRows(open, 0).next()).rejects.toThrow(/socket closed/);
	});
});

describe("streamRows – a server at its stream limit", () => {
	const cap = () =>
		new ValidationError({
			kind: "Validation",
			message: "Too many concurrent streaming queries",
		} as never);

	const refusing =
		(): ((signal: AbortSignal) => AsyncIterable<StreamedFrame>) => () => ({
			[Symbol.asyncIterator]: () => ({
				next: async () => {
					throw cap();
				},
			}),
		});

	const fallback = (rows: unknown[]) => {
		const state = { built: 0 };
		return {
			state,
			when: isStreamCapRefusal,
			rows: () => {
				state.built += 1;
				return bufferedRows(async () => rows);
			},
		};
	};

	test("is answered from the fallback, since the refusal means nothing ran", async () => {
		const fb = fallback(["a", "b"]);
		const rows = streamRows(refusing(), 0, fb);
		expect(await drain(rows)).toEqual(["a", "b"]);
		expect(fb.state.built).toBe(1);
	});

	test("recognises exactly that refusal, and no other validation failure", () => {
		expect(isStreamCapRefusal(cap())).toBe(true);
		expect(
			isStreamCapRefusal(
				new ValidationError({
					kind: "Validation",
					message: "Specify a namespace",
				} as never),
			),
		).toBe(false);
		expect(
			isStreamCapRefusal(new Error("Too many concurrent streaming queries")),
		).toBe(false);
	});

	test("another failure is not answered from the fallback", async () => {
		const fb = fallback(["a"]);
		const open = () => ({
			[Symbol.asyncIterator]: () => ({
				next: async () => {
					throw new Error("socket closed");
				},
			}),
		});
		await expect(streamRows(open, 0, fb).next()).rejects.toThrow(
			/socket closed/,
		);
		expect(fb.state.built).toBe(0);
	});

	test("never after a row has been delivered, because that would run the query twice", async () => {
		const fb = fallback(["a"]);
		let reads = 0;
		const open = () => ({
			[Symbol.asyncIterator]: () => ({
				next: async () => {
					reads += 1;
					if (reads === 1)
						return { done: false as const, value: value(0, "first") };
					throw cap();
				},
			}),
		});
		const rows = streamRows(open, 0, fb);
		expect((await rows.next()).value).toBe("first");
		await expect(rows.next()).rejects.toThrow();
		expect(fb.state.built).toBe(0);
	});

	test("return() reaches the fallback's own iterator", async () => {
		const source = endless("x");
		const rows = streamRows(refusing(), 0, {
			when: isStreamCapRefusal,
			rows: () => source.rows,
		});
		expect((await rows.next()).value).toBe("x");
		await rows.return?.();
		expect(source.released()).toBe(1);
	});
});

describe("bufferedRows", () => {
	test("loads on the first read, not when built", async () => {
		let loads = 0;
		const rows = bufferedRows(async () => {
			loads += 1;
			return [1, 2];
		});
		expect(loads).toBe(0);
		expect(await drain(rows)).toEqual([1, 2]);
		expect(loads).toBe(1);
	});

	test("a failed load ends the iterator rather than running again", async () => {
		let loads = 0;
		const rows = bufferedRows<number>(async () => {
			loads += 1;
			throw new Error("nope");
		});
		await expect(rows.next()).rejects.toThrow("nope");
		expect((await rows.next()).done).toBe(true);
		expect(loads).toBe(1);
	});

	test("return() stops handing rows out", async () => {
		const rows = bufferedRows(async () => [1, 2, 3]);
		expect((await rows.next()).value).toBe(1);
		await rows.return?.();
		expect((await rows.next()).done).toBe(true);
	});
});

describe("deferredRows", () => {
	test("builds its source on the first read", async () => {
		let built = 0;
		const rows = deferredRows(async () => {
			built += 1;
			return bufferedRows(async () => ["a"]);
		});
		expect(built).toBe(0);
		expect(await drain(rows)).toEqual(["a"]);
		expect(built).toBe(1);
	});

	test("return() before the first read never builds the source", async () => {
		let built = 0;
		const rows = deferredRows(async () => {
			built += 1;
			return bufferedRows(async () => ["a"]);
		});
		await rows.return?.();
		expect((await rows.next()).done).toBe(true);
		expect(built).toBe(0);
	});

	test("return() while the source is still being built releases it when it arrives", async () => {
		const source = endless("a");
		let arrive!: () => void;
		const arrives = new Promise<void>((resolve) => {
			arrive = resolve;
		});
		const rows = deferredRows<string>(async () => {
			await arrives;
			return source.rows;
		});
		const pending = rows.next();
		await Promise.resolve();
		await rows.return?.();
		arrive();
		expect((await pending).done).toBe(true);
		expect(source.released()).toBe(1);
	});

	test("a source that cannot be built fails the read, then ends", async () => {
		const rows = deferredRows<string>(async () => {
			throw new Error("not connected");
		});
		await expect(rows.next()).rejects.toThrow("not connected");
		expect((await rows.next()).done).toBe(true);
	});
});

describe("mapRows and rowsOrNoneWhen", () => {
	test("mapRows transforms each row and forwards return()", async () => {
		const source = endless(2);
		const rows = mapRows(source.rows, (n) => n * 10);
		expect((await rows.next()).value).toBe(20);
		await rows.return?.();
		expect(source.released()).toBe(1);
	});

	test("a failure the predicate recognises reads as no rows", async () => {
		const source = bufferedRows<number>(async () => {
			throw new Error("The table 'x' does not exist");
		});
		const rows = rowsOrNoneWhen(source, (e) =>
			/does not exist/.test(String(e)),
		);
		expect(await drain(rows)).toEqual([]);
	});

	test("any other failure is thrown", async () => {
		const source = bufferedRows<number>(async () => {
			throw new Error("permission denied");
		});
		const rows = rowsOrNoneWhen(source, (e) =>
			/does not exist/.test(String(e)),
		);
		await expect(rows.next()).rejects.toThrow("permission denied");
	});
});
