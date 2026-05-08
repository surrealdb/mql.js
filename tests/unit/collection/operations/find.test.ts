import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
	executeFind,
	findOne,
} from "../../../../src/collection/operations/find.ts";
import { makeContext } from "../../../helpers/operation-context.ts";

describe("findOne", () => {
	test("emits SELECT * FROM <table> LIMIT 1 with no filter", async () => {
		const { ctx, executor } = makeContext({ collectionName: "users" });
		executor.enqueue([{ id: new RecordId("users", "a"), name: "Alice" }]);

		const doc = await findOne(ctx);

		expect(executor.queries[0].sql).toBe("SELECT * FROM users LIMIT 1");
		expect(executor.queries[0].bindings).toEqual({});
		expect(doc).toEqual({ _id: "a", name: "Alice" });
	});

	test("appends WHERE for filter and stitches inclusion projection", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([{ id: new RecordId("users", "a"), name: "Alice" }]);

		await findOne(ctx, { name: "Alice" }, { projection: { name: 1 } });

		expect(executor.queries[0].sql).toBe(
			"SELECT name FROM users WHERE name = $p0 LIMIT 1",
		);
		expect(executor.queries[0].bindings).toEqual({ p0: "Alice" });
	});

	test("returns null when no rows", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);
		expect(await findOne(ctx, { _id: "missing" })).toBeNull();
	});

	test("applies exclusion projection in post-processing", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([
			{ id: new RecordId("users", "a"), name: "Alice", secret: "x" },
		]);

		const doc = await findOne(ctx, undefined, { projection: { secret: 0 } });

		expect(doc).toEqual({ _id: "a", name: "Alice" });
		// Inclusion path was NOT taken: SQL still selects *.
		expect(executor.queries[0].sql).toContain("SELECT * FROM");
	});

	test("respects explicit sort and uses ORDER BY", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);
		await findOne(ctx, undefined, { sort: { age: -1 } });
		expect(executor.queries[0].sql).toBe(
			"SELECT * FROM users ORDER BY age DESC LIMIT 1",
		);
	});

	test("nearSort from $near is applied when no explicit sort is given", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);
		await findOne(ctx, {
			location: {
				$near: {
					$geometry: { type: "Point", coordinates: [0, 0] },
					$maxDistance: 100,
				},
			},
		});
		expect(executor.queries[0].sql).toContain(
			"ORDER BY geo::distance(location, $p0) ASC",
		);
	});
});

describe("executeFind", () => {
	test("builds SELECT */WHERE/ORDER/LIMIT/START in the canonical order", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([{ id: new RecordId("users", "a"), name: "Alice" }]);

		const docs = await executeFind(
			ctx,
			{ active: true },
			{ sort: { age: 1 }, limit: 5, skip: 10 },
		);

		expect(executor.queries[0].sql).toBe(
			"SELECT * FROM users WHERE active = $p0 ORDER BY age ASC LIMIT 5 START 10",
		);
		expect(executor.queries[0].bindings).toEqual({ p0: true });
		expect(docs).toEqual([{ _id: "a", name: "Alice" }]);
	});

	test("inclusion projection becomes the SELECT field list", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);
		await executeFind(ctx, undefined, {
			projectionFields: "name, age",
		});
		expect(executor.queries[0].sql).toBe("SELECT name, age FROM users");
	});

	test("exclusion projection is applied in JS post-processing", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([
			{ id: new RecordId("users", "a"), name: "Alice", secret: "x" },
			{ id: new RecordId("users", "b"), name: "Bob", secret: "y" },
		]);
		const docs = await executeFind(ctx, undefined, {
			projectionExcludeFields: ["secret"],
		});
		expect(docs).toEqual([
			{ _id: "a", name: "Alice" },
			{ _id: "b", name: "Bob" },
		]);
	});

	test("projectionIncludeId=false suppresses _id in the post-processed result", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([{ id: new RecordId("users", "a"), name: "Alice" }]);
		const docs = await executeFind(ctx, undefined, {
			projectionFields: "name",
			projectionIncludeId: false,
		});
		expect(docs[0]._id).toBeUndefined();
		expect(docs[0].name).toBe("Alice");
	});

	test("returns [] when the executor returns no rows", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue(undefined); // simulate "no rows" envelope
		const docs = await executeFind(ctx, undefined, {});
		expect(docs).toEqual([]);
	});
});
