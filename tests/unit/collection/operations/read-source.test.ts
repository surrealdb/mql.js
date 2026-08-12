/**
 * Where an ordered read puts its `ORDER BY`, and when it declines to run at all.
 *
 * SurrealDB requires every `ORDER BY` idiom to appear in the statement's own field
 * list. Three consequences are pinned here: a read whose field list carries its
 * sort orders **in place**, clauses and all; a read whose field list does not
 * carry it is **refused**, in terms that name what is missing; and `$near`, whose
 * ordering is a computed distance no field list can name, orders in a **subquery**.
 */

import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
	executeFind,
	findOne,
} from "../../../../src/collection/operations/find.ts";
import { MongoCompatibilityError } from "../../../../src/errors.ts";
import { makeContext } from "../../../helpers/operation-context.ts";

const NEAR_POINT = {
	location: { $near: { $geometry: { type: "Point", coordinates: [0, 0] } } },
};

describe("a sort the field list does not name", () => {
	test("is refused, naming the column that cannot be ordered by", async () => {
		const { ctx } = makeContext();

		const failure = executeFind(ctx, undefined, {
			sort: { k: 1 },
			projectionFields: "id, tag",
		});

		await expect(failure).rejects.toBeInstanceOf(MongoCompatibilityError);
		// The message has to say which column is at fault: the caller chose the
		// projection and the sort independently, and only one of them has to change.
		await expect(failure).rejects.toThrow(/Sorting by k\b/);
	});

	test("names every column the field list is missing, and no other", async () => {
		const { ctx } = makeContext();

		const failure = executeFind(ctx, undefined, {
			sort: { extra: 1, k: -1, tag: 1 },
			projectionFields: "id, tag",
		});

		// `tag` is projected, so it is not part of the complaint.
		await expect(failure).rejects.toThrow(/Sorting by extra, k while/);
	});

	test("says how the caller can get the documents anyway", async () => {
		const { ctx } = makeContext();

		const failure = executeFind(ctx, undefined, {
			sort: { k: 1 },
			projectionFields: "id, tag",
		});

		// Every one of the three ways out is a change the caller makes, so the error
		// is only useful if it lists them.
		await expect(failure).rejects.toThrow(
			/Include that field in the projection/,
		);
		await expect(failure).rejects.toThrow(
			/use an exclusion projection instead/,
		);
		await expect(failure).rejects.toThrow(
			/sort the results after reading them/,
		);
	});

	test("is refused before anything is asked of the server", async () => {
		const { ctx, executor } = makeContext();

		await expect(
			executeFind(ctx, undefined, {
				sort: { k: 1 },
				projectionFields: "id, tag",
			}),
		).rejects.toBeInstanceOf(MongoCompatibilityError);

		// A statement SurrealDB would reject is never sent, so the caller gets this
		// error rather than a parse error from the wire.
		expect(executor.queries).toHaveLength(0);
	});

	test("is refused for a dotted sort path the field list does not name", async () => {
		const { ctx } = makeContext();

		// A projection of `a.c` names `a.c`, not `a`, so it carries nothing of `a.b`.
		await expect(
			executeFind(ctx, undefined, {
				sort: { "a.b": 1 },
				projectionFields: "id, a.c",
			}),
		).rejects.toThrow(/Sorting by a\.b while/);
	});

	test("is refused for a sort on _id the projection suppressed", async () => {
		const { ctx } = makeContext();

		// `{_id: 0}` takes the identity column out of the field list, and the sort
		// is reported against the column SurrealDB would have been asked to order by.
		await expect(
			executeFind(ctx, undefined, {
				sort: { _id: -1 },
				projectionFields: "tag",
				projectionIncludeId: false,
			}),
		).rejects.toThrow(/Sorting by id while/);
	});

	test("is refused from findOne on the same terms", async () => {
		const { ctx, executor } = makeContext();

		await expect(
			findOne(ctx, {}, { projection: { tag: 1 }, sort: { k: 1 } }),
		).rejects.toBeInstanceOf(MongoCompatibilityError);
		expect(executor.queries).toHaveLength(0);
	});
});

describe("a sort the field list carries", () => {
	test("orders the statement itself, projection and all", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);

		await executeFind(ctx, undefined, {
			sort: { k: 1 },
			projectionFields: "id, tag, k",
		});

		expect(executor.queries[0].sql).toBe(
			"SELECT id, tag, k FROM users ORDER BY k ASC",
		);
	});

	test("orders in place when the field list is a star", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);

		// A `SELECT *` carries every idiom an `ORDER BY` could name. An exclusion
		// projection is this case too: it selects everything and removes fields
		// afterwards, so any sort at all can be served under one.
		await executeFind(ctx, undefined, {
			sort: { k: 1 },
			projectionExcludeFields: ["k"],
		});

		expect(executor.queries[0].sql).toBe("SELECT * FROM users ORDER BY k ASC");
	});

	test("orders by the identity column an inclusion projection prepends", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);

		// An inclusion projection leads with `id` so `_id` comes back as MongoDB
		// returns it — which means a sort on `_id` is always carried by one.
		await executeFind(ctx, undefined, {
			sort: { _id: -1 },
			projectionFields: "id, tag",
		});

		expect(executor.queries[0].sql).toBe(
			"SELECT id, tag FROM users ORDER BY id DESC",
		);
	});

	test("orders by several fields, all of them projected", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);

		await executeFind(ctx, undefined, {
			sort: { extra: 1, k: -1 },
			projectionFields: "id, extra, k",
		});

		expect(executor.queries[0].sql).toBe(
			"SELECT id, extra, k FROM users ORDER BY extra ASC, k DESC",
		);
	});

	test("orders by a dotted path the projection names", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);

		await executeFind(ctx, undefined, {
			sort: { "a.b": 1 },
			projectionFields: "id, a.b",
		});

		expect(executor.queries[0].sql).toBe(
			"SELECT id, a.b FROM users ORDER BY a.b ASC",
		);
	});

	test("keeps the filter and the index hint on the ordered statement", async () => {
		const { ctx, executor } = makeContext();
		// A hint is resolved against the table's real indexes before it becomes a
		// clause, so the read of those has to be answered first.
		executor.enqueue({
			indexes: [{ name: "active_1", cols: ["active"], index: "" }],
		});
		executor.enqueue([]);

		await executeFind(
			ctx,
			{ active: true },
			{ sort: { k: -1 }, projectionFields: "id, k" },
			{ hint: "active_1" },
		);

		expect(executor.queries[1].sql).toBe(
			"SELECT id, k FROM users WITH INDEX active_1 " +
				"WHERE (active = $p0 OR (type::is_array(active) AND active CONTAINS $p0)) " +
				"ORDER BY k DESC",
		);
	});

	test("pages beside the ordering rather than under it", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);

		await executeFind(
			ctx,
			undefined,
			{ sort: { k: 1 }, limit: 5, skip: 10, projectionFields: "id, k" },
			{ maxTimeMS: 1000 },
		);

		// `LIMIT` and `START` sit with the `ORDER BY` they page, on the one statement
		// that has both — never moved into a source of their own. Measured on 3.2.x,
		// paging an ordering from outside it costs several times what paging it
		// alongside does, because only the latter can be answered from an index
		// instead of ordering everything the filter matched. `TIMEOUT` comes last, as
		// SurrealQL requires.
		expect(executor.queries[0].sql).toBe(
			"SELECT id, k FROM users ORDER BY k ASC LIMIT 5 START 10 TIMEOUT 1000ms",
		);
	});

	test("pages a skip without a limit", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);

		await executeFind(ctx, undefined, {
			sort: { k: 1 },
			skip: 2,
			projectionFields: "id, k",
		});

		expect(executor.queries[0].sql).toBe(
			"SELECT id, k FROM users ORDER BY k ASC START 2",
		);
	});

	test("pages an unprojected read in place too", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);

		await executeFind(ctx, undefined, { sort: { k: 1 }, limit: 5, skip: 10 });

		expect(executor.queries[0].sql).toBe(
			"SELECT * FROM users ORDER BY k ASC LIMIT 5 START 10",
		);
	});

	test("findOne orders the same way, and asks for one row", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([{ id: new RecordId("users", "a"), tag: "t" }]);

		await findOne(ctx, {}, { projection: { tag: 1 }, sort: { _id: 1 } });

		expect(executor.queries[0].sql).toBe(
			"SELECT id, tag FROM users ORDER BY id ASC LIMIT 1",
		);
	});

	test("returns the projected documents in the order they arrived", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([
			{ id: new RecordId("users", "b"), tag: "t2", k: 1 },
			{ id: new RecordId("users", "a"), tag: "t1", k: 2 },
		]);

		const docs = await executeFind(ctx, undefined, {
			sort: { k: 1 },
			projectionFields: "id, tag, k",
		});

		expect(docs).toEqual([
			{ _id: "b", tag: "t2", k: 1 },
			{ _id: "a", tag: "t1", k: 2 },
		]);
	});
});

describe("a sort composed with $near", () => {
	test("replaces the distance ordering rather than nesting inside it", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);

		await executeFind(ctx, NEAR_POINT, {
			sort: { k: 1 },
			projectionFields: "id, name, k",
		});

		// MongoDB lets an explicit sort win over the ordering `$near` implies, so the
		// distance is never projected and nothing needs a source of its own.
		const { sql } = executor.queries[0];
		expect(sql).toBe(
			"SELECT id, name, k FROM users " +
				"WHERE type::is_point(location) ORDER BY k ASC",
		);
		expect(sql).not.toContain("__mql_distance");
	});

	test("orders by distance in its own subquery when no sort overrides it", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);

		// `ORDER BY` takes an idiom, and a distance is an expression, so no field
		// list can carry this ordering however the caller projects. The alias in the
		// subquery's `*` is the only thing that can.
		expect(
			await executeFind(ctx, NEAR_POINT, { projectionFields: "id, name" }),
		).toEqual([]);

		expect(executor.queries[0].sql).toBe(
			"SELECT id, name FROM (SELECT *, geo::distance(location, $p0) AS __mql_distance " +
				"FROM users WHERE type::is_point(location) ORDER BY __mql_distance ASC)",
		);
	});

	test("pages the distance ordering inside the subquery that carries it", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);

		await executeFind(
			ctx,
			NEAR_POINT,
			{ limit: 5, skip: 10, projectionFields: "id, name" },
			{ maxTimeMS: 250 },
		);

		// The enclosing select filters nothing, so both placements name the same
		// rows — but only this one lets SurrealDB stop at a page instead of ordering
		// everything the filter matched. `TIMEOUT` cannot join them: SurrealQL takes
		// one, and it has to come last.
		expect(executor.queries[0].sql).toBe(
			"SELECT id, name FROM (SELECT *, geo::distance(location, $p0) AS __mql_distance " +
				"FROM users WHERE type::is_point(location) " +
				"ORDER BY __mql_distance ASC LIMIT 5 START 10) TIMEOUT 250ms",
		);
	});

	test("hides the distance alias from an unprojected read", async () => {
		const { ctx, executor } = makeContext();
		executor.enqueue([]);

		await executeFind(ctx, NEAR_POINT, {});

		// Only a `*` can carry the alias, so only a `*` needs to omit it.
		expect(executor.queries[0].sql).toStartWith(
			"SELECT * OMIT __mql_distance FROM (",
		);
	});
});
