/**
 * The session lifecycle, against a stubbed SDK.
 *
 * Everything here is state-machine behaviour and misuse reporting, which a fake
 * transaction handle pins more precisely than a live server can: it makes visible
 * exactly how many round trips each path costs, and "none" is the assertion for
 * several of them.
 *
 * The isolation, rollback and atomicity the state machine is in service of are
 * proved against a real server in `tests/integration/sessions.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ConnectOptions } from "surrealdb";
import { ConnectionUnavailableError, Surreal } from "surrealdb";
import { MongoClient } from "../../../src/client/mongo-client.ts";
import {
	MongoCompatibilityError,
	MongoErrorCode,
	MongoErrorLabel,
	MongoExpiredSessionError,
	MongoInvalidArgumentError,
	MongoNetworkError,
	MongoRuntimeError,
	MongoServerError,
	MongoTransactionError,
} from "../../../src/errors.ts";
import type { ClientSession } from "../../../src/session/client-session.ts";
import { sessionExecutor } from "../../../src/session/client-session.ts";
import {
	Transaction,
	TransactionState,
} from "../../../src/session/transaction.ts";

/** Everything the stubbed SDK recorded across a test. */
interface Recording {
	/** Statements sent outside any transaction. */
	connectionQueries: string[];
	/** Transactions begun, in order, each with its own log. */
	transactions: TransactionLog[];
	beginFailure: Error | undefined;
	commitFailure: Error | undefined;
	transactionsSupported: boolean;
}

interface TransactionLog {
	queries: string[];
	commits: number;
	cancels: number;
}

const originals = {
	connect: Surreal.prototype.connect,
	query: Surreal.prototype.query,
	version: Surreal.prototype.version,
	close: Surreal.prototype.close,
	subscribe: Surreal.prototype.subscribe,
	beginTransaction: Surreal.prototype.beginTransaction,
	isFeatureSupported: Surreal.prototype.isFeatureSupported,
};

let recording: Recording;

beforeEach(() => {
	recording = {
		connectionQueries: [],
		transactions: [],
		beginFailure: undefined,
		commitFailure: undefined,
		transactionsSupported: true,
	};

	Surreal.prototype.connect = (async (
		_url: string | URL,
		_options?: ConnectOptions,
	) => true) as typeof Surreal.prototype.connect;

	Surreal.prototype.query = (async (sql: string) => {
		recording.connectionQueries.push(sql);
		return [[]];
	}) as unknown as typeof Surreal.prototype.query;

	Surreal.prototype.version = (async () => ({
		version: "surrealdb-3.2.4",
	})) as typeof Surreal.prototype.version;

	Surreal.prototype.close = (async () =>
		true) as typeof Surreal.prototype.close;

	Surreal.prototype.subscribe = (() =>
		() => {}) as unknown as typeof Surreal.prototype.subscribe;

	Surreal.prototype.isFeatureSupported = (() =>
		recording.transactionsSupported) as typeof Surreal.prototype.isFeatureSupported;

	Surreal.prototype.beginTransaction = (async () => {
		if (recording.beginFailure) throw recording.beginFailure;
		const log: TransactionLog = { queries: [], commits: 0, cancels: 0 };
		recording.transactions.push(log);
		return {
			query: async (sql: string) => {
				log.queries.push(sql);
				return [[]];
			},
			commit: async () => {
				log.commits += 1;
				if (recording.commitFailure) throw recording.commitFailure;
			},
			cancel: async () => {
				log.cancels += 1;
			},
		};
	}) as unknown as typeof Surreal.prototype.beginTransaction;
});

afterEach(() => {
	Object.assign(Surreal.prototype, originals);
});

function client(
	url = "mongodb://root:root@127.0.0.1:8000/testdb",
): MongoClient {
	return new MongoClient(url, { namespace: "test" });
}

/** Run one statement with `session`, which is what establishes the transaction. */
async function statement(session: ClientSession, sql: string): Promise<void> {
	const executor = await sessionExecutor(session, session.client, "testdb");
	await executor.query(sql);
}

/** An error that says it may be retried, as a write conflict does. */
function transientError(message = "write conflict"): MongoServerError {
	const error = new MongoServerError(message, {
		code: MongoErrorCode.WriteConflict,
	});
	error.addErrorLabel(MongoErrorLabel.TransientTransactionError);
	return error;
}

describe("startSession", () => {
	test("returns a usable session synchronously, before any connection", () => {
		const mongo = client();
		const session = mongo.startSession();

		expect(session.client).toBe(mongo);
		expect(session.hasEnded).toBe(false);
		expect(session.inTransaction()).toBe(false);
		expect(session.id?.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(session.transaction.state).toBe(TransactionState.NoTransaction);
		expect(recording.connectionQueries).toEqual([]);
	});

	test("each session has its own identity", () => {
		const mongo = client();
		const first = mongo.startSession();
		const second = mongo.startSession();

		expect(first.equals(first)).toBe(true);
		expect(first.equals(second)).toBe(false);
	});

	test("is refused over HTTP, naming the transport", () => {
		const mongo = client("http://root:root@127.0.0.1:8000/testdb");

		expect(() => mongo.startSession()).toThrow(MongoCompatibilityError);
		expect(() => mongo.startSession()).toThrow(/'http' transport/);
	});

	test("is refused over HTTPS, naming the transport", () => {
		const mongo = client("https://root:root@127.0.0.1:8000/testdb");

		expect(() => mongo.startSession()).toThrow(/'https' transport/);
	});

	test("refuses a snapshot session, as no snapshot can be established", () => {
		const mongo = client();

		expect(() => mongo.startSession({ snapshot: true })).toThrow(
			MongoServerError,
		);
		try {
			mongo.startSession({ snapshot: true });
		} catch (error) {
			expect((error as MongoServerError).code).toBe(
				MongoErrorCode.NotAReplicaSet,
			);
		}
	});

	test("reports causal consistency, which a single node always provides", () => {
		expect(client().startSession().supports.causalConsistency).toBe(true);
		expect(
			client().startSession({ causalConsistency: false }).supports
				.causalConsistency,
		).toBe(false);
	});
});

describe("startTransaction", () => {
	test("costs no round trip until a statement needs the transaction", async () => {
		const mongo = client();
		const session = mongo.startSession();

		session.startTransaction();
		expect(session.inTransaction()).toBe(true);
		expect(session.transaction.state).toBe(
			TransactionState.StartingTransaction,
		);
		expect(recording.transactions).toHaveLength(0);

		await statement(session, "CREATE t:one");
		expect(recording.transactions).toHaveLength(1);
		expect(recording.transactions[0]?.queries).toEqual(["CREATE t:one"]);
		expect(session.transaction.state).toBe(
			TransactionState.TransactionInProgress,
		);
	});

	test("refuses to start a second transaction while one is in progress", () => {
		const session = client().startSession();
		session.startTransaction();

		expect(() => session.startTransaction()).toThrow(MongoTransactionError);
		expect(() => session.startTransaction()).toThrow(
			"Transaction already in progress",
		);
	});

	test("refuses options this driver cannot honour", () => {
		const session = client().startSession();

		// A transaction's options are read by every statement inside it, so a
		// promise this driver cannot keep has to be refused here rather than at the
		// first write that inherits it.
		expect(() => session.startTransaction({ writeConcern: { w: 0 } })).toThrow(
			/writeConcern/,
		);
		// `linearizable` asks the server to confirm no newer primary was elected
		// before answering, which is a step nothing here performs.
		expect(() =>
			session.startTransaction({ readConcern: "linearizable" }),
		).toThrow(MongoServerError);
	});

	test("accepts `readConcern: 'snapshot'`, which an open transaction provides", () => {
		const session = client().startSession();

		// The request is that every read in the transaction come from one
		// consistent point in time. That is what a SurrealDB transaction is, so the
		// option is served rather than refused — proved against a live server by
		// `tests/integration/sessions.test.ts`, where a commit made by another
		// connection is invisible to a transaction that has already read.
		expect(() =>
			session.startTransaction({ readConcern: "snapshot" }),
		).not.toThrow();
		expect(session.transaction.options.readConcern).toBe("snapshot");
	});

	test("inherits the session's default transaction options", () => {
		const session = client().startSession({
			defaultTransactionOptions: { maxCommitTimeMS: 1234 },
		});
		session.startTransaction();

		expect(session.transaction.options.maxCommitTimeMS).toBe(1234);
	});

	test("a new transaction may follow a committed one", async () => {
		const session = client().startSession();

		session.startTransaction();
		await statement(session, "CREATE t:one");
		await session.commitTransaction();

		session.startTransaction();
		await statement(session, "CREATE t:two");
		await session.commitTransaction();

		expect(recording.transactions).toHaveLength(2);
		expect(recording.transactions[1]?.queries).toEqual(["CREATE t:two"]);
	});
});

describe("commitTransaction", () => {
	test("fails when no transaction was started", async () => {
		const session = client().startSession();

		await expect(session.commitTransaction()).rejects.toThrow(
			"No transaction started",
		);
	});

	test("a transaction with no statements commits without reaching the server", async () => {
		const session = client().startSession();
		session.startTransaction();

		await session.commitTransaction();

		expect(session.transaction.state).toBe(
			TransactionState.TransactionCommittedEmpty,
		);
		expect(recording.transactions).toHaveLength(0);
	});

	test("committing twice over is idempotent once the work is durable", async () => {
		const session = client().startSession();
		session.startTransaction();
		await statement(session, "CREATE t:one");

		await session.commitTransaction();
		await session.commitTransaction();

		expect(recording.transactions[0]?.commits).toBe(1);
	});

	test("a failed commit is reported again rather than silently retried", async () => {
		recording.commitFailure = transientError();
		const session = client().startSession();
		session.startTransaction();
		await statement(session, "CREATE t:one");

		await expect(session.commitTransaction()).rejects.toThrow("write conflict");
		await expect(session.commitTransaction()).rejects.toThrow(
			/handle is consumed/,
		);
		expect(recording.transactions[0]?.commits).toBe(1);
	});

	// Two settle calls racing each other is the caller's mistake, not the driver
	// losing track of its own state, and the error has to say so: only one of them
	// can hold the transaction, and the other has nothing to commit with.
	test("a second settle call while one is in flight is refused as such", async () => {
		const session = client().startSession();
		session.startTransaction();
		await statement(session, "CREATE t:one");

		const [first, second] = await Promise.allSettled([
			session.commitTransaction(),
			session.commitTransaction(),
		]);

		expect(first.status).toBe("fulfilled");
		expect(second.status).toBe("rejected");
		expect((second as PromiseRejectedResult).reason).toBeInstanceOf(
			MongoTransactionError,
		);
		expect(recording.transactions[0]?.commits).toBe(1);
	});

	test("cannot commit after aborting", async () => {
		const session = client().startSession();
		session.startTransaction();
		await statement(session, "CREATE t:one");
		await session.abortTransaction();

		await expect(session.commitTransaction()).rejects.toThrow(
			"Cannot call commitTransaction after calling abortTransaction",
		);
	});

	// The commit request had already left, so what is missing is the reply: the
	// server may have applied it. MongoDB labels this case the same way, and the
	// label is the only thing that distinguishes it from a commit that provably did
	// not happen — which is the distinction a caller needs before re-doing the work.
	test("a commit lost with the connection reports an unknown result", async () => {
		recording.commitFailure = new MongoNetworkError("connection closed");
		const session = client().startSession();
		session.startTransaction();
		await statement(session, "CREATE t:one");

		try {
			await session.commitTransaction();
			throw new Error("commit should not have resolved");
		} catch (error) {
			expect(error).toBeInstanceOf(MongoNetworkError);
			const failure = error as MongoNetworkError;
			expect(
				failure.hasErrorLabel(MongoErrorLabel.UnknownTransactionCommitResult),
			).toBe(true);
			// Not transient: repeating the callback could apply its writes twice.
			expect(
				failure.hasErrorLabel(MongoErrorLabel.TransientTransactionError),
			).toBe(false);
		}
	});

	test("maxCommitTimeMS expiring reports an unknown commit result", async () => {
		Surreal.prototype.beginTransaction = (async () => ({
			query: async () => [[]],
			commit: () => new Promise<void>(() => {}),
			cancel: async () => {},
		})) as unknown as typeof Surreal.prototype.beginTransaction;

		const session = client().startSession();
		session.startTransaction({ maxCommitTimeMS: 5 });
		await statement(session, "CREATE t:one");

		try {
			await session.commitTransaction();
			throw new Error("commit should not have resolved");
		} catch (error) {
			expect(error).toBeInstanceOf(MongoServerError);
			const failure = error as MongoServerError;
			expect(failure.code).toBe(MongoErrorCode.MaxTimeMSExpired);
			expect(
				failure.hasErrorLabel(MongoErrorLabel.UnknownTransactionCommitResult),
			).toBe(true);
		}
	});
});

describe("abortTransaction", () => {
	test("fails when no transaction was started", async () => {
		const session = client().startSession();

		await expect(session.abortTransaction()).rejects.toThrow(
			"No transaction started",
		);
	});

	test("a transaction with no statements aborts without reaching the server", async () => {
		const session = client().startSession();
		session.startTransaction();

		await session.abortTransaction();

		expect(session.transaction.state).toBe(TransactionState.TransactionAborted);
		expect(recording.transactions).toHaveLength(0);
	});

	test("cancels the transaction on the server once one exists", async () => {
		const session = client().startSession();
		session.startTransaction();
		await statement(session, "CREATE t:one");

		await session.abortTransaction();

		expect(recording.transactions[0]?.cancels).toBe(1);
		expect(recording.transactions[0]?.commits).toBe(0);
	});

	test("cannot abort twice", async () => {
		const session = client().startSession();
		session.startTransaction();
		await statement(session, "CREATE t:one");
		await session.abortTransaction();

		await expect(session.abortTransaction()).rejects.toThrow(
			"Cannot call abortTransaction twice",
		);
	});

	test("cannot abort after committing", async () => {
		const session = client().startSession();
		session.startTransaction();
		await statement(session, "CREATE t:one");
		await session.commitTransaction();

		await expect(session.abortTransaction()).rejects.toThrow(
			"Cannot call abortTransaction after calling commitTransaction",
		);
	});

	test("a cancel the server refuses still leaves the transaction aborted", async () => {
		Surreal.prototype.beginTransaction = (async () => ({
			query: async () => [[]],
			commit: async () => {},
			cancel: async () => {
				throw new Error("connection lost");
			},
		})) as unknown as typeof Surreal.prototype.beginTransaction;

		const session = client().startSession();
		session.startTransaction();
		await statement(session, "CREATE t:one");

		await session.abortTransaction();
		expect(session.transaction.state).toBe(TransactionState.TransactionAborted);
	});
});

describe("endSession", () => {
	test("aborts an open transaction", async () => {
		const session = client().startSession();
		session.startTransaction();
		await statement(session, "CREATE t:one");

		await session.endSession();

		expect(session.hasEnded).toBe(true);
		expect(recording.transactions[0]?.cancels).toBe(1);
	});

	test("every method refuses an ended session", async () => {
		const mongo = client();
		const session = mongo.startSession();
		await session.endSession();

		expect(() => session.startTransaction()).toThrow(MongoExpiredSessionError);
		await expect(session.commitTransaction()).rejects.toBeInstanceOf(
			MongoExpiredSessionError,
		);
		await expect(session.abortTransaction()).rejects.toBeInstanceOf(
			MongoExpiredSessionError,
		);
		await expect(
			sessionExecutor(session, mongo, "testdb"),
		).rejects.toBeInstanceOf(MongoExpiredSessionError);
	});

	test("is idempotent", async () => {
		const session = client().startSession();
		await session.endSession();
		await session.endSession();

		expect(session.hasEnded).toBe(true);
	});

	test("`await using` ends the session at the end of the block", async () => {
		const mongo = client();
		let captured: ClientSession | undefined;

		{
			await using session = mongo.startSession();
			captured = session;
			session.startTransaction();
			await statement(session, "CREATE t:one");
		}

		expect(captured?.hasEnded).toBe(true);
		expect(recording.transactions[0]?.cancels).toBe(1);
	});

	test("closing the client ends outstanding sessions", async () => {
		const mongo = client();
		const session = mongo.startSession();
		session.startTransaction();
		await statement(session, "CREATE t:one");

		await mongo.close();

		expect(session.hasEnded).toBe(true);
		expect(recording.transactions[0]?.cancels).toBe(1);
	});
});

describe("withSession", () => {
	test("ends the session when the callback returns", async () => {
		const mongo = client();
		let session: ClientSession | undefined;

		const result = await mongo.withSession(async (s) => {
			session = s;
			return 42;
		});

		expect(result).toBe(42);
		expect(session?.hasEnded).toBe(true);
	});

	test("ends the session when the callback throws", async () => {
		const mongo = client();
		let session: ClientSession | undefined;

		await expect(
			mongo.withSession(async (s) => {
				session = s;
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(session?.hasEnded).toBe(true);
	});

	test("accepts session options ahead of the callback", async () => {
		const mongo = client();

		const consistency = await mongo.withSession(
			{ causalConsistency: false },
			async (s) => s.supports.causalConsistency,
		);

		expect(consistency).toBe(false);
	});

	test("requires a callback", async () => {
		const mongo = client();

		// A JavaScript caller who supplied options and forgot the callback.
		await expect(
			mongo.withSession({ causalConsistency: true } as never),
		).rejects.toBeInstanceOf(MongoInvalidArgumentError);
	});
});

describe("withTransaction", () => {
	test("commits when the callback returns", async () => {
		const session = client().startSession();

		const result = await session.withTransaction(async (s) => {
			await statement(s, "CREATE t:one");
			return "done";
		});

		expect(result).toBe("done");
		expect(recording.transactions).toHaveLength(1);
		expect(recording.transactions[0]?.commits).toBe(1);
		expect(recording.transactions[0]?.cancels).toBe(0);
	});

	test("aborts and rethrows when the callback throws", async () => {
		const session = client().startSession();

		await expect(
			session.withTransaction(async (s) => {
				await statement(s, "CREATE t:one");
				throw new Error("callback failed");
			}),
		).rejects.toThrow("callback failed");

		expect(recording.transactions[0]?.cancels).toBe(1);
		expect(recording.transactions[0]?.commits).toBe(0);
	});

	test("leaves a callback that committed for itself alone", async () => {
		const session = client().startSession();

		await session.withTransaction(async (s) => {
			await statement(s, "CREATE t:one");
			await s.commitTransaction();
		});

		expect(recording.transactions[0]?.commits).toBe(1);
	});

	test("leaves a callback that aborted for itself alone, without throwing", async () => {
		const session = client().startSession();

		await session.withTransaction(async (s) => {
			await statement(s, "CREATE t:one");
			await s.abortTransaction();
		});

		expect(recording.transactions[0]?.cancels).toBe(1);
		expect(recording.transactions[0]?.commits).toBe(0);
	});

	test("retries the whole callback when the failure says it may be retried", async () => {
		const session = client().startSession();
		let attempts = 0;

		const result = await session.withTransaction(async (s) => {
			attempts += 1;
			await statement(s, `CREATE t:${attempts}`);
			if (attempts < 3) throw transientError();
			return attempts;
		});

		expect(result).toBe(3);
		expect(recording.transactions).toHaveLength(3);
		expect(recording.transactions.map((t) => t.queries)).toEqual([
			["CREATE t:1"],
			["CREATE t:2"],
			["CREATE t:3"],
		]);
	});

	test("retries when the commit itself reports a conflict", async () => {
		const session = client().startSession();
		let attempts = 0;

		const result = await session.withTransaction(async (s) => {
			attempts += 1;
			recording.commitFailure = attempts === 1 ? transientError() : undefined;
			await statement(s, "CREATE t:one");
			return attempts;
		});

		expect(result).toBe(2);
		expect(recording.transactions).toHaveLength(2);
	});

	test("does not retry a failure that carries no retry label", async () => {
		const session = client().startSession();
		let attempts = 0;

		await expect(
			session.withTransaction(async (s) => {
				attempts += 1;
				await statement(s, "CREATE t:one");
				throw new MongoServerError("permanent");
			}),
		).rejects.toThrow("permanent");

		expect(attempts).toBe(1);
	});

	test("stops retrying once the caller's budget is spent", async () => {
		const session = client().startSession();
		let attempts = 0;

		await expect(
			session.withTransaction(
				async (s) => {
					attempts += 1;
					await statement(s, "CREATE t:one");
					throw transientError("still conflicting");
				},
				{ timeoutMS: 1 },
			),
		).rejects.toThrow("still conflicting");

		// One attempt is always made; the budget only governs whether another is.
		expect(attempts).toBeGreaterThanOrEqual(1);
		expect(attempts).toBeLessThan(10);
	});

	test("transaction options survive a retry, and timeoutMS is not one of them", async () => {
		const session = client().startSession();
		let attempts = 0;

		await session.withTransaction(
			async (s) => {
				attempts += 1;
				expect(s.transaction.options.maxCommitTimeMS).toBe(2000);
				expect("timeoutMS" in s.transaction.options).toBe(false);
				await statement(s, "CREATE t:one");
				if (attempts === 1) throw transientError();
			},
			{ maxCommitTimeMS: 2000, timeoutMS: 60_000 },
		);

		expect(attempts).toBe(2);
	});

	test("requires the callback to return a promise", async () => {
		const session = client().startSession();

		await expect(
			session.withTransaction((() => 1) as never),
		).rejects.toBeInstanceOf(MongoInvalidArgumentError);
	});
});

describe("sessionExecutor", () => {
	test("uses the connection when no session is given", async () => {
		const mongo = client();

		expect(await sessionExecutor(undefined, mongo, "testdb")).toBe(
			mongo._executor,
		);
	});

	test("uses the connection for a session with no transaction", async () => {
		const mongo = client();
		const session = mongo.startSession();

		expect(await sessionExecutor(session, mongo, "testdb")).toBe(
			mongo._executor,
		);
	});

	test("routes statements to the transaction while one is in progress", async () => {
		const mongo = client();
		const session = mongo.startSession();
		session.startTransaction();

		const executor = await sessionExecutor(session, mongo, "testdb");
		await executor.query("CREATE t:one");

		expect(recording.transactions[0]?.queries).toEqual(["CREATE t:one"]);
		expect(recording.connectionQueries).not.toContain("CREATE t:one");
	});

	test("two statements issued at once share one transaction", async () => {
		const mongo = client();
		const session = mongo.startSession();
		session.startTransaction();

		await Promise.all([
			statement(session, "CREATE t:one"),
			statement(session, "CREATE t:two"),
		]);

		expect(recording.transactions).toHaveLength(1);
		expect(recording.transactions[0]?.queries).toEqual([
			"CREATE t:one",
			"CREATE t:two",
		]);
	});

	test("keeps a statement for another database inside the same transaction", async () => {
		const mongo = client();
		const session = mongo.startSession();
		session.startTransaction();

		const connected = await sessionExecutor(session, mongo, "testdb");
		const other = await sessionExecutor(session, mongo, "elsewhere");
		await connected.query("CREATE t:one");
		await other.query("CREATE t:two");

		// One transaction, both statements in it. A second transaction — or either
		// statement landing on the connection — would mean the two databases could
		// not be committed or rolled back as a unit.
		expect(recording.transactions).toHaveLength(1);
		expect(recording.transactions[0]?.queries).toEqual([
			"CREATE t:one",
			"USE DB `elsewhere`; CREATE t:two",
		]);
		expect(recording.connectionQueries).not.toContain("CREATE t:two");
	});

	test("uses the named database's connection when no transaction is open", async () => {
		const mongo = client();
		const session = mongo.startSession();

		expect(await sessionExecutor(session, mongo, "elsewhere")).toBe(
			await sessionExecutor(undefined, mongo, "elsewhere"),
		);
	});

	test("refuses a session belonging to another client", async () => {
		const owner = client();
		const other = client();
		const session = owner.startSession();

		await expect(
			sessionExecutor(session, other, "testdb"),
		).rejects.toBeInstanceOf(MongoInvalidArgumentError);
		await expect(sessionExecutor(session, other, "testdb")).rejects.toThrow(
			"must be from the same MongoClient",
		);
	});

	test("refuses a value that is not a session", async () => {
		const mongo = client();

		await expect(
			sessionExecutor({ id: "not-a-session" }, mongo, "testdb"),
		).rejects.toBeInstanceOf(MongoInvalidArgumentError);
	});

	test("surfaces a connection that cannot transact when the transaction is needed", async () => {
		recording.transactionsSupported = false;
		const mongo = client();
		const session = mongo.startSession();
		session.startTransaction();

		await expect(statement(session, "CREATE t:one")).rejects.toBeInstanceOf(
			MongoCompatibilityError,
		);
	});

	// Whether the engine can transact is a question put to the live connection, so
	// a connection that dropped between `startTransaction()` and the first
	// statement answers it by throwing the SDK's own error. The caller catches
	// `MongoError`, so that error has to be translated like any other.
	test("a connection lost before the transaction opens reports a driver error", async () => {
		Surreal.prototype.isFeatureSupported = (() => {
			throw new ConnectionUnavailableError();
		}) as typeof Surreal.prototype.isFeatureSupported;
		const mongo = client();
		const session = mongo.startSession();
		session.startTransaction();

		await expect(statement(session, "CREATE t:one")).rejects.toBeInstanceOf(
			MongoNetworkError,
		);
	});

	test("a transaction that opens after being aborted is closed, not left behind", async () => {
		let releaseBegin: (() => void) | undefined;
		const begun = new Promise<void>((resolve) => {
			releaseBegin = resolve;
		});
		const inner = Surreal.prototype.beginTransaction;
		Surreal.prototype.beginTransaction = async function (this: Surreal) {
			await begun;
			return inner.call(this);
		} as unknown as typeof Surreal.prototype.beginTransaction;

		const mongo = client();
		const session = mongo.startSession();
		session.startTransaction();

		const pending = statement(session, "CREATE t:one");
		await session.abortTransaction();
		releaseBegin?.();

		await expect(pending).rejects.toBeInstanceOf(MongoTransactionError);
		expect(recording.transactions).toHaveLength(1);
		expect(recording.transactions[0]?.cancels).toBe(1);
		expect(recording.transactions[0]?.queries).toEqual([]);
	});

	test("a transaction that could not be opened can still be aborted", async () => {
		recording.beginFailure = new Error("begin refused");
		const mongo = client();
		const session = mongo.startSession();
		session.startTransaction();

		await expect(statement(session, "CREATE t:one")).rejects.toThrow();
		await session.abortTransaction();

		expect(session.transaction.state).toBe(TransactionState.TransactionAborted);
	});
});

describe("the transaction state machine", () => {
	test("an illegal transition is reported as a driver fault", () => {
		const transaction = new Transaction();

		expect(() =>
			transaction.transition(TransactionState.TransactionCommitted),
		).toThrow(MongoRuntimeError);
	});

	test("state predicates describe the lifecycle", () => {
		const transaction = new Transaction();
		expect(transaction.isActive).toBe(false);
		expect(transaction.isStarting).toBe(false);
		expect(transaction.isCommitted).toBe(false);

		transaction.transition(TransactionState.StartingTransaction);
		expect(transaction.isActive).toBe(true);
		expect(transaction.isStarting).toBe(true);

		transaction.transition(TransactionState.TransactionInProgress);
		expect(transaction.isActive).toBe(true);
		expect(transaction.isStarting).toBe(false);

		transaction.transition(TransactionState.TransactionAborted);
		expect(transaction.isActive).toBe(false);
		expect(transaction.isCommitted).toBe(true);
	});
});

test("a session refuses to be serialised", () => {
	const session = client().startSession();

	expect(() => session.toBSON()).toThrow(MongoInvalidArgumentError);
});
