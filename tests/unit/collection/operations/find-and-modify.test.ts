import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
	findOneAndDelete,
	findOneAndReplace,
	findOneAndUpdate,
} from "../../../../src/collection/operations/find-and-modify.ts";
import { MongoInvalidArgumentError } from "../../../../src/errors.ts";
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
			"UPDATE $__rid SET age += $p0 RETURN BEFORE",
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

	test("includeResultMetadata reports the command reply, ok=1 even on no match", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]); // no match
		const r = (await findOneAndUpdate<User>(
			ctx,
			{ _id: "x" },
			{ $set: { age: 1 } },
			{ includeResultMetadata: true },
		)) as ModifyResult<User>;
		expect(r).toEqual({
			lastErrorObject: { n: 0, updatedExisting: false },
			value: null,
			ok: 1,
		});
	});

	test("includeResultMetadata reports updatedExisting when the document is found", async () => {
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
		expect(r.lastErrorObject).toEqual({ n: 1, updatedExisting: true });
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
		expect(executor.queries[1].sql).toContain("grades[WHERE score >= $p0]");
	});

	test("sort decides which document is modified, by ordering the id lookup", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		const rid = new RecordId("users", "a");
		executor.enqueue([{ id: rid }]).enqueue([{ id: rid }]);

		await findOneAndUpdate<User>(
			ctx,
			{},
			{ $set: { age: 1 } },
			{
				sort: { age: -1 },
			},
		);

		// The sort's column is selected alongside `id` because SurrealDB rejects an
		// `ORDER BY` naming an idiom the field list does not carry.
		expect(executor.queries[0].sql).toBe(
			"SELECT id, age FROM users ORDER BY age DESC LIMIT 1",
		);
	});

	test("projection is applied to the returned document", async () => {
		const { ctx, executor } = makeContext();
		const rid = new RecordId("users", "a");
		executor
			.enqueue([{ id: rid }])
			.enqueue([{ id: rid, name: "Alice", password: "hunter2" }]);

		const out = (await findOneAndUpdate<User>(
			ctx,
			{},
			{ $set: { age: 1 } },
			{
				projection: { name: 1, _id: 0 },
			},
		)) as User;

		expect(out).toEqual({ name: "Alice" } as unknown as User);
	});

	test("upsert inserts the document seeded from the filter and reports it", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		executor
			.enqueue([]) // no match
			.enqueue([{ id: new RecordId("users", "x"), email: "a@b.c", hits: 1 }]);

		const r = (await findOneAndUpdate<User>(
			ctx,
			{ email: "a@b.c" },
			{ $inc: { hits: 1 } },
			{ upsert: true, returnDocument: "after", includeResultMetadata: true },
		)) as ModifyResult<User>;

		expect(executor.queries[1].sql).toBe(
			"UPSERT $__rid SET email = $p0, hits += $p1 RETURN AFTER",
		);
		expect(executor.queries[1].bindings?.p0).toBe("a@b.c");
		expect(r.value).toMatchObject({ email: "a@b.c", hits: 1 });
		expect(r.lastErrorObject?.updatedExisting).toBe(false);
		expect(r.lastErrorObject?.upserted).toBeDefined();
	});

	test("upsert returns null for the pre-image of a document that did not exist", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]).enqueue([{ id: new RecordId("users", "x") }]);

		const out = await findOneAndUpdate<User>(
			ctx,
			{ email: "a@b.c" },
			{ $set: { hits: 1 } },
			{ upsert: true },
		);

		expect(out).toBeNull();
		// The write still happened, which is what makes get-or-create work.
		expect(executor.queries.length).toBe(2);
	});

	test("an _id in the filter becomes the upserted record's identity", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		executor.enqueue([]).enqueue([{ id: new RecordId("users", "fixed") }]);

		await findOneAndUpdate<User>(
			ctx,
			{ _id: "fixed" },
			{ $set: { age: 1 } },
			{
				upsert: true,
			},
		);

		const rid = executor.queries[1].bindings?.__rid as RecordId;
		expect(rid.id).toBe("fixed");
		// `_id` addresses the record; it must not also be written as a field.
		expect(executor.queries[1].sql).toBe(
			"UPSERT $__rid SET age = $p0 RETURN AFTER",
		);
	});
});

describe("findOneAndDelete", () => {
	test("performs SELECT id LIMIT 1 then DELETE $__rid RETURN BEFORE", async () => {
		const { ctx, executor } = makeContext();
		const rid = new RecordId("users", "a");
		executor.enqueue([{ id: rid }]).enqueue([{ id: rid, name: "Alice" }]);

		const out = await findOneAndDelete<User>(ctx, { name: "Alice" });

		expect(executor.queries[0].sql).toBe(
			"SELECT id FROM users WHERE (name = $p0 OR (type::is_array(name) AND name CONTAINS $p0)) LIMIT 1",
		);
		expect(executor.queries[1].sql).toBe("DELETE $__rid RETURN BEFORE");
		expect(out).toMatchObject({ name: "Alice" });
	});

	test("returns null when no match", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);
		expect(await findOneAndDelete<User>(ctx, { name: "ghost" })).toBeNull();
	});

	test("includeResultMetadata reports n=0 and no updatedExisting", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);
		const r = (await findOneAndDelete<User>(
			ctx,
			{ name: "ghost" },
			{ includeResultMetadata: true },
		)) as ModifyResult<User>;
		expect(r).toEqual({ lastErrorObject: { n: 0 }, value: null, ok: 1 });
	});

	test("sort and projection reach the lookup and the returned document", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		const rid = new RecordId("users", "a");
		executor
			.enqueue([{ id: rid }])
			.enqueue([{ id: rid, name: "Alice", password: "x" }]);

		const out = await findOneAndDelete<User>(
			ctx,
			{},
			{
				sort: { age: 1 },
				projection: { password: 0 },
			},
		);

		expect(executor.queries[0].sql).toBe(
			"SELECT id, age FROM users ORDER BY age ASC LIMIT 1",
		);
		expect(out).toEqual({ _id: "a", name: "Alice" } as unknown as User);
	});
});

describe("findOneAndReplace", () => {
	test("requires a non-empty filter (caller error, not a server error)", async () => {
		const { ctx } = makeContext();
		await expect(
			findOneAndReplace<User>(ctx, {}, { name: "x", age: 0 } as User),
		).rejects.toBeInstanceOf(MongoInvalidArgumentError);
	});

	test("returns null when no match", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]); // SELECT id LIMIT 1
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
			.enqueue([{ id: rid }]) // SELECT id LIMIT 1
			.enqueue([{ id: rid, name: "Old", age: 10 }]); // UPDATE … RETURN BEFORE

		const out = (await findOneAndReplace<User>(ctx, { name: "Old" }, {
			name: "New",
			age: 1,
		} as User)) as User;

		expect(out.name).toBe("Old");
	});

	test("returnDocument=after returns the post-image", async () => {
		const { ctx, executor } = makeContext();
		const rid = new RecordId("users", "a");
		executor.enqueue([{ id: rid }]).enqueue([{ id: rid, name: "New", age: 1 }]);

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
		executor.enqueue([{ id: rid }]).enqueue([{ id: rid, name: "New" }]);

		await findOneAndReplace<User>(ctx, { name: "Old" }, {
			name: "New",
			age: 1,
		} as User);

		expect(executor.queries[1].sql).toBe(
			"UPDATE $__rid CONTENT $p0 RETURN BEFORE",
		);
		expect(executor.queries[1].bindings?.__rid).toBe(rid);
		expect(executor.queries[1].bindings?.p0).toEqual({
			name: "New",
			age: 1,
		});
	});

	test("upsert creates exactly the replacement, not the filter's fields", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		executor.enqueue([]).enqueue([{ id: new RecordId("users", "x"), r: 1 }]);

		const out = await findOneAndReplace<User>(
			ctx,
			{ k: 7 },
			{ r: 1 } as unknown as User,
			{ upsert: true, returnDocument: "after" },
		);

		expect(executor.queries[1].sql).toBe(
			"CREATE $__rid CONTENT $__doc RETURN AFTER",
		);
		expect(executor.queries[1].bindings?.__doc).toEqual({ r: 1 });
		expect(out).toMatchObject({ r: 1 });
	});
});
