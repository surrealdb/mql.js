/**
 * `insertMany` when part of the batch is refused, against a real server.
 *
 * MongoDB does not treat a batch as one write, and the difference is visible in
 * the collection afterwards rather than only in the error: `ordered: true` keeps
 * every document before the refusal, `ordered: false` keeps every success. The
 * expectations below are what a real `mongod` did for the same seven scenarios,
 * measured rather than assumed — documents present, `code`, `writeErrors`
 * indexes, `insertedCount` and `insertedIds` all agreed with it.
 *
 * This runs against a live server because the claim is about what survives in the
 * collection, which no string assertion can establish. A batch is a single
 * SurrealDB statement and therefore a single transaction, so the whole thing
 * hinges on the driver re-issuing it per document — and on separate statements in
 * one query each getting their own implicit transaction.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import type { Collection, Db, MongoClient } from "../../src/index.ts";
import { MongoBulkWriteError } from "../../src/index.ts";
import type { Document } from "../../src/types.ts";
import { setupSurreal, teardownSurreal } from "./helpers.ts";

const PORT = 18145;

interface Doc extends Document {
	_id?: string;
	n?: number;
}

let proc: Subprocess;
let client: MongoClient;
let db: Db;
let sequence = 0;

/** A collection of its own per test: the server keeps data between them. */
async function fresh(seed: Doc[] = []): Promise<Collection<Doc>> {
	sequence += 1;
	const coll = db.collection<Doc>(`batch_${sequence}`);
	for (const doc of seed) await coll.insertOne(doc);
	return coll;
}

/** The `_id`s present, sorted, which is what "what survived" means here. */
async function present(coll: Collection<Doc>): Promise<string[]> {
	const rows = await coll.find({}).toArray();
	return rows.map((row) => String(row._id)).sort();
}

beforeAll(async () => {
	const ctx = await setupSurreal<Doc>(PORT, "batchdb");
	proc = ctx.process;
	client = ctx.client;
	db = ctx.db;
});

afterAll(async () => {
	await teardownSurreal({ process: proc, client } as never);
});

describe("a batch with no refusals", () => {
	test("inserts everything and reports every id", async () => {
		const coll = await fresh();
		const result = await coll.insertMany([
			{ _id: "a", n: 1 },
			{ _id: "b", n: 2 },
		]);

		expect(result.insertedCount).toBe(2);
		expect(await present(coll)).toEqual(["a", "b"]);
	});
});

describe("ordered (the default): stop at the refusal, keep what came before", () => {
	test("a duplicate in the middle keeps the documents before it", async () => {
		const coll = await fresh([{ _id: "dup", n: 0 }]);

		const err = (await coll
			.insertMany([
				{ _id: "a1", n: 1 },
				{ _id: "dup", n: 2 },
				{ _id: "a2", n: 3 },
			])
			.catch((e) => e)) as MongoBulkWriteError;

		expect(err).toBeInstanceOf(MongoBulkWriteError);
		expect(err.code).toBe(11000);
		expect(err.writeErrors.map((w) => w.index)).toEqual([1]);
		expect(err.insertedCount).toBe(1);
		expect(err.insertedIds).toEqual({ 0: "a1" });
		// `a2` is *not* here: ordered stops rather than skipping.
		expect(await present(coll)).toEqual(["a1", "dup"]);
	});

	test("`ordered: true` written out behaves the same as the default", async () => {
		const coll = await fresh([{ _id: "dup", n: 0 }]);

		await expect(
			coll.insertMany(
				[
					{ _id: "a1", n: 1 },
					{ _id: "dup", n: 2 },
					{ _id: "a2", n: 3 },
				],
				{ ordered: true },
			),
		).rejects.toBeInstanceOf(MongoBulkWriteError);

		expect(await present(coll)).toEqual(["a1", "dup"]);
	});

	test("a duplicate at index 0 keeps nothing", async () => {
		const coll = await fresh([{ _id: "c1", n: 0 }]);

		const err = (await coll
			.insertMany([
				{ _id: "c1", n: 1 },
				{ _id: "c2", n: 2 },
			])
			.catch((e) => e)) as MongoBulkWriteError;

		expect(err.writeErrors.map((w) => w.index)).toEqual([0]);
		expect(err.insertedCount).toBe(0);
		expect(err.insertedIds).toEqual({});
		expect(await present(coll)).toEqual(["c1"]);
	});

	test("two documents in the batch colliding with each other", async () => {
		// No pre-existing row: the collision is between index 0 and index 2.
		const coll = await fresh();

		const err = (await coll
			.insertMany([
				{ _id: "b1", n: 1 },
				{ _id: "b2", n: 2 },
				{ _id: "b1", n: 3 },
				{ _id: "b3", n: 4 },
			])
			.catch((e) => e)) as MongoBulkWriteError;

		expect(err.writeErrors.map((w) => w.index)).toEqual([2]);
		expect(err.insertedCount).toBe(2);
		expect(await present(coll)).toEqual(["b1", "b2"]);
	});
});

describe("unordered: attempt everything, keep every success", () => {
	test("a duplicate in the middle does not stop the ones after it", async () => {
		const coll = await fresh([{ _id: "dup", n: 0 }]);

		const err = (await coll
			.insertMany(
				[
					{ _id: "a1", n: 1 },
					{ _id: "dup", n: 2 },
					{ _id: "a2", n: 3 },
				],
				{ ordered: false },
			)
			.catch((e) => e)) as MongoBulkWriteError;

		expect(err).toBeInstanceOf(MongoBulkWriteError);
		expect(err.writeErrors.map((w) => w.index)).toEqual([1]);
		expect(err.insertedCount).toBe(2);
		expect(err.insertedIds).toEqual({ 0: "a1", 2: "a2" });
		expect(await present(coll)).toEqual(["a1", "a2", "dup"]);
	});

	test("every refusal is reported, in batch order", async () => {
		const coll = await fresh([
			{ _id: "d1", n: 0 },
			{ _id: "d2", n: 0 },
		]);

		const err = (await coll
			.insertMany(
				[
					{ _id: "a1", n: 1 },
					{ _id: "d1", n: 2 },
					{ _id: "a2", n: 3 },
					{ _id: "d2", n: 4 },
					{ _id: "a3", n: 5 },
				],
				{ ordered: false },
			)
			.catch((e) => e)) as MongoBulkWriteError;

		expect(err.writeErrors.map((w) => w.index)).toEqual([1, 3]);
		expect(err.writeErrors.map((w) => w.code)).toEqual([11000, 11000]);
		expect(err.insertedCount).toBe(3);
		expect(await present(coll)).toEqual(["a1", "a2", "a3", "d1", "d2"]);
	});

	test("a collision inside the batch leaves the first of the pair", async () => {
		const coll = await fresh();

		const err = (await coll
			.insertMany(
				[
					{ _id: "b1", n: 1 },
					{ _id: "b2", n: 2 },
					{ _id: "b1", n: 3 },
					{ _id: "b3", n: 4 },
				],
				{ ordered: false },
			)
			.catch((e) => e)) as MongoBulkWriteError;

		expect(err.writeErrors.map((w) => w.index)).toEqual([2]);
		expect(err.insertedCount).toBe(3);
		expect(await present(coll)).toEqual(["b1", "b2", "b3"]);
	});

	test("`ordered: false` is no longer refused as unsupported", async () => {
		const coll = await fresh();
		const result = await coll.insertMany(
			[
				{ _id: "u1", n: 1 },
				{ _id: "u2", n: 2 },
			],
			{ ordered: false },
		);
		expect(result.insertedCount).toBe(2);
	});
});

describe("what the error carries", () => {
	test("the top-level fields describe the first refusal", async () => {
		// A caller checking `err.code === 11000` without walking `writeErrors` still
		// gets a true answer about why the batch stopped.
		const coll = await fresh([{ _id: "dup", n: 0 }]);

		const err = (await coll
			.insertMany([
				{ _id: "dup", n: 1 },
				{ _id: "z", n: 2 },
			])
			.catch((e) => e)) as MongoBulkWriteError;

		expect(err.name).toBe("MongoBulkWriteError");
		expect(err.code).toBe(11000);
		expect(err.codeName).toBe("DuplicateKey");
		expect(err.keyValue).toEqual({ _id: "dup" });
		expect(err.message).toContain("E11000");
	});

	test("a numeric _id keeps its type in the report", async () => {
		// SurrealDB names the record it rejected as a string, which loses whether
		// the `_id` was `42` or `"42"`.
		const coll = await fresh([{ _id: 42 } as never]);

		const err = (await coll
			.insertMany([{ _id: 42 }, { _id: 43 }] as never)
			.catch((e) => e)) as MongoBulkWriteError;

		expect(err.keyValue).toEqual({ _id: 42 });
		expect(err.writeErrors[0]?.keyValue).toEqual({ _id: 42 });
	});
});

describe("inside a caller's transaction", () => {
	test("a failed batch keeps nothing, as MongoDB's does", async () => {
		const coll = await fresh([{ _id: "tx", n: 0 }]);
		const session = client.startSession();

		try {
			await session.withTransaction(async () => {
				await coll.insertMany(
					[
						{ _id: "t1", n: 1 },
						{ _id: "tx", n: 2 },
					],
					{ session },
				);
			});
			throw new Error("the transaction should not have committed");
		} catch (err) {
			expect((err as Error).message).not.toBe(
				"the transaction should not have committed",
			);
		} finally {
			await session.endSession();
		}

		// Neither `t1` nor anything else: the failure aborted the transaction.
		expect(await present(coll)).toEqual(["tx"]);
	});
});
