/**
 * The `Db` surface routes its options through the same machinery the collection
 * operations use: the gate that refuses what this driver cannot honour, and the
 * session resolution that decides which executor the statement runs on.
 *
 * `session` is the option whose silent loss is the most damaging, because a
 * caller believes their `dropCollection` can be rolled back with the rest of
 * their transaction. This surface is where it was once accepted and then dropped
 * one layer above the code that would have applied it, so every method that
 * issues a statement is checked here individually.
 */

import { describe, expect, test } from "bun:test";
import type { MongoClient } from "../../../src/client/mongo-client.ts";
import { listCollections } from "../../../src/db/database-operations.ts";
import { Db } from "../../../src/db/db.ts";
import {
	MongoCompatibilityError,
	MongoExpiredSessionError,
	MongoInvalidArgumentError,
} from "../../../src/errors.ts";
import { ClientSession } from "../../../src/session/client-session.ts";
import type { QueryExecutor } from "../../../src/surreal/query-executor.ts";
import type { TransactionScope } from "../../../src/surreal/transaction-executor.ts";
import { FakeQueryExecutor } from "../../helpers/fake-executor.ts";

/** A `Db` wired to a fake executor, with no client to connect. */
function makeDb(exec: FakeQueryExecutor): Db {
	return new Db(fakeClient(exec, new FakeQueryExecutor()), "testdb");
}

/**
 * A client whose connection and transaction are separate recorders, so which one
 * a statement reached is observable.
 */
function fakeClient(
	connection: FakeQueryExecutor,
	transaction: FakeQueryExecutor,
): MongoClient {
	const scope: TransactionScope = Object.assign(transaction, {
		commit: async (): Promise<void> => {},
		cancel: async (): Promise<void> => {},
		isLive: true,
		forDatabase: (): QueryExecutor => transaction,
	});
	return {
		_executor: connection,
		_scopeFor: (): string | undefined => undefined,
		_executorFor: (): QueryExecutor => connection,
		_beginTransaction: async (): Promise<TransactionScope> => scope,
		_forgetSession: (): void => {},
	} as unknown as MongoClient;
}

/** A `Db`, its two executors, and a session already inside a transaction. */
function makeTransactionalDb(): {
	db: Db;
	connection: FakeQueryExecutor;
	transaction: FakeQueryExecutor;
	session: ClientSession;
} {
	const connection = new FakeQueryExecutor();
	const transaction = new FakeQueryExecutor();
	const client = fakeClient(connection, transaction);
	const session = new ClientSession(client);
	session.startTransaction();
	return { db: new Db(client, "testdb"), connection, transaction, session };
}

describe("Db statements honour a session", () => {
	test.each([
		[
			"listCollections",
			(db: Db, session: ClientSession) =>
				db.listCollections(undefined, { session }),
			"INFO FOR DB",
		],
		[
			"createCollection",
			(db: Db, session: ClientSession) => db.createCollection("c", { session }),
			"DEFINE TABLE c",
		],
		[
			"dropCollection",
			(db: Db, session: ClientSession) => db.dropCollection("c", { session }),
			"REMOVE TABLE c",
		],
		[
			"dropDatabase",
			(db: Db, session: ClientSession) => db.dropDatabase({ session }),
			"REMOVE DATABASE `testdb`",
		],
	])("%s runs inside the caller's transaction", async (_, call, sql) => {
		const { db, connection, transaction, session } = makeTransactionalDb();
		transaction.enqueue({ tables: {} });

		await call(db, session);

		// The point of the option: the statement is part of the transaction the
		// caller can still roll back, not a separate write on the connection that
		// would survive an abort.
		expect(transaction.queries.map((q) => q.sql)).toEqual([sql]);
		expect(connection.queries).toEqual([]);
	});

	test("without a session the same statement stays on the connection", async () => {
		const { db, connection, transaction } = makeTransactionalDb();
		connection.enqueue({ tables: {} });

		await db.listCollections();

		expect(connection.queries.map((q) => q.sql)).toEqual(["INFO FOR DB"]);
		expect(transaction.queries).toEqual([]);
	});

	// `collection()` issues nothing, so there is no statement to route; MongoDB's
	// `CollectionOptions` carries `session` only through the shared option shape,
	// and each operation on the returned collection takes its own.
	test("collection() accepts a session without opening a transaction for it", () => {
		const { db, connection, transaction, session } = makeTransactionalDb();

		expect(db.collection("c", { session }).collectionName).toBe("c");
		expect(connection.queries).toEqual([]);
		expect(transaction.queries).toEqual([]);
	});

	test("no options at all still works", () => {
		const exec = new FakeQueryExecutor();
		const db = makeDb(exec);
		expect(db.collection("c").collectionName).toBe("c");
	});
});

describe("Db statements validate the session they are given", () => {
	test("an ended session is refused rather than run on the connection", async () => {
		const { db, connection, session } = makeTransactionalDb();
		await session.endSession();

		await expect(db.dropDatabase({ session })).rejects.toBeInstanceOf(
			MongoExpiredSessionError,
		);
		// Falling back to the connection would silently take the drop out of the
		// transaction the caller believed it was in.
		expect(connection.queries).toEqual([]);
	});

	test("a session from another client is refused", async () => {
		const { db } = makeTransactionalDb();
		const foreign = new ClientSession(
			fakeClient(new FakeQueryExecutor(), new FakeQueryExecutor()),
		);
		foreign.startTransaction();

		await expect(
			db.listCollections(undefined, { session: foreign }),
		).rejects.toBeInstanceOf(MongoInvalidArgumentError);
	});

	test("a value that is not a session is refused", async () => {
		const { db } = makeTransactionalDb();

		await expect(
			db.dropCollection("c", { session: { id: "fake" } as never }),
		).rejects.toBeInstanceOf(MongoInvalidArgumentError);
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
