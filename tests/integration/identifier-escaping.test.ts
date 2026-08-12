/**
 * Identifier escaping, end to end against a real server.
 *
 * Two failure modes are covered, both previously live:
 *
 *  1. Legal MongoDB field names broke. A name containing a space produced a
 *     SurrealQL parse error, and a name containing a hyphen was silently
 *     reinterpreted as subtraction — so the query returned the wrong documents
 *     with no error at all.
 *
 *  2. A filter key was evaluated as an expression. Applications routinely build
 *     filters from request input, so `{'1=1 OR normal': 1}` matching every row
 *     was an injection vector rather than a curiosity.
 *
 * These run against a live server because the point is what SurrealDB does with
 * the emitted SQL, which a string assertion cannot establish.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import type { Collection, Db } from "../../src/index.ts";
import { MongoCompatibilityError } from "../../src/index.ts";
import type { Document } from "../../src/types.ts";
import { setupSurreal, teardownSurreal } from "./helpers.ts";

const PORT = 18133;

interface Doc extends Document {
	normal?: number;
	profile?: { email?: string };
	items?: { sku: string }[];
}

let proc: Subprocess;
let client: Parameters<typeof teardownSurreal>[0]["client"];
let db: Db;
let col: Collection<Doc>;

beforeAll(async () => {
	const ctx = await setupSurreal<Doc>(PORT, "escdb");
	proc = ctx.process;
	client = ctx.client;
	db = ctx.db;
	col = db.collection<Doc>("docs");
	await col.insertOne({
		normal: 1,
		profile: { email: "z@y.x" },
		items: [{ sku: "S1" }, { sku: "S2" }],
		"first name": "fn",
		"a-b": 7,
		select: 5,
	} as Doc);
});

afterAll(async () => {
	await teardownSurreal({ process: proc, client } as never);
});

describe("legal MongoDB field names that previously failed", () => {
	test("a field name containing a space is queryable", async () => {
		// Previously: SurrealQL parse error.
		expect(await col.countDocuments({ "first name": "fn" } as never)).toBe(1);
	});

	test("a field name containing a hyphen matches instead of subtracting", async () => {
		// Previously: "Cannot perform subtraction with 'none' and 'none'".
		expect(await col.countDocuments({ "a-b": 7 } as never)).toBe(1);
	});

	test("a field name colliding with a SurrealQL keyword is queryable", async () => {
		expect(await col.countDocuments({ select: 5 } as never)).toBe(1);
	});

	test("dotted paths still resolve as nested access, not as one flat name", async () => {
		expect(
			await col.countDocuments({ "profile.email": "z@y.x" } as never),
		).toBe(1);
	});

	test("a numeric path segment addresses an array element", async () => {
		// MongoDB spells this `items.0.sku`; SurrealQL needs `items[0].sku`, and
		// passing the Mongo form through unchanged was a parse error.
		expect(await col.countDocuments({ "items.0.sku": "S1" } as never)).toBe(1);
		expect(await col.countDocuments({ "items.1.sku": "S1" } as never)).toBe(0);
	});

	test("sort, projection, distinct and createIndex accept such names", async () => {
		expect(
			(await col.find({}).sort({ "first name": 1 }).toArray()).length,
		).toBe(1);

		const projected = await col.find({}).project({ "first name": 1 }).toArray();
		expect(Object.keys(projected[0] ?? {})).toContain("first name");

		expect(await col.distinct("first name")).toEqual(["fn"]);
		expect(await col.createIndex({ "first name": 1 })).toBe("first name_1");
	});

	test("an update can target such a name", async () => {
		const result = await col.updateOne({ normal: 1 }, {
			$set: { "first name": "changed" },
		} as never);
		expect(result.modifiedCount).toBe(1);
		expect(await col.countDocuments({ "first name": "changed" } as never)).toBe(
			1,
		);
		await col.updateOne({ normal: 1 }, {
			$set: { "first name": "fn" },
		} as never);
	});
});

describe("a hostile filter key cannot escape its identifier position", () => {
	/** Each of these matched every row before escaping. */
	const injections = [
		"1=1 OR normal",
		"x` = 1 OR true OR `",
		"a` OR true --",
		") OR (1=1",
	];

	for (const key of injections) {
		test(`{'${key}': 1} matches nothing`, async () => {
			expect(await col.countDocuments({ [key]: 1 } as never)).toBe(0);
		});
	}

	test("a destructive payload does not run and the collection survives", async () => {
		const before = await col.countDocuments({});
		expect(
			await col.countDocuments({ "n`; REMOVE TABLE docs; --": 1 } as never),
		).toBe(0);
		expect(await col.countDocuments({})).toBe(before);
	});

	test("a hostile key in a sort does not run either", async () => {
		const rows = await col
			.find({})
			.sort({ "n` DESC; REMOVE TABLE docs; --": 1 } as never)
			.toArray();
		expect(rows.length).toBe(1);
		expect(await col.countDocuments({})).toBe(1);
	});
});

/**
 * Names a hand-kept reserved-word list missed.
 *
 * These are ordinary MongoDB names — `function` and `table` in particular are
 * unremarkable collection names — and each was measured to fail bare in at
 * least one position this driver emits an identifier in, while the list that
 * decided when to quote did not contain them. So a collection called `function`
 * was not merely awkward: every operation on it raised a raw SurrealQL parse
 * error.
 *
 * The last two are the reason this is tested against a live server rather than
 * asserted as a string. Bare, `none` and `true` do not fail — `SELECT * FROM
 * none` answers `[]` and `SELECT * FROM true` answers `[true]` — so a caller
 * with a collection so named was answered wrongly instead of refused, which no
 * amount of reading the generated SQL would reveal.
 */
describe("keyword-named collections", () => {
	const names = [
		"function",
		"table",
		"tb",
		"alter",
		"rebuild",
		"sleep",
		"only",
		"overwrite",
		"and",
		"none",
		"true",
		"select",
	];

	for (const name of names) {
		test(`a collection named \`${name}\` round-trips`, async () => {
			const keyword = db.collection<Doc>(name);

			const inserted = await keyword.insertOne({ normal: 1 } as Doc);
			expect(inserted.insertedId).toBeDefined();

			expect(await keyword.countDocuments({})).toBe(1);
			expect(await keyword.countDocuments({ normal: 1 } as never)).toBe(1);

			const found = await keyword.findOne({ _id: inserted.insertedId });
			expect(found?.normal).toBe(1);

			const updated = await keyword.updateOne(
				{ normal: 1 } as never,
				{
					$set: { normal: 2 },
				} as never,
			);
			expect(updated.modifiedCount).toBe(1);
			expect(await keyword.countDocuments({ normal: 2 } as never)).toBe(1);

			expect((await keyword.deleteMany({})).deletedCount).toBe(1);
		});
	}

	test("createIndex, listIndexes, dropIndex and drop all name it too", async () => {
		const keyword = db.collection<Doc>("function");
		await keyword.insertOne({ normal: 1 } as Doc);

		expect(await keyword.createIndex({ normal: 1 })).toBe("normal_1");
		const names = (await keyword.listIndexes().toArray()).map((i) => i.name);
		expect(names).toContain("normal_1");

		expect(await keyword.dropIndex("normal_1")).toMatchObject({ ok: 1 });
		expect(await keyword.drop()).toBe(true);
	});

	test("listCollections and createCollection name it as the caller wrote it", async () => {
		await db.createCollection("upsert");
		const listed = (await db.listCollections()).map((c) => c.name);
		expect(listed).toContain("upsert");
		expect(await db.dropCollection("upsert")).toBe(true);
	});
});

describe("keyword-named fields and indexes", () => {
	test("fields named `rand` and `and` are queryable, sortable and indexable", async () => {
		const keyword = db.collection<Doc>("keyword_fields");
		await keyword.insertOne({ rand: 1, and: 2 } as never);

		expect(await keyword.countDocuments({ rand: 1 } as never)).toBe(1);
		expect(await keyword.countDocuments({ and: 2 } as never)).toBe(1);
		expect(await keyword.countDocuments({ rand: 1, and: 2 } as never)).toBe(1);

		const sorted = await keyword.find({}).sort({ rand: 1 }).toArray();
		expect(sorted.length).toBe(1);

		expect(await keyword.distinct("and")).toEqual([2]);
		expect(await keyword.createIndex({ rand: 1 })).toBe("rand_1");

		await keyword.drop();
	});

	/**
	 * The one thing quoting a field name does *not* make safe.
	 *
	 * SurrealDB accepts `DEFINE INDEX … FIELDS \`select\`` and then re-renders the
	 * stored idiom unquoted, so reading the definition back fails — and from then
	 * on the table cannot be scanned, its indexes cannot be listed, and neither
	 * the index, the table nor the database can be dropped
	 * (surrealdb/surrealdb-private#906). `createIndex` reads the definition back
	 * inside the transaction that wrote it, so the failure rolls the definition
	 * away instead of keeping it.
	 *
	 * `function` is the case this driver newly reached: unquoted it was a parse
	 * error, so before quoting the definition was refused by accident. The other
	 * words were quoted already and *did* brick the collection.
	 */
	describe("an index on a field SurrealDB cannot read back", () => {
		for (const field of ["select", "function", "alter", "none", "true"]) {
			test(`{ ${field}: 1 } is refused and the collection survives`, async () => {
				const name = `unindexable_${field}`;
				const keyword = db.collection<Doc>(name);
				await keyword.insertOne({ normal: 1 } as Doc);

				await expect(
					keyword.createIndex({ [field]: 1 } as never),
				).rejects.toThrow(MongoCompatibilityError);

				// Nothing was stored, so everything still answers. Each of these threw
				// a raw SurrealQL conversion error once the definition was kept.
				expect(await keyword.countDocuments({})).toBe(1);
				expect((await keyword.find({}).toArray()).length).toBe(1);
				expect(
					(await keyword.listIndexes().toArray()).map((i) => i.name),
				).toEqual(["_id_"]);
				expect(await keyword.createIndex({ normal: 1 })).toBe("normal_1");
				expect(await keyword.drop()).toBe(true);
			});
		}

		test("a nested path under such a name is indexable, and works", async () => {
			// Only the leading segment is affected — measured for all 26 words.
			const keyword = db.collection<Doc>("nested_keyword_index");
			await keyword.insertOne({ doc: { select: 1 } } as never);

			expect(await keyword.createIndex({ "doc.select": 1 })).toBe(
				"doc.select_1",
			);
			expect(await keyword.countDocuments({ "doc.select": 1 } as never)).toBe(
				1,
			);
			expect(await keyword.drop()).toBe(true);
		});

		test("the refusal names the field and the nested path that works", async () => {
			const keyword = db.collection<Doc>("unindexable_message");
			await keyword.insertOne({ normal: 1 } as Doc);

			const err = await keyword
				.createIndex({ select: 1 } as never)
				.catch((e: Error) => e);
			expect(err).toBeInstanceOf(MongoCompatibilityError);
			expect((err as Error).message).toContain("'select'");
			expect((err as Error).message).toContain("doc.select");

			await keyword.drop();
		});

		test("a compound index is refused for the one field, before anything runs", async () => {
			const keyword = db.collection<Doc>("unindexable_compound");
			await keyword.insertOne({ normal: 1 } as Doc);

			await expect(
				keyword.createIndex({ normal: 1, select: 1 } as never),
			).rejects.toThrow(/'select'/);
			// Refused during validation, so not even the leading field was indexed.
			expect(
				(await keyword.listIndexes().toArray()).map((i) => i.name),
			).toEqual(["_id_"]);

			await keyword.drop();
		});
	});

	test("an index named after a keyword can be created, hinted and dropped", async () => {
		const keyword = db.collection<Doc>("keyword_indexes");
		await keyword.insertOne({ normal: 1 } as Doc);

		expect(await keyword.createIndex({ normal: 1 }, { name: "only" })).toBe(
			"only",
		);
		// A hint puts the name in `WITH INDEX`, a third distinct position.
		expect(
			await keyword.countDocuments({ normal: 1 } as never, { hint: "only" }),
		).toBe(1);
		expect(await keyword.dropIndex("only")).toMatchObject({ ok: 1 });

		expect(
			await keyword.createIndex({ normal: 1 }, { name: "overwrite" }),
		).toBe("overwrite");
		expect(await keyword.dropIndex("overwrite")).toMatchObject({ ok: 1 });

		await keyword.drop();
	});
});

describe("keyword-named databases", () => {
	/**
	 * `USE DB` is the strictest position of the lot: it reads its argument as an
	 * expression, so bare `USE DB function` is a parse error and bare
	 * `USE DB INFO FOR DB` panics the server outright
	 * (surrealdb/surrealdb-private#903). Quoting is what confines a
	 * caller-supplied name to being a name.
	 */
	for (const name of ["function", "alter", "sleep", "and"]) {
		test(`client.db("${name}") reads and writes that database`, async () => {
			const other = client.db(name);
			const keyword = other.collection<Doc>("docs");

			await keyword.insertOne({ normal: 42 } as Doc);
			expect(await keyword.countDocuments({ normal: 42 } as never)).toBe(1);

			// And it is a different database: the connected one is untouched.
			expect(await col.countDocuments({ normal: 42 } as never)).toBe(0);

			expect(await other.dropDatabase()).toBe(true);
		});
	}

	test("a name that would be a whole statement is still only a name", async () => {
		const other = client.db("INFO FOR DB");
		await other.collection<Doc>("docs").insertOne({ normal: 1 } as Doc);
		expect(await other.collection<Doc>("docs").countDocuments({})).toBe(1);
		expect(await other.dropDatabase()).toBe(true);

		// The server is still there — the point of the previous assertion.
		expect(await col.countDocuments({})).toBe(1);
	});
});
