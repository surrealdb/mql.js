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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	SUPPORTED_STAGES,
	translatePipeline,
} from "../../src/translators/aggregate/index.ts";
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
			sql([{ $group: { _id: null, d: { $mergeObjects: "$price" } } }]),
		).toThrow(/\$mergeObjects is not implemented/);
	});

	test("$stdDevSamp is math::stddev, which is already the sample statistic", () => {
		expect(
			sql([{ $group: { _id: null, d: { $stdDevSamp: "$price" } } }]),
		).toContain("math::stddev(`price`) AS `d`");
	});

	test("$stdDevPop scales math::stddev by sqrt((n-1)/n), since SurrealDB has no population variant", () => {
		const statement = sql([
			{ $group: { _id: null, d: { $stdDevPop: "$price" } } },
		]);
		expect(statement).toContain("math::stddev(`price`)");
		expect(statement).toContain("<float>(count() - 1)");
		expect(statement).toContain("<float>count()");
	});

	test("$firstN/$lastN/$maxN/$minN take {input, n}", () => {
		expect(
			sql([
				{ $group: { _id: null, d: { $firstN: { input: "$price", n: 3 } } } },
			]),
		).toContain("array::slice(array::group(`price`), 0, 3) AS `d`");
		expect(
			sql([
				{ $group: { _id: null, d: { $lastN: { input: "$price", n: 3 } } } },
			]),
		).toContain("array::slice(array::group(`price`), -3) AS `d`");
		expect(
			sql([{ $group: { _id: null, d: { $maxN: { input: "$price", n: 3 } } } }]),
		).toContain(
			"array::slice(array::reverse(array::sort(array::group(`price`))), 0, 3) AS `d`",
		);
		expect(
			sql([{ $group: { _id: null, d: { $minN: { input: "$price", n: 3 } } } }]),
		).toContain(
			"array::slice(array::sort(array::group(`price`)), 0, 3) AS `d`",
		);
	});

	test("$firstN refuses a spec that isn't {input, n}", () => {
		expect(() =>
			sql([{ $group: { _id: null, d: { $firstN: "$price" } } }]),
		).toThrow(/takes a document of \{input, n\}/);
	});

	test("$firstN refuses a non-positive or fractional n", () => {
		expect(() =>
			sql([
				{ $group: { _id: null, d: { $firstN: { input: "$price", n: 0 } } } },
			]),
		).toThrow(/n must be a positive whole number/);
		expect(() =>
			sql([
				{
					$group: {
						_id: null,
						d: { $firstN: { input: "$price", n: 1.5 } },
					},
				},
			]),
		).toThrow(/n must be a positive whole number/);
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

describe("$graphLookup", () => {
	const walk = [
		{
			$graphLookup: {
				from: "staff",
				startWith: "$who",
				connectFromField: "who",
				connectToField: "mgr",
				as: "tree",
			},
		},
	];

	test("folds a breadth-first search rather than repeating a join", () => {
		const statement = sql(walk);
		expect(statement).toContain("array::reduce([{ d: 0, seen: []");
		expect(statement).toContain("array::concat($a.seen, $next)");
	});

	test("the predicate is uncorrelated, so it keeps the index", () => {
		// The correlation is in the seed only. `WHERE mgr IN $a.front` plans as an
		// IndexScan; the `$parent`-correlated predicate `$lookup` avoids does not.
		const statement = sql(walk);
		expect(statement).toContain("WHERE `mgr` IN $a.front");
		expect(statement).not.toContain("`mgr` = $parent");
	});

	test("guards against revisiting, which is what ends a cycle", () => {
		expect(sql(walk)).toContain("record::id(id) NOT IN $a.seen.`_id`");
	});

	test("flattens and dedupes both the seed and the frontier", () => {
		const statement = sql(walk);
		expect(statement).toContain("array::distinct(array::flatten([`who`]))");
		expect(statement).toContain("array::distinct(array::flatten($next.`who`))");
	});

	test("maxDepth decides how many steps are emitted", () => {
		// MongoDB counts the first level as depth 0, so maxDepth 0 is one step.
		expect(
			sql([
				{ ...walk[0], $graphLookup: { ...walk[0].$graphLookup, maxDepth: 0 } },
			]),
		).toContain("}, 0], |$a, $v|");
		expect(
			sql([
				{ ...walk[0], $graphLookup: { ...walk[0].$graphLookup, maxDepth: 2 } },
			]),
		).toContain("}, 0, 1, 2], |$a, $v|");
	});

	test("depthField is only selected when it was asked for", () => {
		expect(sql(walk)).not.toContain("AS `lvl`");
		expect(
			sql([
				{
					...walk[0],
					$graphLookup: { ...walk[0].$graphLookup, depthField: "lvl" },
				},
			]),
		).toContain("$a.d AS `lvl`");
	});

	test("the traversed field does not make _id a plain field", () => {
		// `SELECT *, … AS tree` keeps every column the rows had, `id` among them.
		expect(sql([...walk, { $sort: { _id: 1 } }])).toContain("ORDER BY id ASC");
	});

	test("a maxDepth beyond the emitted cap is refused rather than truncated", () => {
		expect(() =>
			sql([
				{
					...walk[0],
					$graphLookup: { ...walk[0].$graphLookup, maxDepth: 999 },
				},
			]),
		).toThrow(/must be below 64/);
	});

	test("a missing field is refused by name", () => {
		expect(() => sql([{ $graphLookup: { from: "a", as: "b" } }])).toThrow(
			/requires a non-empty string `connectFromField`/,
		);
	});
});

describe("the refusal names what is actually supported", () => {
	/**
	 * The message drifted once already: it kept listing stages by hand and fell two
	 * behind the switch, telling callers `$facet` and `$graphLookup` were
	 * unavailable after both had shipped. These assert the list and the router
	 * agree in both directions, which is the thing that stays true.
	 */
	test("every stage it names is one the translator accepts", () => {
		for (const stage of SUPPORTED_STAGES) {
			// A stage the router does not know raises "is not implemented"; every one
			// listed must fail some *other* way, or not at all.
			let message = "";
			try {
				sql([{ [stage]: {} } as Document]);
			} catch (error) {
				message = (error as Error).message;
			}
			expect(message).not.toContain("is not implemented");
		}
	});

	test("it names every stage the router actually handles", () => {
		// The direction that drifted: `$facet` and `$graphLookup` were routed and not
		// listed, so callers were told they did not work. Asserting the list against
		// the message would never have caught that — the message is built from the
		// list. Only the router settles it.
		const source = readFileSync(
			join(
				import.meta.dirname,
				"..",
				"..",
				"src",
				"translators",
				"aggregate",
				"index.ts",
			),
			"utf8",
		);
		const routed = [...source.matchAll(/^\t\tcase "(\$[a-zA-Z]+)":/gm)].map(
			(match) => match[1],
		);

		expect(routed.length).toBeGreaterThan(10);
		expect([...routed].sort()).toEqual([...SUPPORTED_STAGES].sort());
	});

	test("a stage it does not name is refused, and the message lists the rest", () => {
		let message = "";
		try {
			sql([{ $bucketAuto: {} }]);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("$bucketAuto is not implemented");
		for (const stage of SUPPORTED_STAGES) {
			expect(message).toContain(stage);
		}
	});
});

describe("$dateToString", () => {
	const fmt = (format: string) =>
		sql([{ $project: { d: { $dateToString: { date: "$when", format } } } }]);

	test("maps MongoDB's milliseconds onto the spelling chrono takes", () => {
		// `%L` is the one specifier SurrealDB rejects outright, so it has to be
		// translated rather than passed through.
		expect(
			compile([
				{ $project: { d: { $dateToString: { date: "$when", format: "%L" } } } },
			]).bindings.a0,
		).toBe("%3f");
	});

	test("passes through the specifiers that mean the same thing", () => {
		expect(
			compile([
				{
					$project: {
						d: { $dateToString: { date: "$when", format: "%Y-%m-%d" } },
					},
				},
			]).bindings.a0,
		).toBe("%Y-%m-%d");
	});

	test("refuses %w, which would render a number wrong by one", () => {
		expect(() => fmt("%w")).toThrow(/does not support %w/);
	});

	test("refuses an unknown specifier rather than emitting it", () => {
		expect(() => fmt("%Q")).toThrow(/does not support %Q/);
	});

	test("refuses a trailing lone percent", () => {
		expect(() => fmt("%Y%")).toThrow(/lone %/);
	});

	test("refuses timezone and onNull rather than ignoring them", () => {
		expect(() =>
			sql([
				{
					$project: {
						d: { $dateToString: { date: "$w", format: "%Y", timezone: "UTC" } },
					},
				},
			]),
		).toThrow(/timezone` is not supported/);
		expect(() =>
			sql([
				{
					$project: {
						d: { $dateToString: { date: "$w", format: "%Y", onNull: "-" } },
					},
				},
			]),
		).toThrow(/onNull` is not supported/);
	});
});

describe("$reduce", () => {
	test("prepends initialValue and folds with a two-parameter closure", () => {
		const statement = sql([
			{
				$project: {
					d: {
						$reduce: {
							input: "$arr",
							initialValue: 0,
							in: { $add: ["$$value", "$$this"] },
						},
					},
				},
			},
		]);
		expect(statement).toContain(
			"array::reduce(array::concat([$a0], `arr`), |$mql_v0, $mql_v1| ($mql_v0 + $mql_v1))",
		);
	});

	test("requires input, initialValue and in", () => {
		expect(() =>
			sql([{ $project: { d: { $reduce: { input: "$arr" } } } }]),
		).toThrow(/requires `input`, `initialValue` and `in`/);
	});
});

describe("$objectToArray and $arrayToObject", () => {
	test("$objectToArray maps object::entries' pairs into {k, v} docs", () => {
		expect(sql([{ $project: { d: { $objectToArray: "$obj" } } }])).toContain(
			"array::map(object::entries(`obj`), |$mql_v0| { k: $mql_v0[0], v: $mql_v0[1] })",
		);
	});

	test("$arrayToObject accepts either shape at runtime via type::is_array", () => {
		expect(sql([{ $project: { d: { $arrayToObject: "$pairs" } } }])).toContain(
			"object::from_entries(array::map(`pairs`, |$mql_v0| IF type::is_array($mql_v0) THEN $mql_v0 ELSE [$mql_v0.k, $mql_v0.v] END))",
		);
	});
});

describe("the $set family", () => {
	test("$setUnion folds array::union, which already de-duplicates", () => {
		expect(sql([{ $project: { d: { $setUnion: ["$a", "$b"] } } }])).toContain(
			"array::union(`a`, `b`)",
		);
	});

	test("$setUnion of one array is just array::distinct", () => {
		expect(sql([{ $project: { d: { $setUnion: ["$a"] } } }])).toContain(
			"array::distinct(`a`)",
		);
	});

	test("$setIntersection folds array::intersect", () => {
		expect(
			sql([{ $project: { d: { $setIntersection: ["$a", "$b", "$c"] } } }]),
		).toContain("array::intersect(array::intersect(`a`, `b`), `c`)");
	});

	test("$setDifference wraps array::complement in array::distinct", () => {
		expect(
			sql([{ $project: { d: { $setDifference: ["$a", "$b"] } } }]),
		).toContain("array::distinct(array::complement(`a`, `b`))");
	});

	test("$setDifference takes exactly two arrays", () => {
		expect(() =>
			sql([{ $project: { d: { $setDifference: ["$a"] } } }]),
		).toThrow(/exactly 2 arguments/);
	});

	test("$setEquals compares sorted, distinct elements", () => {
		expect(sql([{ $project: { d: { $setEquals: ["$a", "$b"] } } }])).toContain(
			"(array::sort(array::distinct(`a`)) = array::sort(array::distinct(`b`)))",
		);
	});

	test("$setIsSubset reads as b CONTAINSALL a", () => {
		expect(
			sql([{ $project: { d: { $setIsSubset: ["$a", "$b"] } } }]),
		).toContain("(`b` CONTAINSALL `a`)");
	});
});

describe("$dateAdd, $dateDiff and $dateTrunc", () => {
	test("$dateAdd branches on the sign, since durations are unsigned", () => {
		const statement = sql([
			{
				$project: {
					d: { $dateAdd: { startDate: "$when", unit: "hour", amount: 5 } },
				},
			},
		]);
		expect(statement).toContain("IF $a0 >= 0 THEN");
		expect(statement).toContain("<duration>(<string>($a0)");
		expect(statement).toContain("<duration>(<string>(math::abs($a0))");
	});

	test("$dateAdd refuses a calendar unit and names why", () => {
		expect(() =>
			sql([
				{
					$project: {
						d: { $dateAdd: { startDate: "$when", unit: "month", amount: 1 } },
					},
				},
			]),
		).toThrow(/length in days varies/);
	});

	test("$dateAdd refuses timezone", () => {
		expect(() =>
			sql([
				{
					$project: {
						d: {
							$dateAdd: {
								startDate: "$when",
								unit: "hour",
								amount: 1,
								timezone: "UTC",
							},
						},
					},
				},
			]),
		).toThrow(/timezone` is not supported/);
	});

	test("$dateDiff branches on direction and negates duration::<unit> for the reverse", () => {
		const statement = sql([
			{
				$project: {
					d: {
						$dateDiff: { startDate: "$a", endDate: "$b", unit: "hour" },
					},
				},
			},
		]);
		expect(statement).toContain(
			"(IF `b` >= `a` THEN duration::hours(`b` - `a`) ELSE -duration::hours(`a` - `b`) END) AS `d`",
		);
	});

	test("$dateDiff refuses week, since it needs startOfWeek to mean anything", () => {
		expect(() =>
			sql([
				{
					$project: {
						d: { $dateDiff: { startDate: "$a", endDate: "$b", unit: "week" } },
					},
				},
			]),
		).toThrow(/needs startOfWeek/);
	});

	test("$dateTrunc floors rather than rounds", () => {
		expect(
			sql([
				{ $project: { d: { $dateTrunc: { date: "$when", unit: "hour" } } } },
			]),
		).toContain("time::floor(`when`, <duration>(<string>(1) + $a0))");
	});

	test("$dateTrunc's binSize multiplies the unit", () => {
		expect(
			sql([
				{
					$project: {
						d: {
							$dateTrunc: {
								date: "$when",
								unit: "minute",
								binSize: 15,
							},
						},
					},
				},
			]),
		).toContain("<duration>(<string>($a0) + $a1)");
	});

	test("$dateTrunc refuses startOfWeek", () => {
		expect(() =>
			sql([
				{
					$project: {
						d: {
							$dateTrunc: {
								date: "$when",
								unit: "hour",
								startOfWeek: "monday",
							},
						},
					},
				},
			]),
		).toThrow(/startOfWeek` is not supported/);
	});
});

describe("$replaceAll", () => {
	test("maps directly to string::replace", () => {
		expect(
			sql([
				{
					$project: {
						d: {
							$replaceAll: { input: "$s", find: ".", replacement: "-" },
						},
					},
				},
			]),
		).toContain("string::replace(`s`, $a0, $a1)");
	});

	test("requires input, find and replacement", () => {
		expect(() =>
			sql([{ $project: { d: { $replaceAll: { input: "$s" } } } }]),
		).toThrow(/requires `input`, `find` and `replacement`/);
	});
});

describe("$convert", () => {
	test("maps to string, bool, int and double the same casts $toString etc. use", () => {
		expect(
			sql([{ $project: { d: { $convert: { input: "$s", to: "int" } } } }]),
		).toContain("<int>(`s`)");
	});

	test("refuses a target with no cast this driver implements", () => {
		expect(() =>
			sql([{ $project: { d: { $convert: { input: "$s", to: "objectId" } } } }]),
		).toThrow(/has no SurrealQL cast this driver implements/);
	});

	test("refuses onError and onNull, since SurrealQL has no try/catch", () => {
		expect(() =>
			sql([
				{
					$project: {
						d: { $convert: { input: "$s", to: "int", onError: 0 } },
					},
				},
			]),
		).toThrow(/onError` is not supported/);
		expect(() =>
			sql([
				{
					$project: {
						d: { $convert: { input: "$s", to: "int", onNull: 0 } },
					},
				},
			]),
		).toThrow(/onNull` is not supported/);
	});
});

describe("$let", () => {
	test("substitutes the variable into the body", () => {
		expect(
			sql([
				{
					$project: {
						x: { $let: { vars: { a: "$price" }, in: { $add: ["$$a", 1] } } },
					},
				},
			]),
		).toContain("((`price`) + $a0)");
	});

	test("one var cannot see another, as in MongoDB", () => {
		// Each `vars` entry compiles in the scope outside the $let, so `$$a` inside
		// `b` is not the `a` being defined beside it.
		expect(() =>
			sql([
				{
					$project: {
						x: {
							$let: {
								vars: { a: "$price", b: { $add: ["$$a", 1] } },
								in: "$$b",
							},
						},
					},
				},
			]),
		).toThrow(/system variable \$\$a is not implemented/);
	});

	test("requires vars and in", () => {
		expect(() => sql([{ $project: { x: { $let: { vars: {} } } } }])).toThrow(
			/requires `in`/,
		);
	});
});

describe("$bucket", () => {
	const bucket = (extra: Document = {}) =>
		sql([
			{
				$bucket: {
					groupBy: "$price",
					boundaries: [0, 10, 20],
					default: "other",
					...extra,
				},
			},
		]);

	test("is a group over a switch, and sorts by the lower bound", () => {
		const statement = bucket();
		expect(statement).toContain("GROUP BY `_id`");
		expect(statement).toContain("IF ");
		expect(statement).toEndWith("ORDER BY `_id` ASC");
	});

	test("counts by default, and honours a custom output", () => {
		expect(bucket()).toContain("count() AS `count`");
		expect(bucket({ output: { total: { $sum: "$price" } } })).toContain(
			"math::sum(`price`) AS `total`",
		);
	});

	test("refuses a missing default, which MongoDB fails on at run time", () => {
		expect(() =>
			sql([{ $bucket: { groupBy: "$price", boundaries: [0, 10] } }]),
		).toThrow(/requires `default`/);
	});

	test("refuses fewer than two boundaries, which would make no bucket", () => {
		expect(() =>
			sql([{ $bucket: { groupBy: "$p", boundaries: [0], default: "x" } }]),
		).toThrow(/at least two values/);
	});
});

describe("$project and $unset exclusion", () => {
	test("excludes any number of fields, keeping _id", () => {
		const statement = sql([{ $project: { secret: 0, extra: 0 } }]);
		expect(statement).toBe("SELECT * OMIT `secret`, `extra` FROM `sales`");
	});

	test("excludes _id alongside other fields", () => {
		expect(sql([{ $project: { secret: 0, _id: 0 } }])).toBe(
			"SELECT * OMIT `secret`, id FROM `sales`",
		);
	});

	test("{$project: {_id: 0}} alone omits only the identity", () => {
		expect(sql([{ $project: { _id: 0 } }])).toBe(
			"SELECT * OMIT id FROM `sales`",
		);
	});

	test("{$project: {_id: 1}} alone is inclusion of _id only, not *", () => {
		// The case the exclusion branch must not swallow: naming only `_id` with a
		// truthy value means "the document is just `_id`", not "nothing was
		// excluded, keep everything".
		expect(sql([{ $project: { _id: 1 } }])).toBe(
			"SELECT id AS `_id` FROM `sales`",
		);
	});

	test("does not reshape: _id keeps meaning the record identity afterwards", () => {
		// The bug this replaces: exclusion used to be marked reshaped
		// unconditionally, so `{$project: {_id: 0}}` OMITted a column called
		// `_id` — which does not exist on a stored row, the column is `id` — and
		// excluded nothing at all.
		const statement = sql([{ $project: { secret: 0 } }, { $sort: { _id: 1 } }]);
		expect(statement).toContain("ORDER BY id ASC");
	});

	test("$unset takes a single field name", () => {
		expect(sql([{ $unset: "secret" }])).toBe(
			"SELECT * OMIT `secret` FROM `sales`",
		);
	});

	test("$unset takes an array of field names, _id included", () => {
		expect(sql([{ $unset: ["secret", "_id"] }])).toBe(
			"SELECT * OMIT `secret`, id FROM `sales`",
		);
	});

	test("$unset does not reshape either", () => {
		expect(sql([{ $unset: "secret" }, { $sort: { _id: 1 } }])).toContain(
			"ORDER BY id ASC",
		);
	});

	test("an exclusion after $group omits the literal _id column, not id", () => {
		const statement = sql([
			{ $group: { _id: "$cat", n: { $sum: 1 } } },
			{ $unset: "n" },
		]);
		expect(statement).toContain("OMIT `n`");
	});

	test("$project still refuses mixing inclusion and exclusion", () => {
		expect(() => sql([{ $project: { name: 1, secret: 0 } }])).toThrow(
			/cannot exclude secret in an inclusion projection/,
		);
	});

	test("$unset refuses an empty array, and an empty string", () => {
		expect(() => sql([{ $unset: [] }])).toThrow(/non-empty field name/);
		expect(() => sql([{ $unset: [""] }])).toThrow(/non-empty field name/);
	});
});

describe("$sample", () => {
	test("orders by rand() and limits", () => {
		expect(sql([{ $sample: { size: 5 } }])).toBe(
			"SELECT * FROM `sales` ORDER BY rand() LIMIT 5",
		);
	});

	test("refuses a non-numeric size", () => {
		expect(() => sql([{ $sample: { size: "5" } }])).toThrow(
			/document with a numeric `size`/,
		);
	});
});

describe("$out and $merge, at the translator", () => {
	// $out/$merge write, and the translator never touches the executor — they are
	// handled one layer up, in `executeAggregate`, which strips a *trailing*
	// $out/$merge before the translator ever sees it. Calling the translator
	// directly, as `sql()` does, therefore never reaches a case where either
	// stage can succeed: from its own point of view every stage must be handled
	// or refused, and there is no SQL a $out/$merge-terminated pipeline compiles
	// to. What these tests pin is the one thing the translator can say about
	// them: naming the stage and the position rule, which is real regardless of
	// where the stage sits — see `tests/integration/aggregate.test.ts` for the
	// stage actually working when it is last.
	test("both are named in the supported list", () => {
		expect(SUPPORTED_STAGES).toContain("$out");
		expect(SUPPORTED_STAGES).toContain("$merge");
	});

	test("refuses $out before a later stage, naming the rule", () => {
		expect(() => sql([{ $out: "copy" }, { $match: {} }])).toThrow(
			/\$out must be the final stage/,
		);
	});

	test("refuses $merge before a later stage", () => {
		expect(() => sql([{ $merge: "copy" }, { $match: {} }])).toThrow(
			/\$merge must be the final stage/,
		);
	});
});

describe("what is refused", () => {
	test.each([
		["$unionWith", { $unionWith: "other" }],
		["$setWindowFields", { $setWindowFields: {} }],
	])("%s raises naming the stage", (name, stage) => {
		expect(() => sql([stage as Document])).toThrow(
			new RegExp(`\\${name} is not implemented`),
		);
	});

	test("an unimplemented expression operator raises naming it", () => {
		expect(() => sql([{ $project: { x: { $dateFromString: {} } } }])).toThrow(
			/\$dateFromString is not implemented/,
		);
	});

	test("$type is refused rather than mapping SurrealDB's type names onto BSON's", () => {
		expect(() => sql([{ $project: { t: { $type: "$price" } } }])).toThrow(
			/\$type is not implemented/,
		);
	});

	test("$project mixing an inclusion and an exclusion is refused", () => {
		// A pure exclusion is fine now — see the "$project and $unset exclusion"
		// block below. What MongoDB actually forbids is mixing the two modes.
		expect(() => sql([{ $project: { name: 1, cat: 0 } }])).toThrow(
			/cannot exclude cat in an inclusion projection/,
		);
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
