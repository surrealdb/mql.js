/**
 * BSON values through a real server, in every place one can appear.
 *
 * A value that survives the write but comes back as something else is worse than
 * a rejected write: the document still reads, the equality filters still match —
 * because the filter is encoded the same wrong way — and the loss only shows up
 * when somebody calls a method on the value. So each case here writes a value,
 * reads it back, and asserts on the *type* it returns with, not only on what it
 * compares equal to.
 *
 * Every path is covered separately, because they reach the wire differently: a
 * document, a nested field, an array element, an array of sub-documents, an
 * `_id`, a `$set` and `$push` operand, a filter, and what `findOneAndUpdate`
 * hands back.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import {
	Binary,
	Code,
	DBRef,
	Decimal128,
	Long,
	MaxKey,
	MinKey,
	ObjectId as RealObjectId,
	Timestamp,
	UUID,
} from "mongodb";
import type { Collection, Db } from "../../src/index.ts";
import { MongoCompatibilityError, ObjectId } from "../../src/index.ts";
import type { Document } from "../../src/types.ts";
import { setupSurreal, teardownSurreal } from "./helpers.ts";

const PORT = 18138;

interface Doc extends Document {
	_id?: ObjectId | string | number;
	name?: string;
	authorId?: ObjectId;
	editors?: ObjectId[];
	reviews?: { by: ObjectId; score: number }[];
	meta?: { owner?: ObjectId; at?: Date };
	when?: Date;
	dates?: Date[];
}

let proc: Subprocess;
let client: Parameters<typeof teardownSurreal>[0]["client"];
let db: Db;
let seq = 0;

/** A fresh collection per test, so ids from one cannot mask another. */
function freshCollection(): Collection<Doc> {
	seq += 1;
	return db.collection<Doc>(`bson_${seq}`);
}

beforeAll(async () => {
	const ctx = await setupSurreal<Doc>(PORT, "bsondb");
	proc = ctx.process;
	client = ctx.client;
	db = ctx.db;
});

afterAll(async () => {
	await teardownSurreal({ process: proc, client } as never);
});

describe("a nested ObjectId", () => {
	test("comes back as an ObjectId, not as a plain object", async () => {
		const col = freshCollection();
		const authorId = new ObjectId();
		await col.insertOne({ name: "post", authorId });

		const found = await col.findOne({ name: "post" });
		expect(found?.authorId).toBeInstanceOf(ObjectId);
		expect(found?.authorId?.toHexString()).toBe(authorId.toHexString());
		expect(found?.authorId?.equals(authorId)).toBe(true);
	});

	test("survives inside an array", async () => {
		const col = freshCollection();
		const editors = [new ObjectId(), new ObjectId()];
		await col.insertOne({ name: "post", editors });

		const found = await col.findOne({ name: "post" });
		expect(found?.editors).toHaveLength(2);
		for (const [index, editor] of (found?.editors ?? []).entries()) {
			expect(editor).toBeInstanceOf(ObjectId);
			expect(editor.equals(editors[index])).toBe(true);
		}
	});

	test("survives inside an array of sub-documents", async () => {
		const col = freshCollection();
		const by = new ObjectId();
		await col.insertOne({ name: "post", reviews: [{ by, score: 5 }] });

		const found = await col.findOne({ name: "post" });
		expect(found?.reviews?.[0].by).toBeInstanceOf(ObjectId);
		expect(found?.reviews?.[0].by.equals(by)).toBe(true);
		expect(found?.reviews?.[0].score).toBe(5);
	});

	test("survives inside a sub-document", async () => {
		const col = freshCollection();
		const owner = new ObjectId();
		await col.insertOne({ name: "post", meta: { owner } });

		const found = await col.findOne({ name: "post" });
		expect(found?.meta?.owner).toBeInstanceOf(ObjectId);
		expect(found?.meta?.owner?.equals(owner)).toBe(true);
	});

	test("is matched by an equality filter, by $in and by $ne", async () => {
		const col = freshCollection();
		const mine = new ObjectId();
		const theirs = new ObjectId();
		await col.insertOne({ name: "mine", authorId: mine });
		await col.insertOne({ name: "theirs", authorId: theirs });

		expect((await col.findOne({ authorId: mine }))?.name).toBe("mine");
		expect(
			(await col.find({ authorId: { $in: [mine, theirs] } }).toArray()).length,
		).toBe(2);
		expect((await col.find({ authorId: { $ne: mine } }).toArray()).length).toBe(
			1,
		);
	});

	test("is matched inside an array by an equality filter", async () => {
		const col = freshCollection();
		const editor = new ObjectId();
		await col.insertOne({ name: "post", editors: [editor, new ObjectId()] });

		expect((await col.findOne({ editors: editor }))?.name).toBe("post");
	});

	test("is matched through a dotted path into a sub-document", async () => {
		const col = freshCollection();
		const owner = new ObjectId();
		await col.insertOne({ name: "post", meta: { owner } });

		expect((await col.findOne({ "meta.owner": owner }))?.name).toBe("post");
	});

	test("written by $set reads back as an ObjectId", async () => {
		const col = freshCollection();
		const { insertedId } = await col.insertOne({ name: "post" });
		const authorId = new ObjectId();

		await col.updateOne({ _id: insertedId }, { $set: { authorId } });

		const found = await col.findOne({ _id: insertedId });
		expect(found?.authorId).toBeInstanceOf(ObjectId);
		expect(found?.authorId?.equals(authorId)).toBe(true);
	});

	test("written by $push reads back as an ObjectId", async () => {
		const col = freshCollection();
		const { insertedId } = await col.insertOne({ name: "post", editors: [] });
		const editor = new ObjectId();

		await col.updateOne({ _id: insertedId }, { $push: { editors: editor } });

		const found = await col.findOne({ _id: insertedId });
		expect(found?.editors?.[0]).toBeInstanceOf(ObjectId);
		expect(found?.editors?.[0].equals(editor)).toBe(true);
	});

	test("is an ObjectId in what findOneAndUpdate returns", async () => {
		const col = freshCollection();
		const authorId = new ObjectId();
		const { insertedId } = await col.insertOne({ name: "post", authorId });

		const before = await col.findOneAndUpdate(
			{ _id: insertedId },
			{ $set: { name: "renamed" } },
		);
		expect(before?.authorId).toBeInstanceOf(ObjectId);

		const after = await col.findOneAndUpdate(
			{ _id: insertedId },
			{ $set: { name: "again" } },
			{ returnDocument: "after" },
		);
		expect(after?.authorId).toBeInstanceOf(ObjectId);
		expect(after?.authorId?.equals(authorId)).toBe(true);
	});

	test("survives a replacement and an upsert", async () => {
		const col = freshCollection();
		const authorId = new ObjectId();
		const { insertedId } = await col.insertOne({ name: "post" });

		await col.replaceOne({ _id: insertedId }, { name: "replaced", authorId });
		expect((await col.findOne({ _id: insertedId }))?.authorId).toBeInstanceOf(
			ObjectId,
		);

		const upserted = new ObjectId();
		await col.updateOne(
			{ name: "new" },
			{ $set: { authorId: upserted } },
			{ upsert: true },
		);
		expect((await col.findOne({ name: "new" }))?.authorId).toBeInstanceOf(
			ObjectId,
		);
	});

	// `insertMany` takes a different route to the wire — one `INSERT` carrying every
	// document, ids included — so it is covered separately.
	test("survives insertMany, ids and nested values alike", async () => {
		const col = freshCollection();
		const first = new ObjectId();
		const authorId = new ObjectId();

		const { insertedIds } = await col.insertMany([
			{ _id: first, name: "a", authorId },
			{ name: "b", editors: [authorId] },
		]);

		expect(insertedIds[0]).toBe(first);
		expect((await col.findOne({ _id: first }))?.authorId).toBeInstanceOf(
			ObjectId,
		);
		expect((await col.findOne({ name: "b" }))?.editors?.[0]).toBeInstanceOf(
			ObjectId,
		);
	});

	test("comes back as an ObjectId from distinct", async () => {
		const col = freshCollection();
		const authorId = new ObjectId();
		await col.insertOne({ name: "a", authorId });
		await col.insertOne({ name: "b", authorId });

		const authors = await col.distinct("authorId", {});
		expect(authors).toHaveLength(1);
		expect(authors[0]).toBeInstanceOf(ObjectId);

		const ids = await col.distinct("_id", {});
		expect(ids).toHaveLength(2);
		for (const id of ids) expect(id).toBeInstanceOf(ObjectId);
	});
});

describe("an ObjectId _id", () => {
	test("is returned as an ObjectId and addresses its own document", async () => {
		const col = freshCollection();
		const _id = new ObjectId();
		await col.insertOne({ _id, name: "pinned" });

		const found = await col.findOne({ _id });
		expect(found?._id).toBeInstanceOf(ObjectId);
		expect((found?._id as ObjectId).equals(_id)).toBe(true);
	});

	test("sorts chronologically, as the timestamp bytes promise", async () => {
		const col = freshCollection();
		const early = ObjectId.createFromTime(1_000_000_000);
		const late = ObjectId.createFromTime(2_000_000_000);
		await col.insertOne({ _id: late, name: "late" });
		await col.insertOne({ _id: early, name: "early" });

		const ascending = await col.find({}).sort({ _id: 1 }).toArray();
		expect(ascending.map((doc) => doc.name)).toEqual(["early", "late"]);
	});

	// Pagination by id relies on this: `_id > lastSeen` has to mean "written later".
	test("supports range comparison, so id pagination works", async () => {
		const col = freshCollection();
		const early = ObjectId.createFromTime(1_000_000_000);
		const late = ObjectId.createFromTime(2_000_000_000);
		await col.insertOne({ _id: early, name: "early" });
		await col.insertOne({ _id: late, name: "late" });

		const after = await col.find({ _id: { $gt: early } }).toArray();
		expect(after.map((doc) => doc.name)).toEqual(["late"]);
	});

	test("is reported as an ObjectId when it collides", async () => {
		const col = freshCollection();
		const _id = new ObjectId();
		await col.insertOne({ _id, name: "first" });

		const err = (await col
			.insertOne({ _id, name: "second" })
			.catch((error: unknown) => error)) as {
			code: number;
			keyValue?: Record<string, unknown>;
		};

		expect(err.code).toBe(11000);
		expect(err.keyValue?._id).toBe(_id);
	});
});

describe("an ObjectId from another BSON implementation", () => {
	// mongoose hands over `bson`'s class, and a document written with one has to be
	// readable — and queryable — as an id from here.
	test("is stored as an id and read back as this driver's ObjectId", async () => {
		const col = freshCollection();
		const foreign = new RealObjectId();
		await col.insertOne({ name: "post", authorId: foreign as never });

		const found = await col.findOne({ name: "post" });
		expect(found?.authorId).toBeInstanceOf(ObjectId);
		expect(found?.authorId?.toHexString()).toBe(foreign.toHexString());
	});

	test("matches a filter written with either implementation's id", async () => {
		const col = freshCollection();
		const foreign = new RealObjectId();
		await col.insertOne({ name: "post", authorId: foreign as never });

		expect((await col.findOne({ authorId: foreign as never }))?.name).toBe(
			"post",
		);
		expect(
			(await col.findOne({ authorId: new ObjectId(foreign.toHexString()) }))
				?.name,
		).toBe("post");
	});

	test("addresses a record when used as an _id", async () => {
		const col = freshCollection();
		const foreign = new RealObjectId();
		await col.insertOne({ _id: foreign as never, name: "pinned" });

		const found = await col.findOne({ _id: foreign as never });
		expect(found?.name).toBe("pinned");
		expect(found?._id).toBeInstanceOf(ObjectId);
	});
});

describe("a Date", () => {
	// Without native dates the SDK decodes a datetime to its own `DateTime`, on
	// which `instanceof Date` is false and `getTime()` does not exist.
	test("comes back as a Date, with its milliseconds", async () => {
		const col = freshCollection();
		const when = new Date("2024-03-04T05:06:07.890Z");
		await col.insertOne({ name: "post", when });

		const found = await col.findOne({ name: "post" });
		expect(found?.when).toBeInstanceOf(Date);
		expect(found?.when?.getTime()).toBe(when.getTime());
	});

	test("survives inside arrays and sub-documents", async () => {
		const col = freshCollection();
		const when = new Date("2020-01-02T03:04:05.678Z");
		await col.insertOne({ name: "post", dates: [when], meta: { at: when } });

		const found = await col.findOne({ name: "post" });
		expect(found?.dates?.[0]).toBeInstanceOf(Date);
		expect(found?.dates?.[0].getTime()).toBe(when.getTime());
		expect(found?.meta?.at).toBeInstanceOf(Date);
		expect(found?.meta?.at?.getTime()).toBe(when.getTime());
	});

	test("is matched by equality and by a range filter", async () => {
		const col = freshCollection();
		const when = new Date("2024-03-04T05:06:07.890Z");
		await col.insertOne({ name: "post", when });

		expect((await col.findOne({ when }))?.name).toBe("post");
		expect(
			(await col.findOne({ when: { $gt: new Date("2024-01-01T00:00:00Z") } }))
				?.name,
		).toBe("post");
		expect(
			await col.findOne({ when: { $lt: new Date("2024-01-01T00:00:00Z") } }),
		).toBeNull();
	});

	test("written by $set and $push reads back as a Date", async () => {
		const col = freshCollection();
		const { insertedId } = await col.insertOne({ name: "post", dates: [] });
		const when = new Date("2022-06-07T08:09:10.111Z");

		await col.updateOne(
			{ _id: insertedId },
			{ $set: { when }, $push: { dates: when } },
		);

		const found = await col.findOne({ _id: insertedId });
		expect(found?.when).toBeInstanceOf(Date);
		expect(found?.dates?.[0]).toBeInstanceOf(Date);
		expect(found?.dates?.[0].getTime()).toBe(when.getTime());
	});

	test("is a Date in what findOneAndUpdate returns", async () => {
		const col = freshCollection();
		const when = new Date("2021-05-06T07:08:09.010Z");
		const { insertedId } = await col.insertOne({ name: "post", when });

		const after = await col.findOneAndUpdate(
			{ _id: insertedId },
			{ $set: { name: "renamed" } },
			{ returnDocument: "after" },
		);
		expect(after?.when).toBeInstanceOf(Date);
		expect(after?.when?.getTime()).toBe(when.getTime());
	});

	test("comes back as a Date from distinct", async () => {
		const col = freshCollection();
		const when = new Date("2019-09-08T07:06:05.040Z");
		await col.insertOne({ name: "a", when });

		const values = await col.distinct("when", {});
		expect(values[0]).toBeInstanceOf(Date);
		expect((values[0] as Date).getTime()).toBe(when.getTime());
	});

	test("sorts and orders as a datetime, not as text", async () => {
		const col = freshCollection();
		await col.insertOne({
			name: "later",
			when: new Date("2024-02-01T00:00:00Z"),
		});
		await col.insertOne({
			name: "earlier",
			when: new Date("2023-11-01T00:00:00Z"),
		});

		const ascending = await col.find({}).sort({ when: 1 }).toArray();
		expect(ascending.map((doc) => doc.name)).toEqual(["earlier", "later"]);
	});
});

describe("a Date before 1970", () => {
	// An instant before the epoch with a fractional second — `new Date(-1)` is
	// the smallest — used to be encoded with a negative nanosecond count, which
	// SurrealDB cannot decode and does not answer: the insert never returned. The
	// whole-second cases are here to show the boundary was never the epoch.
	const instants = [
		"1970-01-01T00:00:00.000Z",
		"1969-12-31T23:59:59.999Z",
		"1969-12-31T23:59:59.000Z",
		"1960-06-15T12:30:45.123Z",
		"1900-01-01T00:00:00.001Z",
		"0001-01-01T00:00:00.000Z",
	];

	/** A hang is the failure under test, so it must fail rather than stall the run. */
	const within = <T>(work: Promise<T>) =>
		Promise.race([
			work,
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error("the operation never returned")),
					5000,
				),
			),
		]);

	test("is stored and read back as the same instant", async () => {
		const col = freshCollection();
		for (const iso of instants) {
			const when = new Date(iso);
			const { insertedId } = await within(col.insertOne({ when } as never));
			const back = await within(col.findOne({ _id: insertedId } as never));
			expect((back as { when: Date }).when.getTime()).toBe(when.getTime());
		}
	});

	test("can be matched, compared and sorted, inside arrays and documents too", async () => {
		const col = freshCollection();
		await col.insertMany([
			{ name: "modern", when: new Date("2024-03-15T10:00:00.500Z") },
			{ name: "epoch-1ms", when: new Date(-1) },
			{ name: "old", when: new Date("1960-06-15T12:30:45.123Z") },
			{
				name: "nested",
				when: new Date("2030-01-01T00:00:00.000Z"),
				meta: { at: new Date(-1500) },
				dates: [new Date(-2)],
			},
		] as never);

		expect(
			(await within(col.find({ when: new Date(-1) } as never).toArray())).map(
				(d) => d.name,
			),
		).toEqual(["epoch-1ms"]);
		expect(
			(
				await within(
					col.find({ when: { $lt: new Date(0) } } as never).toArray(),
				)
			)
				.map((d) => d.name)
				.sort(),
		).toEqual(["epoch-1ms", "old"]);
		expect(
			(
				await within(
					col
						.find({ when: { $exists: true } } as never)
						.sort({ when: 1 } as never)
						.toArray(),
				)
			).map((d) => d.name),
		).toEqual(["old", "epoch-1ms", "modern", "nested"]);

		const nested = (await within(col.findOne({ name: "nested" } as never))) as {
			meta: { at: Date };
			dates: Date[];
		};
		expect(nested.meta.at.getTime()).toBe(-1500);
		expect(nested.dates[0].getTime()).toBe(-2);
	});

	test("an update can set one, and $in can name several", async () => {
		const col = freshCollection();
		await col.insertOne({ name: "a" } as never);
		await within(
			col.updateOne({ name: "a" }, { $set: { when: new Date(-7) } }),
		);
		expect(
			(
				await within(
					col
						.find({ when: { $in: [new Date(-7), new Date(-8)] } } as never)
						.toArray(),
				)
			).length,
		).toBe(1);
	});
});

describe("a Date beyond the range SurrealDB can store", () => {
	test("is refused by name, rather than hanging the request", async () => {
		const err = await new Promise<unknown>((resolve) => {
			setTimeout(
				() => resolve(new Error("the operation never returned")),
				5000,
			);
			freshCollection()
				.insertOne({ when: new Date(8.64e15) } as never)
				.then(
					() => resolve(undefined),
					(error: unknown) => resolve(error),
				);
		});
		expect(err).toBeInstanceOf(MongoCompatibilityError);
		expect((err as Error).message).toContain("years -262143 to 262142");
	});

	test("the instants at each end of the range are stored", async () => {
		const col = freshCollection();
		const min = new Date(Date.UTC(-262143, 0, 1));
		const max = new Date(Date.UTC(262143, 0, 1) - 1);
		await col.insertMany([{ when: min }, { when: max }] as never);
		const back = await col
			.find({})
			.sort({ when: 1 } as never)
			.toArray();
		expect(back.map((d) => (d as { when: Date }).when.getTime())).toEqual([
			min.getTime(),
			max.getTime(),
		]);
	});
});

describe("BSON types with no SurrealDB representation", () => {
	// Each of these is an object as far as the wire is concerned, so it *would*
	// encode — as its own internals — and read back as a plain object that is no
	// longer the type it was. The write is refused instead.
	// A `UUID` is a `Binary` subtype in BSON and reports itself as one, which is
	// the name the error can honestly give.
	const unsupported: [string, unknown, string][] = [
		["Decimal128", Decimal128.fromString("1.25"), "Decimal128"],
		["Long", Long.fromNumber(2 ** 40), "Long"],
		["Binary", new Binary(new Uint8Array([1, 2, 3])), "Binary"],
		["UUID", new UUID(), "Binary"],
		["Timestamp", new Timestamp({ t: 1, i: 1 }), "Timestamp"],
		["Code", new Code("() => 1"), "Code"],
		["MinKey", new MinKey(), "MinKey"],
		["MaxKey", new MaxKey(), "MaxKey"],
		["DBRef", new DBRef("users", new RealObjectId()), "DBRef"],
	];

	for (const [name, value, reported] of unsupported) {
		test(`${name} is refused rather than silently mangled`, async () => {
			const col = freshCollection();
			await col.insertOne({ name: "existing" });

			const err = (await col
				.insertOne({ name: "post", value } as never)
				.catch((error: unknown) => error)) as Error;

			expect(err).toBeInstanceOf(MongoCompatibilityError);
			expect(err.message).toContain(reported);
			// Nothing was written: the refusal happens on the way to the wire.
			expect(await col.countDocuments({})).toBe(1);
		});
	}

	test("the refusal covers filters and update operands too", async () => {
		const col = freshCollection();
		await col.insertOne({ name: "post" });

		await expect(
			col.findOne({ amount: Decimal128.fromString("1.25") } as never),
		).rejects.toBeInstanceOf(MongoCompatibilityError);
		await expect(
			col.updateOne({ name: "post" }, {
				$set: { amount: Decimal128.fromString("1.25") },
			} as never),
		).rejects.toBeInstanceOf(MongoCompatibilityError);
	});
});

describe("documents that only look like stored ids", () => {
	// The stored form is narrow on purpose: one field, named `$oid`, holding 24
	// lowercase hex characters. Anything else is a caller's own document.
	test("an object with a $oid field alongside others is left as a document", async () => {
		const col = freshCollection();
		const payload = { $oid: "507f1f77bcf86cd799439011", note: "mine" };
		await col.insertOne({ name: "post", payload });

		const found = await col.findOne({ name: "post" });
		expect(found?.payload).toEqual(payload);
	});

	test("an object whose $oid is not a hex id is left as a document", async () => {
		const col = freshCollection();
		await col.insertOne({ name: "post", payload: { $oid: "not-an-id" } });

		const found = await col.findOne({ name: "post" });
		expect(found?.payload).toEqual({ $oid: "not-an-id" });
	});

	/**
	 * A whole document of exactly the stored shape is the sharpest version of the
	 * question, because a document is handed back by spreading its fields: read as
	 * an id it would contribute none, so the field would not merely change type —
	 * it would be missing from the document the caller gets back.
	 */
	test("a document whose only field is $oid keeps that field", async () => {
		const col = freshCollection();
		const hex = "507f1f77bcf86cd799439011";
		const { insertedId } = await col.insertOne({ $oid: hex } as never);

		const found = await col.findOne({ _id: insertedId });
		expect(found?.$oid).toBe(hex);
		expect(Object.keys(found ?? {})).toEqual(["_id", "$oid"]);
	});

	// The refusal of an unsupported BSON value keys off a value's class, so an
	// ordinary document that happens to have a field of that name is still data.
	test("a document with a _bsontype field of its own is stored as written", async () => {
		const col = freshCollection();
		const payload = { _bsontype: "draft", text: "hi" };
		await col.insertOne({ name: "post", payload } as never);

		const found = await col.findOne({ name: "post" });
		expect(found?.payload).toEqual(payload);
	});
});
