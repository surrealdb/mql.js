/**
 * Aggregation parity: the same pipelines, through both drivers.
 *
 * These exist because the aggregation translation was written against a reading
 * of MongoDB's documentation on one side and measurements of SurrealDB on the
 * other. Half of that is evidence. The expectations below are asserted of the
 * official driver against a real `mongod` *and* of this one, so an assumption
 * about MongoDB that turned out to be wrong fails on the MongoDB leg rather than
 * being enshrined as this driver's behaviour.
 *
 * Four cases were reasoned about rather than measured when the feature landed,
 * and each has a test here that would have caught the reasoning being wrong:
 *
 *   - `$unwind` on a value that is not an array;
 *   - `$dayOfWeek`'s numbering, which differs from SurrealDB's `time::wday` by
 *     an offset that had to be derived;
 *   - what `$ifNull` treats as null — `0` and `""` are present, not null;
 *   - the order `$push` collects values in.
 *
 * Everything here restricts itself to the `MongoLikeCollection` contract, so
 * adding a scenario means appending a `test()`.
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type {
	MongoLikeClient,
	MongoLikeCollection,
	MongoLikeDb,
	MongoLikeDocument,
} from "../contracts/mongo-like.ts";
import type { DatabaseProvider } from "../providers/database-provider.ts";

interface SaleDoc extends MongoLikeDocument {
	_id?: unknown;
	cat?: string;
	sub?: string;
	price?: number;
	qty?: number;
	tags?: unknown;
	when?: Date;
}

const COLLECTION_NAME = "agg_sales";

/** Strip `_id` where a scenario is not asserting about identity. */
function withoutId(docs: MongoLikeDocument[]): MongoLikeDocument[] {
	return docs.map(({ _id, ...rest }) => rest);
}

export function registerAggregationScenarios(provider: DatabaseProvider): void {
	describe(`E2E aggregation parity – ${provider.name}`, () => {
		let client: MongoLikeClient;
		let db: MongoLikeDb;
		let sales: MongoLikeCollection<SaleDoc>;

		beforeAll(async () => {
			client = await provider.start();
			db = client.db();
		}, 120_000);

		afterAll(async () => {
			await provider.stop();
		}, 30_000);

		beforeEach(async () => {
			sales = db.collection<SaleDoc>(COLLECTION_NAME);
			try {
				await sales.deleteMany({});
			} catch {
				// Some engines throw on missing tables; ignore.
			}
		});

		/** The fixture most scenarios below share. */
		async function seed(): Promise<void> {
			await sales.insertMany([
				{ cat: "a", sub: "x", price: 10, qty: 2, tags: ["p", "q"] },
				{ cat: "a", sub: "y", price: 20, qty: 1, tags: ["q"] },
				{ cat: "b", sub: "x", price: 30, qty: 5, tags: ["p"] },
				{ cat: "b", sub: "x", price: 40, qty: 3, tags: [] },
			]);
		}

		// -----------------------------------------------------------------
		// $group
		// -----------------------------------------------------------------

		describe("$group", () => {
			test("sums, counts, averages and bounds per key", async () => {
				await seed();
				const out = await sales
					.aggregate([
						{
							$group: {
								_id: "$cat",
								total: { $sum: "$price" },
								n: { $sum: 1 },
								avg: { $avg: "$price" },
								lo: { $min: "$price" },
								hi: { $max: "$price" },
							},
						},
						{ $sort: { _id: 1 } },
					])
					.toArray();

				expect(out).toEqual([
					{ _id: "a", total: 30, n: 2, avg: 15, lo: 10, hi: 20 },
					{ _id: "b", total: 70, n: 2, avg: 35, lo: 30, hi: 40 },
				]);
			});

			test("_id: null collapses everything into one document", async () => {
				await seed();
				expect(
					await sales
						.aggregate([{ $group: { _id: null, total: { $sum: "$price" } } }])
						.toArray(),
				).toEqual([{ _id: null, total: 100 }]);
			});

			test("a compound _id keeps the shape it was written in", async () => {
				await seed();
				expect(
					await sales
						.aggregate([
							{ $group: { _id: { c: "$cat", s: "$sub" }, n: { $sum: 1 } } },
							{ $sort: { _id: 1 } },
						])
						.toArray(),
				).toEqual([
					{ _id: { c: "a", s: "x" }, n: 1 },
					{ _id: { c: "a", s: "y" }, n: 1 },
					{ _id: { c: "b", s: "x" }, n: 2 },
				]);
			});

			test("$push collects in the order the group saw them", async () => {
				// The ordering claim. `array::group` and MongoDB's `$push` both build a
				// list, and nothing guaranteed they build it the same way round.
				await sales.insertMany([
					{ cat: "a", sub: "first", price: 1 },
					{ cat: "a", sub: "second", price: 2 },
					{ cat: "a", sub: "third", price: 3 },
				]);
				const [group] = await sales
					.aggregate([
						{ $sort: { price: 1 } },
						{ $group: { _id: "$cat", subs: { $push: "$sub" } } },
					])
					.toArray();
				expect(group?.subs).toEqual(["first", "second", "third"]);
			});

			test("$addToSet drops duplicates", async () => {
				await seed();
				const out = await sales
					.aggregate([
						{ $group: { _id: "$cat", uniq: { $addToSet: "$sub" } } },
						{ $sort: { _id: 1 } },
					])
					.toArray();
				// Set order is not guaranteed by either driver, so compare as sets.
				expect(out.map((row) => (row.uniq as string[]).slice().sort())).toEqual(
					[["x", "y"], ["x"]],
				);
			});

			test("an expression inside an accumulator runs per document", async () => {
				await seed();
				expect(
					await sales
						.aggregate([
							{
								$group: {
									_id: "$cat",
									revenue: { $sum: { $multiply: ["$price", "$qty"] } },
								},
							},
							{ $sort: { _id: 1 } },
						])
						.toArray(),
				).toEqual([
					{ _id: "a", revenue: 40 },
					{ _id: "b", revenue: 270 },
				]);
			});
		});

		// -----------------------------------------------------------------
		// $match
		// -----------------------------------------------------------------

		describe("$match", () => {
			test("before a $group filters the input rows", async () => {
				await seed();
				expect(
					await sales
						.aggregate([
							{ $match: { price: { $gte: 20 } } },
							{ $group: { _id: "$cat", n: { $sum: 1 } } },
							{ $sort: { _id: 1 } },
						])
						.toArray(),
				).toEqual([
					{ _id: "a", n: 1 },
					{ _id: "b", n: 2 },
				]);
			});

			test("after a $group filters the groups", async () => {
				await seed();
				expect(
					await sales
						.aggregate([
							{
								$group: {
									_id: "$cat",
									n: { $sum: 1 },
									total: { $sum: "$price" },
								},
							},
							{ $match: { total: { $gt: 50 } } },
						])
						.toArray(),
				).toEqual([{ _id: "b", n: 2, total: 70 }]);
			});

			test("on _id after a $group matches the group key", async () => {
				await seed();
				expect(
					await sales
						.aggregate([
							{ $group: { _id: "$cat", n: { $sum: 1 } } },
							{ $match: { _id: "a" } },
						])
						.toArray(),
				).toEqual([{ _id: "a", n: 2 }]);
			});
		});

		// -----------------------------------------------------------------
		// $unwind
		// -----------------------------------------------------------------

		describe("$unwind", () => {
			test("emits one document per element", async () => {
				await sales.insertOne({ cat: "a", tags: ["p", "q"] });
				expect(
					withoutId(
						await sales
							.aggregate([
								{ $unwind: "$tags" },
								{ $project: { tags: 1, _id: 0 } },
							])
							.toArray(),
					),
				).toEqual([{ tags: "p" }, { tags: "q" }]);
			});

			test("drops a document whose array is empty", async () => {
				await sales.insertMany([
					{ cat: "keep", tags: ["p"] },
					{ cat: "drop", tags: [] },
				]);
				const out = await sales.aggregate([{ $unwind: "$tags" }]).toArray();
				expect(out).toHaveLength(1);
				expect(out[0]?.cat).toBe("keep");
			});

			test("drops a document that has no such field", async () => {
				await sales.insertMany([
					{ cat: "keep", tags: ["p"] },
					{ cat: "drop", price: 1 },
				]);
				const out = await sales.aggregate([{ $unwind: "$tags" }]).toArray();
				expect(out).toHaveLength(1);
				expect(out[0]?.cat).toBe("keep");
			});

			test("drops a document whose field is null", async () => {
				await sales.insertMany([
					{ cat: "keep", tags: ["p"] },
					{ cat: "drop", tags: null },
				]);
				const out = await sales.aggregate([{ $unwind: "$tags" }]).toArray();
				expect(out).toHaveLength(1);
				expect(out[0]?.cat).toBe("keep");
			});

			test("unwinds a non-array value as though it were an array of one", async () => {
				// The reasoned-about case. If MongoDB actually errors or drops here, this
				// fails on the MongoDB leg and the driver's guard is wrong.
				await sales.insertOne({ cat: "scalar", tags: "solo" });
				const out = await sales.aggregate([{ $unwind: "$tags" }]).toArray();
				expect(out).toHaveLength(1);
				expect(out[0]?.tags).toBe("solo");
			});

			test("preserveNullAndEmptyArrays keeps what the default drops", async () => {
				await sales.insertMany([
					{ cat: "full", tags: ["p"] },
					{ cat: "empty", tags: [] },
					{ cat: "missing", price: 1 },
				]);
				const out = await sales
					.aggregate([
						{ $unwind: { path: "$tags", preserveNullAndEmptyArrays: true } },
						{ $sort: { cat: 1 } },
					])
					.toArray();
				expect(out.map((row) => row.cat)).toEqual(["empty", "full", "missing"]);
			});

			test("feeds a $group", async () => {
				await seed();
				expect(
					await sales
						.aggregate([
							{ $unwind: "$tags" },
							{ $group: { _id: "$tags", n: { $sum: 1 } } },
							{ $sort: { _id: 1 } },
						])
						.toArray(),
				).toEqual([
					{ _id: "p", n: 2 },
					{ _id: "q", n: 2 },
				]);
			});
		});

		// -----------------------------------------------------------------
		// $project and expressions
		// -----------------------------------------------------------------

		describe("$project", () => {
			test("includes _id unless it is suppressed", async () => {
				await sales.insertOne({ cat: "a", price: 10 });

				const [withId] = await sales
					.aggregate([{ $project: { cat: 1 } }])
					.toArray();
				expect(Object.keys(withId ?? {}).sort()).toEqual(["_id", "cat"]);

				const [withoutIdField] = await sales
					.aggregate([{ $project: { cat: 1, _id: 0 } }])
					.toArray();
				expect(withoutIdField).toEqual({ cat: "a" });
			});

			test("computes from an expression", async () => {
				await sales.insertOne({ cat: "a", price: 10, qty: 3 });
				expect(
					await sales
						.aggregate([
							{
								$project: {
									_id: 0,
									revenue: { $multiply: ["$price", "$qty"] },
								},
							},
						])
						.toArray(),
				).toEqual([{ revenue: 30 }]);
			});

			test("$cond picks a branch per document", async () => {
				await seed();
				expect(
					await sales
						.aggregate([
							{
								$project: {
									_id: 0,
									price: 1,
									band: { $cond: [{ $gte: ["$price", 25] }, "high", "low"] },
								},
							},
							{ $sort: { price: 1 } },
						])
						.toArray(),
				).toEqual([
					{ price: 10, band: "low" },
					{ price: 20, band: "low" },
					{ price: 30, band: "high" },
					{ price: 40, band: "high" },
				]);
			});

			test("$ifNull treats 0 and the empty string as present", async () => {
				// The reasoned-about case. SurrealQL's `??` was measured; MongoDB's
				// notion of "null" for `$ifNull` was read. If they disagree, this fails
				// on the MongoDB leg.
				await sales.insertOne({ cat: "", price: 0 });
				expect(
					await sales
						.aggregate([
							{
								$project: {
									_id: 0,
									price: { $ifNull: ["$price", -1] },
									cat: { $ifNull: ["$cat", "fallback"] },
									missing: { $ifNull: ["$nope", "fallback"] },
								},
							},
						])
						.toArray(),
				).toEqual([{ price: 0, cat: "", missing: "fallback" }]);
			});

			test("arithmetic and string operators agree", async () => {
				await sales.insertOne({ cat: "abc", price: 7, qty: 2 });
				expect(
					await sales
						.aggregate([
							{
								$project: {
									_id: 0,
									sum: { $add: ["$price", "$qty"] },
									diff: { $subtract: ["$price", "$qty"] },
									quot: { $divide: ["$price", "$qty"] },
									rem: { $mod: ["$price", "$qty"] },
									upper: { $toUpper: "$cat" },
									len: { $strLenCP: "$cat" },
								},
							},
						])
						.toArray(),
				).toEqual([
					{ sum: 9, diff: 5, quot: 3.5, rem: 1, upper: "ABC", len: 3 },
				]);
			});

			test("$dayOfWeek and the other date parts agree", async () => {
				// The reasoned-about case, and the one most likely to be wrong: SurrealDB
				// numbers weekdays from Monday and MongoDB from Sunday, so the driver
				// applies an offset that was derived rather than measured against mongod.
				// 2026-03-04 is a Wednesday, which MongoDB numbers 4.
				await sales.insertOne({
					cat: "a",
					when: new Date("2026-03-04T05:06:07Z"),
				});
				expect(
					await sales
						.aggregate([
							{
								$project: {
									_id: 0,
									y: { $year: "$when" },
									mo: { $month: "$when" },
									d: { $dayOfMonth: "$when" },
									wd: { $dayOfWeek: "$when" },
									yd: { $dayOfYear: "$when" },
									h: { $hour: "$when" },
									mi: { $minute: "$when" },
								},
							},
						])
						.toArray(),
				).toEqual([{ y: 2026, mo: 3, d: 4, wd: 4, yd: 63, h: 5, mi: 6 }]);
			});
		});

		// -----------------------------------------------------------------
		// Paging and $count
		// -----------------------------------------------------------------

		describe("paging", () => {
			test("$skip then $limit takes the middle window", async () => {
				await seed();
				expect(
					await sales
						.aggregate([
							{ $sort: { price: 1 } },
							{ $skip: 1 },
							{ $limit: 2 },
							{ $project: { _id: 0, price: 1 } },
						])
						.toArray(),
				).toEqual([{ price: 20 }, { price: 30 }]);
			});

			test("$limit then $skip discards from inside the page", async () => {
				await seed();
				expect(
					await sales
						.aggregate([
							{ $sort: { price: 1 } },
							{ $limit: 2 },
							{ $skip: 1 },
							{ $project: { _id: 0, price: 1 } },
						])
						.toArray(),
				).toEqual([{ price: 20 }]);
			});

			test("$count reports one document of one field", async () => {
				await seed();
				expect(
					await sales
						.aggregate([{ $match: { cat: "b" } }, { $count: "total" }])
						.toArray(),
				).toEqual([{ total: 2 }]);
			});

			test("$count over an empty match yields no document at all", async () => {
				await seed();
				expect(
					await sales
						.aggregate([{ $match: { cat: "nope" } }, { $count: "total" }])
						.toArray(),
				).toEqual([]);
			});
		});
	});
}
