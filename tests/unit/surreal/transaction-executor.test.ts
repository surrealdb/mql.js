/**
 * The transaction-scoped executor: serialisation and single use.
 *
 * Both are guarantees this driver adds on top of the SDK handle rather than
 * behaviour it inherits, so they are pinned here against a handle that records
 * what happened instead of against a live server.
 */

import { describe, expect, test } from "bun:test";
import { MongoTransactionError } from "../../../src/errors.ts";
import type { TransactionHandle } from "../../../src/surreal/transaction-executor.ts";
import { TransactionExecutor } from "../../../src/surreal/transaction-executor.ts";

/**
 * The SDK's query object: awaitable for the results, or read per statement with
 * `responses()`. Both fakes below hand back one of these, because the executor
 * reaches for either depending on what the operation needs to know.
 */
type HandleReply<R> = PromiseLike<R> & {
	responses(): Promise<
		readonly { success: boolean; result?: unknown; error?: unknown }[]
	>;
};

function reply<R>(promise: Promise<R>, sql: string): HandleReply<R> {
	return Object.assign(promise, {
		responses: async () => [{ success: true, result: sql }],
	});
}

/** A handle that logs every dispatch and reply, so overlap is visible. */
function recordingHandle(): {
	handle: TransactionHandle;
	events: string[];
	resolvers: Array<() => void>;
} {
	const events: string[] = [];
	const resolvers: Array<() => void> = [];

	const handle: TransactionHandle = {
		query: <R extends unknown[] = unknown[]>(sql: string): HandleReply<R> =>
			reply(
				new Promise<R>((resolve) => {
					events.push(`start:${sql}`);
					resolvers.push(() => {
						events.push(`end:${sql}`);
						resolve([sql] as unknown as R);
					});
				}),
				sql,
			),
		commit: async () => {
			events.push("commit");
		},
		cancel: async () => {
			events.push("cancel");
		},
	};

	return { handle, events, resolvers };
}

/** A handle whose statements settle immediately. */
function immediateHandle(): { handle: TransactionHandle; events: string[] } {
	const events: string[] = [];
	return {
		events,
		handle: {
			query: <R extends unknown[] = unknown[]>(sql: string): HandleReply<R> => {
				events.push(sql);
				return reply(Promise.resolve([sql] as unknown as R), sql);
			},
			commit: async () => {
				events.push("commit");
			},
			cancel: async () => {
				events.push("cancel");
			},
		},
	};
}

describe("statement ordering", () => {
	test("statements never overlap, and run in call order", async () => {
		const { handle, events, resolvers } = recordingHandle();
		const executor = new TransactionExecutor(handle, "3.2.4");

		const first = executor.query("one");
		const second = executor.query("two");

		// Only the first has been dispatched: the second is still queued.
		await Promise.resolve();
		expect(events).toEqual(["start:one"]);

		resolvers[0]?.();
		expect(await first).toBe("one");

		// Draining the queue requires the second dispatch to have happened.
		await Promise.resolve();
		resolvers[1]?.();
		expect(await second).toBe("two");

		expect(events).toEqual(["start:one", "end:one", "start:two", "end:two"]);
	});

	test("a commit waits for the statements already issued", async () => {
		const { handle, events, resolvers } = recordingHandle();
		const executor = new TransactionExecutor(handle, "3.2.4");

		const statement = executor.query("write");
		const commit = executor.commit();

		await Promise.resolve();
		expect(events).toEqual(["start:write"]);

		resolvers[0]?.();
		await statement;
		await commit;

		expect(events).toEqual(["start:write", "end:write", "commit"]);
	});

	test("a failed statement does not stall the queue", async () => {
		const events: string[] = [];
		const handle: TransactionHandle = {
			query: <R extends unknown[] = unknown[]>(sql: string): HandleReply<R> => {
				events.push(sql);
				const pending =
					sql === "bad"
						? Promise.reject<R>(new Error("rejected"))
						: Promise.resolve([sql] as unknown as R);
				return reply(pending, sql);
			},
			commit: async () => {
				events.push("commit");
			},
			cancel: async () => {
				events.push("cancel");
			},
		};
		const executor = new TransactionExecutor(handle, "3.2.4");

		const failing = executor.query("bad");
		const following = executor.query("good");

		await expect(failing).rejects.toThrow("rejected");
		expect(await following).toBe("good");
		expect(events).toEqual(["bad", "good"]);
	});
});

describe("single use", () => {
	test("a statement after commit is refused without reaching the server", async () => {
		const { handle, events } = immediateHandle();
		const executor = new TransactionExecutor(handle, "3.2.4");

		await executor.query("write");
		await executor.commit();

		expect(executor.isLive).toBe(false);
		await expect(executor.query("late")).rejects.toBeInstanceOf(
			MongoTransactionError,
		);
		expect(events).toEqual(["write", "commit"]);
	});

	test("commit and cancel are each refused once the transaction is settled", async () => {
		const { handle } = immediateHandle();
		const executor = new TransactionExecutor(handle, "3.2.4");

		await executor.cancel();
		await expect(executor.commit()).rejects.toBeInstanceOf(
			MongoTransactionError,
		);
		await expect(executor.cancel()).rejects.toBeInstanceOf(
			MongoTransactionError,
		);
	});

	test("a commit that fails still consumes the transaction", async () => {
		const handle: TransactionHandle = {
			query: <R extends unknown[] = unknown[]>(): HandleReply<R> =>
				reply(Promise.resolve([] as unknown as R), ""),
			commit: async () => {
				throw new Error("conflict");
			},
			cancel: async () => {},
		};
		const executor = new TransactionExecutor(handle, "3.2.4");

		await expect(executor.commit()).rejects.toThrow("conflict");
		expect(executor.isLive).toBe(false);
	});

	test("closing discards uncommitted work rather than the connection", async () => {
		const { handle, events } = immediateHandle();
		const executor = new TransactionExecutor(handle, "3.2.4");

		await executor.query("write");
		await executor.close();

		expect(events).toEqual(["write", "cancel"]);
	});
});

test("the server version is inherited from the connection", () => {
	const { handle } = immediateHandle();
	expect(new TransactionExecutor(handle, "3.1.5").serverVersion).toBe("3.1.5");
});

/**
 * One transaction spans every database a session touches, so a statement for
 * another database is a view of the same handle rather than a second
 * transaction. What matters is that the guarantees above are not lost on the way
 * through the view: a scoped statement queues in the same line and is refused by
 * the same spent handle.
 */
describe("statements for another database", () => {
	test("carry the database prefix into the transaction", async () => {
		const { handle, events } = immediateHandle();
		const executor = new TransactionExecutor(handle, "3.2.4");

		await executor.forDatabase("other").query("CREATE t:one");

		expect(events).toEqual(["USE DB `other`; CREATE t:one"]);
	});

	test("queue behind statements issued for the connected one", async () => {
		const { handle, events, resolvers } = recordingHandle();
		const executor = new TransactionExecutor(handle, "3.2.4");

		const first = executor.query("one");
		const second = executor.forDatabase("other").query("two");

		await Promise.resolve();
		expect(events).toEqual(["start:one"]);

		resolvers[0]?.();
		await first;
		await Promise.resolve();
		resolvers[1]?.();
		await second;

		expect(events).toEqual([
			"start:one",
			"end:one",
			"start:USE DB `other`; two",
			"end:USE DB `other`; two",
		]);
	});

	test("are refused once the transaction has been settled", async () => {
		const { handle, events } = immediateHandle();
		const executor = new TransactionExecutor(handle, "3.2.4");
		const other = executor.forDatabase("other");

		await executor.commit();

		await expect(other.query("late")).rejects.toBeInstanceOf(
			MongoTransactionError,
		);
		expect(events).toEqual(["commit"]);
	});

	test("read their own result, not the prefix's", async () => {
		const handle: TransactionHandle = {
			query: <R extends unknown[] = unknown[]>(): HandleReply<R> =>
				reply(
					Promise.resolve([{ database: "other" }, ["row"]] as unknown as R),
					"",
				),
			commit: async () => {},
			cancel: async () => {},
		};
		const executor = new TransactionExecutor(handle, "3.2.4");

		expect(
			await executor.forDatabase("other").query<string[]>("SELECT 1"),
		).toEqual(["row"]);
	});
});
