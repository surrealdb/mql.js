import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { replaceOne } from "../../../../src/collection/operations/replace.ts";
import { makeContext } from "../../../helpers/operation-context.ts";

describe("replaceOne", () => {
	test("names the matching record in a subquery and gives it new content", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([{ id: new RecordId("users", "a"), name: "New" }]);

		const result = await replaceOne(ctx, { name: "Old" }, {
			name: "New",
		} as never);

		expect(executor.queries[0].sql).toBe(
			"UPDATE (SELECT VALUE id FROM (SELECT id FROM `users` " +
				"WHERE (`name` = $p0 OR (type::is_array(`name`) AND `name` CONTAINS $p0)) " +
				"LIMIT 1)) CONTENT $p1",
		);
		expect(result.matchedCount).toBe(1);
		expect(result.modifiedCount).toBe(1);
	});

	// An empty filter matches every document, and MongoDB replaces the first of
	// them — measured against a real mongod, which replaces the document that comes
	// first in natural order and reports `matchedCount: 1`.
	test("accepts an empty filter and targets the first document", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([{ id: new RecordId("users", "a"), name: "New" }]);

		const result = await replaceOne(ctx, {}, { name: "New" } as never);

		expect(executor.queries[0].sql).toBe(
			"UPDATE (SELECT VALUE id FROM (SELECT id FROM `users` LIMIT 1)) CONTENT $p0",
		);
		expect(result.matchedCount).toBe(1);
	});

	test("an empty filter that matches nothing reports nothing matched", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);

		const result = await replaceOne(ctx, {}, { name: "New" } as never);

		expect(result.matchedCount).toBe(0);
		expect(result.modifiedCount).toBe(0);
		expect(result.upsertedId).toBeNull();
	});

	test("an empty filter with upsert inserts the replacement as given", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]); // nothing to replace
		executor.enqueue([{ id: new RecordId("users", "gen"), v: 1 }]);

		const result = await replaceOne(ctx, {}, { v: 1 } as never, {
			upsert: true,
		});

		// Nothing is seeded from an empty filter, so the created document is exactly
		// the replacement — which is what MongoDB creates.
		expect(executor.queries[1].sql).toBe(
			"CREATE $__rid CONTENT $__doc RETURN AFTER",
		);
		expect(executor.queries[1].bindings?.__doc).toEqual({ v: 1 });
		expect(result.upsertedId).not.toBeNull();
	});

	test("a caller's sort decides which document an empty filter replaces", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([{ id: new RecordId("users", "a"), v: 99 }]);

		await replaceOne(ctx, {}, { v: 99 } as never, { sort: { v: -1 } });

		// The sort column joins `id` in the field list because SurrealDB refuses an
		// `ORDER BY` naming an idiom the selection does not; `SELECT VALUE id` then
		// discards it.
		expect(executor.queries[0].sql).toBe(
			"UPDATE (SELECT VALUE id FROM (SELECT id, `v` FROM `users` " +
				"ORDER BY `v` DESC LIMIT 1)) CONTENT $p0",
		);
	});
});
