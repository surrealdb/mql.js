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
// ORDERING OPERATORS IN $pull AND arrayFilters
// ---------------------------------------------------------------------------

describe("ordering operators in $pull and arrayFilters match within one BSON type", () => {
	// A `$pull` condition and an `arrayFilters` entry are query predicates applied
	// to an array element, so they bracket by type as a filter's do. As a bare `>`
	// they removed the string "x" for `{$pull: {v: {$gt: 5}}}`, because SurrealQL
	// ranks every string above every number. What a real `mongod` leaves in the
	// array is what each case below expects, and
	// `tests/e2e/scenarios/crud-scenarios.ts` checks them against one.

	interface ArrayDoc {
		[key: string]: unknown;
		_id?: ObjectId | string | number;
		k: string;
		v?: unknown;
	}

	let docs: Collection<ArrayDoc>;

	beforeEach(async () => {
		docs = ctx.db.collection<ArrayDoc>("array_ranges");
		try {
			await docs.deleteMany({});
		} catch {
			// ignore
		}
	});

	const MIXED = [
		1,
		10,
		"x",
		null,
		true,
		20,
		7.5,
		new Date(5000),
		[7, 8],
		{ a: 9 },
	];

	const afterUpdate = async (
		v: unknown,
		update: Record<string, unknown>,
		options?: Record<string, unknown>,
	) => {
		// Each call starts clean: a test may make several, and `findOne` would
		// otherwise hand back the first document it left behind.
		await docs.deleteMany({});
		await docs.insertOne({ k: "a", v });
		await docs.updateOne({ k: "a" }, update as never, options as never);
		return (await docs.findOne({ k: "a" }))?.v;
	};

	const pulled = (v: unknown, condition: Record<string, unknown>) =>
		afterUpdate(v, { $pull: { v: condition } });

	describe("$pull of an element", () => {
		const CASES: [string, Record<string, unknown>, unknown[]][] = [
			["$gt 5", { $gt: 5 }, [1, "x", null, true, new Date(5000), { a: 9 }]],
			[
				"$gte 10",
				{ $gte: 10 },
				[1, "x", null, true, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				"$lt 5",
				{ $lt: 5 },
				[10, "x", null, true, 20, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				"$lte 1",
				{ $lte: 1 },
				[10, "x", null, true, 20, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				'$gt "a"',
				{ $gt: "a" },
				[1, 10, null, true, 20, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				'$lt "z"',
				{ $lt: "z" },
				[1, 10, null, true, 20, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				"$gte true",
				{ $gte: true },
				[1, 10, "x", null, 20, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				"$lte true",
				{ $lte: true },
				[1, 10, "x", null, 20, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				"$gt Date(1)",
				{ $gt: new Date(1) },
				[1, 10, "x", null, true, 20, 7.5, [7, 8], { a: 9 }],
			],
			[
				"$lt Date(9999)",
				{ $lt: new Date(9999) },
				[1, 10, "x", null, true, 20, 7.5, [7, 8], { a: 9 }],
			],
			[
				"$gt null",
				{ $gt: null },
				[1, 10, "x", null, true, 20, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				"$gte null",
				{ $gte: null },
				[1, 10, "x", true, 20, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				"$lt null",
				{ $lt: null },
				[1, 10, "x", null, true, 20, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				"$lte null",
				{ $lte: null },
				[1, 10, "x", true, 20, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				"$gt 5 $lt 15",
				{ $gt: 5, $lt: 15 },
				[1, "x", null, true, 20, new Date(5000), { a: 9 }],
			],
		];

		for (const [label, condition, expected] of CASES) {
			test(label, async () => {
				expect(await pulled(MIXED, condition)).toEqual(expected);
			});
		}

		test("an element that is an array matches when any of its elements does", async () => {
			expect(await pulled([[7, 8], [1], 6], { $gt: 5 })).toEqual([[1]]);
			expect(await pulled([[7, 8], [1], 6], { $lt: 5 })).toEqual([[7, 8], 6]);
		});

		test("a NaN element is in no range, and equals a NaN operand", async () => {
			const withNaN = () => [1, Number.NaN, 7, "x"];
			expect(await pulled(withNaN(), { $gte: Number.NaN })).toEqual([
				1,
				7,
				"x",
			]);
			expect(await pulled(withNaN(), { $gt: 5 })).toEqual([1, Number.NaN, "x"]);
			expect(await pulled(withNaN(), { $lt: 5 })).toEqual([Number.NaN, 7, "x"]);
			expect(await pulled(withNaN(), { $gt: Number.NaN })).toEqual(withNaN());
		});

		test("an ObjectId is its own bracket", async () => {
			const oid = (hex: string) => new ObjectId(hex);
			const v = [
				oid("000000000000000000000001"),
				oid("000000000000000000000005"),
				"000000000000000000000009",
				5,
			];
			const hexes = (list: unknown) =>
				(list as unknown[]).map((item) =>
					item instanceof ObjectId ? item.toHexString() : item,
				);
			expect(
				hexes(await pulled(v, { $gt: oid("000000000000000000000001") })),
			).toEqual(["000000000000000000000001", "000000000000000000000009", 5]);
			expect(
				hexes(await pulled(v, { $lte: oid("000000000000000000000005") })),
			).toEqual(["000000000000000000000009", 5]);
		});

		test("a missing array is left missing", async () => {
			await docs.insertOne({ k: "a" });
			await docs.updateOne({ k: "a" }, { $pull: { v: { $gt: 5 } } } as never);
			expect((await docs.findOne({ k: "a" }))?.v).toBeUndefined();
		});

		test("an array or an embedded document operand is refused, and nothing is changed", async () => {
			await docs.insertOne({ k: "a", v: [1, 10] });
			await expect(
				(async () =>
					docs.updateOne({ k: "a" }, {
						$pull: { v: { $gt: [1] } },
					} as never))(),
			).rejects.toThrow(MongoCompatibilityError);
			await expect(
				(async () =>
					docs.updateOne({ k: "a" }, {
						$pull: { v: { $lt: { a: 1 } } },
					} as never))(),
			).rejects.toThrow("$lt with an embedded document operand");
			expect((await docs.findOne({ k: "a" }))?.v).toEqual([1, 10]);
		});
	});

	describe("$pull of a sub-document by a condition on one of its fields", () => {
		const DOCS = [
			{ p: 1 },
			{ p: 9 },
			{ p: "9" },
			{ p: [1, 9] },
			{ p: [1, 2] },
			{ q: 1 },
			{ p: null },
			{ p: true },
		];
		const CASES: [string, Record<string, unknown>, unknown[]][] = [
			[
				"p $gt 5",
				{ p: { $gt: 5 } },
				[
					{ p: 1 },
					{ p: "9" },
					{ p: [1, 2] },
					{ q: 1 },
					{ p: null },
					{ p: true },
				],
			],
			[
				"p $lt 5",
				{ p: { $lt: 5 } },
				[{ p: 9 }, { p: "9" }, { q: 1 }, { p: null }, { p: true }],
			],
			[
				'p $gt "5"',
				{ p: { $gt: "5" } },
				[
					{ p: 1 },
					{ p: 9 },
					{ p: [1, 9] },
					{ p: [1, 2] },
					{ q: 1 },
					{ p: null },
					{ p: true },
				],
			],
			[
				"p $gte null",
				{ p: { $gte: null } },
				[
					{ p: 1 },
					{ p: 9 },
					{ p: "9" },
					{ p: [1, 9] },
					{ p: [1, 2] },
					{ p: true },
				],
			],
			[
				"p $lte 1",
				{ p: { $lte: 1 } },
				[{ p: 9 }, { p: "9" }, { q: 1 }, { p: null }, { p: true }],
			],
			[
				"p $gt 0 $lt 3",
				{ p: { $gt: 0, $lt: 3 } },
				[{ p: 9 }, { p: "9" }, { q: 1 }, { p: null }, { p: true }],
			],
		];

		for (const [label, condition, expected] of CASES) {
			test(label, async () => {
				expect(await pulled(DOCS, condition)).toEqual(expected);
			});
		}
	});

	describe("arrayFilters on a field of the element", () => {
		const SCORES = [
			{ score: 95 },
			{ score: 50 },
			{ score: "90" },
			{ score: null },
			{ x: 1 },
			{ score: [95, 10] },
			{ score: [5, 6] },
			{ score: true },
			{ score: new Date(5000) },
		];
		const CASES: [string, Record<string, unknown>, unknown[]][] = [
			[
				"$gte 90",
				{ $gte: 90 },
				[
					{ flag: true, score: 95 },
					{ score: 50 },
					{ score: "90" },
					{ score: null },
					{ x: 1 },
					{ flag: true, score: [95, 10] },
					{ score: [5, 6] },
					{ score: true },
					{ score: new Date(5000) },
				],
			],
			[
				"$gt 5",
				{ $gt: 5 },
				[
					{ flag: true, score: 95 },
					{ flag: true, score: 50 },
					{ score: "90" },
					{ score: null },
					{ x: 1 },
					{ flag: true, score: [95, 10] },
					{ flag: true, score: [5, 6] },
					{ score: true },
					{ score: new Date(5000) },
				],
			],
			[
				"$lt 60",
				{ $lt: 60 },
				[
					{ score: 95 },
					{ flag: true, score: 50 },
					{ score: "90" },
					{ score: null },
					{ x: 1 },
					{ flag: true, score: [95, 10] },
					{ flag: true, score: [5, 6] },
					{ score: true },
					{ score: new Date(5000) },
				],
			],
			[
				"$lte 5",
				{ $lte: 5 },
				[
					{ score: 95 },
					{ score: 50 },
					{ score: "90" },
					{ score: null },
					{ x: 1 },
					{ score: [95, 10] },
					{ flag: true, score: [5, 6] },
					{ score: true },
					{ score: new Date(5000) },
				],
			],
			[
				'$gt "8"',
				{ $gt: "8" },
				[
					{ score: 95 },
					{ score: 50 },
					{ flag: true, score: "90" },
					{ score: null },
					{ x: 1 },
					{ score: [95, 10] },
					{ score: [5, 6] },
					{ score: true },
					{ score: new Date(5000) },
				],
			],
			[
				"$gte true",
				{ $gte: true },
				[
					{ score: 95 },
					{ score: 50 },
					{ score: "90" },
					{ score: null },
					{ x: 1 },
					{ score: [95, 10] },
					{ score: [5, 6] },
					{ flag: true, score: true },
					{ score: new Date(5000) },
				],
			],
			[
				"$gt Date(1)",
				{ $gt: new Date(1) },
				[
					{ score: 95 },
					{ score: 50 },
					{ score: "90" },
					{ score: null },
					{ x: 1 },
					{ score: [95, 10] },
					{ score: [5, 6] },
					{ score: true },
					{ flag: true, score: new Date(5000) },
				],
			],
			[
				"$gte null",
				{ $gte: null },
				[
					{ score: 95 },
					{ score: 50 },
					{ score: "90" },
					{ flag: true, score: null },
					{ flag: true, x: 1 },
					{ score: [95, 10] },
					{ score: [5, 6] },
					{ score: true },
					{ score: new Date(5000) },
				],
			],
			[
				"$lte null",
				{ $lte: null },
				[
					{ score: 95 },
					{ score: 50 },
					{ score: "90" },
					{ flag: true, score: null },
					{ flag: true, x: 1 },
					{ score: [95, 10] },
					{ score: [5, 6] },
					{ score: true },
					{ score: new Date(5000) },
				],
			],
			[
				"$gt null",
				{ $gt: null },
				[
					{ score: 95 },
					{ score: 50 },
					{ score: "90" },
					{ score: null },
					{ x: 1 },
					{ score: [95, 10] },
					{ score: [5, 6] },
					{ score: true },
					{ score: new Date(5000) },
				],
			],
			[
				"$gte 50 $lt 96",
				{ $gte: 50, $lt: 96 },
				[
					{ flag: true, score: 95 },
					{ flag: true, score: 50 },
					{ score: "90" },
					{ score: null },
					{ x: 1 },
					{ flag: true, score: [95, 10] },
					{ score: [5, 6] },
					{ score: true },
					{ score: new Date(5000) },
				],
			],
		];

		for (const [label, condition, expected] of CASES) {
			test(`flags the elements whose score is ${label}`, async () => {
				expect(
					await afterUpdate(
						SCORES,
						{ $set: { "v.$[e].flag": true } },
						{ arrayFilters: [{ "e.score": condition }] },
					),
				).toEqual(expected);
			});
		}

		test("a nested path on the element, one of which is a scalar", async () => {
			const v = [{ a: { b: 1 } }, { a: { b: 9 } }, { a: { b: "1" } }, { a: 1 }];
			expect(
				await afterUpdate(
					v,
					{ $set: { "v.$[e].flag": true } },
					{ arrayFilters: [{ "e.a.b": { $lt: 5 } }] },
				),
			).toEqual([
				{ a: { b: 1 }, flag: true },
				{ a: { b: 9 } },
				{ a: { b: "1" } },
				{ a: 1 },
			]);
		});

		test("an array or an embedded document operand is refused, and nothing is changed", async () => {
			await docs.insertOne({ k: "a", v: [{ score: 1 }] });
			await expect(
				(async () =>
					docs.updateOne(
						{ k: "a" },
						{ $set: { "v.$[e].flag": true } } as never,
						{
							arrayFilters: [{ "e.score": { $gt: [1] } }],
						},
					))(),
			).rejects.toThrow(MongoCompatibilityError);
			expect((await docs.findOne({ k: "a" }))?.v).toEqual([{ score: 1 }]);
		});
	});

	describe("every way of running an update reads them the same way", () => {
		const MIXED = [1, 10, "x", null, true, 20];

		test("updateMany", async () => {
			await docs.insertMany([
				{ k: "a", v: MIXED },
				{ k: "b", v: [3, "y", 8] },
			]);
			const result = await docs.updateMany({}, {
				$pull: { v: { $gt: 5 } },
			} as never);
			expect(result.modifiedCount).toBe(2);
			expect((await docs.findOne({ k: "a" }))?.v).toEqual([1, "x", null, true]);
			expect((await docs.findOne({ k: "b" }))?.v).toEqual([3, "y"]);
		});

		test("findOneAndUpdate, with a pull and with arrayFilters", async () => {
			await docs.insertOne({ k: "a", v: MIXED });
			const pulled = await docs.findOneAndUpdate(
				{ k: "a" },
				{ $pull: { v: { $lt: 5 } } } as never,
				{ returnDocument: "after" },
			);
			expect(pulled?.v).toEqual([10, "x", null, true, 20]);

			await docs.deleteMany({});
			await docs.insertOne({
				k: "b",
				v: [{ score: 95 }, { score: "90" }, { score: 50 }],
			});
			const flagged = await docs.findOneAndUpdate(
				{ k: "b" },
				{ $set: { "v.$[e].flag": true } } as never,
				{
					arrayFilters: [{ "e.score": { $gte: 90 } }],
					returnDocument: "after",
				},
			);
			expect(flagged?.v).toEqual([
				{ score: 95, flag: true },
				{ score: "90" },
				{ score: 50 },
			]);
		});

		test("bulkWrite", async () => {
			await docs.insertOne({ k: "a", v: MIXED });
			await docs.bulkWrite([
				{
					updateOne: {
						filter: { k: "a" },
						update: { $pull: { v: { $gte: 10 } } } as never,
					},
				},
			]);
			expect((await docs.findOne({ k: "a" }))?.v).toEqual([1, "x", null, true]);
		});

		test("an upsert that inserts", async () => {
			const result = await docs.updateOne(
				{ k: "new" },
				{ $pull: { v: { $gt: 5 } }, $set: { seen: true } } as never,
				{ upsert: true },
			);
			expect(result.upsertedCount).toBe(1);
			expect((await docs.findOne({ k: "new" }))?.seen).toBe(true);
		});
	});

	describe("the other operators of the same vocabulary are unchanged", () => {
		test("$pull with $eq, $ne, $in and $nin", async () => {
			expect(await pulled(MIXED, { $eq: 7.5 })).toEqual(
				MIXED.filter((x) => x !== 7.5),
			);
			expect(await pulled([1, 2, 3], { $ne: 1 })).toEqual([1]);
			expect(await pulled([1, 2, 3], { $in: [1, 3] })).toEqual([2]);
			expect(await pulled([1, 2, 3], { $nin: [1, 3] })).toEqual([1, 3]);
		});
	});
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
