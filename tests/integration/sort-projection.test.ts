/**
 * A sort an inclusion projection does not cover, against a real server.
 *
 * SurrealDB requires every `ORDER BY` idiom to appear in the statement's own field
 * list: `SELECT tag FROM t ORDER BY k` is `Missing order idiom \`k\` in statement
 * selection`, a parse error rather than a slower query. MongoDB requires nothing of
 * the kind, so this is the one place where a projection and a sort cannot be chosen
 * independently, and this driver refuses the read instead of paying — on every
 * projected read — for a statement shape that would satisfy the constraint. The
 * constraint is filed upstream as `surrealdb/surrealdb-private#900`.
 *
 * A refusal is only as good as what a caller can do about it, so this runs against
 * a real server in two halves: every shape that is refused, named field by named
 * field, and then each of the three ways out actually producing the documents
 * MongoDB would have returned. The second half is why the first is a boundary
 * rather than a hole — and it has to be measured against a live SurrealDB, because
 * "the projection now covers the sort" is a claim about what the server accepts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import type { Collection, Db, MongoClient } from "../../src/index.ts";
import { MongoCompatibilityError } from "../../src/index.ts";
import type { Document } from "../../src/types.ts";
import { setupSurreal, teardownSurreal } from "./helpers.ts";

const PORT = 18142;

interface Doc extends Document {
	_id?: unknown;
	tag?: string;
	k?: number;
	extra?: number;
	a?: { b?: number; c?: string };
}

let proc: Subprocess;
let client: MongoClient;
let db: Db;
let sequence = 0;

/**
 * Three documents whose `_id`, `tag` and `k` orders are all different, in a
 * collection of their own: the server keeps data between tests.
 */
async function seeded(): Promise<Collection<Doc>> {
	sequence += 1;
	const coll = db.collection<Doc>(`sortproj_${sequence}`);
	await coll.insertMany([
		{ _id: 1, tag: "t1", k: 3, extra: 1, a: { b: 2, c: "c1" } },
		{ _id: 2, tag: "t2", k: 1, extra: 2, a: { b: 3, c: "c2" } },
		{ _id: 3, tag: "t3", k: 2, extra: 3, a: { b: 1, c: "c3" } },
	]);
	return coll;
}

beforeAll(async () => {
	const ctx = await setupSurreal<Doc>(PORT);
	proc = ctx.process;
	client = ctx.client;
	db = ctx.db;
});

afterAll(async () => {
	await teardownSurreal({ process: proc, client, db } as never);
});

describe("a sort an inclusion projection does not cover", () => {
	test("is refused, in terms that name the column and the ways out", async () => {
		const coll = await seeded();

		const err = (await coll
			.find({}, { projection: { tag: 1 }, sort: { k: 1 } })
			.toArray()
			.catch((e: unknown) => e)) as MongoCompatibilityError;

		expect(err).toBeInstanceOf(MongoCompatibilityError);
		expect(err.message).toContain("Sorting by k");
		expect(err.message).toContain("Include that field in the projection");
		expect(err.message).toContain("use an exclusion projection instead");
		expect(err.message).toContain("sort the results after reading them");
	});

	test("is refused from findOne", async () => {
		const coll = await seeded();

		await expect(
			coll.findOne({}, { projection: { tag: 1 }, sort: { k: 1 } }),
		).rejects.toBeInstanceOf(MongoCompatibilityError);
	});

	test("is refused however the cursor was chained", async () => {
		const coll = await seeded();

		await expect(
			coll.find({}).project({ tag: 1 }).sort({ k: 1 }).toArray(),
		).rejects.toBeInstanceOf(MongoCompatibilityError);
		await expect(
			coll.find({}).sort({ k: 1 }).project({ tag: 1 }).toArray(),
		).rejects.toBeInstanceOf(MongoCompatibilityError);
	});

	test("is refused when the read is paged as well", async () => {
		const coll = await seeded();

		await expect(
			coll
				.find({}, { projection: { tag: 1 }, sort: { k: 1 } })
				.skip(1)
				.limit(1)
				.toArray(),
		).rejects.toBeInstanceOf(MongoCompatibilityError);
	});

	test("is refused when only some of the sort's fields are projected", async () => {
		const coll = await seeded();

		const err = (await coll
			.find({}, { projection: { tag: 1, k: 1 }, sort: { extra: -1, k: 1 } })
			.toArray()
			.catch((e: unknown) => e)) as MongoCompatibilityError;

		// `k` is projected and `extra` is not, so only `extra` is at fault.
		expect(err.message).toContain("Sorting by extra");
		expect(err.message).not.toContain("extra, k");
	});

	test("is refused for a dotted path under a projection of its parent", async () => {
		const coll = await seeded();

		// A projection of `a` selects the sub-document, but the field list names `a`
		// and the ordering names `a.b`, which is not the same idiom.
		await expect(
			coll.find({}, { projection: { a: 1 }, sort: { "a.b": 1 } }).toArray(),
		).rejects.toThrow(/Sorting by a\.b/);
	});

	test("is refused for a dotted path under a projection of its sibling", async () => {
		const coll = await seeded();

		await expect(
			coll.find({}, { projection: { "a.c": 1 }, sort: { "a.b": 1 } }).toArray(),
		).rejects.toThrow(/Sorting by a\.b/);
	});

	test("is refused for a sort on _id the projection suppressed", async () => {
		const coll = await seeded();

		// `_id` lives in SurrealDB's `id` column, which is what the ordering would
		// have named and what `{_id: 0}` took out of the field list.
		await expect(
			coll
				.find({}, { projection: { tag: 1, _id: 0 }, sort: { _id: -1 } })
				.toArray(),
		).rejects.toThrow(/Sorting by _id/);
	});

	test("is refused for a projection of _id alone sorted by anything else", async () => {
		const coll = await seeded();

		await expect(
			coll.find({}, { projection: { _id: 1 }, sort: { k: 1 } }).toArray(),
		).rejects.toThrow(/Sorting by k/);
	});
});

describe("the ways to read those documents instead", () => {
	test("including the sort's field in the projection returns them in order", async () => {
		const coll = await seeded();

		const found = await coll
			.find({}, { projection: { tag: 1, k: 1 }, sort: { k: 1 } })
			.toArray();

		expect(found).toEqual([
			{ _id: 2, tag: "t2", k: 1 },
			{ _id: 3, tag: "t3", k: 2 },
			{ _id: 1, tag: "t1", k: 3 },
		]);
	});

	test("an exclusion projection orders by a field it hides", async () => {
		const coll = await seeded();

		const found = await coll
			.find({}, { projection: { k: 0, extra: 0, a: 0 }, sort: { k: 1 } })
			.toArray();

		// A `SELECT *` carries every idiom an `ORDER BY` could name, and the fields
		// are removed from the documents afterwards — so an exclusion projection can
		// order by anything, including what it excludes.
		expect(found).toEqual([
			{ _id: 2, tag: "t2" },
			{ _id: 3, tag: "t3" },
			{ _id: 1, tag: "t1" },
		]);
	});

	test("reading the documents whole and shaping them reaches the same answer", async () => {
		const coll = await seeded();

		// Nothing is projected, so the ordering is carried by the `*` and the caller
		// decides afterwards which fields to hand on.
		const found = (await coll.find({}, { sort: { k: 1 } }).toArray()).map(
			({ _id, tag }) => ({ _id, tag }),
		);

		expect(found).toEqual([
			{ _id: 2, tag: "t2" },
			{ _id: 3, tag: "t3" },
			{ _id: 1, tag: "t1" },
		]);
	});

	test("a dotted sort works under a projection of the same path", async () => {
		const coll = await seeded();

		const found = await coll
			.find({}, { projection: { "a.b": 1 }, sort: { "a.b": 1 } })
			.toArray();

		expect(found).toEqual([
			{ _id: 3, a: { b: 1 } },
			{ _id: 1, a: { b: 2 } },
			{ _id: 2, a: { b: 3 } },
		]);
	});

	test("a sort on _id needs no projection of its own", async () => {
		const coll = await seeded();

		// An inclusion projection leads its field list with the identity column, so
		// `_id` is covered unless the caller suppressed it.
		const found = await coll
			.find({}, { projection: { tag: 1 }, sort: { _id: -1 } })
			.toArray();

		expect(found).toEqual([
			{ _id: 3, tag: "t3" },
			{ _id: 2, tag: "t2" },
			{ _id: 1, tag: "t1" },
		]);
	});

	test("paging and a hint compose with an ordering the projection covers", async () => {
		const coll = await seeded();
		await coll.createIndex({ k: 1 }, { name: "k_1" });

		const page = await coll
			.find({}, { projection: { tag: 1, k: 1 }, sort: { k: 1 }, hint: "k_1" })
			.skip(1)
			.limit(1)
			.toArray();

		expect(page).toEqual([{ _id: 3, tag: "t3", k: 2 }]);
	});
});
