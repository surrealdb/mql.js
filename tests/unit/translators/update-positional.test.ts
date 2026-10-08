/**
 * The SurrealQL a positional update (`$[]`, `$[identifier]`) compiles to.
 *
 * It is a rewrite of the array, one element at a time, and not a path
 * expression: `grades[*].score` evaluates to the *list* of every element's
 * `score`, so `$inc` through it appended to that list and `$mul` failed outright.
 * `positional.ts` explains the shape; these pin it, and the SQL is written out in
 * full rather than composed from helpers so that a change to any part of it is a
 * diff in this file. What the shapes are chosen for is measured against a real
 * server in `tests/integration/update-operators.test.ts` and against a real
 * `mongod` in `tests/e2e/scenarios/crud-scenarios.ts`.
 */

import { describe, expect, test } from "bun:test";
import {
	MongoCompatibilityError,
	MongoInvalidArgumentError,
} from "../../../src/errors.ts";
import { V3Dialect } from "../../../src/translators/dialect/v3-dialect.ts";
import { translateUpdate } from "../../../src/translators/update.ts";

const ITEM = "$__mql_item0";

/** The guard on the array being one, and the closure over its elements. */
const rewrite = (array: string, body: string) =>
	`SET ${array} = IF type::is_array(${array}) THEN array::map(${array}, |${ITEM}| ${body}) ELSE ${array} END`;

/** An element is a document, or the update is refused; `extend` is what it becomes. */
const document = (body: string, message: string) =>
	`IF type::is_object(${ITEM}) THEN ${body} ELSE { THROW $${message} } END`;

const notADocument = (path: string) =>
	`Cannot create a field in an array element that is not a document, for the path '${path}'`;

describe("positional $inc and $mul", () => {
	test("$inc creates an absent field at the increment, from the element as it was", () => {
		const { clause, bindings } = translateUpdate({ $inc: { "v.$[].n": 1 } });
		expect(clause).toBe(
			rewrite(
				"`v`",
				document(
					`object::extend(${ITEM}, {\`n\`: IF ${ITEM}.\`n\` IS NONE THEN $p0 ELSE ${ITEM}.\`n\` + $p0 END})`,
					"p1",
				),
			),
		);
		expect(bindings).toEqual({ p0: 1, p1: notADocument("v.$[].n") });
	});

	test("$mul sets an absent field to zero, as there was nothing to multiply", () => {
		const { clause } = translateUpdate({ $mul: { "v.$[].n": 2 } });
		expect(clause).toContain(
			`{\`n\`: IF ${ITEM}.\`n\` IS NONE THEN 0 ELSE ${ITEM}.\`n\` * $p0 END}`,
		);
	});

	test("an element that is itself the number is incremented in place", () => {
		const { clause, bindings } = translateUpdate({ $inc: { "v.$[]": 1 } });
		expect(clause).toBe(
			rewrite("`v`", `IF ${ITEM} IS NONE THEN $p0 ELSE ${ITEM} + $p0 END`),
		);
		expect(bindings).toEqual({ p0: 1 });
	});

	test("an element that is the number is multiplied in place", () => {
		const { clause } = translateUpdate({ $mul: { "v.$[]": 2 } });
		expect(clause).toContain(
			`IF ${ITEM} IS NONE THEN 0 ELSE ${ITEM} * $p0 END`,
		);
	});
});

describe("positional $min and $max", () => {
	test("$min writes the candidate when it is lower, or when there is nothing", () => {
		const { clause } = translateUpdate({ $min: { "v.$[].n": 3 } });
		expect(clause).toContain(
			`{\`n\`: IF ${ITEM}.\`n\` IS NONE OR $p0 < ${ITEM}.\`n\` THEN $p0 ELSE ${ITEM}.\`n\` END}`,
		);
	});

	test("$max writes the candidate when it is higher", () => {
		const { clause } = translateUpdate({ $max: { "v.$[].n": 3 } });
		expect(clause).toContain(
			`{\`n\`: IF ${ITEM}.\`n\` IS NONE OR $p0 > ${ITEM}.\`n\` THEN $p0 ELSE ${ITEM}.\`n\` END}`,
		);
	});
});

describe("positional $set, $unset and $currentDate", () => {
	// These are folded as well, though the path form would do for them alone: a
	// `$set` beside an `$inc` on the same array must be part of the same rewrite.
	test("$set", () => {
		const { clause } = translateUpdate({ $set: { "v.$[].n": 9 } });
		expect(clause).toBe(
			rewrite("`v`", document(`object::extend(${ITEM}, {\`n\`: $p0})`, "p1")),
		);
	});

	test("$unset removes the field, and an absent one is no change", () => {
		const { clause, bindings } = translateUpdate({ $unset: { "v.$[].n": "" } });
		expect(clause).toBe(
			rewrite("`v`", document(`object::remove(${ITEM}, [$p1])`, "p0")),
		);
		expect(bindings.p1).toBe("n");
	});

	test("$unset of the element itself leaves a null, as MongoDB does", () => {
		expect(translateUpdate({ $unset: { "v.$[]": "" } }).clause).toBe(
			rewrite("`v`", "NULL"),
		);
	});

	test("$set of the element itself replaces it", () => {
		expect(translateUpdate({ $set: { "v.$[]": 0 } }).clause).toBe(
			rewrite("`v`", "$p0"),
		);
	});

	test("$currentDate", () => {
		const { clause } = translateUpdate({ $currentDate: { "v.$[].at": true } });
		expect(clause).toContain(`{\`at\`: time::now()}`);
	});
});

describe("positional array operators", () => {
	test("$push creates the array when the field is absent", () => {
		const { clause, bindings } = translateUpdate({ $push: { "v.$[].t": "z" } });
		expect(clause).toContain(
			`{\`t\`: array::concat(IF ${ITEM}.\`t\` IS NONE THEN [] ELSE ${ITEM}.\`t\` END, [$p0])}`,
		);
		expect(bindings.p0).toBe("z");
	});

	test("$push with modifiers builds from the same starting array", () => {
		const { clause } = translateUpdate({
			$push: {
				"v.$[].t": { $each: [8, 9], $position: 1, $sort: 1, $slice: 3 },
			},
		});
		const start = `IF ${ITEM}.\`t\` IS NONE THEN [] ELSE ${ITEM}.\`t\` END`;
		expect(clause).toContain(
			`{\`t\`: array::slice(array::sort::asc(array::concat(array::concat(array::slice(${start}, 0, $p1), $p0), array::slice(${start}, $p1))), 0, $p2)}`,
		);
	});

	test("$addToSet", () => {
		const { clause } = translateUpdate({
			$addToSet: { "v.$[].t": { $each: [1, 2] } },
		});
		expect(clause).toContain(
			`{\`t\`: array::union(IF ${ITEM}.\`t\` IS NONE THEN [] ELSE ${ITEM}.\`t\` END, $p0)}`,
		);
	});

	test("$pop leaves an absent field absent", () => {
		const { clause } = translateUpdate({ $pop: { "v.$[].t": -1 } });
		expect(clause).toContain(
			`{\`t\`: IF type::is_array(${ITEM}.\`t\`) THEN array::slice(${ITEM}.\`t\`, 1) ELSE ${ITEM}.\`t\` END}`,
		);
		expect(translateUpdate({ $pop: { "v.$[].t": 1 } }).clause).toContain(
			`array::slice(${ITEM}.\`t\`, 0, array::len(${ITEM}.\`t\`) - 1)`,
		);
	});

	test("$pull by value", () => {
		const { clause } = translateUpdate({ $pull: { "v.$[].t": "a" } });
		expect(clause).toContain(
			`{\`t\`: IF type::is_array(${ITEM}.\`t\`) THEN ${ITEM}.\`t\` - [$p0] ELSE ${ITEM}.\`t\` END}`,
		);
	});

	test("$pull by condition", () => {
		const { clause } = translateUpdate({ $pull: { "v.$[].t": { $gt: 4 } } });
		expect(clause).toContain(
			`THEN ${ITEM}.\`t\`[WHERE !(((type::is_number(($this)) AND ($this) <= math::inf AND ($this) > $p0)`,
		);
	});

	test("$pullAll", () => {
		const { clause } = translateUpdate({ $pullAll: { "v.$[].t": ["a"] } });
		expect(clause).toContain(
			`{\`t\`: IF type::is_array(${ITEM}.\`t\`) THEN array::complement(${ITEM}.\`t\`, $p0) ELSE ${ITEM}.\`t\` END}`,
		);
	});
});

describe("positional updates to one array are one rewrite", () => {
	// Every assignment in a `SET` is evaluated against the document as it was
	// before the statement, so two that each rewrote `v` would not compose.
	test("two operators on the same elements", () => {
		const { clause } = translateUpdate(
			{ $inc: { "v.$[e].n": 1 }, $set: { "v.$[e].f": true } },
			0,
			{ arrayFilters: [{ "e.s": 1 }] },
		);
		expect(clause.match(/array::map\(`v`/g)).toHaveLength(1);
		expect(clause).toContain(
			`object::extend(${ITEM}, {\`n\`: IF ${ITEM}.\`n\` IS NONE THEN $p0 ELSE ${ITEM}.\`n\` + $p0 END, \`f\`: $p1})`,
		);
	});

	test("the elements are selected once, by what they were", () => {
		// `e.n` is tested on the element before either field is written.
		const { clause } = translateUpdate(
			{ $inc: { "v.$[e].n": 1, "v.$[e].m": 1 } },
			0,
			{ arrayFilters: [{ "e.n": { $lt: 6 } }] },
		);
		expect(clause.match(/\|\$__mql_item0\|/g)).toHaveLength(1);
		expect(clause).toContain(`IF ((type::is_number(${ITEM}.\`n\`)`);
	});

	test("two arrays are two assignments, each from the original document", () => {
		const { clause } = translateUpdate({
			$inc: { "v.$[].n": 1, "w.$[].m": 1 },
		});
		expect(clause.match(/array::map\(`v`/g)).toHaveLength(1);
		expect(clause.match(/array::map\(`w`/g)).toHaveLength(1);
		expect(clause).toContain("SET `v` = IF");
		expect(clause).toContain(", `w` = IF");
	});

	test("two identifiers on one array are applied one after the other", () => {
		const { clause } = translateUpdate(
			{ $inc: { "v.$[a].n": 1, "v.$[b].s": 10 } },
			0,
			{ arrayFilters: [{ "a.s": 1 }, { "b.s": { $gte: 2 } }] },
		);
		expect(clause).toStartWith(
			"SET `v` = IF type::is_array(`v`) THEN array::map(array::map(`v`, |$__mql_item0| IF $__mql_item0.`s` = ",
		);
	});

	test("$[] and $[identifier] together", () => {
		const { clause } = translateUpdate(
			{ $inc: { "v.$[].n": 1, "v.$[e].s": 10 } },
			0,
			{ arrayFilters: [{ "e.s": 1 }] },
		);
		expect(clause).toContain(
			"array::map(array::map(`v`, |$__mql_item0| IF type::is_object($__mql_item0) THEN object::extend($__mql_item0, {`n`:",
		);
	});

	test("plain paths are left as they were", () => {
		expect(translateUpdate({ $inc: { n: 1 } }).clause).toBe("SET `n` += $p0");
		expect(
			translateUpdate({ $inc: { n: 1, "v.$[].m": 1 } }).clause,
		).toStartWith("SET `n` += $p0, `v` = IF");
	});
});

describe("positional paths: where the array is, and what is inside the element", () => {
	test("an array reached through an object", () => {
		expect(translateUpdate({ $inc: { "o.v.$[].n": 1 } }).clause).toStartWith(
			"SET `o`.`v` = IF type::is_array(`o`.`v`) THEN array::map(`o`.`v`,",
		);
	});

	test("an array reached through an index", () => {
		expect(translateUpdate({ $inc: { "v.0.w.$[].n": 1 } }).clause).toStartWith(
			"SET `v`[0].`w` = IF type::is_array(`v`[0].`w`) THEN array::map(`v`[0].`w`,",
		);
	});

	test("a path inside the element creates the objects along it", () => {
		const { clause } = translateUpdate({ $inc: { "v.$[].a.b": 2 } });
		expect(clause).toContain(
			`{\`a\`: object::extend(IF ${ITEM}.\`a\` IS NONE THEN {} ELSE ${ITEM}.\`a\` END, {\`b\`: IF ${ITEM}.\`a\`.\`b\` IS NONE THEN $p0 ELSE ${ITEM}.\`a\`.\`b\` + $p0 END})}`,
		);
	});

	test("a path that only removes does not create the objects along it", () => {
		const { clause } = translateUpdate({ $unset: { "v.$[].a.b": "" } });
		expect(clause).toContain(
			`IF type::is_object(${ITEM}.\`a\`) THEN object::extend(${ITEM}, {\`a\`: object::remove(${ITEM}.\`a\`, [$p1])}) ELSE ${ITEM} END`,
		);
	});

	test("an array inside the element is rewritten in its own closure", () => {
		const { clause } = translateUpdate({ $inc: { "v.$[a].w.$[b].n": 1 } }, 0, {
			arrayFilters: [{ "a.k": 1 }, { "b.s": { $gte: 2 } }],
		});
		expect(clause).toContain(
			"IF type::is_array($__mql_item0.`w`) THEN object::extend($__mql_item0, {`w`: array::map($__mql_item0.`w`, |$__mql_item1| IF ",
		);
		expect(clause).toContain(
			"{`n`: IF $__mql_item1.`n` IS NONE THEN $p0 ELSE $__mql_item1.`n` + $p0 END}",
		);
	});

	test("an array that is absent inside the element is left absent", () => {
		const { clause } = translateUpdate({ $inc: { "v.$[].w.$[].n": 1 } });
		expect(clause).toContain(
			"IF type::is_array($__mql_item0.`w`) THEN object::extend($__mql_item0, {`w`: array::map(",
		);
		expect(clause).toContain("ELSE $__mql_item0 END");
	});

	test("an element that is not a document is refused when a path goes inside it", () => {
		// MongoDB: "Cannot create field 'n' in element {0: 1}".
		const { clause, bindings } = translateUpdate({ $inc: { "v.$[].n": 1 } });
		expect(clause).toContain("ELSE { THROW $p1 } END");
		expect(bindings.p1).toBe(notADocument("v.$[].n"));
	});

	test("the type predicates come from the dialect", () => {
		class Renamed extends V3Dialect {
			override typeCheckFn(bson: string | number): string | undefined {
				return super.typeCheckFn(bson)?.replace("type::is_", "type::is::");
			}
		}
		const { clause } = translateUpdate({ $inc: { "v.$[].n": 1 } }, 0, {
			dialect: new Renamed(),
		});
		expect(clause).toContain("type::is::array(`v`)");
		expect(clause).toContain("type::is::object($__mql_item0)");
		expect(clause).not.toContain("type::is_");
	});
});

describe("what MongoDB refuses is refused", () => {
	test("two operators on one path", () => {
		expect(() =>
			translateUpdate({ $inc: { "v.$[].n": 1 }, $set: { "v.$[].n": 9 } }),
		).toThrow(
			"Updating the path 'v.$[].n' would create a conflict at 'v.$[].n'",
		);
		expect(() =>
			translateUpdate({ $inc: { "v.$[].n": 1 }, $mul: { "v.$[].n": 2 } }),
		).toThrow(MongoInvalidArgumentError);
	});

	test("a path and one inside it", () => {
		expect(() =>
			translateUpdate({
				$set: { "v.$[].a": 1 },
				$inc: { "v.$[].a.b": 1 },
			}),
		).toThrow("would create a conflict at 'v.$[].a'");
		expect(() =>
			translateUpdate({
				$inc: { "v.$[].a.b": 1 },
				$set: { "v.$[].a": 1 },
			}),
		).toThrow(MongoInvalidArgumentError);
	});

	test("$rename through a positional path, as the source or the destination", () => {
		expect(() => translateUpdate({ $rename: { "v.$[].n": "m" } })).toThrow(
			"The source field for $rename may not be dynamic: v.$[].n",
		);
		expect(() => translateUpdate({ $rename: { "v.0.n": "v.$[].m" } })).toThrow(
			"The destination field for $rename may not be dynamic: v.$[].m",
		);
	});

	test("the single positional operator", () => {
		expect(() => translateUpdate({ $inc: { "v.$.n": 1 } })).toThrow(
			"The positional operator '$' is not supported",
		);
	});

	test("a positional path in an operator that has no use for one", () => {
		expect(() =>
			translateUpdate({ $setOnInsert: { "v.$[].n": 1 } }, 0, { upsert: true }),
		).toThrow('The positional path "v.$[].n" cannot be used');
	});
});

describe("what this driver does not support is refused", () => {
	test("an array index after a marker", () => {
		expect(() => translateUpdate({ $inc: { "v.$[].c.0": 1 } })).toThrow(
			MongoCompatibilityError,
		);
		expect(() => translateUpdate({ $inc: { "v.$[].c.0": 1 } })).toThrow(
			'An array index after a positional operator is not supported in "v.$[].c.0"',
		);
	});

	test("an identifier with no arrayFilters, or with none naming it", () => {
		expect(() => translateUpdate({ $inc: { "v.$[e].n": 1 } })).toThrow(
			"Positional operator $[e] requires arrayFilters",
		);
		expect(() =>
			translateUpdate({ $inc: { "v.$[e].n": 1 } }, 0, {
				arrayFilters: [{ "other.s": 1 }],
			}),
		).toThrow('No arrayFilter found for identifier "e"');
	});

	test("an arrayFilters operator with no translation", () => {
		expect(() =>
			translateUpdate({ $inc: { "v.$[e].n": 1 } }, 0, {
				arrayFilters: [{ "e.s": { $exists: true } }],
			}),
		).toThrow("Unsupported operator in arrayFilter: $exists");
	});
});
