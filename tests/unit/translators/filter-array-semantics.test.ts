/**
 * What `$regex`, `$type`, `$mod`, `$size`, `$all` and equality at an `$elemMatch`
 * element compile to.
 *
 * MongoDB reads every field comparison as "the field, or any element of it": a
 * pattern matches `["abc", "x"]` as it matches `"abc"`, `{$type: "string"}` matches
 * `["a"]`, and `{$all: [5]}` matches a scalar `5`. These were SQL on the field
 * alone — and two of them, `$mod` and `$size`, were typed on numbers and arrays
 * and *raised* on anything else, aborting the whole query on the first document
 * with a string in the field. What the shapes are chosen for is measured against a
 * real server in `tests/integration/filter-operators.test.ts` and against a real
 * `mongod` in `tests/e2e/scenarios/crud-scenarios.ts`; the SQL is written out in
 * full here so that a change to any part of it is a diff in this file.
 */

import { describe, expect, test } from "bun:test";
import {
	MongoCompatibilityError,
	MongoInvalidArgumentError,
} from "../../../src/errors.ts";
import { translateFilter } from "../../../src/translators/filter.ts";

const ELEMENT = "$__mql_element";

/** `test` of the field, or of any element: see `fieldOrAnyElement`. */
const anyElement = (test: (target: string) => string) =>
	`((${test("`v`")}) OR (type::is_array(\`v\`) AND array::any(\`v\`, |${ELEMENT}| (${test(ELEMENT)}))))`;

const eq = (target: string, param: string) =>
	`(${target} = $${param} OR (type::is_array(${target}) AND ${target} CONTAINS $${param}))`;

describe("$regex", () => {
	test("matches an array when any element does", () => {
		const { clause, bindings } = translateFilter({ v: { $regex: "^a" } });
		expect(clause).toBe(
			anyElement((t) => `type::is_string(${t}) AND string::matches(${t}, $p0)`),
		);
		expect(bindings).toEqual({ p0: "^a" });
	});

	test("an element that is not a string is not matched, and not an error", () => {
		const { clause } = translateFilter({ v: { $regex: "a" } });
		expect(clause).toContain(`type::is_string(${ELEMENT}) AND `);
	});

	test("an $elemMatch element is a value, so there is no element arm", () => {
		const { clause } = translateFilter({ v: { $elemMatch: { $regex: "^a" } } });
		expect(clause).toBe(
			"(type::is_array(`v`) AND array::len(`v`[WHERE type::is_string($this) AND string::matches($this, $p0)]) > 0)",
		);
	});
});

describe("$type", () => {
	test("matches an array holding a value of the type, for any type but array", () => {
		const { clause } = translateFilter({ v: { $type: "string" } });
		expect(clause).toBe(anyElement((t) => `type::is_string(${t})`));
	});

	test("a number code is the same as its name", () => {
		expect(translateFilter({ v: { $type: 2 } }).clause).toBe(
			translateFilter({ v: { $type: "string" } }).clause,
		);
	});

	test("$type: array asks whether the field is one, and never looks at its elements", () => {
		expect(translateFilter({ v: { $type: "array" } }).clause).toBe(
			"type::is_array(`v`)",
		);
		expect(translateFilter({ v: { $type: 4 } }).clause).toBe(
			"type::is_array(`v`)",
		);
	});

	test("an object is a geometry too, in an element as in the field", () => {
		expect(translateFilter({ v: { $type: "object" } }).clause).toBe(
			anyElement((t) => `(type::is_object(${t}) OR type::is_geometry(${t}))`),
		);
	});

	test("an $elemMatch element is a value, so there is no element arm", () => {
		const { clause } = translateFilter({
			v: { $elemMatch: { $type: "string" } },
		});
		expect(clause).toBe(
			"(type::is_array(`v`) AND array::len(`v`[WHERE type::is_string($this)]) > 0)",
		);
	});
});

describe("$mod", () => {
	const mod = (t: string) =>
		`type::is_number(${t}) AND (IF ${t} >= 0 THEN math::floor(${t}) ELSE math::ceil(${t}) END) % $p0 = $p1`;

	test("takes a whole number, only of a number, and any element of an array", () => {
		const { clause, bindings } = translateFilter({ v: { $mod: [2, 1] } });
		expect(clause).toBe(anyElement(mod));
		expect(bindings).toEqual({ p0: 2, p1: 1 });
	});

	test("truncates both operands, as MongoDB does", () => {
		expect(translateFilter({ v: { $mod: [2.5, 1.9] } }).bindings).toEqual({
			p0: 2,
			p1: 1,
		});
		expect(translateFilter({ v: { $mod: [-7.9, -1.5] } }).bindings).toEqual({
			p0: -7,
			p1: -1,
		});
	});

	test("an $elemMatch element is a value, so there is no element arm", () => {
		const { clause } = translateFilter({ v: { $elemMatch: { $mod: [2, 1] } } });
		expect(clause).toContain(
			"WHERE type::is_number($this) AND (IF $this >= 0 THEN",
		);
		expect(clause).not.toContain("array::any");
	});

	test.each([
		[5, "malformed mod, needs to be an array"],
		[[], "malformed mod, not enough elements"],
		[[1], "malformed mod, not enough elements"],
		[[1, 2, 3], "malformed mod, too many elements"],
		[["a", 1], "malformed mod, divisor not a number"],
		[[2, "a"], "malformed mod, remainder not a number"],
		[[0, 0], "divisor cannot be 0"],
		[[0.5, 0], "divisor cannot be 0"],
	])("%j is refused in MongoDB's words", (operand, message) => {
		expect(() => translateFilter({ v: { $mod: operand } })).toThrow(message);
		expect(() => translateFilter({ v: { $mod: operand } })).toThrow(
			MongoInvalidArgumentError,
		);
	});
});

describe("$size", () => {
	test("matches an array of that size, and nothing else", () => {
		const { clause, bindings } = translateFilter({ v: { $size: 1 } });
		expect(clause).toBe("(type::is_array(`v`) AND array::len(`v`) = $p0)");
		expect(bindings).toEqual({ p0: 1 });
	});

	test("inside $elemMatch it is a test of the element", () => {
		const { clause } = translateFilter({ v: { $elemMatch: { $size: 1 } } });
		expect(clause).toBe(
			"(type::is_array(`v`) AND array::len(`v`[WHERE (type::is_array($this) AND array::len($this) = $p0)]) > 0)",
		);
	});

	test.each([
		["a", 'Failed to parse $size. Expected a number in: $size: "a"'],
		[1.5, "Failed to parse $size. Expected an integer: $size: 1.5"],
		[-1, "Failed to parse $size. Expected a non-negative number in: $size: -1"],
	])("%j is refused in MongoDB's words", (operand, message) => {
		expect(() => translateFilter({ v: { $size: operand } })).toThrow(message);
	});
});

describe("$all", () => {
	test("one value is an equality, so a scalar matches", () => {
		const { clause, bindings } = translateFilter({ v: { $all: [5] } });
		expect(clause).toBe(eq("`v`", "p0"));
		expect(bindings).toEqual({ p0: 5 });
	});

	test("several values are each an equality, and ANDed", () => {
		const { clause, bindings } = translateFilter({ v: { $all: [5, 6] } });
		expect(clause).toBe(`(${eq("`v`", "p0")} AND ${eq("`v`", "p1")})`);
		expect(bindings).toEqual({ p0: 5, p1: 6 });
	});

	test("an empty list matches nothing", () => {
		expect(translateFilter({ v: { $all: [] } }).clause).toBe("false");
	});

	test("null is a null, or an absent field", () => {
		expect(translateFilter({ v: { $all: [null] } }).clause).toBe(
			"(`v` IS NULL OR `v` IS NONE OR (type::is_array(`v`) AND `v` CONTAINS NULL))",
		);
	});

	test("an array among the values is whole-array equality, or an element equal to it", () => {
		expect(translateFilter({ v: { $all: [[1, 2]] } }).clause).toBe(
			eq("`v`", "p0"),
		);
	});

	test("an operand that is not an array is refused in MongoDB's words", () => {
		expect(() => translateFilter({ v: { $all: 5 } })).toThrow(
			"$all needs an array",
		);
	});

	test("a regular expression and an $elemMatch among the values are refused", () => {
		expect(() => translateFilter({ v: { $all: [/^a/] } })).toThrow(
			MongoCompatibilityError,
		);
		expect(() =>
			translateFilter({ v: { $all: [{ $elemMatch: { $gt: 1 } }] } }),
		).toThrow(MongoCompatibilityError);
	});
});

describe("equality at an $elemMatch element", () => {
	// The element is the value being matched, so it is compared as one: `[["abc"]]`
	// has one element, an array, and `{$elemMatch: {$eq: "abc"}}` does not match it.
	const elemMatch = (condition: Record<string, unknown>) =>
		translateFilter({ v: { $elemMatch: condition } }).clause;

	test("$eq", () => {
		expect(elemMatch({ $eq: "abc" })).toBe(
			"(type::is_array(`v`) AND array::len(`v`[WHERE $this = $p0]) > 0)",
		);
	});

	test("$ne", () => {
		expect(elemMatch({ $ne: "abc" })).toBe(
			"(type::is_array(`v`) AND array::len(`v`[WHERE $this != $p0]) > 0)",
		);
	});

	test("$in and $nin", () => {
		expect(elemMatch({ $in: ["abc"] })).toBe(
			"(type::is_array(`v`) AND array::len(`v`[WHERE ($this IN $p0)]) > 0)",
		);
		expect(elemMatch({ $nin: ["abc"] })).toBe(
			"(type::is_array(`v`) AND array::len(`v`[WHERE !($this IN $p0)]) > 0)",
		);
	});

	test("a field of the element is a field, and still sees into an array", () => {
		expect(elemMatch({ a: 1 })).toContain(eq("`a`", "p0"));
	});
});
