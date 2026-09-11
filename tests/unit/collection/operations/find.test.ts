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

		expect(executor.queries[0].sql).toBe("SELECT * FROM `users` LIMIT 1");
		expect(executor.queries[0].bindings).toEqual({});
		expect(doc).toEqual({ _id: "a", name: "Alice" });
	});

	test("appends WHERE for filter and stitches inclusion projection", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([{ id: new RecordId("users", "a"), name: "Alice" }]);

		await findOne(ctx, { name: "Alice" }, { projection: { name: 1 } });

		expect(executor.queries[0].sql).toBe(
			"SELECT id, `name` FROM `users` WHERE (`name` = $p0 OR (type::is_array(`name`) AND `name` CONTAINS $p0)) LIMIT 1",
		);
		expect(executor.queries[0].bindings).toEqual({ p0: "Alice" });
	});

	test("returns null when no rows", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);
		expect(await findOne(ctx, { _id: "missing" })).toBeNull();
	});

	test("applies exclusion projection via a server-side OMIT", async () => {
		const { ctx, executor } = makeContext();
		// The mocked row is what the server would actually return: `secret` is
		// already gone, stripped by OMIT rather than by JS post-processing.
		executor.enqueue([{ id: new RecordId("users", "a"), name: "Alice" }]);

		const doc = await findOne(ctx, undefined, { projection: { secret: 0 } });

		expect(doc).toEqual({ _id: "a", name: "Alice" });
		// Inclusion path was NOT taken: SQL still selects *, and OMIT does the
		// excluding server-side.
		expect(executor.queries[0].sql).toContain("SELECT * OMIT `secret` FROM");
	});

	test("respects explicit sort and uses ORDER BY", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);
		await findOne(ctx, undefined, { sort: { age: -1 } });
		expect(executor.queries[0].sql).toBe(
			"SELECT * FROM `users` ORDER BY `age` DESC LIMIT 1",
		);
	});

	test("$near orders by a projected distance alias, hidden from the result", async () => {
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

		// `ORDER BY geo::distance(...)` does not parse — SurrealDB's ORDER BY takes
		// a field path — so the distance is projected under an alias in a subquery,
		// ordered by that alias *inside* the subquery, and omitted on the way out.
		// Simplifying any of those three back is what breaks the query.
		expect(executor.queries[0].sql).toBe(
			"SELECT * OMIT `__mql_distance` FROM (" +
				"SELECT *, geo::distance(`location`, $p0) AS `__mql_distance` FROM `users` " +
				"WHERE type::is_point(`location`) AND geo::distance(`location`, $p0) <= $p1 " +
				"ORDER BY `__mql_distance` ASC LIMIT 1" +
				")",
		);
	});

	test("an explicit sort wins over $near's distance ordering, as in MongoDB", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);

		await findOne(
			ctx,
			{
				location: {
					$near: { $geometry: { type: "Point", coordinates: [0, 0] } },
				},
			},
			{ sort: { name: 1 } },
		);

		// No subquery is needed at all once nothing orders by distance, so the
		// distance band stays an ordinary WHERE condition.
		expect(executor.queries[0].sql).toBe(
			"SELECT * FROM `users` WHERE type::is_point(`location`) ORDER BY `name` ASC LIMIT 1",
		);
	});

	test("an inclusion projection replaces the alias rather than omitting it", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);

		await findOne(
			ctx,
			{
				location: {
					$near: { $geometry: { type: "Point", coordinates: [0, 0] } },
				},
			},
			{ projection: { name: 1 } },
		);

		// An outer field list cannot carry an alias it does not name, so there is
		// nothing to OMIT — and the ordering still has to live inside, because an
		// outer `ORDER BY __mql_distance` fails to parse against this field list.
		expect(executor.queries[0].sql).toBe(
			"SELECT id, `name` FROM (" +
				"SELECT *, geo::distance(`location`, $p0) AS `__mql_distance` FROM `users` " +
				"WHERE type::is_point(`location`) ORDER BY `__mql_distance` ASC LIMIT 1" +
				")",
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
			"SELECT * FROM `users` WHERE (`active` = $p0 OR (type::is_array(`active`) AND `active` CONTAINS $p0)) ORDER BY `age` ASC LIMIT 5 START 10",
		);
		expect(executor.queries[0].bindings).toEqual({ p0: true });
		expect(docs).toEqual([{ _id: "a", name: "Alice" }]);
	});

	test("inclusion projection becomes the SELECT field list", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);
		await executeFind(ctx, undefined, {
			projectionColumns: ["name", "age"],
		});
		expect(executor.queries[0].sql).toBe("SELECT name, age FROM `users`");
	});

	test("exclusion projection is applied via a server-side OMIT", async () => {
		const { ctx, executor } = makeContext();
		// `secret` is already absent from the mocked rows: OMIT strips it on the
		// server, there is no JS-side field removal left to test here.
		executor.enqueue([
			{ id: new RecordId("users", "a"), name: "Alice" },
			{ id: new RecordId("users", "b"), name: "Bob" },
		]);
		const docs = await executeFind(ctx, undefined, {
			projectionExcludeFields: ["secret"],
		});
		expect(docs).toEqual([
			{ _id: "a", name: "Alice" },
			{ _id: "b", name: "Bob" },
		]);
		expect(executor.queries[0].sql).toContain("OMIT `secret`");
	});

	test("projectionIncludeId=false suppresses _id", async () => {
		const { ctx, executor } = makeContext();
		// `id` is already absent from the mocked row: an inclusion column list
		// that doesn't name it just never selects it, no OMIT needed.
		executor.enqueue([{ name: "Alice" }]);
		const docs = await executeFind(ctx, undefined, {
			projectionColumns: ["name"],
			projectionIncludeId: false,
		});
		expect(docs[0]._id).toBeUndefined();
		expect("_id" in docs[0]).toBe(false);
		expect(docs[0].name).toBe("Alice");
		expect(executor.queries[0].sql).toBe("SELECT name FROM `users`");
	});

	test("returns [] when the executor returns no rows", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue(undefined); // simulate "no rows" envelope
		const docs = await executeFind(ctx, undefined, {});
		expect(docs).toEqual([]);
	});

	test("$near pages inside the ordering subquery and times out outside it", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);

		await executeFind(
			ctx,
			{
				status: "open",
				location: {
					$near: { $geometry: { type: "Point", coordinates: [0, 0] } },
				},
			},
			{ limit: 5, skip: 10 },
			{ maxTimeMS: 250 },
		);

		// The enclosing select filters nothing, so paging the ordered rows and
		// paging the projection of them are the same rows — and pairing the paging
		// with the `ORDER BY` is what lets SurrealDB stop at a page instead of
		// ordering everything the filter matched. `TIMEOUT` cannot join them:
		// SurrealQL takes one, last, so it bounds the whole statement.
		expect(executor.queries[0].sql).toBe(
			"SELECT * OMIT `__mql_distance` FROM (" +
				"SELECT *, geo::distance(`location`, $p1) AS `__mql_distance` FROM `users` " +
				"WHERE (`status` = $p0 OR (type::is_array(`status`) AND `status` CONTAINS $p0)) " +
				"AND type::is_point(`location`) " +
				"ORDER BY `__mql_distance` ASC LIMIT 5 START 10" +
				") TIMEOUT 250ms",
		);
	});

	test("a filter with no $near is unchanged: no subquery, no alias", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);

		await executeFind(ctx, { status: "open" }, { limit: 5 });

		expect(executor.queries[0].sql).not.toContain("__mql_distance");
		expect(executor.queries[0].sql).toBe(
			"SELECT * FROM `users` WHERE (`status` = $p0 OR (type::is_array(`status`) AND `status` CONTAINS $p0)) LIMIT 5",
		);
	});
});
