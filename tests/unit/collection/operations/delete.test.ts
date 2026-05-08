import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
	deleteMany,
	deleteOne,
} from "../../../../src/collection/operations/delete.ts";
import { makeContext } from "../../../helpers/operation-context.ts";

describe("deleteOne", () => {
	test("performs SELECT id LIMIT 1 then DELETE $__rid", async () => {
		const { ctx, executor } = makeContext();
		const rid = new RecordId("users", "alice");
		executor.enqueue([{ id: rid }]).enqueue([{ id: rid }]);

		const result = await deleteOne(ctx, { name: "Alice" });

		expect(executor.queries[0].sql).toBe(
			"SELECT id FROM users WHERE name = $p0 LIMIT 1",
		);
		expect(executor.queries[1].sql).toBe("DELETE $__rid RETURN BEFORE");
		expect(executor.queries[1].bindings).toEqual({ __rid: rid });
		expect(result.deletedCount).toBe(1);
	});

	test("returns deletedCount=0 when no document matches", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]); // empty SELECT id

		const result = await deleteOne(ctx, { name: "ghost" });

		expect(result.deletedCount).toBe(0);
		expect(executor.queries.length).toBe(1); // no DELETE
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
			"DELETE FROM users WHERE status = $p0 RETURN BEFORE",
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
