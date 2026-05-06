import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
	findOneAndDelete,
	findOneAndReplace,
	findOneAndUpdate,
} from "../../../../src/collection/operations/find-and-modify.ts";
import { MongoServerError } from "../../../../src/errors.ts";
import type { Document, ModifyResult } from "../../../../src/types.ts";
import { makeContext } from "../../../helpers/operation-context.ts";

interface User extends Document {
	_id: string;
	name: string;
	age: number;
}

describe("findOneAndUpdate", () => {
	test("default returnDocument=before emits RETURN BEFORE and returns the pre-image", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		const rid = new RecordId("users", "alice");
		executor
			.enqueue([{ id: rid }]) // SELECT id LIMIT 1
			.enqueue([{ id: rid, name: "Alice", age: 30 }]); // UPDATE $__rid RETURN BEFORE

		const out = (await findOneAndUpdate<User>(
			ctx,
			{ name: "Alice" },
			{ $inc: { age: 1 } },
		)) as User;

		expect(executor.queries[1].sql).toBe(
			"UPDATE $__rid SET age += $p1 RETURN BEFORE",
		);
		expect(out.age).toBe(30);
	});

	test("returnDocument=after emits RETURN AFTER", async () => {
		const { ctx, executor } = makeContext();
		const rid = new RecordId("users", "alice");
		executor.enqueue([{ id: rid }]).enqueue([{ id: rid, age: 31 }]);

		await findOneAndUpdate<User>(
			ctx,
			{ name: "Alice" },
			{ $inc: { age: 1 } },
			{ returnDocument: "after" },
		);

		expect(executor.queries[1].sql).toContain("RETURN AFTER");
	});

	test("returns null when no match (no metadata)", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]); // SELECT id empty
		expect(
			await findOneAndUpdate<User>(ctx, { _id: "x" }, { $set: { age: 1 } }),
		).toBeNull();
		expect(executor.queries.length).toBe(1);
	});

	test("includeResultMetadata wraps the value in { value, ok }", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]); // no match
		const r = (await findOneAndUpdate<User>(
			ctx,
			{ _id: "x" },
			{ $set: { age: 1 } },
			{ includeResultMetadata: true },
		)) as ModifyResult<User>;
		expect(r).toEqual({ value: null, ok: 0 });
	});

	test("includeResultMetadata=true returns ok=1 when the document is found", async () => {
		const { ctx, executor } = makeContext();
		const rid = new RecordId("users", "a");
		executor.enqueue([{ id: rid }]).enqueue([{ id: rid, age: 10 }]);
		const r = (await findOneAndUpdate<User>(
			ctx,
			{ _id: "a" },
			{ $set: { age: 11 } },
			{ includeResultMetadata: true },
		)) as ModifyResult<User>;
		expect(r.ok).toBe(1);
		expect(r.value?.age).toBe(10); // RETURN BEFORE default
	});

	test("forwards arrayFilters into the SET clause", async () => {
		const { ctx, executor } = makeContext();
		const rid = new RecordId("users", "a");
		executor.enqueue([{ id: rid }]).enqueue([{ id: rid }]);
		await findOneAndUpdate<User>(
			ctx,
			{ _id: "a" },
			{ $set: { "grades.$[g].adjusted": true } },
			{ arrayFilters: [{ "g.score": { $gte: 90 } }] },
		);
		expect(executor.queries[1].sql).toContain("grades[WHERE score >= $p1]");
	});
});

describe("findOneAndDelete", () => {
	test("performs SELECT id LIMIT 1 then DELETE $__rid RETURN BEFORE", async () => {
		const { ctx, executor } = makeContext();
		const rid = new RecordId("users", "a");
		executor.enqueue([{ id: rid }]).enqueue([{ id: rid, name: "Alice" }]);

		const out = await findOneAndDelete<User>(ctx, { name: "Alice" });

		expect(executor.queries[0].sql).toBe(
			"SELECT id FROM users WHERE name = $p0 LIMIT 1",
		);
		expect(executor.queries[1].sql).toBe("DELETE $__rid RETURN BEFORE");
		expect(out).toMatchObject({ name: "Alice" });
	});

	test("returns null when no match", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);
		expect(await findOneAndDelete<User>(ctx, { name: "ghost" })).toBeNull();
	});

	test("includeResultMetadata wraps the result", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);
		const r = (await findOneAndDelete<User>(
			ctx,
			{ name: "ghost" },
			{ includeResultMetadata: true },
		)) as ModifyResult<User>;
		expect(r).toEqual({ value: null, ok: 0 });
	});
});

describe("findOneAndReplace", () => {
	test("requires a non-empty filter (Mongo-compat error)", async () => {
		const { ctx } = makeContext();
		await expect(
			findOneAndReplace<User>(ctx, {}, { name: "x", age: 0 } as User),
		).rejects.toBeInstanceOf(MongoServerError);
	});

	test("returns null when no match", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]); // first SELECT * LIMIT 1
		const out = await findOneAndReplace<User>(ctx, { name: "ghost" }, {
			name: "x",
			age: 1,
		} as User);
		expect(out).toBeNull();
	});

	test("default returnDocument=before returns the pre-image", async () => {
		const { ctx, executor } = makeContext();
		const rid = new RecordId("users", "a");
		executor
			.enqueue([{ id: rid, name: "Old", age: 10 }]) // SELECT * LIMIT 1
			.enqueue([{ id: rid, name: "New", age: 1 }]); // UPDATE $rid CONTENT … RETURN AFTER

		const out = (await findOneAndReplace<User>(ctx, { name: "Old" }, {
			name: "New",
			age: 1,
		} as User)) as User;

		expect(out.name).toBe("Old");
	});

	test("returnDocument=after returns the post-image", async () => {
		const { ctx, executor } = makeContext();
		const rid = new RecordId("users", "a");
		executor
			.enqueue([{ id: rid, name: "Old", age: 10 }])
			.enqueue([{ id: rid, name: "New", age: 1 }]);

		const out = (await findOneAndReplace<User>(
			ctx,
			{ name: "Old" },
			{ name: "New", age: 1 } as User,
			{ returnDocument: "after" },
		)) as User;

		expect(out.name).toBe("New");
	});

	test("UPDATE statement uses CONTENT $… and binds the rid", async () => {
		const { ctx, executor } = makeContext();
		const rid = new RecordId("users", "a");
		executor
			.enqueue([{ id: rid, name: "Old" }])
			.enqueue([{ id: rid, name: "New" }]);

		await findOneAndReplace<User>(ctx, { name: "Old" }, {
			name: "New",
			age: 1,
		} as User);

		expect(executor.queries[1].sql).toBe(
			"UPDATE $rid CONTENT $p1 RETURN AFTER",
		);
		expect(executor.queries[1].bindings?.rid).toBe(rid);
		expect(executor.queries[1].bindings?.p1).toEqual({
			name: "New",
			age: 1,
		});
	});
});
