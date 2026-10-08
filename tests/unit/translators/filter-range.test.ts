/**
 * The SurrealQL `$gt`, `$gte`, `$lt` and `$lte` compile to.
 *
 * These pin the *shape* — which guards, which arms, and in what order — because
 * a range predicate that compiled to the wrong guard still compiles, still runs
 * and still returns rows, just not MongoDB's. What the shapes are chosen for is
 * measured in `tests/integration/filter-operators.test.ts` against a real server
 * and in `tests/e2e/scenarios/crud-scenarios.ts` against a real `mongod`; the
 * SQL is written out in full here rather than composed from helpers so that a
 * change to any part of it shows up as a diff in this file.
 */

import { describe, expect, test } from "bun:test";
import { MongoCompatibilityError } from "../../../src/errors.ts";
import { ObjectId } from "../../../src/object-id.ts";
import { V3Dialect } from "../../../src/translators/dialect/v3-dialect.ts";
import { translateFilter } from "../../../src/translators/filter.ts";

const ELEMENT = "$__mql_element";

/** The scalar arm and the element arm, each guarded by `guard`. */
const arms = (guard: (expr: string) => string) =>
	`((${guard("`v`")}) OR (type::is_array(\`v\`) AND array::any(\`v\`, |${ELEMENT}| (${guard(ELEMENT)}))))`;

describe("range operators: one bracket per operand type", () => {
	test("a number operand is guarded by type::is_number and bounded away from NaN", () => {
		const { clause, bindings } = translateFilter({ v: { $gt: 5 } });
		expect(clause).toBe(
			`(\`v\` > $p0 AND ${arms((e) => `type::is_number(${e}) AND ${e} <= math::inf AND ${e} > $p0`)})`,
		);
		expect(bindings).toEqual({ p0: 5 });
	});

	test("a string operand is guarded by type::is_string", () => {
		const { clause, bindings } = translateFilter({ v: { $gt: "a" } });
		expect(clause).toBe(
			`(\`v\` > $p0 AND ${arms((e) => `type::is_string(${e}) AND ${e} > $p0`)})`,
		);
		expect(bindings).toEqual({ p0: "a" });
	});

	test("a boolean operand is guarded by type::is_bool", () => {
		const { clause, bindings } = translateFilter({ v: { $gte: true } });
		expect(clause).toBe(
			`(\`v\` >= $p0 AND ${arms((e) => `type::is_bool(${e}) AND ${e} >= $p0`)})`,
		);
		expect(bindings).toEqual({ p0: true });
	});

	test("a Date operand is guarded by type::is_datetime", () => {
		const date = new Date(5000);
		const { clause, bindings } = translateFilter({ v: { $gt: date } });
		expect(clause).toBe(
			`(\`v\` > $p0 AND ${arms((e) => `type::is_datetime(${e}) AND ${e} > $p0`)})`,
		);
		expect(bindings).toEqual({ p0: date });
	});

	test("a bigint operand is a number", () => {
		const { clause } = translateFilter({ v: { $gt: 5n } });
		expect(clause).toContain("type::is_number(`v`)");
	});

	test("an ObjectId operand is guarded by the stored form, and has no leading range", () => {
		const id = new ObjectId("000000000000000000000001");
		const { clause, bindings } = translateFilter({ v: { $gte: id } });
		// The tagged object sorts above arrays, so `v >= $p0` would not cover the
		// array arm: the predicate is the two arms alone.
		expect(clause).toBe(
			arms(
				(e) =>
					`type::is_object(${e}) AND object::len(${e}) = 1 AND type::is_string(${e}.\`$oid\`) AND ${e} >= $p0`,
			),
		);
		expect(bindings).toEqual({ p0: id });
	});

	test("the type predicates come from the dialect", () => {
		class Renamed extends V3Dialect {
			override typeCheckFn(bson: string | number): string | undefined {
				const name = super.typeCheckFn(bson);
				return name?.replace("type::is_", "type::is::");
			}
		}
		const { clause } = translateFilter(
			{ v: { $lt: "z" } },
			{ dialect: new Renamed() },
		);
		expect(clause).toContain("type::is::string(`v`)");
		expect(clause).toContain("type::is::array(`v`)");
		expect(clause).not.toContain("type::is_");
	});
});

describe("range operators: the leading range", () => {
	// SurrealQL ranks arrays above numbers, strings, booleans and datetimes, so a
	// `$gt`/`$gte` can lead with the operator itself: every array is in range.
	test("$gt and $gte lead with the operator itself", () => {
		expect(translateFilter({ v: { $gt: 5 } }).clause).toStartWith(
			"(`v` > $p0 AND ",
		);
		expect(translateFilter({ v: { $gte: 5 } }).clause).toStartWith(
			"(`v` >= $p0 AND ",
		);
	});

	// A `$lt`/`$lte` must not: the arrays its element arm selects are *above* the
	// operand, so the leading range is the union of "below" and "an array".
	test("$lt and $lte lead with a union that includes every array", () => {
		expect(translateFilter({ v: { $lt: 5 } }).clause).toStartWith(
			"((`v` < $p0 OR `v` >= []) AND ",
		);
		expect(translateFilter({ v: { $lte: 5 } }).clause).toStartWith(
			"((`v` <= $p0 OR `v` >= []) AND ",
		);
	});

	test("$lt and $lte bound the number bracket from below, $gt and $gte from above", () => {
		expect(translateFilter({ v: { $lt: 5 } }).clause).toContain(
			"`v` >= math::neg_inf AND `v` < $p0",
		);
		expect(translateFilter({ v: { $gt: 5 } }).clause).toContain(
			"`v` <= math::inf AND `v` > $p0",
		);
	});

	test("infinities are ordinary number operands", () => {
		const { clause, bindings } = translateFilter({
			v: { $lt: Number.POSITIVE_INFINITY },
		});
		expect(clause).toContain("`v` >= math::neg_inf AND `v` < $p0");
		expect(bindings).toEqual({ p0: Number.POSITIVE_INFINITY });
	});

	test("every arm reads the one binding", () => {
		const { clause, bindings } = translateFilter({ v: { $gt: 5 } });
		expect(Object.keys(bindings)).toEqual(["p0"]);
		expect(clause).not.toContain("$p1");
	});
});

describe("range operators: arrays", () => {
	test("a dotted path is evaluated before its elements are tested", () => {
		// `a.b[WHERE …]` filters per `a` element and is true for any document whose
		// `a` has an element at all; `array::any` over the evaluated path is what
		// keeps `{"items.price": {$gt: 5}}` honest.
		const { clause } = translateFilter({ "items.price": { $gt: 5 } });
		expect(clause).toContain("array::any(`items`.`price`, |$__mql_element| (");
		expect(clause).not.toContain("[WHERE");
	});

	test("an $elemMatch element is compared as a value, with no element arm", () => {
		const { clause } = translateFilter({ v: { $elemMatch: { $gt: 7 } } });
		expect(clause).toBe(
			"(type::is_array(`v`) AND array::len(`v`[WHERE type::is_number($this) AND $this <= math::inf AND $this > $p0]) > 0)",
		);
	});

	test("an $elemMatch sub-field still gets the array arm, as any field does", () => {
		const { clause } = translateFilter({
			v: { $elemMatch: { a: { $gt: 1 } } },
		});
		expect(clause).toContain("array::any(`a`, |$__mql_element| (");
	});

	test("$not negates the whole predicate", () => {
		const { clause } = translateFilter({ v: { $not: { $lt: 5 } } });
		expect(clause).toStartWith("!(((`v` < $p0 OR `v` >= []) AND ");
		expect(clause).toEndWith(")))");
	});
});

describe("range operators: null, undefined and NaN", () => {
	test("$gt and $lt of null match nothing", () => {
		for (const operator of ["$gt", "$lt"]) {
			const { clause, bindings } = translateFilter({ v: { [operator]: null } });
			expect(clause).toBe("false");
			expect(bindings).toEqual({});
		}
	});

	test("$gte and $lte of null are equality with null: a null or a missing field", () => {
		for (const operator of ["$gte", "$lte"]) {
			const { clause, bindings } = translateFilter({ v: { [operator]: null } });
			expect(clause).toBe("(`v` IS NULL OR `v` IS NONE)");
			expect(bindings).toEqual({});
		}
	});

	test("undefined is null, as the official driver serialises it", () => {
		expect(translateFilter({ v: { $gt: undefined } }).clause).toBe("false");
		expect(translateFilter({ v: { $lte: undefined } }).clause).toBe(
			"(`v` IS NULL OR `v` IS NONE)",
		);
	});

	test("$gt and $lt of NaN match nothing", () => {
		for (const operator of ["$gt", "$lt"]) {
			const { clause, bindings } = translateFilter({
				v: { [operator]: Number.NaN },
			});
			expect(clause).toBe("false");
			expect(bindings).toEqual({});
		}
	});

	test("$gte and $lte of NaN are equality with NaN", () => {
		for (const operator of ["$gte", "$lte"]) {
			const { clause, bindings } = translateFilter({
				v: { [operator]: Number.NaN },
			});
			expect(clause).toBe(
				"(`v` = $p0 OR (type::is_array(`v`) AND `v` CONTAINS $p0))",
			);
			expect(bindings).toEqual({ p0: Number.NaN });
		}
	});

	test("inside $elemMatch, NaN equality is on the element alone", () => {
		const { clause } = translateFilter({
			v: { $elemMatch: { $gte: Number.NaN } },
		});
		expect(clause).toContain("WHERE $this = $p0]");
	});
});

describe("range operators: the identity field", () => {
	test("_id keeps the bare comparison, against the RecordId it is coerced to", () => {
		const { clause, bindings } = translateFilter(
			{ _id: { $gt: "abc" } },
			{ collection: "users" },
		);
		expect(clause).toBe("id > $p0");
		expect(Object.keys(bindings)).toEqual(["p0"]);
	});

	// `_id` is only left alone when the identity is *not* the record id — after a
	// `$group`, say, where it is the group key — so it is an ordinary field, and a
	// mixed-type key needs the bracketing any other field does.
	test("an _id the translator was not told to rewrite is an ordinary field", () => {
		const { clause } = translateFilter({ _id: { $lte: 5 } });
		expect(clause).toStartWith("((`_id` <= $p0 OR `_id` >= []) AND ");
		expect(clause).toContain("type::is_number(`_id`)");
	});
});

describe("range operators: what has no exact translation is refused", () => {
	test.each([
		"$gt",
		"$gte",
		"$lt",
		"$lte",
	])("%s with an array operand", (operator) => {
		expect(() => translateFilter({ v: { [operator]: [7] } })).toThrow(
			MongoCompatibilityError,
		);
		expect(() => translateFilter({ v: { [operator]: [7] } })).toThrow(
			`${operator} with an array operand is not supported`,
		);
	});

	test.each([
		"$gt",
		"$gte",
		"$lt",
		"$lte",
	])("%s with an embedded document operand", (operator) => {
		expect(() => translateFilter({ v: { [operator]: { a: 1 } } })).toThrow(
			MongoCompatibilityError,
		);
		expect(() => translateFilter({ v: { [operator]: { a: 1 } } })).toThrow(
			`${operator} with an embedded document operand is not supported`,
		);
	});

	test("an empty array and an empty document are refused too", () => {
		expect(() => translateFilter({ v: { $gt: [] } })).toThrow(
			MongoCompatibilityError,
		);
		expect(() => translateFilter({ v: { $lte: {} } })).toThrow(
			MongoCompatibilityError,
		);
	});

	test("a regular expression operand", () => {
		expect(() => translateFilter({ v: { $gt: /a/ } })).toThrow(
			"$gt does not support a regular expression as an operand",
		);
	});

	test("a BSON value this driver cannot represent", () => {
		class Long {
			readonly _bsontype = "Long";
		}
		expect(() => translateFilter({ v: { $lt: new Long() } })).toThrow(
			"$lt does not support a BSON Long as an operand",
		);
	});

	test("a function operand", () => {
		expect(() => translateFilter({ v: { $lt: () => 1 } })).toThrow(
			MongoCompatibilityError,
		);
	});

	test("the refusal names the operator in a combined condition", () => {
		expect(() => translateFilter({ v: { $gt: 1, $lt: [9] } })).toThrow(
			"$lt with an array operand",
		);
	});
});
