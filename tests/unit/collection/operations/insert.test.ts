import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
	insertMany,
	insertOne,
} from "../../../../src/collection/operations/insert.ts";
import {
	MongoBulkWriteError,
	MongoErrorCode,
	MongoServerError,
} from "../../../../src/errors.ts";
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
		expect(executor.queries[0].sql).toBe("INSERT INTO `users` $__docs");

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
			"INSERT INTO `events` $__docs TIMEOUT 1000ms",
		);
	});
});

/**
 * A batch is one SurrealDB statement, so a refusal rolls all of it back. MongoDB
 * keeps what it wrote: `ordered: true` stops at the first refusal and keeps
 * everything before it, `ordered: false` keeps every success. Both are reproduced
 * by re-issuing the batch per document *after* the whole-batch attempt has
 * failed, which is what these pin — the happy path must still be one statement.
 */
describe("insertMany – a batch that partly fails", () => {
	/** Refuse the whole-batch attempt, then answer per-document as told. */
	function failingBatch(collectionName = "users") {
		const { ctx, executor } = makeContext({ collectionName });
		let seen = 0;
		executor.onQuery(() => {
			seen += 1;
			if (seen === 1) {
				throw new MongoServerError("E11000 duplicate key error", {
					code: MongoErrorCode.DuplicateKey,
				});
			}
		});
		return { ctx, executor };
	}

	test("a batch that succeeds is still one statement", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		const result = await insertMany(ctx, [{ a: 1 }, { a: 2 }]);

		expect(executor.queries.length).toBe(1);
		expect(executor.queries[0].sql).toBe("INSERT INTO `users` $__docs");
		expect(result.insertedCount).toBe(2);
	});

	test("ordered stops at the first refusal, one statement per document", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		let seen = 0;
		executor.onQuery(() => {
			seen += 1;
			// The whole-batch attempt, then the second document of the replay.
			if (seen === 1 || seen === 3) {
				throw new MongoServerError("E11000 duplicate key error", {
					code: MongoErrorCode.DuplicateKey,
				});
			}
		});

		const failure = insertMany(ctx, [{ a: 1 }, { a: 2 }, { a: 3 }]);
		await expect(failure).rejects.toBeInstanceOf(MongoBulkWriteError);

		const err = (await failure.catch((e) => e)) as MongoBulkWriteError;
		expect(err.code).toBe(11000);
		expect(err.writeErrors.map((w) => w.index)).toEqual([1]);
		expect(err.insertedCount).toBe(1);
		expect(Object.keys(err.insertedIds)).toEqual(["0"]);

		// The batch, then one statement each for documents 0 and 1 — and nothing for
		// document 2, which is the whole point of `ordered`.
		expect(executor.queries.map((q) => q.sql)).toEqual([
			"INSERT INTO `users` $__docs",
			"INSERT INTO `users` $__d",
			"INSERT INTO `users` $__d",
		]);
	});

	test("unordered attempts every document in one dispatch", async () => {
		const { ctx, executor } = failingBatch();
		executor.enqueueOutcomes([
			{ ok: true, value: null, error: undefined },
			{
				ok: false,
				value: undefined,
				error: new MongoServerError("E11000 duplicate key error", {
					code: MongoErrorCode.DuplicateKey,
				}),
			},
			{ ok: true, value: null, error: undefined },
		]);

		const failure = insertMany(ctx, [{ a: 1 }, { a: 2 }, { a: 3 }], {
			ordered: false,
		});
		const err = (await failure.catch((e) => e)) as MongoBulkWriteError;

		expect(err).toBeInstanceOf(MongoBulkWriteError);
		expect(err.writeErrors.map((w) => w.index)).toEqual([1]);
		expect(err.insertedCount).toBe(2);
		expect(Object.keys(err.insertedIds)).toEqual(["0", "2"]);

		// One round trip for the replay, not one per document: this is the shape a
		// caller asks for `ordered: false` to get.
		expect(executor.queries.length).toBe(2);
		expect(executor.queries[1].sql).toBe(
			"INSERT INTO `users` $__d0; INSERT INTO `users` $__d1; INSERT INTO `users` $__d2",
		);
		expect(Object.keys(executor.queries[1].bindings ?? {})).toEqual([
			"__d0",
			"__d1",
			"__d2",
		]);
	});

	test("every document being refused reports every index", async () => {
		const { ctx, executor } = failingBatch();
		const duplicate = () => ({
			ok: false,
			value: undefined,
			error: new MongoServerError("E11000 duplicate key error", {
				code: MongoErrorCode.DuplicateKey,
			}),
		});
		executor.enqueueOutcomes([duplicate(), duplicate()]);

		const err = (await insertMany(ctx, [{ a: 1 }, { a: 2 }], {
			ordered: false,
		}).catch((e) => e)) as MongoBulkWriteError;

		expect(err.writeErrors.map((w) => w.index)).toEqual([0, 1]);
		expect(err.insertedCount).toBe(0);
		expect(err.insertedIds).toEqual({});
	});

	test("a replay in which nothing fails returns normally", async () => {
		// The whole-batch attempt can fail for a reason a per-document replay does
		// not reproduce — a timeout on the larger statement, say — and then every
		// document really was inserted.
		const { ctx } = failingBatch();
		const result = await insertMany(ctx, [{ a: 1 }, { a: 2 }], {
			ordered: false,
		});
		expect(result.insertedCount).toBe(2);
	});

	test("inside a caller's transaction the batch stays all-or-nothing", async () => {
		// MongoDB's own `insertMany` in a transaction keeps nothing when it fails:
		// the failure aborts the transaction. One statement already is that.
		const { ctx, executor } = makeContext({
			collectionName: "users",
			inTransaction: true,
		});
		executor.onQuery(() => {
			throw new MongoServerError("E11000 duplicate key error", {
				code: MongoErrorCode.DuplicateKey,
			});
		});

		const err = (await insertMany(ctx, [{ a: 1 }, { a: 2 }]).catch(
			(e) => e,
		)) as Error;
		expect(err).toBeInstanceOf(MongoServerError);
		expect(err).not.toBeInstanceOf(MongoBulkWriteError);
		expect(executor.queries.length).toBe(1);
	});

	test("a single-document batch has no partial outcome to report", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		executor.onQuery(() => {
			throw new MongoServerError("E11000 duplicate key error", {
				code: MongoErrorCode.DuplicateKey,
			});
		});

		const err = (await insertMany(ctx, [{ a: 1 }]).catch((e) => e)) as Error;
		expect(err).toBeInstanceOf(MongoServerError);
		expect(err).not.toBeInstanceOf(MongoBulkWriteError);
		expect(executor.queries.length).toBe(1);
	});

	test("the per-document statements carry the caller's TIMEOUT", async () => {
		const { ctx, executor } = failingBatch("events");
		executor.enqueueAllOk(2);
		await insertMany(ctx, [{ a: 1 }, { a: 2 }], {
			ordered: false,
			maxTimeMS: 500,
		});
		expect(executor.queries[1].sql).toBe(
			"INSERT INTO `events` $__d0 TIMEOUT 500ms; INSERT INTO `events` $__d1 TIMEOUT 500ms",
		);
	});
});
