import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
	deleteMany,
	deleteOne,
} from "../../../../src/collection/operations/delete.ts";
import { makeContext } from "../../../helpers/operation-context.ts";

describe("deleteOne", () => {
	test("chooses and deletes its one record in a single statement", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([{ id: new RecordId("users", "alice") }]);

		const result = await deleteOne(ctx, { name: "Alice" });

		// The `LIMIT 1` lookup is a subquery of the `DELETE`, not a query of its own,
		// and that is the operation's atomicity: split across two round trips,
		// another client can change the document out of the filter in between and
		// the delete lands anyway — 498 of 500 four-way races resolved wrongly that
		// way, against 28 of 1000 as one statement (see `modify-one.ts`).
		expect(executor.queries.length).toBe(1);
		expect(executor.queries[0].sql).toBe(
			"DELETE (SELECT VALUE id FROM (SELECT id FROM users WHERE (name = $p0 OR (type::is_array(name) AND name CONTAINS $p0)) LIMIT 1)) RETURN BEFORE",
		);
		expect(executor.queries[0].bindings).toEqual({ p0: "Alice" });
		// `RETURN BEFORE` is what makes the reply countable: one pre-image per
		// record the statement removed.
		expect(result.deletedCount).toBe(1);
	});

	test("returns deletedCount=0 when no document matches", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]); // the statement deleted nothing

		const result = await deleteOne(ctx, { name: "ghost" });

		expect(result.deletedCount).toBe(0);
		expect(executor.queries.length).toBe(1);
	});
});

describe("deleteMany", () => {
	test("emits DELETE … WHERE … RETURN BEFORE", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([
			{ id: new RecordId("users", "a") },
			{ id: new RecordId("users", "b") },
		]);

		const result = await deleteMany(ctx, { status: "deleted" });

		expect(executor.queries.length).toBe(1);
		expect(executor.queries[0].sql).toBe(
			"DELETE FROM users WHERE (status = $p0 OR (type::is_array(status) AND status CONTAINS $p0)) RETURN BEFORE",
		);
		expect(result.deletedCount).toBe(2);
	});

	test("undefined / empty filter deletes everything", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);
		await deleteMany(ctx);
		expect(executor.queries[0].sql).toBe("DELETE FROM users RETURN BEFORE");
	});

	test("returns deletedCount=0 when no rows", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue(undefined);
		const result = await deleteMany(ctx, {});
		expect(result.deletedCount).toBe(0);
	});
});
