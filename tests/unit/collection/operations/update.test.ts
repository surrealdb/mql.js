import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
	updateMany,
	updateOne,
} from "../../../../src/collection/operations/update.ts";
import { makeContext } from "../../../helpers/operation-context.ts";

describe("updateOne", () => {
	test("chooses and updates its one record in a single statement", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		const rid = new RecordId("users", "alice");
		executor.enqueue([{ id: rid }]);

		const result = await updateOne(
			ctx,
			{ name: "Alice" },
			{ $set: { age: 31 } },
		);

		// The `LIMIT 1` lookup is a subquery of the `UPDATE`, so choosing the
		// document and writing it are one statement — and one SurrealQL statement is
		// one transaction. Resolved as two round trips instead, the write applies to
		// whatever the id names by the time it arrives: four clients racing to claim
		// one document that way produced two or more winners in 498 of 500 attempts,
		// where this shape produced a single winner in 972 of 1000. Splitting it back
		// into a pair of queries is the regression this guards.
		expect(executor.queries.length).toBe(1);
		expect(executor.queries[0].sql).toBe(
			"UPDATE (SELECT VALUE id FROM (SELECT id FROM `users` WHERE (`name` = $p0 OR (type::is_array(`name`) AND `name` CONTAINS $p0)) LIMIT 1)) SET `age` = $p1",
		);
		// The filter's placeholders are numbered first, so the update's continue
		// from where they stopped rather than colliding with them.
		expect(executor.queries[0].bindings).toEqual({ p0: "Alice", p1: 31 });

		expect(result.matchedCount).toBe(1);
		expect(result.modifiedCount).toBe(1);
		expect(result.upsertedId).toBeNull();
	});

	test("returns matched=0 when no document matches", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]); // the statement updated nothing

		const result = await updateOne(ctx, { name: "ghost" }, { $set: { x: 1 } });

		expect(result.matchedCount).toBe(0);
		expect(executor.queries.length).toBe(1);
	});

	test("upsert with no match inserts a document seeded from the filter", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		executor
			.enqueue([]) // the update matched nothing
			.enqueue([{ id: new RecordId("users", "abc"), name: "X", age: 1 }]);

		const result = await updateOne(
			ctx,
			{ name: "X" },
			{ $set: { age: 1 } },
			{ upsert: true },
		);

		// The created document carries the filter's `name`, without which the
		// next call with the same filter would insert a second one.
		expect(executor.queries[1].sql).toBe(
			"UPSERT $__rid SET `name` = $p0, `age` = $p1 RETURN AFTER",
		);
		expect(executor.queries[1].bindings?.p0).toBe("X");
		expect(result.upsertedId).toBeTruthy();
		expect(result.upsertedCount).toBe(1);
		expect(result.matchedCount).toBe(0);
	});

	test("upsert with a match updates the matched record only", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		executor.enqueue([{ id: new RecordId("users", "abc") }]);

		const result = await updateOne(
			ctx,
			{ name: "X" },
			{ $set: { age: 1 } },
			{ upsert: true },
		);

		// A match makes `upsert` a plain update, and the insert is never reached:
		// the one statement that ran is the update, and it carries no `UPSERT`.
		expect(executor.queries.length).toBe(1);
		expect(executor.queries[0].sql).toStartWith(
			"UPDATE (SELECT VALUE id FROM (",
		);
		expect(result.upsertedCount).toBe(0);
		expect(result.matchedCount).toBe(1);
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
			"UPDATE `users` SET `tier` = $p1 WHERE (`status` = $p0 OR (type::is_array(`status`) AND `status` CONTAINS $p0))",
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
		expect(executor.queries[0].sql).toBe("UPDATE `users` SET `x` = $p0");
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
		expect(executor.queries[0].sql).toContain("WHERE `status` = $p0");
		expect(executor.queries[0].sql).toContain(
			"`items`[WHERE `status` = $p0].`qty`",
		);
	});
});
