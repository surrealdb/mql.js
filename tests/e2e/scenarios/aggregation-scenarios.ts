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
	sub?: unknown;
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
		// $addFields / $set, $replaceRoot / $replaceWith, $sortByCount
		// -----------------------------------------------------------------

		describe("$addFields", () => {
			test("adds a computed field and keeps the rest", async () => {
				await sales.insertOne({ cat: "a", price: 10, qty: 3 });
				const [row] = await sales
					.aggregate([
						{ $addFields: { total: { $multiply: ["$price", "$qty"] } } },
						{ $project: { _id: 0, cat: 1, price: 1, total: 1 } },
					])
					.toArray();
				expect(row).toEqual({ cat: "a", price: 10, total: 30 });
			});

			test("replaces a field that is already there", async () => {
				// The behaviour that separates it from $project, and the one nothing in
				// SurrealQL's grammar promised.
				await sales.insertOne({ cat: "a", price: 10 });
				const [row] = await sales
					.aggregate([
						{ $addFields: { price: 999 } },
						{ $project: { _id: 0, price: 1 } },
					])
					.toArray();
				expect(row).toEqual({ price: 999 });
			});

			test("$set is the same stage", async () => {
				await sales.insertOne({ cat: "a", price: 10 });
				const [row] = await sales
					.aggregate([{ $set: { tag: "x" } }, { $project: { _id: 0, tag: 1 } }])
					.toArray();
				expect(row).toEqual({ tag: "x" });
			});

			test("leaves _id addressable afterwards", async () => {
				await sales.insertMany([
					{ _id: "a1", price: 1 },
					{ _id: "a2", price: 2 },
				]);
				expect(
					await sales
						.aggregate([
							{ $addFields: { n: 1 } },
							{ $sort: { _id: -1 } },
							{ $project: { _id: 1 } },
						])
						.toArray(),
				).toEqual([{ _id: "a2" }, { _id: "a1" }]);
			});

			test("works on the output of a $group", async () => {
				await sales.insertMany([
					{ cat: "a", price: 10 },
					{ cat: "a", price: 20 },
					{ cat: "b", price: 30 },
				]);
				expect(
					await sales
						.aggregate([
							{ $group: { _id: "$cat", total: { $sum: "$price" } } },
							{ $addFields: { doubled: { $multiply: ["$total", 2] } } },
							{ $sort: { _id: 1 } },
						])
						.toArray(),
				).toEqual([
					{ _id: "a", total: 30, doubled: 60 },
					{ _id: "b", total: 30, doubled: 60 },
				]);
			});
		});

		describe("$replaceRoot", () => {
			test("promotes a subdocument to the root", async () => {
				await sales.insertOne({ cat: "a", sub: { x: 9, y: 8 } });
				expect(
					await sales
						.aggregate([{ $replaceRoot: { newRoot: "$sub" } }])
						.toArray(),
				).toEqual([{ x: 9, y: 8 }]);
			});

			test("$replaceWith is the shorthand", async () => {
				await sales.insertOne({ cat: "a", sub: { x: 7 } });
				expect(
					await sales.aggregate([{ $replaceWith: "$sub" }]).toArray(),
				).toEqual([{ x: 7 }]);
			});

			test("accepts a computed document", async () => {
				await sales.insertOne({ cat: "a", price: 10 });
				expect(
					await sales
						.aggregate([
							{ $replaceRoot: { newRoot: { label: "$cat", value: "$price" } } },
						])
						.toArray(),
				).toEqual([{ label: "a", value: 10 }]);
			});
		});

		describe("$sortByCount", () => {
			test("counts by the expression and orders by the count", async () => {
				await sales.insertMany([
					{ cat: "a" },
					{ cat: "a" },
					{ cat: "a" },
					{ cat: "b" },
					{ cat: "b" },
					{ cat: "c" },
				]);
				expect(
					await sales.aggregate([{ $sortByCount: "$cat" }]).toArray(),
				).toEqual([
					{ _id: "a", count: 3 },
					{ _id: "b", count: 2 },
					{ _id: "c", count: 1 },
				]);
			});
		});

		// -----------------------------------------------------------------
		// $lookup
		// -----------------------------------------------------------------

		describe("$lookup", () => {
			const CUSTOMERS = "agg_customers";

			/** Two customers, and orders pointing at them by key and by id. */
			async function seedJoin(): Promise<void> {
				const customers = db.collection<MongoLikeDocument>(CUSTOMERS);
				try {
					await customers.deleteMany({});
				} catch {
					// Missing collection; ignore.
				}
				await customers.insertMany([
					{ _id: "c1", cid: "c1", name: "Ada" },
					{ _id: "c2", cid: "c2", name: "Bob" },
				]);
				await sales.insertMany([
					{ _id: "o1", cat: "a", sub: "c1", price: 10 },
					{ _id: "o2", cat: "b", sub: "c2", price: 20 },
					{ _id: "o3", cat: "c", sub: "missing", price: 30 },
					{ _id: "o4", cat: "d", sub: ["c1", "c2"], price: 40 },
				]);
			}

			test("attaches the matching documents as an array", async () => {
				await seedJoin();
				const [row] = await sales
					.aggregate([
						{ $match: { _id: "o1" } },
						{
							$lookup: {
								from: CUSTOMERS,
								localField: "sub",
								foreignField: "cid",
								as: "c",
							},
						},
					])
					.toArray();
				expect(row?.c).toEqual([{ _id: "c1", cid: "c1", name: "Ada" }]);
			});

			test("a document with no match keeps an empty array", async () => {
				// The left-outer half: MongoDB does not drop the row.
				await seedJoin();
				const [row] = await sales
					.aggregate([
						{ $match: { _id: "o3" } },
						{
							$lookup: {
								from: CUSTOMERS,
								localField: "sub",
								foreignField: "cid",
								as: "c",
							},
						},
					])
					.toArray();
				expect(row?.c).toEqual([]);
			});

			test("an array local field matches on any element", async () => {
				await seedJoin();
				const [row] = await sales
					.aggregate([
						{ $match: { _id: "o4" } },
						{
							$lookup: {
								from: CUSTOMERS,
								localField: "sub",
								foreignField: "cid",
								as: "c",
							},
						},
					])
					.toArray();
				expect(
					(row?.c as MongoLikeDocument[]).map((d) => d.name).sort(),
				).toEqual(["Ada", "Bob"]);
			});

			test("joins on the foreign _id", async () => {
				await seedJoin();
				const [row] = await sales
					.aggregate([
						{ $match: { _id: "o1" } },
						{
							$lookup: {
								from: CUSTOMERS,
								localField: "sub",
								foreignField: "_id",
								as: "c",
							},
						},
					])
					.toArray();
				expect((row?.c as MongoLikeDocument[])[0]?._id).toBe("c1");
			});

			test("the joined documents carry _id, and it survives being moved", async () => {
				await seedJoin();
				const [row] = await sales
					.aggregate([
						{ $match: { _id: "o1" } },
						{
							$lookup: {
								from: CUSTOMERS,
								localField: "sub",
								foreignField: "cid",
								as: "c",
							},
						},
						{ $unwind: "$c" },
						{ $project: { _id: 0, who: "$c._id", name: "$c.name" } },
					])
					.toArray();
				expect(row).toEqual({ who: "c1", name: "Ada" });
			});

			test("joining a collection with no matches at all yields empty arrays", async () => {
				await seedJoin();
				const rows = await sales
					.aggregate([
						{ $match: { _id: "o1" } },
						{
							$lookup: {
								from: "agg_nothing_here",
								localField: "sub",
								foreignField: "cid",
								as: "c",
							},
						},
					])
					.toArray();
				expect(rows).toHaveLength(1);
				expect(rows[0]?.c).toEqual([]);
			});

			test("feeds $unwind and $group, which is what a join is usually for", async () => {
				await seedJoin();
				expect(
					await sales
						.aggregate([
							{
								$lookup: {
									from: CUSTOMERS,
									localField: "sub",
									foreignField: "cid",
									as: "c",
								},
							},
							{ $unwind: "$c" },
							{ $group: { _id: "$c.name", spend: { $sum: "$price" } } },
							{ $sort: { _id: 1 } },
						])
						.toArray(),
				).toEqual([
					{ _id: "Ada", spend: 50 },
					{ _id: "Bob", spend: 60 },
				]);
			});
		});

		// -----------------------------------------------------------------
		// $graphLookup
		// -----------------------------------------------------------------

		describe("$graphLookup", () => {
			const STAFF = "agg_staff";

			/** Ada at the top; Bob and Eve under her; Cy under Bob; Dee under Cy. */
			async function seedTree(): Promise<void> {
				const staff = db.collection<MongoLikeDocument>(STAFF);
				try {
					await staff.deleteMany({});
				} catch {
					// Missing collection; ignore.
				}
				await staff.insertMany([
					{ _id: "1", who: "Ada", mgr: null },
					{ _id: "2", who: "Bob", mgr: "Ada" },
					{ _id: "3", who: "Cy", mgr: "Bob" },
					{ _id: "4", who: "Dee", mgr: "Cy" },
					{ _id: "5", who: "Eve", mgr: "Ada" },
				]);
			}

			const staff = () => db.collection<MongoLikeDocument>(STAFF);

			const names = (rows: MongoLikeDocument[]): string[] =>
				(rows[0]?.t as MongoLikeDocument[]).map((d) => d.who as string).sort();

			test("walks the whole subtree, not just the first level", async () => {
				await seedTree();
				const out = await staff()
					.aggregate([
						{ $match: { who: "Ada" } },
						{
							$graphLookup: {
								from: STAFF,
								startWith: "$who",
								connectFromField: "who",
								connectToField: "mgr",
								as: "t",
							},
						},
					])
					.toArray();
				expect(names(out)).toEqual(["Bob", "Cy", "Dee", "Eve"]);
			});

			test("each input document gets its own reachable set", async () => {
				await seedTree();
				const out = await staff()
					.aggregate([
						{
							$graphLookup: {
								from: STAFF,
								startWith: "$who",
								connectFromField: "who",
								connectToField: "mgr",
								as: "t",
							},
						},
						{ $project: { _id: 0, who: 1, n: { $size: "$t" } } },
						{ $sort: { who: 1 } },
					])
					.toArray();
				expect(out).toEqual([
					{ who: "Ada", n: 4 },
					{ who: "Bob", n: 2 },
					{ who: "Cy", n: 1 },
					{ who: "Dee", n: 0 },
					{ who: "Eve", n: 0 },
				]);
			});

			test("maxDepth: 0 takes only the first level", async () => {
				await seedTree();
				const out = await staff()
					.aggregate([
						{ $match: { who: "Ada" } },
						{
							$graphLookup: {
								from: STAFF,
								startWith: "$who",
								connectFromField: "who",
								connectToField: "mgr",
								as: "t",
								maxDepth: 0,
							},
						},
					])
					.toArray();
				expect(names(out)).toEqual(["Bob", "Eve"]);
			});

			test("depthField counts the first level as zero", async () => {
				// The numbering is a convention rather than a derivation, so it is
				// asserted of mongod rather than assumed.
				await seedTree();
				const out = await staff()
					.aggregate([
						{ $match: { who: "Ada" } },
						{
							$graphLookup: {
								from: STAFF,
								startWith: "$who",
								connectFromField: "who",
								connectToField: "mgr",
								as: "t",
								depthField: "lvl",
							},
						},
						{ $unwind: "$t" },
						{ $project: { _id: 0, name: "$t.who", lvl: "$t.lvl" } },
						{ $sort: { lvl: 1, name: 1 } },
					])
					.toArray();
				expect(out).toEqual([
					{ name: "Bob", lvl: 0 },
					{ name: "Eve", lvl: 0 },
					{ name: "Cy", lvl: 1 },
					{ name: "Dee", lvl: 2 },
				]);
			});

			test("restrictSearchWithMatch prunes the traversal", async () => {
				await seedTree();
				const out = await staff()
					.aggregate([
						{ $match: { who: "Ada" } },
						{
							$graphLookup: {
								from: STAFF,
								startWith: "$who",
								connectFromField: "who",
								connectToField: "mgr",
								as: "t",
								restrictSearchWithMatch: { who: { $ne: "Eve" } },
							},
						},
					])
					.toArray();
				expect(names(out)).toEqual(["Bob", "Cy", "Dee"]);
			});

			test("a leaf reaches nothing and gets an empty array", async () => {
				await seedTree();
				const out = await staff()
					.aggregate([
						{ $match: { who: "Dee" } },
						{
							$graphLookup: {
								from: STAFF,
								startWith: "$who",
								connectFromField: "who",
								connectToField: "mgr",
								as: "t",
							},
						},
					])
					.toArray();
				expect(out[0]?.t).toEqual([]);
			});

			test("a cycle terminates rather than repeating", async () => {
				// Two documents pointing at each other. Without the already-seen guard
				// the fold would rediscover them for every step of the cap.
				const staffed = staff();
				try {
					await staffed.deleteMany({});
				} catch {
					// Missing collection; ignore.
				}
				await staffed.insertMany([
					{ _id: "x", who: "X", mgr: "Y" },
					{ _id: "y", who: "Y", mgr: "X" },
				]);

				const out = await staffed
					.aggregate([
						{ $match: { who: "X" } },
						{
							$graphLookup: {
								from: STAFF,
								startWith: "$who",
								connectFromField: "who",
								connectToField: "mgr",
								as: "t",
							},
						},
					])
					.toArray();
				expect(names(out)).toEqual(["X", "Y"]);
			});
		});

		// -----------------------------------------------------------------
		// $facet
		// -----------------------------------------------------------------

		describe("$facet", () => {
			test("answers with one document carrying an array per branch", async () => {
				await seed();
				const out = await sales
					.aggregate([
						{
							$facet: {
								byCat: [
									{ $group: { _id: "$cat", n: { $sum: 1 } } },
									{ $sort: { _id: 1 } },
								],
								dearest: [
									{ $sort: { price: -1 } },
									{ $limit: 1 },
									{ $project: { _id: 0, price: 1 } },
								],
							},
						},
					])
					.toArray();

				expect(out).toHaveLength(1);
				expect(out[0]?.byCat).toEqual([
					{ _id: "a", n: 2 },
					{ _id: "b", n: 2 },
				]);
				expect(out[0]?.dearest).toEqual([{ price: 40 }]);
			});

			test("every branch sees the same input, filtered by what came before", async () => {
				await seed();
				const out = await sales
					.aggregate([
						{ $match: { cat: "a" } },
						{
							$facet: {
								count: [{ $count: "n" }],
								prices: [
									{ $sort: { price: 1 } },
									{ $project: { _id: 0, price: 1 } },
								],
							},
						},
					])
					.toArray();

				expect(out[0]?.count).toEqual([{ n: 2 }]);
				expect(out[0]?.prices).toEqual([{ price: 10 }, { price: 20 }]);
			});

			test("a branch that matches nothing is an empty array, not a missing field", async () => {
				await seed();
				const out = await sales
					.aggregate([{ $facet: { none: [{ $match: { cat: "nope" } }] } }])
					.toArray();

				expect(out[0]?.none).toEqual([]);
			});

			test("a later stage reads the facet document", async () => {
				await seed();
				const out = await sales
					.aggregate([
						{ $facet: { all: [{ $match: {} }] } },
						{ $project: { _id: 0, howMany: { $size: "$all" } } },
					])
					.toArray();

				expect(out).toEqual([{ howMany: 4 }]);
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
