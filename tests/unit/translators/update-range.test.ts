/**
 * The SurrealQL a `$pull` or `arrayFilters` ordering operator compiles to.
 *
 * Both are a MongoDB query predicate applied to an array element, so they are
 * the predicate the filter translator builds for `$gt`, `$gte`, `$lt` and `$lte`
 * (see `filter-range.test.ts`) and not a bare `>`: a bare `>` removed the string
 * `"x"` for `{$pull: {v: {$gt: 5}}}`, because SurrealQL ranks every string above
 * every number. What the shapes are chosen for is measured against a real server
 * in `tests/integration/update-operators.test.ts` and against a real
 * `mongod` in `tests/e2e/scenarios/crud-scenarios.ts`. The SQL is written out
 * here rather than composed from helpers so a change to any part of it is a diff
 * in this file.
 */

import { describe, expect, test } from "bun:test";
import { MongoCompatibilityError } from "../../../src/errors.ts";
import { ObjectId } from "../../../src/object-id.ts";
import { V3Dialect } from "../../../src/translators/dialect/v3-dialect.ts";
import { translateUpdate } from "../../../src/translators/update.ts";

const ELEMENT = "$__mql_element";

/** The scalar arm and the element arm over `target`, each guarded by `guard`. */
const arms = (target: string, guard: (expr: string) => string) =>
	`((${guard(target)}) OR (type::is_array(${target}) AND array::any(${target}, |${ELEMENT}| (${guard(ELEMENT)}))))`;

describe("$pull: a condition on the element itself", () => {
	// The element is named `($this)` and not `$this`: MongoDB tests it as the
	// value of a field, so an element that is an array matches when any of its
	// elements does, and the filter translator keys the other reading — a plain
	// value, as in `$elemMatch` — on the string `$this`.
	test("a number operand is guarded by type::is_number and bounded away from NaN", () => {
		const { clause, bindings } = translateUpdate({ $pull: { v: { $gt: 5 } } });
		expect(clause).toBe(
			`SET \`v\` = \`v\`[WHERE !(${arms("($this)", (e) => `type::is_number(${e}) AND ${e} <= math::inf AND ${e} > $p0`)})]`,
		);
		expect(bindings).toEqual({ p0: 5 });
	});

	test("$lt and $lte bound the number bracket from below", () => {
		const { clause } = translateUpdate({ $pull: { v: { $lte: 5 } } });
		expect(clause).toContain(
			"type::is_number(($this)) AND ($this) >= math::neg_inf AND ($this) <= $p0",
		);
	});

	test("a string operand is guarded by type::is_string", () => {
		const { clause, bindings } = translateUpdate({
			$pull: { v: { $gt: "a" } },
		});
		expect(clause).toBe(
			`SET \`v\` = \`v\`[WHERE !(${arms("($this)", (e) => `type::is_string(${e}) AND ${e} > $p0`)})]`,
		);
		expect(bindings).toEqual({ p0: "a" });
	});

	test("a boolean operand is guarded by type::is_bool", () => {
		const { clause } = translateUpdate({ $pull: { v: { $gte: true } } });
		expect(clause).toContain("type::is_bool(($this)) AND ($this) >= $p0");
	});

	test("a Date operand is guarded by type::is_datetime", () => {
		const date = new Date(5000);
		const { clause, bindings } = translateUpdate({
			$pull: { v: { $lt: date } },
		});
		expect(clause).toContain("type::is_datetime(($this)) AND ($this) < $p0");
		expect(bindings).toEqual({ p0: date });
	});

	test("an ObjectId operand is guarded by the stored form", () => {
		const id = new ObjectId("000000000000000000000001");
		const { clause, bindings } = translateUpdate({ $pull: { v: { $gt: id } } });
		expect(clause).toContain(
			"type::is_object(($this)) AND object::len(($this)) = 1 AND type::is_string(($this).`$oid`) AND ($this) > $p0",
		);
		expect(bindings).toEqual({ p0: id });
	});

	test("an element that is an array is searched, as a field's value is", () => {
		const { clause } = translateUpdate({ $pull: { v: { $gt: 5 } } });
		expect(clause).toContain(
			"type::is_array(($this)) AND array::any(($this), |$__mql_element| (",
		);
	});

	test("it leaves out the range a table scan would use, which a filtered path has no use for", () => {
		const { clause } = translateUpdate({ $pull: { v: { $lt: 5 } } });
		expect(clause).not.toContain(">= []");
		expect(clause).toStartWith("SET `v` = `v`[WHERE !(((type::is_number(");
	});

	test("two operators are each bracketed, and ANDed", () => {
		const { clause, bindings } = translateUpdate({
			$pull: { v: { $gte: 2, $lt: 10 } },
		});
		expect(clause).toContain(
			") AND ((type::is_number(($this)) AND ($this) >= math::neg_inf",
		);
		expect(bindings).toEqual({ p0: 2, p1: 10 });
	});

	test("$eq, $ne, $in and $nin are unchanged", () => {
		expect(translateUpdate({ $pull: { v: { $eq: 5 } } }).clause).toBe(
			"SET `v` = `v`[WHERE !($this = $p0)]",
		);
		expect(translateUpdate({ $pull: { v: { $ne: 5 } } }).clause).toBe(
			"SET `v` = `v`[WHERE !($this != $p0)]",
		);
		expect(translateUpdate({ $pull: { v: { $in: [1] } } }).clause).toBe(
			"SET `v` = `v`[WHERE !($this IN $p0)]",
		);
		expect(translateUpdate({ $pull: { v: { $nin: [1] } } }).clause).toBe(
			"SET `v` = `v`[WHERE !($this NOT IN $p0)]",
		);
	});

	test("the type predicates come from the dialect", () => {
		class Renamed extends V3Dialect {
			override typeCheckFn(bson: string | number): string | undefined {
				return super.typeCheckFn(bson)?.replace("type::is_", "type::is::");
			}
		}
		const { clause } = translateUpdate({ $pull: { v: { $gt: "a" } } }, 0, {
			dialect: new Renamed(),
		});
		expect(clause).toContain("type::is::string(($this))");
		expect(clause).toContain("type::is::array(($this))");
		expect(clause).not.toContain("type::is_");
	});
});

describe("$pull: null and NaN", () => {
	test("$gt and $lt of null remove nothing, whatever the element", () => {
		for (const operator of ["$gt", "$lt"]) {
			const { clause, bindings } = translateUpdate({
				$pull: { v: { [operator]: null } },
			});
			expect(clause).toBe("SET `v` = `v`[WHERE !(false)]");
			expect(bindings).toEqual({});
		}
	});

	test("$gte and $lte of null remove a null, as a null equality does", () => {
		for (const operator of ["$gte", "$lte"]) {
			const { clause } = translateUpdate({
				$pull: { v: { [operator]: null } },
			});
			expect(clause).toBe(
				"SET `v` = `v`[WHERE !((($this) IS NULL OR ($this) IS NONE OR (type::is_array(($this)) AND ($this) CONTAINS NULL)))]",
			);
		}
	});

	test("$gt and $lt of NaN remove nothing, and $gte and $lte of NaN remove a NaN", () => {
		expect(translateUpdate({ $pull: { v: { $gt: Number.NaN } } }).clause).toBe(
			"SET `v` = `v`[WHERE !(false)]",
		);
		const { clause, bindings } = translateUpdate({
			$pull: { v: { $lte: Number.NaN } },
		});
		expect(clause).toBe(
			"SET `v` = `v`[WHERE !((($this) = $p0 OR (type::is_array(($this)) AND ($this) CONTAINS $p0)))]",
		);
		expect(bindings).toEqual({ p0: Number.NaN });
	});
});

describe("$pull: a condition on a field of each element", () => {
	test("the sub-field is a field, so an array-valued one is searched", () => {
		const { clause, bindings } = translateUpdate({
			$pull: { items: { price: { $gt: 5 } } },
		});
		expect(clause).toBe(
			`SET \`items\` = \`items\`[WHERE !(${arms("$this.`price`", (e) => `type::is_number(${e}) AND ${e} <= math::inf AND ${e} > $p0`)})]`,
		);
		expect(bindings).toEqual({ p0: 5 });
	});

	test("its path is escaped, nested paths included", () => {
		const { clause } = translateUpdate({
			$pull: { items: { "a-b.c": { $lt: "z" } } },
		});
		expect(clause).toContain(
			"type::is_string($this.`a-b`.`c`) AND $this.`a-b`.`c` < $p0",
		);
	});

	test("conditions on several fields are ANDed with an equality", () => {
		const { clause, bindings } = translateUpdate({
			$pull: { items: { price: { $gte: 8 }, name: "B" } },
		});
		expect(clause).toContain("$this.`name` = $p1)]");
		expect(bindings).toEqual({ p0: 8, p1: "B" });
	});
});

describe("arrayFilters: a condition on a field of the element", () => {
	test("a number operand", () => {
		const { clause, bindings } = translateUpdate(
			{ $set: { "scores.$[high].passed": true } },
			0,
			{ arrayFilters: [{ "high.value": { $gte: 90 } }] },
		);
		expect(clause).toBe(
			`SET \`scores\`[WHERE ${arms("`value`", (e) => `type::is_number(${e}) AND ${e} <= math::inf AND ${e} >= $p0`)}].\`passed\` = $p1`,
		);
		expect(bindings).toEqual({ p0: 90, p1: true });
	});

	test("a string, a boolean and a Date each get their own guard", () => {
		const guards: [unknown, string][] = [
			["8", "type::is_string(`s`)"],
			[true, "type::is_bool(`s`)"],
			[new Date(1), "type::is_datetime(`s`)"],
		];
		for (const [operand, guard] of guards) {
			const { clause } = translateUpdate({ $set: { "v.$[e].f": 1 } }, 0, {
				arrayFilters: [{ "e.s": { $gt: operand } }],
			});
			expect(clause).toContain(guard);
		}
	});

	test("an array-valued field is searched for an element in range", () => {
		const { clause } = translateUpdate({ $set: { "v.$[e].f": 1 } }, 0, {
			arrayFilters: [{ "e.score": { $lt: 60 } }],
		});
		expect(clause).toContain(
			"type::is_array(`score`) AND array::any(`score`, |$__mql_element| (",
		);
	});

	test("it leaves out the range a table scan would use", () => {
		const { clause } = translateUpdate({ $set: { "v.$[e].f": 1 } }, 0, {
			arrayFilters: [{ "e.score": { $lt: 60 } }],
		});
		expect(clause).not.toContain(">= []");
	});

	test("null and NaN follow the same rules as in a filter", () => {
		const filtered = (operator: string, operand: unknown) =>
			translateUpdate({ $set: { "v.$[e].f": 1 } }, 0, {
				arrayFilters: [{ "e.s": { [operator]: operand } }],
			}).clause;
		expect(filtered("$gt", null)).toBe("SET `v`[WHERE false].`f` = $p0");
		expect(filtered("$lte", null)).toBe(
			"SET `v`[WHERE (`s` IS NULL OR `s` IS NONE OR (type::is_array(`s`) AND `s` CONTAINS NULL))].`f` = $p0",
		);
		expect(filtered("$lt", Number.NaN)).toBe("SET `v`[WHERE false].`f` = $p0");
	});

	test("conditions are ANDed with the equality ones", () => {
		const { clause, bindings } = translateUpdate(
			{ $inc: { "items.$[item].qty": 1 } },
			0,
			{ arrayFilters: [{ "item.status": "active", "item.qty": { $lt: 100 } }] },
		);
		expect(clause).toContain(
			"[WHERE `status` = $p0 AND ((type::is_number(`qty`)",
		);
		expect(bindings).toEqual({ p0: "active", p1: 100, p2: 1 });
	});

	test("$eq, $ne, $in and $nin are unchanged", () => {
		const filtered = (spec: Record<string, unknown>) =>
			translateUpdate({ $set: { "v.$[e].f": 1 } }, 0, {
				arrayFilters: [{ "e.s": spec }],
			}).clause;
		expect(filtered({ $eq: 1 })).toBe("SET `v`[WHERE `s` = $p0].`f` = $p1");
		expect(filtered({ $ne: 1 })).toBe("SET `v`[WHERE `s` != $p0].`f` = $p1");
		expect(filtered({ $in: [1] })).toBe("SET `v`[WHERE `s` IN $p0].`f` = $p1");
		expect(filtered({ $nin: [1] })).toBe(
			"SET `v`[WHERE `s` NOT IN $p0].`f` = $p1",
		);
	});

	test("the type predicates come from the dialect", () => {
		class Renamed extends V3Dialect {
			override typeCheckFn(bson: string | number): string | undefined {
				return super.typeCheckFn(bson)?.replace("type::is_", "type::is::");
			}
		}
		const { clause } = translateUpdate({ $set: { "v.$[e].f": 1 } }, 0, {
			arrayFilters: [{ "e.s": { $gt: 5 } }],
			dialect: new Renamed(),
		});
		expect(clause).toContain("type::is::number(`s`)");
		expect(clause).not.toContain("type::is_");
	});
});

describe("what has no exact translation is refused, in an update as in a filter", () => {
	test.each([
		"$gt",
		"$gte",
		"$lt",
		"$lte",
	])("$pull with %s and an array operand", (operator) => {
		const update = { $pull: { v: { [operator]: [7] } } };
		expect(() => translateUpdate(update)).toThrow(MongoCompatibilityError);
		expect(() => translateUpdate(update)).toThrow(
			`${operator} with an array operand is not supported`,
		);
	});

	test.each([
		"$gt",
		"$gte",
		"$lt",
		"$lte",
	])("$pull with %s and an embedded document operand", (operator) => {
		expect(() =>
			translateUpdate({ $pull: { v: { [operator]: { a: 1 } } } }),
		).toThrow(`${operator} with an embedded document operand`);
	});

	test("a sub-field condition", () => {
		expect(() =>
			translateUpdate({ $pull: { items: { price: { $gt: [1] } } } }),
		).toThrow(MongoCompatibilityError);
	});

	test("an arrayFilters condition", () => {
		expect(() =>
			translateUpdate({ $set: { "v.$[e].f": 1 } }, 0, {
				arrayFilters: [{ "e.s": { $lt: { a: 1 } } }],
			}),
		).toThrow(MongoCompatibilityError);
	});

	test("a regular expression", () => {
		expect(() => translateUpdate({ $pull: { v: { $gt: /a/ } } })).toThrow(
			"$gt does not support a regular expression as an operand",
		);
	});
});
