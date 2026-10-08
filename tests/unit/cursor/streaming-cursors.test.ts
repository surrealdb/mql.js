/**
 * What a cursor does when it is read a document at a time.
 *
 * `toArray()` reads the whole result in one response; `next()`, `hasNext()`,
 * `forEach()` and `for await` read from a stream, so the first document is in
 * hand before the last has been found. The thing that matters most — and the
 * reason a stream is worth the trouble — is **leaving**: a consumer that stops
 * early must stop the server producing what it will not read, so every way out
 * is asserted to release the stream, and every way of *not* leaving is asserted
 * not to.
 *
 * Both cursors share one implementation of this (`CursorRows`), so each case
 * runs against both.
 */

import { describe, expect, test } from "bun:test";
import { AggregationCursor } from "../../../src/cursor/aggregation-cursor.ts";
import {
	FindCursor,
	type FindCursorState,
} from "../../../src/cursor/find-cursor.ts";
import {
	MongoCursorExhaustedError,
	MongoCursorInUseError,
} from "../../../src/errors.ts";
import type { Document } from "../../../src/types.ts";

const ROWS: Document[] = [
	{ _id: 1, n: "a" },
	{ _id: 2, n: "b" },
	{ _id: 3, n: "c" },
];

/** What was asked of a scripted stream. */
interface Tracking {
	opened: number;
	/** Rows handed out across every stream opened. */
	read: number;
	/** Streams released early by `return()`. */
	released: number;
	/** The state the streamer was opened with, for a find cursor. */
	states: FindCursorState[];
	/** Calls to the whole-result runner. */
	runs: number;
}

/**
 * A stream of `rows` that counts what is asked of it. `failAfter` makes it throw
 * once that many rows have been read, as a statement that fails mid-scan does.
 */
function scripted(rows: Document[], failAfter?: Error) {
	const tracking: Tracking = {
		opened: 0,
		read: 0,
		released: 0,
		states: [],
		runs: 0,
	};

	const open = (): AsyncIterableIterator<Document> => {
		tracking.opened += 1;
		let index = 0;
		let finished = false;
		const iterator: AsyncIterableIterator<Document> = {
			async next() {
				if (finished) return { done: true as const, value: undefined };
				if (failAfter && index === rows.length) {
					finished = true;
					throw failAfter;
				}
				if (index >= rows.length) {
					finished = true;
					return { done: true as const, value: undefined };
				}
				tracking.read += 1;
				return { done: false as const, value: rows[index++] as Document };
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
	};

	const run = async () => {
		tracking.runs += 1;
		return rows.slice();
	};

	return { tracking, open, run };
}

type Cursor = FindCursor<Document> | AggregationCursor<Document>;

const KINDS: [string, (s: ReturnType<typeof scripted>) => Cursor][] = [
	[
		"FindCursor",
		(s) =>
			new FindCursor<Document>(
				async () => s.run(),
				undefined,
				undefined,
				undefined,
				(state) => {
					s.tracking.states.push(state);
					return s.open();
				},
			),
	],
	[
		"AggregationCursor",
		(s) =>
			new AggregationCursor<Document>(
				() => s.run(),
				() => s.open(),
			),
	],
];

for (const [kind, make] of KINDS) {
	describe(`${kind} – read a document at a time`, () => {
		test("next() streams, and never asks for the whole result", async () => {
			const s = scripted(ROWS);
			const cursor = make(s);

			expect(await cursor.next()).toEqual(ROWS[0]);
			expect(s.tracking.opened).toBe(1);
			expect(s.tracking.runs).toBe(0);
			// One document in hand, and no more asked for than that.
			expect(s.tracking.read).toBe(1);
		});

		test("walks the stream and answers null at the end", async () => {
			const cursor = make(scripted(ROWS));
			expect(await cursor.next()).toEqual(ROWS[0]);
			expect(await cursor.next()).toEqual(ROWS[1]);
			expect(await cursor.next()).toEqual(ROWS[2]);
			expect(await cursor.next()).toBeNull();
			expect(await cursor.next()).toBeNull();
		});

		test("nothing is opened until the first read", async () => {
			const s = scripted(ROWS);
			make(s);
			expect(s.tracking.opened).toBe(0);
		});

		test("hasNext() reads one ahead without losing the document", async () => {
			const s = scripted(ROWS);
			const cursor = make(s);

			expect(await cursor.hasNext()).toBe(true);
			expect(await cursor.hasNext()).toBe(true);
			// Asking twice reads once.
			expect(s.tracking.read).toBe(1);
			expect(await cursor.next()).toEqual(ROWS[0]);
			expect(await cursor.next()).toEqual(ROWS[1]);
		});

		test("hasNext() is false at the end and next() agrees", async () => {
			const cursor = make(scripted([ROWS[0] as Document]));
			expect(await cursor.next()).toEqual(ROWS[0]);
			expect(await cursor.hasNext()).toBe(false);
			expect(await cursor.next()).toBeNull();
		});

		test("an empty result is false and null, not an error", async () => {
			const cursor = make(scripted([]));
			expect(await cursor.hasNext()).toBe(false);
			expect(await cursor.next()).toBeNull();
		});

		test("for await yields every document and finishes by itself", async () => {
			const s = scripted(ROWS);
			const cursor = make(s);
			const seen: Document[] = [];
			for await (const doc of cursor) seen.push(doc);

			expect(seen).toEqual(ROWS);
			// Running to the end is not leaving: the stream finished on its own.
			expect(s.tracking.released).toBe(0);
			expect(cursor.closed).toBe(false);
		});

		test("forEach visits every document", async () => {
			const s = scripted(ROWS);
			const seen: unknown[] = [];
			await make(s).forEach((doc) => {
				seen.push(doc._id);
			});
			expect(seen).toEqual([1, 2, 3]);
			expect(s.tracking.released).toBe(0);
		});
	});

	describe(`${kind} – leaving early`, () => {
		test("breaking out of for await releases the stream, and reads nothing further", async () => {
			const s = scripted(ROWS);
			const cursor = make(s);
			for await (const doc of cursor) {
				expect(doc).toEqual(ROWS[0]);
				break;
			}

			expect(s.tracking.released).toBe(1);
			expect(s.tracking.read).toBe(1);
			expect(cursor.closed).toBe(true);
		});

		test("returning false from forEach releases the stream", async () => {
			const s = scripted(ROWS);
			const cursor = make(s);
			// biome-ignore lint/suspicious/useIterableCallbackReturn: forEach() short-circuits on `false` per the MongoDB driver contract.
			await cursor.forEach(() => false);

			expect(s.tracking.released).toBe(1);
			expect(s.tracking.read).toBe(1);
			expect(cursor.closed).toBe(true);
		});

		test("a callback that throws leaves the stream released too", async () => {
			const s = scripted(ROWS);
			const cursor = make(s);
			// An exception out of a `for await` body is leaving as much as `break`.
			await expect(
				(async () => {
					for await (const _ of cursor) throw new Error("callback failed");
				})(),
			).rejects.toThrow("callback failed");
			expect(s.tracking.released).toBe(1);
		});

		test("close() releases the stream", async () => {
			const s = scripted(ROWS);
			const cursor = make(s);
			await cursor.next();
			await cursor.close();

			expect(s.tracking.released).toBe(1);
			expect(cursor.closed).toBe(true);
		});

		test("close() on a cursor that was never read opens nothing at all", async () => {
			const s = scripted(ROWS);
			const cursor = make(s);
			await cursor.close();
			expect(s.tracking.opened).toBe(0);
			expect(s.tracking.released).toBe(0);
		});

		test("a closed cursor refuses every read", async () => {
			const cursor = make(scripted(ROWS));
			await cursor.next();
			await cursor.close();

			await expect(cursor.next()).rejects.toThrow(MongoCursorExhaustedError);
			await expect(cursor.hasNext()).rejects.toThrow(MongoCursorExhaustedError);
			await expect(cursor.toArray()).rejects.toThrow(MongoCursorExhaustedError);
			await expect(
				cursor.forEach(() => {
					/* never called: the cursor is closed */
				}),
			).rejects.toThrow(MongoCursorExhaustedError);
		});

		test("closing twice releases once", async () => {
			const s = scripted(ROWS);
			const cursor = make(s);
			await cursor.next();
			await cursor.close();
			await cursor.close();
			expect(s.tracking.released).toBe(1);
		});
	});

	describe(`${kind} – toArray`, () => {
		test("on a cursor not yet read is one response, with no stream", async () => {
			const s = scripted(ROWS);
			expect(await make(s).toArray()).toEqual(ROWS);
			expect(s.tracking.runs).toBe(1);
			expect(s.tracking.opened).toBe(0);
		});

		test("after some documents were read returns the rest, as MongoDB's does", async () => {
			const s = scripted(ROWS);
			const cursor = make(s);
			await cursor.next();
			expect(await cursor.toArray()).toEqual([ROWS[1], ROWS[2]]);
			expect(s.tracking.runs).toBe(0);
		});

		test("a second toArray() on a whole-result cursor does not run the query again", async () => {
			const s = scripted(ROWS);
			const cursor = make(s);
			await cursor.toArray();
			await cursor.toArray();
			expect(s.tracking.runs).toBe(1);
		});

		test("returns a copy, so changing it does not change the cursor", async () => {
			const cursor = make(scripted(ROWS));
			const first = await cursor.toArray();
			first.pop();
			expect(await cursor.toArray()).toEqual(ROWS);
		});
	});

	describe(`${kind} – failure`, () => {
		test("a failure after some rows is thrown from the read that meets it", async () => {
			const s = scripted(
				ROWS,
				new Error("The query was not executed: timed out"),
			);
			const cursor = make(s);

			expect(await cursor.next()).toEqual(ROWS[0]);
			expect(await cursor.next()).toEqual(ROWS[1]);
			expect(await cursor.next()).toEqual(ROWS[2]);
			await expect(cursor.next()).rejects.toThrow(/timed out/);
		});

		test("for await throws it to the loop", async () => {
			const cursor = make(scripted(ROWS, new Error("boom")));
			const seen: unknown[] = [];
			await expect(
				(async () => {
					for await (const doc of cursor) seen.push(doc._id);
				})(),
			).rejects.toThrow("boom");
			expect(seen).toEqual([1, 2, 3]);
		});

		test("hasNext() throws a failure rather than reporting the end", async () => {
			const cursor = make(scripted([], new Error("first read failed")));
			await expect(cursor.hasNext()).rejects.toThrow("first read failed");
		});
	});

	describe(`${kind} – rewind and clone`, () => {
		test("rewind() releases the stream and reads again from the start", async () => {
			const s = scripted(ROWS);
			const cursor = make(s);
			expect(await cursor.next()).toEqual(ROWS[0]);

			cursor.rewind();
			expect(s.tracking.released).toBe(1);
			expect(await cursor.next()).toEqual(ROWS[0]);
			expect(s.tracking.opened).toBe(2);
		});

		test("rewind() reopens a closed cursor", async () => {
			const cursor = make(scripted(ROWS));
			await cursor.next();
			await cursor.close();
			cursor.rewind();
			expect(cursor.closed).toBe(false);
			expect(await cursor.next()).toEqual(ROWS[0]);
		});

		test("clone() is independent, and streams too", async () => {
			const s = scripted(ROWS);
			const cursor = make(s);
			await cursor.next();

			const copy = cursor.clone();
			expect(await copy.next()).toEqual(ROWS[0]);
			// Each has its own stream; neither disturbed the other.
			expect(s.tracking.opened).toBe(2);
			expect(await cursor.next()).toEqual(ROWS[1]);
		});
	});
}

describe("FindCursor – what the stream is opened with", () => {
	test("the chained options, as the whole-result runner would have had", async () => {
		const s = scripted(ROWS);
		const cursor = new FindCursor<Document>(
			async () => s.run(),
			{ active: true },
			undefined,
			undefined,
			(state) => {
				s.tracking.states.push(state);
				return s.open();
			},
		);
		cursor.sort({ n: 1 }).limit(5).skip(2).project({ n: 1 });
		await cursor.next();

		expect(s.tracking.states).toHaveLength(1);
		expect(s.tracking.states[0]).toMatchObject({
			filter: { active: true },
			sort: { n: 1 },
			limit: 5,
			skip: 2,
			projectionColumns: ["id", "`n`"],
			projectionIncludeId: true,
		});
	});

	test("chaining after a read has begun is refused, as it is after execution", async () => {
		const cursor = new FindCursor<Document>(
			async () => ROWS,
			undefined,
			undefined,
			undefined,
			() => scripted(ROWS).open(),
		);
		await cursor.next();
		expect(() => cursor.sort({ n: 1 })).toThrow(MongoCursorInUseError);
		expect(() => cursor.limit(1)).toThrow(MongoCursorInUseError);
	});

	test("map() transforms streamed documents and keeps streaming", async () => {
		const s = scripted(ROWS);
		const cursor = new FindCursor<Document>(
			async () => s.run(),
			undefined,
			undefined,
			undefined,
			() => s.open(),
		).map((doc) => ({ ...doc, mapped: true }));

		expect(await cursor.next()).toMatchObject({ _id: 1, n: "a", mapped: true });
		expect(s.tracking.opened).toBe(1);
		expect(s.tracking.runs).toBe(0);

		const seen: unknown[] = [];
		for await (const doc of cursor) {
			seen.push(doc.mapped);
			break;
		}
		expect(seen).toEqual([true]);
		expect(s.tracking.released).toBe(1);
	});
});

describe("a cursor with nothing to stream from", () => {
	test("reads the whole result and walks it, as it always did", async () => {
		let runs = 0;
		const cursor = new FindCursor<Document>(async () => {
			runs += 1;
			return ROWS.slice();
		});
		expect(await cursor.next()).toEqual(ROWS[0]);
		expect(await cursor.hasNext()).toBe(true);
		const seen: unknown[] = [];
		for await (const doc of cursor) seen.push(doc._id);
		expect(seen).toEqual([2, 3]);
		expect(runs).toBe(1);
	});
});
