/**
 * Driver-agnostic E2E scenarios.
 *
 * The scenarios below only ever touch the `MongoLikeClient` contract, so
 * the exact same `describe` block is reused for the official MongoDB
 * driver and for `@surrealdb/mql`. Adding a new scenario means appending
 * a `test()` here — no provider edits needed (Open/Closed).
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { ObjectId } from "mongodb";
import type {
	MongoLikeClient,
	MongoLikeCollection,
	MongoLikeDb,
	MongoLikeFilter,
} from "../contracts/mongo-like.ts";
import type { DatabaseProvider } from "../providers/database-provider.ts";

interface UserDoc {
	[key: string]: unknown;
	_id?: unknown;
	name: string;
	age: number;
	email?: string;
	tags?: string[];
	active?: boolean;
}

const COLLECTION_NAME = "users";

/**
 * Register the parity test cases against `provider`. The provider is
 * brought up once per file (`beforeAll`) and torn down at the end
 * (`afterAll`); each test starts from an empty collection.
 */
export function registerCrudScenarios(provider: DatabaseProvider): void {
	describe(`E2E parity – ${provider.name}`, () => {
		let client: MongoLikeClient;
		let db: MongoLikeDb;
		let users: MongoLikeCollection<UserDoc>;

		beforeAll(async () => {
			client = await provider.start();
			db = client.db();
		}, 120_000);

		afterAll(async () => {
			await provider.stop();
		}, 30_000);

		beforeEach(async () => {
			users = db.collection<UserDoc>(COLLECTION_NAME);
			try {
				await users.deleteMany({});
			} catch {
				// Some engines throw on missing tables; ignore.
			}
		});

		// -----------------------------------------------------------------
		// INSERT
		// -----------------------------------------------------------------

		describe("what an update counts as modified", () => {
			// `matchedCount` and `modifiedCount` are different numbers, and this
			// driver reported them as the same one until the bulkWrite parity
			// scenarios put the question to a real mongod.
			test("a $set to the value already there matches but does not modify", async () => {
				await users.insertOne({ name: "Alice", age: 30 });
				const result = await users.updateOne(
					{ name: "Alice" },
					{ $set: { age: 30 } },
				);
				expect(result.matchedCount).toBe(1);
				expect(result.modifiedCount).toBe(0);
			});

			test("a $set to a new value modifies", async () => {
				await users.insertOne({ name: "Alice", age: 30 });
				const result = await users.updateOne(
					{ name: "Alice" },
					{ $set: { age: 31 } },
				);
				expect(result.matchedCount).toBe(1);
				expect(result.modifiedCount).toBe(1);
			});

			test("updateMany counts only the documents it changed", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 31 },
				]);
				const result = await users.updateMany({}, { $set: { age: 30 } });
				expect(result.matchedCount).toBe(2);
				expect(result.modifiedCount).toBe(1);
			});

			test("a replace counts as modified even when the content is identical", async () => {
				// Measured, and not what the $set rule above would predict: MongoDB
				// compares values for an update operator and does not for a
				// whole-document replace. Asserting it of both drivers is what stops
				// the asymmetry being tidied away into a consistency that is wrong.
				await users.insertOne({ name: "Alice", age: 30 });
				const result = await users.replaceOne(
					{ name: "Alice" },
					{ name: "Alice", age: 30 },
				);
				expect(result.matchedCount).toBe(1);
				expect(result.modifiedCount).toBe(1);
			});
		});

		describe("insert", () => {
			test("insertOne acknowledges and returns an id", async () => {
				const result = await users.insertOne({ name: "Alice", age: 30 });
				expect(result.acknowledged).toBe(true);
				expect(result.insertedId).toBeDefined();
			});

			test("insertMany returns the right count", async () => {
				const result = await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
					{ name: "Charlie", age: 35 },
				]);
				expect(result.acknowledged).toBe(true);
				expect(result.insertedCount).toBe(3);
				expect(Object.keys(result.insertedIds)).toHaveLength(3);
			});

			test("a Date before 1970 round-trips to the millisecond", async () => {
				// A fractional second before the epoch used to hang the insert on this
				// driver: the SDK encoded `new Date(-1)` with negative nanoseconds,
				// which SurrealDB cannot decode and does not answer. MongoDB stores the
				// instant as an int64 of milliseconds, so it has no such edge.
				const instants = [
					new Date(-1),
					new Date("1969-12-31T23:59:59.000Z"),
					new Date("1960-06-15T12:30:45.123Z"),
					new Date("0001-01-01T00:00:00.000Z"),
				];
				for (const [i, when] of instants.entries()) {
					await users.insertOne({ name: `d${i}`, age: i, when });
				}
				const found = await users.find({}).sort({ age: 1 }).toArray();
				expect(found.map((doc) => (doc.when as Date).getTime())).toEqual(
					instants.map((d) => d.getTime()),
				);
			});
		});

		// -----------------------------------------------------------------
		// FIND
		// -----------------------------------------------------------------

		describe("find", () => {
			test("findOne returns null when nothing matches", async () => {
				const found = await users.findOne({ name: "Nobody" });
				expect(found).toBeNull();
			});

			test("findOne retrieves an inserted document", async () => {
				await users.insertOne({ name: "Alice", age: 30 });
				const found = await users.findOne({ name: "Alice" });
				expect(found).not.toBeNull();
				expect(found?.name).toBe("Alice");
				expect(found?.age).toBe(30);
			});

			test("find().toArray returns all matches", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
					{ name: "Charlie", age: 35 },
				]);
				const all = await users.find({}).toArray();
				expect(all).toHaveLength(3);
				const names = all.map((d) => d.name).sort();
				expect(names).toEqual(["Alice", "Bob", "Charlie"]);
			});

			test("find with $gt comparison filter", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
					{ name: "Charlie", age: 35 },
				]);
				const adults = await users.find({ age: { $gt: 28 } }).toArray();
				expect(adults).toHaveLength(2);
				const names = adults.map((d) => d.name).sort();
				expect(names).toEqual(["Alice", "Charlie"]);
			});

			test("find with $in filter", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
					{ name: "Charlie", age: 35 },
				]);
				const subset = await users
					.find({ name: { $in: ["Alice", "Charlie"] } })
					.toArray();
				expect(subset).toHaveLength(2);
			});

			test("find().sort().limit().skip() chain", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
					{ name: "Charlie", age: 35 },
					{ name: "Diana", age: 28 },
				]);
				const page = await users
					.find({})
					.sort({ age: 1 })
					.skip(1)
					.limit(2)
					.toArray();
				expect(page.map((d) => d.name)).toEqual(["Diana", "Alice"]);
			});

			test("$or filter combines clauses", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
					{ name: "Charlie", age: 35 },
				]);
				const matches = await users
					.find({ $or: [{ name: "Alice" }, { age: { $gt: 32 } }] })
					.toArray();
				expect(matches).toHaveLength(2);
				const names = matches.map((d) => d.name).sort();
				expect(names).toEqual(["Alice", "Charlie"]);
			});
		});

		// -----------------------------------------------------------------
		// RANGE OPERATORS
		// -----------------------------------------------------------------

		describe("range operators", () => {
			// MongoDB does not rank values of different types against each other. A
			// range comparison matches only values in the same BSON type bracket as
			// its operand — numbers with numbers, strings with strings, dates with
			// dates — and never a missing field, whatever SurrealDB's own total order
			// would say. Every expectation below is what a real `mongod` returns, which
			// is what makes the fixture worth having: it holds one document of each
			// type, so an operator that over-matches shows up as a wrong set rather
			// than a wrong count. No scenario existed before with a mixed-type or
			// missing field on a range operator, which is how `{age: {$lt: 30}}`
			// returning every person with no `age` went unnoticed.

			interface RangeDoc {
				[key: string]: unknown;
				_id?: unknown;
				k: string;
				v?: unknown;
			}

			let docs: MongoLikeCollection<RangeDoc>;

			const keys = async (filter: MongoLikeFilter) =>
				(await docs.find(filter).toArray()).map((doc) => doc.k).sort();

			const show = (operand: unknown): string => {
				if (operand instanceof Date) return `new Date(${operand.getTime()})`;
				if (typeof operand === "number") return String(operand);
				return JSON.stringify(operand);
			};

			beforeEach(async () => {
				docs = db.collection<RangeDoc>("range_brackets");
				try {
					await docs.deleteMany({});
				} catch {
					// Some engines throw on missing tables; ignore.
				}
			});

			describe("over one document of each type", () => {
				beforeEach(async () => {
					await docs.insertMany([
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
				});

				const EXPECTED: Record<string, [unknown, string[]][]> = {
					$gt: [
						[5, ["arr", "num10"]],
						[1, ["arr", "num10"]],
						[10, []],
						[7.5, ["arr", "num10"]],
						[Number.NEGATIVE_INFINITY, ["arr", "num1", "num10"]],
						["abc", []],
						["a", ["str"]],
						["z", []],
						["", ["str"]],
						[true, []],
						[false, ["bool"]],
						[new Date(5000), []],
						[new Date(1), ["date"]],
						[new Date(6000), []],
						[null, []],
						[Number.NaN, []],
					],
					$gte: [
						[5, ["arr", "num10"]],
						[1, ["arr", "num1", "num10"]],
						[10, ["num10"]],
						[7.5, ["arr", "num10"]],
						[Number.NEGATIVE_INFINITY, ["arr", "num1", "num10"]],
						["abc", ["str"]],
						["a", ["str"]],
						["z", []],
						["", ["str"]],
						[true, ["bool"]],
						[false, ["bool"]],
						[new Date(5000), ["date"]],
						[new Date(1), ["date"]],
						[new Date(6000), []],
						[null, ["missing", "null"]],
						[Number.NaN, []],
					],
					$lt: [
						[5, ["num1"]],
						[1, []],
						[10, ["arr", "num1"]],
						[7.5, ["arr", "num1"]],
						[Number.NEGATIVE_INFINITY, []],
						["abc", []],
						["a", []],
						["z", ["str"]],
						["", []],
						[true, []],
						[false, []],
						[new Date(5000), []],
						[new Date(1), []],
						[new Date(6000), ["date"]],
						[null, []],
						[Number.NaN, []],
					],
					$lte: [
						[5, ["num1"]],
						[1, ["num1"]],
						[10, ["arr", "num1", "num10"]],
						[7.5, ["arr", "num1"]],
						[Number.NEGATIVE_INFINITY, []],
						["abc", ["str"]],
						["a", []],
						["z", ["str"]],
						["", []],
						[true, ["bool"]],
						[false, []],
						[new Date(5000), ["date"]],
						[new Date(1), []],
						[new Date(6000), ["date"]],
						[null, ["missing", "null"]],
						[Number.NaN, []],
					],
				};

				for (const [operator, cases] of Object.entries(EXPECTED)) {
					describe(operator, () => {
						for (const [operand, expected] of cases) {
							test(`${show(operand)} matches ${expected.length === 0 ? "nothing" : expected.join(", ")}`, async () => {
								expect(await keys({ v: { [operator]: operand } })).toEqual(
									expected,
								);
							});
						}
					});
				}

				test("an undefined operand is null, as the official driver serialises it", async () => {
					expect(await keys({ v: { $gt: undefined } })).toEqual([]);
					expect(await keys({ v: { $gte: undefined } })).toEqual([
						"missing",
						"null",
					]);
				});

				test("two operators on one field bracket together", async () => {
					expect(await keys({ v: { $gte: 1, $lte: 10 } })).toEqual([
						"arr",
						"num1",
						"num10",
					]);
					// `[7, 8]` matches: 8 satisfies `$gt: 7` and 7 satisfies `$lt: 8`. Two
					// operators on an array need not be met by the same element.
					expect(await keys({ v: { $gt: 7, $lt: 8 } })).toEqual(["arr"]);
				});

				test("$not of a range also matches what the range skips by type", async () => {
					expect(await keys({ v: { $not: { $gt: 5 } } })).toEqual([
						"bool",
						"date",
						"missing",
						"null",
						"num1",
						"obj",
						"str",
					]);
				});

				test("$nor of both ends of the number bracket leaves every other type", async () => {
					expect(
						await keys({ $nor: [{ v: { $lt: 5 } }, { v: { $gt: 5 } }] }),
					).toEqual(["bool", "date", "missing", "null", "obj", "str"]);
				});

				test("countDocuments and an aggregation $match agree with find", async () => {
					expect(await docs.countDocuments({ v: { $lt: 5 } })).toBe(1);
					const matched = await docs
						.aggregate<RangeDoc>([{ $match: { v: { $lt: 5 } } }])
						.toArray();
					expect(matched.map((doc) => doc.k)).toEqual(["num1"]);
				});
			});

			describe("over a grouped _id", () => {
				// After `$group`, `_id` is the group key and not a record identity, so a
				// key of one type must not match a range of another.
				beforeEach(async () => {
					await docs.insertMany([
						{ k: "n1", g: 1 },
						{ k: "n9", g: 9 },
						{ k: "s", g: "a" },
						{ k: "b", g: true },
					]);
				});

				const groupedKeys = async (range: MongoLikeFilter) =>
					(
						await docs
							.aggregate<RangeDoc>([
								{ $group: { _id: "$g", n: { $sum: 1 } } },
								{ $match: { _id: range } },
							])
							.toArray()
					)
						.map((doc) => doc._id)
						.sort();

				test("a number range keeps the numbers", async () => {
					expect(await groupedKeys({ $lt: 5 })).toEqual([1]);
					expect(await groupedKeys({ $gt: 5 })).toEqual([9]);
				});

				test("a string range keeps the strings", async () => {
					expect(await groupedKeys({ $gte: "a" })).toEqual(["a"]);
				});
			});

			describe("over arrays", () => {
				beforeEach(async () => {
					await docs.insertMany([
						{ k: "arrLow", v: [1, 2] },
						{ k: "arrHigh", v: [7, 8] },
						{ k: "arrBoth", v: [1, 9] },
						{ k: "arrMixed", v: [1, "x"] },
						{ k: "arrNested", v: [[7, 8]] },
						{ k: "arrEmpty", v: [] },
						{ k: "num", v: 6 },
					]);
				});

				test("a field matches when any element is in range", async () => {
					expect(await keys({ v: { $gt: 5 } })).toEqual([
						"arrBoth",
						"arrHigh",
						"num",
					]);
					expect(await keys({ v: { $lt: 5 } })).toEqual([
						"arrBoth",
						"arrLow",
						"arrMixed",
					]);
				});

				test("an element of another type is not in the bracket", async () => {
					expect(await keys({ v: { $gt: "a" } })).toEqual(["arrMixed"]);
				});

				test("an array inside an array is not searched", async () => {
					// `[[7, 8]]` has one element, and it is an array.
					expect(await keys({ v: { $gte: 7 } })).toEqual([
						"arrBoth",
						"arrHigh",
					]);
				});

				test("two operators may be satisfied by different elements", async () => {
					expect(await keys({ v: { $gt: 2, $lt: 5 } })).toEqual(["arrBoth"]);
				});

				test("$elemMatch needs one element to satisfy them all", async () => {
					expect(await keys({ v: { $elemMatch: { $gt: 2, $lt: 5 } } })).toEqual(
						[],
					);
					expect(await keys({ v: { $elemMatch: { $gt: 5, $lt: 9 } } })).toEqual(
						["arrHigh"],
					);
				});
			});

			describe("over an array element addressed by index", () => {
				beforeEach(async () => {
					await docs.insertMany([
						{ k: "first", scores: [95, 10] },
						{ k: "second", scores: [10, 95] },
						{ k: "text", scores: ["95", 10] },
						{ k: "short", scores: [] },
					]);
				});

				test("the element is a value of its own", async () => {
					expect(await keys({ "scores.0": { $gt: 90 } })).toEqual(["first"]);
					expect(await keys({ "scores.0": { $lt: 20 } })).toEqual(["second"]);
				});
			});

			describe("over a path through an array of documents", () => {
				beforeEach(async () => {
					await docs.insertMany([
						{ k: "itemsHi", items: [{ price: 1 }, { price: 9 }] },
						{ k: "itemsLo", items: [{ price: 1 }] },
						{ k: "itemsObj", items: { price: 9 } },
						{ k: "itemsStr", items: [{ price: "9" }] },
						{ k: "noItems" },
					]);
				});

				test("any item in range matches", async () => {
					expect(await keys({ "items.price": { $gt: 5 } })).toEqual([
						"itemsHi",
						"itemsObj",
					]);
					expect(await keys({ "items.price": { $lt: 5 } })).toEqual([
						"itemsHi",
						"itemsLo",
					]);
				});

				test("a price of another type is skipped", async () => {
					expect(await keys({ "items.price": { $gt: "5" } })).toEqual([
						"itemsStr",
					]);
				});

				test("a sub-field condition inside $elemMatch is bracketed too", async () => {
					expect(
						await keys({ items: { $elemMatch: { price: { $gt: 5 } } } }),
					).toEqual(["itemsHi"]);
				});
			});

			describe("over ObjectIds", () => {
				// An ObjectId is its own bracket: a string of the same hex is not in it.
				beforeEach(async () => {
					await docs.insertMany([
						{ k: "oid1", ref: new ObjectId("000000000000000000000001") },
						{ k: "oid2", ref: new ObjectId("000000000000000000000002") },
						{ k: "oid3", ref: new ObjectId("0000000000000000000000ff") },
						{
							k: "oidArr",
							ref: [
								new ObjectId("000000000000000000000002"),
								new ObjectId("000000000000000000000003"),
							],
						},
						{ k: "oidStr", ref: "000000000000000000000002" },
					]);
				});

				test("$gt and $gte", async () => {
					expect(
						await keys({
							ref: { $gt: new ObjectId("000000000000000000000001") },
						}),
					).toEqual(["oid2", "oid3", "oidArr"]);
					expect(
						await keys({
							ref: { $gte: new ObjectId("000000000000000000000002") },
						}),
					).toEqual(["oid2", "oid3", "oidArr"]);
				});

				test("$lt and $lte", async () => {
					expect(
						await keys({
							ref: { $lt: new ObjectId("0000000000000000000000ff") },
						}),
					).toEqual(["oid1", "oid2", "oidArr"]);
					expect(
						await keys({
							ref: { $lte: new ObjectId("000000000000000000000002") },
						}),
					).toEqual(["oid1", "oid2", "oidArr"]);
				});

				test("a string operand does not reach an ObjectId", async () => {
					expect(
						await keys({ ref: { $gt: "000000000000000000000001" } }),
					).toEqual(["oidStr"]);
				});
			});
		});

		// -----------------------------------------------------------------
		// NULL EQUALITY AND ARRAYS
		// -----------------------------------------------------------------

		describe("null equality sees the elements of an array", () => {
			// `{f: null}` matches a null, a missing field, and — like any equality —
			// an array with a null element; `$ne: null` is exactly the rest. The
			// driver saw only the first two, so `[null]` and `[1, null]` were missed by
			// `{f: null}` and let through by `$ne: null`.

			interface NullDoc {
				[key: string]: unknown;
				_id?: unknown;
				k: string;
				v?: unknown;
			}

			let docs: MongoLikeCollection<NullDoc>;

			const keys = async (filter: MongoLikeFilter) =>
				(await docs.find(filter).toArray()).map((doc) => doc.k).sort();

			const WITH_NULL = ["arrMixed", "arrNull", "missing", "null"];
			const WITHOUT_NULL = [
				"arrEmpty",
				"arrNested",
				"arrNum",
				"num",
				"obj",
				"objArr",
			];

			beforeEach(async () => {
				docs = db.collection<NullDoc>("null_elements");
				try {
					await docs.deleteMany({});
				} catch {
					// Some engines throw on missing tables; ignore.
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

			test("{f: null} and $eq: null match an array holding a null", async () => {
				expect(await keys({ v: null })).toEqual(WITH_NULL);
				expect(await keys({ v: { $eq: null } })).toEqual(WITH_NULL);
			});

			test("$ne: null excludes an array holding a null", async () => {
				expect(await keys({ v: { $ne: null } })).toEqual(WITHOUT_NULL);
			});

			test("$not and $nor negate the whole predicate", async () => {
				expect(await keys({ v: { $not: { $eq: null } } })).toEqual(
					WITHOUT_NULL,
				);
				expect(await keys({ v: { $not: { $ne: null } } })).toEqual(WITH_NULL);
				expect(await keys({ $nor: [{ v: null }] })).toEqual(WITHOUT_NULL);
			});

			test("$gte: null and $lte: null are the same equality", async () => {
				expect(await keys({ v: { $gte: null } })).toEqual(WITH_NULL);
				expect(await keys({ v: { $lte: null } })).toEqual(WITH_NULL);
			});

			test("$in and $nin of null agree with it", async () => {
				expect(await keys({ v: { $in: [null] } })).toEqual(WITH_NULL);
				expect(await keys({ v: { $nin: [null] } })).toEqual(WITHOUT_NULL);
			});

			test("an array inside an array is not searched", async () => {
				expect(await keys({ v: null })).not.toContain("arrNested");
			});

			test("an $elemMatch element is a value, not an array to look inside", async () => {
				expect(await keys({ v: { $elemMatch: { $eq: null } } })).toEqual([
					"arrMixed",
					"arrNull",
				]);
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

			test("countDocuments and an aggregation $match agree with find", async () => {
				expect(await docs.countDocuments({ v: null })).toBe(4);
				expect(await docs.countDocuments({ v: { $ne: null } })).toBe(6);
				const matched = await docs
					.aggregate<NullDoc>([{ $match: { v: { $ne: null } } }])
					.toArray();
				expect(matched.map((doc) => doc.k).sort()).toEqual(WITHOUT_NULL);
			});
		});

		// -----------------------------------------------------------------
		// ORDERING OPERATORS IN $pull AND arrayFilters
		// -----------------------------------------------------------------

		describe("ordering operators in $pull and arrayFilters", () => {
			// A `$pull` condition and an `arrayFilters` entry are query predicates
			// applied to an array element, so they match within one BSON type as a
			// filter's do, and an element that is itself an array matches when any of
			// its own elements does. As a bare `>` they removed the string "x" for
			// `{$pull: {v: {$gt: 5}}}`, because SurrealQL ranks every string above every
			// number. Every expectation is what a real `mongod` leaves in the array.

			interface ArrayDoc {
				[key: string]: unknown;
				_id?: unknown;
				k: string;
				v?: unknown;
			}

			let docs: MongoLikeCollection<ArrayDoc>;

			beforeEach(async () => {
				docs = db.collection<ArrayDoc>("array_ranges");
				try {
					await docs.deleteMany({});
				} catch {
					// Some engines throw on missing tables; ignore.
				}
			});

			const afterUpdate = async (
				v: unknown,
				update: MongoLikeFilter,
				options?: { arrayFilters?: MongoLikeFilter[] },
			) => {
				await docs.deleteMany({});
				await docs.insertOne({ k: "a", v });
				await docs.updateOne({ k: "a" }, update, options);
				return (await docs.findOne({ k: "a" }))?.v;
			};

			const pulled = (v: unknown, condition: MongoLikeFilter) =>
				afterUpdate(v, { $pull: { v: condition } });

			describe("$pull of an element", () => {
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
				const CASES: [string, MongoLikeFilter, unknown[]][] = [
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
					expect(await pulled([[7, 8], [1], 6], { $lt: 5 })).toEqual([
						[7, 8],
						6,
					]);
				});

				test("a NaN element is in no range, and equals a NaN operand", async () => {
					const withNaN = () => [1, Number.NaN, 7, "x"];
					expect(await pulled(withNaN(), { $gte: Number.NaN })).toEqual([
						1,
						7,
						"x",
					]);
					expect(await pulled(withNaN(), { $gt: 5 })).toEqual([
						1,
						Number.NaN,
						"x",
					]);
					expect(await pulled(withNaN(), { $lt: 5 })).toEqual([
						Number.NaN,
						7,
						"x",
					]);
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
							item instanceof Object && "toHexString" in item
								? (item as ObjectId).toHexString()
								: item,
						);
					expect(
						hexes(await pulled(v, { $gt: oid("000000000000000000000001") })),
					).toEqual([
						"000000000000000000000001",
						"000000000000000000000009",
						5,
					]);
					expect(
						hexes(await pulled(v, { $lte: oid("000000000000000000000005") })),
					).toEqual(["000000000000000000000009", 5]);
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
				const CASES: [string, MongoLikeFilter, unknown[]][] = [
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
				const CASES: [string, MongoLikeFilter, unknown[]][] = [
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
					const v = [
						{ a: { b: 1 } },
						{ a: { b: 9 } },
						{ a: { b: "1" } },
						{ a: 1 },
					];
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
			});
		});

		// -----------------------------------------------------------------
		// POSITIONAL UPDATES: $[] AND $[identifier]
		// -----------------------------------------------------------------

		describe("positional updates compute each element's new value from its own", () => {
			// Through the path expression `v[*].n` an update was written as, `v[*].n` is the
			// LIST of every element's `n`, so `$inc` appended to it and wrote the list
			// into each element, `$mul` failed outright, and `$push`, `$addToSet`,
			// `$pop`, `$pull`, `$min` and `$max` were wrong in the same way. Every
			// expectation is what a real `mongod` leaves in the array, or "error" where
			// it refuses.

			interface ArrayDoc {
				[key: string]: unknown;
				_id?: unknown;
				k: string;
				v?: unknown;
			}

			let docs: MongoLikeCollection<ArrayDoc>;

			beforeEach(async () => {
				docs = db.collection<ArrayDoc>("positional_updates");
				try {
					await docs.deleteMany({});
				} catch {
					// Some engines throw on missing tables; ignore.
				}
			});

			const run = async (
				doc: MongoLikeFilter,
				update: MongoLikeFilter,
				options?: { arrayFilters?: MongoLikeFilter[] } | null,
			) => {
				await docs.deleteMany({});
				await docs.insertOne({ k: "a", ...doc });
				const result = await docs.updateOne(
					{ k: "a" },
					update,
					options ?? undefined,
				);
				return { result, doc: await docs.findOne({ k: "a" }) };
			};

			const CASES: [
				string,
				MongoLikeFilter,
				MongoLikeFilter,
				{ arrayFilters?: MongoLikeFilter[] } | null,
				unknown,
			][] = [
				[
					"$[] $inc n",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $inc: { "v.$[].n": 1 } },
					null,
					[
						{ n: 1, s: 1, t: ["a"], u: 3 },
						{ n: 6, s: 2, t: ["b", "c"], u: 4 },
						{ n: 1, s: 3 },
					],
				],
				[
					"$[] $inc new field",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $inc: { "v.$[].z": 2 } },
					null,
					[
						{ n: 0, s: 1, t: ["a"], u: 3, z: 2 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4, z: 2 },
						{ s: 3, z: 2 },
					],
				],
				[
					"$[] $mul n",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $mul: { "v.$[].u": 2 } },
					null,
					[
						{ n: 0, s: 1, t: ["a"], u: 6 },
						{ n: 5, s: 2, t: ["b", "c"], u: 8 },
						{ s: 3, u: 0 },
					],
				],
				[
					"$[] $mul missing",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $mul: { "v.$[].z": 2 } },
					null,
					[
						{ n: 0, s: 1, t: ["a"], u: 3, z: 0 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4, z: 0 },
						{ s: 3, z: 0 },
					],
				],
				[
					"$[] $min n",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $min: { "v.$[].n": 3 } },
					null,
					[
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 3, s: 2, t: ["b", "c"], u: 4 },
						{ n: 3, s: 3 },
					],
				],
				[
					"$[] $max n",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $max: { "v.$[].n": 3 } },
					null,
					[
						{ n: 3, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ n: 3, s: 3 },
					],
				],
				[
					"$[] $set n",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $set: { "v.$[].n": 9 } },
					null,
					[
						{ n: 9, s: 1, t: ["a"], u: 3 },
						{ n: 9, s: 2, t: ["b", "c"], u: 4 },
						{ n: 9, s: 3 },
					],
				],
				[
					"$[] $unset n",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $unset: { "v.$[].n": "" } },
					null,
					[{ s: 1, t: ["a"], u: 3 }, { s: 2, t: ["b", "c"], u: 4 }, { s: 3 }],
				],
				[
					"$[] $push t",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $push: { "v.$[].t": "z" } },
					null,
					[
						{ n: 0, s: 1, t: ["a", "z"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c", "z"], u: 4 },
						{ s: 3, t: ["z"] },
					],
				],
				[
					"$[] $addToSet t",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $addToSet: { "v.$[].t": "a" } },
					null,
					[
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c", "a"], u: 4 },
						{ s: 3, t: ["a"] },
					],
				],
				[
					"$[] $addToSet t new",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $addToSet: { "v.$[].t": "q" } },
					null,
					[
						{ n: 0, s: 1, t: ["a", "q"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c", "q"], u: 4 },
						{ s: 3, t: ["q"] },
					],
				],
				[
					"$[] $pop t",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $pop: { "v.$[].t": 1 } },
					null,
					[
						{ n: 0, s: 1, t: [], u: 3 },
						{ n: 5, s: 2, t: ["b"], u: 4 },
						{ s: 3 },
					],
				],
				[
					"$[] $pull t",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $pull: { "v.$[].t": "a" } },
					null,
					[
						{ n: 0, s: 1, t: [], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				],
				[
					"$[] $pullAll t",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $pullAll: { "v.$[].t": ["a", "b"] } },
					null,
					[
						{ n: 0, s: 1, t: [], u: 3 },
						{ n: 5, s: 2, t: ["c"], u: 4 },
						{ s: 3 },
					],
				],
				[
					"$[] $rename n",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $rename: { "v.$[].n": "v.$[].m" } },
					null,
					"error",
				],
				[
					"$[e] $inc n",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $inc: { "v.$[e].n": 1 } },
					{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
					[
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 6, s: 2, t: ["b", "c"], u: 4 },
						{ n: 1, s: 3 },
					],
				],
				[
					"$[e] $inc new field",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $inc: { "v.$[e].z": 2 } },
					{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
					[
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4, z: 2 },
						{ s: 3, z: 2 },
					],
				],
				[
					"$[e] $mul u",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $mul: { "v.$[e].u": 2 } },
					{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
					[
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 8 },
						{ s: 3, u: 0 },
					],
				],
				[
					"$[e] $min n",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $min: { "v.$[e].n": 3 } },
					{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
					[
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 3, s: 2, t: ["b", "c"], u: 4 },
						{ n: 3, s: 3 },
					],
				],
				[
					"$[e] $max n",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $max: { "v.$[e].n": 3 } },
					{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
					[
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ n: 3, s: 3 },
					],
				],
				[
					"$[e] $set n",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $set: { "v.$[e].n": 9 } },
					{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
					[
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 9, s: 2, t: ["b", "c"], u: 4 },
						{ n: 9, s: 3 },
					],
				],
				[
					"$[e] $unset n",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $unset: { "v.$[e].n": "" } },
					{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
					[
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				],
				[
					"$[e] $push t",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $push: { "v.$[e].t": "z" } },
					{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
					[
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c", "z"], u: 4 },
						{ s: 3, t: ["z"] },
					],
				],
				[
					"$[e] $addToSet t",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $addToSet: { "v.$[e].t": "q" } },
					{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
					[
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c", "q"], u: 4 },
						{ s: 3, t: ["q"] },
					],
				],
				[
					"$[e] $pop t",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $pop: { "v.$[e].t": 1 } },
					{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
					[
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b"], u: 4 },
						{ s: 3 },
					],
				],
				[
					"$[e] $pull t",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $pull: { "v.$[e].t": "b" } },
					{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
					[
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["c"], u: 4 },
						{ s: 3 },
					],
				],
				[
					"$[e] $inc, filter matches none",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $inc: { "v.$[e].n": 1 } },
					{ arrayFilters: [{ "e.s": { $gt: 99 } }] },
					[
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				],
				[
					"$[e] $inc, filter matches all",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $inc: { "v.$[e].n": 1 } },
					{ arrayFilters: [{ "e.s": { $gte: 0 } }] },
					[
						{ n: 1, s: 1, t: ["a"], u: 3 },
						{ n: 6, s: 2, t: ["b", "c"], u: 4 },
						{ n: 1, s: 3 },
					],
				],
				[
					"$[e] $inc, equality filter",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $inc: { "v.$[e].n": 1 } },
					{ arrayFilters: [{ "e.s": 2 }] },
					[
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 6, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				],
				[
					"$[e] $inc, two conditions",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $inc: { "v.$[e].n": 1 } },
					{ arrayFilters: [{ "e.s": { $gte: 1 }, "e.u": { $lt: 4 } }] },
					[
						{ n: 1, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				],
				[
					"$[e] $inc, two ops one field",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $inc: { "v.$[e].n": 1, "v.$[e].u": 10 } },
					{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
					[
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 6, s: 2, t: ["b", "c"], u: 14 },
						{ n: 1, s: 3, u: 10 },
					],
				],
				[
					"$[e] $inc negative",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
					},
					{ $inc: { "v.$[e].n": -2 } },
					{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
					[
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 3, s: 2, t: ["b", "c"], u: 4 },
						{ n: -2, s: 3 },
					],
				],
				[
					"scalars $[] $inc",
					{ v: [1, 2, 3] },
					{ $inc: { "v.$[]": 1 } },
					null,
					[2, 3, 4],
				],
				[
					"scalars $[] $mul",
					{ v: [1, 2, 3] },
					{ $mul: { "v.$[]": 2 } },
					null,
					[2, 4, 6],
				],
				[
					"scalars $[] $min",
					{ v: [1, 5, 3] },
					{ $min: { "v.$[]": 3 } },
					null,
					[1, 3, 3],
				],
				[
					"scalars $[] $max",
					{ v: [1, 5, 3] },
					{ $max: { "v.$[]": 3 } },
					null,
					[3, 5, 3],
				],
				[
					"scalars $[] $set",
					{ v: [1, 2, 3] },
					{ $set: { "v.$[]": 0 } },
					null,
					[0, 0, 0],
				],
				["empty array $inc", { v: [] }, { $inc: { "v.$[].n": 1 } }, null, []],
				[
					"nested $[a].w.$[b].n $inc",
					{
						v: [
							{
								k: 1,
								w: [
									{ n: 0, s: 1 },
									{ n: 5, s: 2 },
								],
							},
							{ k: 2, w: [{ n: 7, s: 3 }] },
						],
					},
					{ $inc: { "v.$[a].w.$[b].n": 1 } },
					{ arrayFilters: [{ "a.k": 1 }, { "b.s": { $gte: 2 } }] },
					[
						{
							k: 1,
							w: [
								{ n: 0, s: 1 },
								{ n: 6, s: 2 },
							],
						},
						{ k: 2, w: [{ n: 7, s: 3 }] },
					],
				],
				[
					"nested $[].w.$[].n $inc",
					{
						v: [
							{
								k: 1,
								w: [
									{ n: 0, s: 1 },
									{ n: 5, s: 2 },
								],
							},
							{ k: 2, w: [{ n: 7, s: 3 }] },
						],
					},
					{ $inc: { "v.$[].w.$[].n": 1 } },
					null,
					[
						{
							k: 1,
							w: [
								{ n: 1, s: 1 },
								{ n: 6, s: 2 },
							],
						},
						{ k: 2, w: [{ n: 8, s: 3 }] },
					],
				],
				[
					"nested $[a].w.$[].n $inc",
					{
						v: [
							{
								k: 1,
								w: [
									{ n: 0, s: 1 },
									{ n: 5, s: 2 },
								],
							},
							{ k: 2, w: [{ n: 7, s: 3 }] },
						],
					},
					{ $inc: { "v.$[a].w.$[].n": 1 } },
					{ arrayFilters: [{ "a.k": 2 }] },
					[
						{
							k: 1,
							w: [
								{ n: 0, s: 1 },
								{ n: 5, s: 2 },
							],
						},
						{ k: 2, w: [{ n: 8, s: 3 }] },
					],
				],
				[
					"nested $[a].w.$[b].n $set",
					{
						v: [
							{
								k: 1,
								w: [
									{ n: 0, s: 1 },
									{ n: 5, s: 2 },
								],
							},
							{ k: 2, w: [{ n: 7, s: 3 }] },
						],
					},
					{ $set: { "v.$[a].w.$[b].n": 99 } },
					{ arrayFilters: [{ "a.k": 1 }, { "b.s": { $gte: 2 } }] },
					[
						{
							k: 1,
							w: [
								{ n: 0, s: 1 },
								{ n: 99, s: 2 },
							],
						},
						{ k: 2, w: [{ n: 7, s: 3 }] },
					],
				],
				[
					"$inc positional + plain",
					{
						v: [
							{ n: 0, s: 1, t: ["a"], u: 3 },
							{ n: 5, s: 2, t: ["b", "c"], u: 4 },
							{ s: 3 },
						],
						count: 0,
					},
					{ $inc: { "v.$[e].n": 1, count: 1 } },
					{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
					[
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 6, s: 2, t: ["b", "c"], u: 4 },
						{ n: 1, s: 3 },
					],
				],
				[
					"scalar elems + sub-path",
					{ v: [1, 2] },
					{ $inc: { "v.$[].n": 1 } },
					null,
					"error",
				],
				[
					"mixed elems + sub-path",
					{ v: [{ n: 1 }, 5] },
					{ $inc: { "v.$[].n": 1 } },
					null,
					"error",
				],
				[
					"$unset element itself",
					{ v: [1, 2] },
					{ $unset: { "v.$[]": "" } },
					null,
					[null, null],
				],
				[
					"$set element itself",
					{ v: [1, 2] },
					{ $set: { "v.$[]": { a: 1 } } },
					null,
					[{ a: 1 }, { a: 1 }],
				],
				[
					"conflict: $inc + $set same leaf",
					{ v: [{ n: 0, s: 1 }, { n: 5, s: 2 }, { s: 3 }] },
					{ $inc: { "v.$[].n": 1 }, $set: { "v.$[].n": 9 } },
					null,
					"error",
				],
				[
					"conflict: prefix",
					{ v: [{ a: { b: 1 } }] },
					{ $set: { "v.$[].a": 1 }, $inc: { "v.$[].a.b": 1 } },
					null,
					"error",
				],
				[
					"two identifiers one array",
					{ v: [{ n: 0, s: 1 }, { n: 5, s: 2 }, { s: 3 }] },
					{ $inc: { "v.$[a].n": 1, "v.$[b].s": 10 } },
					{ arrayFilters: [{ "a.s": 1 }, { "b.s": { $gte: 2 } }] },
					[{ n: 1, s: 1 }, { n: 5, s: 12 }, { s: 13 }],
				],
				[
					"$[] and $[e] one array",
					{ v: [{ n: 0, s: 1 }, { n: 5, s: 2 }, { s: 3 }] },
					{ $inc: { "v.$[].n": 1, "v.$[e].s": 10 } },
					{ arrayFilters: [{ "e.s": 1 }] },
					[
						{ n: 1, s: 11 },
						{ n: 6, s: 2 },
						{ n: 1, s: 3 },
					],
				],
				[
					"$inc + $set different leaves",
					{ v: [{ n: 0, s: 1 }, { n: 5, s: 2 }, { s: 3 }] },
					{ $inc: { "v.$[e].n": 1 }, $set: { "v.$[e].flag": true } },
					{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
					[
						{ n: 0, s: 1 },
						{ flag: true, n: 6, s: 2 },
						{ flag: true, n: 1, s: 3 },
					],
				],
				[
					"filter on the field being incremented",
					{ v: [{ n: 4 }, { n: 5 }, { n: 6 }] },
					{ $inc: { "v.$[e].n": 1, "v.$[e].m": 1 } },
					{ arrayFilters: [{ "e.n": { $lt: 6 } }] },
					[{ m: 1, n: 5 }, { m: 1, n: 6 }, { n: 6 }],
				],
				[
					"$inc deep new path ($[])",
					{ v: [{ s: 1 }, { a: { b: 1 } }] },
					{ $inc: { "v.$[].a.b": 2 } },
					null,
					[{ a: { b: 2 }, s: 1 }, { a: { b: 3 } }],
				],
				[
					"$push deep",
					{ v: [{ s: 1 }, { a: { t: [1] } }] },
					{ $push: { "v.$[].a.t": 9 } },
					null,
					[{ a: { t: [9] }, s: 1 }, { a: { t: [1, 9] } }],
				],
				[
					"$push $each $position",
					{ v: [{ t: [1, 2] }, {}] },
					{ $push: { "v.$[].t": { $each: [8, 9], $position: 1 } } },
					null,
					[{ t: [1, 8, 9, 2] }, { t: [8, 9] }],
				],
				[
					"$push $each $sort $slice",
					{ v: [{ t: [3, 1] }, {}] },
					{ $push: { "v.$[].t": { $each: [2, 5], $sort: 1, $slice: 3 } } },
					null,
					[{ t: [1, 2, 3] }, { t: [2, 5] }],
				],
				[
					"$addToSet $each",
					{ v: [{ t: [1] }, {}] },
					{ $addToSet: { "v.$[].t": { $each: [1, 2] } } },
					null,
					[{ t: [1, 2] }, { t: [1, 2] }],
				],
				[
					"$pull condition",
					{ v: [{ t: [1, 5, 9] }, { t: [2] }, {}] },
					{ $pull: { "v.$[].t": { $gt: 4 } } },
					null,
					[{ t: [1] }, { t: [2] }, {}],
				],
				[
					"$pull sub-doc condition",
					{ v: [{ t: [{ p: 1 }, { p: 9 }] }, {}] },
					{ $pull: { "v.$[].t": { p: { $gt: 4 } } } },
					null,
					[{ t: [{ p: 1 }] }, {}],
				],
				[
					"$rename dest positional",
					{ v: [{ a: 1 }] },
					{ $rename: { "v.0.a": "v.$[].b" } },
					null,
					"error",
				],
				[
					"$min/$max strings",
					{ v: [{ s: "b" }, { s: "d" }] },
					{ $min: { "v.$[].s": "c" } },
					null,
					[{ s: "b" }, { s: "c" }],
				],
				[
					"$mul float",
					{ v: [{ n: 2 }, { n: 3 }] },
					{ $mul: { "v.$[].n": 1.5 } },
					null,
					[{ n: 3 }, { n: 4.5 }],
				],
				[
					"$inc on string leaf",
					{ v: [{ n: "a" }] },
					{ $inc: { "v.$[].n": 1 } },
					null,
					"error",
				],
				[
					"$inc on null leaf",
					{ v: [{ n: null }] },
					{ $inc: { "v.$[].n": 1 } },
					null,
					"error",
				],
				[
					"index before marker",
					{ v: [{ w: [{ n: 1 }, { n: 2 }] }, { w: [{ n: 3 }] }] },
					{ $inc: { "v.0.w.$[].n": 1 } },
					null,
					[{ w: [{ n: 2 }, { n: 3 }] }, { w: [{ n: 3 }] }],
				],
				[
					"$unset deep, elements lack the parent",
					{ v: [{ s: 1 }, { a: { b: 1, c: 2 } }, { a: {} }] },
					{ $unset: { "v.$[].a.b": "" } },
					null,
					[{ s: 1 }, { a: { c: 2 } }, { a: {} }],
				],
				[
					"$unset deep, scalar parent",
					{ v: [{ a: 5 }] },
					{ $unset: { "v.$[].a.b": "" } },
					null,
					[{ a: 5 }],
				],
				[
					"$unset + $inc same elements",
					{
						v: [
							{ n: 1, m: 2 },
							{ n: 3, m: 4 },
						],
					},
					{ $unset: { "v.$[e].m": "" }, $inc: { "v.$[e].n": 1 } },
					{ arrayFilters: [{ "e.n": { $gte: 3 } }] },
					[{ m: 2, n: 1 }, { n: 4 }],
				],
				[
					"$set deep creates parent",
					{ v: [{ s: 1 }, { a: { c: 2 } }] },
					{ $set: { "v.$[].a.b": 9 } },
					null,
					[{ a: { b: 9 }, s: 1 }, { a: { b: 9, c: 2 } }],
				],
				[
					"$push on array inside branch, absent",
					{ v: [{ s: 1 }, { a: { t: [1] } }] },
					{ $push: { "v.$[].a.t": 7 } },
					null,
					[{ a: { t: [7] }, s: 1 }, { a: { t: [1, 7] } }],
				],
				[
					"two arrays, one update",
					{ v: [{ n: 1 }], w: [{ m: 1 }] },
					{ $inc: { "v.$[].n": 1, "w.$[].m": 5 } },
					null,
					[{ n: 2 }],
				],
			];

			for (const [label, doc, update, options, expected] of CASES) {
				test(label, async () => {
					if (expected === "error") {
						await expect(run(doc, update, options)).rejects.toThrow();
						return;
					}
					expect((await run(doc, update, options)).doc?.v).toEqual(expected);
				});
			}

			// MongoDB reads the clock as it reaches each element, and so does this driver:
			// over 3,000 elements a real `mongod` wrote two different dates, a millisecond
			// apart. So what is asserted is a date on every element and that they are all
			// the same moment to within a second, and not that they are equal.
			test("$currentDate sets the current date on every element", async () => {
				const before = Date.now();
				const { doc } = await run(
					{ v: Array.from({ length: 200 }, (_, n) => ({ n })) },
					{ $currentDate: { "v.$[].at": true } },
				);
				const after = Date.now();

				const dates = (doc?.v as { at: unknown }[]).map(
					(element) => element.at,
				);
				for (const date of dates) expect(date).toBeInstanceOf(Date);

				const times = (dates as Date[]).map((date) => date.getTime());
				expect(Math.max(...times) - Math.min(...times)).toBeLessThan(1000);
				expect(Math.abs(times[0] - before)).toBeLessThan(60_000);
				expect(Math.abs(times[0] - after)).toBeLessThan(60_000);
			});

			test("an update that changes an element is modified, and one that does not is not", async () => {
				const changed = await run(
					{ v: [{ n: 1 }] },
					{ $inc: { "v.$[].n": 1 } },
				);
				expect(changed.result.matchedCount).toBe(1);
				expect(changed.result.modifiedCount).toBe(1);

				const unchanged = await run(
					{ v: [{ n: 9 }, { n: 8 }] },
					{ $max: { "v.$[].n": 3 } },
				);
				expect(unchanged.result.matchedCount).toBe(1);
				expect(unchanged.result.modifiedCount).toBe(0);
			});

			test("the plain fields beside it are updated as usual", async () => {
				const { doc } = await run(
					{
						v: [
							{ n: 0, s: 1 },
							{ n: 5, s: 2 },
						],
						count: 0,
					},
					{ $inc: { "v.$[e].n": 1, count: 1 } },
					{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
				);
				expect(doc?.count).toBe(1);
				expect(doc?.v).toEqual([
					{ n: 0, s: 1 },
					{ n: 6, s: 2 },
				]);
			});
		});

		// -----------------------------------------------------------------
		// EQUALITY OPERATORS IN $pull AND arrayFilters
		// -----------------------------------------------------------------

		describe("equality in $pull and arrayFilters reads a value as a field's", () => {
			// A `$pull` condition and an `arrayFilters` entry are query predicates
			// applied to a value the update finds in an array, so equality sees into an
			// array — `{$eq: 7}` removes `[7, 8]` as well as `7` — `null` is a null, a
			// missing field or an array holding one, and `$ne` and `$nin` are exact
			// negations. As a bare `=` and `IN` they compared the value whole. A bare
			// `{$pull: {v: 7}}` and `$pullAll` are whole-value equality in MongoDB, and
			// are in the table to show it. Every expectation is what a real `mongod`
			// leaves in the array.

			interface ArrayDoc {
				[key: string]: unknown;
				_id?: unknown;
				k: string;
				v?: unknown;
			}

			let docs: MongoLikeCollection<ArrayDoc>;

			beforeEach(async () => {
				docs = db.collection<ArrayDoc>("array_equality");
				try {
					await docs.deleteMany({});
				} catch {
					// Some engines throw on missing tables; ignore.
				}
			});

			const run = async (
				doc: MongoLikeFilter,
				update: MongoLikeFilter,
				options?: { arrayFilters?: MongoLikeFilter[] } | null,
			) => {
				await docs.deleteMany({});
				await docs.insertOne({ k: "a", ...doc });
				await docs.updateOne({ k: "a" }, update, options ?? undefined);
				return (await docs.findOne({ k: "a" }))?.v;
			};

			const CASES: [
				string,
				MongoLikeFilter,
				MongoLikeFilter,
				{ arrayFilters?: MongoLikeFilter[] } | null,
				unknown,
			][] = [
				[
					"pull $eq 7",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $eq: 7 } } },
					null,
					[5, "7", [5], null, [null], { a: 7 }],
				],
				[
					"pull $ne 7",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $ne: 7 } } },
					null,
					[[7, 8], 7, [7]],
				],
				[
					"pull $in [7]",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $in: [7] } } },
					null,
					[5, "7", [5], null, [null], { a: 7 }],
				],
				[
					"pull $nin [7]",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $nin: [7] } } },
					null,
					[[7, 8], 7, [7]],
				],
				[
					"pull $in [7,5]",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $in: [7, 5] } } },
					null,
					["7", null, [null], { a: 7 }],
				],
				[
					"pull $nin [7,5]",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $nin: [7, 5] } } },
					null,
					[[7, 8], 7, 5, [5], [7]],
				],
				[
					'pull $in [7,"7"]',
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $in: [7, "7"] } } },
					null,
					[5, [5], null, [null], { a: 7 }],
				],
				[
					'pull $eq "7"',
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $eq: "7" } } },
					null,
					[[7, 8], 7, 5, [5], null, [null], { a: 7 }, [7]],
				],
				[
					"pull $eq [7,8]",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $eq: [7, 8] } } },
					null,
					[7, 5, "7", [5], null, [null], { a: 7 }, [7]],
				],
				[
					"pull $ne [7,8]",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $ne: [7, 8] } } },
					null,
					[[7, 8]],
				],
				[
					"pull $in [[7,8]]",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $in: [[7, 8]] } } },
					null,
					[7, 5, "7", [5], null, [null], { a: 7 }, [7]],
				],
				[
					"pull $nin [[7,8]]",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $nin: [[7, 8]] } } },
					null,
					[[7, 8]],
				],
				[
					"pull $eq [5]",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $eq: [5] } } },
					null,
					[[7, 8], 7, 5, "7", null, [null], { a: 7 }, [7]],
				],
				[
					"pull $in [[5]]",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $in: [[5]] } } },
					null,
					[[7, 8], 7, 5, "7", null, [null], { a: 7 }, [7]],
				],
				[
					"pull $eq null",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $eq: null } } },
					null,
					[[7, 8], 7, 5, "7", [5], { a: 7 }, [7]],
				],
				[
					"pull $ne null",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $ne: null } } },
					null,
					[null, [null]],
				],
				[
					"pull $in [null]",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $in: [null] } } },
					null,
					[[7, 8], 7, 5, "7", [5], { a: 7 }, [7]],
				],
				[
					"pull $nin [null]",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $nin: [null] } } },
					null,
					[null, [null]],
				],
				[
					"pull $eq {a:7}",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $eq: { a: 7 } } } },
					null,
					[[7, 8], 7, 5, "7", [5], null, [null], [7]],
				],
				[
					"pull $in [{a:7}]",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $in: [{ a: 7 }] } } },
					null,
					[[7, 8], 7, 5, "7", [5], null, [null], [7]],
				],
				[
					"pull $eq 7 + $ne 5",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $eq: 7, $ne: 5 } } },
					null,
					[5, "7", [5], null, [null], { a: 7 }],
				],
				[
					"pull $gt 4 + $ne 7",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $gt: 4, $ne: 7 } } },
					null,
					[[7, 8], 7, "7", null, [null], { a: 7 }, [7]],
				],
				[
					"pull $in [7,5] + $nin [5]",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $in: [7, 5], $nin: [5] } } },
					null,
					[5, "7", [5], null, [null], { a: 7 }],
				],
				[
					"pull $ne 7 + $ne? ($nin [5])",
					{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
					{ $pull: { v: { $ne: 7, $nin: [5] } } },
					null,
					[[7, 8], 7, 5, [5], [7]],
				],
				[
					"pull strings $eq 'a'",
					{ v: ["abc", "a", ["abc", "x"], ["a"], "ab"] },
					{ $pull: { v: { $eq: "a" } } },
					null,
					["abc", ["abc", "x"], "ab"],
				],
				[
					"pull strings $ne 'a'",
					{ v: ["abc", "a", ["abc", "x"], ["a"], "ab"] },
					{ $pull: { v: { $ne: "a" } } },
					null,
					["a", ["a"]],
				],
				[
					"pull strings $in ['a']",
					{ v: ["abc", "a", ["abc", "x"], ["a"], "ab"] },
					{ $pull: { v: { $in: ["a"] } } },
					null,
					["abc", ["abc", "x"], "ab"],
				],
				[
					"pull strings $nin ['a']",
					{ v: ["abc", "a", ["abc", "x"], ["a"], "ab"] },
					{ $pull: { v: { $nin: ["a"] } } },
					null,
					["a", ["a"]],
				],
				[
					"pull sub a: 1",
					{
						v: [
							{ a: [1, 2] },
							{ a: 1 },
							{ a: 2 },
							{ a: [3] },
							{ b: 1 },
							{ a: null },
							{ a: [null] },
							{ a: "1" },
						],
					},
					{ $pull: { v: { a: 1 } } },
					null,
					[
						{ a: 2 },
						{ a: [3] },
						{ b: 1 },
						{ a: null },
						{ a: [null] },
						{ a: "1" },
					],
				],
				[
					"pull sub a $eq 1",
					{
						v: [
							{ a: [1, 2] },
							{ a: 1 },
							{ a: 2 },
							{ a: [3] },
							{ b: 1 },
							{ a: null },
							{ a: [null] },
							{ a: "1" },
						],
					},
					{ $pull: { v: { a: { $eq: 1 } } } },
					null,
					[
						{ a: 2 },
						{ a: [3] },
						{ b: 1 },
						{ a: null },
						{ a: [null] },
						{ a: "1" },
					],
				],
				[
					"pull sub a $ne 1",
					{
						v: [
							{ a: [1, 2] },
							{ a: 1 },
							{ a: 2 },
							{ a: [3] },
							{ b: 1 },
							{ a: null },
							{ a: [null] },
							{ a: "1" },
						],
					},
					{ $pull: { v: { a: { $ne: 1 } } } },
					null,
					[{ a: [1, 2] }, { a: 1 }],
				],
				[
					"pull sub a $in [1]",
					{
						v: [
							{ a: [1, 2] },
							{ a: 1 },
							{ a: 2 },
							{ a: [3] },
							{ b: 1 },
							{ a: null },
							{ a: [null] },
							{ a: "1" },
						],
					},
					{ $pull: { v: { a: { $in: [1] } } } },
					null,
					[
						{ a: 2 },
						{ a: [3] },
						{ b: 1 },
						{ a: null },
						{ a: [null] },
						{ a: "1" },
					],
				],
				[
					"pull sub a $nin [1]",
					{
						v: [
							{ a: [1, 2] },
							{ a: 1 },
							{ a: 2 },
							{ a: [3] },
							{ b: 1 },
							{ a: null },
							{ a: [null] },
							{ a: "1" },
						],
					},
					{ $pull: { v: { a: { $nin: [1] } } } },
					null,
					[{ a: [1, 2] }, { a: 1 }],
				],
				[
					"pull sub a: [1,2]",
					{
						v: [
							{ a: [1, 2] },
							{ a: 1 },
							{ a: 2 },
							{ a: [3] },
							{ b: 1 },
							{ a: null },
							{ a: [null] },
							{ a: "1" },
						],
					},
					{ $pull: { v: { a: [1, 2] } } },
					null,
					[
						{ a: 1 },
						{ a: 2 },
						{ a: [3] },
						{ b: 1 },
						{ a: null },
						{ a: [null] },
						{ a: "1" },
					],
				],
				[
					"pull sub a $eq [1,2]",
					{
						v: [
							{ a: [1, 2] },
							{ a: 1 },
							{ a: 2 },
							{ a: [3] },
							{ b: 1 },
							{ a: null },
							{ a: [null] },
							{ a: "1" },
						],
					},
					{ $pull: { v: { a: { $eq: [1, 2] } } } },
					null,
					[
						{ a: 1 },
						{ a: 2 },
						{ a: [3] },
						{ b: 1 },
						{ a: null },
						{ a: [null] },
						{ a: "1" },
					],
				],
				[
					"pull sub a: null",
					{
						v: [
							{ a: [1, 2] },
							{ a: 1 },
							{ a: 2 },
							{ a: [3] },
							{ b: 1 },
							{ a: null },
							{ a: [null] },
							{ a: "1" },
						],
					},
					{ $pull: { v: { a: null } } },
					null,
					[{ a: [1, 2] }, { a: 1 }, { a: 2 }, { a: [3] }, { a: "1" }],
				],
				[
					"pull sub a $ne null",
					{
						v: [
							{ a: [1, 2] },
							{ a: 1 },
							{ a: 2 },
							{ a: [3] },
							{ b: 1 },
							{ a: null },
							{ a: [null] },
							{ a: "1" },
						],
					},
					{ $pull: { v: { a: { $ne: null } } } },
					null,
					[{ b: 1 }, { a: null }, { a: [null] }],
				],
				[
					"pull sub a $in [1,3]",
					{
						v: [
							{ a: [1, 2] },
							{ a: 1 },
							{ a: 2 },
							{ a: [3] },
							{ b: 1 },
							{ a: null },
							{ a: [null] },
							{ a: "1" },
						],
					},
					{ $pull: { v: { a: { $in: [1, 3] } } } },
					null,
					[{ a: 2 }, { b: 1 }, { a: null }, { a: [null] }, { a: "1" }],
				],
				[
					"pull sub a: 1, b: 1 (both)",
					{
						v: [
							{ a: [1, 2] },
							{ a: 1 },
							{ a: 2 },
							{ a: [3] },
							{ b: 1 },
							{ a: null },
							{ a: [null] },
							{ a: "1" },
						],
					},
					{ $pull: { v: { a: 1, b: 1 } } },
					null,
					[
						{ a: [1, 2] },
						{ a: 1 },
						{ a: 2 },
						{ a: [3] },
						{ b: 1 },
						{ a: null },
						{ a: [null] },
						{ a: "1" },
					],
				],
				[
					"arrayFilters p: 9",
					{
						v: [
							{ p: 9 },
							{ p: [1, 9] },
							{ p: 5 },
							{ x: 1 },
							{ p: null },
							{ p: [null] },
							{ p: "9" },
							{ p: [[1, 9]] },
						],
					},
					{ $set: { "v.$[e].flag": true } },
					{ arrayFilters: [{ "e.p": 9 }] },
					[
						{ flag: true, p: 9 },
						{ flag: true, p: [1, 9] },
						{ p: 5 },
						{ x: 1 },
						{ p: null },
						{ p: [null] },
						{ p: "9" },
						{ p: [[1, 9]] },
					],
				],
				[
					"arrayFilters p $eq 9",
					{
						v: [
							{ p: 9 },
							{ p: [1, 9] },
							{ p: 5 },
							{ x: 1 },
							{ p: null },
							{ p: [null] },
							{ p: "9" },
							{ p: [[1, 9]] },
						],
					},
					{ $set: { "v.$[e].flag": true } },
					{ arrayFilters: [{ "e.p": { $eq: 9 } }] },
					[
						{ flag: true, p: 9 },
						{ flag: true, p: [1, 9] },
						{ p: 5 },
						{ x: 1 },
						{ p: null },
						{ p: [null] },
						{ p: "9" },
						{ p: [[1, 9]] },
					],
				],
				[
					"arrayFilters p $ne 9",
					{
						v: [
							{ p: 9 },
							{ p: [1, 9] },
							{ p: 5 },
							{ x: 1 },
							{ p: null },
							{ p: [null] },
							{ p: "9" },
							{ p: [[1, 9]] },
						],
					},
					{ $set: { "v.$[e].flag": true } },
					{ arrayFilters: [{ "e.p": { $ne: 9 } }] },
					[
						{ p: 9 },
						{ p: [1, 9] },
						{ flag: true, p: 5 },
						{ flag: true, x: 1 },
						{ flag: true, p: null },
						{ flag: true, p: [null] },
						{ flag: true, p: "9" },
						{ flag: true, p: [[1, 9]] },
					],
				],
				[
					"arrayFilters p $in [9]",
					{
						v: [
							{ p: 9 },
							{ p: [1, 9] },
							{ p: 5 },
							{ x: 1 },
							{ p: null },
							{ p: [null] },
							{ p: "9" },
							{ p: [[1, 9]] },
						],
					},
					{ $set: { "v.$[e].flag": true } },
					{ arrayFilters: [{ "e.p": { $in: [9] } }] },
					[
						{ flag: true, p: 9 },
						{ flag: true, p: [1, 9] },
						{ p: 5 },
						{ x: 1 },
						{ p: null },
						{ p: [null] },
						{ p: "9" },
						{ p: [[1, 9]] },
					],
				],
				[
					"arrayFilters p $nin [9]",
					{
						v: [
							{ p: 9 },
							{ p: [1, 9] },
							{ p: 5 },
							{ x: 1 },
							{ p: null },
							{ p: [null] },
							{ p: "9" },
							{ p: [[1, 9]] },
						],
					},
					{ $set: { "v.$[e].flag": true } },
					{ arrayFilters: [{ "e.p": { $nin: [9] } }] },
					[
						{ p: 9 },
						{ p: [1, 9] },
						{ flag: true, p: 5 },
						{ flag: true, x: 1 },
						{ flag: true, p: null },
						{ flag: true, p: [null] },
						{ flag: true, p: "9" },
						{ flag: true, p: [[1, 9]] },
					],
				],
				[
					"arrayFilters p $in [9, 5]",
					{
						v: [
							{ p: 9 },
							{ p: [1, 9] },
							{ p: 5 },
							{ x: 1 },
							{ p: null },
							{ p: [null] },
							{ p: "9" },
							{ p: [[1, 9]] },
						],
					},
					{ $set: { "v.$[e].flag": true } },
					{ arrayFilters: [{ "e.p": { $in: [9, 5] } }] },
					[
						{ flag: true, p: 9 },
						{ flag: true, p: [1, 9] },
						{ flag: true, p: 5 },
						{ x: 1 },
						{ p: null },
						{ p: [null] },
						{ p: "9" },
						{ p: [[1, 9]] },
					],
				],
				[
					"arrayFilters p: null",
					{
						v: [
							{ p: 9 },
							{ p: [1, 9] },
							{ p: 5 },
							{ x: 1 },
							{ p: null },
							{ p: [null] },
							{ p: "9" },
							{ p: [[1, 9]] },
						],
					},
					{ $set: { "v.$[e].flag": true } },
					{ arrayFilters: [{ "e.p": null }] },
					[
						{ p: 9 },
						{ p: [1, 9] },
						{ p: 5 },
						{ flag: true, x: 1 },
						{ flag: true, p: null },
						{ flag: true, p: [null] },
						{ p: "9" },
						{ p: [[1, 9]] },
					],
				],
				[
					"arrayFilters p $ne null",
					{
						v: [
							{ p: 9 },
							{ p: [1, 9] },
							{ p: 5 },
							{ x: 1 },
							{ p: null },
							{ p: [null] },
							{ p: "9" },
							{ p: [[1, 9]] },
						],
					},
					{ $set: { "v.$[e].flag": true } },
					{ arrayFilters: [{ "e.p": { $ne: null } }] },
					[
						{ flag: true, p: 9 },
						{ flag: true, p: [1, 9] },
						{ flag: true, p: 5 },
						{ x: 1 },
						{ p: null },
						{ p: [null] },
						{ flag: true, p: "9" },
						{ flag: true, p: [[1, 9]] },
					],
				],
				[
					"arrayFilters p $in [null]",
					{
						v: [
							{ p: 9 },
							{ p: [1, 9] },
							{ p: 5 },
							{ x: 1 },
							{ p: null },
							{ p: [null] },
							{ p: "9" },
							{ p: [[1, 9]] },
						],
					},
					{ $set: { "v.$[e].flag": true } },
					{ arrayFilters: [{ "e.p": { $in: [null] } }] },
					[
						{ p: 9 },
						{ p: [1, 9] },
						{ p: 5 },
						{ flag: true, x: 1 },
						{ flag: true, p: null },
						{ flag: true, p: [null] },
						{ p: "9" },
						{ p: [[1, 9]] },
					],
				],
				[
					"arrayFilters p: [1,9]",
					{
						v: [
							{ p: 9 },
							{ p: [1, 9] },
							{ p: 5 },
							{ x: 1 },
							{ p: null },
							{ p: [null] },
							{ p: "9" },
							{ p: [[1, 9]] },
						],
					},
					{ $set: { "v.$[e].flag": true } },
					{ arrayFilters: [{ "e.p": [1, 9] }] },
					[
						{ p: 9 },
						{ flag: true, p: [1, 9] },
						{ p: 5 },
						{ x: 1 },
						{ p: null },
						{ p: [null] },
						{ p: "9" },
						{ flag: true, p: [[1, 9]] },
					],
				],
				[
					"arrayFilters p $eq [1,9]",
					{
						v: [
							{ p: 9 },
							{ p: [1, 9] },
							{ p: 5 },
							{ x: 1 },
							{ p: null },
							{ p: [null] },
							{ p: "9" },
							{ p: [[1, 9]] },
						],
					},
					{ $set: { "v.$[e].flag": true } },
					{ arrayFilters: [{ "e.p": { $eq: [1, 9] } }] },
					[
						{ p: 9 },
						{ flag: true, p: [1, 9] },
						{ p: 5 },
						{ x: 1 },
						{ p: null },
						{ p: [null] },
						{ p: "9" },
						{ flag: true, p: [[1, 9]] },
					],
				],
				[
					"arrayFilters p $in [[1,9]]",
					{
						v: [
							{ p: 9 },
							{ p: [1, 9] },
							{ p: 5 },
							{ x: 1 },
							{ p: null },
							{ p: [null] },
							{ p: "9" },
							{ p: [[1, 9]] },
						],
					},
					{ $set: { "v.$[e].flag": true } },
					{ arrayFilters: [{ "e.p": { $in: [[1, 9]] } }] },
					[
						{ p: 9 },
						{ flag: true, p: [1, 9] },
						{ p: 5 },
						{ x: 1 },
						{ p: null },
						{ p: [null] },
						{ p: "9" },
						{ flag: true, p: [[1, 9]] },
					],
				],
				[
					"arrayFilters p: '9'",
					{
						v: [
							{ p: 9 },
							{ p: [1, 9] },
							{ p: 5 },
							{ x: 1 },
							{ p: null },
							{ p: [null] },
							{ p: "9" },
							{ p: [[1, 9]] },
						],
					},
					{ $set: { "v.$[e].flag": true } },
					{ arrayFilters: [{ "e.p": "9" }] },
					[
						{ p: 9 },
						{ p: [1, 9] },
						{ p: 5 },
						{ x: 1 },
						{ p: null },
						{ p: [null] },
						{ flag: true, p: "9" },
						{ p: [[1, 9]] },
					],
				],
				[
					"pullAll [7]",
					{
						v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]],
					},
					{ $pullAll: { v: [7] } },
					null,
					[[7, 8], 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]],
				],
				[
					"pullAll [[7,8]]",
					{
						v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]],
					},
					{ $pullAll: { v: [[7, 8]] } },
					null,
					[7, 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]],
				],
				[
					"pullAll [null]",
					{
						v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]],
					},
					{ $pullAll: { v: [null] } },
					null,
					[[7, 8], 7, 5, "7", [5], [null], { a: 7 }, "abc", ["abc"]],
				],
				[
					"pullAll ['abc']",
					{
						v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]],
					},
					{ $pullAll: { v: ["abc"] } },
					null,
					[[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, ["abc"]],
				],
				[
					"pull bare 7",
					{
						v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]],
					},
					{ $pull: { v: 7 } },
					null,
					[[7, 8], 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]],
				],
				[
					"pull bare 'abc'",
					{
						v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]],
					},
					{ $pull: { v: "abc" } },
					null,
					[[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, ["abc"]],
				],
				[
					"pull bare null",
					{
						v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]],
					},
					{ $pull: { v: null } },
					null,
					[[7, 8], 7, 5, "7", [5], [null], { a: 7 }, "abc", ["abc"]],
				],
				[
					"pull bare [7,8]",
					{
						v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]],
					},
					{ $pull: { v: [7, 8] } },
					null,
					[7, 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]],
				],
				[
					"positional $pull $eq 7",
					{ v: [{ t: [[7, 8], 7, 5, null, [null]] }, { t: [7] }, {}] },
					{ $pull: { "v.$[].t": { $eq: 7 } } },
					null,
					[{ t: [5, null, [null]] }, { t: [] }, {}],
				],
				[
					"positional $pull $ne 7",
					{ v: [{ t: [[7, 8], 7, 5, null, [null]] }, { t: [7] }, {}] },
					{ $pull: { "v.$[].t": { $ne: 7 } } },
					null,
					[{ t: [[7, 8], 7] }, { t: [7] }, {}],
				],
				[
					"positional $pull $in [7]",
					{ v: [{ t: [[7, 8], 7, 5, null, [null]] }, { t: [7] }, {}] },
					{ $pull: { "v.$[].t": { $in: [7] } } },
					null,
					[{ t: [5, null, [null]] }, { t: [] }, {}],
				],
				[
					"positional $pull $nin [7]",
					{ v: [{ t: [[7, 8], 7, 5, null, [null]] }, { t: [7] }, {}] },
					{ $pull: { "v.$[].t": { $nin: [7] } } },
					null,
					[{ t: [[7, 8], 7] }, { t: [7] }, {}],
				],
				[
					"positional $pull $eq null",
					{ v: [{ t: [[7, 8], 7, 5, null, [null]] }, { t: [7] }, {}] },
					{ $pull: { "v.$[].t": { $eq: null } } },
					null,
					[{ t: [[7, 8], 7, 5] }, { t: [7] }, {}],
				],
				[
					"positional $pull sub-doc",
					{ v: [{ t: [{ a: [1, 2] }, { a: 1 }, { a: 3 }] }] },
					{ $pull: { "v.$[].t": { a: 1 } } },
					null,
					[{ t: [{ a: 3 }] }],
				],
			];

			for (const [label, doc, update, options, expected] of CASES) {
				test(label, async () => {
					expect(await run(doc, update, options)).toEqual(expected);
				});
			}
		});

		// -----------------------------------------------------------------
		// $regex, $type, $mod, $size AND $all READ AN ARRAY AS ANY OF ITS ELEMENTS
		// -----------------------------------------------------------------

		describe("field comparisons read an array field as any of its elements", () => {
			// MongoDB reads every field comparison as "the field, or any element of it": a
			// pattern matches `["abc", "x"]` as it matches `"abc"`, `{$type: "string"}`
			// matches `["a"]`, `{$mod: [2, 1]}` matches `[2, 3]`, and `{$all: [5]}` matches a
			// scalar `5`. These were SQL on the field alone, and `$mod` and `$size` raised on
			// the first document holding a string, aborting the whole query. Every
			// expectation is what a real `mongod` returns.

			interface MixedDoc {
				[key: string]: unknown;
				_id?: unknown;
				k: string;
				v?: unknown;
			}

			let docs: MongoLikeCollection<MixedDoc>;

			const keys = async (filter: MongoLikeFilter) =>
				(await docs.find(filter).toArray()).map((doc) => doc.k).sort();

			beforeEach(async () => {
				docs = db.collection<MixedDoc>("array_comparisons");
				try {
					await docs.deleteMany({});
				} catch {
					// Some engines throw on missing tables; ignore.
				}
			});

			const FIXTURES: {
				name: string;
				docs: MixedDoc[];
				cases: [string, MongoLikeFilter, string[]][];
			}[] = [
				{
					name: "strings, numbers, nulls, arrays and documents",
					docs: [
						{ k: "abc", v: "abc" },
						{ k: "ABC", v: "ABC" },
						{ k: "xyz", v: "xyz" },
						{ k: "arrAbc", v: ["abc"] },
						{ k: "arrMix", v: ["abc", "x"] },
						{ k: "arrXyz", v: ["xyz", "q"] },
						{ k: "num5", v: 5 },
						{ k: "num6", v: 6 },
						{ k: "arrNum", v: [5, 6] },
						{ k: "arrOdd", v: [1] },
						{ k: "null", v: null },
						{ k: "missing" },
						{ k: "obj", v: { a: 1 } },
						{ k: "arrObj", v: [{ a: 1 }] },
						{ k: "arrObjB", v: [{ a: 2 }, { a: 1 }] },
						{ k: "empty", v: [] },
						{ k: "nested", v: [["abc"]] },
						{ k: "nested1", v: [[1]] },
						{ k: "bool", v: true },
						{ k: "date", v: new Date(5000) },
						{ k: "arrNull", v: [null] },
						{ k: "size2", v: ["a", "b"] },
					],
					cases: [
						[
							"$regex ^a",
							{ v: { $regex: "^a" } },
							["abc", "arrAbc", "arrMix", "size2"],
						],
						[
							"$regex /^a/i",
							{ v: /^a/i },
							["ABC", "abc", "arrAbc", "arrMix", "size2"],
						],
						[
							"$regex A $options i",
							{ v: { $regex: "A", $options: "i" } },
							["ABC", "abc", "arrAbc", "arrMix", "size2"],
						],
						["$regex ^x", { v: { $regex: "^x" } }, ["arrMix", "arrXyz", "xyz"]],
						[
							"$exists true",
							{ v: { $exists: true } },
							[
								"ABC",
								"abc",
								"arrAbc",
								"arrMix",
								"arrNull",
								"arrNum",
								"arrObj",
								"arrObjB",
								"arrOdd",
								"arrXyz",
								"bool",
								"date",
								"empty",
								"nested",
								"nested1",
								"null",
								"num5",
								"num6",
								"obj",
								"size2",
								"xyz",
							],
						],
						["$exists false", { v: { $exists: false } }, ["missing"]],
						[
							"$type string",
							{ v: { $type: "string" } },
							["ABC", "abc", "arrAbc", "arrMix", "arrXyz", "size2", "xyz"],
						],
						[
							"$type array",
							{ v: { $type: "array" } },
							[
								"arrAbc",
								"arrMix",
								"arrNull",
								"arrNum",
								"arrObj",
								"arrObjB",
								"arrOdd",
								"arrXyz",
								"empty",
								"nested",
								"nested1",
								"size2",
							],
						],
						[
							"$type number",
							{ v: { $type: "number" } },
							["arrNum", "arrOdd", "num5", "num6"],
						],
						[
							"$type object",
							{ v: { $type: "object" } },
							["arrObj", "arrObjB", "obj"],
						],
						["$type null", { v: { $type: "null" } }, ["arrNull", "null"]],
						["$type bool", { v: { $type: "bool" } }, ["bool"]],
						["$type date", { v: { $type: "date" } }, ["date"]],
						[
							"$type 2",
							{ v: { $type: 2 } },
							["ABC", "abc", "arrAbc", "arrMix", "arrXyz", "size2", "xyz"],
						],
						[
							"$mod [2,1]",
							{ v: { $mod: [2, 1] } },
							["arrNum", "arrOdd", "num5"],
						],
						["$mod [5,0]", { v: { $mod: [5, 0] } }, ["arrNum", "num5"]],
						[
							"$size 1",
							{ v: { $size: 1 } },
							["arrAbc", "arrNull", "arrObj", "arrOdd", "nested", "nested1"],
						],
						["$size 0", { v: { $size: 0 } }, ["empty"]],
						[
							"$size 2",
							{ v: { $size: 2 } },
							["arrMix", "arrNum", "arrObjB", "arrXyz", "size2"],
						],
						[
							"$all ['abc']",
							{ v: { $all: ["abc"] } },
							["abc", "arrAbc", "arrMix"],
						],
						["$all ['abc','x']", { v: { $all: ["abc", "x"] } }, ["arrMix"]],
						["$all [5]", { v: { $all: [5] } }, ["arrNum", "num5"]],
						["$all []", { v: { $all: [] } }, []],
						[
							"$elemMatch $eq abc",
							{ v: { $elemMatch: { $eq: "abc" } } },
							["arrAbc", "arrMix"],
						],
						["$elemMatch $gt 5", { v: { $elemMatch: { $gt: 5 } } }, ["arrNum"]],
						[
							"$elemMatch a:1",
							{ v: { $elemMatch: { a: 1 } } },
							["arrObj", "arrObjB"],
						],
						[
							"$elemMatch $regex ^a",
							{ v: { $elemMatch: { $regex: "^a" } } },
							["arrAbc", "arrMix", "size2"],
						],
					],
				},
				{
					name: "numbers with fractions and signs, and arrays in arrays",
					docs: [
						{ k: "f57", v: 5.7 },
						{ k: "neg3", v: -3 },
						{ k: "str5", v: "5" },
						{ k: "six0", v: 6 },
						{ k: "int7", v: 7 },
						{ k: "arrF", v: [5.7, 2] },
						{ k: "abc", v: "abc" },
						{ k: "arrAbc", v: ["abc"] },
						{ k: "arrAbcAbc", v: ["abc", "abc"] },
						{ k: "nested", v: [["abc"]] },
						{ k: "nestedNum", v: [[1, 2]] },
						{ k: "num5", v: 5 },
						{ k: "arrNum", v: [5, 6] },
						{ k: "arr12", v: [1, 2] },
						{ k: "null", v: null },
						{ k: "missing" },
						{ k: "arrNull", v: [null] },
						{ k: "obj", v: { a: [1, 2] } },
						{ k: "arrObj", v: [{ a: 1 }, { a: [1, 2] }] },
					],
					cases: [
						[
							"$mod [2,1]",
							{ v: { $mod: [2, 1] } },
							["arr12", "arrF", "arrNum", "f57", "int7", "num5"],
						],
						[
							"$mod [2,0]",
							{ v: { $mod: [2, 0] } },
							["arr12", "arrF", "arrNum", "six0"],
						],
						[
							"$mod [3,-0]",
							{ v: { $mod: [3, 0] } },
							["arrNum", "neg3", "six0"],
						],
						["$mod [2,-1]", { v: { $mod: [2, -1] } }, ["neg3"]],
						[
							"$mod [2.5, 1]",
							{ v: { $mod: [2.5, 1] } },
							["arr12", "arrF", "arrNum", "f57", "int7", "num5"],
						],
						["$all [5]", { v: { $all: [5] } }, ["arrNum", "num5"]],
						["$all [5,6]", { v: { $all: [5, 6] } }, ["arrNum"]],
						[
							"$all [null]",
							{ v: { $all: [null] } },
							["arrNull", "missing", "null"],
						],
						["$all [[1,2]]", { v: { $all: [[1, 2]] } }, ["arr12", "nestedNum"]],
						[
							"$all ['abc','abc']",
							{ v: { $all: ["abc", "abc"] } },
							["abc", "arrAbc", "arrAbcAbc"],
						],
						["$all []", { v: { $all: [] } }, []],
						["$all [{a:1}]", { v: { $all: [{ a: 1 }] } }, ["arrObj"]],
						[
							"$elemMatch $eq abc",
							{ v: { $elemMatch: { $eq: "abc" } } },
							["arrAbc", "arrAbcAbc"],
						],
						[
							"$elemMatch $in [abc]",
							{ v: { $elemMatch: { $in: ["abc"] } } },
							["arrAbc", "arrAbcAbc"],
						],
						[
							"$elemMatch $ne abc",
							{ v: { $elemMatch: { $ne: "abc" } } },
							[
								"arr12",
								"arrF",
								"arrNull",
								"arrNum",
								"arrObj",
								"nested",
								"nestedNum",
							],
						],
						[
							"$elemMatch $nin [abc]",
							{ v: { $elemMatch: { $nin: ["abc"] } } },
							[
								"arr12",
								"arrF",
								"arrNull",
								"arrNum",
								"arrObj",
								"nested",
								"nestedNum",
							],
						],
						["$elemMatch $eq 1", { v: { $elemMatch: { $eq: 1 } } }, ["arr12"]],
						[
							"$elemMatch $eq [1,2]",
							{ v: { $elemMatch: { $eq: [1, 2] } } },
							["nestedNum"],
						],
						[
							"$elemMatch $eq null",
							{ v: { $elemMatch: { $eq: null } } },
							["arrNull"],
						],
						[
							"$elemMatch $size 1",
							{ v: { $elemMatch: { $size: 1 } } },
							["nested"],
						],
						[
							"$elemMatch $type array",
							{ v: { $elemMatch: { $type: "array" } } },
							["nested", "nestedNum"],
						],
						[
							"$elemMatch $type string",
							{ v: { $elemMatch: { $type: "string" } } },
							["arrAbc", "arrAbcAbc"],
						],
						[
							"$elemMatch $mod [2,1]",
							{ v: { $elemMatch: { $mod: [2, 1] } } },
							["arr12", "arrF", "arrNum"],
						],
						[
							"$size 2",
							{ v: { $size: 2 } },
							["arr12", "arrAbcAbc", "arrF", "arrNum", "arrObj"],
						],
						[
							"$regex ^a (nested arrays)",
							{ v: { $regex: "^a" } },
							["abc", "arrAbc", "arrAbcAbc"],
						],
						[
							"$type string",
							{ v: { $type: "string" } },
							["abc", "arrAbc", "arrAbcAbc", "str5"],
						],
						[
							"$type array",
							{ v: { $type: "array" } },
							[
								"arr12",
								"arrAbc",
								"arrAbcAbc",
								"arrF",
								"arrNull",
								"arrNum",
								"arrObj",
								"nested",
								"nestedNum",
							],
						],
						[
							"$type 4",
							{ v: { $type: 4 } },
							[
								"arr12",
								"arrAbc",
								"arrAbcAbc",
								"arrF",
								"arrNull",
								"arrNum",
								"arrObj",
								"nested",
								"nestedNum",
							],
						],
						["$type double", { v: { $type: "double" } }, ["arrF", "f57"]],
						[
							"$type int",
							{ v: { $type: "int" } },
							["arr12", "arrF", "arrNum", "int7", "neg3", "num5", "six0"],
						],
						[
							"$type number",
							{ v: { $type: "number" } },
							[
								"arr12",
								"arrF",
								"arrNum",
								"f57",
								"int7",
								"neg3",
								"num5",
								"six0",
							],
						],
						["$type null", { v: { $type: "null" } }, ["arrNull", "null"]],
						["$type object", { v: { $type: "object" } }, ["arrObj", "obj"]],
					],
				},
			];

			for (const fixture of FIXTURES) {
				describe(fixture.name, () => {
					beforeEach(async () => {
						await docs.insertMany(fixture.docs);
					});

					for (const [label, filter, expected] of fixture.cases) {
						test(label, async () => {
							expect(await keys(filter)).toEqual(expected);
						});
					}
				});
			}

			describe("a value of the wrong type is not an error", () => {
				test("$mod and $size over a collection with strings in the field", async () => {
					await docs.insertMany([
						{ k: "str", v: "abc" },
						{ k: "num", v: 5 },
						{ k: "arr", v: [1] },
						{ k: "missing" },
					]);
					expect(await keys({ v: { $mod: [2, 1] } })).toEqual(["arr", "num"]);
					expect(await keys({ v: { $size: 1 } })).toEqual(["arr"]);
				});
			});

			describe("what is malformed is refused", () => {
				test.each([
					["$mod: 5", { v: { $mod: 5 } }],
					["$mod: [1]", { v: { $mod: [1] } }],
					["$mod: [0.5, 0]", { v: { $mod: [0.5, 0] } }],
					["$all: 5", { v: { $all: 5 } }],
					["$size: 1.5", { v: { $size: 1.5 } }],
					["$size: -1", { v: { $size: -1 } }],
				])("%s", async (_label, filter) => {
					await expect(keys(filter as MongoLikeFilter)).rejects.toThrow();
				});
			});
		});

		// -----------------------------------------------------------------
		// UPDATE
		// -----------------------------------------------------------------

		describe("update", () => {
			test("$set updates a single document", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
				]);
				const result = await users.updateOne(
					{ name: "Alice" },
					{ $set: { age: 31 } },
				);
				expect(result.matchedCount).toBe(1);
				expect(result.modifiedCount).toBe(1);

				const updated = await users.findOne({ name: "Alice" });
				expect(updated?.age).toBe(31);
			});

			test("$inc increments a numeric field", async () => {
				await users.insertOne({ name: "Alice", age: 30 });
				await users.updateOne({ name: "Alice" }, { $inc: { age: 5 } });
				const updated = await users.findOne({ name: "Alice" });
				expect(updated?.age).toBe(35);
			});

			test("updateMany updates every match", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30, active: false },
					{ name: "Bob", age: 25, active: false },
					{ name: "Charlie", age: 35, active: true },
				]);
				const result = await users.updateMany(
					{ active: false },
					{ $set: { active: true } },
				);
				expect(result.matchedCount).toBe(2);

				const allActive = await users.find({ active: true }).toArray();
				expect(allActive).toHaveLength(3);
			});
		});

		// -----------------------------------------------------------------
		// DELETE
		// -----------------------------------------------------------------

		describe("delete", () => {
			test("deleteOne removes one document", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
				]);
				const result = await users.deleteOne({ name: "Alice" });
				expect(result.deletedCount).toBe(1);

				const remaining = await users.find({}).toArray();
				expect(remaining).toHaveLength(1);
				expect(remaining[0].name).toBe("Bob");
			});

			test("deleteMany removes every match", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
					{ name: "Charlie", age: 35 },
				]);
				const result = await users.deleteMany({ age: { $gte: 30 } });
				expect(result.deletedCount).toBe(2);

				const remaining = await users.find({}).toArray();
				expect(remaining).toHaveLength(1);
				expect(remaining[0].name).toBe("Bob");
			});

			test("deleteOne reports zero matches", async () => {
				const result = await users.deleteOne({ name: "Nobody" });
				expect(result.deletedCount).toBe(0);
			});
		});

		// -----------------------------------------------------------------
		// COUNT
		// -----------------------------------------------------------------

		describe("count", () => {
			test("countDocuments counts everything", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
					{ name: "Charlie", age: 35 },
				]);
				expect(await users.countDocuments()).toBe(3);
			});

			test("countDocuments respects filters", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
					{ name: "Charlie", age: 35 },
				]);
				expect(await users.countDocuments({ age: { $gt: 28 } })).toBe(2);
			});
		});

		// -----------------------------------------------------------------
		// FULL ROUND-TRIP
		// -----------------------------------------------------------------

		test("insert → query → update → delete round-trip", async () => {
			await users.insertOne({
				name: "Alice",
				age: 30,
				email: "alice@example.com",
				tags: ["admin"],
			});

			const found = await users.findOne({ name: "Alice" });
			expect(found?.email).toBe("alice@example.com");

			await users.updateOne({ name: "Alice" }, { $set: { age: 31 } });
			const updated = await users.findOne({ name: "Alice" });
			expect(updated?.age).toBe(31);

			const deleted = await users.deleteOne({ name: "Alice" });
			expect(deleted.deletedCount).toBe(1);

			const gone = await users.findOne({ name: "Alice" });
			expect(gone).toBeNull();
		});
	});
}
