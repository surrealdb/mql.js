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
import {
	MongoCompatibilityError,
	MongoInvalidArgumentError,
} from "../../../src/errors.ts";
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

describe("what a condition cannot say is still refused", () => {
	// MongoDB takes any query operator here — `$regex`, `$exists`, `$type`, `$mod`,
	// `$size`, `$all` and `$elemMatch` among them — but not `$not`, which it reads
	// as a top-level operator and refuses. Taking the whole filter vocabulary is a
	// change of its own, each operator to be measured as the value of a field.
	test.each([
		"$regex",
		"$exists",
		"$type",
		"$mod",
		"$size",
		"$all",
		"$not",
	])("$pull with %s", (operator) => {
		expect(() => pulled({ [operator]: 1 })).toThrow(MongoInvalidArgumentError);
		expect(() => pulled({ [operator]: 1 })).toThrow(
			`Unsupported operator in $pull condition: ${operator}`,
		);
	});

	// In MongoDB a bare pattern is a `$regex`. Compared as a value, as equality
	// would have it, it matches nothing, and `{$pull: {tags: /^a/}}` removed no
	// tag and said nothing; it is refused until `$regex` is.
	test("a regular expression as the condition on the element", () => {
		expect(() => translateUpdate({ $pull: { v: /^a/ } })).toThrow(
			MongoCompatibilityError,
		);
		expect(() => translateUpdate({ $pull: { v: /^a/ } })).toThrow(
			"A regular expression is not supported as a condition on an array element",
		);
	});

	test("a regular expression as the condition on a field of the element", () => {
		expect(() =>
			translateUpdate({ $pull: { items: { sku: /^ab/i } } }),
		).toThrow(MongoCompatibilityError);
	});

	test("a regular expression in an arrayFilters entry", () => {
		expect(() =>
			translateUpdate({ $set: { "v.$[e].f": 1 } }, 0, {
				arrayFilters: [{ "e.s": /^a/ }],
			}),
		).toThrow(MongoCompatibilityError);
	});

	test("a regular expression inside a value to match whole is not a condition", () => {
		// `$pullAll` and an array operand are whole-value equality, and a pattern in
		// the list is a value like any other.
		expect(() => translateUpdate({ $pullAll: { v: [/^a/] } })).not.toThrow();
	});

	test("arrayFilters with $exists", () => {
		expect(() =>
			translateUpdate({ $set: { "v.$[e].f": 1 } }, 0, {
				arrayFilters: [{ "e.p": { $exists: true } }],
			}),
		).toThrow("Unsupported operator in arrayFilter: $exists");
	});
});
