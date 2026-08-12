import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
	findOneAndDelete,
	findOneAndReplace,
	findOneAndUpdate,
} from "../../../../src/collection/operations/find-and-modify.ts";
import type { Document, ModifyResult } from "../../../../src/types.ts";
import { makeContext } from "../../../helpers/operation-context.ts";

interface User extends Document {
	_id: string;
	name: string;
	age: number;
}

describe("findOneAndUpdate", () => {
	test("chooses, updates and returns its one record in a single statement", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		const rid = new RecordId("users", "alice");
		executor.enqueue([{ id: rid, name: "Alice", age: 30 }]);

		const out = (await findOneAndUpdate<User>(
			ctx,
			{ name: "Alice" },
			{ $inc: { age: 1 } },
		)) as User;

		// The lookup that decides *which* document is modified is a subquery of the
		// `UPDATE`, so no other client can act between the choice and the write —
		// one statement is one transaction. See `modify-one.ts` for what the same
		// pair costs when it is split over two round trips.
		expect(executor.queries.length).toBe(1);
		expect(executor.queries[0].sql).toBe(
			"UPDATE (SELECT VALUE id FROM (SELECT id FROM users WHERE (name = $p0 OR (type::is_array(name) AND name CONTAINS $p0)) LIMIT 1)) SET age += $p1 RETURN BEFORE",
		);
		// `RETURN BEFORE` on the same statement is also what makes the pre-image
		// available at all: fetching it separately afterwards would read the
		// document the update had already changed.
		expect(out.age).toBe(30);
	});

	test("returnDocument=after emits RETURN AFTER", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([{ id: new RecordId("users", "alice"), age: 31 }]);

		await findOneAndUpdate<User>(
			ctx,
			{ name: "Alice" },
			{ $inc: { age: 1 } },
			{ returnDocument: "after" },
		);

		expect(executor.queries[0].sql).toContain("RETURN AFTER");
	});

	test("returns null when no match (no metadata)", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]); // the statement modified nothing
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
		executor.enqueue([{ id: new RecordId("users", "a"), age: 10 }]);
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
		executor.enqueue([{ id: new RecordId("users", "a") }]);
		await findOneAndUpdate<User>(
			ctx,
			{ _id: "a" },
			{ $set: { "grades.$[g].adjusted": true } },
			{ arrayFilters: [{ "g.score": { $gte: 90 } }] },
		);
		expect(executor.queries[0].sql).toContain("grades[WHERE score >= $p1]");
	});

	test("sort decides which document is modified, by ordering the subquery that names it", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		executor.enqueue([{ id: new RecordId("users", "a") }]);

		await findOneAndUpdate<User>(
			ctx,
			{},
			{ $set: { age: 1 } },
			{
				sort: { age: -1 },
			},
		);

		// `UPDATE` takes neither `ORDER BY` nor `LIMIT`, so the sort belongs to the
		// subquery that names the target — and stays inside the one statement with
		// it, rather than deciding a target that a separate write then re-resolves.
		// The sort's column is selected alongside `id` because SurrealDB rejects an
		// `ORDER BY` naming an idiom the field list does not carry, and the enclosing
		// `SELECT VALUE id` drops it again.
		expect(executor.queries.length).toBe(1);
		expect(executor.queries[0].sql).toBe(
			"UPDATE (SELECT VALUE id FROM (SELECT id, age FROM users ORDER BY age DESC LIMIT 1)) SET age = $p0 RETURN BEFORE",
		);
	});

	test("projection is applied to the returned document", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([
			{ id: new RecordId("users", "a"), name: "Alice", password: "hunter2" },
		]);

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
	test("chooses, deletes and returns its one record in a single statement", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([{ id: new RecordId("users", "a"), name: "Alice" }]);

		const out = await findOneAndDelete<User>(ctx, { name: "Alice" });

		// One statement, so the document returned is provably the document deleted.
		// A `SELECT` followed by a `DELETE` could return a document another client
		// had already removed — and report it as this call's deletion.
		expect(executor.queries.length).toBe(1);
		expect(executor.queries[0].sql).toBe(
			"DELETE (SELECT VALUE id FROM (SELECT id FROM users WHERE (name = $p0 OR (type::is_array(name) AND name CONTAINS $p0)) LIMIT 1)) RETURN BEFORE",
		);
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

	test("sort orders the subquery, and the projection shapes what comes back", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		executor.enqueue([
			{ id: new RecordId("users", "a"), name: "Alice", password: "x" },
		]);

		const out = await findOneAndDelete<User>(
			ctx,
			{},
			{
				sort: { age: 1 },
				projection: { password: 0 },
			},
		);

		// The sort decides which document is deleted, so it has to be inside the
		// statement that deletes it; the projection shapes the pre-image the same
		// statement returned, since `RETURN BEFORE` hands back the whole record.
		expect(executor.queries.length).toBe(1);
		expect(executor.queries[0].sql).toBe(
			"DELETE (SELECT VALUE id FROM (SELECT id, age FROM users ORDER BY age ASC LIMIT 1)) RETURN BEFORE",
		);
		expect(out).toEqual({ _id: "a", name: "Alice" } as unknown as User);
	});
});

describe("findOneAndReplace", () => {
	// An empty filter matches every document, and MongoDB replaces the first of
	// them. The target subquery names one record with or without a `WHERE`, so no
	// clause has to be conditional on the filter having narrowed anything.
	test("an empty filter targets the first document", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([
			{ id: new RecordId("users", "a"), name: "Old", age: 10 },
		]);

		const out = (await findOneAndReplace<User>(ctx, {}, {
			name: "New",
			age: 1,
		} as User)) as User;

		expect(executor.queries[0].sql).toBe(
			"UPDATE (SELECT VALUE id FROM (SELECT id FROM users LIMIT 1)) CONTENT $p0 RETURN BEFORE",
		);
		expect(out).toEqual({ _id: "a", name: "Old", age: 10 } as unknown as User);
	});

	test("returns null when no match", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]); // the statement replaced nothing
		const out = await findOneAndReplace<User>(ctx, { name: "ghost" }, {
			name: "x",
			age: 1,
		} as User);
		expect(out).toBeNull();
	});

	test("default returnDocument=before returns the pre-image", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([
			{ id: new RecordId("users", "a"), name: "Old", age: 10 },
		]);

		const out = (await findOneAndReplace<User>(ctx, { name: "Old" }, {
			name: "New",
			age: 1,
		} as User)) as User;

		expect(out.name).toBe("Old");
	});

	test("returnDocument=after returns the post-image", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([{ id: new RecordId("users", "a"), name: "New", age: 1 }]);

		const out = (await findOneAndReplace<User>(
			ctx,
			{ name: "Old" },
			{ name: "New", age: 1 } as User,
			{ returnDocument: "after" },
		)) as User;

		expect(out.name).toBe("New");
	});

	test("chooses and replaces its one record in a single CONTENT statement", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([{ id: new RecordId("users", "a"), name: "New" }]);

		await findOneAndReplace<User>(ctx, { name: "Old" }, {
			name: "New",
			age: 1,
		} as User);

		// `CONTENT` is SurrealQL's whole-document write, which is what MongoDB's
		// replace means — and it applies to the record the subquery named, in the
		// same statement, so the document replaced is the document that matched.
		expect(executor.queries.length).toBe(1);
		expect(executor.queries[0].sql).toBe(
			"UPDATE (SELECT VALUE id FROM (SELECT id FROM users WHERE (name = $p0 OR (type::is_array(name) AND name CONTAINS $p0)) LIMIT 1)) CONTENT $p1 RETURN BEFORE",
		);
		// The replacement travels as a bound value, so a field named like SurrealQL
		// syntax cannot become syntax.
		expect(executor.queries[0].bindings?.p1).toEqual({
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
