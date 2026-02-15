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
	age?: number;
	score?: number;
	value?: number;
	tags?: string[];
	scores?: number[];
	email?: string;
	nickname?: string;
	updatedAt?: string;
	grades?: { grade: string; score: number }[];
}

let ctx: SurrealTestContext<TestDoc>;
let col: Collection<TestDoc>;
const PORT = 18737;

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
	col = ctx.collection("update_ops");
	try {
		await col.deleteMany({});
	} catch {
		// ignore
	}
});

// ---------------------------------------------------------------------------
// $mul
// ---------------------------------------------------------------------------

describe("$mul", () => {
	test("multiplies a numeric field", async () => {
		await col.insertOne({ name: "Alice", age: 30, score: 10 });
		await col.updateOne({ name: "Alice" }, { $mul: { score: 3 } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.score).toBe(30);
	});

	test("multiplies by decimal", async () => {
		await col.insertOne({ name: "Alice", age: 30, value: 100 });
		await col.updateOne({ name: "Alice" }, { $mul: { value: 0.5 } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.value).toBe(50);
	});

	test("multiplies by zero", async () => {
		await col.insertOne({ name: "Alice", age: 30, score: 42 });
		await col.updateOne({ name: "Alice" }, { $mul: { score: 0 } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.score).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// $min / $max
// ---------------------------------------------------------------------------

describe("$min", () => {
	test("updates field when new value is smaller", async () => {
		await col.insertOne({ name: "Alice", age: 30, score: 80 });
		await col.updateOne({ name: "Alice" }, { $min: { score: 60 } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.score).toBe(60);
	});

	test("does not update when existing value is already smaller", async () => {
		await col.insertOne({ name: "Alice", age: 30, score: 50 });
		await col.updateOne({ name: "Alice" }, { $min: { score: 80 } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.score).toBe(50);
	});
});

describe("$max", () => {
	test("updates field when new value is larger", async () => {
		await col.insertOne({ name: "Alice", age: 30, score: 80 });
		await col.updateOne({ name: "Alice" }, { $max: { score: 95 } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.score).toBe(95);
	});

	test("does not update when existing value is already larger", async () => {
		await col.insertOne({ name: "Alice", age: 30, score: 95 });
		await col.updateOne({ name: "Alice" }, { $max: { score: 80 } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.score).toBe(95);
	});
});

// ---------------------------------------------------------------------------
// $addToSet
// ---------------------------------------------------------------------------

describe("$addToSet", () => {
	test("adds value to array if not present", async () => {
		await col.insertOne({ name: "Alice", age: 30, tags: ["a", "b"] });
		await col.updateOne({ name: "Alice" }, { $addToSet: { tags: "c" } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.tags).toContain("c");
		expect(updated?.tags).toHaveLength(3);
	});

	test("does not duplicate existing value", async () => {
		await col.insertOne({ name: "Alice", age: 30, tags: ["a", "b", "c"] });
		await col.updateOne({ name: "Alice" }, { $addToSet: { tags: "b" } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.tags).toHaveLength(3);
	});
});

// ---------------------------------------------------------------------------
// $rename
// ---------------------------------------------------------------------------

describe("$rename", () => {
	test("renames a field", async () => {
		await col.insertOne({
			name: "Alice",
			age: 30,
			email: "alice@test.com",
		});
		await col.updateOne(
			{ name: "Alice" },
			{ $rename: { email: "contactEmail" } },
		);
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.email).toBeUndefined();
		expect((updated as Record<string, unknown>)?.contactEmail).toBe(
			"alice@test.com",
		);
	});
});

// ---------------------------------------------------------------------------
// $currentDate
// ---------------------------------------------------------------------------

describe("$currentDate", () => {
	test("sets field to current timestamp", async () => {
		await col.insertOne({ name: "Alice", age: 30 });
		await col.updateOne(
			{ name: "Alice" },
			{ $currentDate: { updatedAt: true } },
		);
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.updatedAt).toBeDefined();
		// SurrealDB's time::now() returns a datetime object
		expect(updated?.updatedAt).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// $push with $sort modifier
// ---------------------------------------------------------------------------

describe("$push with $sort", () => {
	test("sorts array after push with $each and $sort ascending", async () => {
		await col.insertOne({ name: "Alice", age: 30, scores: [50, 30, 80] });
		await col.updateOne(
			{ name: "Alice" },
			{ $push: { scores: { $each: [10, 90], $sort: 1 } } },
		);
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.scores).toEqual([10, 30, 50, 80, 90]);
	});

	test("sorts array descending with $sort: -1", async () => {
		await col.insertOne({ name: "Alice", age: 30, scores: [50, 30, 80] });
		await col.updateOne(
			{ name: "Alice" },
			{ $push: { scores: { $each: [10, 90], $sort: -1 } } },
		);
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.scores).toEqual([90, 80, 50, 30, 10]);
	});
});

// ---------------------------------------------------------------------------
// $push with $position modifier
// ---------------------------------------------------------------------------

describe("$push with $position", () => {
	test("inserts elements at specified position", async () => {
		await col.insertOne({ name: "Alice", age: 30, tags: ["a", "d", "e"] });
		await col.updateOne(
			{ name: "Alice" },
			{ $push: { tags: { $each: ["b", "c"], $position: 1 } } },
		);
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.tags).toEqual(["a", "b", "c", "d", "e"]);
	});

	test("inserts at position 0 (beginning)", async () => {
		await col.insertOne({ name: "Alice", age: 30, tags: ["c", "d"] });
		await col.updateOne(
			{ name: "Alice" },
			{ $push: { tags: { $each: ["a", "b"], $position: 0 } } },
		);
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.tags).toEqual(["a", "b", "c", "d"]);
	});
});

// ---------------------------------------------------------------------------
// $push with combined modifiers ($each + $sort + $slice)
// ---------------------------------------------------------------------------

describe("$push with $each + $sort + $slice combined", () => {
	test("pushes, sorts, and slices in one operation", async () => {
		await col.insertOne({ name: "Alice", age: 30, scores: [70, 90, 50] });
		await col.updateOne(
			{ name: "Alice" },
			{
				$push: {
					scores: { $each: [80, 95, 60], $sort: -1, $slice: 4 },
				},
			},
		);
		const updated = await col.findOne({ name: "Alice" });
		// After concat: [70,90,50,80,95,60] → sort desc: [95,90,80,70,60,50] → slice first 4
		expect(updated?.scores).toEqual([95, 90, 80, 70]);
	});

	test("$slice with negative keeps last N", async () => {
		await col.insertOne({ name: "Alice", age: 30, scores: [10, 20] });
		await col.updateOne(
			{ name: "Alice" },
			{
				$push: {
					scores: { $each: [30, 40, 50], $slice: -3 },
				},
			},
		);
		const updated = await col.findOne({ name: "Alice" });
		// After concat: [10,20,30,40,50] → slice last 3
		expect(updated?.scores).toEqual([30, 40, 50]);
	});
});

// ---------------------------------------------------------------------------
// $setOnInsert (tested via upsert context in advanced-crud, but verify
// the clause generation here via updateMany with upsert)
// ---------------------------------------------------------------------------

describe("$setOnInsert", () => {
	test("sets fields only when upserting a new document", async () => {
		const result = await col.updateMany(
			{ name: "NewUser" },
			{
				$set: { name: "NewUser", age: 25 },
				$setOnInsert: { score: 100 },
			},
			{ upsert: true },
		);
		expect(result.upsertedCount).toBe(1);
		const doc = await col.findOne({ age: 25 });
		expect(doc).not.toBeNull();
		expect(doc?.age).toBe(25);
		// $setOnInsert uses ?? operator, so score should be set on the new doc
		expect(doc?.score).toBe(100);
	});
});

// ---------------------------------------------------------------------------
// Multiple operators in a single update
// ---------------------------------------------------------------------------

describe("combined update operators", () => {
	test("$set and $inc in one update", async () => {
		await col.insertOne({
			name: "Alice",
			age: 30,
			score: 80,
			active: false,
		} as TestDoc);
		await col.updateOne(
			{ name: "Alice" },
			{ $set: { active: true }, $inc: { score: 10 } },
		);
		const updated = await col.findOne({ name: "Alice" });
		expect((updated as Record<string, unknown>)?.active).toBe(true);
		expect(updated?.score).toBe(90);
	});

	test("$push and $set in one update", async () => {
		await col.insertOne({ name: "Alice", age: 30, tags: ["a"], score: 0 });
		await col.updateOne(
			{ name: "Alice" },
			{ $push: { tags: "b" }, $set: { score: 42 } },
		);
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.tags).toContain("b");
		expect(updated?.score).toBe(42);
	});
});
