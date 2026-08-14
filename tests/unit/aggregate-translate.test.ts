/**
 * The SurrealQL an aggregation pipeline compiles to.
 *
 * These assert the *shape* — which stages share a statement and which force a
 * subquery — because that is the part no integration test can show you. A
 * pipeline that nested where it did not need to still returns the right
 * documents; it just costs more. A pipeline that folded where it should have
 * nested returns the wrong ones.
 *
 * The behaviour these shapes are chosen for is measured in
 * `tests/integration/aggregate.test.ts` against a real server.
 */

import { describe, expect, test } from "bun:test";
import { translatePipeline } from "../../src/translators/aggregate/index.ts";
import type { Document } from "../../src/types.ts";

const compile = (pipeline: Document[]) =>
	translatePipeline(pipeline, { table: "`sales`", collection: "sales" });

const sql = (pipeline: Document[]) => compile(pipeline).sql;

/** How many `SELECT`s the pipeline became. */
const depth = (pipeline: Document[]) =>
	(sql(pipeline).match(/SELECT/g) ?? []).length;

describe("stages that share one statement", () => {
	test("$match is a WHERE, translated as a find() filter is", () => {
		// Equality carries MongoDB's array-membership reading — `{cat: "a"}` matches
		// a scalar "a" and an array containing it — because `$match` runs through
		// the same translator `find()` does, rather than a second implementation.
		expect(sql([{ $match: { cat: "a" } }])).toBe(
			"SELECT * FROM `sales` WHERE (`cat` = $m0p0 OR (type::is_array(`cat`) AND `cat` CONTAINS $m0p0))",
		);
	});

	test("$match, $sort, $skip and $limit all fit one SELECT", () => {
		expect(
			sql([
				{ $match: { cat: "a" } },
				{ $sort: { price: -1 } },
				{ $skip: 2 },
				{ $limit: 5 },
			]),
		).toEndWith("ORDER BY `price` DESC START 2 LIMIT 5");
	});

	test("$group then $sort then $limit is one SELECT", () => {
		// The common tail. ORDER BY sees aggregate aliases, which is what lets the
		// sort stay in the same statement as the grouping it orders.
		expect(
			depth([
				{ $group: { _id: "$cat", n: { $sum: 1 } } },
				{ $sort: { n: -1 } },
				{ $limit: 3 },
			]),
		).toBe(1);
	});
});

describe("stages that force a subquery", () => {
	test("$match after $group becomes a HAVING", () => {
		const statement = sql([
			{ $group: { _id: "$cat", n: { $sum: 1 } } },
			{ $match: { n: { $gt: 1 } } },
		]);
		expect(
			depth([
				{ $group: { _id: "$cat", n: { $sum: 1 } } },
				{ $match: { n: { $gt: 1 } } },
			]),
		).toBe(2);
		expect(statement).toContain("FROM (SELECT");
		expect(statement).toEndWith("WHERE `n` > $m1p0");
	});

	test("$match after $project nests, because WHERE cannot see an alias", () => {
		expect(
			depth([
				{ $project: { doubled: { $multiply: ["$price", 2] } } },
				{ $match: { doubled: { $gt: 10 } } },
			]),
		).toBe(2);
	});

	test("$match after $unwind nests, because WHERE runs before SPLIT", () => {
		expect(depth([{ $unwind: "$tags" }, { $match: { tags: "p" } }])).toBe(2);
	});

	test("$group after $unwind nests, because SPLIT and GROUP cannot share", () => {
		expect(
			depth([
				{ $unwind: "$tags" },
				{ $group: { _id: "$tags", n: { $sum: 1 } } },
			]),
		).toBe(2);
	});

	test("$project after $group nests rather than overwriting the aggregates", () => {
		const statement = sql([
			{ $group: { _id: "$cat", n: { $sum: 1 } } },
			{ $project: { n: 1, _id: 0 } },
		]);
		expect(statement).toContain("count() AS `n`");
		expect(
			depth([
				{ $group: { _id: "$cat", n: { $sum: 1 } } },
				{ $project: { n: 1, _id: 0 } },
			]),
		).toBe(2);
	});

	test("$limit before $skip nests, so it means what MongoDB means", () => {
		// Folded, `LIMIT 5 START 2` would skip *then* take. MongoDB's $limit then
		// $skip takes five and then discards two of them.
		const statement = sql([{ $limit: 5 }, { $skip: 2 }]);
		expect(statement).toBe(
			"SELECT * FROM (SELECT * FROM `sales` LIMIT 5) START 2",
		);
	});

	test("two $match stages nest rather than sharing a WHERE", () => {
		expect(depth([{ $match: { a: 1 } }, { $match: { b: 2 } }])).toBe(2);
	});
});

describe("$group", () => {
	test("always groups by the _id alias, never GROUP ALL", () => {
		// `SELECT NULL AS _id … GROUP ALL` returns _id as one null per row rather
		// than a collapsed group — measured, and the reason this idiom is uniform.
		const statement = sql([{ $group: { _id: null, n: { $sum: 1 } } }]);
		expect(statement).toContain("GROUP BY `_id`");
		expect(statement).not.toContain("GROUP ALL");
	});

	test("a compound key becomes an object aliased to _id", () => {
		expect(sql([{ $group: { _id: { c: "$cat" }, n: { $sum: 1 } } }])).toContain(
			'{ "c": `cat` } AS `_id`',
		);
	});

	test("$sum: 1 is count(), not a sum over a constant", () => {
		expect(sql([{ $group: { _id: "$cat", n: { $sum: 1 } } }])).toContain(
			"count() AS `n`",
		);
	});

	test("$sum over anything else is a real sum", () => {
		expect(sql([{ $group: { _id: "$cat", n: { $sum: 2 } } }])).toContain(
			"math::sum($a0) AS `n`",
		);
	});

	test("an unimplemented accumulator is refused by name", () => {
		expect(() =>
			sql([{ $group: { _id: null, d: { $stdDevPop: "$price" } } }]),
		).toThrow(/\$stdDevPop is not implemented/);
	});

	test("a non-accumulator field is refused", () => {
		expect(() => sql([{ $group: { _id: null, x: "$price" } }])).toThrow(
			/must be an accumulator/,
		);
	});

	test("a missing _id is refused", () => {
		expect(() => sql([{ $group: { n: { $sum: 1 } } }])).toThrow(
			/requires an _id/,
		);
	});
});

describe("_id after a reshaping stage", () => {
	test("a sort on _id over stored rows orders by SurrealDB's id", () => {
		expect(sql([{ $sort: { _id: 1 } }])).toContain("ORDER BY id ASC");
	});

	test("a sort on _id after $group orders by the literal field", () => {
		// The grouped rows have an `_id` and no `id` at all, so the rewrite that is
		// right for stored rows would order by a column that is not there.
		const statement = sql([
			{ $group: { _id: "$cat", n: { $sum: 1 } } },
			{ $sort: { _id: 1 } },
		]);
		expect(statement).toContain("ORDER BY `_id` ASC");
		expect(statement).not.toContain("ORDER BY id ASC");
	});

	test("a $match on _id after $group compares the literal field", () => {
		const statement = sql([
			{ $group: { _id: "$cat", n: { $sum: 1 } } },
			{ $match: { _id: "a" } },
		]);
		expect(statement).toEndWith("WHERE `_id` = $m1p0");
	});
});

describe("$unwind", () => {
	test("guards out the rows MongoDB drops", () => {
		const statement = sql([{ $unwind: "$tags" }]);
		expect(statement).toContain("`tags`.is_array() AND `tags`.len() > 0");
		expect(statement).toContain("SPLIT `tags`");
	});

	test("keeps a present non-array value, as MongoDB does", () => {
		expect(sql([{ $unwind: "$tags" }])).toContain(
			"!`tags`.is_array() AND `tags` != NONE",
		);
	});

	test("preserveNullAndEmptyArrays drops the guard", () => {
		const statement = sql([
			{ $unwind: { path: "$tags", preserveNullAndEmptyArrays: true } },
		]);
		expect(statement).not.toContain("is_array()");
		expect(statement).toContain("SPLIT `tags`");
	});

	test("includeArrayIndex is refused rather than ignored", () => {
		expect(() =>
			sql([{ $unwind: { path: "$tags", includeArrayIndex: "i" } }]),
		).toThrow(/includeArrayIndex is not supported/);
	});

	test("a path without a $ is refused", () => {
		expect(() => sql([{ $unwind: "tags" }])).toThrow(/must be a field path/);
	});
});

describe("bindings", () => {
	test("two $match stages do not collide on a parameter name", () => {
		// Both filters number from zero. Without a per-stage prefix the second set
		// of bindings overwrites the first while both clauses still read `$p0`.
		const { sql: statement, bindings } = compile([
			{ $match: { a: "first" } },
			{ $match: { b: "second" } },
		]);
		expect(Object.keys(bindings).sort()).toEqual(["m0p0", "m1p0"]);
		expect(bindings.m0p0).toBe("first");
		expect(bindings.m1p0).toBe("second");
		expect(statement).toContain("$m0p0");
		expect(statement).toContain("$m1p0");
	});

	test("literals in expressions are bound, never interpolated", () => {
		const { sql: statement, bindings } = compile([
			{ $project: { tag: { $literal: "'; DROP TABLE x --" } } },
		]);
		expect(statement).not.toContain("DROP TABLE");
		expect(Object.values(bindings)).toContain("'; DROP TABLE x --");
	});
});

describe("what is refused", () => {
	test.each([
		["$lookup", { $lookup: { from: "a", as: "b" } }],
		["$facet", { $facet: {} }],
		["$bucket", { $bucket: {} }],
		["$graphLookup", { $graphLookup: {} }],
		["$unionWith", { $unionWith: "other" }],
		["$out", { $out: "other" }],
		["$merge", { $merge: {} }],
		["$setWindowFields", { $setWindowFields: {} }],
	])("%s raises naming the stage", (name, stage) => {
		expect(() => sql([stage as Document])).toThrow(
			new RegExp(`\\${name} is not implemented`),
		);
	});

	test("an unimplemented expression operator raises naming it", () => {
		expect(() => sql([{ $project: { x: { $dateToString: {} } } }])).toThrow(
			/\$dateToString is not implemented/,
		);
	});

	test("$type is refused rather than mapping SurrealDB's type names onto BSON's", () => {
		expect(() => sql([{ $project: { t: { $type: "$price" } } }])).toThrow(
			/\$type is not implemented/,
		);
	});

	test("$project cannot exclude a field other than _id", () => {
		expect(() => sql([{ $project: { cat: 0 } }])).toThrow(/cannot exclude cat/);
	});

	test("a stage document naming two stages is refused", () => {
		expect(() => sql([{ $limit: 1, $skip: 1 }])).toThrow(/exactly one field/);
	});

	test("$limit takes a non-negative whole number", () => {
		expect(() => sql([{ $limit: -1 }])).toThrow(/non-negative whole number/);
		expect(() => sql([{ $limit: 1.5 }])).toThrow(/non-negative whole number/);
	});

	test("$near inside $match is refused, since a stage cannot carry its ordering", () => {
		expect(() =>
			sql([
				{
					$match: {
						loc: {
							$near: { $geometry: { type: "Point", coordinates: [0, 0] } },
						},
					},
				},
			]),
		).toThrow(/\$near and \$nearSphere are not supported/);
	});
});
