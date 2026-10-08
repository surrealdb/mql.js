import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import { ConnectionManager } from "../../../src/client/connection-manager.ts";

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
