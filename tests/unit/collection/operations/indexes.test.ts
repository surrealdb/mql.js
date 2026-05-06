import { describe, expect, test } from "bun:test";
import { IndexRegistry } from "../../../../src/collection/index-registry.ts";
import {
	createIndex,
	dropIndex,
	listIndexes,
} from "../../../../src/collection/operations/indexes.ts";
import {
	V2Dialect,
	V3Dialect,
} from "../../../../src/translators/dialect/index.ts";
import { makeContext } from "../../../helpers/operation-context.ts";

describe("createIndex – regular (non-text) index", () => {
	test("emits DEFINE INDEX with auto-generated name and tracks it", async () => {
		const { ctx, executor, indexes } = makeContext();
		const name = await createIndex(ctx, { age: 1 });

		expect(name).toBe("age_1");
		expect(executor.queries.length).toBe(1);
		expect(executor.queries[0].sql).toBe(
			"DEFINE INDEX age_1 ON users FIELDS age",
		);
		expect(indexes.list()).toEqual([{ name: "age_1", key: { age: 1 } }]);
	});

	test("descending direction is encoded as `neg` in the auto-name", async () => {
		const { ctx, executor } = makeContext();
		const name = await createIndex(ctx, { age: -1 });
		expect(name).toBe("age_neg1");
		expect(executor.queries[0].sql).toBe(
			"DEFINE INDEX age_neg1 ON users FIELDS age",
		);
	});

	test("compound index uses comma-separated FIELDS list", async () => {
		const { ctx, executor } = makeContext();
		await createIndex(ctx, { a: 1, b: -1 });
		expect(executor.queries[0].sql).toBe(
			"DEFINE INDEX a_1_b_neg1 ON users FIELDS a, b",
		);
	});

	test("explicit name option overrides the auto-generated one", async () => {
		const { ctx, executor } = makeContext();
		const name = await createIndex(ctx, { age: 1 }, { name: "by_age" });
		expect(name).toBe("by_age");
		expect(executor.queries[0].sql).toContain("DEFINE INDEX by_age");
	});
});

describe("createIndex – text indexes (dialect-driven)", () => {
	test("v3 dialect: defines blank analyzer first, then FULLTEXT index", async () => {
		const { ctx, executor, indexes } = makeContext({
			dialect: new V3Dialect(),
		});
		const name = await createIndex(ctx, { title: "text" });

		expect(name).toBe("title_text");
		expect(executor.queries.length).toBe(2);
		expect(executor.queries[0].sql).toBe(
			"DEFINE ANALYZER IF NOT EXISTS blank TOKENIZERS blank FILTERS lowercase",
		);
		expect(executor.queries[1].sql).toBe(
			"DEFINE INDEX title_text ON users FIELDS title FULLTEXT ANALYZER blank BM25 HIGHLIGHTS",
		);
		expect(indexes.textFields).toEqual(["title"]);
	});

	test("v2 dialect: skips analyzer DDL and uses SEARCH keyword", async () => {
		const { ctx, executor, indexes } = makeContext({
			dialect: new V2Dialect(),
		});
		await createIndex(ctx, { title: "text" });

		expect(executor.queries.length).toBe(1); // no analyzer DDL on v2
		expect(executor.queries[0].sql).toBe(
			"DEFINE INDEX title_text ON users FIELDS title SEARCH ANALYZER blank BM25 HIGHLIGHTS",
		);
		expect(indexes.textFields).toEqual(["title"]);
	});

	test("multi-field text index registers every text field", async () => {
		const { ctx, indexes } = makeContext({ dialect: new V3Dialect() });
		await createIndex(ctx, { title: "text", body: "text" });
		expect(indexes.textFields).toEqual(["title", "body"]);
	});
});

describe("dropIndex", () => {
	test("emits REMOVE INDEX and untracks it", async () => {
		const indexes = new IndexRegistry();
		indexes.add({ age: 1 }, "age_1");
		const { ctx, executor } = makeContext({ indexes });

		await dropIndex(ctx, "age_1");

		expect(executor.queries[0].sql).toBe("REMOVE INDEX age_1 ON users");
		expect(indexes.list()).toEqual([]);
	});

	test("dropping a text index also untracks its text fields", async () => {
		const { ctx, indexes } = makeContext({ dialect: new V3Dialect() });
		await createIndex(ctx, { title: "text" });
		expect(indexes.textFields).toEqual(["title"]);
		await dropIndex(ctx, "title_text");
		expect(indexes.textFields).toEqual([]);
	});
});

describe("listIndexes", () => {
	test("returns the current registry snapshot", async () => {
		const { ctx, indexes } = makeContext();
		expect(listIndexes(ctx)).toEqual([]);
		await createIndex(ctx, { age: 1 });
		expect(listIndexes(ctx)).toEqual([{ name: "age_1", key: { age: 1 } }]);
		// Mutating the returned array does not affect the live state.
		listIndexes(ctx).pop();
		expect(indexes.list().length).toBe(1);
	});
});
