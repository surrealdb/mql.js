/**
 * Duplicate-key errors, end to end against a real server.
 *
 * `err.code === 11000` is the most-written error check in the MongoDB
 * ecosystem — mongoose's own duplicate-key path depends on it. SurrealDB
 * reports a unique-index violation as a generic internal error whose only
 * distinguishing feature is its message, so this suite exists to catch the
 * message format changing between SurrealDB releases: it would otherwise
 * degrade silently into an uncoded error that no application can branch on.
 *
 * The unique index is defined with raw SurrealQL rather than through
 * `createIndex`, so what is under test is only the error mapping — a change to
 * how the driver emits `UNIQUE` cannot mask a change in what the server says
 * when the constraint fires.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import type { Collection, Db, MongoClient } from "../../src/index.ts";
import { MongoServerError, ObjectId } from "../../src/index.ts";
import type { Document } from "../../src/types.ts";
import { setupSurreal, teardownSurreal } from "./helpers.ts";

const PORT = 18132;

interface Account extends Document {
	_id?: unknown;
	email?: string;
	tenant?: string;
	slot?: number;
}

let proc: Subprocess;
let client: MongoClient;
let db: Db;

/** Define a unique index straight in SurrealQL, bypassing createIndex. */
async function defineUniqueIndex(
	table: string,
	indexName: string,
	fields: string,
): Promise<void> {
	await client.executor.query(
		`DEFINE TABLE ${table} SCHEMALESS; DEFINE INDEX ${indexName} ON ${table} FIELDS ${fields} UNIQUE;`,
	);
}

/** Run `fn` and return the error it threw, failing the test if it did not. */
async function captureError(
	fn: () => Promise<unknown>,
): Promise<MongoServerError> {
	try {
		await fn();
	} catch (err) {
		return err as MongoServerError;
	}
	throw new Error("expected the operation to throw, but it resolved");
}

beforeAll(async () => {
	const ctx = await setupSurreal<Account>(PORT, "dupdb");
	proc = ctx.process;
	client = ctx.client;
	db = ctx.db;
});

afterAll(async () => {
	await teardownSurreal({ process: proc, client } as never);
});

describe("unique index violation", () => {
	test("insertOne on a duplicate throws MongoServerError with code 11000", async () => {
		await defineUniqueIndex("acct_single", "email_1", "email");
		const col: Collection<Account> = db.collection<Account>("acct_single");

		await col.insertOne({ email: "a@b.c" });
		const err = await captureError(() => col.insertOne({ email: "a@b.c" }));

		expect(err).toBeInstanceOf(MongoServerError);
		expect(err.code).toBe(11000);
		expect(err.codeName).toBe("DuplicateKey");
	});

	test("the message is MongoDB-shaped, naming collection, index and key", async () => {
		await defineUniqueIndex("acct_msg", "email_1", "email");
		const col = db.collection<Account>("acct_msg");

		await col.insertOne({ email: "dup@example.com" });
		const err = await captureError(() =>
			col.insertOne({ email: "dup@example.com" }),
		);

		expect(err.message).toContain("E11000 duplicate key error");
		expect(err.message).toContain("collection: acct_msg");
		expect(err.message).toContain("index: email_1");
		expect(err.message).toContain('email: "dup@example.com"');
	});

	test("keyPattern and keyValue identify the offending field", async () => {
		await defineUniqueIndex("acct_keys", "email_1", "email");
		const col = db.collection<Account>("acct_keys");

		await col.insertOne({ email: "keys@example.com" });
		const err = await captureError(() =>
			col.insertOne({ email: "keys@example.com" }),
		);

		expect(err.keyPattern).toEqual({ email: 1 });
		expect(err.keyValue).toEqual({ email: "keys@example.com" });
	});

	test("a compound unique index reports every key field", async () => {
		await defineUniqueIndex("acct_compound", "tenant_1_slot_1", "tenant, slot");
		const col = db.collection<Account>("acct_compound");

		await col.insertOne({ tenant: "acme", slot: 1 });
		const err = await captureError(() =>
			col.insertOne({ tenant: "acme", slot: 1 }),
		);

		expect(err.code).toBe(11000);
		expect(err.keyPattern).toEqual({ tenant: 1, slot: 1 });
		expect(err.keyValue).toEqual({ tenant: "acme", slot: 1 });
	});

	test("the originating SurrealDB error is preserved as `cause`", async () => {
		await defineUniqueIndex("acct_cause", "email_1", "email");
		const col = db.collection<Account>("acct_cause");

		await col.insertOne({ email: "cause@example.com" });
		const err = await captureError(() =>
			col.insertOne({ email: "cause@example.com" }),
		);

		expect(err.cause).toBeDefined();
		expect(String((err.cause as Error).message)).toContain("already contains");
	});

	test("insertMany surfaces the duplicate as code 11000 too", async () => {
		await defineUniqueIndex("acct_many", "email_1", "email");
		const col = db.collection<Account>("acct_many");

		const err = await captureError(() =>
			col.insertMany([{ email: "m@x.y" }, { email: "m@x.y" }]),
		);

		expect(err.code).toBe(11000);
	});

	test("a non-duplicate write is unaffected", async () => {
		await defineUniqueIndex("acct_ok", "email_1", "email");
		const col = db.collection<Account>("acct_ok");

		await col.insertOne({ email: "one@x.y" });
		await col.insertOne({ email: "two@x.y" });

		expect(await col.countDocuments({})).toBe(2);
	});
});

describe("other server errors keep their own codes", () => {
	test("querying a collection that does not exist is not reported as a duplicate key", async () => {
		const err = await captureError(() =>
			db.collection<Account>("no_such_collection_here").find({}).toArray(),
		);

		expect(err.code).not.toBe(11000);
	});
});

// ---------------------------------------------------------------------------
// Duplicate _id
// ---------------------------------------------------------------------------

/**
 * A colliding `_id` is a duplicate key, not a duplicate namespace.
 *
 * SurrealDB reports it as "record already exists", which reads like the table
 * and namespace conflicts it shares an error class with — but what collided is
 * `_id`, and MongoDB attributes that to the implicit `_id_` index with code
 * 11000. Every expectation below was measured against a real mongod first.
 */
describe("duplicate _id", () => {
	test("a colliding string _id reports 11000 against the _id_ index", async () => {
		const col = db.collection<Account>("dupid_string");
		await col.insertOne({ _id: "dup" });

		const err = await captureError(() => col.insertOne({ _id: "dup" }));

		expect(err.code).toBe(11000);
		expect(err.codeName).toBe("DuplicateKey");
		expect(err.keyPattern).toEqual({ _id: 1 });
		expect(err.keyValue).toEqual({ _id: "dup" });
		expect(err.message).toContain("E11000 duplicate key error");
		expect(err.message).toContain("index: _id_");
		expect(err.message).toContain('dup key: { _id: "dup" }');
	});

	test("a colliding ObjectId _id round-trips as an ObjectId", async () => {
		const col = db.collection<Account>("dupid_oid");
		const id = new ObjectId();
		await col.insertOne({ _id: id });

		const err = await captureError(() => col.insertOne({ _id: id }));

		expect(err.code).toBe(11000);
		// The value has to be the ObjectId a read would have returned, not the hex
		// string the server names the record with.
		expect(err.keyValue?._id).toBeInstanceOf(ObjectId);
		expect((err.keyValue?._id as ObjectId).toHexString()).toBe(
			id.toHexString(),
		);
		expect(err.message).toContain(
			`dup key: { _id: ObjectId('${id.toHexString()}') }`,
		);
	});

	// The server names the record as a string, which cannot distinguish 42 from
	// "42"; the insert still holds the typed id, and that is what is reported.
	test("a colliding numeric _id stays a number", async () => {
		const col = db.collection<Account>("dupid_number");
		await col.insertOne({ _id: 42 });

		const err = await captureError(() => col.insertOne({ _id: 42 }));

		expect(err.code).toBe(11000);
		expect(err.keyValue).toEqual({ _id: 42 });
		expect(err.message).toContain("dup key: { _id: 42 }");
	});

	test("insertMany colliding with an existing _id reports 11000", async () => {
		const col = db.collection<Account>("dupid_many");
		await col.insertOne({ _id: "taken" });

		const err = await captureError(() =>
			col.insertMany([{ _id: "fresh" }, { _id: "taken" }]),
		);

		expect(err.code).toBe(11000);
		expect(err.keyValue).toEqual({ _id: "taken" });
	});

	test("a generated _id never collides", async () => {
		const col = db.collection<Account>("dupid_generated");
		await col.insertMany([
			{ email: "a@x" },
			{ email: "b@x" },
			{ email: "c@x" },
		]);
		expect(await col.countDocuments({})).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// Neighbouring conflicts keep their own codes
// ---------------------------------------------------------------------------

describe("conflicts that are not duplicate keys", () => {
	test("a collection that already exists is 48, not 11000", async () => {
		await db.createCollection("already_here");
		const err = await captureError(() => db.createCollection("already_here"));

		// Same SurrealDB error class as a duplicate record, discriminated by whether
		// the error names a record or a table.
		expect(err.code).toBe(48);
		expect(err.codeName).toBe("NamespaceExists");
	});
});
