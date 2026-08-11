import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
	updateMany,
	updateOne,
} from "../../../../src/collection/operations/update.ts";
import { makeContext } from "../../../helpers/operation-context.ts";

describe("updateOne", () => {
	test("performs a SELECT id LIMIT 1 then UPDATE $__rid", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		const rid = new RecordId("users", "alice");
		executor
			.enqueue([{ id: rid }]) // SELECT id … LIMIT 1
			.enqueue([{ id: rid }]); // UPDATE $__rid

		const result = await updateOne(
			ctx,
			{ name: "Alice" },
			{ $set: { age: 31 } },
		);

		expect(executor.queries[0].sql).toBe(
			"SELECT id FROM users WHERE (name = $p0 OR (type::is_array(name) AND name CONTAINS $p0)) LIMIT 1",
		);
		expect(executor.queries[0].bindings).toEqual({ p0: "Alice" });

		expect(executor.queries[1].sql).toBe("UPDATE $__rid SET age = $p1");
		expect(executor.queries[1].bindings).toEqual({
			p0: "Alice",
			p1: 31,
			__rid: rid,
		});

		expect(result.matchedCount).toBe(1);
		expect(result.modifiedCount).toBe(1);
		expect(result.upsertedId).toBeNull();
	});

	test("returns matched=0 when no document matches", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]); // SELECT id … LIMIT 1 → empty

		const result = await updateOne(ctx, { name: "ghost" }, { $set: { x: 1 } });

		expect(result.matchedCount).toBe(0);
		expect(executor.queries.length).toBe(1); // no UPDATE follow-up
	});

	test("upsert path takes the bulk UPSERT statement (no SELECT first)", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		const rid = new RecordId("users", "abc");
		executor.enqueue([{ id: rid, name: "X" }]);

		const result = await updateOne(
			ctx,
			{ name: "X" },
			{ $set: { age: 1 } },
			{ upsert: true },
		);

		expect(executor.queries.length).toBe(1);
		expect(executor.queries[0].sql).toBe(
			"UPSERT users SET age = $p1 WHERE (name = $p0 OR (type::is_array(name) AND name CONTAINS $p0))",
		);
		expect(executor.queries[0].bindings).toEqual({ p0: "X", p1: 1 });
		expect(result.upsertedId).toBeTruthy();
		expect(result.upsertedCount).toBe(1);
	});
});

describe("updateMany", () => {
	test("emits a single UPDATE … WHERE statement", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		executor.enqueue([
			{ id: new RecordId("users", "a") },
			{ id: new RecordId("users", "b") },
		]);

		const result = await updateMany(
			ctx,
			{ status: "active" },
			{ $set: { tier: "gold" } },
		);

		expect(executor.queries.length).toBe(1);
		expect(executor.queries[0].sql).toBe(
			"UPDATE users SET tier = $p1 WHERE (status = $p0 OR (type::is_array(status) AND status CONTAINS $p0))",
		);
		expect(executor.queries[0].bindings).toEqual({
			p0: "active",
			p1: "gold",
		});
		expect(result.matchedCount).toBe(2);
		expect(result.modifiedCount).toBe(2);
	});

	test("empty filter omits WHERE", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);
		await updateMany(ctx, {}, { $set: { x: 1 } });
		expect(executor.queries[0].sql).toBe("UPDATE users SET x = $p0");
	});

	test("forwards arrayFilters into the SET clause translator", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);
		await updateMany(
			ctx,
			{},
			{ $inc: { "items.$[item].qty": 1 } },
			{ arrayFilters: [{ "item.status": "active" }] },
		);
		expect(executor.queries[0].sql).toContain("WHERE status = $p0");
		expect(executor.queries[0].sql).toContain("items[WHERE status = $p0].qty");
	});
});
