/**
 * What `$eq`, `$ne`, `$in` and `$nin` compile to inside a `$pull` condition and
 * an `arrayFilters` entry.
 *
 * Both are MongoDB query predicates applied to a value the update finds in an
 * array, so each means what it means in a `find()` filter: equality sees into an
 * array, `null` is a null, a missing field or an array holding a null, and `$ne`
 * and `$nin` are exact negations. They were a bare `=`, `!=`, `IN` and `NOT IN`,
 * which compared the element as a plain value. What the shapes are chosen for is
 * measured against a real server in `tests/integration/update-operators.test.ts`
 * and against a real `mongod` in `tests/e2e/scenarios/crud-scenarios.ts`; the SQL
 * is written out in full here so that a change to any part of it is a diff in
 * this file.
 */

import { describe, expect, test } from "bun:test";
import { MongoInvalidArgumentError } from "../../../src/errors.ts";
import { translateUpdate } from "../../../src/translators/update.ts";

/** MongoDB equality against `target`, spelled out. */
const eq = (target: string, param: string) =>
	`(${target} = $${param} OR (type::is_array(${target}) AND ${target} CONTAINS $${param}))`;

/** MongoDB membership of `target` in a list, spelled out. */
const member = (target: string, param: string) =>
	`(${target} IN $${param} OR (type::is_array(${target}) AND ${target} ANYINSIDE $${param}))`;

/** The element itself, named as the value of a field: see `PULLED_ELEMENT`. */
const ELEMENT = "($this)";

const pulled = (condition: Record<string, unknown>) =>
	translateUpdate({ $pull: { v: condition } });

describe("$pull of an element", () => {
	test("$eq matches an element that is the value, or an array holding it", () => {
		const { clause, bindings } = pulled({ $eq: 7 });
		expect(clause).toBe(`SET \`v\` = \`v\`[WHERE !(${eq(ELEMENT, "p0")})]`);
		expect(bindings).toEqual({ p0: 7 });
	});

	test("$ne is the exact negation, so it keeps an array holding the value", () => {
		const { clause } = pulled({ $ne: 7 });
		expect(clause).toBe(`SET \`v\` = \`v\`[WHERE !(!${eq(ELEMENT, "p0")})]`);
	});

	test("$in", () => {
		const { clause, bindings } = pulled({ $in: [7, 5] });
		expect(clause).toBe(`SET \`v\` = \`v\`[WHERE !(${member(ELEMENT, "p0")})]`);
		expect(bindings).toEqual({ p0: [7, 5] });
	});

	test("$nin is the exact negation of $in", () => {
		const { clause } = pulled({ $nin: [7] });
		expect(clause).toBe(
			`SET \`v\` = \`v\`[WHERE !(!${member(ELEMENT, "p0")})]`,
		);
	});

	test("a string operand cannot match a longer string, as CONTAINS alone would", () => {
		// `'abc' CONTAINS 'a'` is a substring test in SurrealQL: the array guard on
		// the element arm is what keeps `{$eq: "a"}` from removing "abc".
		const { clause } = pulled({ $eq: "a" });
		expect(clause).toContain(
			"type::is_array(($this)) AND ($this) CONTAINS $p0",
		);
	});

	test("$eq of null is a null, or an array holding one", () => {
		const { clause, bindings } = pulled({ $eq: null });
		expect(clause).toBe(
			"SET `v` = `v`[WHERE !((($this) IS NULL OR ($this) IS NONE OR (type::is_array(($this)) AND ($this) CONTAINS NULL)))]",
		);
		expect(bindings).toEqual({});
	});

	test("$ne of null is its exact negation", () => {
		const { clause } = pulled({ $ne: null });
		expect(clause).toContain(
			"!(!(($this) IS NULL OR ($this) IS NONE OR (type::is_array(($this)) AND ($this) CONTAINS NULL)))",
		);
	});

	test("an array operand is whole-array equality, or an element equal to it", () => {
		const { clause, bindings } = pulled({ $eq: [7, 8] });
		expect(clause).toContain(eq(ELEMENT, "p0"));
		expect(bindings).toEqual({ p0: [7, 8] });
	});

	test("several operators are each read that way, and ANDed", () => {
		const { clause, bindings } = pulled({ $eq: 7, $ne: 5 });
		expect(clause).toBe(
			`SET \`v\` = \`v\`[WHERE !(${eq(ELEMENT, "p0")} AND !${eq(ELEMENT, "p1")})]`,
		);
		expect(bindings).toEqual({ p0: 7, p1: 5 });
	});

	test("beside an ordering operator", () => {
		const { clause } = pulled({ $gt: 4, $ne: 7 });
		expect(clause).toContain(`AND !${eq(ELEMENT, "p1")})]`);
	});

	test("a bare value is whole-value equality, as it is in MongoDB", () => {
		const { clause, bindings } = translateUpdate({ $pull: { v: 7 } });
		expect(clause).toBe("SET `v` -= [$p0]");
		expect(bindings).toEqual({ p0: 7 });
	});

	test("through a positional path", () => {
		const { clause } = translateUpdate({ $pull: { "v.$[].t": { $eq: 7 } } });
		expect(clause).toContain(
			`{\`t\`: IF type::is_array($__mql_item0.\`t\`) THEN $__mql_item0.\`t\`[WHERE !(${eq(ELEMENT, "p0")})] ELSE $__mql_item0.\`t\` END}`,
		);
	});
});

describe("$pull of a sub-document by a condition on one of its fields", () => {
	const items = (condition: unknown) =>
		translateUpdate({ $pull: { items: { p: condition } } });

	test("a bare value is equality as a field's value is", () => {
		const { clause, bindings } = items(9);
		expect(clause).toBe(
			`SET \`items\` = \`items\`[WHERE !(${eq("$this.`p`", "p0")})]`,
		);
		expect(bindings).toEqual({ p0: 9 });
	});

	test("a bare null is a null, a missing field, or an array holding one", () => {
		expect(items(null).clause).toBe(
			"SET `items` = `items`[WHERE !(($this.`p` IS NULL OR $this.`p` IS NONE OR (type::is_array($this.`p`) AND $this.`p` CONTAINS NULL)))]",
		);
	});

	test("$eq, $ne, $in and $nin", () => {
		expect(items({ $eq: 1 }).clause).toContain(eq("$this.`p`", "p0"));
		expect(items({ $ne: 1 }).clause).toContain(`!${eq("$this.`p`", "p0")}`);
		expect(items({ $in: [1, 3] }).clause).toContain(member("$this.`p`", "p0"));
		expect(items({ $nin: [1] }).clause).toContain(
			`!${member("$this.`p`", "p0")}`,
		);
	});

	test("an array operand", () => {
		expect(items([1, 2]).clause).toContain(eq("$this.`p`", "p0"));
	});
});

describe("arrayFilters on a field of the element", () => {
	const ITEM = "$__mql_item0";
	const selecting = (condition: unknown) =>
		translateUpdate({ $set: { "v.$[e].f": 1 } }, 0, {
			arrayFilters: [{ "e.p": condition }],
		}).clause;

	test("a bare value", () => {
		expect(selecting(9)).toContain(`IF ${eq(`${ITEM}.\`p\``, "p2")} THEN `);
	});

	test("a bare null", () => {
		expect(selecting(null)).toContain(
			`IF (${ITEM}.\`p\` IS NULL OR ${ITEM}.\`p\` IS NONE OR (type::is_array(${ITEM}.\`p\`) AND ${ITEM}.\`p\` CONTAINS NULL)) THEN `,
		);
	});

	test("$eq, $ne, $in and $nin", () => {
		expect(selecting({ $eq: 9 })).toContain(
			`IF ${eq(`${ITEM}.\`p\``, "p2")} THEN `,
		);
		expect(selecting({ $ne: 9 })).toContain(
			`IF !${eq(`${ITEM}.\`p\``, "p2")} THEN `,
		);
		expect(selecting({ $in: [9] })).toContain(
			`IF ${member(`${ITEM}.\`p\``, "p2")} THEN `,
		);
		expect(selecting({ $nin: [9] })).toContain(
			`IF !${member(`${ITEM}.\`p\``, "p2")} THEN `,
		);
	});

	test("an array operand matches an element equal to it, as well as the whole field", () => {
		expect(selecting([1, 9])).toContain(`${ITEM}.\`p\` CONTAINS $p2`);
	});
});

describe("the operators of a field, as the value of a field", () => {
	const ELEMENT_PARAMETER = "$__mql_element";
	/** `test` of the target, or of any element when it is an array. */
	const anyElement = (target: string, test: (t: string) => string) =>
		`((${test(target)}) OR (type::is_array(${target}) AND array::any(${target}, |${ELEMENT_PARAMETER}| (${test(ELEMENT_PARAMETER)}))))`;
	const matches = (t: string) =>
		`type::is_string(${t}) AND string::matches(${t}, $p0)`;

	test("$regex matches an element that is a matching string, or an array holding one", () => {
		const { clause, bindings } = pulled({ $regex: "^a" });
		expect(clause).toBe(
			`SET \`v\` = \`v\`[WHERE !(${anyElement(ELEMENT, matches)})]`,
		);
		expect(bindings).toEqual({ p0: "^a" });
	});

	test("$regex takes its $options as a filter does", () => {
		const { clause, bindings } = pulled({ $regex: "^a", $options: "i" });
		expect(clause).toContain(anyElement(ELEMENT, matches));
		expect(bindings).toEqual({ p0: "(?i)^a" });
	});

	test("$options without a $regex is refused, as a filter refuses it", () => {
		expect(() => pulled({ $options: "i" })).toThrow("$options needs a $regex");
	});

	test("a bare regular expression is a $regex", () => {
		const { clause, bindings } = translateUpdate({ $pull: { v: /^a/i } });
		expect(clause).toBe(
			`SET \`v\` = \`v\`[WHERE !(${anyElement(ELEMENT, matches)})]`,
		);
		expect(bindings).toEqual({ p0: "(?i)^a" });
	});

	test("$exists tests the value, and does not look inside it", () => {
		expect(pulled({ $exists: true }).clause).toBe(
			"SET `v` = `v`[WHERE !(($this) IS NOT NONE)]",
		);
		expect(
			translateUpdate({ $pull: { items: { s: { $exists: false } } } }).clause,
		).toBe("SET `items` = `items`[WHERE !($this.`s` IS NONE)]");
	});

	test("$type matches an array holding the type, except for array", () => {
		expect(pulled({ $type: "string" }).clause).toBe(
			`SET \`v\` = \`v\`[WHERE !(${anyElement(ELEMENT, (t) => `type::is_string(${t})`)})]`,
		);
		expect(pulled({ $type: "array" }).clause).toBe(
			"SET `v` = `v`[WHERE !(type::is_array(($this)))]",
		);
	});

	test("$mod takes a whole number, only of a number", () => {
		const { clause, bindings } = pulled({ $mod: [2, 1] });
		expect(clause).toContain(
			"type::is_number(($this)) AND (IF ($this) >= 0 THEN math::floor(($this)) ELSE math::ceil(($this)) END) % $p0 = $p1",
		);
		expect(bindings).toEqual({ p0: 2, p1: 1 });
	});

	test("$size matches an array of that size, and nothing else", () => {
		expect(pulled({ $size: 1 }).clause).toBe(
			"SET `v` = `v`[WHERE !((type::is_array(($this)) AND array::len(($this)) = $p0))]",
		);
	});

	test("$all is an equality per value", () => {
		const { clause, bindings } = pulled({ $all: ["a", "b"] });
		expect(clause).toBe(
			`SET \`v\` = \`v\`[WHERE !((${eq(ELEMENT, "p0")} AND ${eq(ELEMENT, "p1")}))]`,
		);
		expect(bindings).toEqual({ p0: "a", p1: "b" });
	});

	test("$elemMatch tests the elements of an element, each as a value", () => {
		const { clause } = pulled({ $elemMatch: { $gt: 5 } });
		expect(clause).toContain(
			"(type::is_array(($this)) AND array::len(($this)[WHERE type::is_number($this) AND $this <= math::inf AND $this > $p0]) > 0)",
		);
	});

	test("several operators are each built, and ANDed", () => {
		// The comparisons are built first, then the operators the filter builds, so
		// the `$gt` is `$p0` and the pattern `$p1`.
		const { clause, bindings } = pulled({ $regex: "^a", $gt: 1 });
		expect(clause).toContain(
			"type::is_number(($this)) AND ($this) <= math::inf",
		);
		expect(clause).toContain("string::matches(($this), $p1)");
		expect(bindings).toEqual({ p0: 1, p1: "^a" });
	});

	test("on a field of each sub-document", () => {
		const { clause } = translateUpdate({
			$pull: { items: { s: { $regex: "^a" } } },
		});
		expect(clause).toBe(
			`SET \`items\` = \`items\`[WHERE !(${anyElement("$this.`s`", matches)})]`,
		);
	});

	test("a bare regular expression on a field of each sub-document", () => {
		const { clause } = translateUpdate({ $pull: { items: { sku: /^ab/ } } });
		expect(clause).toContain(
			"type::is_string($this.`sku`) AND string::matches($this.`sku`, $p0)",
		);
	});

	test("through a positional path", () => {
		const { clause } = translateUpdate({
			$pull: { "v.$[].t": { $regex: "^a" } },
		});
		expect(clause).toContain(
			`THEN $__mql_item0.\`t\`[WHERE !(${anyElement(ELEMENT, matches)})]`,
		);
	});
});

describe("arrayFilters with the operators of a field", () => {
	const ITEM = "$__mql_item0";
	const selecting = (condition: unknown) =>
		translateUpdate({ $set: { "v.$[e].f": 1 } }, 0, {
			arrayFilters: [{ "e.s": condition }],
		}).clause;

	test("$regex sees into an array-valued field", () => {
		expect(selecting({ $regex: "^a" })).toContain(
			`IF ((type::is_string(${ITEM}.\`s\`) AND string::matches(${ITEM}.\`s\`, $p2)) OR (type::is_array(${ITEM}.\`s\`) AND array::any(${ITEM}.\`s\`, |$__mql_element| (`,
		);
	});

	test("a bare regular expression is a $regex", () => {
		expect(selecting(/^a/)).toContain(`string::matches(${ITEM}.\`s\`, $p2)`);
	});

	test("$exists", () => {
		expect(selecting({ $exists: false })).toContain(
			`IF ${ITEM}.\`s\` IS NONE THEN `,
		);
	});

	test("$size, $all and $type", () => {
		expect(selecting({ $size: 1 })).toContain(
			`IF (type::is_array(${ITEM}.\`s\`) AND array::len(${ITEM}.\`s\`) = $p2) THEN `,
		);
		expect(selecting({ $all: ["x"] })).toContain(
			`IF ${eq(`${ITEM}.\`s\``, "p2")} THEN `,
		);
		expect(selecting({ $type: "string" })).toContain(
			`type::is_string(${ITEM}.\`s\`)`,
		);
	});
});

describe("what MongoDB refuses in a condition is refused", () => {
	// MongoDB takes the operators above and refuses the rest at the top of a
	// `$pull` condition: `$not` ("unknown top level operator"), `$and`, `$or`,
	// `$nor` and `$comment` (whose sub-conditions would need field names), and
	// `$expr`, `$where`, `$text`, `$jsonSchema` and `$near` ("not allowed in this
	// context"). `$bitsAllSet`, `$geoWithin` and their kin it takes, and this
	// driver's filters do not translate.
	test.each([
		"$not",
		"$and",
		"$or",
		"$nor",
		"$comment",
		"$expr",
		"$where",
		"$text",
		"$jsonSchema",
		"$near",
		"$nearSphere",
		"$geoWithin",
		"$bitsAllSet",
		"$unknown",
	])("$pull with %s", (operator) => {
		expect(() => pulled({ [operator]: 1 })).toThrow(MongoInvalidArgumentError);
		expect(() => pulled({ [operator]: 1 })).toThrow(
			`Unsupported operator in $pull condition: ${operator}`,
		);
	});

	test("arrayFilters with $not", () => {
		expect(() =>
			translateUpdate({ $set: { "v.$[e].f": 1 } }, 0, {
				arrayFilters: [{ "e.p": { $not: { $eq: 1 } } }],
			}),
		).toThrow("Unsupported operator in arrayFilter: $not");
	});

	test("$near inside an $elemMatch has no result set to order", () => {
		expect(() =>
			pulled({
				$elemMatch: {
					$near: { $geometry: { type: "Point", coordinates: [0, 0] } },
				},
			}),
		).toThrow();
	});
});
