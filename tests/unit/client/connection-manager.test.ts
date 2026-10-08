import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import {
	assertTransportAvailable,
	ConnectionManager,
} from "../../../src/client/connection-manager.ts";
import { MongoCompatibilityError } from "../../../src/errors.ts";

/** Minimal `Surreal` stub that records the SQL passed to `query()`. */
function makeSurrealStub(opts: { throwOnQuery?: boolean } = {}): {
	surreal: Surreal;
	queries: string[];
} {
	const queries: string[] = [];
	const surreal = {
		query(sql: string) {
			queries.push(sql);
			// The SDK's query object answers `.responses()` with every statement's
			// outcome and rejects only for the dispatch itself.
			return {
				async responses() {
					if (opts.throwOnQuery) throw new Error("permission denied");
					return [];
				},
			};
		},
	} as unknown as Surreal;
	return { surreal, queries };
}

describe("ConnectionManager.ensureNamespaceAndDatabase", () => {
	test("defines both namespace and database when both are provided", async () => {
		const { surreal, queries } = makeSurrealStub();
		await new ConnectionManager(surreal).ensureNamespaceAndDatabase(
			"test",
			"mydb",
		);

		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain("DEFINE NAMESPACE IF NOT EXISTS `test`");
		expect(queries[0]).toContain("DEFINE DATABASE IF NOT EXISTS `mydb`");
	});

	test("escapes identifiers that require quoting", async () => {
		const { surreal, queries } = makeSurrealStub();
		await new ConnectionManager(surreal).ensureNamespaceAndDatabase(
			"with space",
			"db-1",
		);

		expect(queries[0]).toContain("DEFINE NAMESPACE IF NOT EXISTS `with space`");
		expect(queries[0]).toContain("DEFINE DATABASE IF NOT EXISTS `db-1`");
	});

	test("only defines the namespace when no database is given", async () => {
		const { surreal, queries } = makeSurrealStub();
		await new ConnectionManager(surreal).ensureNamespaceAndDatabase(
			"test",
			undefined,
		);

		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain("DEFINE NAMESPACE IF NOT EXISTS `test`");
		expect(queries[0]).not.toContain("DEFINE DATABASE");
	});

	test("issues no query when neither is given", async () => {
		const { surreal, queries } = makeSurrealStub();
		await new ConnectionManager(surreal).ensureNamespaceAndDatabase(
			undefined,
			undefined,
		);

		expect(queries).toHaveLength(0);
	});

	test("reads every statement's outcome rather than awaiting the query", async () => {
		// The awaited query throws at the first statement that fails and, from SDK
		// 2.1.0 on a 3.3+ server, cancels the ones behind it: a user who may define
		// a database but not its namespace would then never get the database. A
		// stub that only answers `.responses()` fails this test if the call
		// reverts to awaiting the query itself.
		const { surreal, queries } = makeSurrealStub();
		await new ConnectionManager(surreal).ensureNamespaceAndDatabase(
			"test",
			"mydb",
		);
		expect(queries).toHaveLength(1);
	});

	test("swallows errors so a usable connection is never broken", async () => {
		const { surreal } = makeSurrealStub({ throwOnQuery: true });

		let threw = false;
		try {
			await new ConnectionManager(surreal).ensureNamespaceAndDatabase(
				"test",
				"mydb",
			);
		} catch {
			threw = true;
		}

		expect(threw).toBe(false);
	});
});

describe("a runtime with no global WebSocket", () => {
	/**
	 * Node has no global `WebSocket` before 22 (20.10+ behind a flag). The SDK then
	 * throws a `TypeError` from a loop nothing awaits, and `connect()` never
	 * settles, or the process dies. Measured by deleting the global under Node 26.
	 */
	const without = async <T>(work: () => Promise<T> | T): Promise<T> => {
		const original = globalThis.WebSocket;
		// biome-ignore lint/suspicious/noExplicitAny: removing a global to simulate a runtime
		delete (globalThis as any).WebSocket;
		try {
			return await work();
		} finally {
			globalThis.WebSocket = original;
		}
	};

	test("refuses a ws:// or wss:// connection by name, before the SDK is asked", async () => {
		const { surreal, calls } = connectStub();
		for (const url of [
			"ws://localhost:8000/rpc",
			"wss://db.example/rpc",
			"WS://x",
		]) {
			await without(async () => {
				await expect(
					new ConnectionManager(surreal).connect({ url, options: {} }),
				).rejects.toThrow(MongoCompatibilityError);
			});
		}
		expect(calls.connect).toBe(0);
	});

	test("says what to do about it", async () => {
		await without(() => {
			expect(() => assertTransportAvailable("ws://x")).toThrow(
				/--experimental-websocket/,
			);
			expect(() => assertTransportAvailable("ws://x")).toThrow(
				/http:\/\/ or https:\/\//,
			);
		});
	});

	test("an http:// connection needs none, so is not refused", async () => {
		await without(() => {
			expect(() =>
				assertTransportAvailable("http://localhost:8000"),
			).not.toThrow();
			expect(() =>
				assertTransportAvailable("https://db.example"),
			).not.toThrow();
		});
	});

	test("a runtime that has one is not refused", () => {
		expect(typeof globalThis.WebSocket).toBe("function");
		expect(() =>
			assertTransportAvailable("ws://localhost:8000/rpc"),
		).not.toThrow();
	});
});

/** A `Surreal` whose `connect` succeeds at once and counts being called. */
function connectStub(): { surreal: Surreal; calls: { connect: number } } {
	const calls = { connect: 0 };
	const surreal = {
		subscribe: () => () => undefined,
		async connect() {
			calls.connect += 1;
		},
		async close() {
			return undefined;
		},
	} as unknown as Surreal;
	return { surreal, calls };
}
