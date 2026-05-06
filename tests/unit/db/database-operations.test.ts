import { describe, expect, test } from "bun:test";
import {
	createCollectionTable,
	dropCollectionTable,
	dropDatabase,
	listCollections,
} from "../../../src/db/database-operations.ts";
import { FakeQueryExecutor } from "../../helpers/fake-executor.ts";

describe("listCollections", () => {
	test("maps SurrealDB INFO FOR DB tables to CollectionInfo[]", async () => {
		const exec = new FakeQueryExecutor();
		exec.enqueue({
			tables: { users: "DEFINE TABLE users", logs: "DEFINE TABLE logs" },
		});
		const out = await listCollections(exec);

		expect(exec.queries[0].sql).toBe("INFO FOR DB");
		expect(out).toEqual([
			{ name: "users", type: "collection" },
			{ name: "logs", type: "collection" },
		]);
	});

	test("falls back to the legacy `tb` field for older SurrealDB versions", async () => {
		const exec = new FakeQueryExecutor();
		exec.enqueue({ tb: { events: {} } });
		const out = await listCollections(exec);
		expect(out).toEqual([{ name: "events", type: "collection" }]);
	});

	test("returns [] when no INFO is reported", async () => {
		const exec = new FakeQueryExecutor();
		exec.enqueue(undefined);
		expect(await listCollections(exec)).toEqual([]);
	});

	test("returns [] when neither tables nor tb is present", async () => {
		const exec = new FakeQueryExecutor();
		exec.enqueue({});
		expect(await listCollections(exec)).toEqual([]);
	});
});

describe("createCollectionTable", () => {
	test("emits DEFINE TABLE with the escaped name", async () => {
		const exec = new FakeQueryExecutor();
		exec.enqueue(undefined);
		await createCollectionTable(exec, "users");
		expect(exec.queries[0].sql).toBe("DEFINE TABLE users");
	});

	test("escapes weird names with backticks", async () => {
		const exec = new FakeQueryExecutor();
		exec.enqueue(undefined);
		await createCollectionTable(exec, "with spaces");
		expect(exec.queries[0].sql).toBe("DEFINE TABLE `with spaces`");
	});
});

describe("dropCollectionTable", () => {
	test("emits REMOVE TABLE and returns true on success", async () => {
		const exec = new FakeQueryExecutor();
		exec.enqueue(undefined);
		const ok = await dropCollectionTable(exec, "users");
		expect(ok).toBe(true);
		expect(exec.queries[0].sql).toBe("REMOVE TABLE users");
	});

	test("swallows errors and returns false (Mongo-compat)", async () => {
		const exec = new FakeQueryExecutor();
		exec.query = async () => {
			throw new Error("permission denied");
		};
		expect(await dropCollectionTable(exec, "users")).toBe(false);
	});
});

describe("dropDatabase", () => {
	test("emits REMOVE DATABASE with the database name", async () => {
		const exec = new FakeQueryExecutor();
		exec.enqueue(undefined);
		const ok = await dropDatabase(exec, "mydb");
		expect(ok).toBe(true);
		expect(exec.queries[0].sql).toBe("REMOVE DATABASE mydb");
	});

	test("returns false on error", async () => {
		const exec = new FakeQueryExecutor();
		exec.query = async () => {
			throw new Error("forbidden");
		};
		expect(await dropDatabase(exec, "mydb")).toBe(false);
	});
});
