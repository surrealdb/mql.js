/**
 * Sessions and transactions against a live SurrealDB server.
 *
 * The state machine is pinned by unit tests; what only a real server can settle
 * is whether the transaction is real — that a read inside it sees writes a read
 * outside cannot, that an abort leaves nothing behind, and that two sessions
 * racing for the same record produce the write conflict `withTransaction` exists
 * to absorb.
 *
 * The lifecycle cases issue their statements through the session seam directly,
 * because that seam is the whole mechanism: pass a session and the caller's
 * statement goes to the transaction, pass nothing and it goes to the connection.
 * The last group then goes the way an application does — `insertOne`,
 * `updateOne`, `find` and the rest, each taking `options.session` — which is what
 * proves the seam is actually reached from the public surface.
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { MongoClient } from "../../src/client/mongo-client.ts";
import {
	MongoCompatibilityError,
	MongoErrorCode,
	MongoErrorLabel,
	MongoExpiredSessionError,
	MongoInvalidArgumentError,
	MongoServerError,
	MongoTransactionError,
} from "../../src/errors.ts";
import type { Collection } from "../../src/index.ts";
import type { ClientSession } from "../../src/session/client-session.ts";
import { sessionExecutor } from "../../src/session/client-session.ts";
import { TransactionState } from "../../src/session/transaction.ts";
import type { Document } from "../../src/types.ts";
import {
	type SurrealTestContext,
	setupSurreal,
	teardownSurreal,
} from "./helpers.ts";

const PORT = 18137;

let ctx: SurrealTestContext<Document>;
/** A second connection, for the reads and writes that must stay outside. */
let outside: MongoClient;

beforeAll(async () => {
	ctx = await setupSurreal(PORT);
	outside = await MongoClient.connect(
		`mongodb://root:root@127.0.0.1:${PORT}/testdb?namespace=test`,
	);
	// Defined once, up front. Two transactions that each have to create the table
	// contend over its definition, which would make every pair of writes look like
	// a conflict regardless of the records they touched.
	await ctx.client._executor.query("DEFINE TABLE txn SCHEMALESS");
});

afterAll(async () => {
	await outside.close();
	await teardownSurreal(ctx);
});

beforeEach(async () => {
	await ctx.client._executor.query("DELETE txn");
});

/** Run `sql` with `session`, which is what decides where it lands. */
async function run(
	session: ClientSession | undefined,
	sql: string,
	client: MongoClient = ctx.client,
): Promise<unknown> {
	const executor = await sessionExecutor(session, client, client._executor);
	return executor.query(sql);
}

/** Every `n` currently stored in `txn`, as seen from outside any transaction. */
async function committed(client: MongoClient = outside): Promise<number[]> {
	const rows = await client._executor.query<number[]>(
		"SELECT VALUE n FROM txn ORDER BY n",
	);
	return rows;
}

describe("a committed transaction", () => {
	test("is invisible until the commit, then durable", async () => {
		const session = ctx.client.startSession();
		session.startTransaction();

		await run(session, "CREATE txn:a SET n = 1");
		expect(await committed()).toEqual([]);

		await session.commitTransaction();
		expect(await committed()).toEqual([1]);

		await session.endSession();
	});

	test("applies statements issued across separate round trips as one unit", async () => {
		const session = ctx.client.startSession();
		session.startTransaction();

		await run(session, "CREATE txn:a SET n = 1");
		await run(session, "CREATE txn:b SET n = 2");
		await run(session, "UPDATE txn:a SET n = 10");
		expect(await committed()).toEqual([]);

		await session.commitTransaction();
		expect(await committed()).toEqual([2, 10]);

		await session.endSession();
	});
});

describe("an aborted transaction", () => {
	test("leaves nothing behind", async () => {
		const session = ctx.client.startSession();
		session.startTransaction();

		await run(session, "CREATE txn:a SET n = 1");
		await run(session, "CREATE txn:b SET n = 2");
		await session.abortTransaction();

		expect(await committed()).toEqual([]);
		await session.endSession();
	});

	test("is aborted for a caller who ends the session instead", async () => {
		const session = ctx.client.startSession();
		session.startTransaction();
		await run(session, "CREATE txn:a SET n = 1");

		await session.endSession();

		expect(await committed()).toEqual([]);
		expect(session.transaction.state).toBe(TransactionState.TransactionAborted);
	});

	test("is aborted when the client is closed under it", async () => {
		const closing = await MongoClient.connect(
			`mongodb://root:root@127.0.0.1:${PORT}/testdb?namespace=test`,
		);
		const session = closing.startSession();
		session.startTransaction();
		await run(session, "CREATE txn:a SET n = 1", closing);

		await closing.close();

		expect(session.hasEnded).toBe(true);
		expect(await committed()).toEqual([]);
	});

	test("is aborted when `await using` leaves the block", async () => {
		{
			await using session = ctx.client.startSession();
			session.startTransaction();
			await run(session, "CREATE txn:a SET n = 1");
		}

		expect(await committed()).toEqual([]);
	});
});

describe("isolation", () => {
	test("a read inside sees its own uncommitted write; one outside does not", async () => {
		const session = ctx.client.startSession();
		session.startTransaction();

		await run(session, "CREATE txn:a SET n = 1");

		expect(await run(session, "SELECT VALUE n FROM txn")).toEqual([1]);
		expect(await committed()).toEqual([]);
		// The same connection, without the session, is outside too.
		expect(await committed(ctx.client)).toEqual([]);

		await session.abortTransaction();
		await session.endSession();
	});

	test("a write committed outside is not visible to a transaction already reading", async () => {
		await outside._executor.query("CREATE txn:a SET n = 1");

		const session = ctx.client.startSession();
		session.startTransaction();
		expect(await run(session, "SELECT VALUE n FROM txn")).toEqual([1]);

		await outside._executor.query("CREATE txn:b SET n = 2");
		expect(await run(session, "SELECT VALUE n FROM txn ORDER BY n")).toEqual([
			1,
		]);

		await session.abortTransaction();
		await session.endSession();
	});
});

describe("a write conflict", () => {
	test("is reported to whichever session commits second, with MongoDB's code and label", async () => {
		await outside._executor.query("CREATE txn:a SET n = 0");

		const first = ctx.client.startSession();
		const second = outside.startSession();
		first.startTransaction();
		second.startTransaction();

		// Both writes are accepted: SurrealDB is optimistic, and resolves the
		// contention at commit rather than by blocking either writer.
		await run(first, "UPDATE txn:a SET n = 1", ctx.client);
		await run(second, "UPDATE txn:a SET n = 2", outside);

		await first.commitTransaction();

		try {
			await second.commitTransaction();
			throw new Error("the second commit should have conflicted");
		} catch (error) {
			expect(error).toBeInstanceOf(MongoServerError);
			const failure = error as MongoServerError;
			expect(failure.code).toBe(MongoErrorCode.WriteConflict);
			expect(failure.codeName).toBe("WriteConflict");
			expect(
				failure.hasErrorLabel(MongoErrorLabel.TransientTransactionError),
			).toBe(true);
		}

		expect(await committed()).toEqual([1]);
		await first.endSession();
		await second.endSession();
	});

	test("two sessions writing different records both commit", async () => {
		const first = ctx.client.startSession();
		const second = outside.startSession();
		first.startTransaction();
		second.startTransaction();

		await run(first, "CREATE txn:a SET n = 1", ctx.client);
		await run(second, "CREATE txn:b SET n = 2", outside);

		await first.commitTransaction();
		await second.commitTransaction();

		expect(await committed()).toEqual([1, 2]);
		await first.endSession();
		await second.endSession();
	});
});

describe("withTransaction", () => {
	test("commits when the callback returns", async () => {
		const session = ctx.client.startSession();

		const result = await session.withTransaction(async (s) => {
			await run(s, "CREATE txn:a SET n = 1");
			await run(s, "CREATE txn:b SET n = 2");
			return "ok";
		});

		expect(result).toBe("ok");
		expect(await committed()).toEqual([1, 2]);
		await session.endSession();
	});

	test("aborts when the callback throws", async () => {
		const session = ctx.client.startSession();

		await expect(
			session.withTransaction(async (s) => {
				await run(s, "CREATE txn:a SET n = 1");
				throw new Error("no good");
			}),
		).rejects.toThrow("no good");

		expect(await committed()).toEqual([]);
		await session.endSession();
	});

	test("retries the callback after a real write conflict, and succeeds", async () => {
		await outside._executor.query("CREATE txn:a SET n = 0");

		const session = ctx.client.startSession();
		let attempts = 0;

		const total = await session.withTransaction(async (s) => {
			attempts += 1;
			await run(s, `UPDATE txn:a SET n = ${attempts}`);
			// Lose the race on the first attempt only: another connection commits the
			// same record while this transaction is still open, so this commit is
			// rejected and the whole callback must run again.
			if (attempts === 1) {
				await outside._executor.query("UPDATE txn:a SET n = 99");
			}
			return attempts;
		});

		expect(total).toBe(2);
		expect(attempts).toBe(2);
		expect(await committed()).toEqual([2]);
		await session.endSession();
	});
});

describe("misuse", () => {
	test("a session from another client is refused", async () => {
		const session = outside.startSession();

		await expect(
			sessionExecutor(session, ctx.client, ctx.client._executor),
		).rejects.toBeInstanceOf(MongoInvalidArgumentError);

		await session.endSession();
	});

	test("commit and abort are each refused after the other", async () => {
		const session = ctx.client.startSession();

		session.startTransaction();
		await run(session, "CREATE txn:a SET n = 1");
		await session.commitTransaction();
		await expect(session.abortTransaction()).rejects.toBeInstanceOf(
			MongoTransactionError,
		);

		session.startTransaction();
		await run(session, "CREATE txn:b SET n = 2");
		await session.abortTransaction();
		await expect(session.commitTransaction()).rejects.toBeInstanceOf(
			MongoTransactionError,
		);

		await session.endSession();
	});
});

describe("collection methods given a session", () => {
	/** The `txn` table as a collection on `client`. */
	function txn(client: MongoClient = ctx.client): Collection<Document> {
		return client.db("testdb").collection<Document>("txn");
	}

	test("every write in the transaction is invisible outside it, then durable", async () => {
		const col = txn();
		const session = ctx.client.startSession();
		session.startTransaction();

		await col.insertOne({ n: 1 }, { session });
		await col.insertOne({ n: 2 }, { session });
		await col.updateOne({ n: 1 }, { $set: { n: 10 } }, { session });
		await col.deleteOne({ n: 2 }, { session });

		// Reads given the session see the session's own uncommitted writes; the same
		// collection object without it does not, which is the isolation an
		// application relies on and the thing a dropped `session` would break.
		expect(await col.countDocuments({}, { session })).toBe(1);
		expect(await col.findOne({}, { session })).toMatchObject({ n: 10 });
		expect((await col.find({}, { session }).toArray()).map((d) => d.n)).toEqual(
			[10],
		);
		expect(await col.countDocuments({})).toBe(0);
		expect(await committed()).toEqual([]);

		await session.commitTransaction();
		expect(await committed()).toEqual([10]);
		await session.endSession();
	});

	test("an abort undoes the collection methods that ran inside it", async () => {
		const col = txn();
		await col.insertOne({ n: 1 });

		const session = ctx.client.startSession();
		session.startTransaction();
		await col.deleteOne({ n: 1 }, { session });
		await col.insertOne({ n: 2 }, { session });
		await col.findOneAndUpdate({ n: 2 }, { $set: { n: 3 } }, { session });
		await col.replaceOne({ n: 3 }, { n: 4 }, { session });
		expect(await col.countDocuments({}, { session })).toBe(1);

		await session.abortTransaction();
		await session.endSession();

		// The delete is undone with the writes, so the document the transaction
		// removed is still there and nothing it created is.
		expect(await committed()).toEqual([1]);
	});

	test("withTransaction commits the work its callback did through the collection", async () => {
		const col = txn();
		await col.insertOne({ n: 100 });
		const session = ctx.client.startSession();

		const moved = await session.withTransaction(async (s) => {
			const from = await col.findOneAndUpdate(
				{ n: 100 },
				{ $inc: { n: -10 } },
				{ session: s, returnDocument: "after" },
			);
			await col.insertOne({ n: 10 }, { session: s });
			return (from as Document).n;
		});

		expect(moved).toBe(90);
		expect(await committed()).toEqual([10, 90]);
		await session.endSession();
	});

	test("only one of two transactions claiming the same document can commit", async () => {
		// The claim both transactions make — filter on the state, set it to
		// something else — is MongoDB's compare-and-set, and only one caller may
		// come away believing it succeeded. Both writes are *accepted*, because
		// SurrealDB is optimistic and each transaction reads the document as pending;
		// the contention is settled at commit, where the second is refused. Nothing
		// retries it here, unlike the same write outside a transaction: the conflict
		// belongs to a transaction the server has already given up on, and only
		// re-running the whole of it — what `withTransaction` does with the
		// `TransientTransactionError` label — can clear it.
		await txn().insertOne({ n: 0, state: "pending" });

		const first = ctx.client.startSession();
		const second = outside.startSession();
		first.startTransaction();
		second.startTransaction();

		const claim = (
			client: MongoClient,
			session: ClientSession,
			owner: number,
		): Promise<number> =>
			txn(client)
				.updateOne(
					{ state: "pending" },
					{ $set: { state: "claimed", owner } },
					{ session },
				)
				.then((result) => result.matchedCount);

		expect(await claim(ctx.client, first, 1)).toBe(1);
		expect(await claim(outside, second, 2)).toBe(1);

		const failures = (
			await Promise.all(
				[first, second].map((session) =>
					session.commitTransaction().then(
						() => undefined,
						(error: unknown) => error as MongoServerError,
					),
				),
			)
		).filter((error) => error !== undefined);

		expect(failures).toHaveLength(1);
		expect(failures[0]?.code).toBe(MongoErrorCode.WriteConflict);
		expect(
			failures[0]?.hasErrorLabel(MongoErrorLabel.TransientTransactionError),
		).toBe(true);

		// One owner, and it is the one whose transaction committed.
		expect(
			await outside._executor.query<unknown[]>("SELECT VALUE owner FROM txn"),
		).toHaveLength(1);

		await first.endSession();
		await second.endSession();
	});

	test("an ended session is refused by a collection method, not quietly ignored", async () => {
		const session = ctx.client.startSession();
		session.startTransaction();
		await txn().insertOne({ n: 1 }, { session });
		await session.endSession();

		await expect(txn().insertOne({ n: 2 }, { session })).rejects.toBeInstanceOf(
			MongoExpiredSessionError,
		);
		// Running on the connection instead would make the write durable when the
		// caller believes it is inside a transaction that has already been discarded.
		expect(await committed()).toEqual([]);
	});

	test("a session from another client is refused by a collection method", async () => {
		const session = outside.startSession();
		session.startTransaction();

		await expect(
			txn(ctx.client).insertOne({ n: 1 }, { session }),
		).rejects.toBeInstanceOf(MongoInvalidArgumentError);

		await session.endSession();
	});
});

describe("index DDL inside a transaction", () => {
	/** A table of its own: an index outlives the `txn` table's per-test wipe. */
	function idx(): Collection<Document> {
		return ctx.client.db("testdb").collection<Document>("idx");
	}

	beforeEach(async () => {
		await ctx.client._executor.query(
			"REMOVE TABLE IF EXISTS idx; DEFINE TABLE idx SCHEMALESS;",
		);
	});

	test("a text index survives its commit and is undone by its abort", async () => {
		const col = idx();
		await col.insertOne({ body: "hello world" });

		const aborted = ctx.client.startSession();
		aborted.startTransaction();
		// The analyzer a FULLTEXT index names cannot be defined in the same
		// transaction — SurrealDB does not show it to the `DEFINE INDEX` that
		// follows — so it is established on the connection, and only the index
		// itself belongs to the transaction.
		expect(await col.createIndex({ body: "text" }, { session: aborted })).toBe(
			"body_text",
		);
		await aborted.abortTransaction();
		await aborted.endSession();
		expect(Object.keys(await idx().indexInformation())).toEqual(["_id_"]);

		const committed = ctx.client.startSession();
		committed.startTransaction();
		await col.createIndex({ body: "text" }, { session: committed });
		await committed.commitTransaction();
		await committed.endSession();
		expect(Object.keys(await idx().indexInformation())).toEqual([
			"_id_",
			"body_text",
		]);
		expect(
			await idx()
				.find({ $text: { $search: "hello" } })
				.toArray(),
		).toHaveLength(1);
	});

	test("an index a transaction rolled back is not remembered as one that exists", async () => {
		// The `$text` field list is cached per `Collection`, and what a transaction
		// defines is provisional: caching it would leave this object expanding
		// `$text` to a field carrying no index — which answers with no documents
		// instead of saying the index is missing.
		const col = idx();
		await col.insertOne({ body: "hello world" });
		await col.indexInformation();

		const session = ctx.client.startSession();
		session.startTransaction();
		await col.createIndex({ body: "text" }, { session });
		await session.abortTransaction();
		await session.endSession();

		expect(col._textFields).toEqual([]);
		await expect(
			col.find({ $text: { $search: "hello" } }).toArray(),
		).rejects.toBeInstanceOf(MongoInvalidArgumentError);
	});

	test("an index a rolled-back drop still leaves in place stays searchable", async () => {
		const col = idx();
		await col.insertOne({ body: "hello world" });
		await col.createIndex({ body: "text" });

		const session = ctx.client.startSession();
		session.startTransaction();
		await col.dropIndex("body_text", { session });
		await session.abortTransaction();
		await session.endSession();

		// The drop was undone, so the index is still there and the collection object
		// that asked for the drop must not have written it off.
		expect(Object.keys(await idx().indexInformation())).toContain("body_text");
		expect(
			await col.find({ $text: { $search: "hello" } }).toArray(),
		).toHaveLength(1);
	});
});

describe("a transport without transactions", () => {
	test("serves queries but refuses to open a session", async () => {
		const http = await MongoClient.connect(
			`http://root:root@127.0.0.1:${PORT}/testdb?namespace=test`,
		);

		try {
			// The connection itself is perfectly usable.
			await http._executor.query("CREATE txn:a SET n = 1");
			expect(await committed()).toEqual([1]);

			expect(() => http.startSession()).toThrow(MongoCompatibilityError);
			expect(() => http.startSession()).toThrow(/'http' transport/);
		} finally {
			await http.close();
		}
	});
});
