/**
 * A collection that does not exist, against a real server.
 *
 * The interesting half of this is the second suite. Reading a collection nothing
 * has written to has to answer emptily, and the way SurrealDB reports that is a
 * `NotFound` — the very same error class, and the same MongoDB code 26, that a
 * namespace which is not there produces. So the tolerance is only as good as the
 * discrimination behind it, and the only way to be sure a mistyped database name
 * still fails loudly is to point a connection at one and watch it fail.
 *
 * Getting a live server to report a missing namespace takes a little arranging,
 * because this driver issues `DEFINE NAMESPACE IF NOT EXISTS` when it connects, so
 * the namespace a root user names always exists by the time they read from it.
 * Removing it from under the connection reaches the same state, and is a failure
 * mode in its own right: the store a running application is pointed at going away
 * is precisely when answering `[]` would be worst.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import type { Db, MongoClient } from "../../src/index.ts";
import { MongoErrorCode, MongoServerError } from "../../src/index.ts";
import type { Document } from "../../src/types.ts";
import { runIfVersion } from "../helpers/version.ts";
import { setupSurreal, teardownSurreal } from "./helpers.ts";

const PORT = 18141;

interface Doc extends Document {
	_id?: unknown;
	tag?: string;
	k?: number;
}

let proc: Subprocess;
let client: MongoClient;
let db: Db;
let sequence = 0;

/** A collection name nothing has written to, since the store outlives a test. */
function undefinedCollection() {
	sequence += 1;
	return db.collection<Doc>(`ghost_${sequence}`);
}

beforeAll(async () => {
	const ctx = await setupSurreal<Doc>(PORT);
	proc = ctx.process;
	client = ctx.client;
	db = ctx.db;
});

afterAll(async () => {
	await teardownSurreal({ process: proc, client, db } as never);
});

describe("a collection that was never written to", () => {
	test("reads answer emptily rather than failing", async () => {
		expect(await undefinedCollection().find({}).toArray()).toEqual([]);
		expect(await undefinedCollection().findOne({})).toBeNull();
		expect(await undefinedCollection().countDocuments({})).toBe(0);
		expect(await undefinedCollection().estimatedDocumentCount()).toBe(0);
		expect(await undefinedCollection().distinct("tag")).toEqual([]);
	});

	test("a projected, sorted read answers emptily too", async () => {
		// A field list and an `ORDER BY` on one statement is a second read shape, so
		// it has to tolerate the missing table on its own account.
		expect(
			await undefinedCollection()
				.find({}, { projection: { tag: 1, k: 1 }, sort: { k: 1 } })
				.toArray(),
		).toEqual([]);
	});

	test("writes that match nothing report nothing", async () => {
		expect((await undefinedCollection().deleteMany({})).deletedCount).toBe(0);
		expect(
			(await undefinedCollection().updateMany({}, { $set: { k: 1 } }))
				.matchedCount,
		).toBe(0);
		expect(await undefinedCollection().findOneAndDelete({})).toBeNull();
	});

	test("an upsert creates the table it was told was empty", async () => {
		const col = undefinedCollection();

		const result = await col.updateOne(
			{ tag: "seed" },
			{ $set: { k: 1 } },
			{ upsert: true },
		);

		expect(result.upsertedId).not.toBeNull();
		expect(await col.countDocuments({})).toBe(1);
	});
});

/**
 * A database or namespace that is not there, which must never read as empty.
 *
 * Reached by removing it from under a live connection — a real failure mode, and
 * the only one a root user can produce, since this driver defines the namespace
 * and database it was pointed at when it connects. What matters is that these
 * arrive as the same `NotFound` and the same code 26 that an undefined table does,
 * so nothing but the structured detail tells them apart.
 */
describe("a database or namespace that is gone", () => {
	/**
	 * A connection of its own, pointed at a namespace and database that are then
	 * removed. `dropped` is run through a second connection so the one under test
	 * learns of the removal the way an application would: from its next statement.
	 */
	async function connectionToRemoved(
		scope: "DATABASE" | "NAMESPACE",
	): Promise<{ client: MongoClient; namespace: string }> {
		const { MongoClient: Client } = await import("../../src/index.ts");
		const namespace = `gone_${scope.toLowerCase()}_${Date.now()}`;
		const doomed = new Client(
			`mongodb://root:root@127.0.0.1:${PORT}/doomed?namespace=${namespace}`,
		);
		await doomed.connect();

		// The collection has to exist first, so that what fails afterwards can only
		// be the database or namespace rather than the table.
		await doomed
			.db("doomed")
			.collection<Doc>("present")
			.insertOne({ tag: "x" });

		const remover = new Client(
			`mongodb://root:root@127.0.0.1:${PORT}/doomed?namespace=${namespace}`,
		);
		await remover.connect();
		await remover.executor.query(
			scope === "DATABASE"
				? "REMOVE DATABASE doomed"
				: `REMOVE NAMESPACE ${namespace}`,
		);
		await remover.close();

		return { client: doomed, namespace };
	}

	test("a removed database still throws from every read", async () => {
		const { client: gone } = await connectionToRemoved("DATABASE");
		const col = gone.db("doomed").collection<Doc>("present");

		try {
			// Each of these tolerates an undefined *table*; none may tolerate this.
			await expect(col.find({}).toArray()).rejects.toBeInstanceOf(
				MongoServerError,
			);
			await expect(col.findOne({})).rejects.toBeInstanceOf(MongoServerError);
			await expect(col.countDocuments({})).rejects.toBeInstanceOf(
				MongoServerError,
			);
			await expect(col.estimatedDocumentCount()).rejects.toBeInstanceOf(
				MongoServerError,
			);
			await expect(col.distinct("tag")).rejects.toBeInstanceOf(
				MongoServerError,
			);
			await expect(
				col
					.find({}, { projection: { tag: 1, k: 1 }, sort: { k: 1 } })
					.toArray(),
			).rejects.toBeInstanceOf(MongoServerError);
		} finally {
			await gone.close().catch(() => {});
		}
	});

	test("a removed database still throws from every write", async () => {
		const { client: gone } = await connectionToRemoved("DATABASE");
		const col = gone.db("doomed").collection<Doc>("present");

		try {
			await expect(col.deleteMany({})).rejects.toBeInstanceOf(MongoServerError);
			await expect(col.deleteOne({ tag: "x" })).rejects.toBeInstanceOf(
				MongoServerError,
			);
			await expect(
				col.updateMany({}, { $set: { k: 1 } }),
			).rejects.toBeInstanceOf(MongoServerError);
			await expect(col.findOneAndDelete({})).rejects.toBeInstanceOf(
				MongoServerError,
			);
		} finally {
			await gone.close().catch(() => {});
		}
	});

	// The guarantee, on every supported server: a connection pointed at a namespace
	// that is not there fails, rather than being absorbed into the empty answer a
	// missing *table* now gives. What the server says about it varies (below).
	test("a removed namespace still throws rather than reading empty", async () => {
		const { client: gone } = await connectionToRemoved("NAMESPACE");
		const col = gone.db("doomed").collection<Doc>("present");

		try {
			await expect(col.find({}).toArray()).rejects.toBeInstanceOf(
				MongoServerError,
			);
			await expect(col.findOne({})).rejects.toBeInstanceOf(MongoServerError);
			await expect(col.countDocuments({})).rejects.toBeInstanceOf(
				MongoServerError,
			);
		} finally {
			await gone.close().catch(() => {});
		}
	});

	// 3.1 onwards reports it as the missing namespace it is, which is what tells a
	// caller their connection is pointed somewhere that does not exist. 3.0 surfaces
	// the same condition as an uncoded key-value-store error instead, so only the
	// throwing itself can be pinned there.
	runIfVersion(">=3.1.0", () => {
		test("the rejection names the namespace and carries code 26", async () => {
			const { client: gone, namespace } =
				await connectionToRemoved("NAMESPACE");
			const col = gone.db("doomed").collection<Doc>("present");

			try {
				const err = (await col
					.findOne({})
					.catch((e: unknown) => e)) as MongoServerError;
				expect(err.message).toContain(namespace);
				expect(err.code).toBe(MongoErrorCode.NamespaceNotFound);
			} finally {
				await gone.close().catch(() => {});
			}
		});
	});
});
