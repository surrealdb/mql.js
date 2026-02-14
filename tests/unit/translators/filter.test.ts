import { describe, expect, test } from "bun:test";
import { translateFilter } from "../../../src/translators/filter.ts";

describe("translateFilter", () => {
	// -----------------------------------------------------------------
	// Empty / null filters
	// -----------------------------------------------------------------
	test("empty object produces empty clause", () => {
		const { clause, bindings } = translateFilter({});
		expect(clause).toBe("");
		expect(bindings).toEqual({});
	});

	test("null / undefined produces empty clause", () => {
		expect(translateFilter(null).clause).toBe("");
		expect(translateFilter(undefined).clause).toBe("");
	});

	// -----------------------------------------------------------------
	// Implicit equality
	// -----------------------------------------------------------------
	test("implicit equality with string", () => {
		const { clause, bindings } = translateFilter({ name: "John" });
		expect(clause).toBe("name = $p0");
		expect(bindings).toEqual({ p0: "John" });
	});

	test("implicit equality with number", () => {
		const { clause, bindings } = translateFilter({ age: 30 });
		expect(clause).toBe("age = $p0");
		expect(bindings).toEqual({ p0: 30 });
	});

	test("implicit equality with null", () => {
		const { clause, bindings } = translateFilter({ field: null });
		expect(clause).toBe("field = $p0");
		expect(bindings).toEqual({ p0: null });
	});

	test("implicit equality with boolean", () => {
		const { clause, bindings } = translateFilter({ active: true });
		expect(clause).toBe("active = $p0");
		expect(bindings).toEqual({ p0: true });
	});

	test("multiple implicit equalities are AND-ed", () => {
		const { clause, bindings } = translateFilter({
			name: "John",
			age: 30,
		});
		expect(clause).toBe("name = $p0 AND age = $p1");
		expect(bindings).toEqual({ p0: "John", p1: 30 });
	});

	// -----------------------------------------------------------------
	// Comparison operators
	// -----------------------------------------------------------------
	test("$eq", () => {
		const { clause, bindings } = translateFilter({ x: { $eq: 5 } });
		expect(clause).toBe("x = $p0");
		expect(bindings).toEqual({ p0: 5 });
	});

	test("$ne", () => {
		const { clause, bindings } = translateFilter({ x: { $ne: 5 } });
		expect(clause).toBe("x != $p0");
		expect(bindings).toEqual({ p0: 5 });
	});

	test("$gt", () => {
		const { clause, bindings } = translateFilter({ x: { $gt: 10 } });
		expect(clause).toBe("x > $p0");
		expect(bindings).toEqual({ p0: 10 });
	});

	test("$gte", () => {
		const { clause, bindings } = translateFilter({ x: { $gte: 10 } });
		expect(clause).toBe("x >= $p0");
		expect(bindings).toEqual({ p0: 10 });
	});

	test("$lt", () => {
		const { clause, bindings } = translateFilter({ x: { $lt: 10 } });
		expect(clause).toBe("x < $p0");
		expect(bindings).toEqual({ p0: 10 });
	});

	test("$lte", () => {
		const { clause, bindings } = translateFilter({ x: { $lte: 10 } });
		expect(clause).toBe("x <= $p0");
		expect(bindings).toEqual({ p0: 10 });
	});

	test("combined $gt and $lt on same field", () => {
		const { clause, bindings } = translateFilter({
			age: { $gt: 18, $lt: 65 },
		});
		expect(clause).toBe("age > $p0 AND age < $p1");
		expect(bindings).toEqual({ p0: 18, p1: 65 });
	});

	// -----------------------------------------------------------------
	// $in / $nin
	// -----------------------------------------------------------------
	test("$in", () => {
		const { clause, bindings } = translateFilter({
			status: { $in: ["active", "pending"] },
		});
		expect(clause).toBe("status IN $p0");
		expect(bindings).toEqual({ p0: ["active", "pending"] });
	});

	test("$nin", () => {
		const { clause, bindings } = translateFilter({
			role: { $nin: ["admin", "root"] },
		});
		expect(clause).toBe("role NOT IN $p0");
		expect(bindings).toEqual({ p0: ["admin", "root"] });
	});

	// -----------------------------------------------------------------
	// $exists
	// -----------------------------------------------------------------
	test("$exists: true", () => {
		const { clause, bindings } = translateFilter({
			email: { $exists: true },
		});
		expect(clause).toBe("email IS NOT NONE");
		expect(bindings).toEqual({});
	});

	test("$exists: false", () => {
		const { clause, bindings } = translateFilter({
			email: { $exists: false },
		});
		expect(clause).toBe("email IS NONE");
		expect(bindings).toEqual({});
	});

	// -----------------------------------------------------------------
	// $regex
	// -----------------------------------------------------------------
	test("$regex with string", () => {
		const { clause, bindings } = translateFilter({
			name: { $regex: "^Jo" },
		});
		expect(clause).toBe("name ~ $p0");
		expect(bindings).toEqual({ p0: "^Jo" });
	});

	test("$regex with RegExp", () => {
		const { clause, bindings } = translateFilter({
			name: { $regex: /^Jo/i },
		});
		expect(clause).toBe("name ~ $p0");
		expect(bindings).toEqual({ p0: "^Jo" });
	});

	test("RegExp shorthand on field", () => {
		const { clause, bindings } = translateFilter({ name: /^Jo/ });
		expect(clause).toBe("name ~ $p0");
		expect(bindings).toEqual({ p0: "^Jo" });
	});

	// -----------------------------------------------------------------
	// $not
	// -----------------------------------------------------------------
	test("$not wraps inner operators", () => {
		const { clause, bindings } = translateFilter({
			age: { $not: { $gt: 18 } },
		});
		expect(clause).toBe("!(age > $p0)");
		expect(bindings).toEqual({ p0: 18 });
	});

	test("$not with multiple inner operators", () => {
		const { clause, bindings } = translateFilter({
			age: { $not: { $gt: 18, $lt: 65 } },
		});
		expect(clause).toBe("!(age > $p0 AND age < $p1)");
		expect(bindings).toEqual({ p0: 18, p1: 65 });
	});

	// -----------------------------------------------------------------
	// Logical: $and, $or, $nor
	// -----------------------------------------------------------------
	test("$and", () => {
		const { clause, bindings } = translateFilter({
			$and: [{ name: "John" }, { age: { $gt: 25 } }],
		});
		expect(clause).toBe("(name = $p0 AND age > $p1)");
		expect(bindings).toEqual({ p0: "John", p1: 25 });
	});

	test("$or", () => {
		const { clause, bindings } = translateFilter({
			$or: [{ name: "John" }, { name: "Jane" }],
		});
		expect(clause).toBe("(name = $p0 OR name = $p1)");
		expect(bindings).toEqual({ p0: "John", p1: "Jane" });
	});

	test("$nor", () => {
		const { clause, bindings } = translateFilter({
			$nor: [{ status: "deleted" }, { status: "banned" }],
		});
		expect(clause).toBe("NOT ((status = $p0 OR status = $p1))");
		expect(bindings).toEqual({ p0: "deleted", p1: "banned" });
	});

	test("single-element $and omits parens", () => {
		const { clause } = translateFilter({
			$and: [{ name: "John" }],
		});
		expect(clause).toBe("name = $p0");
	});

	// -----------------------------------------------------------------
	// Nested dot-notation paths
	// -----------------------------------------------------------------
	test("dot-notation field paths", () => {
		const { clause, bindings } = translateFilter({
			"address.city": "NYC",
		});
		expect(clause).toBe("address.city = $p0");
		expect(bindings).toEqual({ p0: "NYC" });
	});

	test("deeply nested dot paths", () => {
		const { clause } = translateFilter({
			"a.b.c.d": { $gt: 10 },
		});
		expect(clause).toBe("a.b.c.d > $p0");
	});

	// -----------------------------------------------------------------
	// Complex combinations
	// -----------------------------------------------------------------
	test("field condition + $or", () => {
		const { clause, bindings } = translateFilter({
			active: true,
			$or: [{ role: "admin" }, { age: { $gte: 18 } }],
		});
		expect(clause).toBe("active = $p0 AND (role = $p1 OR age >= $p2)");
		expect(bindings).toEqual({ p0: true, p1: "admin", p2: 18 });
	});

	test("nested $and inside $or", () => {
		const { clause, bindings } = translateFilter({
			$or: [{ $and: [{ a: 1 }, { b: 2 }] }, { c: 3 }],
		});
		expect(clause).toBe("((a = $p0 AND b = $p1) OR c = $p2)");
		expect(bindings).toEqual({ p0: 1, p1: 2, p2: 3 });
	});

	// -----------------------------------------------------------------
	// Error handling
	// -----------------------------------------------------------------
	test("throws on unsupported operator", () => {
		expect(() =>
			translateFilter({ x: { $type: "string" } as unknown }),
		).toThrow("Unsupported filter operator: $type");
	});
});
