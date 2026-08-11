/**
 * The per-operation option surface, against a live SurrealDB server.
 *
 * These options are all statement-shape decisions, and a fake executor can only
 * confirm that the shape is the one the driver meant to emit — not that SurrealDB
 * accepts it. Two of them cannot be verified any other way:
 *
 *   - `sort` puts an `ORDER BY` inside the subquery that names a single-document
 *     write's target, and SurrealDB rejects an `ORDER BY` naming an idiom the
 *     field list does not carry;
 *   - an `upsert` runs that subquery against a collection that does not exist
 *     yet, which SurrealDB refuses to read while MongoDB treats it as "no
 *     match";
 *   - `session` puts the statement in a transaction, and only a real server can
 *     show that the transaction is real — that an index defined in one is
 *     invisible outside it and gone after an abort.
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { MongoCompatibilityError, MongoServerError } from "../../src/errors.ts";
import type { Collection } from "../../src/index.ts";
import {
	type SurrealTestContext,
	setupSurreal,
	teardownSurreal,
} from "./helpers.ts";

interface Doc {
	[key: string]: unknown;
	_id?: unknown;
	k?: number;
	tag?: string;
	nested?: { d: number };
}

const PORT = 18136;

let ctx: SurrealTestContext<Doc>;
let col: Collection<Doc>;

beforeAll(async () => {
	ctx = await setupSurreal<Doc>(PORT);
});

afterAll(async () => {
	await teardownSurreal(ctx);
});

beforeEach(async () => {
	col = ctx.collection("op_options");
	try {
		await col.deleteMany({});
	} catch {
		// The collection may not exist yet.
	}
});

/** A collection name nothing has ever written to. */
function unwritten(): Collection<Doc> {
	return ctx.collection(
		`unwritten_${Date.now()}_${Math.random().toString(36).slice(2)}`,
	);
}

describe("sort", () => {
	beforeEach(async () => {
		await col.insertMany([
			{ k: 3, tag: "c", nested: { d: 3 } },
			{ k: 1, tag: "a", nested: { d: 1 } },
			{ k: 2, tag: "b", nested: { d: 2 } },
		]);
	});

	test("findOneAndUpdate modifies the lowest sorted document", async () => {
		const out = await col.findOneAndUpdate(
			{},
			{ $set: { hit: true } },
			{ sort: { k: 1 }, returnDocument: "after" },
		);
		expect(out?.tag).toBe("a");
	});

	test("findOneAndDelete removes the highest sorted document", async () => {
		const out = await col.findOneAndDelete({}, { sort: { k: -1 } });
		expect(out?.tag).toBe("c");
		expect(await col.countDocuments({})).toBe(2);
	});

	test("findOneAndReplace replaces the lowest sorted document", async () => {
		await col.findOneAndReplace(
			{ k: { $gte: 0 } },
			{ k: 9, tag: "z" },
			{ sort: { k: 1 } },
		);
		const remaining = (await col.find({}).toArray()).map((d) => d.tag).sort();
		expect(remaining).toEqual(["b", "c", "z"]);
	});

	test("replaceOne replaces the highest sorted document", async () => {
		await col.replaceOne(
			{ k: { $gte: 0 } },
			{ k: 9, tag: "z" },
			{
				sort: { k: -1 },
			},
		);
		const remaining = (await col.find({}).toArray()).map((d) => d.tag).sort();
		expect(remaining).toEqual(["a", "b", "z"]);
	});

	test("a nested sort path orders the lookup", async () => {
		const out = await col.findOneAndDelete({}, { sort: { "nested.d": -1 } });
		expect(out?.tag).toBe("c");
	});

	test("a multi-key sort orders the lookup", async () => {
		const out = await col.findOneAndDelete({}, { sort: { tag: -1, k: 1 } });
		expect(out?.tag).toBe("c");
	});

	test("sorting by _id needs no extra column", async () => {
		const first = await col.findOne({}, { sort: { _id: 1 } });
		const out = await col.findOneAndDelete({}, { sort: { _id: 1 } });
		expect(out?._id).toEqual(first?._id);
	});

	test("sort combines with hint and maxTimeMS", async () => {
		await col.createIndex({ k: 1 });
		const out = await col.findOneAndUpdate(
			{ k: { $gte: 0 } },
			{ $set: { hit: true } },
			{
				sort: { k: 1 },
				hint: "k_1",
				maxTimeMS: 30_000,
				returnDocument: "after",
			},
		);
		expect(out?.tag).toBe("a");
	});
});

describe("a collection that does not exist yet", () => {
	test("updateOne with upsert creates it", async () => {
		const target = unwritten();
		const result = await target.updateOne(
			{ email: "a@b.c" },
			{ $set: { n: 1 } },
			{ upsert: true },
		);
		expect(result.upsertedCount).toBe(1);
		expect(await target.findOne({ email: "a@b.c" })).toMatchObject({ n: 1 });
	});

	test("findOneAndUpdate with upsert creates it", async () => {
		const target = unwritten();
		const out = await target.findOneAndUpdate(
			{ email: "a@b.c" },
			{ $set: { n: 1 } },
			{ upsert: true, returnDocument: "after" },
		);
		expect(out).toMatchObject({ email: "a@b.c", n: 1 });
	});

	test("findOneAndReplace with upsert creates it", async () => {
		const target = unwritten();
		const out = await target.findOneAndReplace(
			{ k: 1 },
			{ k: 1, tag: "new" },
			{ upsert: true, returnDocument: "after" },
		);
		expect(out).toMatchObject({ k: 1, tag: "new" });
	});

	test("deleteOne reports no match rather than failing", async () => {
		const result = await unwritten().deleteOne({ k: 1 });
		expect(result.deletedCount).toBe(0);
	});

	test("updateOne without upsert reports no match", async () => {
		const result = await unwritten().updateOne({ k: 1 }, { $set: { n: 1 } });
		expect(result.matchedCount).toBe(0);
		expect(result.upsertedCount).toBe(0);
	});
});

describe("maxTimeMS", () => {
	test("a limit the server cannot meet is MaxTimeMSExpired (50)", async () => {
		// Enough rows that a full scan with an unindexable predicate cannot finish
		// inside a millisecond.
		for (let batch = 0; batch < 5; batch++) {
			await col.insertMany(
				Array.from({ length: 1000 }, (_, i) => ({
					k: batch * 1000 + i,
					tag: "x".repeat(200),
				})),
			);
		}

		const err = await col
			.countDocuments({ tag: { $regex: "nomatch" } }, { maxTimeMS: 1 })
			.then(
				() => undefined,
				(e: unknown) => e as MongoServerError,
			);
		expect(err).toBeInstanceOf(MongoServerError);
		expect(err?.code).toBe(50);
	});

	test("a generous limit changes nothing", async () => {
		await col.insertOne({ k: 1 });
		expect(await col.countDocuments({}, { maxTimeMS: 30_000 })).toBe(1);
	});

	test("a limit above MongoDB's 32-bit ceiling is refused", async () => {
		const err = await col.countDocuments({}, { maxTimeMS: 2_147_483_648 }).then(
			() => undefined,
			(e: unknown) => e as MongoServerError,
		);
		// Refused rather than rendered: JavaScript writes anything from 1e21 up in
		// exponent notation, which is not a SurrealQL duration.
		expect(err).toBeInstanceOf(MongoServerError);
		expect(err?.code).toBe(2);
	});
});

describe("the option gate", () => {
	test("`session` reaches the index operations, so their DDL rolls back too", async () => {
		// A collection of its own: an index left behind would change how the
		// statements in the other tests are planned.
		const indexed = ctx.collection("op_options_indexed");
		await indexed.insertOne({ k: 1 });

		const session = ctx.client.startSession();
		session.startTransaction();

		expect(await indexed.createIndex({ k: 1 }, { session })).toBe("k_1");
		// SurrealDB's `DEFINE INDEX` is transactional, so the index exists for the
		// statements in this transaction and for nobody else — which is only true
		// because the session reached the `DEFINE`, and reaches the reads as well.
		expect(await indexed.indexInformation({ session })).toHaveProperty("k_1");
		expect(
			(await indexed.listIndexes({ session }).toArray()).map((i) => i.name),
		).toEqual(["_id_", "k_1"]);
		expect(await indexed.indexInformation()).not.toHaveProperty("k_1");

		await session.abortTransaction();
		await session.endSession();
		// A session silently dropped on the way to `createIndex` would leave this
		// index behind, which is exactly the damage the option exists to prevent.
		expect(await indexed.indexInformation()).not.toHaveProperty("k_1");

		// Removing an index is rolled back the same way.
		await indexed.createIndex({ k: 1 });
		const dropping = ctx.client.startSession();
		dropping.startTransaction();

		expect(await indexed.dropIndexes({ session: dropping })).toBe(true);
		expect(
			await indexed.indexInformation({ session: dropping }),
		).not.toHaveProperty("k_1");

		await dropping.abortTransaction();
		await dropping.endSession();
		expect(await indexed.indexInformation()).toHaveProperty("k_1");
	});

	test("an index operation still refuses an option it cannot serve", async () => {
		// The index methods take the whole command surface, which is what makes
		// `session` nameable on them — so they have to refuse the parts of that
		// surface no `DEFINE INDEX` or `INFO FOR TABLE` could honour, rather than
		// accepting them because the type admits them.
		await expect(
			col.createIndex({ k: 1 }, { collation: { locale: "en" } }),
		).rejects.toBeInstanceOf(MongoCompatibilityError);
		await expect(
			col.listIndexes({ readConcern: "linearizable" }).toArray(),
		).rejects.toBeInstanceOf(MongoServerError);
	});

	test("a 2d index's `min`/`max` are not read as a query's index bounds", async () => {
		// `CreateIndexesOptions` gives both names a meaning of their own, so the
		// query rule that refuses them must not apply here.
		expect(await col.createIndex({ k: 1 }, { min: -180, max: 180 })).toBe(
			"k_1",
		);
	});

	test("an unrecognised option is tolerated on every operation", async () => {
		const noise = {
			translateAliases: false,
			overwriteDiscriminatorKey: true,
			_internalBookkeeping: 1,
		} as never;
		await col.insertOne({ k: 1 }, noise);
		expect(await col.countDocuments({}, noise)).toBe(1);
		expect(await col.listIndexes(noise).toArray()).not.toBeEmpty();
	});
});
