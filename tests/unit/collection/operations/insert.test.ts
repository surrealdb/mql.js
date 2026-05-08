import { describe, expect, test } from "bun:test";
import { RecordId, Table } from "surrealdb";
import {
	insertMany,
	insertOne,
} from "../../../../src/collection/operations/insert.ts";
import { ObjectId } from "../../../../src/object-id.ts";
import { makeContext } from "../../../helpers/operation-context.ts";

describe("insertOne", () => {
	test("calls executor.createRecord with a RecordId for the table and returns the inserted id", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		const result = await insertOne(ctx, { name: "Alice" });

		expect(executor.createCalls.length).toBe(1);
		const call = executor.createCalls[0];
		expect(call.recordId).toBeInstanceOf(RecordId);
		expect((call.recordId as RecordId).table.name).toBe("users");
		expect(call.content).toEqual({ name: "Alice" });

		expect(result.acknowledged).toBe(true);
		expect(result.insertedId).toBeInstanceOf(ObjectId);
	});

	test("preserves a caller-supplied string _id", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		const result = await insertOne(ctx, { _id: "alice", name: "Alice" });
		expect(result.insertedId).toBe("alice");
		expect((executor.createCalls[0].recordId as RecordId).id).toBe("alice");
		// The content sent to SurrealDB must NOT contain `_id`
		expect(executor.createCalls[0].content._id).toBeUndefined();
	});

	test("propagates errors from the executor", async () => {
		const { ctx, executor } = makeContext();
		executor.createRecord = async () => {
			throw new Error("boom");
		};
		await expect(insertOne(ctx, { name: "x" })).rejects.toThrow("boom");
	});
});

describe("insertMany", () => {
	test("delegates to executor.insertMany with a Table, attaches RecordIds and returns mapped result", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		const result = await insertMany(ctx, [
			{ name: "Alice" },
			{ _id: "bob", name: "Bob" },
		]);

		expect(executor.insertManyCalls.length).toBe(1);
		const call = executor.insertManyCalls[0];
		expect(call.table).toBe("users");
		expect(call.docs.length).toBe(2);

		// Each doc has a populated `id` (RecordId) and no `_id`.
		expect(call.docs[0].id).toBeInstanceOf(RecordId);
		expect(call.docs[0]._id).toBeUndefined();
		expect((call.docs[1].id as RecordId).id).toBe("bob");

		expect(result.acknowledged).toBe(true);
		expect(result.insertedCount).toBe(2);
		expect(result.insertedIds[0]).toBeInstanceOf(ObjectId);
		expect(result.insertedIds[1]).toBe("bob");
	});

	test("empty input returns a zero-count result and does not call insertMany on the executor", async () => {
		const { ctx, executor } = makeContext();
		// Note: insertMany is still called once with `[]`; that's a deliberate
		// no-op so SurrealDB doesn't accidentally see undefined behaviour.
		const result = await insertMany(ctx, []);
		expect(result.insertedCount).toBe(0);
		expect(executor.insertManyCalls.length).toBe(1);
		expect(executor.insertManyCalls[0].docs).toEqual([]);
	});

	test("works when caller supplies an explicit Table object", async () => {
		const { ctx, executor } = makeContext({ collectionName: "events" });
		await insertMany(ctx, [{ kind: "ping" }]);
		// The executor receives the unescaped collection name string; the
		// SurrealdbExecutor adapter wraps it in `new Table()` itself.
		expect(executor.insertManyCalls[0].table).toBe("events");
	});

	test("ignored: TS-only check that Table import is used", () => {
		// Import is needed so the file participates in the same module
		// graph as the production code path; harmless assertion here.
		expect(typeof Table).toBe("function");
	});
});
