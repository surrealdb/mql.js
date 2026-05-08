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
	test("$regex with string emits ~ on v2", () => {
		const { clause, bindings } = translateFilter(
			{ name: { $regex: "^Jo" } },
			{ surrealVersion: "2.0.0" },
		);
		expect(clause).toBe("name ~ $p0");
		expect(bindings).toEqual({ p0: "^Jo" });
	});

	test("$regex with string emits string::matches on v3", () => {
		const { clause, bindings } = translateFilter(
			{ name: { $regex: "^Jo" } },
			{ surrealVersion: "3.0.0" },
		);
		expect(clause).toBe("string::matches(name, $p0)");
		expect(bindings).toEqual({ p0: "^Jo" });
	});

	test("$regex with RegExp emits ~ on v2", () => {
		const { clause, bindings } = translateFilter(
			{ name: { $regex: /^Jo/i } },
			{ surrealVersion: "2.0.0" },
		);
		expect(clause).toBe("name ~ $p0");
		expect(bindings).toEqual({ p0: "^Jo" });
	});

	test("$regex with RegExp emits string::matches on v3", () => {
		const { clause, bindings } = translateFilter(
			{ name: { $regex: /^Jo/i } },
			{ surrealVersion: "3.0.0" },
		);
		expect(clause).toBe("string::matches(name, $p0)");
		expect(bindings).toEqual({ p0: "^Jo" });
	});

	test("RegExp shorthand on field emits ~ on v2", () => {
		const { clause, bindings } = translateFilter(
			{ name: /^Jo/ },
			{ surrealVersion: "2.0.0" },
		);
		expect(clause).toBe("name ~ $p0");
		expect(bindings).toEqual({ p0: "^Jo" });
	});

	test("RegExp shorthand on field emits string::matches on v3", () => {
		const { clause, bindings } = translateFilter(
			{ name: /^Jo/ },
			{ surrealVersion: "3.0.0" },
		);
		expect(clause).toBe("string::matches(name, $p0)");
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

	test("$elemMatch simple equality", () => {
		const { clause, bindings } = translateFilter({
			results: { $elemMatch: { product: "abc", score: 8 } },
		});
		expect(clause).toBe("results CONTAINS $p0");
		expect(bindings).toEqual({ p0: { product: "abc", score: 8 } });
	});

	test("$elemMatch with operators", () => {
		const { clause, bindings } = translateFilter({
			results: { $elemMatch: { score: { $gt: 80 }, grade: "A" } },
		});
		expect(clause).toBe(
			"array::len(results[WHERE score > $p0 AND grade = $p1]) > 0",
		);
		expect(bindings).toEqual({ p0: 80, p1: "A" });
	});

	test("$elemMatch with only operators", () => {
		const { clause, bindings } = translateFilter({
			scores: { $elemMatch: { $gte: 80, $lt: 90 } },
		});
		// Top-level operators apply to the element itself via $this
		expect(clause).toBe(
			"array::len(scores[WHERE $this >= $p0 AND $this < $p1]) > 0",
		);
		expect(bindings).toEqual({ p0: 80, p1: 90 });
	});

	// -----------------------------------------------------------------
	// $type — both dialects: v2 emits `type::is::*`, v3 emits `type::is_*`.
	// -----------------------------------------------------------------
	const V2 = { surrealVersion: "2.0.0" };
	const V3 = { surrealVersion: "3.0.0" };

	test("$type with string alias", () => {
		expect(translateFilter({ x: { $type: "string" } }, V2).clause).toBe(
			"type::is::string(x)",
		);
		expect(translateFilter({ x: { $type: "string" } }, V3).clause).toBe(
			"type::is_string(x)",
		);
	});

	test("$type with numeric BSON code", () => {
		expect(translateFilter({ x: { $type: 2 } }, V2).clause).toBe(
			"type::is::string(x)",
		);
		expect(translateFilter({ x: { $type: 2 } }, V3).clause).toBe(
			"type::is_string(x)",
		);
	});

	test("$type 'number' matches any numeric type", () => {
		expect(translateFilter({ x: { $type: "number" } }, V2).clause).toBe(
			"type::is::number(x)",
		);
		expect(translateFilter({ x: { $type: "number" } }, V3).clause).toBe(
			"type::is_number(x)",
		);
	});

	test("$type 'double' / 1 maps to float", () => {
		expect(translateFilter({ x: { $type: "double" } }, V2).clause).toBe(
			"type::is::float(x)",
		);
		expect(translateFilter({ x: { $type: 1 } }, V2).clause).toBe(
			"type::is::float(x)",
		);
		expect(translateFilter({ x: { $type: "double" } }, V3).clause).toBe(
			"type::is_float(x)",
		);
		expect(translateFilter({ x: { $type: 1 } }, V3).clause).toBe(
			"type::is_float(x)",
		);
	});

	test("$type 'object' / 3 maps to object", () => {
		expect(translateFilter({ x: { $type: "object" } }, V2).clause).toBe(
			"type::is::object(x)",
		);
		expect(translateFilter({ x: { $type: "object" } }, V3).clause).toBe(
			"type::is_object(x)",
		);
	});

	test("$type 'array' / 4 maps to array", () => {
		expect(translateFilter({ x: { $type: "array" } }, V2).clause).toBe(
			"type::is::array(x)",
		);
		expect(translateFilter({ x: { $type: "array" } }, V3).clause).toBe(
			"type::is_array(x)",
		);
	});

	test("$type 'bool' / 8 maps to bool", () => {
		expect(translateFilter({ x: { $type: "bool" } }, V2).clause).toBe(
			"type::is::bool(x)",
		);
		expect(translateFilter({ x: { $type: "bool" } }, V3).clause).toBe(
			"type::is_bool(x)",
		);
	});

	test("$type 'date' / 9 maps to datetime", () => {
		expect(translateFilter({ x: { $type: "date" } }, V2).clause).toBe(
			"type::is::datetime(x)",
		);
		expect(translateFilter({ x: { $type: "date" } }, V3).clause).toBe(
			"type::is_datetime(x)",
		);
	});

	test("$type 'null' / 10 maps to null", () => {
		expect(translateFilter({ x: { $type: "null" } }, V2).clause).toBe(
			"type::is::null(x)",
		);
		expect(translateFilter({ x: { $type: "null" } }, V3).clause).toBe(
			"type::is_null(x)",
		);
	});

	test("$type 'int' / 16 maps to int", () => {
		expect(translateFilter({ x: { $type: "int" } }, V2).clause).toBe(
			"type::is::int(x)",
		);
		expect(translateFilter({ x: { $type: "int" } }, V3).clause).toBe(
			"type::is_int(x)",
		);
	});

	test("$type 'long' / 18 maps to int (no distinction)", () => {
		expect(translateFilter({ x: { $type: "long" } }, V2).clause).toBe(
			"type::is::int(x)",
		);
		expect(translateFilter({ x: { $type: "long" } }, V3).clause).toBe(
			"type::is_int(x)",
		);
	});

	test("$type 'decimal' / 19 maps to decimal", () => {
		expect(translateFilter({ x: { $type: "decimal" } }, V2).clause).toBe(
			"type::is::decimal(x)",
		);
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
		expect(clause).toBe("content @@ $p0 AND status = $p1");
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
	// $geoWithin
	// -----------------------------------------------------------------
	test("$geoWithin with $geometry (Polygon)", () => {
		const polygon = {
			type: "Polygon",
			coordinates: [
				[
					[0, 0],
					[3, 6],
					[6, 1],
					[0, 0],
				],
			],
		};
		const { clause, bindings } = translateFilter({
			location: { $geoWithin: { $geometry: polygon } },
		});
		expect(clause).toBe("location INSIDE $p0");
		expect(bindings).toEqual({ p0: polygon });
	});

	test("$geoWithin with $centerSphere", () => {
		const { clause, bindings } = translateFilter({
			location: {
				$geoWithin: { $centerSphere: [[-73.93, 40.82], 0.0025] },
			},
		});
		expect(clause).toBe("geo::distance(location, $p0) <= $p1");
		expect(bindings.p0).toEqual({
			type: "Point",
			coordinates: [-73.93, 40.82],
		});
		// 0.0025 radians * 6378100 metres
		expect(bindings.p1).toBeCloseTo(0.0025 * 6_378_100, 0);
	});

	test("$geoWithin with $center", () => {
		const { clause, bindings } = translateFilter({
			location: {
				$geoWithin: { $center: [[-74, 40.74], 5000] },
			},
		});
		expect(clause).toBe("geo::distance(location, $p0) <= $p1");
		expect(bindings.p0).toEqual({
			type: "Point",
			coordinates: [-74, 40.74],
		});
		expect(bindings.p1).toBe(5000);
	});

	test("$geoWithin with $box", () => {
		const { clause, bindings } = translateFilter({
			location: {
				$geoWithin: {
					$box: [
						[-74.0, 40.7],
						[-73.9, 40.8],
					],
				},
			},
		});
		expect(clause).toBe("location INSIDE $p0");
		expect(bindings.p0).toEqual({
			type: "Polygon",
			coordinates: [
				[
					[-74.0, 40.7],
					[-73.9, 40.7],
					[-73.9, 40.8],
					[-74.0, 40.8],
					[-74.0, 40.7],
				],
			],
		});
	});

	test("$geoWithin with $polygon", () => {
		const { clause, bindings } = translateFilter({
			location: {
				$geoWithin: {
					$polygon: [
						[0, 0],
						[3, 6],
						[6, 0],
					],
				},
			},
		});
		expect(clause).toBe("location INSIDE $p0");
		// Auto-closes the ring
		expect(bindings.p0).toEqual({
			type: "Polygon",
			coordinates: [
				[
					[0, 0],
					[3, 6],
					[6, 0],
					[0, 0],
				],
			],
		});
	});

	test("$geoWithin throws without shape", () => {
		expect(() => translateFilter({ location: { $geoWithin: {} } })).toThrow(
			"$geoWithin requires",
		);
	});

	// -----------------------------------------------------------------
	// $geoIntersects
	// -----------------------------------------------------------------
	test("$geoIntersects with $geometry", () => {
		const polygon = {
			type: "Polygon",
			coordinates: [
				[
					[0, 0],
					[3, 6],
					[6, 1],
					[0, 0],
				],
			],
		};
		const { clause, bindings } = translateFilter({
			area: { $geoIntersects: { $geometry: polygon } },
		});
		expect(clause).toBe("area INTERSECTS $p0");
		expect(bindings).toEqual({ p0: polygon });
	});

	test("$geoIntersects throws without $geometry", () => {
		expect(() =>
			translateFilter({
				area: { $geoIntersects: {} },
			}),
		).toThrow("$geoIntersects requires $geometry");
	});

	// -----------------------------------------------------------------
	// $near / $nearSphere
	// -----------------------------------------------------------------
	test("$near with $maxDistance", () => {
		const point = { type: "Point", coordinates: [-73.9667, 40.78] };
		const { clause, bindings, nearSort } = translateFilter({
			location: {
				$near: { $geometry: point, $maxDistance: 5000 },
			},
		});
		expect(clause).toBe("geo::distance(location, $p0) <= $p1");
		expect(bindings).toEqual({ p0: point, p1: 5000 });
		expect(nearSort).toBe("ORDER BY geo::distance(location, $p0) ASC");
	});

	test("$near with $minDistance and $maxDistance", () => {
		const point = { type: "Point", coordinates: [-73.9667, 40.78] };
		const { clause, bindings, nearSort } = translateFilter({
			location: {
				$near: {
					$geometry: point,
					$minDistance: 500,
					$maxDistance: 3000,
				},
			},
		});
		expect(clause).toBe(
			"geo::distance(location, $p0) >= $p1 AND geo::distance(location, $p0) <= $p2",
		);
		expect(bindings).toEqual({ p0: point, p1: 500, p2: 3000 });
		expect(nearSort).toBe("ORDER BY geo::distance(location, $p0) ASC");
	});

	test("$near without distance constraints", () => {
		const point = { type: "Point", coordinates: [-73.9667, 40.78] };
		const { clause, bindings, nearSort } = translateFilter({
			location: { $near: { $geometry: point } },
		});
		// Always-true condition to keep the WHERE valid
		expect(clause).toBe("geo::distance(location, $p0) >= 0");
		expect(bindings).toEqual({ p0: point });
		expect(nearSort).toBe("ORDER BY geo::distance(location, $p0) ASC");
	});

	test("$nearSphere produces same output as $near", () => {
		const point = { type: "Point", coordinates: [2.3522, 48.8566] };
		const { clause, bindings, nearSort } = translateFilter({
			location: {
				$nearSphere: { $geometry: point, $maxDistance: 10000 },
			},
		});
		expect(clause).toBe("geo::distance(location, $p0) <= $p1");
		expect(bindings).toEqual({ p0: point, p1: 10000 });
		expect(nearSort).toBe("ORDER BY geo::distance(location, $p0) ASC");
	});

	test("$near throws without $geometry", () => {
		expect(() => translateFilter({ location: { $near: {} } })).toThrow(
			"$near/$nearSphere requires $geometry",
		);
	});

	test("$geoWithin combined with other conditions", () => {
		const polygon = {
			type: "Polygon",
			coordinates: [
				[
					[0, 0],
					[3, 6],
					[6, 1],
					[0, 0],
				],
			],
		};
		const { clause, bindings } = translateFilter({
			location: { $geoWithin: { $geometry: polygon } },
			status: "active",
		});
		expect(clause).toBe("location INSIDE $p0 AND status = $p1");
		expect(bindings).toEqual({ p0: polygon, p1: "active" });
	});

	test("regular filter has no nearSort", () => {
		const { nearSort } = translateFilter({ name: "John" });
		expect(nearSort).toBeUndefined();
	});

	// -----------------------------------------------------------------
	// Error handling
	// -----------------------------------------------------------------
	test("throws on unsupported operator", () => {
		expect(() => translateFilter({ x: { $where: "1" } })).toThrow(
			"Unsupported filter operator: $where",
		);
	});
});
