/**
 * Geospatial operators: `$geoWithin`, `$geoIntersects`, `$near`, `$nearSphere`.
 *
 * SurrealDB answers the containment half of MongoDB's geospatial language
 * directly — `INSIDE` and `INTERSECTS` compare two geometries — and the distance
 * half with `geo::distance`, so the whole surface reduces to producing a real
 * geometry for the query shape (see `geometry-codec.ts`) and knowing which
 * SurrealQL to compare it with.
 *
 * ## Distances, and the two spheres
 *
 * `geo::distance` returns **metres along a sphere** of radius 6 371 008.8 m: a
 * degree of longitude measures 111 195 m at the equator and 55 597 m at 60°N,
 * and the antipodal distance is 20 015 114.4 m, which fixes the radius exactly.
 * MongoDB measures metres on a sphere of radius 6 378 100 m — its `$geoNear`
 * reports 111 318.8 m for a degree of latitude — so the same arc is a different
 * number of metres in each. A metre bound is therefore converted between the two
 * (`toSurrealMetres`) rather than passed through: the caller's `$maxDistance` is
 * a MongoDB metre, and a bound 0.11 % out is a bound that quietly includes or
 * drops the documents nearest the boundary.
 *
 * A radian bound needs no earth at all. `$centerSphere` and legacy-pair
 * `$nearSphere` are angles, so comparing `geo::distance` against
 * `radians × 6 371 008.8` cancels the radius and is exact.
 *
 * ## Containment, and where the boundary falls
 *
 * SurrealDB's `INSIDE` tests the *interior*: a point sitting exactly on a
 * polygon's edge is not inside it. MongoDB counts that point as within — for
 * `$geometry` and for every legacy shape — so `INSIDE` alone answers `false`
 * where MongoDB answers `true`, which is a wrong answer on a boundary rather
 * than a rounding difference. `INTERSECTS` is the operator that includes the
 * boundary, and for a *point* it is exactly MongoDB's `$geoWithin`: a point
 * intersects a polygon precisely when it is inside it or on its edge, and a hole
 * in the polygon excludes the point either way.
 *
 * So containment is tested with `INTERSECTS` wherever the field holds a point —
 * which is every legacy shape, since MongoDB restricts those to point-like
 * values — and with `INSIDE` otherwise, because for a stored line or polygon
 * `INTERSECTS` would also match one merely overlapping the boundary.
 *
 * ## Which field values match
 *
 * `INSIDE` and `INTERSECTS` are total: a field holding a string, or no field at
 * all, is simply not inside anything, so those two need no guard.
 * `geo::distance` is not — it refuses a non-geometry argument outright, and
 * answers `NONE` for a geometry that is not a point, which would then compare
 * *true* against any upper bound. So everything built on distance is guarded by
 * `type::is_point`, and SurrealQL's `AND` short-circuits left to right, which is
 * why the guard is written first and has to stay there.
 *
 * That guard also happens to reproduce MongoDB's own behaviour for the legacy
 * shapes, which match point-like values and nothing else, so `$box`, `$center`,
 * `$centerSphere` and `$polygon` all carry it.
 *
 * ## Array fields
 *
 * MongoDB matches a field holding an *array* of geometries if any element
 * matches, the same way `{tags: "a"}` matches `{tags: ["a", "b"]}`. SurrealDB's
 * operators compare one value, so `$geoWithin` and `$geoIntersects` test the
 * field and, when it is an array, every element — `array::any` with a closure,
 * which is where the guards have to be repeated. Without it a route stored as a
 * list of points would match nothing, silently, which is the failure this whole
 * module exists to remove.
 *
 * `$near` is the exception: it has to *order* by a distance, and there is no one
 * distance for an array of points. It matches a single point per document, which
 * `type::is_point` states.
 */

import { MongoInvalidArgumentError } from "../../../errors.ts";
import {
	type GeoJsonGeometry,
	isGeoJsonGeometry,
	toSurrealGeometry,
} from "../../../surreal/geometry-codec.ts";
import type { Document } from "../../../types.ts";
import type { FilterOperator } from "../operator-registry.ts";
import type { TranslateContext } from "../translate-context.ts";

/** The radius `geo::distance` measures on, established against a live server. */
export const SURREAL_EARTH_RADIUS_M = 6_371_008.8;

/** The radius MongoDB measures a metre distance on. */
export const MONGO_EARTH_RADIUS_M = 6_378_100;

/** A MongoDB metre distance, restated in the metres `geo::distance` returns. */
export function toSurrealMetres(metres: number): number {
	return (metres * SURREAL_EARTH_RADIUS_M) / MONGO_EARTH_RADIUS_M;
}

/** A radian distance, restated in the metres `geo::distance` returns. */
export function radiansToSurrealMetres(radians: number): number {
	return radians * SURREAL_EARTH_RADIUS_M;
}

/** The shape keys `$geoWithin` accepts, in the order they are reported. */
const WITHIN_SHAPES = [
	"$geometry",
	"$box",
	"$center",
	"$centerSphere",
	"$polygon",
] as const;

/** The geometry types that can *contain* another, and so bound a `$geoWithin`. */
const CONTAINING_TYPES = new Set([
	"Polygon",
	"MultiPolygon",
	"GeometryCollection",
]);

/** A `[longitude, latitude]` pair as the legacy shapes spell a point. */
type LegacyPoint = readonly [number, number];

/**
 * The operand of a `$near`/`$nearSphere`, with the bounds that may sit beside it.
 *
 * MongoDB puts `$minDistance`/`$maxDistance` inside the operand for the
 * `$geometry` form and *next to* the operator for the legacy-pair form
 * (`{loc: {$nearSphere: [x, y], $maxDistance: r}}`). Both reach here as one
 * operand so the operator can read them wherever the caller wrote them — the
 * dispatcher pairs them, as it does `$regex` with `$options`.
 */
export interface NearOperand {
	/** What the caller passed as the operator's value. */
	readonly spec: unknown;
	/** A `$minDistance` written beside the operator rather than inside it. */
	readonly siblingMinDistance?: unknown;
	/** A `$maxDistance` written beside the operator rather than inside it. */
	readonly siblingMaxDistance?: unknown;
}

// ---------------------------------------------------------------------------
// $geoWithin
// ---------------------------------------------------------------------------

function translateGeoWithin(
	field: string,
	value: unknown,
	ctx: TranslateContext,
): string {
	const spec = asShapeDocument("$geoWithin", value);
	const shape = soleShape(spec);

	switch (shape) {
		case "$geometry":
			return withinGeometry(field, spec.$geometry, ctx);
		case "$box":
			return pointInRing(field, boxRing(spec.$box), ctx);
		case "$polygon":
			return pointInRing(field, polygonRing(spec.$polygon), ctx);
		case "$center":
			return withinPlanarCircle(field, spec.$center, ctx);
		case "$centerSphere":
			return withinSphericalCircle(field, spec.$centerSphere, ctx);
	}
}

/**
 * `$geoWithin: {$geometry: …}` — the geometry has to be one that encloses an
 * area, which MongoDB refuses a point or a line for and SurrealDB would answer
 * `false` for every document.
 */
function withinGeometry(
	field: string,
	value: unknown,
	ctx: TranslateContext,
): string {
	const geometry = requireGeometry("$geoWithin", value);
	if (!CONTAINING_TYPES.has(geometry.type)) {
		throw new MongoInvalidArgumentError(
			`$geoWithin not supported with provided geometry: a ${geometry.type} encloses no area. Use a Polygon, MultiPolygon or GeometryCollection.`,
		);
	}

	const p = ctx.bind(toSurrealGeometry(geometry));

	// A point on the boundary is within, which only `INTERSECTS` reports; for
	// anything else the interior test is the one that means "contained".
	return anyGeometry(
		field,
		(target) =>
			`${target} INSIDE $${p} OR (${pointGuard(target, ctx)} AND ${target} INTERSECTS $${p})`,
	);
}

/** A legacy shape's ring, restricted to point-valued fields as MongoDB is. */
function pointInRing(
	field: string,
	ring: LegacyPoint[],
	ctx: TranslateContext,
): string {
	const p = ctx.bind(
		toSurrealGeometry({ type: "Polygon", coordinates: [ring] }),
	);
	return anyGeometry(
		field,
		(target) => `${pointGuard(target, ctx)} AND ${target} INTERSECTS $${p}`,
	);
}

/**
 * `$box: [[x1, y1], [x2, y2]]` — the ring of the rectangle those corners span.
 *
 * The corners are normalised because MongoDB accepts them in either order, and a
 * ring wound from unsorted corners crosses itself and encloses nothing.
 */
function boxRing(value: unknown): LegacyPoint[] {
	const corners = legacyPoints("$box", value, 2, 2);
	const [minX, maxX] = minMax(corners[0][0], corners[1][0]);
	const [minY, maxY] = minMax(corners[0][1], corners[1][1]);

	return [
		[minX, minY],
		[maxX, minY],
		[maxX, maxY],
		[minX, maxY],
		[minX, minY],
	];
}

/** `$polygon: [[x, y], …]` — the ring those vertices trace, closed if it is not. */
function polygonRing(value: unknown): LegacyPoint[] {
	const vertices = legacyPoints("$polygon", value, 3);
	const first = vertices[0];
	const last = vertices[vertices.length - 1];

	return first[0] === last[0] && first[1] === last[1]
		? vertices
		: [...vertices, first];
}

/**
 * `$center: [[x, y], r]` — a circle of `r` *degrees*, measured flat.
 *
 * MongoDB's `$center` is a planar circle in coordinate space, which no geometry
 * SurrealDB has can stand for: it is not a spherical cap, so `geo::distance`
 * would answer a different question, and a polygon of enough sides to hide the
 * difference would still be an approximation. The comparison is therefore written
 * out — the squared distance in degrees, against the squared radius — which is
 * the definition itself and needs no approximating.
 *
 * That arithmetic reads the field's own coordinates, so it applies to a point and
 * to nothing else. MongoDB's `$center` matches points and nothing else too.
 */
function withinPlanarCircle(
	field: string,
	value: unknown,
	ctx: TranslateContext,
): string {
	const [centre, radius] = circle("$center", value);
	const x = ctx.bind(centre[0]);
	const y = ctx.bind(centre[1]);
	const squared = ctx.bind(radius * radius);

	return anyGeometry(field, (target) => {
		const dx = `(${target}.coordinates[0] - $${x})`;
		const dy = `(${target}.coordinates[1] - $${y})`;
		return `${pointGuard(target, ctx)} AND ${dx} * ${dx} + ${dy} * ${dy} <= $${squared}`;
	});
}

/**
 * `$centerSphere: [[x, y], r]` — a circle of `r` *radians* on the sphere.
 *
 * Exact rather than approximated: an angle times SurrealDB's own radius is the
 * metre distance `geo::distance` would report for that angle, so the radius
 * cancels out of the comparison.
 */
function withinSphericalCircle(
	field: string,
	value: unknown,
	ctx: TranslateContext,
): string {
	const [centre, radians] = circle("$centerSphere", value);
	const point = bindPoint(centre, ctx);
	const bound = ctx.bind(radiansToSurrealMetres(radians));

	return anyGeometry(
		field,
		(target) =>
			`${pointGuard(target, ctx)} AND geo::distance(${target}, $${point}) <= $${bound}`,
	);
}

// ---------------------------------------------------------------------------
// $geoIntersects
// ---------------------------------------------------------------------------

/**
 * `$geoIntersects: {$geometry: …}` — any geometry, since anything can overlap
 * anything. MongoDB accepts no legacy shape here, and `soleShape` reports the
 * one it was given.
 */
function translateGeoIntersects(
	field: string,
	value: unknown,
	ctx: TranslateContext,
): string {
	const spec = asShapeDocument("$geoIntersects", value);
	const shape = soleShape(spec);

	if (shape !== "$geometry") {
		throw new MongoInvalidArgumentError(
			`$geoIntersects not supported with provided geometry: ${shape} describes a shape, not a geometry. Use $geometry with GeoJSON.`,
		);
	}

	const geometry = requireGeometry("$geoIntersects", spec.$geometry);
	const p = ctx.bind(toSurrealGeometry(geometry));
	return anyGeometry(field, (target) => `${target} INTERSECTS $${p}`);
}

// ---------------------------------------------------------------------------
// $near / $nearSphere
// ---------------------------------------------------------------------------

/**
 * `$near`/`$nearSphere` — a distance ordering, and optionally a distance band.
 *
 * The ordering is handed to the context rather than emitted here, because
 * SurrealDB's `ORDER BY` takes a field path and not an expression: it has to
 * become a projected alias in a subquery, which only the operation building the
 * statement can arrange. See `near-query.ts`.
 *
 * The predicate is self-contained, so an operation that cannot order — a
 * `deleteMany`, a count — still applies the band and the point guard correctly.
 */
function translateNear(
	operator: "$near" | "$nearSphere",
	field: string,
	operand: NearOperand,
	ctx: TranslateContext,
): string {
	const { centre, bounds } = nearTarget(operator, operand);
	const distance = distanceExpression(field, centre, ctx);

	ctx.setNearOrder(distance);

	const conditions = [pointGuard(field, ctx)];
	if (bounds.min !== undefined) {
		conditions.push(`${distance} >= $${ctx.bind(bounds.min)}`);
	}
	if (bounds.max !== undefined) {
		conditions.push(`${distance} <= $${ctx.bind(bounds.max)}`);
	}

	return conditions.join(" AND ");
}

/** A `$near` band, already converted to the metres `geo::distance` returns. */
interface NearBounds {
	min?: number;
	max?: number;
}

/** What a `$near` operand names: the point to measure from, and the band. */
interface NearTarget {
	centre: LegacyPoint;
	bounds: NearBounds;
}

/**
 * Read a `$near`/`$nearSphere` operand, in either of the forms MongoDB takes.
 *
 * The two forms differ in the unit of their bounds, which is the whole reason
 * they are told apart here rather than normalised earlier: a GeoJSON `$geometry`
 * carries metres, a legacy coordinate pair carries radians, and MongoDB reads the
 * same number as one or the other depending on which was written.
 */
function nearTarget(
	operator: "$near" | "$nearSphere",
	operand: NearOperand,
): NearTarget {
	const { spec } = operand;

	if (Array.isArray(spec)) {
		// A legacy pair is measured flat by MongoDB's `$near`, which needs a `2d`
		// index to do it — an index type SurrealDB has no equivalent for and
		// `createIndex` refuses. `$nearSphere` reads the same pair as an angle, which
		// `geo::distance` answers exactly, so that is the form to point at.
		if (operator === "$near") {
			throw new MongoInvalidArgumentError(
				"$near with a [longitude, latitude] pair needs a '2d' index, which SurrealDB has no equivalent of. Use $nearSphere for the same query measured on the sphere, or $near with a $geometry point.",
			);
		}
		return {
			centre: legacyPoint(operator, spec),
			bounds: bounds(operator, operand, {}, radiansToSurrealMetres),
		};
	}

	const nested = asShapeDocument(operator, spec);
	const geometry = requireGeometry(operator, nested.$geometry);
	if (geometry.type !== "Point") {
		throw new MongoInvalidArgumentError(
			`invalid point in geo near query $geometry argument: expected a GeoJSON Point, but got ${geometry.type}.`,
		);
	}
	rejectUnknownNearKeys(nested);

	return {
		centre: geometry.coordinates as LegacyPoint,
		bounds: bounds(operator, operand, nested, toSurrealMetres),
	};
}

/** Every key a `$near` operand may carry beside the point. */
const NEAR_KEYS = new Set(["$geometry", "$minDistance", "$maxDistance"]);

function rejectUnknownNearKeys(spec: Document): void {
	for (const key of Object.keys(spec)) {
		if (!NEAR_KEYS.has(key)) {
			throw new MongoInvalidArgumentError(
				`invalid argument in geo near query: ${key}`,
			);
		}
	}
}

/**
 * The distance band, whichever side of the operator it was written on.
 *
 * A bound given twice is refused rather than one of them silently winning.
 */
function bounds(
	operator: string,
	operand: NearOperand,
	spec: Document,
	convert: (value: number) => number,
): NearBounds {
	const min = soleBound(
		operator,
		"$minDistance",
		spec.$minDistance,
		operand.siblingMinDistance,
	);
	const max = soleBound(
		operator,
		"$maxDistance",
		spec.$maxDistance,
		operand.siblingMaxDistance,
	);

	const result: NearBounds = {};
	if (min !== undefined) result.min = convert(min);
	if (max !== undefined) result.max = convert(max);
	return result;
}

function soleBound(
	operator: string,
	name: string,
	nested: unknown,
	sibling: unknown,
): number | undefined {
	if (nested !== undefined && sibling !== undefined) {
		throw new MongoInvalidArgumentError(
			`${name} given twice for ${operator}: once inside the operator and once beside it.`,
		);
	}

	const value = nested ?? sibling;
	if (value === undefined) return undefined;

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new MongoInvalidArgumentError(`${name} must be non-negative`);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Shared fragments and operand reading
// ---------------------------------------------------------------------------

/**
 * The closure parameter each array element is tested under.
 *
 * Named for this driver so it cannot shadow anything a caller's field path or
 * bound parameter is called.
 */
const ELEMENT = "$__mql_element";

/**
 * Widen a one-value geometry test to MongoDB's "the field, or any element of it".
 *
 * `test` is called twice — once for the field and once for the closure parameter
 * — rather than written out by each caller, so a guard cannot be remembered in
 * one branch and forgotten in the other.
 */
function anyGeometry(field: string, test: (target: string) => string): string {
	return `((${test(field)}) OR (type::is_array(${field}) AND array::any(${field}, |${ELEMENT}| (${test(ELEMENT)}))))`;
}

/** Bind a point to measure distances from, and return its parameter name. */
function bindPoint(centre: LegacyPoint, ctx: TranslateContext): string {
	return ctx.bind(
		toSurrealGeometry({ type: "Point", coordinates: [...centre] }),
	);
}

/** `geo::distance(field, <bound point>)`, the expression everything measures with. */
function distanceExpression(
	field: string,
	centre: LegacyPoint,
	ctx: TranslateContext,
): string {
	return `geo::distance(${field}, $${bindPoint(centre, ctx)})`;
}

/** The guard that keeps a non-point value away from the distance functions. */
function pointGuard(field: string, ctx: TranslateContext): string {
	return ctx.dialect.pointCheck(field);
}

/** The operand of a geospatial operator, which is always a document of shapes. */
function asShapeDocument(operator: string, value: unknown): Document {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		value instanceof Date
	) {
		throw new MongoInvalidArgumentError(
			`${operator} requires a document naming a shape, e.g. {${operator}: {$geometry: {...}}}`,
		);
	}
	return value as Document;
}

/**
 * The one shape key a `$geoWithin`/`$geoIntersects` operand names.
 *
 * MongoDB refuses two shapes rather than picking one, and refuses a key it does
 * not know rather than ignoring it — either would answer a question the caller
 * did not ask.
 */
function soleShape(spec: Document): (typeof WITHIN_SHAPES)[number] {
	const keys = Object.keys(spec);

	if (keys.length === 0) {
		throw new MongoInvalidArgumentError("geo query doesn't have any geometry");
	}
	for (const key of keys) {
		if (!(WITHIN_SHAPES as readonly string[]).includes(key)) {
			throw new MongoInvalidArgumentError(`unknown geo specifier: ${key}`);
		}
	}
	if (keys.length > 1) {
		throw new MongoInvalidArgumentError(
			`geo query doesn't accept multiple shapes: ${keys.join(", ")}`,
		);
	}

	return keys[0] as (typeof WITHIN_SHAPES)[number];
}

/** The GeoJSON a `$geometry` names, refused when it is not GeoJSON at all. */
function requireGeometry(operator: string, value: unknown): GeoJsonGeometry {
	if (!isGeoJsonGeometry(value)) {
		throw new MongoInvalidArgumentError(
			`${operator} requires a GeoJSON geometry: an object with a 'type' of Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon or GeometryCollection and its coordinates.`,
		);
	}
	return value;
}

/** A `[[x, y], r]` circle, with the non-negative radius MongoDB insists on. */
function circle(shape: string, value: unknown): [LegacyPoint, number] {
	if (!Array.isArray(value) || value.length !== 2) {
		throw new MongoInvalidArgumentError(
			`${shape} requires [[longitude, latitude], radius]`,
		);
	}

	const radius = value[1];
	if (typeof radius !== "number" || !Number.isFinite(radius) || radius < 0) {
		throw new MongoInvalidArgumentError(
			`Radius must be a non-negative number: ${String(radius)}`,
		);
	}

	return [legacyPoint(shape, value[0]), radius];
}

/** A list of `[x, y]` pairs, with the count the shape needs. */
function legacyPoints(
	shape: string,
	value: unknown,
	minimum: number,
	maximum?: number,
): LegacyPoint[] {
	if (
		!Array.isArray(value) ||
		value.length < minimum ||
		(maximum !== undefined && value.length > maximum)
	) {
		throw new MongoInvalidArgumentError(
			maximum === minimum
				? `${shape} requires exactly ${minimum} points, each a [longitude, latitude] pair`
				: `${shape} must have at least ${minimum} points, each a [longitude, latitude] pair`,
		);
	}
	return value.map((point) => legacyPoint(shape, point));
}

/** One `[longitude, latitude]` pair. */
function legacyPoint(shape: string, value: unknown): LegacyPoint {
	if (
		!Array.isArray(value) ||
		value.length !== 2 ||
		!value.every((n) => typeof n === "number" && Number.isFinite(n))
	) {
		throw new MongoInvalidArgumentError(
			`${shape} points must only contain numeric elements: [longitude, latitude]`,
		);
	}
	return [value[0], value[1]];
}

function minMax(a: number, b: number): [number, number] {
	return a <= b ? [a, b] : [b, a];
}

export const geospatialOperators: FilterOperator[] = [
	{
		name: "$geoWithin",
		translate(field, value, ctx) {
			return translateGeoWithin(field, value, ctx);
		},
	},
	{
		name: "$geoIntersects",
		translate(field, value, ctx) {
			return translateGeoIntersects(field, value, ctx);
		},
	},
	{
		name: "$near",
		translate(field, value, ctx) {
			return translateNear("$near", field, value as NearOperand, ctx);
		},
	},
	{
		name: "$nearSphere",
		translate(field, value, ctx) {
			return translateNear("$nearSphere", field, value as NearOperand, ctx);
		},
	},
];
