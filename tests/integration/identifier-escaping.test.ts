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
