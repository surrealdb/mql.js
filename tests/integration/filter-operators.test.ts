import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	type Collection,
	MongoCompatibilityError,
	ObjectId,
} from "../../src/index.ts";
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
// RANGE OPERATORS AND BSON TYPE BRACKETS
// ---------------------------------------------------------------------------

describe("range operators match within one BSON type bracket", () => {
	interface RangeDoc {
		[key: string]: unknown;
		_id?: ObjectId | string | number;
		k: string;
		v?: unknown;
	}

	let docs: Collection<RangeDoc>;

	const keys = async (filter: Record<string, unknown>) =>
		(await docs.find(filter).toArray()).map((doc) => doc.k).sort();

	// One document of each type. `{v: {$lt: 5}}` used to return `bool`, `missing`
	// and `null` as well, because SurrealQL orders them all in one total order.
	const insertOneOfEachType = () =>
		docs.insertMany([
			{ k: "num10", v: 10 },
			{ k: "num1", v: 1 },
			{ k: "str", v: "abc" },
			{ k: "bool", v: true },
			{ k: "arr", v: [7, 8] },
			{ k: "obj", v: { a: 1 } },
			{ k: "date", v: new Date(5000) },
			{ k: "null", v: null },
			{ k: "missing" },
		]);

	beforeEach(async () => {
		docs = ctx.db.collection<RangeDoc>("range_ops");
		try {
			await docs.deleteMany({});
		} catch {
			// ignore
		}
	});

	// What a real `mongod` returns for each of these, which
	// `tests/e2e/scenarios/crud-scenarios.ts` checks against one.
	test("$gt of a number matches numbers, and an array with a number above it", async () => {
		await insertOneOfEachType();
		expect(await keys({ v: { $gt: 5 } })).toEqual(["arr", "num10"]);
	});

	test("$lt of a number skips a missing field, a null and a boolean", async () => {
		await insertOneOfEachType();
		expect(await keys({ v: { $lt: 5 } })).toEqual(["num1"]);
	});

	test("$gt of a string matches strings only", async () => {
		await insertOneOfEachType();
		expect(await keys({ v: { $gt: "a" } })).toEqual(["str"]);
	});

	test("$lt of a string matches strings only", async () => {
		await insertOneOfEachType();
		expect(await keys({ v: { $lt: "z" } })).toEqual(["str"]);
	});

	test("$gt of a Date matches dates only", async () => {
		await insertOneOfEachType();
		expect(await keys({ v: { $gt: new Date(1) } })).toEqual(["date"]);
	});

	test("$gte and $lte of a boolean match booleans only", async () => {
		await insertOneOfEachType();
		expect(await keys({ v: { $gte: true } })).toEqual(["bool"]);
		expect(await keys({ v: { $lte: true } })).toEqual(["bool"]);
		expect(await keys({ v: { $lte: false } })).toEqual([]);
	});

	test("a person with no age is not under 30", async () => {
		const people = ctx.db.collection<RangeDoc>("range_people");
		await people.deleteMany({});
		await people.insertMany([
			{ k: "Alice", age: 25 },
			{ k: "Bob", age: 40 },
			{ k: "Carol" },
			{ k: "Dave", age: null },
			{ k: "Eve", age: "unknown" },
		]);
		const under30 = await people.find({ age: { $lt: 30 } }).toArray();
		expect(under30.map((person) => person.k)).toEqual(["Alice"]);
		expect(await people.countDocuments({ age: { $lt: 30 } })).toBe(1);
	});

	describe("null", () => {
		test("$gt and $lt of null match nothing", async () => {
			await insertOneOfEachType();
			expect(await keys({ v: { $gt: null } })).toEqual([]);
			expect(await keys({ v: { $lt: null } })).toEqual([]);
		});

		test("$gte and $lte of null match a null and a missing field", async () => {
			await insertOneOfEachType();
			expect(await keys({ v: { $gte: null } })).toEqual(["missing", "null"]);
			expect(await keys({ v: { $lte: null } })).toEqual(["missing", "null"]);
		});

		test("an undefined operand is null", async () => {
			await insertOneOfEachType();
			expect(await keys({ v: { $gt: undefined } })).toEqual([]);
			expect(await keys({ v: { $gte: undefined } })).toEqual([
				"missing",
				"null",
			]);
		});
	});

	describe("NaN and infinities", () => {
		beforeEach(async () => {
			await docs.insertMany([
				{ k: "nan", v: Number.NaN },
				{ k: "inf", v: Number.POSITIVE_INFINITY },
				{ k: "ninf", v: Number.NEGATIVE_INFINITY },
				{ k: "five", v: 5 },
				{ k: "arrNan", v: [Number.NaN] },
			]);
		});

		test("a stored NaN is in no range", async () => {
			expect(await keys({ v: { $gt: 0 } })).toEqual(["five", "inf"]);
			expect(await keys({ v: { $gte: 0 } })).toEqual(["five", "inf"]);
			expect(await keys({ v: { $lt: 10 } })).toEqual(["five", "ninf"]);
			expect(await keys({ v: { $lte: 10 } })).toEqual(["five", "ninf"]);
		});

		test("an operand of NaN is ordered against nothing, but equals NaN", async () => {
			expect(await keys({ v: { $gt: Number.NaN } })).toEqual([]);
			expect(await keys({ v: { $lt: Number.NaN } })).toEqual([]);
			expect(await keys({ v: { $gte: Number.NaN } })).toEqual([
				"arrNan",
				"nan",
			]);
			expect(await keys({ v: { $lte: Number.NaN } })).toEqual([
				"arrNan",
				"nan",
			]);
		});

		test("infinities order as numbers", async () => {
			expect(await keys({ v: { $gt: Number.POSITIVE_INFINITY } })).toEqual([]);
			expect(await keys({ v: { $gte: Number.POSITIVE_INFINITY } })).toEqual([
				"inf",
			]);
			expect(await keys({ v: { $lte: Number.NEGATIVE_INFINITY } })).toEqual([
				"ninf",
			]);
		});
	});

	describe("arrays", () => {
		beforeEach(async () => {
			await docs.insertMany([
				{ k: "low", v: [1, 2] },
				{ k: "high", v: [7, 8] },
				{ k: "both", v: [1, 9] },
				{ k: "mixed", v: [1, "x"] },
				{ k: "nested", v: [[7, 8]] },
				{ k: "empty", v: [] },
				{ k: "scalar", v: 6 },
			]);
		});

		test("an array matches when any element is in range", async () => {
			expect(await keys({ v: { $gt: 5 } })).toEqual(["both", "high", "scalar"]);
			expect(await keys({ v: { $lt: 5 } })).toEqual(["both", "low", "mixed"]);
		});

		test("an array that is itself above the operand does not match on that account", async () => {
			// `[1, 2] > 5` in SurrealQL's order, which is what the old comparison used.
			expect(await keys({ v: { $gt: 5 } })).not.toContain("low");
		});

		test("an array inside an array is not searched", async () => {
			expect(await keys({ v: { $gte: 7 } })).toEqual(["both", "high"]);
		});

		test("an $elemMatch element is compared as a value", async () => {
			expect(await keys({ v: { $elemMatch: { $gt: 7 } } })).toEqual([
				"both",
				"high",
			]);
			expect(await keys({ v: { $elemMatch: { $gt: 2, $lt: 5 } } })).toEqual([]);
		});

		test("$not negates the whole bracketed predicate", async () => {
			expect(await keys({ v: { $not: { $gt: 5 } } })).toEqual([
				"empty",
				"low",
				"mixed",
				"nested",
			]);
		});

		test("an element addressed by index is a value of its own", async () => {
			await docs.deleteMany({});
			await docs.insertMany([
				{ k: "first", scores: [95, 10] },
				{ k: "second", scores: [10, 95] },
				{ k: "text", scores: ["95", 10] },
				{ k: "short", scores: [] },
			]);
			expect(await keys({ "scores.0": { $gt: 90 } })).toEqual(["first"]);
			expect(await keys({ "scores.0": { $lt: 20 } })).toEqual(["second"]);
		});

		test("an array of documents is searched through its path", async () => {
			await docs.deleteMany({});
			await docs.insertMany([
				{ k: "hi", items: [{ price: 1 }, { price: 9 }] },
				{ k: "lo", items: [{ price: 1 }] },
				{ k: "obj", items: { price: 9 } },
				{ k: "none" },
			]);
			expect(await keys({ "items.price": { $gt: 5 } })).toEqual(["hi", "obj"]);
			expect(await keys({ "items.price": { $lt: 5 } })).toEqual(["hi", "lo"]);
		});
	});

	describe("ObjectIds", () => {
		const oid = (hex: string) => new ObjectId(hex);

		beforeEach(async () => {
			await docs.insertMany([
				{ k: "one", ref: oid("000000000000000000000001") },
				{ k: "two", ref: oid("000000000000000000000002") },
				{ k: "ff", ref: oid("0000000000000000000000ff") },
				{
					k: "arr",
					ref: [
						oid("000000000000000000000002"),
						oid("000000000000000000000003"),
					],
				},
				{ k: "str", ref: "000000000000000000000002" },
				{ k: "obj", ref: { $oid: "000000000000000000000009", extra: 1 } },
			]);
		});

		test("order follows the twelve bytes", async () => {
			expect(
				await keys({ ref: { $gt: oid("000000000000000000000001") } }),
			).toEqual(["arr", "ff", "two"]);
			expect(
				await keys({ ref: { $lt: oid("0000000000000000000000ff") } }),
			).toEqual(["arr", "one", "two"]);
			expect(
				await keys({ ref: { $gte: oid("0000000000000000000000ff") } }),
			).toEqual(["ff"]);
			expect(
				await keys({ ref: { $lte: oid("000000000000000000000001") } }),
			).toEqual(["one"]);
		});

		test("a string of the same hex is not an ObjectId", async () => {
			expect(await keys({ ref: { $gte: "000000000000000000000001" } })).toEqual(
				["str"],
			);
		});

		test("a document that merely has a $oid field is not one either", async () => {
			expect(
				await keys({ ref: { $gt: oid("000000000000000000000000") } }),
			).not.toContain("obj");
		});
	});

	describe("the rest of the driver reads them the same way", () => {
		beforeEach(insertOneOfEachType);

		test("countDocuments", async () => {
			expect(await docs.countDocuments({ v: { $lt: 5 } })).toBe(1);
			expect(await docs.countDocuments({ v: { $gte: null } })).toBe(2);
		});

		test("distinct", async () => {
			expect(await docs.distinct("k", { v: { $gt: "a" } })).toEqual(["str"]);
		});

		test("updateMany touches only what matches", async () => {
			const result = await docs.updateMany(
				{ v: { $lt: 5 } },
				{ $set: { touched: true } },
			);
			expect(result.matchedCount).toBe(1);
			expect(await keys({ touched: true })).toEqual(["num1"]);
		});

		test("deleteMany removes only what matches", async () => {
			const result = await docs.deleteMany({ v: { $gt: "a" } });
			expect(result.deletedCount).toBe(1);
			expect(await docs.countDocuments({})).toBe(8);
		});

		test("an aggregation $match", async () => {
			const matched = await docs
				.aggregate<RangeDoc>([{ $match: { v: { $gt: 5 } } }])
				.toArray();
			expect(matched.map((doc) => doc.k).sort()).toEqual(["arr", "num10"]);
		});

		test("an aggregation $match on a grouped _id compares the group key", async () => {
			const keyed = ctx.db.collection<RangeDoc>("range_groups");
			await keyed.deleteMany({});
			await keyed.insertMany([
				{ k: "n1", g: 1 },
				{ k: "n9", g: 9 },
				{ k: "s", g: "a" },
				{ k: "b", g: true },
			]);
			const under5 = await keyed
				.aggregate<{ _id: unknown }>([
					{ $group: { _id: "$g", n: { $sum: 1 } } },
					{ $match: { _id: { $lt: 5 } } },
				])
				.toArray();
			expect(under5.map((row) => row._id)).toEqual([1]);
		});

		test("an aggregation $match on a computed field", async () => {
			const grouped = await docs
				.aggregate<{ _id: unknown; n: number }>([
					{ $group: { _id: "$k", n: { $sum: 1 } } },
					{ $match: { n: { $gt: 0 } } },
				])
				.toArray();
			expect(grouped).toHaveLength(9);
		});

		test("the identity field keeps comparing record ids", async () => {
			const all = await docs.find({}).sort({ _id: 1 }).toArray();
			const middle = all[4]._id;
			const above = await docs.find({ _id: { $gt: middle } }).toArray();
			expect(above).toHaveLength(4);
		});
	});

	describe("an index on the field", () => {
		// Scalars only: SurrealDB's index scan returns an array-valued field once
		// per element the scan range covers, which `find()` would then hand back
		// as a duplicate. That holds for a bare `v > 5` as much as for this
		// predicate, so it is not a thing these assertions could tell apart.
		test("answers the same as a scan, whatever else is in the range", async () => {
			await docs.insertMany([
				{ k: "num10", v: 10 },
				{ k: "num1", v: 1 },
				{ k: "str", v: "abc" },
				{ k: "bool", v: true },
				{ k: "date", v: new Date(5000) },
				{ k: "null", v: null },
				{ k: "missing" },
			]);
			const queries: Record<string, unknown>[] = [
				{ v: { $gt: 5 } },
				{ v: { $gte: 10 } },
				{ v: { $lt: 5 } },
				{ v: { $lte: 1 } },
				{ v: { $gt: "a" } },
				{ v: { $lt: "z" } },
				{ v: { $gt: new Date(1) } },
				{ v: { $gte: null } },
				{ v: { $gt: 0, $lt: 100 } },
			];
			const scanned = await Promise.all(queries.map(keys));

			await docs.createIndex({ v: 1 });
			const indexed = await Promise.all(queries.map(keys));

			expect(indexed).toEqual(scanned);
			expect(scanned[0]).toEqual(["num10"]);
			expect(scanned[2]).toEqual(["num1"]);
		});
	});

	describe("what has no exact translation is refused", () => {
		const find = (filter: Record<string, unknown>) =>
			(async () => docs.find(filter).toArray())();

		test("an array operand", async () => {
			await expect(find({ v: { $gt: [7] } })).rejects.toThrow(
				MongoCompatibilityError,
			);
			await expect(find({ v: { $lte: [] } })).rejects.toThrow(
				"$lte with an array operand is not supported",
			);
		});

		test("an embedded document operand", async () => {
			await expect(find({ v: { $lt: { a: 1 } } })).rejects.toThrow(
				MongoCompatibilityError,
			);
			await expect(find({ v: { $gte: {} } })).rejects.toThrow(
				"$gte with an embedded document operand is not supported",
			);
		});

		test("a refusal reaches deleteMany before it deletes anything", async () => {
			await insertOneOfEachType();
			await expect(
				(async () => docs.deleteMany({ v: { $gt: [1] } }))(),
			).rejects.toThrow(MongoCompatibilityError);
			expect(await docs.countDocuments({})).toBe(9);
		});
	});
});

// ---------------------------------------------------------------------------
// NULL EQUALITY AND ARRAYS
// ---------------------------------------------------------------------------

describe("null equality sees the elements of an array", () => {
	interface NullDoc {
		[key: string]: unknown;
		_id?: ObjectId | string | number;
		k: string;
		v?: unknown;
	}

	let docs: Collection<NullDoc>;

	const keys = async (filter: Record<string, unknown>) =>
		(await docs.find(filter).toArray()).map((doc) => doc.k).sort();

	beforeEach(async () => {
		docs = ctx.db.collection<NullDoc>("null_elements");
		try {
			await docs.deleteMany({});
		} catch {
			// ignore
		}
		await docs.insertMany([
			{ k: "arrNull", v: [null] },
			{ k: "arrMixed", v: [1, null, "x"] },
			{ k: "arrNum", v: [1, 2] },
			{ k: "arrEmpty", v: [] },
			{ k: "arrNested", v: [[null]] },
			{ k: "null", v: null },
			{ k: "missing" },
			{ k: "num", v: 5 },
			{ k: "obj", v: { a: null } },
			{ k: "objArr", v: [{ a: null }] },
		]);
	});

	const WITH_NULL = ["arrMixed", "arrNull", "missing", "null"];
	const WITHOUT_NULL = [
		"arrEmpty",
		"arrNested",
		"arrNum",
		"num",
		"obj",
		"objArr",
	];

	// What a real `mongod` returns for each of these, which
	// `tests/e2e/scenarios/crud-scenarios.ts` checks against one.
	test("{f: null} matches an array holding a null, as well as a null and a missing field", async () => {
		expect(await keys({ v: null })).toEqual(WITH_NULL);
		expect(await keys({ v: { $eq: null } })).toEqual(WITH_NULL);
	});

	test("$ne: null excludes all of them", async () => {
		expect(await keys({ v: { $ne: null } })).toEqual(WITHOUT_NULL);
	});

	test("$not and $nor negate it", async () => {
		expect(await keys({ v: { $not: { $eq: null } } })).toEqual(WITHOUT_NULL);
		expect(await keys({ v: { $not: { $ne: null } } })).toEqual(WITH_NULL);
		expect(await keys({ $nor: [{ v: null }] })).toEqual(WITHOUT_NULL);
	});

	test("$gte: null and $lte: null are the same equality", async () => {
		expect(await keys({ v: { $gte: null } })).toEqual(WITH_NULL);
		expect(await keys({ v: { $lte: null } })).toEqual(WITH_NULL);
	});

	test("an array inside an array is not searched", async () => {
		expect(await keys({ v: null })).not.toContain("arrNested");
	});

	test("$in and $nin of null already saw the elements", async () => {
		expect(await keys({ v: { $in: [null] } })).toEqual(WITH_NULL);
		expect(await keys({ v: { $nin: [null] } })).toEqual(WITHOUT_NULL);
	});

	test("an $elemMatch element is a value, not an array to look inside", async () => {
		expect(await keys({ v: { $elemMatch: { $eq: null } } })).toEqual([
			"arrMixed",
			"arrNull",
		]);
		// `[[null]]`'s one element is an array, which is not null.
		expect(await keys({ v: { $elemMatch: { $ne: null } } })).toEqual([
			"arrMixed",
			"arrNested",
			"arrNum",
			"objArr",
		]);
	});

	test("a path through an array of documents sees a null in one of them", async () => {
		expect(await keys({ "v.a": null })).toEqual([
			"missing",
			"null",
			"num",
			"obj",
			"objArr",
		]);
		expect(await keys({ "v.a": { $ne: null } })).toEqual([
			"arrEmpty",
			"arrMixed",
			"arrNested",
			"arrNull",
			"arrNum",
		]);
	});

	test("the same through a path into documents that hold an array", async () => {
		await docs.deleteMany({});
		await docs.insertMany([
			{ k: "pathNull", items: [{ x: null }, { x: 1 }] },
			{ k: "pathAll", items: [{ x: 1 }, { x: 2 }] },
			{ k: "pathObj", items: { x: null } },
			{ k: "pathEmpty", items: [] },
			{ k: "pathNone" },
		]);
		expect(await keys({ "items.x": null })).toEqual([
			"pathNone",
			"pathNull",
			"pathObj",
		]);
		expect(await keys({ "items.x": { $ne: null } })).toEqual([
			"pathAll",
			"pathEmpty",
		]);
	});

	test("countDocuments, distinct, update and delete read it the same way", async () => {
		expect(await docs.countDocuments({ v: null })).toBe(4);
		expect(await docs.countDocuments({ v: { $ne: null } })).toBe(6);
		expect((await docs.distinct("k", { v: null })).sort()).toEqual(WITH_NULL);

		const updated = await docs.updateMany({ v: null }, { $set: { hit: true } });
		expect(updated.matchedCount).toBe(4);
		expect(await keys({ hit: true })).toEqual(WITH_NULL);

		const deleted = await docs.deleteMany({ v: { $ne: null } });
		expect(deleted.deletedCount).toBe(6);
		expect(await keys({})).toEqual(WITH_NULL);
	});

	test("an aggregation $match reads it the same way", async () => {
		const matched = await docs
			.aggregate<NullDoc>([{ $match: { v: { $ne: null } } }])
			.toArray();
		expect(matched.map((doc) => doc.k).sort()).toEqual(WITHOUT_NULL);
	});

	test("the identity is never null", async () => {
		const count = (filter: Record<string, unknown>) =>
			docs.countDocuments(filter);
		expect(await count({ _id: null })).toBe(0);
		expect(await count({ _id: { $ne: null } })).toBe(10);
	});

	describe("what it still does not see", () => {
		// MongoDB counts a document without the sub-field as null, so
		// `{"items.x": null}` matches `items: [{y: 1}]`. SurrealQL evaluates `items.x`
		// to `[NONE]` for that, and to `[NONE, NONE]` for `v.a` over `[1, 2]`, which
		// MongoDB does *not* match: naming NONE would trade one wrong answer for
		// another, so neither is matched.
		test("a document in an array that lacks the sub-field", async () => {
			await docs.deleteMany({});
			await docs.insertOne({ k: "pathMissing", items: [{ y: 1 }] });
			expect(await keys({ "items.x": null })).toEqual([]);
		});

		test("and a scalar array is not mistaken for one", async () => {
			expect(await keys({ "v.a": null })).not.toContain("arrNum");
		});
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
