import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Collection, ObjectId } from "../../src/index.ts";
import {
	type SurrealTestContext,
	setupSurreal,
	teardownSurreal,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// Test document shape
// ---------------------------------------------------------------------------

interface TestDoc {
	[key: string]: unknown;
	_id?: ObjectId | string | number;
	name: string;
	age?: number;
	bio?: string;
	title?: string;
}

let ctx: SurrealTestContext<TestDoc>;
let col: Collection<TestDoc>;
const PORT = 18739;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
	ctx = await setupSurreal<TestDoc>(PORT);
});

afterAll(async () => {
	await teardownSurreal(ctx);
});

beforeEach(async () => {
	col = ctx.collection("index_tests");
	try {
		await col.deleteMany({});
	} catch {
		// ignore
	}
});

// ---------------------------------------------------------------------------
// createIndex – regular
// ---------------------------------------------------------------------------

describe("createIndex", () => {
	test("creates a regular index and returns its name", async () => {
		const name = await col.createIndex({ age: 1 });
		expect(name).toBe("age_1");
	});

	test("creates an index with a custom name", async () => {
		const name = await col.createIndex({ name: 1 }, { name: "idx_name" });
		expect(name).toBe("idx_name");
	});

	test("creates a compound index", async () => {
		const compoundCol = ctx.collection("compound_idx_test");
		const name = await compoundCol.createIndex({ name: 1, age: -1 });
		expect(name).toBe("name_1_age_neg1");
	});
});

// ---------------------------------------------------------------------------
// createIndex – text
// ---------------------------------------------------------------------------

describe("createIndex (text)", () => {
	test("creates a text index", async () => {
		const textCol = ctx.collection("text_idx_test");
		const name = await textCol.createIndex({ bio: "text" });
		expect(name).toBe("bio_text");
	});

	test("registers text fields for $text queries", async () => {
		const textCol2 = ctx.collection("text_idx_test2");
		await textCol2.createIndex({ bio: "text" });
		// Internal: _textFields should now include "bio"
		expect(textCol2._textFields).toContain("bio");
	});
});

// ---------------------------------------------------------------------------
// listIndexes
// ---------------------------------------------------------------------------

describe("listIndexes", () => {
	test("returns tracked indexes", async () => {
		const listCol = ctx.collection("list_idx_test");
		await listCol.createIndex({ age: 1 });
		await listCol.createIndex({ name: 1 }, { name: "name_idx" });
		const indexes = listCol.listIndexes();
		expect(indexes).toHaveLength(2);
		expect(indexes.map((i) => i.name).sort()).toEqual(["age_1", "name_idx"]);
	});

	test("returns empty array when no indexes exist", async () => {
		const freshCol = ctx.collection("no_indexes");
		const indexes = freshCol.listIndexes();
		expect(indexes).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// dropIndex
// ---------------------------------------------------------------------------

describe("dropIndex", () => {
	test("removes an index by name", async () => {
		const dropCol = ctx.collection("drop_idx_test");
		await dropCol.createIndex({ age: 1 });
		const before = dropCol.listIndexes();
		expect(before).toHaveLength(1);

		await dropCol.dropIndex("age_1");
		const after = dropCol.listIndexes();
		expect(after).toHaveLength(0);
	});

	test("removes text fields when dropping a text index", async () => {
		const dropTextCol = ctx.collection("drop_text_idx_test");
		await dropTextCol.createIndex({ bio: "text" });
		expect(dropTextCol._textFields).toContain("bio");

		await dropTextCol.dropIndex("bio_text");
		expect(dropTextCol._textFields).not.toContain("bio");
	});
});

// ---------------------------------------------------------------------------
// $text / $search queries
// ---------------------------------------------------------------------------

describe("$text search", () => {
	// NOTE: $text search requires a SEARCH ANALYZER to be defined in SurrealDB.
	// The built-in analyzer names vary across SurrealDB versions.
	// This test is skipped until the analyzer configuration is stabilised.
	test.skip("finds documents matching text search", async () => {
		const textCol = ctx.collection("text_search");
		try {
			await textCol.deleteMany({});
		} catch {
			// ignore
		}

		await textCol.createIndex({ bio: "text" });

		await textCol.insertMany([
			{ name: "Alice", bio: "software engineer at a tech company" },
			{ name: "Bob", bio: "data scientist working on machine learning" },
			{ name: "Charlie", bio: "software developer building web apps" },
		]);

		const results = await textCol
			.find({ $text: { $search: "software" } })
			.toArray();
		expect(results.length).toBeGreaterThanOrEqual(1);
		const names = results.map((r) => r.name);
		expect(names).toContain("Alice");
		expect(names).toContain("Charlie");
	});
});
