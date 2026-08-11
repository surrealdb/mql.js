import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
	insertMany,
	insertOne,
} from "../../../../src/collection/operations/insert.ts";
import { ObjectId } from "../../../../src/object-id.ts";
import { makeContext } from "../../../helpers/operation-context.ts";

describe("insertOne", () => {
	test("emits CREATE with the record id and content bound, and returns the inserted id", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		const result = await insertOne(ctx, { name: "Alice" });

		expect(executor.queries.length).toBe(1);
		expect(executor.queries[0].sql).toBe("CREATE $__rid CONTENT $__doc");

		const bindings = executor.queries[0].bindings as Record<string, unknown>;
		expect(bindings.__rid).toBeInstanceOf(RecordId);
		expect((bindings.__rid as RecordId).table.name).toBe("users");
		expect(bindings.__doc).toEqual({ name: "Alice" });

		expect(result.acknowledged).toBe(true);
		expect(result.insertedId).toBeInstanceOf(ObjectId);
	});

	test("preserves a caller-supplied string _id", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		const result = await insertOne(ctx, { _id: "alice", name: "Alice" });
		const bindings = executor.queries[0].bindings as Record<string, unknown>;

		expect(result.insertedId).toBe("alice");
		expect((bindings.__rid as RecordId).id).toBe("alice");
		// The content sent to SurrealDB must NOT contain `_id`
		expect((bindings.__doc as Record<string, unknown>)._id).toBeUndefined();
	});

	test("appends TIMEOUT for maxTimeMS", async () => {
		const { ctx, executor } = makeContext();
		await insertOne(ctx, { name: "Alice" }, { maxTimeMS: 250 });
		expect(executor.queries[0].sql).toBe(
			"CREATE $__rid CONTENT $__doc TIMEOUT 250ms",
		);
	});

	test("stores undefined as null unless ignoreUndefined is set", async () => {
		const { ctx, executor } = makeContext();
		await insertOne(ctx, { name: "Alice", nickname: undefined });
		expect(executor.queries[0].bindings?.__doc).toEqual({
			name: "Alice",
			nickname: null,
		});

		await insertOne(
			ctx,
			{ name: "Bob", nickname: undefined },
			{
				ignoreUndefined: true,
			},
		);
		expect(executor.queries[1].bindings?.__doc).toEqual({ name: "Bob" });
	});

	test("propagates errors from the executor", async () => {
		const { ctx, executor } = makeContext();
		executor.query = async () => {
			throw new Error("boom");
		};
		await expect(insertOne(ctx, { name: "x" })).rejects.toThrow("boom");
	});
});

describe("insertMany", () => {
	test("emits INSERT INTO with the documents bound, ids attached and result mapped", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		const result = await insertMany(ctx, [
			{ name: "Alice" },
			{ _id: "bob", name: "Bob" },
		]);

		expect(executor.queries.length).toBe(1);
		expect(executor.queries[0].sql).toBe("INSERT INTO users $__docs");

		const docs = executor.queries[0].bindings?.__docs as Record<
			string,
			unknown
		>[];
		expect(docs.length).toBe(2);

		// Each doc has a populated `id` (RecordId) and no `_id`.
		expect(docs[0].id).toBeInstanceOf(RecordId);
		expect(docs[0]._id).toBeUndefined();
		expect((docs[1].id as RecordId).id).toBe("bob");

		expect(result.acknowledged).toBe(true);
		expect(result.insertedCount).toBe(2);
		expect(result.insertedIds[0]).toBeInstanceOf(ObjectId);
		expect(result.insertedIds[1]).toBe("bob");
	});

	test("empty input inserts an empty batch and returns a zero-count result", async () => {
		const { ctx, executor } = makeContext();
		// The statement still runs with `[]`; that's a deliberate no-op so
		// SurrealDB doesn't accidentally see undefined behaviour.
		const result = await insertMany(ctx, []);
		expect(result.insertedCount).toBe(0);
		expect(executor.queries[0].bindings?.__docs).toEqual([]);
	});

	test("escapes the collection name in the statement", async () => {
		const { ctx, executor } = makeContext({ collectionName: "user events" });
		await insertMany(ctx, [{ kind: "ping" }]);
		expect(executor.queries[0].sql).toBe("INSERT INTO `user events` $__docs");
	});

	test("appends TIMEOUT for maxTimeMS", async () => {
		const { ctx, executor } = makeContext({ collectionName: "events" });
		await insertMany(ctx, [{ kind: "ping" }], { maxTimeMS: 1000 });
		expect(executor.queries[0].sql).toBe(
			"INSERT INTO events $__docs TIMEOUT 1000ms",
		);
	});
});
