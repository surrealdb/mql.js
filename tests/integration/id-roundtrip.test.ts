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

	// A string `_id` is the caller's own primary key: every character of it has to
	// come back, and it has to come back a string.
	const awkward: [string, string][] = [
		["colons", "urn:uuid:1234"],
		["a leading colon", ":leading"],
		["a trailing colon", "trailing:"],
		["only a colon", ":"],
		["24 lowercase hex characters", "507f1f77bcf86cd799439011"],
		["24 uppercase hex characters", "507F1F77BCF86CD799439011"],
		["spaces", "with space"],
		["a backtick", "back`tick"],
		["angle brackets", "an⟩gle⟨brackets"],
		["a backslash", "back\\slash"],
		["a quote", "it's mine"],
		["braces", '{ "$oid": "507f1f77bcf86cd799439011" }'],
		["unicode", "ключ-🔑"],
	];

	for (const [name, id] of awkward) {
		test(`a string _id with ${name} round-trips exactly`, async () => {
			const col = freshCollection();
			await col.insertOne({ _id: id, name: "S" });

			const viaFilter = await col.findOne({ _id: id });
			expect(viaFilter?.name).toBe("S");

			const viaRead = (await col.find({}).toArray())[0]?._id;
			expect(typeof viaRead).toBe("string");
			expect(viaRead).toBe(id);

			// And the id a read handed back must address the same document again.
			expect((await col.findOne({ _id: viaRead }))?.name).toBe("S");
			expect((await col.deleteOne({ _id: id })).deletedCount).toBe(1);
		});
	}

	test("a hex-looking string _id stays a string through every operation", async () => {
		const col = freshCollection();
		const hex = "507f1f77bcf86cd799439011";
		await col.insertOne({ _id: hex, name: "S" });

		expect((await col.findOne({ _id: hex }))?._id).toBe(hex);
		expect(
			(await col.findOneAndUpdate({ _id: hex }, { $set: { age: 1 } }))?._id,
		).toBe(hex);
		expect(await col.distinct("_id", {})).toEqual([hex]);

		// The ObjectId of the same hex is a different id, and matches nothing.
		expect(await col.findOne({ _id: new ObjectId(hex) })).toBeNull();
	});

	test("a string _id and an ObjectId of the same hex are different documents", async () => {
		const col = freshCollection();
		const hex = "507f1f77bcf86cd799439011";
		await col.insertOne({ _id: hex, name: "string" });
		await col.insertOne({ _id: new ObjectId(hex), name: "objectid" });

		expect((await col.findOne({ _id: hex }))?.name).toBe("string");
		expect((await col.findOne({ _id: new ObjectId(hex) }))?.name).toBe(
			"objectid",
		);
		expect(await col.countDocuments({})).toBe(2);
	});

	test("a duplicate string _id reports the caller's own value", async () => {
		const col = freshCollection();
		const id = "urn:uuid:1234";
		await col.insertOne({ _id: id, name: "first" });

		const err = (await col
			.insertOne({ _id: id, name: "second" })
			.catch((error: unknown) => error)) as {
			code: number;
			keyValue?: Record<string, unknown>;
		};

		expect(err.code).toBe(11000);
		expect(err.keyValue).toEqual({ _id: id });
	});

	test("a duplicate hex-looking string _id is reported as a string", async () => {
		const col = freshCollection();
		const hex = "507f1f77bcf86cd799439011";
		await col.insertOne({ _id: hex, name: "first" });

		const err = (await col
			.insertOne({ _id: hex, name: "second" })
			.catch((error: unknown) => error)) as {
			keyValue?: Record<string, unknown>;
		};

		expect(err.keyValue?._id).toBe(hex);
		expect(err.keyValue?._id).not.toBeInstanceOf(ObjectId);
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

describe("an _id SurrealDB cannot address", () => {
	/**
	 * A non-integer number is accepted on the wire and then never answered — no
	 * result, no error, no timeout — so it is refused before the statement is sent.
	 * MongoDB would store it, which makes this a divergence, but a hung request is
	 * the one outcome a caller cannot recover from.
	 */
	test("a fractional numeric _id is refused rather than hanging", async () => {
		const col = freshCollection();
		await expect(col.insertOne({ _id: 1.5 })).rejects.toThrow(
			MongoInvalidArgumentError,
		);
		await expect(col.insertOne({ _id: 1.5 })).rejects.toThrow(/whole numbers/);
	});

	test("whole numbers, including negatives, are unaffected", async () => {
		const col = freshCollection();
		await col.insertOne({ _id: 7 });
		await col.insertOne({ _id: -3 });
		expect(await col.countDocuments({})).toBe(2);
		expect((await col.findOne({ _id: -3 }))?._id).toBe(-3);
	});

	test("a fractional value in a filter is refused too, not silently unmatched", async () => {
		const col = freshCollection();
		await col.insertOne({ _id: 2 });
		await expect(col.findOne({ _id: 1.5 })).rejects.toThrow(
			MongoInvalidArgumentError,
		);
	});
});
