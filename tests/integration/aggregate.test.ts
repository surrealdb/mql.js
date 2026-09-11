/**
 * `Collection.aggregate()` against a real server.
 *
 * The expectations here are MongoDB's answers, not SurrealDB's. Where the two
 * differ the difference is the point of the test — `$unwind` is the clearest
 * case, because SurrealDB's `SPLIT` emits rows for an empty array and for a
 * missing field where MongoDB emits none, and a driver that passed `SPLIT`
 * through would return extra documents rather than an error.
 *
 * `tests/unit/aggregate-translate.test.ts` covers the statement shapes; this
 * covers what comes back.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import type { Collection, Db, MongoClient } from "../../src/index.ts";
import type { Document } from "../../src/types.ts";
import { setupSurreal, teardownSurreal } from "./helpers.ts";

const PORT = 18148;

interface Sale extends Document {
	_id?: string;
	cat?: string;
	sub?: string;
	price?: number;
	qty?: number;
	tags?: unknown;
}

let proc: Subprocess;
let client: MongoClient;
let db: Db;
let sales: Collection<Sale>;

beforeAll(async () => {
	const ctx = await setupSurreal<Sale>(PORT, "aggdb");
	proc = ctx.process;
	client = ctx.client;
	db = ctx.db;

	sales = db.collection<Sale>("sales");
	await sales.insertMany([
		{ _id: "1", cat: "a", sub: "x", price: 10, qty: 2, tags: ["p", "q"] },
		{ _id: "2", cat: "a", sub: "y", price: 20, qty: 1, tags: ["q"] },
		{ _id: "3", cat: "b", sub: "x", price: 30, qty: 5, tags: ["p"] },
		{ _id: "4", cat: "b", sub: "x", price: 40, qty: 3, tags: [] },
	]);
});

afterAll(async () => {
	await teardownSurreal({ process: proc, client } as never);
});

describe("the cursor", () => {
	test("comes back synchronously, so .toArray() is reachable on the result", () => {
		// The shape mongoose and every other wrapper depends on: a promise here
		// would make `.toArray` undefined.
		const cursor = sales.aggregate([{ $match: {} }]);
		expect(typeof cursor.toArray).toBe("function");
	});

	test("sends nothing until it is consumed", async () => {
		const cursor = sales.aggregate([{ $count: "n" }]);
		expect(cursor.closed).toBe(false);
		expect(await cursor.toArray()).toEqual([{ n: 4 }]);
	});

	test("iterates", async () => {
		const seen: unknown[] = [];
		for await (const doc of sales.aggregate([
			{ $group: { _id: "$cat", n: { $sum: 1 } } },
			{ $sort: { _id: 1 } },
		])) {
			seen.push(doc);
		}
		expect(seen).toEqual([
			{ _id: "a", n: 2 },
			{ _id: "b", n: 2 },
		]);
	});

	test("rejects once closed", async () => {
		const cursor = sales.aggregate([{ $match: {} }]);
		await cursor.close();
		await expect(cursor.toArray()).rejects.toThrow();
	});
});

describe("$group", () => {
	test("sums, counts and averages per key", async () => {
		expect(
			await sales
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
				.toArray(),
		).toEqual([
			{ _id: "a", total: 30, n: 2, avg: 15, lo: 10, hi: 20 },
			{ _id: "b", total: 70, n: 2, avg: 35, lo: 30, hi: 40 },
		]);
	});

	test("_id: null collapses to one document", async () => {
		// The case `GROUP ALL` gets wrong: it returns `_id` as one null per row.
		expect(
			await sales
				.aggregate([{ $group: { _id: null, total: { $sum: "$price" } } }])
				.toArray(),
		).toEqual([{ _id: null, total: 100 }]);
	});

	test("a compound _id comes back as the document it was written as", async () => {
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

	test("$push keeps duplicates and $addToSet does not", async () => {
		expect(
			await sales
				.aggregate([
					{
						$group: {
							_id: "$cat",
							all: { $push: "$sub" },
							uniq: { $addToSet: "$sub" },
						},
					},
					{ $sort: { _id: 1 } },
				])
				.toArray(),
		).toEqual([
			{ _id: "a", all: ["x", "y"], uniq: ["x", "y"] },
			{ _id: "b", all: ["x", "x"], uniq: ["x"] },
		]);
	});

	test("an expression inside an accumulator is evaluated per row", async () => {
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

	test("$stdDevSamp and $stdDevPop", async () => {
		// cat a: [10, 20], cat b: [30, 40] — same spread in both, so sample and
		// population disagree by the same factor for each.
		const docs = await sales
			.aggregate([
				{
					$group: {
						_id: "$cat",
						samp: { $stdDevSamp: "$price" },
						pop: { $stdDevPop: "$price" },
					},
				},
				{ $sort: { _id: 1 } },
			])
			.toArray();
		for (const doc of docs) {
			expect(doc.samp).toBeCloseTo(Math.sqrt(50));
			expect(doc.pop).toBeCloseTo(5);
		}
		expect(docs.map((d) => d._id)).toEqual(["a", "b"]);
	});

	test("$maxN and $minN take the largest and smallest, in either order", async () => {
		expect(
			await sales
				.aggregate([
					{
						$group: {
							_id: "$cat",
							top: { $maxN: { input: "$price", n: 1 } },
							bottom: { $minN: { input: "$price", n: 1 } },
						},
					},
					{ $sort: { _id: 1 } },
				])
				.toArray(),
		).toEqual([
			{ _id: "a", top: [20], bottom: [10] },
			{ _id: "b", top: [40], bottom: [30] },
		]);
	});

	test("$firstN and $lastN follow document order, made deterministic by a $sort before $group", async () => {
		expect(
			await sales
				.aggregate([
					{ $sort: { price: 1 } },
					{
						$group: {
							_id: "$cat",
							firsts: { $firstN: { input: "$price", n: 1 } },
							lasts: { $lastN: { input: "$price", n: 1 } },
						},
					},
					{ $sort: { _id: 1 } },
				])
				.toArray(),
		).toEqual([
			{ _id: "a", firsts: [10], lasts: [20] },
			{ _id: "b", firsts: [30], lasts: [40] },
		]);
	});
});

describe("$match", () => {
	test("before a $group filters the rows going in", async () => {
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

	test("after a $group filters the groups, as a HAVING", async () => {
		expect(
			await sales
				.aggregate([
					{ $match: { price: { $gte: 20 } } },
					{ $group: { _id: "$cat", n: { $sum: 1 } } },
					{ $match: { n: { $gt: 1 } } },
				])
				.toArray(),
		).toEqual([{ _id: "b", n: 2 }]);
	});

	test("on _id after a $group matches the group key, not a record id", async () => {
		expect(
			await sales
				.aggregate([
					{ $group: { _id: "$cat", n: { $sum: 1 } } },
					{ $match: { _id: "a" } },
				])
				.toArray(),
		).toEqual([{ _id: "a", n: 2 }]);
	});

	test("on _id over stored rows still matches the record id", async () => {
		const [doc] = await sales.aggregate([{ $match: { _id: "2" } }]).toArray();
		expect(doc?._id).toBe("2");
		expect(doc?.price).toBe(20);
	});
});

describe("$unwind", () => {
	test("emits one document per array element", async () => {
		expect(
			await sales
				.aggregate([
					{ $match: { _id: "1" } },
					{ $unwind: "$tags" },
					{ $project: { tags: 1, _id: 0 } },
				])
				.toArray(),
		).toEqual([{ tags: "p" }, { tags: "q" }]);
	});

	test("drops a document whose array is empty, as MongoDB does", async () => {
		// SurrealDB's SPLIT emits a row here. Document 4 has `tags: []`.
		const out = await sales
			.aggregate([
				{ $unwind: "$tags" },
				{ $group: { _id: "$tags", n: { $sum: 1 } } },
				{ $sort: { _id: 1 } },
			])
			.toArray();
		expect(out).toEqual([
			{ _id: "p", n: 2 },
			{ _id: "q", n: 2 },
		]);
	});

	test("drops a document with no such field, as MongoDB does", async () => {
		await sales.insertOne({ _id: "5", cat: "c", price: 50 });
		try {
			const out = await sales.aggregate([{ $unwind: "$tags" }]).toArray();
			expect(out.every((doc) => doc.cat !== "c")).toBe(true);
		} finally {
			await sales.deleteOne({ _id: "5" });
		}
	});

	test("keeps a present non-array value, as MongoDB does", async () => {
		await sales.insertOne({ _id: "6", cat: "d", tags: "scalar" });
		try {
			const out = await sales
				.aggregate([{ $unwind: "$tags" }, { $match: { cat: "d" } }])
				.toArray();
			expect(out).toHaveLength(1);
			expect(out[0]?.tags).toBe("scalar");
		} finally {
			await sales.deleteOne({ _id: "6" });
		}
	});

	test("preserveNullAndEmptyArrays keeps what the default drops", async () => {
		const out = await sales
			.aggregate([
				{ $unwind: { path: "$tags", preserveNullAndEmptyArrays: true } },
				{ $match: { _id: "4" } },
			])
			.toArray();
		expect(out).toHaveLength(1);
	});
});

describe("$project", () => {
	test("includes _id unless it is suppressed", async () => {
		const [withId] = await sales
			.aggregate([{ $match: { _id: "1" } }, { $project: { cat: 1 } }])
			.toArray();
		expect(withId).toEqual({ _id: "1", cat: "a" });

		const [withoutId] = await sales
			.aggregate([{ $match: { _id: "1" } }, { $project: { cat: 1, _id: 0 } }])
			.toArray();
		expect(withoutId).toEqual({ cat: "a" });
	});

	test("excludes a field other than _id, not just _id", async () => {
		// The bug this replaces: exclusion only ever OMITted a column literally
		// named `_id`, which does not exist on a stored row — so excluding
		// anything else silently did nothing.
		const [doc] = await sales
			.aggregate([{ $match: { _id: "1" } }, { $project: { price: 0 } }])
			.toArray();
		expect(doc).toEqual({
			_id: "1",
			cat: "a",
			sub: "x",
			qty: 2,
			tags: ["p", "q"],
		});
	});

	test("$unset excludes a field by name, or a list of them", async () => {
		const [oneField] = await sales
			.aggregate([{ $match: { _id: "1" } }, { $unset: "price" }])
			.toArray();
		expect(oneField).toEqual({
			_id: "1",
			cat: "a",
			sub: "x",
			qty: 2,
			tags: ["p", "q"],
		});

		const [severalFields] = await sales
			.aggregate([
				{ $match: { _id: "1" } },
				{ $unset: ["price", "qty", "tags"] },
			])
			.toArray();
		expect(severalFields).toEqual({ _id: "1", cat: "a", sub: "x" });
	});

	test("computes a field from an expression", async () => {
		expect(
			await sales
				.aggregate([
					{ $match: { _id: "1" } },
					{ $project: { _id: 0, revenue: { $multiply: ["$price", "$qty"] } } },
				])
				.toArray(),
		).toEqual([{ revenue: 20 }]);
	});

	test("$cond picks a branch per document", async () => {
		expect(
			await sales
				.aggregate([
					{
						$project: {
							_id: 1,
							band: { $cond: [{ $gte: ["$price", 25] }, "high", "low"] },
						},
					},
					{ $sort: { _id: 1 } },
				])
				.toArray(),
		).toEqual([
			{ _id: "1", band: "low" },
			{ _id: "2", band: "low" },
			{ _id: "3", band: "high" },
			{ _id: "4", band: "high" },
		]);
	});

	test("$ifNull falls through only for a missing value", async () => {
		await sales.insertOne({ _id: "7", cat: "e", price: 0 });
		try {
			expect(
				await sales
					.aggregate([
						{ $match: { _id: "7" } },
						{
							$project: {
								_id: 0,
								// `0` is present, so it wins; `sub` is absent, so it does not.
								price: { $ifNull: ["$price", -1] },
								sub: { $ifNull: ["$sub", "none"] },
							},
						},
					])
					.toArray(),
			).toEqual([{ price: 0, sub: "none" }]);
		} finally {
			await sales.deleteOne({ _id: "7" });
		}
	});
});

describe("paging", () => {
	test("$skip then $limit takes the window MongoDB takes", async () => {
		expect(
			await sales
				.aggregate([
					{ $sort: { price: 1 } },
					{ $skip: 1 },
					{ $limit: 2 },
					{ $project: { price: 1, _id: 0 } },
				])
				.toArray(),
		).toEqual([{ price: 20 }, { price: 30 }]);
	});

	test("$limit then $skip discards from the page, not before it", async () => {
		expect(
			await sales
				.aggregate([
					{ $sort: { price: 1 } },
					{ $limit: 2 },
					{ $skip: 1 },
					{ $project: { price: 1, _id: 0 } },
				])
				.toArray(),
		).toEqual([{ price: 20 }]);
	});
});

describe("$sample", () => {
	test("returns the requested number of documents, drawn from the collection", async () => {
		const docs = await sales.aggregate([{ $sample: { size: 2 } }]).toArray();
		expect(docs.length).toBe(2);
		for (const doc of docs) {
			expect(["1", "2", "3", "4"]).toContain(doc._id as string);
		}
	});

	test("returns at most as many documents as exist", async () => {
		const docs = await sales.aggregate([{ $sample: { size: 100 } }]).toArray();
		expect(docs.length).toBe(4);
	});
});

describe("$out and $merge", () => {
	test("$out replaces the target collection wholesale", async () => {
		const out = db.collection<Sale & { total?: number }>("sales_out");
		try {
			await out.insertOne({ _id: "stale", cat: "z" });
			await sales
				.aggregate([
					{ $group: { _id: "$cat", total: { $sum: "$price" } } },
					{ $sort: { _id: 1 } },
					{ $out: "sales_out" },
				])
				.toArray();
			expect(await out.find({}).sort({ _id: 1 }).toArray()).toEqual([
				{ _id: "a", total: 30 },
				{ _id: "b", total: 70 },
			]);
		} finally {
			await out.deleteMany({});
		}
	});

	test("$merge upserts by _id, merging fields with the existing document by default", async () => {
		const target = db.collection<Sale & { total?: number }>("sales_merge");
		try {
			await target.insertOne({ _id: "a", cat: "existing", price: 999 });
			await sales
				.aggregate([
					{ $group: { _id: "$cat", total: { $sum: "$price" } } },
					{ $match: { _id: "a" } },
					{ $merge: { into: "sales_merge" } },
				])
				.toArray();
			const [merged] = await target.find({ _id: "a" }).toArray();
			expect(merged).toEqual({
				_id: "a",
				cat: "existing",
				price: 999,
				total: 30,
			});
		} finally {
			await target.deleteMany({});
		}
	});

	test("$merge with whenMatched: replace overwrites the whole document", async () => {
		const target = db.collection<Sale & { total?: number }>(
			"sales_merge_replace",
		);
		try {
			await target.insertOne({ _id: "a", cat: "existing", price: 999 });
			await sales
				.aggregate([
					{ $group: { _id: "$cat", total: { $sum: "$price" } } },
					{ $match: { _id: "a" } },
					{
						$merge: { into: "sales_merge_replace", whenMatched: "replace" },
					},
				])
				.toArray();
			const [merged] = await target.find({ _id: "a" }).toArray();
			expect(merged).toEqual({ _id: "a", total: 30 });
		} finally {
			await target.deleteMany({});
		}
	});

	test("$merge inserts documents that have no existing match", async () => {
		const target = db.collection<Sale & { total?: number }>(
			"sales_merge_insert",
		);
		try {
			await sales
				.aggregate([
					{ $group: { _id: "$cat", total: { $sum: "$price" } } },
					{ $sort: { _id: 1 } },
					{ $merge: { into: "sales_merge_insert" } },
				])
				.toArray();
			expect(await target.find({}).sort({ _id: 1 }).toArray()).toEqual([
				{ _id: "a", total: 30 },
				{ _id: "b", total: 70 },
			]);
		} finally {
			await target.deleteMany({});
		}
	});

	test("$out and $merge must be the final stage", async () => {
		await expect(
			sales.aggregate([{ $out: "sales_out" }, { $match: {} }]).toArray(),
		).rejects.toThrow(/\$out must be the final stage/);
	});
});

describe("expression operators", () => {
	test("$reduce folds an array with an initial value", async () => {
		const [doc] = await sales
			.aggregate([
				{ $match: { _id: "1" } },
				{
					$project: {
						_id: 0,
						total: {
							$reduce: {
								input: "$tags",
								initialValue: "",
								in: { $concat: ["$$value", "$$this"] },
							},
						},
					},
				},
			])
			.toArray();
		expect(doc).toEqual({ total: "pq" });
	});

	test("$objectToArray and $arrayToObject round-trip a document", async () => {
		const [doc] = await sales
			.aggregate([
				{ $match: { _id: "1" } },
				{
					$project: {
						_id: 0,
						pairs: { $objectToArray: { c: "$cat", s: "$sub" } },
					},
				},
				{
					$project: {
						_id: 0,
						roundTripped: { $arrayToObject: "$pairs" },
					},
				},
			])
			.toArray();
		expect(doc).toEqual({ roundTripped: { c: "a", s: "x" } });
	});

	test("the $set family treats arrays as sets", async () => {
		const [doc] = await sales
			.aggregate([
				{ $match: { _id: "1" } },
				{
					$project: {
						_id: 0,
						union: {
							$setUnion: [
								["p", "q"],
								["q", "r"],
							],
						},
						intersection: {
							$setIntersection: [
								["p", "q"],
								["q", "r"],
							],
						},
						difference: {
							$setDifference: [
								["p", "q"],
								["q", "r"],
							],
						},
						equal: {
							$setEquals: [
								["p", "q"],
								["q", "p", "p"],
							],
						},
						subset: { $setIsSubset: [["q"], "$tags"] },
					},
				},
			])
			.toArray();
		expect(doc).toEqual({
			union: ["p", "q", "r"],
			intersection: ["q"],
			difference: ["p"],
			equal: true,
			subset: true,
		});
	});

	test("$dateAdd, $dateDiff and $dateTrunc", async () => {
		await sales.updateOne(
			{ _id: "1" },
			{ $set: { when: new Date("2024-01-01T00:00:00Z") } },
		);
		try {
			const [doc] = await sales
				.aggregate([
					{ $match: { _id: "1" } },
					{
						$project: {
							_id: 0,
							later: {
								$dateAdd: { startDate: "$when", unit: "day", amount: 5 },
							},
							earlier: {
								$dateAdd: { startDate: "$when", unit: "day", amount: -5 },
							},
							diff: {
								$dateDiff: {
									startDate: "$when",
									endDate: new Date("2024-01-03T12:00:00Z"),
									unit: "hour",
								},
							},
							trunc: {
								$dateTrunc: {
									date: new Date("2024-01-01T13:47:00Z"),
									unit: "hour",
								},
							},
						},
					},
				])
				.toArray();
			expect(doc).toEqual({
				later: new Date("2024-01-06T00:00:00Z"),
				earlier: new Date("2023-12-27T00:00:00Z"),
				diff: 60,
				trunc: new Date("2024-01-01T13:00:00Z"),
			});
		} finally {
			await sales.updateOne({ _id: "1" }, { $unset: { when: "" } });
		}
	});

	test("$replaceAll and $convert", async () => {
		const [doc] = await sales
			.aggregate([
				{ $match: { _id: "1" } },
				{
					$project: {
						_id: 0,
						replaced: {
							$replaceAll: { input: "$sub", find: "x", replacement: "y" },
						},
						converted: { $convert: { input: "$qty", to: "string" } },
					},
				},
			])
			.toArray();
		expect(doc).toEqual({ replaced: "y", converted: "2" });
	});
});

describe("refusals reach the caller", () => {
	test("an unimplemented stage names itself", async () => {
		await expect(
			sales.aggregate([{ $unionWith: "other" }]).toArray(),
		).rejects.toThrow(/\$unionWith is not implemented/);
	});

	test("Db.aggregate() still refuses, and says which one works", () => {
		expect(() => db.aggregate([{ $match: {} }])).toThrow(
			/db\.collection\(name\)\.aggregate/,
		);
	});
});
