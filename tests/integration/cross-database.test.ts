/**
 * `client.db(name)` against a real server, where `name` is not the database the
 * connection was pointed at.
 *
 * Every case here is arranged the same way: the same collection name exists in
 * both databases holding *different* documents, and each operation is asserted
 * against both. Nothing is asserted by inspecting a statement, because the
 * failure being guarded against is a statement that runs perfectly well — just
 * against the wrong database — and only reading both databases can tell the
 * difference. A `find` through a handle naming the other database that returns
 * this database's document is the whole defect, and it looks like success.
 *
 * The index methods get the same treatment. Their DDL is database-scoped, so an
 * index defined through the wrong handle would be created on a table with the
 * same name in another database — visible to nothing the caller then queries.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import type { Db, MongoClient } from "../../src/index.ts";
import { MongoAPIError } from "../../src/index.ts";
import type { Document } from "../../src/types.ts";
import { setupSurreal, teardownSurreal } from "./helpers.ts";

const PORT = 18143;

/** The database the connection is pointed at. */
const CONNECTED = "testdb";
/** A second database in the same namespace, reached only through `db(name)`. */
const OTHER = "otherdb";

interface Doc extends Document {
	_id?: unknown;
	who?: string;
	n?: number;
	tag?: string;
}

let proc: Subprocess;
let client: MongoClient;
let connected: Db;
let other: Db;
let sequence = 0;

/**
 * A collection name unused so far, defined in both databases with one document
 * each: `who: "connected"` in one and `who: "other"` in the other.
 *
 * The store outlives each test, so names are never reused.
 */
async function seeded(): Promise<string> {
	sequence += 1;
	const name = `pair_${sequence}`;
	await connected.collection<Doc>(name).insertOne({ who: "connected", n: 1 });
	await other.collection<Doc>(name).insertOne({ who: "other", n: 2 });
	return name;
}

/** A database name nothing has ever addressed. */
function unusedDatabase(): string {
	sequence += 1;
	return `fresh_${Date.now().toString(36)}_${sequence}`;
}

beforeAll(async () => {
	const ctx = await setupSurreal<Doc>(PORT, CONNECTED);
	proc = ctx.process;
	client = ctx.client;
	connected = ctx.db;
	other = client.db(OTHER);
});

afterAll(async () => {
	await teardownSurreal({ process: proc, client, db: connected } as never);
});

describe("what a Db reports about itself", () => {
	test("databaseName is the database that is actually addressed", async () => {
		expect(other.databaseName).toBe(OTHER);

		const name = await seeded();
		const stats = await other.stats();

		expect(stats.db).toBe(OTHER);
		expect((await other.command({ collStats: name })).ns).toBe(
			`${OTHER}.${name}`,
		);
	});
});

describe("reads", () => {
	test("find, findOne and cursor iteration each read their own database", async () => {
		const name = await seeded();

		expect(
			(await other.collection<Doc>(name).find({}).toArray()).map((d) => d.who),
		).toEqual(["other"]);
		expect(
			(await connected.collection<Doc>(name).find({}).toArray()).map(
				(d) => d.who,
			),
		).toEqual(["connected"]);
		expect((await other.collection<Doc>(name).findOne({}))?.who).toBe("other");

		const iterated: unknown[] = [];
		for await (const doc of other.collection<Doc>(name).find({})) {
			iterated.push(doc.who);
		}
		expect(iterated).toEqual(["other"]);
	});

	test("a filter that matches in one database matches nothing in the other", async () => {
		const name = await seeded();

		expect(
			await other.collection<Doc>(name).findOne({ who: "connected" }),
		).toBeNull();
		expect(
			await connected.collection<Doc>(name).findOne({ who: "other" }),
		).toBeNull();
	});

	test("counts and distinct report on their own database", async () => {
		const name = await seeded();
		await other.collection<Doc>(name).insertMany([{ who: "other" }]);

		expect(await other.collection<Doc>(name).countDocuments({})).toBe(2);
		expect(await connected.collection<Doc>(name).countDocuments({})).toBe(1);
		expect(await other.collection<Doc>(name).estimatedDocumentCount()).toBe(2);
		expect(await connected.collection<Doc>(name).estimatedDocumentCount()).toBe(
			1,
		);
		expect(await other.collection<Doc>(name).distinct("who")).toEqual([
			"other",
		]);
		expect(await connected.collection<Doc>(name).distinct("who")).toEqual([
			"connected",
		]);
	});
});

describe("writes", () => {
	test("an insert lands in the database named, and only there", async () => {
		const name = await seeded();

		await other.collection<Doc>(name).insertOne({ who: "other", tag: "added" });

		expect(await other.collection<Doc>(name).countDocuments({})).toBe(2);
		expect(await connected.collection<Doc>(name).countDocuments({})).toBe(1);
	});

	test("update and replace leave the other database's document alone", async () => {
		const name = await seeded();

		await other.collection<Doc>(name).updateOne({}, { $set: { tag: "u" } });
		await other.collection<Doc>(name).updateMany({}, { $inc: { n: 10 } });
		await other.collection<Doc>(name).replaceOne({}, { who: "other", n: 99 });

		expect(await other.collection<Doc>(name).findOne({})).toMatchObject({
			who: "other",
			n: 99,
		});
		expect(await connected.collection<Doc>(name).findOne({})).toMatchObject({
			who: "connected",
			n: 1,
		});
	});

	test("a delete in one database does not empty the other", async () => {
		const name = await seeded();

		expect(
			(await other.collection<Doc>(name).deleteMany({})).deletedCount,
		).toBe(1);

		expect(await other.collection<Doc>(name).find({}).toArray()).toEqual([]);
		expect(await connected.collection<Doc>(name).countDocuments({})).toBe(1);
	});

	test("the three findOneAnd* operations act on their own database", async () => {
		const name = await seeded();

		expect(
			(
				await other
					.collection<Doc>(name)
					.findOneAndUpdate(
						{},
						{ $set: { tag: "updated" } },
						{ returnDocument: "after" },
					)
			)?.who,
		).toBe("other");
		expect(
			(
				await other
					.collection<Doc>(name)
					.findOneAndReplace(
						{},
						{ who: "other", tag: "replaced" },
						{ returnDocument: "after" },
					)
			)?.tag,
		).toBe("replaced");
		expect((await other.collection<Doc>(name).findOneAndDelete({}))?.who).toBe(
			"other",
		);

		// Untouched throughout: three operations that each found, changed and then
		// removed a document would have done all of it here had they addressed the
		// connected database.
		expect(await connected.collection<Doc>(name).findOne({})).toMatchObject({
			who: "connected",
			n: 1,
		});
	});
});

describe("indexes", () => {
	test("createIndex defines the index in the database named", async () => {
		const name = await seeded();

		expect(await other.collection<Doc>(name).createIndex({ who: 1 })).toBe(
			"who_1",
		);

		expect(
			(await other.collection<Doc>(name).listIndexes().toArray()).map(
				(i) => i.name,
			),
		).toContain("who_1");
		expect(
			(await connected.collection<Doc>(name).listIndexes().toArray()).map(
				(i) => i.name,
			),
		).not.toContain("who_1");
		expect(await other.collection<Doc>(name).indexExists("who_1")).toBe(true);
		expect(await connected.collection<Doc>(name).indexExists("who_1")).toBe(
			false,
		);
		expect(
			Object.keys(await other.collection<Doc>(name).indexInformation()),
		).toContain("who_1");
		expect(
			(await other.collection<Doc>(name).indexes()).map((i) => i.name),
		).toContain("who_1");
		expect(
			(await connected.collection<Doc>(name).indexes()).map((i) => i.name),
		).not.toContain("who_1");
	});

	test("createIndexes and dropIndex(es) act on the database named", async () => {
		const name = await seeded();
		const col = other.collection<Doc>(name);

		await col.createIndexes([
			{ key: { who: 1 }, name: "who_1" },
			{ key: { n: -1 }, name: "n_-1" },
		]);
		// The connected database's table of the same name keeps only its `_id` index,
		// so nothing below could be dropping an index defined there.
		expect(
			(await connected.collection<Doc>(name).listIndexes().toArray()).map(
				(i) => i.name,
			),
		).toEqual(["_id_"]);

		await col.dropIndex("who_1");
		expect((await col.listIndexes().toArray()).map((i) => i.name)).toEqual([
			"_id_",
			"n_-1",
		]);

		await col.dropIndexes();
		expect((await col.listIndexes().toArray()).map((i) => i.name)).toEqual([
			"_id_",
		]);
	});

	test("a unique index rejects a duplicate only in its own database", async () => {
		const name = await seeded();
		await other.collection<Doc>(name).createIndex({ who: 1 }, { unique: true });

		await expect(
			other.collection<Doc>(name).insertOne({ who: "other" }),
		).rejects.toThrow();
		// Not constrained here, which is the proof the DDL went where it was aimed.
		await connected.collection<Doc>(name).insertOne({ who: "connected" });
		expect(await connected.collection<Doc>(name).countDocuments({})).toBe(2);
	});

	test("a text index and its $text search work in the database named", async () => {
		const name = await seeded();
		await other
			.collection<Doc>(name)
			.insertOne({ who: "other", tag: "a scoped haystack" });
		await other.collection<Doc>(name).createIndex({ tag: "text" });

		expect(
			(
				await other
					.collection<Doc>(name)
					.find({ $text: { $search: "haystack" } })
					.toArray()
			).map((d) => d.tag),
		).toEqual(["a scoped haystack"]);
	});
});

describe("the Db surface", () => {
	test("listCollections and collections() list their own database", async () => {
		const name = await seeded();
		sequence += 1;
		const onlyOther = `solo_${sequence}`;
		await other.collection<Doc>(onlyOther).insertOne({ who: "other" });

		const otherNames = (await other.listCollections().toArray()).map(
			(c) => c.name,
		);
		const connectedNames = (await connected.listCollections().toArray()).map(
			(c) => c.name,
		);

		expect(otherNames).toContain(name);
		expect(otherNames).toContain(onlyOther);
		expect(connectedNames).toContain(name);
		expect(connectedNames).not.toContain(onlyOther);

		expect((await other.collections()).map((c) => c.collectionName)).toContain(
			onlyOther,
		);
		expect(
			(await connected.collections()).map((c) => c.collectionName),
		).not.toContain(onlyOther);
	});

	test("createCollection and dropCollection act on the database named", async () => {
		sequence += 1;
		const name = `explicit_${sequence}`;

		await other.createCollection(name);
		expect(
			(await other.listCollections().toArray()).map((c) => c.name),
		).toContain(name);
		expect(
			(await connected.listCollections().toArray()).map((c) => c.name),
		).not.toContain(name);

		// A table of the same name in the connected database, to be sure the drop
		// below removes the right one of the two.
		await connected.collection<Doc>(name).insertOne({ who: "connected" });
		expect(await other.dropCollection(name)).toBe(true);
		expect(
			(await other.listCollections().toArray()).map((c) => c.name),
		).not.toContain(name);
		expect(await connected.collection<Doc>(name).countDocuments({})).toBe(1);
	});

	test("dbStats counts the database named", async () => {
		const name = await seeded();
		await other.collection<Doc>(name).insertMany([{ who: "other" }]);

		const otherStats = await other.stats();
		const connectedStats = await connected.stats();

		expect(otherStats.db).toBe(OTHER);
		expect(connectedStats.db).toBe(CONNECTED);
		// Different documents in each, so an equal count would mean one handle read
		// the other's database.
		expect(otherStats.objects).not.toBe(connectedStats.objects);
		expect(await other.command({ dbStats: 1 })).toEqual(otherStats);
	});

	test("collStats and the create/drop commands act on the database named", async () => {
		const name = await seeded();
		await other.collection<Doc>(name).insertMany([{ who: "other" }]);

		expect(await other.command({ collStats: name })).toMatchObject({
			ns: `${OTHER}.${name}`,
			count: 2,
		});
		expect(await connected.command({ collStats: name })).toMatchObject({
			ns: `${CONNECTED}.${name}`,
			count: 1,
		});

		sequence += 1;
		const created = `cmd_${sequence}`;
		await other.command({ create: created });
		expect(
			(await other.listCollections().toArray()).map((c) => c.name),
		).toContain(created);
		expect(
			(await connected.listCollections().toArray()).map((c) => c.name),
		).not.toContain(created);
		await other.command({ drop: created });
		expect(
			(await other.listCollections().toArray()).map((c) => c.name),
		).not.toContain(created);
	});

	test("options() and isCapped() report on the database named", async () => {
		sequence += 1;
		const name = `only_other_${sequence}`;
		await other.collection<Doc>(name).insertOne({ who: "other" });

		expect(await other.collection<Doc>(name).options()).toEqual({});
		expect(await other.collection<Doc>(name).isCapped()).toBe(false);
		// The same collection does not exist in the connected database, and MongoDB
		// refuses to report on a namespace it cannot find.
		await expect(
			connected.collection<Doc>(name).options(),
		).rejects.toBeInstanceOf(MongoAPIError);
	});

	test("dropDatabase removes the database named, leaving the connected one", async () => {
		const doomed = client.db(unusedDatabase());
		await doomed.collection<Doc>("k").insertOne({ who: "doomed" });
		const name = await seeded();

		expect(await doomed.dropDatabase()).toBe(true);

		expect(
			(await connected.admin().listDatabases()).databases.map((d) => d.name),
		).not.toContain(doomed.databaseName);
		expect(await connected.collection<Doc>(name).countDocuments({})).toBe(1);
		expect(await other.collection<Doc>(name).countDocuments({})).toBe(1);
	});

	test("listDatabases sees both, whichever handle asks", async () => {
		await seeded();
		const fromOther = (await other.admin().listDatabases()).databases.map(
			(d) => d.name,
		);

		expect(fromOther).toContain(CONNECTED);
		expect(fromOther).toContain(OTHER);
		expect(
			(await connected.admin().listDatabases()).databases.map((d) => d.name),
		).toEqual(fromOther);
	});
});

/**
 * MongoDB creates a database on first write and answers a read of one that does
 * not exist emptily — measured against mongod 8.2, where a `find` on a
 * never-created database returns `[]`, `dbStats` reports zeroes and
 * `dropDatabase` succeeds.
 */
describe("a database nothing has addressed before", () => {
	test("reads answer emptily rather than failing", async () => {
		const fresh = client.db(unusedDatabase());

		expect(await fresh.collection<Doc>("k").find({}).toArray()).toEqual([]);
		expect(await fresh.collection<Doc>("k").findOne({})).toBeNull();
		expect(await fresh.collection<Doc>("k").countDocuments({})).toBe(0);
		expect(await fresh.collection<Doc>("k").distinct("who")).toEqual([]);
		expect(await fresh.listCollections().toArray()).toEqual([]);
		expect(await fresh.stats()).toMatchObject({
			db: fresh.databaseName,
			collections: 0,
			objects: 0,
		});
	});

	test("a write brings the database into existence", async () => {
		const fresh = client.db(unusedDatabase());

		await fresh.collection<Doc>("k").insertOne({ who: "fresh" });

		expect(
			(await fresh.collection<Doc>("k").find({}).toArray()).map((d) => d.who),
		).toEqual(["fresh"]);
		expect(
			(await connected.admin().listDatabases()).databases.map((d) => d.name),
		).toContain(fresh.databaseName);
	});

	test("dropping one that never existed succeeds, as MongoDB's does", async () => {
		expect(await client.db(unusedDatabase()).dropDatabase()).toBe(true);
	});

	test("one that has been dropped reads emptily rather than failing", async () => {
		const fresh = client.db(unusedDatabase());
		await fresh.collection<Doc>("k").insertOne({ who: "fresh" });
		await fresh.dropDatabase();

		// What MongoDB answers for a database it does not have. The connected
		// database going missing still throws — see `missing-collection.test.ts`,
		// where "the store this connection was pointed at is gone" must stay loud.
		expect(await fresh.collection<Doc>("k").find({}).toArray()).toEqual([]);
		expect(await fresh.collection<Doc>("k").countDocuments({})).toBe(0);
	});

	test("a question about the deployment does not invent it", async () => {
		// Addressing a database creates it, which is why the two commands that report
		// on the *namespace* rather than on a database are not addressed at one. A
		// `listDatabases` that named the handle's database would list a database the
		// question itself had just brought into being.
		const fresh = client.db(unusedDatabase());

		await fresh.admin().ping();
		const listed = (await fresh.admin().listDatabases()).databases.map(
			(d) => d.name,
		);

		expect(listed).not.toContain(fresh.databaseName);
		expect(
			(await connected.admin().listDatabases()).databases.map((d) => d.name),
		).not.toContain(fresh.databaseName);
	});
});

/**
 * A database name is spliced into the statement that selects it, and `USE DB`
 * accepts fewer bare words than a table position does: `function`, `alter` and
 * `sleep` each open a statement or a literal the parser then wants the rest of.
 * They are ordinary MongoDB database names, so a caller who picks one must not
 * meet a SurrealQL parse error from every operation.
 */
describe("a database whose name is a SurrealQL keyword", () => {
	for (const name of ["function", "alter", "sleep"]) {
		test(`db(${JSON.stringify(name)}) is usable end to end`, async () => {
			const keyword = client.db(name);
			const collection = `kw_${name}`;

			await keyword.collection<Doc>(collection).insertOne({ who: name });

			expect((await keyword.collection<Doc>(collection).findOne({}))?.who).toBe(
				name,
			);
			expect(await keyword.listCollections().toArray()).toContainEqual({
				name: collection,
				type: "collection",
			});
			// The connected database has no such collection, so a leak would show as a
			// document appearing where nothing wrote one.
			expect(
				await connected.collection<Doc>(collection).find({}).toArray(),
			).toEqual([]);

			expect(await keyword.dropDatabase()).toBe(true);
			expect(
				(await connected.admin().listDatabases()).databases.map((d) => d.name),
			).not.toContain(name);
		});
	}
});

/**
 * MongoDB's transactions span databases: a commit applies to every database
 * touched and an abort rolls all of them back, measured against a mongod 8.2
 * replica set. SurrealDB's do too, which is why a session here can be handed to
 * operations on two databases at once rather than having to refuse them.
 */
describe("transactions across two databases", () => {
	test("a commit applies to both databases", async () => {
		const name = await seeded();
		const session = client.startSession();

		try {
			session.startTransaction();
			await connected
				.collection<Doc>(name)
				.insertOne({ who: "connected", tag: "txn" }, { session });
			await other
				.collection<Doc>(name)
				.insertOne({ who: "other", tag: "txn" }, { session });
			await session.commitTransaction();
		} finally {
			await session.endSession();
		}

		expect(
			await connected.collection<Doc>(name).countDocuments({ tag: "txn" }),
		).toBe(1);
		expect(
			await other.collection<Doc>(name).countDocuments({ tag: "txn" }),
		).toBe(1);
	});

	test("an abort rolls back both databases", async () => {
		const name = await seeded();
		const session = client.startSession();

		try {
			session.startTransaction();
			await connected
				.collection<Doc>(name)
				.insertOne({ who: "connected", tag: "gone" }, { session });
			await other
				.collection<Doc>(name)
				.insertOne({ who: "other", tag: "gone" }, { session });
			await session.abortTransaction();
		} finally {
			await session.endSession();
		}

		expect(
			await connected.collection<Doc>(name).countDocuments({ tag: "gone" }),
		).toBe(0);
		expect(
			await other.collection<Doc>(name).countDocuments({ tag: "gone" }),
		).toBe(0);
	});

	test("a read in the transaction sees its own write to the other database", async () => {
		const name = await seeded();
		const session = client.startSession();

		try {
			session.startTransaction();
			await other
				.collection<Doc>(name)
				.insertOne({ who: "other", tag: "inside" }, { session });

			expect(
				await other.collection<Doc>(name).countDocuments({}, { session }),
			).toBe(2);
			// The same count outside the transaction still sees only the committed
			// document, which is what makes the isolation the server's rather than
			// this driver's bookkeeping.
			expect(await other.collection<Doc>(name).countDocuments({})).toBe(1);
		} finally {
			await session.abortTransaction();
			await session.endSession();
		}
	});

	test("a Db method takes part in the transaction it is given", async () => {
		sequence += 1;
		const name = `txn_ddl_${sequence}`;
		const session = client.startSession();

		try {
			session.startTransaction();
			await other.createCollection(name, { session });
			await session.abortTransaction();
		} finally {
			await session.endSession();
		}

		expect(
			(await other.listCollections().toArray()).map((c) => c.name),
		).not.toContain(name);
	});

	test("a database created inside a transaction survives the commit", async () => {
		const fresh = client.db(unusedDatabase());
		const session = client.startSession();

		try {
			session.startTransaction();
			await fresh.collection<Doc>("k").insertOne({ who: "fresh" }, { session });
			await session.commitTransaction();
		} finally {
			await session.endSession();
		}

		expect(await fresh.collection<Doc>("k").countDocuments({})).toBe(1);
	});
});

describe("the connected database is unaffected by any of it", () => {
	test("a statement after a scoped one is back on the connected database", async () => {
		const name = await seeded();

		await other.collection<Doc>(name).find({}).toArray();

		// The prefix is per statement, so nothing about the connection changed. This
		// is the assertion the whole mechanism rests on: were `USE` to persist, the
		// next unscoped statement would silently read the other database.
		expect((await connected.collection<Doc>(name).findOne({}))?.who).toBe(
			"connected",
		);
		expect(await connected.stats()).toMatchObject({ db: CONNECTED });
	});

	test("db() and db(<the connected database>) are the same database", async () => {
		const name = await seeded();

		expect((await client.db().collection<Doc>(name).findOne({}))?.who).toBe(
			"connected",
		);
		expect(
			(await client.db(CONNECTED).collection<Doc>(name).findOne({}))?.who,
		).toBe("connected");
	});
});
