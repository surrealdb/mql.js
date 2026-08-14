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

describe("$lookup", () => {
	const join = [
		{
			$lookup: {
				from: "people",
				localField: "who",
				foreignField: "code",
				as: "p",
			},
		},
	];

	test("binds the outer rows once rather than repeating the pipeline", () => {
		// The outer set is needed twice — to collect the keys and to read — and a
		// subquery in both places would evaluate the pipeline so far twice.
		const statement = sql(join);
		expect(statement).toStartWith("LET $mql_rows_0 = (SELECT * FROM `sales`)");
		expect(compile(join).isBatch).toBe(true);
	});

	test("gathers the foreign rows in one uncorrelated, indexable query", () => {
		// The whole point: `WHERE code IN $keys` uses an index, and the correlated
		// `WHERE code = $parent.who` it replaces does not.
		expect(sql(join)).toContain(
			"LET $mql_join_0 = (SELECT *, record::id(id) AS _id OMIT id FROM `people` WHERE `code` IN $mql_keys_0)",
		);
		// The scan itself must not be correlated; `$parent` may only appear later,
		// in the in-memory array filter.
		const scan = sql(join).split("; ")[2];
		expect(scan).toContain("LET $mql_join_0 =");
		expect(scan).not.toContain("$parent");
	});

	test("flattens and dedupes the keys", () => {
		expect(sql(join)).toContain(
			"array::distinct(array::flatten($mql_rows_0.`who`))",
		);
	});

	test("matches a scalar local field and any element of an array one", () => {
		const statement = sql(join);
		expect(statement).toContain("`code` = $parent.`who`");
		expect(statement).toContain(
			"type::is_array($parent.`who`) AND `code` IN $parent.`who`",
		);
	});

	test("answers an empty array when the foreign collection does not exist", () => {
		// SurrealDB refuses to read an undefined table, leaving the variable unset;
		// MongoDB answers a collection it has never seen as an empty one.
		expect(sql(join)).toContain("($mql_join_0 ?? [])[WHERE");
	});

	test("joining on the foreign _id builds record ids for the scan", () => {
		const statement = sql([
			{
				$lookup: {
					from: "people",
					localField: "who",
					foreignField: "_id",
					as: "p",
				},
			},
		]);
		expect(statement).toContain(
			"WHERE id IN $mql_keys_0.map(|$v| type::record('people', $v))",
		);
		// The array filter compares keys, because the projection already extracted them.
		expect(statement).toContain("`_id` = $parent.`who`");
	});

	test("two lookups do not share variables", () => {
		const statement = sql([
			{ $lookup: { from: "a", localField: "x", foreignField: "k", as: "ra" } },
			{ $lookup: { from: "b", localField: "y", foreignField: "k", as: "rb" } },
		]);
		expect(statement).toContain("$mql_join_0");
		expect(statement).toContain("$mql_join_1");
	});

	test("the joined field does not make _id a plain field", () => {
		// `SELECT *, … AS joined` keeps every column the rows had, `id` among them,
		// so a later sort on `_id` still means the record identity.
		expect(sql([...join, { $sort: { _id: 1 } }])).toContain("ORDER BY id ASC");
	});

	test("the pipeline/let form is refused", () => {
		expect(() =>
			sql([{ $lookup: { from: "a", let: {}, pipeline: [], as: "r" } }]),
		).toThrow(/`pipeline` or `let` is not implemented/);
	});

	test("a missing field is refused by name", () => {
		expect(() => sql([{ $lookup: { from: "a", as: "r" } }])).toThrow(
			/requires a non-empty string `localField`/,
		);
	});
});

describe("$addFields, $replaceRoot and $sortByCount", () => {
	test("$addFields extends the field list rather than replacing it", () => {
		expect(sql([{ $addFields: { n: 1 } }])).toBe(
			"SELECT *, $a0 AS `n` FROM `sales`",
		);
	});

	test("$set compiles identically", () => {
		expect(sql([{ $set: { n: 1 } }])).toBe(sql([{ $addFields: { n: 1 } }]));
	});

	test("$addFields does not make _id a plain field", () => {
		// It keeps every column, `id` among them, so a later sort still means the
		// record identity.
		expect(sql([{ $addFields: { n: 1 } }, { $sort: { _id: 1 } }])).toContain(
			"ORDER BY id ASC",
		);
	});

	test("$addFields after $group nests, and extends the subquery's rows", () => {
		// The bug this pins: reading the field list before claiming the slot took
		// the *closed* statement's aggregate list and re-emitted it over the
		// subquery already computing it.
		const statement = sql([
			{ $group: { _id: "$cat", total: { $sum: "$price" } } },
			{ $addFields: { doubled: { $multiply: ["$total", 2] } } },
		]);
		expect(
			depth([
				{ $group: { _id: "$cat", total: { $sum: "$price" } } },
				{ $addFields: { doubled: { $multiply: ["$total", 2] } } },
			]),
		).toBe(2);
		expect(statement).toStartWith(
			"SELECT *, (`total` * $a0) AS `doubled` FROM (",
		);
		expect(statement).not.toContain("math::sum($a0) AS `total`, (`total`");
	});

	test("$replaceRoot is a VALUE selection", () => {
		expect(sql([{ $replaceRoot: { newRoot: "$sub" } }])).toBe(
			"SELECT VALUE `sub` FROM `sales`",
		);
	});

	test("$replaceWith takes the expression directly", () => {
		expect(sql([{ $replaceWith: "$sub" }])).toBe(
			sql([{ $replaceRoot: { newRoot: "$sub" } }]),
		);
	});

	test("$replaceRoot without newRoot is refused", () => {
		expect(() => sql([{ $replaceRoot: {} }])).toThrow(/`newRoot` expression/);
	});

	test("$sortByCount is $group plus $sort, in one statement", () => {
		const statement = sql([{ $sortByCount: "$cat" }]);
		expect(statement).toContain("count() AS `count`");
		expect(statement).toContain("GROUP BY `_id`");
		expect(statement).toEndWith("ORDER BY `count` DESC");
		expect(depth([{ $sortByCount: "$cat" }])).toBe(1);
	});

	test("$addFields with no fields is refused", () => {
		expect(() => sql([{ $addFields: {} }])).toThrow(/at least one field/);
	});
});

describe("$facet", () => {
	const facet = [
		{
			$facet: {
				byCat: [{ $group: { _id: "$cat", n: { $sum: 1 } } }],
				top: [{ $limit: 2 }],
			},
		},
	];

	test("binds the input once and reads it from every branch", () => {
		// The point of binding rather than repeating a subquery: the branches must
		// see the same rows, and the pipeline before them must run once.
		const statement = sql(facet);
		expect(statement).toContain(
			"LET $mql_facet_in_0 = (SELECT * FROM `sales`)",
		);
		expect(statement.match(/FROM \$mql_facet_in_0/g) ?? []).toHaveLength(2);
	});

	test("each branch becomes its own bound statement", () => {
		const statement = sql(facet);
		expect(statement).toContain("LET $mql_facet_0_0 = (SELECT `cat` AS `_id`");
		expect(statement).toContain(
			"LET $mql_facet_0_1 = (SELECT * FROM $mql_facet_in_0 LIMIT 2)",
		);
	});

	test("answers from a one-row literal, so later stages can still fold", () => {
		expect(sql(facet)).toEndWith(
			'SELECT * FROM [{ "byCat": $mql_facet_0_0, "top": $mql_facet_0_1 }]',
		);
	});

	test("a later stage reads the facet document rather than nesting again", () => {
		const statement = sql([...facet, { $project: { n: { $size: "$byCat" } } }]);
		expect(statement).toContain('FROM [{ "byCat"');
		expect(statement).toContain("array::len(`byCat`)");
	});

	test("branches at the same index do not collide on a parameter", () => {
		// Both branches have a `$match` at index 0 of their own pipeline.
		const { bindings } = compile([
			{
				$facet: {
					a: [{ $match: { x: "left" } }],
					b: [{ $match: { x: "right" } }],
				},
			},
		]);
		expect(Object.values(bindings).sort()).toEqual(["left", "right"]);
	});

	test("a branch carrying a $lookup binds its variables before the branch", () => {
		const statement = sql([
			{
				$facet: {
					joined: [
						{
							$lookup: {
								from: "p",
								localField: "w",
								foreignField: "k",
								as: "j",
							},
						},
					],
				},
			},
		]);
		const joinLet = statement.indexOf("LET $mql_join_");
		const branchLet = statement.indexOf("LET $mql_facet_0_0");
		expect(joinLet).toBeGreaterThan(-1);
		expect(joinLet).toBeLessThan(branchLet);
	});

	test.each([
		["$facet"],
		["$out"],
		["$merge"],
		["$geoNear"],
	])("refuses %s inside a branch, as MongoDB does", (name) => {
		expect(() => sql([{ $facet: { a: [{ [name]: {} }] } }])).toThrow(
			new RegExp(`\\${name} cannot appear inside a \\$facet`),
		);
	});

	test("a branch that is not an array is refused", () => {
		expect(() => sql([{ $facet: { a: {} } }])).toThrow(
			/branch a must be an array of stages/,
		);
	});
});

describe("what is refused", () => {
	test.each([
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
