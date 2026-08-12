import { describe, expect, test } from "bun:test";
import {
	FindCursor,
	type FindCursorState,
	type FindRunner,
} from "../../../src/cursor/find-cursor.ts";
import {
	MongoCursorExhaustedError,
	MongoCursorInUseError,
} from "../../../src/errors.ts";
import type { Document } from "../../../src/types.ts";

interface User extends Document {
	_id: string;
	name: string;
	age: number;
}

const ALICE: User = { _id: "a", name: "Alice", age: 30 };
const BOB: User = { _id: "b", name: "Bob", age: 25 };
const CHARLIE: User = { _id: "c", name: "Charlie", age: 35 };

/**
 * Build a runner that records every state it was invoked with and
 * returns the supplied row set.
 */
function recordingRunner(rows: Document[]): {
	runner: FindRunner<Document>;
	calls: FindCursorState[];
} {
	const calls: FindCursorState[] = [];
	const runner: FindRunner<Document> = async (state) => {
		calls.push(state);
		return rows;
	};
	return { runner, calls };
}

describe("FindCursor – chaining and lazy execution", () => {
	test("does not call the runner until results are consumed", async () => {
		const { runner, calls } = recordingRunner([]);
		new FindCursor<User>(runner).sort({ age: 1 }).limit(10).skip(5);
		expect(calls.length).toBe(0);
	});

	test("first toArray() triggers the runner once with the chained options", async () => {
		const { runner, calls } = recordingRunner([ALICE, BOB]);
		const cursor = new FindCursor<User>(runner, { name: "Alice" })
			.sort({ age: -1 })
			.limit(10)
			.skip(2);
		const result = await cursor.toArray();
		expect(result).toEqual([ALICE, BOB]);
		expect(calls.length).toBe(1);
		expect(calls[0].filter).toEqual({ name: "Alice" });
		expect(calls[0].sort).toEqual({ age: -1 });
		expect(calls[0].limit).toBe(10);
		expect(calls[0].skip).toBe(2);
	});

	test("results are cached: a second toArray() does not re-execute", async () => {
		const { runner, calls } = recordingRunner([ALICE]);
		const cursor = new FindCursor<User>(runner);
		await cursor.toArray();
		await cursor.toArray();
		expect(calls.length).toBe(1);
	});

	test("toArray() returns a defensive copy", async () => {
		const { runner } = recordingRunner([ALICE, BOB]);
		const cursor = new FindCursor<User>(runner);
		const a = await cursor.toArray();
		a.pop();
		const b = await cursor.toArray();
		expect(b.length).toBe(2);
	});

	test("filter() overrides any previously-set filter", async () => {
		const { runner, calls } = recordingRunner([]);
		const cursor = new FindCursor<User>(runner, { name: "x" });
		cursor.filter({ name: "Alice" });
		await cursor.toArray();
		expect(calls[0].filter).toEqual({ name: "Alice" });
	});

	test("calling chaining methods after execution throws MongoCursorInUseError", async () => {
		const { runner } = recordingRunner([]);
		const cursor = new FindCursor<User>(runner);
		await cursor.toArray();
		expect(() => cursor.sort({ age: 1 })).toThrow(MongoCursorInUseError);
		expect(() => cursor.limit(5)).toThrow(MongoCursorInUseError);
		expect(() => cursor.skip(3)).toThrow(MongoCursorInUseError);
		expect(() => cursor.project({ name: 1 })).toThrow(MongoCursorInUseError);
		expect(() => cursor.filter({})).toThrow(MongoCursorInUseError);
	});
});

describe("FindCursor – next / hasNext", () => {
	test("next() walks the result set and returns null when exhausted", async () => {
		const { runner } = recordingRunner([ALICE, BOB]);
		const cursor = new FindCursor<User>(runner);
		expect(await cursor.next()).toEqual(ALICE);
		expect(await cursor.next()).toEqual(BOB);
		expect(await cursor.next()).toBeNull();
	});

	test("hasNext() reflects the iterator position", async () => {
		const { runner } = recordingRunner([ALICE, BOB]);
		const cursor = new FindCursor<User>(runner);
		expect(await cursor.hasNext()).toBe(true);
		await cursor.next();
		expect(await cursor.hasNext()).toBe(true);
		await cursor.next();
		expect(await cursor.hasNext()).toBe(false);
	});
});

describe("FindCursor – forEach", () => {
	test("invokes the callback once per document", async () => {
		const { runner } = recordingRunner([ALICE, BOB, CHARLIE]);
		const seen: string[] = [];
		const cursor = new FindCursor<User>(runner);
		await cursor.forEach((doc) => {
			seen.push(doc.name);
		});
		expect(seen).toEqual(["Alice", "Bob", "Charlie"]);
	});

	test("returning false from the callback stops iteration", async () => {
		const { runner } = recordingRunner([ALICE, BOB, CHARLIE]);
		const seen: string[] = [];
		const cursor = new FindCursor<User>(runner);
		// biome-ignore lint/suspicious/useIterableCallbackReturn: forEach() short-circuits on `false` per the MongoDB driver contract.
		await cursor.forEach((doc) => {
			seen.push(doc.name);
			if (doc.name === "Bob") return false;
		});
		expect(seen).toEqual(["Alice", "Bob"]);
	});
});

describe("FindCursor – async iteration", () => {
	test("for-await produces every document in order", async () => {
		const { runner } = recordingRunner([ALICE, BOB, CHARLIE]);
		const seen: string[] = [];
		for await (const doc of new FindCursor<User>(runner)) {
			seen.push(doc.name);
		}
		expect(seen).toEqual(["Alice", "Bob", "Charlie"]);
	});
});

describe("FindCursor – count (deprecated)", () => {
	test("returns the row count after execution", async () => {
		const { runner } = recordingRunner([ALICE, BOB]);
		expect(await new FindCursor<User>(runner).count()).toBe(2);
	});
});

describe("FindCursor – close / closed semantics", () => {
	test("close() flips closed=true", async () => {
		const { runner } = recordingRunner([]);
		const cursor = new FindCursor<User>(runner);
		expect(cursor.closed).toBe(false);
		await cursor.close();
		expect(cursor.closed).toBe(true);
	});

	test("operations after close() throw MongoCursorExhaustedError", async () => {
		const { runner } = recordingRunner([ALICE]);
		const cursor = new FindCursor<User>(runner);
		await cursor.close();
		await expect(cursor.toArray()).rejects.toBeInstanceOf(
			MongoCursorExhaustedError,
		);
		await expect(cursor.next()).rejects.toBeInstanceOf(
			MongoCursorExhaustedError,
		);
		await expect(cursor.hasNext()).rejects.toBeInstanceOf(
			MongoCursorExhaustedError,
		);
	});
});

describe("FindCursor – rewind / clone", () => {
	test("rewind() resets the iterator and re-executes on next consumption", async () => {
		const { runner, calls } = recordingRunner([ALICE, BOB]);
		const cursor = new FindCursor<User>(runner);
		await cursor.toArray();
		expect(calls.length).toBe(1);
		cursor.rewind();
		await cursor.toArray();
		expect(calls.length).toBe(2);
	});

	test("rewind() also clears closed=true", async () => {
		const { runner } = recordingRunner([ALICE]);
		const cursor = new FindCursor<User>(runner);
		await cursor.close();
		cursor.rewind();
		expect(cursor.closed).toBe(false);
		// Can be re-consumed after rewind.
		expect(await cursor.toArray()).toEqual([ALICE]);
	});

	test("clone() yields an independent uninitialised cursor", async () => {
		const { runner, calls } = recordingRunner([ALICE]);
		const original = new FindCursor<User>(runner).limit(7);
		await original.toArray();
		const copy = original.clone();
		expect(copy).not.toBe(original);
		await copy.toArray();
		expect(calls.length).toBe(2);
		// The clone preserves chained options.
		expect(calls[1].limit).toBe(7);
	});
});

describe("FindCursor – map (LSP fix)", () => {
	test("map().toArray() applies the transform per document", async () => {
		const { runner } = recordingRunner([ALICE, BOB]);
		const cursor = new FindCursor<User>(runner);
		const names = await cursor
			.map<{ n: string }>((doc) => ({ n: doc.name }))
			.toArray();
		expect(names).toEqual([{ n: "Alice" }, { n: "Bob" }]);
	});

	test("map() returns a real FindCursor that supports chaining", async () => {
		const { runner, calls } = recordingRunner([ALICE, BOB, CHARLIE]);
		const mapped = new FindCursor<User>(runner)
			.map<{ name: string }>((doc) => ({ name: doc.name }))
			.sort({ age: -1 })
			.limit(2)
			.skip(1);
		expect(mapped).toBeInstanceOf(FindCursor);
		const result = await mapped.toArray();
		expect(result.length).toBeLessThanOrEqual(3);
		// Chained options were forwarded to the runner.
		expect(calls[0].sort).toEqual({ age: -1 });
		expect(calls[0].limit).toBe(2);
		expect(calls[0].skip).toBe(1);
	});

	test("map() compositions stack (latest transform wraps the previous)", async () => {
		const { runner } = recordingRunner([ALICE]);
		const result = await new FindCursor<User>(runner)
			.map<{ upper: string }>((doc) => ({ upper: doc.name.toUpperCase() }))
			.map<{ withBang: string }>((doc) => ({ withBang: `${doc.upper}!` }))
			.toArray();
		expect(result).toEqual([{ withBang: "ALICE!" }]);
	});

	test("map() supports next()/forEach/async iteration too", async () => {
		const { runner } = recordingRunner([ALICE, BOB]);
		const mapped = new FindCursor<User>(runner).map<{ n: string }>((doc) => ({
			n: doc.name,
		}));

		expect(await mapped.next()).toEqual({ n: "Alice" });
		expect(await mapped.next()).toEqual({ n: "Bob" });
		expect(await mapped.next()).toBeNull();
	});
});

describe("FindCursor – projection forwarding", () => {
	test("inclusion projection is forwarded as projectionFields", async () => {
		const { runner, calls } = recordingRunner([]);
		await new FindCursor<User>(runner).project({ name: 1 }).toArray();
		expect(calls[0].projectionFields).toBe("id, name");
		expect(calls[0].projectionExcludeFields).toBeUndefined();
		expect(calls[0].projectionIncludeId).toBe(true);
	});

	test("exclusion projection populates projectionExcludeFields", async () => {
		const { runner, calls } = recordingRunner([]);
		await new FindCursor<User>(runner).project({ name: 0 }).toArray();
		expect(calls[0].projectionFields).toBeUndefined();
		expect(calls[0].projectionExcludeFields).toEqual(["name"]);
		expect(calls[0].projectionIncludeId).toBe(true);
	});

	test("_id: 0 sets projectionIncludeId=false", async () => {
		const { runner, calls } = recordingRunner([]);
		await new FindCursor<User>(runner).project({ _id: 0, name: 1 }).toArray();
		expect(calls[0].projectionFields).toBe("name");
		expect(calls[0].projectionIncludeId).toBe(false);
	});
});
