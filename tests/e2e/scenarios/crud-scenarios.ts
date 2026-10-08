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
