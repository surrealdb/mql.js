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

describe("refusals reach the caller", () => {
	test("an unimplemented stage names itself", async () => {
		await expect(
			sales.aggregate([{ $lookup: { from: "other", as: "joined" } }]).toArray(),
		).rejects.toThrow(/\$lookup is not implemented/);
	});

	test("Db.aggregate() still refuses, and says which one works", () => {
		expect(() => db.aggregate([{ $match: {} }])).toThrow(
			/db\.collection\(name\)\.aggregate/,
		);
	});
});
