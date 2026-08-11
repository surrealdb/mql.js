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

/** A handle that logs every dispatch and reply, so overlap is visible. */
function recordingHandle(): {
	handle: TransactionHandle;
	events: string[];
	resolvers: Array<() => void>;
} {
	const events: string[] = [];
	const resolvers: Array<() => void> = [];

	const handle: TransactionHandle = {
		query: <R extends unknown[] = unknown[]>(sql: string): PromiseLike<R> => {
			events.push(`start:${sql}`);
			return new Promise<R>((resolve) => {
				resolvers.push(() => {
					events.push(`end:${sql}`);
					resolve([sql] as unknown as R);
				});
			});
		},
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
			query: async <R extends unknown[] = unknown[]>(
				sql: string,
			): Promise<R> => {
				events.push(sql);
				return [sql] as unknown as R;
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
			query: async <R extends unknown[] = unknown[]>(
				sql: string,
			): Promise<R> => {
				events.push(sql);
				if (sql === "bad") throw new Error("rejected");
				return [sql] as unknown as R;
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
			query: async <R extends unknown[] = unknown[]>(): Promise<R> =>
				[] as unknown as R,
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
