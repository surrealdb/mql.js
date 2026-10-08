/**
 * A cursor's `AbortSignal`, as MongoDB's cursors treat it.
 *
 * Two behaviours, both read off the official driver's `AbstractCursor`:
 *
 *   - aborting the signal **closes the cursor at once**, with nobody reading, so
 *     whatever it holds is released;
 *   - every read asks the signal **before** it asks whether the cursor is closed.
 *     A cursor that was closed *by* its signal therefore reports the signal's
 *     reason, not "cursor exhausted" — which is the only way a caller can tell
 *     that it was their own abort that ended it.
 */

import { describe, expect, test } from "bun:test";
import { AggregationCursor } from "../../../src/cursor/aggregation-cursor.ts";
import { FindCursor } from "../../../src/cursor/find-cursor.ts";
import { ListCollectionsCursor } from "../../../src/cursor/list-collections-cursor.ts";
import { MongoCursorExhaustedError } from "../../../src/errors.ts";
import type { Document } from "../../../src/types.ts";

const ROWS: Document[] = [{ n: 1 }, { n: 2 }, { n: 3 }];

interface Tracking {
	runs: number;
	opened: number;
	released: number;
}

/** A cursor over `ROWS`, with what it was asked to do. */
interface Subject {
	cursor:
		| FindCursor<Document>
		| AggregationCursor<Document>
		| ListCollectionsCursor;
	tracking: Tracking;
	/** Whether it has a stream to release. */
	streams: boolean;
}

function stream(tracking: Tracking): AsyncIterableIterator<Document> {
	tracking.opened += 1;
	let index = 0;
	let finished = false;
	const iterator: AsyncIterableIterator<Document> = {
		async next() {
			if (finished || index >= ROWS.length) {
				finished = true;
				return { done: true as const, value: undefined };
			}
			return { done: false as const, value: ROWS[index++] as Document };
		},
		async return() {
			if (!finished) tracking.released += 1;
			finished = true;
			return { done: true as const, value: undefined };
		},
		[Symbol.asyncIterator]() {
			return iterator;
		},
	};
	return iterator;
}

const KINDS: [string, (signal: AbortSignal) => Subject][] = [
	[
		"FindCursor",
		(signal) => {
			const tracking = { runs: 0, opened: 0, released: 0 };
			const cursor = new FindCursor<Document>(
				async () => {
					tracking.runs += 1;
					return ROWS.slice();
				},
				undefined,
				{ signal },
				undefined,
				() => stream(tracking),
			);
			return { cursor, tracking, streams: true };
		},
	],
	[
		"AggregationCursor",
		(signal) => {
			const tracking = { runs: 0, opened: 0, released: 0 };
			const cursor = new AggregationCursor<Document>(
				async () => {
					tracking.runs += 1;
					return ROWS.slice();
				},
				() => stream(tracking),
				signal,
			);
			return { cursor, tracking, streams: true };
		},
	],
	[
		"ListCollectionsCursor",
		(signal) => {
			const tracking = { runs: 0, opened: 0, released: 0 };
			const cursor = new ListCollectionsCursor(async () => {
				tracking.runs += 1;
				return ROWS.map((r) => ({ name: String(r.n), type: "collection" }));
			}, signal);
			return { cursor, tracking, streams: false };
		},
	],
];

/** A signal that counts the listeners added to and removed from it. */
function spied(): {
	signal: AbortSignal;
	controller: AbortController;
	live: () => number;
} {
	const controller = new AbortController();
	const signal = controller.signal;
	let live = 0;
	const add = signal.addEventListener.bind(signal);
	const remove = signal.removeEventListener.bind(signal);
	signal.addEventListener = ((...args: Parameters<typeof add>) => {
		live += 1;
		return add(...args);
	}) as typeof add;
	signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
		live -= 1;
		return remove(...args);
	}) as typeof remove;
	return { signal, controller, live: () => live };
}

for (const [kind, make] of KINDS) {
	describe(`${kind} – an AbortSignal`, () => {
		test("already aborted: every read rejects with its reason, and nothing is run", async () => {
			const reason = new Error("stop");
			const controller = new AbortController();
			controller.abort(reason);
			const { cursor, tracking } = make(controller.signal);

			await expect(cursor.next()).rejects.toBe(reason);
			await expect(cursor.hasNext()).rejects.toBe(reason);
			await expect(cursor.toArray()).rejects.toBe(reason);
			await expect(cursor.forEach(() => undefined)).rejects.toBe(reason);
			await expect(
				(async () => {
					for await (const _ of cursor) break;
				})(),
			).rejects.toBe(reason);
			expect(tracking).toEqual({ runs: 0, opened: 0, released: 0 });
		});

		test("aborting closes the cursor at once, with nobody reading", async () => {
			const controller = new AbortController();
			const { cursor } = make(controller.signal);
			expect(cursor.closed).toBe(false);

			controller.abort(new Error("stop"));
			// The listener closes it asynchronously.
			await Promise.resolve();
			await Promise.resolve();
			expect(cursor.closed).toBe(true);
		});

		test("aborting releases the stream the cursor holds", async () => {
			const controller = new AbortController();
			const { cursor, tracking, streams } = make(controller.signal);
			if (!streams) return;

			await cursor.next();
			expect(tracking.opened).toBe(1);
			controller.abort(new Error("stop"));
			await new Promise((resolve) => setTimeout(resolve, 5));
			expect(tracking.released).toBe(1);
		});

		test("a cursor closed by its signal reports the reason, not 'exhausted'", async () => {
			const reason = new Error("stop");
			const controller = new AbortController();
			const { cursor } = make(controller.signal);
			await cursor.next();

			controller.abort(reason);
			await new Promise((resolve) => setTimeout(resolve, 5));
			await expect(cursor.next()).rejects.toBe(reason);
			await expect(cursor.hasNext()).rejects.toBe(reason);
			await expect(cursor.toArray()).rejects.toBe(reason);
		});

		test("a cursor closed by the caller is still 'exhausted', and the signal is not consulted", async () => {
			const controller = new AbortController();
			const { cursor } = make(controller.signal);
			await cursor.next();
			await cursor.close();
			await expect(cursor.next()).rejects.toThrow(MongoCursorExhaustedError);
		});

		test("an abort during a for await body is reported before the next document", async () => {
			const reason = new Error("stop");
			const controller = new AbortController();
			const { cursor } = make(controller.signal);
			const seen: unknown[] = [];

			await expect(
				(async () => {
					for await (const doc of cursor) {
						seen.push(doc);
						controller.abort(reason);
					}
				})(),
			).rejects.toBe(reason);
			expect(seen).toHaveLength(1);
			expect(cursor.closed).toBe(true);
		});

		test("an abort during forEach is reported before the next document", async () => {
			const reason = new Error("stop");
			const controller = new AbortController();
			const { cursor } = make(controller.signal);
			const seen: unknown[] = [];

			await expect(
				cursor.forEach((doc) => {
					seen.push(doc);
					controller.abort(reason);
				}),
			).rejects.toBe(reason);
			expect(seen).toHaveLength(1);
		});

		test("a signal that never aborts changes nothing", async () => {
			const controller = new AbortController();
			const { cursor } = make(controller.signal);
			const seen: unknown[] = [];
			for await (const doc of cursor) seen.push(doc);
			expect(seen).toHaveLength(3);
		});
	});

	describe(`${kind} – what a signal must not leave behind`, () => {
		test("closing the cursor stops listening to the signal", async () => {
			const { signal, live } = spied();
			const { cursor } = make(signal);
			expect(live()).toBe(1);

			await cursor.close();
			expect(live()).toBe(0);
		});

		test("rewinding listens again, so an abort after a rewind still closes it", async () => {
			const { signal, controller, live } = spied();
			const { cursor } = make(signal);
			await cursor.close();
			cursor.rewind();
			expect(live()).toBe(1);

			controller.abort(new Error("stop"));
			await Promise.resolve();
			await Promise.resolve();
			expect(cursor.closed).toBe(true);
		});

		test("clone() keeps the signal", async () => {
			const reason = new Error("stop");
			const controller = new AbortController();
			controller.abort(reason);
			const { cursor } = make(controller.signal);
			await expect(cursor.clone().next()).rejects.toBe(reason);
		});
	});
}

describe("FindCursor – map() keeps the signal", () => {
	test("a mapped cursor is stopped by the same signal", async () => {
		const reason = new Error("stop");
		const controller = new AbortController();
		controller.abort(reason);
		const cursor = new FindCursor<Document>(async () => ROWS, undefined, {
			signal: controller.signal,
		}).map((doc) => doc);
		await expect(cursor.next()).rejects.toBe(reason);
	});
});
