/**
 * Cursors read a document at a time, against a real server.
 *
 * From SurrealDB 3.3.0 a statement's rows can be sent as the server finds them,
 * and a cursor read with `next()`, `hasNext()`, `forEach()` or `for await` uses
 * that; an older server answers the same request in one piece. Everything here
 * asserts what a caller can *see*, which has to be identical either way — the
 * documents, their order, what happens at an error, and that a consumer which
 * leaves early leaves the connection usable — so the file runs on every
 * supported version, and CI runs it on 3.3.x where the stream is real.
 *
 * What it cannot show is *that* the rows streamed; the unit tests pin that the
 * adapter asks the SDK for a stream, and the SDK decides whether the server
 * can give one.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import type { Collection, Db, MongoClient } from "../../src/index.ts";
import type { Document } from "../../src/types.ts";
import { setupSurreal, teardownSurreal } from "./helpers.ts";

const PORT = 18745;

interface Item extends Document {
	_id?: number;
	n?: number;
	group?: string;
}

let proc: Subprocess;
let client: MongoClient;
let db: Db;
let items: Collection<Item>;

const SIZE = 3000;

beforeAll(async () => {
	const ctx = await setupSurreal<Item>(PORT, "streamdb");
	proc = ctx.process;
	client = ctx.client;
	db = ctx.db;

	items = db.collection<Item>("items");
	// Past one frame: the server frames 16 rows, doubling to 256, so a few
	// thousand is many frames and not one.
	await items.insertMany(
		Array.from({ length: SIZE }, (_, i) => ({
			_id: i,
			n: i,
			group: `g${i % 5}`,
		})),
	);
});

afterAll(async () => {
	await teardownSurreal({ process: proc, client } as never);
});

describe("find() read a document at a time", () => {
	test("next() walks the whole collection in order, then answers null", async () => {
		const cursor = items.find({}).sort({ n: 1 });
		for (const expected of [0, 1, 2]) {
			expect((await cursor.next())?.n).toBe(expected);
		}
		let count = 3;
		while ((await cursor.next()) !== null) count += 1;
		expect(count).toBe(SIZE);
		expect(await cursor.next()).toBeNull();
	});

	test("for await sees every document exactly once, across many frames", async () => {
		const seen = new Set<number>();
		let total = 0;
		for await (const doc of items.find({})) {
			seen.add(doc.n as number);
			total += 1;
		}
		expect(total).toBe(SIZE);
		expect(seen.size).toBe(SIZE);
	});

	test("hasNext() and next() agree, and the document hasNext() read is not lost", async () => {
		const cursor = items.find({}).sort({ n: 1 }).limit(3);
		const seen: unknown[] = [];
		while (await cursor.hasNext()) {
			expect(await cursor.hasNext()).toBe(true);
			seen.push((await cursor.next())?.n);
		}
		expect(seen).toEqual([0, 1, 2]);
	});

	test("forEach stops when the callback returns false", async () => {
		const seen: unknown[] = [];
		await items
			.find({})
			.sort({ n: 1 })
			// biome-ignore lint/suspicious/useIterableCallbackReturn: forEach() short-circuits on `false` per the MongoDB driver contract.
			.forEach((doc) => {
				seen.push(doc.n);
				return seen.length < 4;
			});
		expect(seen).toEqual([0, 1, 2, 3]);
	});

	test("filter, sort, skip, limit and projection all apply to the streamed read", async () => {
		const docs: unknown[] = [];
		for await (const doc of items
			.find({ group: "g1" })
			.sort({ n: -1 })
			.skip(2)
			.limit(3)
			.project({ n: 1, _id: 0 })) {
			docs.push(doc);
		}
		// g1 is n = 1, 6, 11, ... ; descending, skipping the two largest.
		const g1 = Array.from({ length: SIZE }, (_, i) => i).filter(
			(i) => i % 5 === 1,
		);
		const expected = g1
			.slice()
			.reverse()
			.slice(2, 5)
			.map((n) => ({ n }));
		expect(docs).toEqual(expected);
	});

	test("toArray() after some documents were read returns the rest", async () => {
		const cursor = items.find({}).sort({ n: 1 }).limit(10);
		await cursor.next();
		await cursor.next();
		const rest = await cursor.toArray();
		expect(rest.map((d) => d.n)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
	});

	test("map() applies to streamed documents", async () => {
		const cursor = items
			.find({})
			.sort({ n: 1 })
			.limit(2)
			.map((d) => ({ ...d, doubled: (d.n as number) * 2 }));
		expect((await cursor.next())?.doubled).toBe(0);
		expect((await cursor.next())?.doubled).toBe(2);
	});
});

describe("leaving a cursor early", () => {
	test("breaking out of for await leaves the connection usable", async () => {
		for await (const doc of items.find({})) {
			expect(doc).toBeDefined();
			break;
		}
		// The stream that was abandoned has not poisoned the connection.
		expect(await items.countDocuments({})).toBe(SIZE);
		expect((await items.findOne({ n: 7 }))?.n).toBe(7);
	});

	test("close() after one document leaves it usable, and the cursor refuses more", async () => {
		const cursor = items.find({});
		await cursor.next();
		await cursor.close();
		await expect(cursor.next()).rejects.toThrow();
		expect(await items.countDocuments({})).toBe(SIZE);
	});

	test("forEach returning false leaves it usable", async () => {
		// biome-ignore lint/suspicious/useIterableCallbackReturn: forEach() short-circuits on `false` per the MongoDB driver contract.
		await items.find({}).forEach(() => false);
		expect(await items.countDocuments({})).toBe(SIZE);
	});

	test("abandoning more cursors than the server allows streams open does not exhaust it", async () => {
		// The server allows 32 concurrent streams on a connection and a stream that
		// is abandoned has to give its slot back, or the 33rd cursor fails. 60 in
		// sequence is more than any slot count it could be leaking against.
		for (let i = 0; i < 60; i += 1) {
			const cursor = items.find({}).sort({ n: 1 });
			expect((await cursor.next())?.n).toBe(0);
			await cursor.close();
		}
		expect((await items.find({}).sort({ n: 1 }).next())?.n).toBe(0);
	});
});

describe("many cursors open at once", () => {
	test("more of them than the server allows streams are all answered", async () => {
		// MongoDB has no limit on open cursors. The server limits open streams, and
		// refuses the excess outright — which this driver answers by reading that
		// cursor whole rather than failing it. 100 is over any default.
		const cursors = Array.from({ length: 100 }, (_, i) =>
			items.find({ n: i }).sort({ n: 1 }),
		);
		const firsts = await Promise.all(cursors.map((cursor) => cursor.next()));
		expect(firsts.map((d) => d?.n)).toEqual(
			Array.from({ length: 100 }, (_, i) => i),
		);

		await Promise.all(cursors.map((cursor) => cursor.close()));
		// Closing them returned every slot.
		expect((await items.find({}).sort({ n: 1 }).next())?.n).toBe(0);
	});

	test("interleaved reads of two cursors do not cross", async () => {
		const evens = items.find({ group: "g0" }).sort({ n: 1 }).limit(3);
		const odds = items.find({ group: "g1" }).sort({ n: 1 }).limit(3);
		const out: unknown[] = [];
		for (let i = 0; i < 3; i += 1) {
			out.push((await evens.next())?.n, (await odds.next())?.n);
		}
		expect(out).toEqual([0, 1, 5, 6, 10, 11]);
	});
});

describe("a collection that does not exist", () => {
	test("reads as empty through every way of reading a cursor", async () => {
		const missing = db.collection<Item>("never_written_stream");
		expect(await missing.find({}).next()).toBeNull();
		expect(await missing.find({}).hasNext()).toBe(false);
		const seen: unknown[] = [];
		for await (const doc of missing.find({})) seen.push(doc);
		expect(seen).toEqual([]);
		await missing.find({}).forEach(() => {
			throw new Error("there is nothing to visit");
		});
	});

	test("an aggregation over it reads as empty too", async () => {
		const missing = db.collection<Item>("never_written_stream_agg");
		expect(await missing.aggregate([{ $match: {} }]).next()).toBeNull();
	});
});

describe("another database", () => {
	test("is read from that database, and the USE it is sent after is not a document", async () => {
		const other = client.db("streamdb_other");
		const there = other.collection<Item>("things");
		await there.insertMany([
			{ _id: 1, n: 10 },
			{ _id: 2, n: 20 },
		]);

		const seen: unknown[] = [];
		for await (const doc of there.find({}).sort({ n: 1 })) seen.push(doc);
		expect(seen).toEqual([
			{ _id: 1, n: 10 },
			{ _id: 2, n: 20 },
		]);
		// And the connected database is unchanged by having been away.
		expect((await items.find({}).sort({ n: 1 }).next())?.n).toBe(0);

		await there.drop();
	});
});

describe("aggregate() read a document at a time", () => {
	test("a pipeline streams: match, sort and project", async () => {
		const out: unknown[] = [];
		for await (const doc of items.aggregate([
			{ $match: { group: "g2" } },
			{ $sort: { n: 1 } },
			{ $limit: 3 },
			{ $project: { _id: 0, n: 1 } },
		])) {
			out.push(doc);
		}
		expect(out).toEqual([{ n: 2 }, { n: 7 }, { n: 12 }]);
	});

	test("a $group's documents carry the group key as _id", async () => {
		const cursor = items.aggregate([
			{ $group: { _id: "$group", total: { $sum: 1 } } },
			{ $sort: { _id: 1 } },
		]);
		const seen: unknown[] = [];
		while (await cursor.hasNext()) seen.push(await cursor.next());
		expect(seen).toEqual(
			["g0", "g1", "g2", "g3", "g4"].map((_id) => ({ _id, total: SIZE / 5 })),
		);
	});

	test("breaking out of an aggregation leaves the connection usable", async () => {
		for await (const doc of items.aggregate([{ $match: {} }])) {
			expect(doc).toBeDefined();
			break;
		}
		expect(await items.countDocuments({})).toBe(SIZE);
	});

	test("a $lookup, which reads a batch, still answers when read a document at a time", async () => {
		const owners = db.collection<Document>("stream_owners");
		await owners.insertMany([
			{ _id: "g0", label: "zero" },
			{ _id: "g1", label: "one" },
		]);
		const out: unknown[] = [];
		for await (const doc of items.aggregate([
			{ $match: { n: { $lt: 2 } } },
			{ $sort: { n: 1 } },
			{
				$lookup: {
					from: "stream_owners",
					localField: "group",
					foreignField: "_id",
					as: "owner",
				},
			},
			{
				$project: {
					_id: 0,
					n: 1,
					label: { $arrayElemAt: ["$owner.label", 0] },
				},
			},
		])) {
			out.push(doc);
		}
		expect(out).toEqual([
			{ n: 0, label: "zero" },
			{ n: 1, label: "one" },
		]);
		await owners.drop();
	});

	test("a pipeline ending in $out writes its target and yields no documents", async () => {
		const target = db.collection<Item>("stream_out");
		const cursor = items.aggregate([
			{ $match: { n: { $lt: 3 } } },
			{ $out: "stream_out" },
		]);
		expect(await cursor.next()).toBeNull();
		expect(await target.countDocuments({})).toBe(3);
		await target.drop();
	});
});

describe("a refusal surfaces from the first read", () => {
	test("find() with an operator that is not supported", async () => {
		const cursor = items.find({ n: { $notAnOperator: 1 } } as never);
		const viaNext = await cursor.next().catch((e: Error) => e);
		const viaArray = await items
			.find({ n: { $notAnOperator: 1 } } as never)
			.toArray()
			.catch((e: Error) => e);
		expect(viaNext).toBeInstanceOf(Error);
		// Streamed or whole, the caller is told the same thing.
		expect((viaNext as Error).constructor).toBe(
			(viaArray as Error).constructor,
		);
		expect((viaNext as Error).message).toBe((viaArray as Error).message);
	});

	test("aggregate() with a stage that is not supported", async () => {
		await expect(items.aggregate([{ $bucketAuto: {} }]).next()).rejects.toThrow(
			/\$bucketAuto is not implemented/,
		);
	});
});

describe("inside a transaction", () => {
	test("a cursor reads the transaction's own uncommitted writes", async () => {
		const scratch = db.collection<Item>("stream_txn");
		const session = client.startSession();
		try {
			session.startTransaction();
			await scratch.insertMany(
				[
					{ _id: 1, n: 1 },
					{ _id: 2, n: 2 },
				],
				{ session },
			);

			const seen: unknown[] = [];
			for await (const doc of scratch.find({}, { session }).sort({ n: 1 })) {
				seen.push(doc.n);
			}
			expect(seen).toEqual([1, 2]);
			await session.commitTransaction();
		} finally {
			await session.endSession();
		}
		expect(await scratch.countDocuments({})).toBe(2);
		await scratch.drop();
	});

	test("an abandoned cursor does not stall the commit", async () => {
		const scratch = db.collection<Item>("stream_txn_abandon");
		const session = client.startSession();
		try {
			session.startTransaction();
			await scratch.insertMany(
				[
					{ _id: 1, n: 1 },
					{ _id: 2, n: 2 },
				],
				{ session },
			);

			const cursor = scratch.find({}, { session }).sort({ n: 1 });
			expect((await cursor.next())?.n).toBe(1);
			// Not closed, not finished: the commit must still go through.
			await session.commitTransaction();
		} finally {
			await session.endSession();
		}
		expect(await scratch.countDocuments({})).toBe(2);
		await scratch.drop();
	});
});
