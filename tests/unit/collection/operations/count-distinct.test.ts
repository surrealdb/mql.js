import { describe, expect, test } from "bun:test";
import {
	countDocuments,
	estimatedDocumentCount,
} from "../../../../src/collection/operations/count.ts";
import { distinct } from "../../../../src/collection/operations/distinct.ts";
import { makeContext } from "../../../helpers/operation-context.ts";

describe("countDocuments", () => {
	test("emits SELECT count() … GROUP ALL", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		executor.enqueue([{ count: 5 }]);

		const n = await countDocuments(ctx, { active: true });

		expect(executor.queries[0].sql).toBe(
			"SELECT count() AS count FROM users WHERE active = $p0 GROUP ALL",
		);
		expect(executor.queries[0].bindings).toEqual({ p0: true });
		expect(n).toBe(5);
	});

	test("returns 0 when SurrealDB returns no rows", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);
		expect(await countDocuments(ctx)).toBe(0);
	});

	test("appends START / LIMIT for skip / limit options", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([{ count: 1 }]);
		await countDocuments(ctx, undefined, { skip: 10, limit: 5 });
		expect(executor.queries[0].sql).toBe(
			"SELECT count() AS count FROM users GROUP ALL START 10 LIMIT 5",
		);
	});

	test("treats missing `count` field as 0", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([{ count: undefined }]);
		expect(await countDocuments(ctx)).toBe(0);
	});
});

describe("estimatedDocumentCount", () => {
	test("delegates to countDocuments() with no filter", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([{ count: 12 }]);
		expect(await estimatedDocumentCount(ctx)).toBe(12);
		expect(executor.queries[0].sql).toBe(
			"SELECT count() AS count FROM users GROUP ALL",
		);
	});
});

describe("distinct", () => {
	test("emits SELECT array::distinct(<key>) AS vals … GROUP ALL", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		executor.enqueue([{ vals: ["alice", "bob"] }]);

		const out = await distinct(ctx, "name", { active: true });

		expect(executor.queries[0].sql).toBe(
			"SELECT array::distinct(name) AS vals FROM users WHERE active = $p0 GROUP ALL",
		);
		expect(executor.queries[0].bindings).toEqual({ p0: true });
		expect(out).toEqual(["alice", "bob"]);
	});

	test("returns [] when no rows", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);
		expect(await distinct(ctx, "name")).toEqual([]);
	});

	test("returns [] when vals is missing on the row", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([{}]);
		expect(await distinct(ctx, "name")).toEqual([]);
	});
});
