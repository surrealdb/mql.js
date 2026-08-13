/**
 * The admin surface against a real SurrealDB: `Db.command`, `Db.admin`,
 * `Db.stats`, `Db.collections`, and the collection-level introspection.
 *
 * Every reply shape asserted here was first measured against a real `mongod`
 * (8.2), so the tests say "this is what MongoDB answers" rather than "this is
 * what we happen to build". Two things are checked in each case: the fields that
 * are present carry the right values, and the fields this driver cannot derive
 * are *absent* rather than zero — a caller reading `storageSize: 0` would
 * conclude the collection is empty, while a caller finding no such field knows
 * the number was not available.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Db, ObjectId } from "../../src/index.ts";
import {
	MongoAPIError,
	MongoCompatibilityError,
	MongoErrorCode,
	type MongoServerError,
} from "../../src/index.ts";
import {
	type SurrealTestContext,
	setupSurreal,
	teardownSurreal,
} from "./helpers.ts";

interface TestDoc {
	[key: string]: unknown;
	_id?: ObjectId | string | number;
	a?: number;
	name?: string;
}

let ctx: SurrealTestContext<TestDoc>;
const PORT = 18744;
const DB_NAME = "testdb";

/** A collection name nobody else in the file uses. */
let counter = 0;
function freshName(prefix: string): string {
	counter += 1;
	return `${prefix}_${counter}`;
}

/**
 * A `Db` on a SurrealDB database of its own, so a count over "every collection"
 * has a known total that the rest of the file cannot disturb.
 *
 * One client serves it: `ctx.client.db(name)` addresses that database, so the
 * counts it reports are that database's. Dropping it afterwards leaves the
 * connected database — and the connection — untouched.
 */
async function isolatedDatabase(
	name: string,
): Promise<{ db: Db; close: () => Promise<void> }> {
	const db = ctx.client.db(name);
	return {
		db,
		close: async () => {
			await db.dropDatabase();
		},
	};
}

beforeAll(async () => {
	ctx = await setupSurreal<TestDoc>(PORT, DB_NAME);
});

afterAll(async () => {
	await teardownSurreal(ctx);
});

// ---------------------------------------------------------------------------
// The commands that report on the deployment
// ---------------------------------------------------------------------------

describe("ping", () => {
	test("answers once the server has answered", async () => {
		expect(await ctx.db.command({ ping: 1 })).toEqual({ ok: 1 });
		expect(await ctx.db.admin().ping()).toEqual({ ok: 1 });
	});

	test("a ping inside a transaction leaves it usable", async () => {
		// The statement a ping runs has to be one a transaction survives, or a
		// health check inside a session would abort the caller's work.
		const name = freshName("pingtxn");
		const session = ctx.client.startSession();

		try {
			session.startTransaction();
			expect(await ctx.db.command({ ping: 1 }, { session })).toEqual({ ok: 1 });
			await ctx.collection(name).insertOne({ a: 1 }, { session });
			await session.commitTransaction();
		} finally {
			await session.endSession();
		}

		expect(await ctx.collection(name).countDocuments()).toBe(1);
	});
});

describe("buildInfo against a connected server", () => {
	test("reports the SurrealDB version it is actually talking to", async () => {
		const info = await ctx.db.admin().buildInfo();

		expect(info.surrealdbVersion).toBe(ctx.serverVersion);
		// Both numbers, and they are not the same number: that is the whole point of
		// reporting a compatibility `version` alongside the real one.
		expect(info.version).not.toBe(info.surrealdbVersion);
	});
});

describe("listDatabases", () => {
	test("reports the databases in the connected SurrealDB namespace", async () => {
		const result = await ctx.db.admin().listDatabases();

		expect(result.ok).toBe(1);
		expect(result.databases.map((entry) => entry.name)).toContain(DB_NAME);
	});

	test("omits the size fields rather than reporting zeros", async () => {
		const result = await ctx.db.admin().listDatabases();

		// MongoDB itself omits these for `{nameOnly: true}`, so an absent field is a
		// shape callers already handle — unlike `sizeOnDisk: 0`, which claims a fact.
		expect(result).not.toContainKey("totalSize");
		expect(result).not.toContainKey("totalSizeMb");
		for (const entry of result.databases) {
			expect(entry).not.toContainKey("sizeOnDisk");
			expect(entry).not.toContainKey("empty");
		}
	});

	test("a filter narrows the reply, as MongoDB filters it server-side", async () => {
		const result = await ctx.db
			.admin()
			.listDatabases({ filter: { name: DB_NAME } });

		expect(result.databases).toEqual([{ name: DB_NAME }]);
	});

	test("a filter on a field the reply has no value for is refused", async () => {
		await expect(
			ctx.db.admin().listDatabases({ filter: { sizeOnDisk: { $gt: 0 } } }),
		).rejects.toThrow(
			"Unsupported field in a listDatabases filter: sizeOnDisk. Only name is reported for a database.",
		);
	});

	test("its options pass the gate every other method applies", async () => {
		// The method routes through `command()` rather than reading the namespace
		// itself, which is what makes an option this driver cannot honour a refusal
		// here too rather than something quietly dropped on one path only.
		await expect(
			ctx.db.admin().listDatabases({ collation: { locale: "en" } }),
		).rejects.toThrow("Option 'collation' is not supported");
	});
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

describe("dbStats", () => {
	test("counts collections, documents and indexes", async () => {
		const { db, close } = await isolatedDatabase("stats_only_db");
		const name = freshName("dbstats");
		await db.collection(name).insertMany([{ a: 1 }, { a: 2 }]);
		await db.collection(name).createIndex({ a: 1 });

		const stats = await db.stats();

		expect(stats.db).toBe("stats_only_db");
		expect(stats.collections).toBe(1);
		expect(stats.objects).toBe(2);
		// `_id_` counts, as it does in mongod's `indexes`, so one defined index is two.
		expect(stats.indexes).toBe(2);
		// SurrealDB has no views, so `0` is derived rather than assumed.
		expect(stats.views).toBe(0);
		expect(stats.ok).toBe(1);

		await close();
	});

	test("omits every byte-size field rather than reporting zeros", async () => {
		const stats = await ctx.db.stats();

		for (const size of [
			"dataSize",
			"storageSize",
			"indexSize",
			"totalSize",
			"avgObjSize",
			"fsUsedSize",
			"fsTotalSize",
			"scaleFactor",
		]) {
			expect(stats).not.toContainKey(size);
		}
	});

	test("an empty database counts nothing without failing", async () => {
		const { db, close } = await isolatedDatabase("entirely_empty_db");

		// Nothing to select from: the count has to be answered without a statement
		// rather than with a `FROM` clause naming no tables.
		expect(await db.stats()).toMatchObject({
			db: "entirely_empty_db",
			collections: 0,
			objects: 0,
			indexes: 0,
			ok: 1,
		});

		await close();
	});
});

describe("collStats", () => {
	test("counts documents and indexes for a collection", async () => {
		const name = freshName("collstats");
		await ctx.collection(name).insertMany([{ a: 1 }, { a: 2 }, { a: 3 }]);
		await ctx.collection(name).createIndex({ a: 1 });

		expect(await ctx.db.command({ collStats: name })).toEqual({
			ns: `${DB_NAME}.${name}`,
			count: 3,
			nindexes: 2,
			capped: false,
			ok: 1,
		});
	});

	test("a collection that does not exist reports zeros, as mongod does", async () => {
		// The one read path where the driver's usual "a missing table raises
		// NamespaceNotFound" would be the wrong answer: mongod reports a namespace it
		// cannot find as empty rather than failing.
		expect(await ctx.db.command({ collStats: "never_created_at_all" })).toEqual(
			{
				ns: `${DB_NAME}.never_created_at_all`,
				count: 0,
				nindexes: 0,
				capped: false,
				ok: 1,
			},
		);
	});

	test("a name of the wrong type is refused the way mongod refuses it", async () => {
		const promise = ctx.db.command({ collStats: 1 });
		await expect(promise).rejects.toThrow(
			"Collection name has invalid type int",
		);

		const error = await promise.catch((e: MongoServerError) => e);
		expect(error.code).toBe(MongoErrorCode.InvalidNamespace);
		expect(error.codeName).toBe("InvalidNamespace");
	});

	test("an empty name is a different refusal, with the same code", async () => {
		const promise = ctx.db.command({ collStats: "" });
		await expect(promise).rejects.toThrow(
			`Invalid namespace specified: ${DB_NAME}`,
		);
		await expect(promise).rejects.toHaveProperty(
			"code",
			MongoErrorCode.InvalidNamespace,
		);
	});
});

// ---------------------------------------------------------------------------
// Commands that delegate to an existing implementation
// ---------------------------------------------------------------------------

describe("create and drop", () => {
	test("create defines the collection, and listCollections then sees it", async () => {
		const name = freshName("created");

		expect(await ctx.db.command({ create: name })).toEqual({ ok: 1 });
		expect(
			(await ctx.db.listCollections().toArray()).map((c) => c.name),
		).toContain(name);
	});

	test("a collection shape SurrealDB cannot give a table is refused, not dropped", async () => {
		// mongod takes these in the command document and honours them, so ignoring
		// them would answer `ok: 1` and leave the caller with a plain table they
		// believe is capped — which `isCapped()` would then report as `false`. The
		// command hands them to `createCollection`, whose gate refuses them.
		for (const [option, request] of [
			["capped", { capped: true, size: 4096 }],
			["validator", { validator: { a: { $exists: true } } }],
			["viewOn", { viewOn: "other", pipeline: [] }],
			["timeseries", { timeseries: { timeField: "at" } }],
			["expireAfterSeconds", { expireAfterSeconds: 60 }],
		] as const) {
			await expect(
				ctx.db.command({ create: freshName("shaped"), ...request }),
			).rejects.toThrow(
				`Option '${option}' is not supported when creating a collection`,
			);
		}
	});

	test("drop reports the namespace it removed", async () => {
		const name = freshName("dropped");
		await ctx.db.command({ create: name });

		expect(await ctx.db.command({ drop: name })).toEqual({
			ns: `${DB_NAME}.${name}`,
			ok: 1,
		});
		expect(
			(await ctx.db.listCollections().toArray()).map((c) => c.name),
		).not.toContain(name);
	});

	test("dropping a collection that is not there is the state the caller asked for", async () => {
		// mongod answers `ok: 1` for an absent namespace rather than failing, so a
		// caller can drop idempotently without catching.
		expect(await ctx.db.command({ drop: "was_never_here" })).toEqual({
			ns: `${DB_NAME}.was_never_here`,
			ok: 1,
		});
	});
});

describe("listCollections as a command", () => {
	test("wraps the list in the exhausted-cursor document MongoDB returns", async () => {
		const name = freshName("listed");
		await ctx.collection(name).insertOne({ a: 1 });

		const reply = await ctx.db.command({ listCollections: 1 });
		const cursor = reply.cursor as {
			id: number;
			ns: string;
			firstBatch: { name: string; type: string }[];
		};

		// `id: 0` is a cursor with nothing left: the whole list arrived in one round
		// trip, so there is no `getMore` to make.
		expect(cursor.id).toBe(0);
		expect(cursor.ns).toBe(`${DB_NAME}.$cmd.listCollections`);
		expect(cursor.firstBatch).toContainEqual({ name, type: "collection" });
		expect(reply.ok).toBe(1);
	});

	test("a filter reaches the same in-memory matching the method uses", async () => {
		const name = freshName("filtered");
		await ctx.collection(name).insertOne({ a: 1 });

		const reply = await ctx.db.command({
			listCollections: 1,
			filter: { name },
		});
		expect((reply.cursor as { firstBatch: unknown[] }).firstBatch).toEqual([
			{ name, type: "collection" },
		]);
	});
});

describe("createIndexes and dropIndexes as commands", () => {
	test("createIndexes reports the counts either side of the change", async () => {
		const name = freshName("cmdidx");
		await ctx.collection(name).insertOne({ a: 1 });

		expect(
			await ctx.db.command({
				createIndexes: name,
				indexes: [{ key: { a: 1 }, name: "a_1" }],
			}),
		).toEqual({ numIndexesBefore: 1, numIndexesAfter: 2, ok: 1 });
	});

	test("re-creating the same index leaves the count where it was", async () => {
		const name = freshName("cmdidxsame");
		await ctx.collection(name).insertOne({ a: 1 });
		const spec = [{ key: { a: 1 }, name: "a_1" }];
		await ctx.db.command({ createIndexes: name, indexes: spec });

		// Read either side rather than inferred from the specifications: `createIndex`
		// is idempotent, so `before + specs.length` would claim work that did not
		// happen.
		expect(
			await ctx.db.command({ createIndexes: name, indexes: spec }),
		).toEqual({ numIndexesBefore: 2, numIndexesAfter: 2, ok: 1 });
	});

	test("createIndexes without its indexes field is refused as mongod refuses it", async () => {
		const promise = ctx.db.command({ createIndexes: "anything" });
		await expect(promise).rejects.toThrow(
			"BSON field 'createIndexes.indexes' is missing but a required field",
		);
		await expect(promise).rejects.toHaveProperty(
			"code",
			MongoErrorCode.IDLFailedToParse,
		);
	});

	test("dropIndexes by name reports the count before the drop", async () => {
		const name = freshName("cmddrop");
		await ctx.collection(name).insertOne({ a: 1 });
		await ctx.collection(name).createIndex({ a: 1 }, { name: "a_1" });

		expect(await ctx.db.command({ dropIndexes: name, index: "a_1" })).toEqual({
			nIndexesWas: 2,
			ok: 1,
		});
	});

	test("dropIndexes with '*' says what it dropped, as mongod does", async () => {
		const name = freshName("cmddropall");
		await ctx.collection(name).insertOne({ a: 1 });
		await ctx.collection(name).createIndex({ a: 1 });

		expect(await ctx.db.command({ dropIndexes: name, index: "*" })).toEqual({
			nIndexesWas: 2,
			msg: "non-_id indexes dropped for collection",
			ok: 1,
		});
	});

	test("dropIndexes inherits dropIndex's refusal to remove _id_", async () => {
		const name = freshName("cmddropid");
		await ctx.collection(name).insertOne({ a: 1 });

		await expect(
			ctx.db.command({ dropIndexes: name, index: "_id_" }),
		).rejects.toThrow("cannot drop _id index");
	});

	test("naming an index by key pattern is refused rather than guessed at", async () => {
		const name = freshName("cmddropkey");
		await ctx.collection(name).insertOne({ a: 1 });
		await ctx.collection(name).createIndex({ a: 1 });

		await expect(
			ctx.db.command({ dropIndexes: name, index: { a: 1 } }),
		).rejects.toBeInstanceOf(MongoCompatibilityError);
	});

	test("dropIndexes without its index field is refused as mongod refuses it", async () => {
		await expect(ctx.db.command({ dropIndexes: "anything" })).rejects.toThrow(
			"BSON field 'dropIndexes.index' is missing but a required field",
		);
	});
});

// ---------------------------------------------------------------------------
// Collection-level introspection
// ---------------------------------------------------------------------------

describe("Collection.drop", () => {
	test("removes the collection, as Db.dropCollection does", async () => {
		const name = freshName("coldrop");
		await ctx.collection(name).insertOne({ a: 1 });

		expect(await ctx.collection(name).drop()).toBe(true);
		expect(
			(await ctx.db.listCollections().toArray()).map((c) => c.name),
		).not.toContain(name);
	});
});

describe("Collection.options and isCapped", () => {
	test("a collection created through this driver has no options and is not capped", async () => {
		const name = freshName("colopts");
		await ctx.collection(name).insertOne({ a: 1 });

		// `{}` is the answer rather than a placeholder: every option that could appear
		// here is refused by `createCollection`, so none can be set.
		expect(await ctx.collection(name).options()).toEqual({});
		expect(await ctx.collection(name).isCapped()).toBe(false);
	});

	test("both refuse to report on a collection that does not exist", async () => {
		const name = freshName("colmissing");

		// MongoDB's own error, measured: a bare `MongoAPIError` naming the namespace,
		// carrying no code. Answering `false` would claim the collection exists.
		for (const call of [
			() => ctx.collection(name).options(),
			() => ctx.collection(name).isCapped(),
		]) {
			const promise = call();
			await expect(promise).rejects.toBeInstanceOf(MongoAPIError);
			await expect(promise).rejects.toThrow(
				`collection ${DB_NAME}.${name} not found`,
			);
		}
	});
});

describe("Db.collections", () => {
	test("hands back the same list listCollections reports, as handles", async () => {
		const { db, close } = await isolatedDatabase("collections_only_db");
		const first = freshName("handle");
		const second = freshName("handle");
		await db.collection(first).insertOne({ a: 1 });
		await db.collection(second).insertOne({ a: 1 });

		const names = (await db.collections())
			.map((collection) => collection.collectionName)
			.sort();
		expect(names).toEqual([first, second].sort());

		await close();
	});

	test("a database with no collections yields an empty list", async () => {
		const { db, close } = await isolatedDatabase("no_collections_db");

		expect(await db.collections()).toEqual([]);

		await close();
	});
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe("a command inside a transaction", () => {
	test("create is rolled back with the transaction that ran it", async () => {
		const name = freshName("txncreate");
		const session = ctx.client.startSession();

		try {
			session.startTransaction();
			await ctx.db.command({ create: name }, { session });
			await session.abortTransaction();
		} finally {
			await session.endSession();
		}

		// The command routes its session the same way the method it delegates to
		// does, so a rolled-back `create` leaves nothing behind.
		expect(
			(await ctx.db.listCollections().toArray()).map((c) => c.name),
		).not.toContain(name);
	});
});
