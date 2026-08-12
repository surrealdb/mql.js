import { describe, expect, test } from "bun:test";
import { Geometry, GeometryPoint, GeometryPolygon } from "surrealdb";
import { MongoInvalidArgumentError } from "../../../src/errors.ts";
import {
	MONGO_EARTH_RADIUS_M,
	SURREAL_EARTH_RADIUS_M,
} from "../../../src/translators/filter/operators/geospatial.ts";
import { translateFilter } from "../../../src/translators/filter.ts";

/**
 * The "the field, or any element of an array field" form the containment
 * operators emit, since MongoDB matches an array of geometries element-wise.
 */
const anyOf = (field: string, test: (target: string) => string) =>
	`((${test(field)}) OR (type::is_array(${field}) AND array::any(${field}, ` +
	`|$__mql_element| (${test("$__mql_element")}))))`;

/**
 * The containment test `$geoWithin: {$geometry: …}` emits.
 *
 * `INSIDE` tests the interior, so it alone would exclude a point sitting exactly
 * on the boundary, which MongoDB counts as within; `INTERSECTS` includes the
 * boundary and, for a point, means precisely "inside or on the edge". The
 * interior test still carries every other stored geometry, for which
 * `INTERSECTS` would also match one merely overlapping the edge.
 */
const contains = (target: string, p: string) =>
	`${target} INSIDE $${p} OR (type::is_point(${target}) AND ${target} INTERSECTS $${p})`;

/** The GeoJSON a bound geometry parameter stands for. */
function geoJson(value: unknown): unknown {
	expect(value).toBeInstanceOf(Geometry);
	return (value as Geometry).toJSON();
}

const NY = { type: "Point", coordinates: [-73.9667, 40.78] } as const;

const MANHATTAN = {
	type: "Polygon",
	coordinates: [
		[
			[-74, 40.7],
			[-73.9, 40.7],
			[-73.9, 40.8],
			[-74, 40.8],
			[-74, 40.7],
		],
	],
} as const;

describe("$geoWithin", () => {
	test("a $geometry polygon becomes a boundary-inclusive containment test", () => {
		const { clause, bindings } = translateFilter({
			location: { $geoWithin: { $geometry: MANHATTAN } },
		});

		expect(clause).toBe(anyOf("location", (t) => contains(t, "p0")));
		// A real SurrealDB geometry, not the plain object: `INSIDE` answers `false`
		// for every polygon when the operand is an ordinary object.
		expect(bindings.p0).toBeInstanceOf(GeometryPolygon);
		expect(geoJson(bindings.p0)).toEqual(MANHATTAN);
	});

	test("a MultiPolygon and a GeometryCollection also enclose an area", () => {
		for (const geometry of [
			{ type: "MultiPolygon", coordinates: [MANHATTAN.coordinates] },
			{ type: "GeometryCollection", geometries: [MANHATTAN] },
		]) {
			const { clause } = translateFilter({
				location: { $geoWithin: { $geometry: geometry } },
			});
			expect(clause).toBe(anyOf("location", (t) => contains(t, "p0")));
		}
	});

	test("a geometry that encloses no area is refused rather than matching nothing", () => {
		for (const geometry of [
			NY,
			{
				type: "LineString",
				coordinates: [
					[0, 0],
					[1, 1],
				],
			},
			{ type: "MultiPoint", coordinates: [[0, 0]] },
			{
				type: "MultiLineString",
				coordinates: [
					[
						[0, 0],
						[1, 1],
					],
				],
			},
		]) {
			expect(() =>
				translateFilter({ location: { $geoWithin: { $geometry: geometry } } }),
			).toThrow(MongoInvalidArgumentError);
		}
	});

	test("$box becomes the ring of the rectangle its corners span", () => {
		const { clause, bindings } = translateFilter({
			location: {
				$geoWithin: {
					$box: [
						[-74, 40.7],
						[-73.9, 40.8],
					],
				},
			},
		});

		// Guarded, and the guard is first: MongoDB's legacy shapes match point-like
		// values only, and SurrealQL's `AND` short-circuits left to right.
		expect(clause).toBe(
			anyOf("location", (t) => `type::is_point(${t}) AND ${t} INTERSECTS $p0`),
		);
		expect(geoJson(bindings.p0)).toEqual(MANHATTAN);
	});

	test("$box corners are normalised, so either diagonal describes the same box", () => {
		const wound = translateFilter({
			location: {
				$geoWithin: {
					$box: [
						[-73.9, 40.8],
						[-74, 40.7],
					],
				},
			},
		});

		expect(geoJson(wound.bindings.p0)).toEqual(MANHATTAN);
	});

	test("$polygon closes the ring the caller left open", () => {
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

		expect(clause).toBe(
			anyOf("location", (t) => `type::is_point(${t}) AND ${t} INTERSECTS $p0`),
		);
		expect(geoJson(bindings.p0)).toEqual({
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

	test("$polygon leaves an already-closed ring alone", () => {
		const { bindings } = translateFilter({
			location: {
				$geoWithin: {
					$polygon: [
						[0, 0],
						[3, 6],
						[6, 0],
						[0, 0],
					],
				},
			},
		});

		expect(geoJson(bindings.p0)).toEqual({
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

	test("$polygon needs three vertices to enclose anything", () => {
		expect(() =>
			translateFilter({
				location: {
					$geoWithin: {
						$polygon: [
							[0, 0],
							[1, 1],
						],
					},
				},
			}),
		).toThrow(/at least 3 points/);
	});

	test("$center is the planar circle written out, not a distance function", () => {
		const { clause, bindings } = translateFilter({
			location: { $geoWithin: { $center: [[-74, 40.74], 0.1] } },
		});

		// The radius is degrees and the circle is flat, which `geo::distance`
		// cannot express: the squared comparison is the definition itself.
		expect(clause).toBe(
			anyOf(
				"location",
				(t) =>
					`type::is_point(${t}) AND ` +
					`(${t}.coordinates[0] - $p0) * (${t}.coordinates[0] - $p0) + ` +
					`(${t}.coordinates[1] - $p1) * (${t}.coordinates[1] - $p1) <= $p2`,
			),
		);
		expect(bindings).toEqual({ p0: -74, p1: 40.74, p2: 0.1 * 0.1 });
	});

	test("$centerSphere compares geo::distance against the radians in metres", () => {
		const { clause, bindings } = translateFilter({
			location: { $geoWithin: { $centerSphere: [[-73.93, 40.82], 0.0025] } },
		});

		expect(clause).toBe(
			anyOf(
				"location",
				(t) => `type::is_point(${t}) AND geo::distance(${t}, $p0) <= $p1`,
			),
		);
		expect(geoJson(bindings.p0)).toEqual({
			type: "Point",
			coordinates: [-73.93, 40.82],
		});
		// An angle times SurrealDB's own radius: the radius cancels out of the
		// comparison, so the bound is exact rather than approximated.
		expect(bindings.p1).toBe(0.0025 * SURREAL_EARTH_RADIUS_M);
	});

	test("a negative radius is refused", () => {
		for (const shape of ["$center", "$centerSphere"]) {
			expect(() =>
				translateFilter({
					location: { $geoWithin: { [shape]: [[0, 0], -1] } },
				}),
			).toThrow(/Radius must be a non-negative number/);
		}
	});

	test("two shapes are refused rather than one of them winning", () => {
		expect(() =>
			translateFilter({
				location: {
					$geoWithin: {
						$box: [
							[0, 0],
							[1, 1],
						],
						$center: [[0, 0], 1],
					},
				},
			}),
		).toThrow(/multiple shapes/);
	});

	test("an unknown shape key is refused rather than ignored", () => {
		expect(() =>
			translateFilter({ location: { $geoWithin: { $sphere: 1 } } }),
		).toThrow(/unknown geo specifier: \$sphere/);
	});

	test("no shape at all is refused", () => {
		expect(() => translateFilter({ location: { $geoWithin: {} } })).toThrow(
			/doesn't have any geometry/,
		);
	});

	test("a $geometry that is not GeoJSON is refused", () => {
		expect(() =>
			translateFilter({
				location: { $geoWithin: { $geometry: { type: "Circle", radius: 5 } } },
			}),
		).toThrow(MongoInvalidArgumentError);
	});

	test("a recognisably-GeoJSON operand with bad coordinates is refused", () => {
		expect(() =>
			translateFilter({
				location: {
					$geoWithin: {
						$geometry: {
							type: "Polygon",
							coordinates: [
								[
									[0, 0],
									[1, 0],
									[1, 1],
								],
							],
						},
					},
				},
			}),
		).toThrow(/at least four positions/);
	});
});

describe("$geoIntersects", () => {
	test("becomes INTERSECTS against a bound geometry", () => {
		const { clause, bindings } = translateFilter({
			area: { $geoIntersects: { $geometry: MANHATTAN } },
		});

		expect(clause).toBe(anyOf("area", (t) => `${t} INTERSECTS $p0`));
		expect(geoJson(bindings.p0)).toEqual(MANHATTAN);
	});

	test("accepts every geometry type, since anything can overlap anything", () => {
		for (const geometry of [
			NY,
			{
				type: "LineString",
				coordinates: [
					[0, 0],
					[1, 1],
				],
			},
			MANHATTAN,
			{ type: "MultiPoint", coordinates: [[0, 0]] },
			{
				type: "MultiLineString",
				coordinates: [
					[
						[0, 0],
						[1, 1],
					],
				],
			},
			{ type: "MultiPolygon", coordinates: [MANHATTAN.coordinates] },
			{ type: "GeometryCollection", geometries: [NY] },
		]) {
			const { clause } = translateFilter({
				area: { $geoIntersects: { $geometry: geometry } },
			});
			expect(clause).toBe(anyOf("area", (t) => `${t} INTERSECTS $p0`));
		}
	});

	test("a legacy shape is refused, as MongoDB refuses it", () => {
		expect(() =>
			translateFilter({
				area: {
					$geoIntersects: {
						$box: [
							[0, 0],
							[1, 1],
						],
					},
				},
			}),
		).toThrow(/\$geoIntersects not supported/);
	});

	test("no $geometry is refused", () => {
		expect(() => translateFilter({ area: { $geoIntersects: {} } })).toThrow(
			/doesn't have any geometry/,
		);
	});
});

describe("$near and $nearSphere", () => {
	test("reports the distance expression rather than an ORDER BY", () => {
		const { clause, bindings, nearDistance } = translateFilter({
			location: { $near: { $geometry: NY } },
		});

		// `ORDER BY geo::distance(...)` is a parse error — SurrealDB's ORDER BY
		// takes a field path — so the expression travels out to be projected under
		// an alias instead.
		expect(nearDistance).toBe("geo::distance(location, $p0)");
		expect(nearDistance).not.toContain("ORDER BY");

		// Without a band, the predicate is still the point guard: the ordering
		// cannot be computed for a document with no point in that field, and
		// MongoDB does not return one either.
		expect(clause).toBe("type::is_point(location)");
		expect(bindings.p0).toBeInstanceOf(GeometryPoint);
		expect(geoJson(bindings.p0)).toEqual(NY);
	});

	test("$maxDistance is a MongoDB metre restated in SurrealDB's metres", () => {
		const { clause, bindings } = translateFilter({
			location: { $near: { $geometry: NY, $maxDistance: 5000 } },
		});

		expect(clause).toBe(
			"type::is_point(location) AND geo::distance(location, $p0) <= $p1",
		);
		// MongoDB measures metres on a 6 378 100 m sphere and `geo::distance` on a
		// 6 371 008.8 m one, so passing the number through would move the boundary
		// by 0.11 % and take the documents nearest it with it.
		expect(bindings.p1).toBe(
			(5000 * SURREAL_EARTH_RADIUS_M) / MONGO_EARTH_RADIUS_M,
		);
		expect(bindings.p1).toBeLessThan(5000);
	});

	test("a band becomes both bounds, in the order MongoDB writes them", () => {
		const { clause, bindings } = translateFilter({
			location: {
				$near: { $geometry: NY, $minDistance: 500, $maxDistance: 3000 },
			},
		});

		expect(clause).toBe(
			"type::is_point(location) AND " +
				"geo::distance(location, $p0) >= $p1 AND " +
				"geo::distance(location, $p0) <= $p2",
		);
		expect(bindings.p1).toBeCloseTo(499.44, 1);
		expect(bindings.p2).toBeCloseTo(2996.66, 1);
	});

	test("$nearSphere with a $geometry point reads its bounds as metres too", () => {
		const sphere = translateFilter({
			location: { $nearSphere: { $geometry: NY, $maxDistance: 5000 } },
		});
		const plain = translateFilter({
			location: { $near: { $geometry: NY, $maxDistance: 5000 } },
		});

		expect(sphere.clause).toBe(plain.clause);
		expect(sphere.bindings.p1).toBe(plain.bindings.p1);
	});

	test("$nearSphere with a coordinate pair reads its bounds as radians", () => {
		const { clause, bindings, nearDistance } = translateFilter({
			location: { $nearSphere: [-73.9667, 40.78], $maxDistance: 0.01 },
		});

		expect(nearDistance).toBe("geo::distance(location, $p0)");
		expect(clause).toBe(
			"type::is_point(location) AND geo::distance(location, $p0) <= $p1",
		);
		expect(geoJson(bindings.p0)).toEqual(NY);
		// An angle needs no earth model to convert: radians times SurrealDB's own
		// radius is exactly the metre distance it would report for that angle.
		expect(bindings.p1).toBe(0.01 * SURREAL_EARTH_RADIUS_M);
	});

	test("$near with a coordinate pair names the index it would need", () => {
		expect(() =>
			translateFilter({ location: { $near: [-73.9667, 40.78] } }),
		).toThrow(/'2d' index/);
	});

	test("a $geometry that is not a Point is refused", () => {
		expect(() =>
			translateFilter({ location: { $near: { $geometry: MANHATTAN } } }),
		).toThrow(/expected a GeoJSON Point/);
	});

	test("an unknown key inside the operand is refused", () => {
		expect(() =>
			translateFilter({ location: { $near: { $geometry: NY, $bogus: 1 } } }),
		).toThrow(/invalid argument in geo near query: \$bogus/);
	});

	test("a negative bound is refused", () => {
		expect(() =>
			translateFilter({
				location: { $near: { $geometry: NY, $maxDistance: -5 } },
			}),
		).toThrow(/\$maxDistance must be non-negative/);
	});

	test("a bound given on both sides of the operator is refused", () => {
		expect(() =>
			translateFilter({
				location: {
					$nearSphere: { $geometry: NY, $maxDistance: 10 },
					$maxDistance: 20,
				},
			}),
		).toThrow(/given twice/);
	});

	test("a bound with no $near to belong to is refused", () => {
		expect(() => translateFilter({ location: { $maxDistance: 20 } })).toThrow(
			/needs a \$near or \$nearSphere/,
		);
	});

	test("two distance orderings in one query are refused", () => {
		expect(() =>
			translateFilter({
				$and: [
					{ a: { $near: { $geometry: NY } } },
					{
						b: { $near: { $geometry: { type: "Point", coordinates: [0, 0] } } },
					},
				],
			}),
		).toThrow(/Too many geoNear expressions/);
	});

	test("$near must be a top-level expression, as it is in MongoDB", () => {
		// Each of these puts the ordering somewhere it cannot hold for every row the
		// query returns: negated, in one branch of a disjunction, or per array
		// element. MongoDB refuses all four with `geo $near must be top-level expr`.
		for (const filter of [
			{ location: { $not: { $near: { $geometry: NY } } } },
			{ $or: [{ location: { $near: { $geometry: NY } } }, { status: "open" }] },
			{ $nor: [{ location: { $near: { $geometry: NY } } }] },
			{ stops: { $elemMatch: { at: { $near: { $geometry: NY } } } } },
		]) {
			expect(() => translateFilter(filter)).toThrow(
				/must be a top-level expression/,
			);
		}
	});

	test("a single-branch $or flattens, so it still carries the ordering", () => {
		// MongoDB accepts exactly this and rejects it as soon as a second branch is
		// added, because one branch is not a disjunction.
		const { nearDistance } = translateFilter({
			$or: [{ location: { $near: { $geometry: NY } } }],
		});
		expect(nearDistance).toBe("geo::distance(location, $p0)");
	});

	test("$and carries the ordering: it holds for every row returned", () => {
		const { nearDistance } = translateFilter({
			$and: [{ location: { $near: { $geometry: NY } } }, { status: "open" }],
		});
		expect(nearDistance).toBe("geo::distance(location, $p0)");
	});

	test("a filter with no $near reports no distance ordering", () => {
		expect(translateFilter({ name: "John" }).nearDistance).toBeUndefined();
	});

	test("composes with other conditions", () => {
		const { clause } = translateFilter({
			status: "open",
			location: { $near: { $geometry: NY, $maxDistance: 1000 } },
		});

		expect(clause).toContain("status = $p0");
		expect(clause).toContain(
			"type::is_point(location) AND geo::distance(location, $p1) <= $p2",
		);
	});
});

describe("field paths", () => {
	test("a nested path is escaped segment by segment", () => {
		const { clause } = translateFilter({
			"place.loc": { $geoWithin: { $geometry: MANHATTAN } },
		});
		expect(clause).toBe(anyOf("place.loc", (t) => contains(t, "p0")));
	});

	test("a path needing quoting is quoted everywhere it appears", () => {
		const { clause } = translateFilter({
			"my loc": { $geoWithin: { $center: [[0, 0], 1] } },
		});

		expect(clause).toBe(
			anyOf(
				"`my loc`",
				(t) =>
					`type::is_point(${t}) AND ` +
					`(${t}.coordinates[0] - $p0) * (${t}.coordinates[0] - $p0) + ` +
					`(${t}.coordinates[1] - $p1) * (${t}.coordinates[1] - $p1) <= $p2`,
			),
		);
	});

	test("a hostile field name cannot escape its quoting", () => {
		const { clause } = translateFilter({
			"x` = 1 OR true OR `": { $near: { $geometry: NY } },
		});
		expect(clause).toBe("type::is_point(`x\\` = 1 OR true OR \\``)");
	});
});
