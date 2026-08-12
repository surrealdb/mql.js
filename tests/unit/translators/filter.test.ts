import { describe, expect, test } from "bun:test";
import {
	MongoCompatibilityError,
	MongoInvalidArgumentError,
} from "../../../src/errors.ts";
import { translateFilter } from "../../../src/translators/filter.ts";

/**
 * MongoDB equality is not whole-value equality: it also matches an element of
 * an array field. These build the predicates the translator emits for that, so
 * the incidental tests below stay readable — the dedicated array-semantics
 * tests further down spell the SurrealQL out in full.
 */
const eq = (field: string, param: string) =>
	`(${field} = $${param} OR (type::is_array(${field}) AND ${field} CONTAINS $${param}))`;
const inAny = (field: string, param: string) =>
	`(${field} IN $${param} OR (type::is_array(${field}) AND ${field} ANYINSIDE $${param}))`;

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
		expect(clause).toBe(
			"(name = $p0 OR (type::is_array(name) AND name CONTAINS $p0))",
		);
		expect(bindings).toEqual({ p0: "John" });
	});

	test("implicit equality with number", () => {
		const { clause, bindings } = translateFilter({ age: 30 });
		expect(clause).toBe(eq("age", "p0"));
		expect(bindings).toEqual({ p0: 30 });
	});

	test("implicit equality with null matches null OR a missing field", () => {
		// MongoDB `{f: null}` matches an explicit null *and* an absent field;
		// SurrealDB spells those NULL and NONE. No value needs binding.
		const { clause, bindings } = translateFilter({ field: null });
		expect(clause).toBe("(field IS NULL OR field IS NONE)");
		expect(bindings).toEqual({});
	});

	test("implicit equality with boolean", () => {
		const { clause, bindings } = translateFilter({ active: true });
		expect(clause).toBe(eq("active", "p0"));
		expect(bindings).toEqual({ p0: true });
	});

	test("multiple implicit equalities are AND-ed", () => {
		const { clause, bindings } = translateFilter({
			name: "John",
			age: 30,
		});
		expect(clause).toBe(`${eq("name", "p0")} AND ${eq("age", "p1")}`);
		expect(bindings).toEqual({ p0: "John", p1: 30 });
	});

	// -----------------------------------------------------------------
	// Comparison operators
	// -----------------------------------------------------------------
	test("$eq", () => {
		const { clause, bindings } = translateFilter({ x: { $eq: 5 } });
		expect(clause).toBe(eq("x", "p0"));
		expect(bindings).toEqual({ p0: 5 });
	});

	test("$ne negates the whole equality, array arm included", () => {
		const { clause, bindings } = translateFilter({ x: { $ne: 5 } });
		expect(clause).toBe("!(x = $p0 OR (type::is_array(x) AND x CONTAINS $p0))");
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
	test("$in also matches an element of an array field", () => {
		const { clause, bindings } = translateFilter({
			status: { $in: ["active", "pending"] },
		});
		expect(clause).toBe(
			"(status IN $p0 OR (type::is_array(status) AND status ANYINSIDE $p0))",
		);
		expect(bindings).toEqual({ p0: ["active", "pending"] });
	});

	test("$nin is the negation of $in", () => {
		const { clause, bindings } = translateFilter({
			role: { $nin: ["admin", "root"] },
		});
		expect(clause).toBe(
			"!(role IN $p0 OR (type::is_array(role) AND role ANYINSIDE $p0))",
		);
		expect(bindings).toEqual({ p0: ["admin", "root"] });
	});

	test("$in containing null also matches a missing field", () => {
		// `IN` already covers the explicit NULL; only NONE needs naming.
		const { clause } = translateFilter({ a: { $in: [null, 1] } });
		expect(clause).toBe(
			"(a IN $p0 OR (type::is_array(a) AND a ANYINSIDE $p0) OR a IS NONE)",
		);
	});

	test("$nin containing null excludes a missing field too", () => {
		const { clause } = translateFilter({ a: { $nin: [null] } });
		expect(clause).toBe(
			"!(a IN $p0 OR (type::is_array(a) AND a ANYINSIDE $p0) OR a IS NONE)",
		);
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
	test("a SurrealDB 2.x target is rejected outright", () => {
		expect(() =>
			translateFilter({ name: { $regex: "^Jo" } }, { surrealVersion: "2.0.0" }),
		).toThrow(MongoCompatibilityError);
	});

	// `string::matches()` is typed on strings and raises on a NONE, so the call
	// is guarded — a document simply missing the field must not abort the query.
	const MATCHES = "(type::is_string(name) AND string::matches(name, $p0))";

	test("$regex with string emits a guarded string::matches on v3", () => {
		const { clause, bindings } = translateFilter(
			{ name: { $regex: "^Jo" } },
			{ surrealVersion: "3.0.0" },
		);
		expect(clause).toBe(MATCHES);
		expect(bindings).toEqual({ p0: "^Jo" });
	});

	test("$regex with RegExp carries its flags into the pattern", () => {
		const { clause, bindings } = translateFilter(
			{ name: { $regex: /^Jo/i } },
			{ surrealVersion: "3.0.0" },
		);
		expect(clause).toBe(MATCHES);
		expect(bindings).toEqual({ p0: "(?i)^Jo" });
	});

	test("RegExp shorthand on field emits string::matches on v3", () => {
		const { clause, bindings } = translateFilter(
			{ name: /^Jo/ },
			{ surrealVersion: "3.0.0" },
		);
		expect(clause).toBe(MATCHES);
		expect(bindings).toEqual({ p0: "^Jo" });
	});

	test("RegExp shorthand flags reach the pattern as an inline group", () => {
		// Defect: flags were dropped, so /hello/i did not match "HELLO".
		expect(translateFilter({ name: /hello/i }).bindings).toEqual({
			p0: "(?i)hello",
		});
		expect(translateFilter({ name: /hello/ims }).bindings).toEqual({
			p0: "(?ims)hello",
		});
	});

	test("$options flags are merged into the pattern", () => {
		const { clause, bindings } = translateFilter({
			name: { $regex: "hello", $options: "i" },
		});
		expect(clause).toBe(MATCHES);
		expect(bindings).toEqual({ p0: "(?i)hello" });
	});

	test("$options and RegExp flags combine, emitted in a stable order", () => {
		expect(
			translateFilter({ name: { $regex: /hello/s, $options: "i" } }).bindings,
		).toEqual({ p0: "(?is)hello" });
	});

	test("flags with no bearing on matching are accepted and dropped", () => {
		// g/y are iteration state, d asks for capture indices, and u/v request a
		// Unicode mode SurrealDB's engine is always in.
		expect(translateFilter({ name: /hello/gu }).bindings).toEqual({
			p0: "hello",
		});
	});

	test("an unsupported regex flag is named rather than ignored", () => {
		expect(() =>
			translateFilter({ name: { $regex: "hello", $options: "q" } }),
		).toThrow(MongoInvalidArgumentError);
		expect(() =>
			translateFilter({ name: { $regex: "hello", $options: "q" } }),
		).toThrow("Unsupported $regex flag: q");
	});

	test("$options without a sibling $regex is rejected", () => {
		expect(() => translateFilter({ name: { $options: "i" } })).toThrow(
			"$options needs a $regex",
		);
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
		expect(clause).toBe(`(${eq("name", "p0")} AND age > $p1)`);
		expect(bindings).toEqual({ p0: "John", p1: 25 });
	});

	test("$or", () => {
		const { clause, bindings } = translateFilter({
			$or: [{ name: "John" }, { name: "Jane" }],
		});
		expect(clause).toBe(`(${eq("name", "p0")} OR ${eq("name", "p1")})`);
		expect(bindings).toEqual({ p0: "John", p1: "Jane" });
	});

	test("$nor", () => {
		const { clause, bindings } = translateFilter({
			$nor: [{ status: "deleted" }, { status: "banned" }],
		});
		expect(clause).toBe(
			`NOT ((${eq("status", "p0")} OR ${eq("status", "p1")}))`,
		);
		expect(bindings).toEqual({ p0: "deleted", p1: "banned" });
	});

	test("single-element $and omits parens", () => {
		const { clause } = translateFilter({
			$and: [{ name: "John" }],
		});
		expect(clause).toBe(eq("name", "p0"));
	});

	// -----------------------------------------------------------------
	// Nested dot-notation paths
	// -----------------------------------------------------------------
	test("dot-notation field paths", () => {
		const { clause, bindings } = translateFilter({
			"address.city": "NYC",
		});
		expect(clause).toBe(eq("address.city", "p0"));
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
		expect(clause).toBe(
			`${eq("active", "p0")} AND (${eq("role", "p1")} OR age >= $p2)`,
		);
		expect(bindings).toEqual({ p0: true, p1: "admin", p2: 18 });
	});

	test("nested $and inside $or", () => {
		const { clause, bindings } = translateFilter({
			$or: [{ $and: [{ a: 1 }, { b: 2 }] }, { c: 3 }],
		});
		expect(clause).toBe(
			`((${eq("a", "p0")} AND ${eq("b", "p1")}) OR ${eq("c", "p2")})`,
		);
		expect(bindings).toEqual({ p0: 1, p1: 2, p2: 3 });
	});

	// -----------------------------------------------------------------
	// Array operators
	// -----------------------------------------------------------------
	test("$all", () => {
		const { clause, bindings } = translateFilter({
			tags: { $all: ["a", "b"] },
		});
		expect(clause).toBe("tags CONTAINSALL $p0");
		expect(bindings).toEqual({ p0: ["a", "b"] });
	});

	test("$size", () => {
		const { clause, bindings } = translateFilter({
			items: { $size: 3 },
		});
		expect(clause).toBe("array::len(items) = $p0");
		expect(bindings).toEqual({ p0: 3 });
	});

	test("$size zero", () => {
		const { clause, bindings } = translateFilter({
			items: { $size: 0 },
		});
		expect(clause).toBe("array::len(items) = $p0");
		expect(bindings).toEqual({ p0: 0 });
	});

	test("$elemMatch equality is a per-element partial match", () => {
		// Defect: this used to compile to `results CONTAINS $p` — whole-object
		// equality — so `{$elemMatch: {product: "abc"}}` missed an element that
		// merely *had* that product alongside other fields.
		const { clause, bindings } = translateFilter({
			results: { $elemMatch: { product: "abc", score: 8 } },
		});
		expect(clause).toBe(
			"(type::is_array(results) AND array::len(results[WHERE " +
				`${eq("product", "p0")} AND ${eq("score", "p1")}]) > 0)`,
		);
		expect(bindings).toEqual({ p0: "abc", p1: 8 });
	});

	test("$elemMatch with a single condition matches a larger element", () => {
		const { clause, bindings } = translateFilter({
			items: { $elemMatch: { x: 1 } },
		});
		expect(clause).toBe(
			`(type::is_array(items) AND array::len(items[WHERE ${eq("x", "p0")}]) > 0)`,
		);
		expect(bindings).toEqual({ p0: 1 });
	});

	test("$elemMatch with operators", () => {
		const { clause, bindings } = translateFilter({
			results: { $elemMatch: { score: { $gt: 80 }, grade: "A" } },
		});
		expect(clause).toBe(
			"(type::is_array(results) AND array::len(results[WHERE " +
				`score > $p0 AND ${eq("grade", "p1")}]) > 0)`,
		);
		expect(bindings).toEqual({ p0: 80, p1: "A" });
	});

	test("$elemMatch mixes nested operators with equality", () => {
		const { clause, bindings } = translateFilter({
			items: { $elemMatch: { x: { $gte: 1, $lt: 5 }, y: 2 } },
		});
		expect(clause).toBe(
			"(type::is_array(items) AND array::len(items[WHERE " +
				`x >= $p0 AND x < $p1 AND ${eq("y", "p2")}]) > 0)`,
		);
		expect(bindings).toEqual({ p0: 1, p1: 5, p2: 2 });
	});

	test("$elemMatch with only operators", () => {
		const { clause, bindings } = translateFilter({
			scores: { $elemMatch: { $gte: 80, $lt: 90 } },
		});
		// Top-level operators apply to the element itself via $this
		expect(clause).toBe(
			"(type::is_array(scores) AND array::len(scores[WHERE $this >= $p0 AND $this < $p1]) > 0)",
		);
		expect(bindings).toEqual({ p0: 80, p1: 90 });
	});

	test("$elemMatch with a nested RegExp condition", () => {
		const { clause, bindings } = translateFilter({
			items: { $elemMatch: { sku: /^ab/i } },
		});
		expect(clause).toBe(
			"(type::is_array(items) AND array::len(items[WHERE " +
				"(type::is_string(sku) AND string::matches(sku, $p0))]) > 0)",
		);
		expect(bindings).toEqual({ p0: "(?i)^ab" });
	});

	test("$elemMatch with no conditions only needs a non-empty array", () => {
		// `array::len()` raises on a NONE, so the type guard's short-circuit is
		// what keeps a document without the field from erroring.
		const { clause } = translateFilter({ items: { $elemMatch: {} } });
		expect(clause).toBe("(type::is_array(items) AND array::len(items) > 0)");
	});

	test("$elemMatch escapes sub-field names", () => {
		const { clause } = translateFilter({
			items: { $elemMatch: { "a-b": 1 } },
		});
		expect(clause).toBe(
			`(type::is_array(items) AND array::len(items[WHERE ${eq("`a-b`", "p0")}]) > 0)`,
		);
	});

	// -----------------------------------------------------------------
	// $type — emits the 3.x `type::is_*` type-check functions.
	// -----------------------------------------------------------------
	const V3 = { surrealVersion: "3.0.0" };

	test("$type with string alias", () => {
		expect(translateFilter({ x: { $type: "string" } }, V3).clause).toBe(
			"type::is_string(x)",
		);
	});

	test("$type with numeric BSON code", () => {
		expect(translateFilter({ x: { $type: 2 } }, V3).clause).toBe(
			"type::is_string(x)",
		);
	});

	test("$type 'number' matches any numeric type", () => {
		expect(translateFilter({ x: { $type: "number" } }, V3).clause).toBe(
			"type::is_number(x)",
		);
	});

	test("$type 'double' / 1 maps to float", () => {
		expect(translateFilter({ x: { $type: "double" } }, V3).clause).toBe(
			"type::is_float(x)",
		);
		expect(translateFilter({ x: { $type: 1 } }, V3).clause).toBe(
			"type::is_float(x)",
		);
	});

	test("$type 'object' / 3 also finds a geometry, which MongoDB calls an object", () => {
		// GeoJSON is stored as SurrealDB's geometry type, which `type::is_object`
		// answers false for — while the value the caller wrote, and reads back, is a
		// JSON object, and is a BSON object to MongoDB.
		for (const spec of ["object", 3]) {
			expect(translateFilter({ x: { $type: spec } }, V3).clause).toBe(
				"(type::is_object(x) OR type::is_geometry(x))",
			);
		}
	});

	test("$type 'array' / 4 maps to array", () => {
		expect(translateFilter({ x: { $type: "array" } }, V3).clause).toBe(
			"type::is_array(x)",
		);
	});

	test("$type 'bool' / 8 maps to bool", () => {
		expect(translateFilter({ x: { $type: "bool" } }, V3).clause).toBe(
			"type::is_bool(x)",
		);
	});

	test("$type 'date' / 9 maps to datetime", () => {
		expect(translateFilter({ x: { $type: "date" } }, V3).clause).toBe(
			"type::is_datetime(x)",
		);
	});

	test("$type 'null' / 10 maps to null", () => {
		expect(translateFilter({ x: { $type: "null" } }, V3).clause).toBe(
			"type::is_null(x)",
		);
	});

	test("$type 'int' / 16 maps to int", () => {
		expect(translateFilter({ x: { $type: "int" } }, V3).clause).toBe(
			"type::is_int(x)",
		);
	});

	test("$type 'long' / 18 maps to int (no distinction)", () => {
		expect(translateFilter({ x: { $type: "long" } }, V3).clause).toBe(
			"type::is_int(x)",
		);
	});

	test("$type 'decimal' / 19 maps to decimal", () => {
		expect(translateFilter({ x: { $type: "decimal" } }, V3).clause).toBe(
			"type::is_decimal(x)",
		);
	});

	test("$type throws on unsupported type", () => {
		expect(() => translateFilter({ x: { $type: "binData" } })).toThrow(
			"Unsupported $type value: binData",
		);
	});

	test("$type throws on unsupported numeric code", () => {
		expect(() => translateFilter({ x: { $type: 5 } })).toThrow(
			"Unsupported $type value: 5",
		);
	});

	// -----------------------------------------------------------------
	// $mod
	// -----------------------------------------------------------------
	test("$mod checks field modulo", () => {
		const { clause, bindings } = translateFilter({
			qty: { $mod: [4, 0] },
		});
		expect(clause).toBe("qty % $p0 = $p1");
		expect(bindings).toEqual({ p0: 4, p1: 0 });
	});

	test("$mod with non-zero remainder", () => {
		const { clause, bindings } = translateFilter({
			qty: { $mod: [3, 1] },
		});
		expect(clause).toBe("qty % $p0 = $p1");
		expect(bindings).toEqual({ p0: 3, p1: 1 });
	});

	test("$mod combined with other operators", () => {
		const { clause, bindings } = translateFilter({
			qty: { $mod: [4, 0], $gt: 10 },
		});
		expect(clause).toBe("qty % $p0 = $p1 AND qty > $p2");
		expect(bindings).toEqual({ p0: 4, p1: 0, p2: 10 });
	});

	// -----------------------------------------------------------------
	// $text
	// -----------------------------------------------------------------
	test("$text with single text field", () => {
		const { clause, bindings } = translateFilter(
			{ $text: { $search: "coffee shop" } },
			{ textFields: ["description"] },
		);
		expect(clause).toBe("description @@ $p0");
		expect(bindings).toEqual({ p0: "coffee shop" });
	});

	test("$text with multiple text fields", () => {
		const { clause, bindings } = translateFilter(
			{ $text: { $search: "hello" } },
			{ textFields: ["title", "body"] },
		);
		expect(clause).toBe("(title @@ $p0 OR body @@ $p0)");
		expect(bindings).toEqual({ p0: "hello" });
	});

	test("$text combined with other conditions", () => {
		const { clause, bindings } = translateFilter(
			{ $text: { $search: "coffee" }, status: "active" },
			{ textFields: ["content"] },
		);
		expect(clause).toBe(`content @@ $p0 AND ${eq("status", "p1")}`);
		expect(bindings).toEqual({ p0: "coffee", p1: "active" });
	});

	test("$text throws without text fields", () => {
		expect(() => translateFilter({ $text: { $search: "hello" } })).toThrow(
			"$text query requires a text index",
		);
	});

	test("$text throws with empty text fields", () => {
		expect(() =>
			translateFilter({ $text: { $search: "hello" } }, { textFields: [] }),
		).toThrow("$text query requires a text index");
	});

	test("$text throws without $search", () => {
		expect(() =>
			translateFilter(
				{ $text: { $language: "en" } } as Record<string, unknown>,
				{ textFields: ["field"] },
			),
		).toThrow("$text requires a $search string");
	});

	// -----------------------------------------------------------------
	// Array-field matching semantics
	//
	// MongoDB matches an array field by element as well as by whole value, so
	// `{tags: "a"}` matches `{tags: ["a", "b"]}`. The `type::is_array` guard is
	// not decoration: on SurrealDB 3.x `'abc' CONTAINS 'a'` is a substring test
	// and `{k: 1} CONTAINS 'k'` is a key test, either of which would produce
	// false positives for a scalar or object field.
	// -----------------------------------------------------------------
	test("equality matches the whole array or one of its elements", () => {
		const { clause, bindings } = translateFilter({ tags: "a" });
		expect(clause).toBe(
			"(tags = $p0 OR (type::is_array(tags) AND tags CONTAINS $p0))",
		);
		expect(bindings).toEqual({ p0: "a" });
	});

	test("whole-array equality binds the array unchanged", () => {
		const { clause, bindings } = translateFilter({ tags: ["a", "b"] });
		expect(clause).toBe(eq("tags", "p0"));
		expect(bindings).toEqual({ p0: ["a", "b"] });
	});

	test("$in matches any listed value against the array's elements", () => {
		const { clause, bindings } = translateFilter({ tags: { $in: ["a"] } });
		expect(clause).toBe(inAny("tags", "p0"));
		expect(bindings).toEqual({ p0: ["a"] });
	});

	test("the identity field keeps plain equality and membership", () => {
		// A `_id` is a single present RecordId — MongoDB refuses to store an array
		// one — so the array and null arms would only add noise.
		const options = { collection: "users" };
		expect(translateFilter({ _id: "a" }, options).clause).toBe("id = $p0");
		expect(translateFilter({ _id: { $in: ["a"] } }, options).clause).toBe(
			"id IN $p0",
		);
		expect(translateFilter({ _id: { $ne: "a" } }, options).clause).toBe(
			"id != $p0",
		);
		expect(translateFilter({ _id: { $nin: ["a"] } }, options).clause).toBe(
			"id NOT IN $p0",
		);
	});

	// -----------------------------------------------------------------
	// null vs. a missing field
	// -----------------------------------------------------------------
	test("$eq null matches an explicit null and an absent field", () => {
		const { clause, bindings } = translateFilter({ a: { $eq: null } });
		expect(clause).toBe("(a IS NULL OR a IS NONE)");
		expect(bindings).toEqual({});
	});

	test("$ne null matches neither an explicit null nor an absent field", () => {
		const { clause, bindings } = translateFilter({ a: { $ne: null } });
		expect(clause).toBe("(a IS NOT NULL AND a IS NOT NONE)");
		expect(bindings).toEqual({});
	});

	// -----------------------------------------------------------------
	// Error handling
	// -----------------------------------------------------------------
	test("throws on unsupported operator", () => {
		expect(() => translateFilter({ x: { $where: "1" } })).toThrow(
			"Unsupported filter operator: $where",
		);
	});

	test("throws on an unsupported top-level operator", () => {
		// Defect: `$where` was treated as a field name, producing a nonsense
		// predicate against an unbound parameter instead of an error.
		expect(() => translateFilter({ $where: "true" })).toThrow(
			MongoInvalidArgumentError,
		);
		expect(() => translateFilter({ $where: "true" })).toThrow(
			"Unsupported top-level filter operator: $where",
		);
		expect(() => translateFilter({ $comment: "hi" })).toThrow(
			"Unsupported top-level filter operator: $comment",
		);
		expect(() => translateFilter({ $expr: { $eq: [1, 1] } })).toThrow(
			"Unsupported top-level filter operator: $expr",
		);
	});

	test("the supported top-level operators still translate", () => {
		expect(() => translateFilter({ $and: [{ a: 1 }] })).not.toThrow();
		expect(() => translateFilter({ $or: [{ a: 1 }] })).not.toThrow();
		expect(() => translateFilter({ $nor: [{ a: 1 }] })).not.toThrow();
		expect(() =>
			translateFilter({ $text: { $search: "x" } }, { textFields: ["b"] }),
		).not.toThrow();
	});
});
