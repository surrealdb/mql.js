/**
 * `signal`, against a real server.
 *
 * MongoDB's driver takes an `AbortSignal` on `find`, `findOne`,
 * `countDocuments`, `aggregate`, `Db.command` and `listCollections`, and on the
 * cursors three of them return. The contract is the same everywhere: a signal
 * that has aborted sends nothing and rejects with *its own reason*, and one that
 * aborts mid-operation rejects with it too.
 *
 * What a live server adds is whether the connection survives it, and — from
 * SurrealDB 3.3.0 over a WebSocket — whether the statement is stopped there. The
 * first is asserted on every version. The second cannot be observed from here,
 * only that nothing is left broken, and an abort that arrives too late to matter
 * is allowed to lose the race.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import type { Collection, Db, MongoClient } from "../../src/index.ts";
import { MongoCompatibilityError } from "../../src/index.ts";
import type { Document } from "../../src/types.ts";
import { setupSurreal, teardownSurreal } from "./helpers.ts";

const PORT = 18746;

interface Item extends Document {
	_id?: number;
	n?: number;
	group?: string;
}

let proc: Subprocess;
let client: MongoClient;
let db: Db;
let items: Collection<Item>;

const SIZE = 2000;

beforeAll(async () => {
	const ctx = await setupSurreal<Item>(PORT, "abortdb");
	proc = ctx.process;
	client = ctx.client;
	db = ctx.db;

	items = db.collection<Item>("items");
	await items.insertMany(
		Array.from({ length: SIZE }, (_, i) => ({
			_id: i,
			n: i,
			group: `g${i % 4}`,
		})),
	);
});

afterAll(async () => {
	await teardownSurreal({ process: proc, client } as never);
});

/** A signal that has already aborted with `reason`. */
function aborted(reason: unknown = new Error("stop")): AbortSignal {
	const controller = new AbortController();
	controller.abort(reason);
	return controller.signal;
}

describe("an already-aborted signal", () => {
	test("rejects find() with its reason, whichever way the cursor is read", async () => {
		const reason = new Error("custom reason");
		const signal = aborted(reason);

		await expect(items.find({}, { signal }).toArray()).rejects.toBe(reason);
		await expect(items.find({}, { signal }).next()).rejects.toBe(reason);
		await expect(items.find({}, { signal }).hasNext()).rejects.toBe(reason);
		await expect(
			(async () => {
				for await (const _ of items.find({}, { signal })) break;
			})(),
		).rejects.toBe(reason);
	});

	test("rejects findOne, countDocuments and aggregate with its reason", async () => {
		const reason = new Error("custom reason");
		const signal = aborted(reason);

		await expect(items.findOne({}, { signal })).rejects.toBe(reason);
		await expect(items.countDocuments({}, { signal })).rejects.toBe(reason);
		await expect(
			items.aggregate([{ $match: {} }], { signal }).toArray(),
		).rejects.toBe(reason);
		await expect(
			items.aggregate([{ $match: {} }], { signal }).next(),
		).rejects.toBe(reason);
	});

	test("rejects Db.command and listCollections with its reason", async () => {
		const reason = new Error("custom reason");
		const signal = aborted(reason);

		await expect(db.command({ ping: 1 }, { signal })).rejects.toBe(reason);
		await expect(db.listCollections({}, { signal }).toArray()).rejects.toBe(
			reason,
		);
	});

	test("the reason is the signal's own, so a timeout reads as a TimeoutError", async () => {
		const signal = AbortSignal.timeout(1);
		await new Promise((resolve) => setTimeout(resolve, 20));

		const err = await items.countDocuments({}, { signal }).catch((e) => e);
		expect((err as Error).name).toBe("TimeoutError");
	});

	test("an abort with no reason rejects with the AbortError the platform supplies", async () => {
		const controller = new AbortController();
		controller.abort();
		const err = await items
			.findOne({}, { signal: controller.signal })
			.catch((e) => e);
		expect((err as Error).name).toBe("AbortError");
	});

	test("leaves the connection usable", async () => {
		await expect(
			items.countDocuments({}, { signal: aborted() }),
		).rejects.toBeDefined();
		expect(await items.countDocuments({})).toBe(SIZE);
	});
});

describe("a signal that does not abort", () => {
	test("changes nothing about the answer", async () => {
		const controller = new AbortController();
		const { signal } = controller;

		expect((await items.find({}, { signal }).toArray()).length).toBe(SIZE);
		expect((await items.findOne({ n: 5 }, { signal }))?.n).toBe(5);
		expect(await items.countDocuments({ group: "g1" }, { signal })).toBe(
			SIZE / 4,
		);
		expect(
			(await items.aggregate([{ $match: { n: 1 } }], { signal }).toArray())
				.length,
		).toBe(1);
		expect(
			(await db.listCollections({}, { signal }).toArray()).map((c) => c.name),
		).toContain("items");
		expect((await db.command({ ping: 1 }, { signal })).ok).toBe(1);
	});
});

describe("aborting a cursor part way", () => {
	test("closes it, and every read after reports the reason", async () => {
		const reason = new Error("enough");
		const controller = new AbortController();
		const cursor = items.find({}, { signal: controller.signal }).sort({ n: 1 });

		expect((await cursor.next())?.n).toBe(0);
		expect((await cursor.next())?.n).toBe(1);
		controller.abort(reason);

		await expect(cursor.next()).rejects.toBe(reason);
		await expect(cursor.hasNext()).rejects.toBe(reason);
		expect(cursor.closed).toBe(true);
		// The stream it held was released: the connection answers.
		expect(await items.countDocuments({})).toBe(SIZE);
	});

	test("a for await is told after the document in hand, not handed the next", async () => {
		const reason = new Error("enough");
		const controller = new AbortController();
		const seen: unknown[] = [];

		await expect(
			(async () => {
				for await (const doc of items.find({}, { signal: controller.signal })) {
					seen.push(doc.n);
					controller.abort(reason);
				}
			})(),
		).rejects.toBe(reason);
		expect(seen).toHaveLength(1);
		expect(await items.countDocuments({})).toBe(SIZE);
	});

	test("an aggregation cursor is closed the same way", async () => {
		const reason = new Error("enough");
		const controller = new AbortController();
		const cursor = items.aggregate([{ $match: {} }], {
			signal: controller.signal,
		});
		await cursor.next();
		controller.abort(reason);
		await expect(cursor.next()).rejects.toBe(reason);
		expect(cursor.closed).toBe(true);
		expect(await items.countDocuments({})).toBe(SIZE);
	});

	test("aborting a cursor nobody has read leaves nothing open", async () => {
		const controller = new AbortController();
		const cursor = items.find({}, { signal: controller.signal });
		controller.abort(new Error("never mind"));
		await Promise.resolve();
		await Promise.resolve();
		expect(cursor.closed).toBe(true);
		expect(await items.countDocuments({})).toBe(SIZE);
	});
});

describe("aborting while a statement is in flight", () => {
	/**
	 * Whether the abort lands before the statement finishes is a race this test
	 * does not control — the server may simply be quicker. So it asserts what holds
	 * either way: if it rejected, it was with the reason, and nothing is broken.
	 */
	test("rejects with the reason, or finished first, and either way the connection is fine", async () => {
		const reason = new Error("too slow");
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const controller = new AbortController();
			const running = items
				.aggregate(
					[
						{ $group: { _id: "$group", total: { $sum: "$n" } } },
						{ $sort: { _id: 1 } },
					],
					{ signal: controller.signal },
				)
				.toArray();
			setTimeout(() => controller.abort(reason), attempt);

			const outcome = await running.then(
				(rows) => ({ rows }),
				(err: unknown) => ({ err }),
			);
			if ("err" in outcome) expect(outcome.err).toBe(reason);
			else expect(outcome.rows.length).toBe(4);
		}
		expect(await items.countDocuments({})).toBe(SIZE);
	});
});

describe("inside a transaction", () => {
	test("a signal is refused, since a statement sent to a transaction cannot be taken back", async () => {
		const session = client.startSession();
		try {
			session.startTransaction();
			const controller = new AbortController();

			await expect(
				items.find({}, { session, signal: controller.signal }).toArray(),
			).rejects.toThrow(MongoCompatibilityError);
			await expect(
				items.countDocuments({}, { session, signal: controller.signal }),
			).rejects.toThrow(/cannot be stopped/);

			// The same read without a signal is fine, and the transaction is intact.
			expect(
				(await items.find({}, { session }).limit(1).toArray()).length,
			).toBe(1);
			await session.commitTransaction();
		} finally {
			await session.endSession();
		}
	});
});

describe("operations that take no signal", () => {
	test("a write ignores one, as it does in MongoDB's types", async () => {
		const scratch = db.collection<Item>("abort_writes");
		await scratch.insertOne({ _id: 1, n: 1 }, { signal: aborted() } as never);
		expect(await scratch.countDocuments({})).toBe(1);
		await scratch.drop();
	});
});

describe("something that is not a signal", () => {
	test("is refused where the call is made, as the operation's own mistake", async () => {
		const bad = "abort" as never;
		expect(() => items.find({}, { signal: bad })).toThrow(/AbortSignal/);
		expect(() => items.aggregate([], { signal: bad })).toThrow(/AbortSignal/);
		expect(() => db.listCollections({}, { signal: bad })).toThrow(
			/AbortSignal/,
		);
		await expect(items.findOne({}, { signal: bad })).rejects.toThrow(
			/AbortSignal/,
		);
		await expect(items.countDocuments({}, { signal: bad })).rejects.toThrow(
			/AbortSignal/,
		);
		await expect(db.command({ ping: 1 }, { signal: bad })).rejects.toThrow(
			/AbortSignal/,
		);
	});
});
