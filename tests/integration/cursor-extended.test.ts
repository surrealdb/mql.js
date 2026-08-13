import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Collection, ObjectId } from "../../src/index.ts";
import {
	type SurrealTestContext,
	setupSurreal,
	teardownSurreal,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// Test document shape
// ---------------------------------------------------------------------------

interface TestDoc {
	[key: string]: unknown;
	_id?: ObjectId | string | number;
	name: string;
	age: number;
	score?: number;
}

let ctx: SurrealTestContext<TestDoc>;
let col: Collection<TestDoc>;
const PORT = 18740;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
	ctx = await setupSurreal<TestDoc>(PORT);
});

afterAll(async () => {
	await teardownSurreal(ctx);
});

beforeEach(async () => {
	col = ctx.collection("cursor_ext");
	try {
		await col.deleteMany({});
	} catch {
		// ignore
	}
	// Seed test data
	await col.insertMany([
		{ name: "Alice", age: 30, score: 85 },
		{ name: "Bob", age: 25, score: 92 },
		{ name: "Charlie", age: 35, score: 78 },
		{ name: "Diana", age: 28, score: 95 },
		{ name: "Eve", age: 32, score: 88 },
	]);
});

// ---------------------------------------------------------------------------
// cursor.map()
// ---------------------------------------------------------------------------

describe("cursor.map()", () => {
	test("transforms documents via toArray()", async () => {
		const cursor = col.find({}).sort({ age: 1 }).limit(3);
		const mapped = cursor.map((doc) => ({
			label: `${doc.name} (${doc.age})`,
		}));
		const results = await mapped.toArray();
		expect(results).toHaveLength(3);
		expect(results[0].label).toBe("Bob (25)");
		expect(results[1].label).toBe("Diana (28)");
		expect(results[2].label).toBe("Alice (30)");
	});

	test("transforms documents via next()", async () => {
		const cursor = col.find({ name: "Alice" });
		const mapped = cursor.map((doc) => ({
			upper: doc.name.toUpperCase(),
		}));
		const first = await mapped.next();
		expect(first).not.toBeNull();
		expect(first?.upper).toBe("ALICE");

		const second = await mapped.next();
		expect(second).toBeNull();
	});

	test("transforms documents via async iterator", async () => {
		const cursor = col.find({}).sort({ age: 1 }).limit(2);
		const mapped = cursor.map((doc) => ({
			info: `${doc.name}:${doc.score}`,
		}));
		const results: string[] = [];
		for await (const doc of mapped) {
			results.push(doc.info as string);
		}
		expect(results).toEqual(["Bob:92", "Diana:95"]);
	});

	test("preserves count()", async () => {
		const cursor = col.find({}).sort({ age: 1 });
		const mapped = cursor.map((doc) => ({ n: doc.name }));
		const count = await mapped.count();
		expect(count).toBe(5);
	});

	test("forEach works on mapped cursor", async () => {
		const cursor = col.find({}).sort({ age: 1 }).limit(3);
		const mapped = cursor.map((doc) => ({
			label: doc.name,
		}));
		const names: string[] = [];
		await mapped.forEach((doc) => {
			names.push(doc.label as string);
		});
		expect(names).toEqual(["Bob", "Diana", "Alice"]);
	});
});

// ---------------------------------------------------------------------------
// cursor.filter()
// ---------------------------------------------------------------------------

describe("cursor.filter()", () => {
	test("applies additional filter before execution", async () => {
		const cursor = col.find({}).sort({ age: 1 });
		cursor.filter({ age: { $gte: 30 } });
		const results = await cursor.toArray();
		expect(results).toHaveLength(3);
		expect(results[0].name).toBe("Alice"); // age 30
	});

	test("replaces the original filter", async () => {
		const cursor = col.find({ name: "Alice" });
		cursor.filter({ name: "Bob" });
		const results = await cursor.toArray();
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("Bob");
	});
});

// ---------------------------------------------------------------------------
// Async iterator with early break
// ---------------------------------------------------------------------------

describe("async iterator with break", () => {
	test("stops iteration early when break is used", async () => {
		const collected: string[] = [];
		for await (const doc of col.find({}).sort({ age: 1 })) {
			collected.push(doc.name);
			if (collected.length >= 2) break;
		}
		expect(collected).toHaveLength(2);
		expect(collected).toEqual(["Bob", "Diana"]);
	});
});

// ---------------------------------------------------------------------------
// Closed cursor errors
// ---------------------------------------------------------------------------

describe("closed cursor errors", () => {
	test("toArray() throws after close()", async () => {
		const cursor = col.find({});
		await cursor.close();
		expect(cursor.closed).toBe(true);
		// Awaited as a rejection rather than asserted with `toThrow()` on the call:
		// the method is async, so it *rejects*, and only Bun's `expect` unwraps a
		// returned promise to find the error. Written this way it asserts the same
		// thing under both runtimes.
		await expect(cursor.toArray()).rejects.toThrow();
	});

	test("next() throws after close()", async () => {
		const cursor = col.find({});
		await cursor.close();
		await expect(cursor.next()).rejects.toThrow();
	});

	test("hasNext() throws after close()", async () => {
		const cursor = col.find({});
		await cursor.close();
		await expect(cursor.hasNext()).rejects.toThrow();
	});

	test("forEach() throws after close()", async () => {
		const cursor = col.find({});
		await cursor.close();
		await expect(
			cursor.forEach(() => {
				/* noop */
			}),
		).rejects.toThrow();
	});

	test("count() throws after close()", async () => {
		const cursor = col.find({});
		await cursor.close();
		await expect(cursor.count()).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Cursor options cannot be changed after execution
// ---------------------------------------------------------------------------

describe("cursor options after execution", () => {
	test("sort() throws after toArray()", async () => {
		const cursor = col.find({});
		await cursor.toArray();
		expect(() => cursor.sort({ age: 1 })).toThrow();
	});

	test("limit() throws after toArray()", async () => {
		const cursor = col.find({});
		await cursor.toArray();
		expect(() => cursor.limit(1)).toThrow();
	});

	test("skip() throws after toArray()", async () => {
		const cursor = col.find({});
		await cursor.toArray();
		expect(() => cursor.skip(1)).toThrow();
	});

	test("project() throws after toArray()", async () => {
		const cursor = col.find({});
		await cursor.toArray();
		expect(() => cursor.project({ name: 1 })).toThrow();
	});

	test("filter() throws after toArray()", async () => {
		const cursor = col.find({});
		await cursor.toArray();
		expect(() => cursor.filter({ name: "Alice" })).toThrow();
	});
});
