/**
 * The `Db` surface passes its options through the same gate the collection
 * operations use.
 *
 * Without this, `session` — the option whose silent loss is the most damaging,
 * because a caller believes their write can be rolled back — was accepted and
 * discarded one layer above the code that would have applied it.
 */

import { describe, expect, test } from "bun:test";
import { listCollections } from "../../../src/db/database-operations.ts";
import { Db } from "../../../src/db/db.ts";
import {
	MongoCompatibilityError,
	MongoInvalidArgumentError,
	MongoTransactionError,
} from "../../../src/errors.ts";
import { FakeQueryExecutor } from "../../helpers/fake-executor.ts";

/** A `Db` wired to a fake executor, with no client to connect. */
function makeDb(exec: FakeQueryExecutor): Db {
	const client = { _executor: exec } as unknown as ConstructorParameters<
		typeof Db
	>[0];
	return new Db(client, "testdb");
}

const SESSION = { id: "fake" } as never;

describe("Db option gate", () => {
	test("collection() rejects a session", () => {
		const db = makeDb(new FakeQueryExecutor());
		expect(() => db.collection("c", { session: SESSION })).toThrow(
			MongoTransactionError,
		);
	});

	test("listCollections() rejects a session", async () => {
		const db = makeDb(new FakeQueryExecutor());
		await expect(
			db.listCollections(undefined, { session: SESSION }),
		).rejects.toThrow(MongoTransactionError);
	});

	test("dropCollection() rejects a session", async () => {
		const db = makeDb(new FakeQueryExecutor());
		await expect(db.dropCollection("c", { session: SESSION })).rejects.toThrow(
			MongoTransactionError,
		);
	});

	test("dropDatabase() rejects a session", async () => {
		const db = makeDb(new FakeQueryExecutor());
		await expect(db.dropDatabase({ session: SESSION })).rejects.toThrow(
			MongoTransactionError,
		);
	});

	test("createCollection() rejects a session", async () => {
		const db = makeDb(new FakeQueryExecutor());
		await expect(
			db.createCollection("c", { session: SESSION }),
		).rejects.toThrow(MongoTransactionError);
	});

	// The gate must not turn an ordinary call into an error.
	test("no options at all still works", () => {
		const exec = new FakeQueryExecutor();
		const db = makeDb(exec);
		expect(db.collection("c").collectionName).toBe("c");
	});
});

describe("createCollection collection-shaping options", () => {
	test.each([
		["capped", { capped: true }],
		["size", { size: 1024 }],
		["max", { max: 10 }],
		["validator", { validator: {} }],
		["timeseries", { timeseries: {} }],
		["expireAfterSeconds", { expireAfterSeconds: 60 }],
		["viewOn", { viewOn: "other" }],
		["pipeline", { pipeline: [] }],
		["clusteredIndex", { clusteredIndex: {} }],
	])("rejects %s, rather than returning an ordinary table", async (_, options) => {
		const db = makeDb(new FakeQueryExecutor());
		await expect(db.createCollection("c", options)).rejects.toThrow(
			MongoCompatibilityError,
		);
	});

	test("accepts storageEngine, which cannot change the stored data", async () => {
		const exec = new FakeQueryExecutor();
		exec.enqueue(null);
		const db = makeDb(exec);
		const col = await db.createCollection("c", { storageEngine: { wt: {} } });
		expect(col.collectionName).toBe("c");
	});
});

describe("listCollections filter", () => {
	const tables = {
		tables: { users: "DEFINE TABLE users", logs: "DEFINE TABLE logs" },
	};

	test("filters on an exact name", async () => {
		const exec = new FakeQueryExecutor();
		exec.enqueue(tables);
		expect(await listCollections(exec, { name: "users" })).toEqual([
			{ name: "users", type: "collection" },
		]);
	});

	test("supports $in, $ne and $regex on the reported fields", async () => {
		for (const [filter, expected] of [
			[{ name: { $in: ["logs"] } }, ["logs"]],
			[{ name: { $ne: "logs" } }, ["users"]],
			[{ name: { $regex: "^us" } }, ["users"]],
			[{ type: "collection" }, ["users", "logs"]],
		] as const) {
			const exec = new FakeQueryExecutor();
			exec.enqueue(tables);
			const out = await listCollections(exec, filter);
			expect(out.map((c) => c.name)).toEqual([...expected]);
		}
	});

	// A predicate over data the reply does not carry would otherwise match
	// everything, which reads as "no such filter" rather than "unsupported".
	test("rejects a field a collection reply does not carry", async () => {
		const exec = new FakeQueryExecutor();
		exec.enqueue(tables);
		await expect(listCollections(exec, { options: {} })).rejects.toThrow(
			MongoInvalidArgumentError,
		);
	});

	test("rejects an operator it cannot evaluate", async () => {
		const exec = new FakeQueryExecutor();
		exec.enqueue(tables);
		await expect(
			listCollections(exec, { name: { $exists: true } }),
		).rejects.toThrow(MongoInvalidArgumentError);
	});

	test("no filter returns everything", async () => {
		const exec = new FakeQueryExecutor();
		exec.enqueue(tables);
		expect((await listCollections(exec)).map((c) => c.name)).toEqual([
			"users",
			"logs",
		]);
	});
});
