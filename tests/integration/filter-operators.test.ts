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
	email?: string;
	tags?: string[];
	active?: boolean;
	grades?: { grade: string; score: number }[];
	address?: { city: string; zip?: string };
}

let ctx: SurrealTestContext<TestDoc>;
let col: Collection<TestDoc>;
const PORT = 18736;

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
	col = ctx.collection("filter_ops");
	try {
		await col.deleteMany({});
	} catch {
		// ignore
	}
});

// ---------------------------------------------------------------------------
// COMPARISON OPERATORS
// ---------------------------------------------------------------------------

describe("$eq (explicit)", () => {
	test("matches documents with explicit $eq", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
		]);
		const results = await col.find({ name: { $eq: "Alice" } }).toArray();
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("Alice");
	});
});

describe("$ne", () => {
	test("excludes documents with matching value", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
			{ name: "Charlie", age: 35 },
		]);
		const results = await col.find({ name: { $ne: "Bob" } }).toArray();
		expect(results).toHaveLength(2);
		const names = results.map((r) => r.name).sort();
		expect(names).toEqual(["Alice", "Charlie"]);
	});

	test("$ne with numeric value", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
			{ name: "Charlie", age: 30 },
		]);
		const results = await col.find({ age: { $ne: 30 } }).toArray();
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("Bob");
	});
});

describe("$lt", () => {
	test("finds documents less than value", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
			{ name: "Charlie", age: 35 },
		]);
		const results = await col.find({ age: { $lt: 30 } }).toArray();
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("Bob");
	});
});

describe("$lte", () => {
	test("finds documents less than or equal to value", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
			{ name: "Charlie", age: 35 },
		]);
		const results = await col
			.find({ age: { $lte: 30 } })
			.sort({ age: 1 })
			.toArray();
		expect(results).toHaveLength(2);
		expect(results[0].name).toBe("Bob");
		expect(results[1].name).toBe("Alice");
	});
});

describe("combined comparison operators", () => {
	test("$gt and $lt together define a range", async () => {
		await col.insertMany([
			{ name: "Alice", age: 20 },
			{ name: "Bob", age: 25 },
			{ name: "Charlie", age: 30 },
			{ name: "Diana", age: 35 },
		]);
		const results = await col
			.find({ age: { $gt: 20, $lt: 35 } })
			.sort({ age: 1 })
			.toArray();
		expect(results).toHaveLength(2);
		expect(results.map((r) => r.name)).toEqual(["Bob", "Charlie"]);
	});

	test("$gte and $lte together define an inclusive range", async () => {
		await col.insertMany([
			{ name: "Alice", age: 20 },
			{ name: "Bob", age: 25 },
			{ name: "Charlie", age: 30 },
			{ name: "Diana", age: 35 },
		]);
		const results = await col
			.find({ age: { $gte: 25, $lte: 30 } })
			.sort({ age: 1 })
			.toArray();
		expect(results).toHaveLength(2);
		expect(results.map((r) => r.name)).toEqual(["Bob", "Charlie"]);
	});
});

// ---------------------------------------------------------------------------
// MEMBERSHIP OPERATORS
// ---------------------------------------------------------------------------

describe("$nin", () => {
	test("excludes documents with values in array", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
			{ name: "Charlie", age: 35 },
		]);
		const results = await col
			.find({ name: { $nin: ["Alice", "Charlie"] } })
			.toArray();
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("Bob");
	});
});

// ---------------------------------------------------------------------------
// ELEMENT OPERATORS
// ---------------------------------------------------------------------------

describe("$exists", () => {
	test("$exists: true finds documents where field is present", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30, email: "alice@test.com" },
			{ name: "Bob", age: 25 },
		]);
		const results = await col.find({ email: { $exists: true } }).toArray();
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("Alice");
	});

	test("$exists: false finds documents where field is absent", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30, email: "alice@test.com" },
			{ name: "Bob", age: 25 },
		]);
		const results = await col.find({ email: { $exists: false } }).toArray();
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("Bob");
	});
});

// ---------------------------------------------------------------------------
// EVALUATION OPERATORS
// ---------------------------------------------------------------------------

describe("$regex", () => {
	test("matches with $regex string", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Alicia", age: 28 },
			{ name: "Bob", age: 25 },
		]);
		const results = await col.find({ name: { $regex: "Ali" } }).toArray();
		expect(results).toHaveLength(2);
		const names = results.map((r) => r.name).sort();
		expect(names).toEqual(["Alice", "Alicia"]);
	});

	test("matches with $regex using RegExp object", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Alicia", age: 28 },
			{ name: "Bob", age: 25 },
		]);
		// SurrealQL's ~ operator does fuzzy/substring matching
		const results = await col.find({ name: { $regex: /Ali/ } }).toArray();
		expect(results).toHaveLength(2);
	});
});

describe("$mod", () => {
	test("matches documents where field mod divisor equals remainder", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
			{ name: "Charlie", age: 35 },
			{ name: "Diana", age: 20 },
		]);
		// age % 10 == 5
		const results = await col.find({ age: { $mod: [10, 5] } }).toArray();
		expect(results).toHaveLength(2);
		const names = results.map((r) => r.name).sort();
		expect(names).toEqual(["Bob", "Charlie"]);
	});
});

// ---------------------------------------------------------------------------
// LOGICAL OPERATORS
// ---------------------------------------------------------------------------

describe("$nor", () => {
	test("excludes documents matching any condition", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
			{ name: "Charlie", age: 35 },
		]);
		const results = await col
			.find({ $nor: [{ name: "Alice" }, { age: 35 }] })
			.toArray();
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("Bob");
	});
});

describe("$not", () => {
	test("negates an operator expression", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
			{ name: "Charlie", age: 35 },
		]);
		// age NOT greater than 28 → Alice(30) and Charlie(35) excluded
		const results = await col.find({ age: { $not: { $gt: 28 } } }).toArray();
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("Bob");
	});

	test("$not combined with $regex", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Alicia", age: 28 },
			{ name: "Bob", age: 25 },
		]);
		const results = await col
			.find({ name: { $not: { $regex: "Ali" } } })
			.toArray();
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("Bob");
	});
});

// ---------------------------------------------------------------------------
// ARRAY OPERATORS
// ---------------------------------------------------------------------------

describe("$elemMatch", () => {
	test("equality object: matches array element with all fields", async () => {
		await col.insertMany([
			{
				name: "Alice",
				age: 30,
				grades: [
					{ grade: "A", score: 95 },
					{ grade: "B", score: 80 },
				],
			},
			{
				name: "Bob",
				age: 25,
				grades: [
					{ grade: "B", score: 85 },
					{ grade: "C", score: 70 },
				],
			},
		]);
		const results = await col
			.find({ grades: { $elemMatch: { grade: "A", score: 95 } } })
			.toArray();
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("Alice");
	});

	test("operator-based: matches array elements with operators", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30, tags: ["10", "20", "30"] },
			{ name: "Bob", age: 25, tags: ["5", "15"] },
		]);
		// Seed numeric scores for elemMatch
		await col.deleteMany({});
		await col.insertMany([
			{ name: "Alice", age: 30, score: 0 },
			{ name: "Bob", age: 25, score: 0 },
		]);
		// Use grades array with operator-based elemMatch
		await col.deleteMany({});
		await col.insertMany([
			{
				name: "Alice",
				age: 30,
				grades: [
					{ grade: "A", score: 95 },
					{ grade: "B", score: 82 },
				],
			},
			{
				name: "Bob",
				age: 25,
				grades: [
					{ grade: "B", score: 75 },
					{ grade: "C", score: 60 },
				],
			},
		]);
		// elemMatch with operator on sub-field
		const results = await col
			.find({
				grades: { $elemMatch: { score: { $gte: 90 }, grade: "A" } },
			})
			.toArray();
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("Alice");
	});
});

// ---------------------------------------------------------------------------
// TYPE OPERATOR
// ---------------------------------------------------------------------------

describe("$type", () => {
	test("matches by BSON type string", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30, score: 95.5 },
			{ name: "Bob", age: 25, score: 80 },
		]);
		const results = await col.find({ name: { $type: "string" } }).toArray();
		// Both have string names
		expect(results).toHaveLength(2);
	});

	test("matches by BSON type for arrays", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30, tags: ["a", "b"] },
			{ name: "Bob", age: 25 },
		]);
		const results = await col.find({ tags: { $type: "array" } }).toArray();
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("Alice");
	});
});

// ---------------------------------------------------------------------------
// REGEX SHORTHAND
// ---------------------------------------------------------------------------

describe("$regex patterns", () => {
	test("substring matching with $regex", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
			{ name: "Charlie", age: 35 },
		]);
		// SurrealQL ~ does fuzzy/substring matching
		const results = await col.find({ name: { $regex: "ob" } }).toArray();
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("Bob");
	});
});

// ---------------------------------------------------------------------------
// COMBINED / COMPOUND FILTERS
// ---------------------------------------------------------------------------

describe("compound filters", () => {
	test("$or with nested operators", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30, score: 90 },
			{ name: "Bob", age: 25, score: 60 },
			{ name: "Charlie", age: 35, score: 85 },
			{ name: "Diana", age: 22, score: 95 },
		]);
		const results = await col
			.find({
				$or: [{ age: { $lt: 25 } }, { score: { $gte: 90 } }],
			})
			.toArray();
		expect(results).toHaveLength(2);
		const names = results.map((r) => r.name).sort();
		expect(names).toEqual(["Alice", "Diana"]);
	});

	test("implicit $and with multiple field conditions", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30, active: true },
			{ name: "Bob", age: 25, active: true },
			{ name: "Charlie", age: 35, active: false },
		]);
		const results = await col
			.find({ active: true, age: { $gte: 28 } })
			.toArray();
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("Alice");
	});

	test("nested field with operators", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30, address: { city: "NYC", zip: "10001" } },
			{ name: "Bob", age: 25, address: { city: "LA", zip: "90001" } },
			{ name: "Charlie", age: 35, address: { city: "NYC", zip: "10002" } },
		]);
		const results = await col
			.find({ "address.city": { $ne: "NYC" } })
			.toArray();
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("Bob");
	});
});
