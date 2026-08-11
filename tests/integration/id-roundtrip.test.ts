/**
 * `_id` round-trips, end to end against a real server.
 *
 * Every one of these assertions used to fail silently. SurrealDB stores
 * identity as a `RecordId` in an `id` column, and while writes and reads
 * translated between that and MongoDB's `_id`, the *query* side did not — so
 * `translateFilter({_id: x})` emitted `_id = $p0` against records with no
 * `_id` column. The comparison could never be true:
 *
 *   findOne({_id})   -> null
 *   updateOne({_id}) -> matchedCount: 0
 *   deleteOne({_id}) -> {acknowledged: true, deletedCount: 0}, nothing deleted
 *
 * None of it raised an error, and reads returned an `_id` that could not be
 * used to fetch the same document again — so every ODM's findById, save() and
 * document delete was broken.
 *
 * It survived because no test in the repository filtered by `_id`. That is the
 * gap this file closes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import type { Collection, Db } from "../../src/index.ts";
import { MongoInvalidArgumentError, ObjectId } from "../../src/index.ts";
import type { Document } from "../../src/types.ts";
import { setupSurreal, teardownSurreal } from "./helpers.ts";

const PORT = 18134;

interface Doc extends Document {
	_id?: ObjectId | string | number;
	name?: string;
	age?: number;
}

let proc: Subprocess;
let client: Parameters<typeof teardownSurreal>[0]["client"];
let db: Db;
let seq = 0;

/** A fresh collection per test, so ids from one cannot mask another. */
function freshCollection(): Collection<Doc> {
	seq += 1;
	return db.collection<Doc>(`ids_${seq}`);
}

beforeAll(async () => {
	const ctx = await setupSurreal<Doc>(PORT, "iddb");
	proc = ctx.process;
	client = ctx.client;
	db = ctx.db;
});

afterAll(async () => {
	await teardownSurreal({ process: proc, client } as never);
});

describe("generated ObjectId _id", () => {
	test("findOne finds the document just inserted", async () => {
		const col = freshCollection();
		const { insertedId } = await col.insertOne({ name: "Alice", age: 30 });

		const found = await col.findOne({ _id: insertedId });
		expect(found).not.toBeNull();
		expect(found?.name).toBe("Alice");
	});

	test("the returned _id is an ObjectId and is stable across reads", async () => {
		const col = freshCollection();
		const { insertedId } = await col.insertOne({ name: "Alice" });
		expect(insertedId).toBeInstanceOf(ObjectId);

		const viaFind = (await col.find({}).toArray())[0];
		expect(String(viaFind?._id)).toBe(String(insertedId));

		// The id handed back must be usable to fetch the same document again.
		const refetched = await col.findOne({ _id: viaFind?._id });
		expect(refetched?.name).toBe("Alice");
	});

	test("updateOne matches and actually modifies", async () => {
		const col = freshCollection();
		const { insertedId } = await col.insertOne({ name: "Alice", age: 30 });

		const result = await col.updateOne(
			{ _id: insertedId },
			{ $set: { age: 31 } },
		);
		expect(result.matchedCount).toBe(1);
		expect(result.modifiedCount).toBe(1);
		expect((await col.findOne({ _id: insertedId }))?.age).toBe(31);
	});

	test("deleteOne reports and performs the deletion", async () => {
		const col = freshCollection();
		const { insertedId } = await col.insertOne({ name: "Alice" });

		const result = await col.deleteOne({ _id: insertedId });
		expect(result.deletedCount).toBe(1);
		expect(await col.countDocuments({})).toBe(0);
	});

	test("an _id that does not exist matches nothing", async () => {
		const col = freshCollection();
		await col.insertOne({ name: "Alice" });

		expect(await col.findOne({ _id: new ObjectId() })).toBeNull();
		expect((await col.deleteOne({ _id: new ObjectId() })).deletedCount).toBe(0);
	});
});

describe("caller-supplied _id types", () => {
	test("a string _id round-trips", async () => {
		const col = freshCollection();
		await col.insertOne({ _id: "user-1", name: "S" });

		expect((await col.findOne({ _id: "user-1" }))?.name).toBe("S");
		expect((await col.find({}).toArray())[0]?._id).toBe("user-1");
	});

	test("a numeric _id round-trips as a number, not a string", async () => {
		const col = freshCollection();
		await col.insertOne({ _id: 42, name: "N" });

		expect((await col.findOne({ _id: 42 }))?.name).toBe("N");
		expect((await col.find({}).toArray())[0]?._id).toBe(42);
		// A numeric id must not be matched by its string spelling.
		expect(await col.findOne({ _id: "42" })).toBeNull();
	});
});

describe("_id query operators", () => {
	test("$in matches every listed id", async () => {
		const col = freshCollection();
		const a = await col.insertOne({ name: "A" });
		await col.insertOne({ _id: 7, name: "B" });
		await col.insertOne({ name: "C" });

		const found = await col.find({ _id: { $in: [a.insertedId, 7] } }).toArray();
		expect(found.map((d) => d.name).sort()).toEqual(["A", "B"]);
	});

	test("$nin and $ne exclude by id", async () => {
		const col = freshCollection();
		await col.insertOne({ _id: 1, name: "A" });
		await col.insertOne({ _id: 2, name: "B" });

		expect((await col.find({ _id: { $ne: 1 } }).toArray()).length).toBe(1);
		expect((await col.find({ _id: { $nin: [1, 2] } }).toArray()).length).toBe(
			0,
		);
	});

	test("an _id condition composes with $or and other fields", async () => {
		const col = freshCollection();
		await col.insertOne({ _id: 1, name: "A" });
		await col.insertOne({ _id: 2, name: "B" });

		expect(
			(await col.find({ $or: [{ _id: 1 }, { name: "B" }] }).toArray()).length,
		).toBe(2);
		expect((await col.find({ _id: 1, name: "A" }).toArray()).length).toBe(1);
		expect((await col.find({ _id: 1, name: "B" }).toArray()).length).toBe(0);
	});
});

describe("find-and-modify by _id", () => {
	test("findOneAndUpdate returns the document and applies the change", async () => {
		const col = freshCollection();
		const { insertedId } = await col.insertOne({ name: "Alice", age: 30 });

		const before = await col.findOneAndUpdate(
			{ _id: insertedId },
			{
				$set: { age: 31 },
			},
		);
		expect(before?.name).toBe("Alice");
		expect((await col.findOne({ _id: insertedId }))?.age).toBe(31);
	});

	test("findOneAndDelete removes the addressed document", async () => {
		const col = freshCollection();
		const { insertedId } = await col.insertOne({ name: "Alice" });

		expect((await col.findOneAndDelete({ _id: insertedId }))?.name).toBe(
			"Alice",
		);
		expect(await col.countDocuments({})).toBe(0);
	});

	test("replaceOne targets the document by _id", async () => {
		const col = freshCollection();
		const { insertedId } = await col.insertOne({ name: "Alice", age: 30 });

		const result = await col.replaceOne({ _id: insertedId }, { name: "Bob" });
		expect(result.matchedCount).toBe(1);

		const after = await col.findOne({ _id: insertedId });
		expect(after?.name).toBe("Bob");
		// Replacement keeps the identity.
		expect(String(after?._id)).toBe(String(insertedId));
	});
});

describe("sorting and distinct on _id", () => {
	test("sort by _id orders by identity rather than a missing column", async () => {
		const col = freshCollection();
		await col.insertOne({ _id: 3, name: "C" });
		await col.insertOne({ _id: 1, name: "A" });
		await col.insertOne({ _id: 2, name: "B" });

		const asc = await col.find({}).sort({ _id: 1 }).toArray();
		expect(asc.map((d) => d.name)).toEqual(["A", "B", "C"]);

		const desc = await col.find({}).sort({ _id: -1 }).toArray();
		expect(desc.map((d) => d.name)).toEqual(["C", "B", "A"]);
	});

	test("distinct('_id') returns the identities", async () => {
		const col = freshCollection();
		await col.insertOne({ _id: 1, name: "A" });
		await col.insertOne({ _id: 2, name: "B" });

		expect((await col.distinct("_id")).length).toBe(2);
	});
});

describe("_id is immutable", () => {
	test("$set on _id is rejected instead of creating a phantom field", async () => {
		const col = freshCollection();
		const { insertedId } = await col.insertOne({ name: "Alice" });

		await expect(
			col.updateOne({ _id: insertedId }, { $set: { _id: 99 } } as never),
		).rejects.toBeInstanceOf(MongoInvalidArgumentError);

		// The identity is untouched and still addressable.
		expect((await col.findOne({ _id: insertedId }))?.name).toBe("Alice");
	});

	test("$unset and $inc on _id are rejected too", async () => {
		const col = freshCollection();
		await col.insertOne({ _id: 1, name: "Alice" });

		await expect(
			col.updateOne({ _id: 1 }, { $unset: { _id: "" } } as never),
		).rejects.toBeInstanceOf(MongoInvalidArgumentError);
		await expect(
			col.updateOne({ _id: 1 }, { $inc: { _id: 1 } } as never),
		).rejects.toBeInstanceOf(MongoInvalidArgumentError);
	});
});
