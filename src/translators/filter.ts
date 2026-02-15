/**
 * Translates a MongoDB query filter document into a SurrealQL WHERE clause
 * with parameterised bindings.
 *
 * Example:
 *   { name: "John", age: { $gt: 25 } }
 *   →  { clause: "name = $p0 AND age > $p1", bindings: { p0: "John", p1: 25 } }
 */

import type { Document } from "../types.ts";

// ---------------------------------------------------------------------------
// BSON type → SurrealQL type::is_*() mapping
// ---------------------------------------------------------------------------

/** Maps MongoDB BSON type strings and numeric codes to SurrealQL type-check function names. */
const BSON_TYPE_MAP: Record<string | number, string> = {
	// String aliases
	double: "type::is::float",
	string: "type::is::string",
	object: "type::is::object",
	array: "type::is::array",
	bool: "type::is::bool",
	date: "type::is::datetime",
	null: "type::is::null",
	int: "type::is::int",
	long: "type::is::int",
	decimal: "type::is::decimal",
	number: "type::is::number",
	// Numeric BSON type codes
	1: "type::is::float",
	2: "type::is::string",
	3: "type::is::object",
	4: "type::is::array",
	8: "type::is::bool",
	9: "type::is::datetime",
	10: "type::is::null",
	16: "type::is::int",
	18: "type::is::int",
	19: "type::is::decimal",
};

export interface TranslatedFilter {
	/** SurrealQL expression to be used after WHERE (empty string when no filter). */
	clause: string;
	/** Parameterised bindings for the clause. */
	bindings: Record<string, unknown>;
	/**
	 * Optional ORDER BY clause implied by $near / $nearSphere.
	 * When set, results should be sorted by distance ascending
	 * (unless an explicit sort is provided).
	 */
	nearSort?: string;
}

/** Earth's mean radius in metres, used for $centerSphere radian→metre conversion. */
const EARTH_RADIUS_M = 6_378_100;

/** Options for `translateFilter`. */
export interface TranslateFilterOptions {
	/** Fields that have a FULLTEXT index, used for $text queries. */
	textFields?: string[];
}

/** Binding counter – scoped per `translateFilter` call via the context. */
interface Context {
	counter: number;
	textFields?: string[];
	/** Populated by $near / $nearSphere to signal distance-based sorting. */
	nearSort?: string;
}

function nextParam(ctx: Context): string {
	return `p${ctx.counter++}`;
}

/** Escape a field path for use in SurrealQL. Dot-notation passes through as-is. */
function escapeField(field: string): string {
	// SurrealQL supports dot notation natively for nested access.
	// Simple identifier characters + dots are safe as-is.
	return field;
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

/**
 * Translate a MongoDB filter document to a SurrealQL WHERE clause.
 * Returns an empty clause when the filter is empty or undefined.
 */
export function translateFilter(
	filter?: Document | null,
	options?: TranslateFilterOptions,
): TranslatedFilter {
	if (!filter || Object.keys(filter).length === 0) {
		return { clause: "", bindings: {} };
	}

	const ctx: Context = { counter: 0, textFields: options?.textFields };
	const bindings: Record<string, unknown> = {};
	const clause = translateDocument(filter, ctx, bindings);

	const result: TranslatedFilter = { clause, bindings };
	if (ctx.nearSort) {
		result.nearSort = ctx.nearSort;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Internal recursive translation
// ---------------------------------------------------------------------------

/**
 * Translate a top-level filter document. Each key is either a field name
 * or a top-level logical operator ($and, $or, $nor).
 */
function translateDocument(
	doc: Document,
	ctx: Context,
	bindings: Record<string, unknown>,
): string {
	const parts: string[] = [];

	for (const [key, value] of Object.entries(doc)) {
		if (key === "$and") {
			parts.push(
				translateLogicalArray(value as Document[], "AND", ctx, bindings),
			);
		} else if (key === "$or") {
			parts.push(
				translateLogicalArray(value as Document[], "OR", ctx, bindings),
			);
		} else if (key === "$nor") {
			const inner = translateLogicalArray(
				value as Document[],
				"OR",
				ctx,
				bindings,
			);
			parts.push(`NOT (${inner})`);
		} else if (key === "$text") {
			parts.push(translateTextSearch(value as Document, ctx, bindings));
		} else {
			// Field-level condition
			parts.push(translateFieldCondition(key, value, ctx, bindings));
		}
	}

	return parts.join(" AND ");
}

/**
 * Translate $and / $or / $nor arrays.
 */
function translateLogicalArray(
	arr: Document[],
	operator: "AND" | "OR",
	ctx: Context,
	bindings: Record<string, unknown>,
): string {
	const parts = arr.map((sub) => translateDocument(sub, ctx, bindings));
	if (parts.length === 1) return parts[0];
	return `(${parts.join(` ${operator} `)})`;
}

/**
 * Translate a single field condition. The value can be:
 *   - a plain value (implicit $eq)
 *   - an object with operator keys ($gt, $in, $exists, etc.)
 *   - a RegExp (shorthand for $regex)
 */
function translateFieldCondition(
	field: string,
	value: unknown,
	ctx: Context,
	bindings: Record<string, unknown>,
): string {
	const f = escapeField(field);

	// RegExp shorthand: { field: /pattern/ }
	if (value instanceof RegExp) {
		const param = nextParam(ctx);
		bindings[param] = value.source;
		return `${f} ~ $${param}`;
	}

	// Operator object: { field: { $gt: 5, $lt: 10 } }
	if (isOperatorObject(value)) {
		return translateOperators(f, value as Document, ctx, bindings);
	}

	// Implicit equality: { field: value }
	const param = nextParam(ctx);
	bindings[param] = value;
	return `${f} = $${param}`;
}

/**
 * Check whether a value is an operator object (has keys starting with $).
 */
function isOperatorObject(value: unknown): boolean {
	if (value === null || value === undefined || typeof value !== "object") {
		return false;
	}
	if (Array.isArray(value)) return false;
	if (value instanceof RegExp) return false;
	if (value instanceof Date) return false;

	const keys = Object.keys(value as Record<string, unknown>);
	return keys.length > 0 && keys.every((k) => k.startsWith("$"));
}

/**
 * Translate an operator object for a specific field.
 */
function translateOperators(
	field: string,
	operators: Document,
	ctx: Context,
	bindings: Record<string, unknown>,
): string {
	const parts: string[] = [];

	for (const [op, val] of Object.entries(operators)) {
		switch (op) {
			// Comparison
			case "$eq": {
				const p = nextParam(ctx);
				bindings[p] = val;
				parts.push(`${field} = $${p}`);
				break;
			}
			case "$ne": {
				const p = nextParam(ctx);
				bindings[p] = val;
				parts.push(`${field} != $${p}`);
				break;
			}
			case "$gt": {
				const p = nextParam(ctx);
				bindings[p] = val;
				parts.push(`${field} > $${p}`);
				break;
			}
			case "$gte": {
				const p = nextParam(ctx);
				bindings[p] = val;
				parts.push(`${field} >= $${p}`);
				break;
			}
			case "$lt": {
				const p = nextParam(ctx);
				bindings[p] = val;
				parts.push(`${field} < $${p}`);
				break;
			}
			case "$lte": {
				const p = nextParam(ctx);
				bindings[p] = val;
				parts.push(`${field} <= $${p}`);
				break;
			}

			// Array membership
			case "$in": {
				const p = nextParam(ctx);
				bindings[p] = val;
				parts.push(`${field} IN $${p}`);
				break;
			}
			case "$nin": {
				const p = nextParam(ctx);
				bindings[p] = val;
				parts.push(`${field} NOT IN $${p}`);
				break;
			}

			// Element
			case "$exists": {
				if (val) {
					parts.push(`${field} IS NOT NONE`);
				} else {
					parts.push(`${field} IS NONE`);
				}
				break;
			}

			// Evaluation
			case "$regex": {
				const p = nextParam(ctx);
				bindings[p] = val instanceof RegExp ? val.source : String(val);
				parts.push(`${field} ~ $${p}`);
				break;
			}

			// Array operators
			case "$all": {
				const p = nextParam(ctx);
				bindings[p] = val;
				parts.push(`${field} CONTAINSALL $${p}`);
				break;
			}
			case "$size": {
				const p = nextParam(ctx);
				bindings[p] = val;
				parts.push(`array::len(${field}) = $${p}`);
				break;
			}
			case "$elemMatch": {
				parts.push(translateElemMatch(field, val as Document, ctx, bindings));
				break;
			}

			// Type checking
			case "$type": {
				const fn = BSON_TYPE_MAP[val as string | number];
				if (!fn) {
					throw new Error(`Unsupported $type value: ${val}`);
				}
				parts.push(`${fn}(${field})`);
				break;
			}

			// Modulo
			case "$mod": {
				const [divisor, remainder] = val as [number, number];
				const pDiv = nextParam(ctx);
				const pRem = nextParam(ctx);
				bindings[pDiv] = divisor;
				bindings[pRem] = remainder;
				parts.push(`${field} % $${pDiv} = $${pRem}`);
				break;
			}

			// Geospatial operators
			case "$geoWithin": {
				parts.push(translateGeoWithin(field, val as Document, ctx, bindings));
				break;
			}
			case "$geoIntersects": {
				parts.push(
					translateGeoIntersects(field, val as Document, ctx, bindings),
				);
				break;
			}
			case "$near":
			case "$nearSphere": {
				parts.push(translateNear(field, val as Document, ctx, bindings));
				break;
			}

			// Negation wrapper
			case "$not": {
				const inner = translateOperators(field, val as Document, ctx, bindings);
				parts.push(`!(${inner})`);
				break;
			}

			default:
				throw new Error(`Unsupported filter operator: ${op}`);
		}
	}

	return parts.join(" AND ");
}

// ---------------------------------------------------------------------------
// Geospatial operator helpers
// ---------------------------------------------------------------------------

/**
 * Translate $geoWithin – documents whose geometry is entirely within a shape.
 *
 * Supports:
 *  - $geometry (GeoJSON Polygon/MultiPolygon) → field INSIDE $p
 *  - $centerSphere [[lon,lat], radiusRad]     → geo::distance(field, $p) <= radiusMetres
 *  - $center [[x,y], radius]                  → geo::distance(field, $p) <= radius (metres)
 *  - $box [[bl], [tr]]                        → field INSIDE $polygon
 *  - $polygon [[p1],[p2],…]                   → field INSIDE $polygon
 */
function translateGeoWithin(
	field: string,
	val: Document,
	ctx: Context,
	bindings: Record<string, unknown>,
): string {
	if (val.$geometry) {
		// GeoJSON geometry – use INSIDE operator
		const p = nextParam(ctx);
		bindings[p] = val.$geometry;
		return `${field} INSIDE $${p}`;
	}

	if (val.$centerSphere) {
		// Spherical circle: [[lon, lat], radiusInRadians]
		const [center, radiusRad] = val.$centerSphere as [[number, number], number];
		const pCenter = nextParam(ctx);
		const pDist = nextParam(ctx);
		bindings[pCenter] = { type: "Point", coordinates: center };
		bindings[pDist] = radiusRad * EARTH_RADIUS_M;
		return `geo::distance(${field}, $${pCenter}) <= $${pDist}`;
	}

	if (val.$center) {
		// Flat circle: [[x, y], radius]  – radius treated as metres
		const [center, radius] = val.$center as [[number, number], number];
		const pCenter = nextParam(ctx);
		const pDist = nextParam(ctx);
		bindings[pCenter] = { type: "Point", coordinates: center };
		bindings[pDist] = radius;
		return `geo::distance(${field}, $${pCenter}) <= $${pDist}`;
	}

	if (val.$box) {
		// Bounding box [[blX,blY],[trX,trY]] → convert to polygon, use INSIDE
		const [[blX, blY], [trX, trY]] = val.$box as [
			[number, number],
			[number, number],
		];
		const polygon = {
			type: "Polygon",
			coordinates: [
				[
					[blX, blY],
					[trX, blY],
					[trX, trY],
					[blX, trY],
					[blX, blY],
				],
			],
		};
		const p = nextParam(ctx);
		bindings[p] = polygon;
		return `${field} INSIDE $${p}`;
	}

	if (val.$polygon) {
		// Legacy polygon: [[x1,y1],[x2,y2],…] – auto-close ring
		const points = val.$polygon as [number, number][];
		const ring = [...points];
		// Close the ring if not already closed
		const first = ring[0];
		const last = ring[ring.length - 1];
		if (first[0] !== last[0] || first[1] !== last[1]) {
			ring.push([...first] as [number, number]);
		}
		const polygon = { type: "Polygon", coordinates: [ring] };
		const p = nextParam(ctx);
		bindings[p] = polygon;
		return `${field} INSIDE $${p}`;
	}

	throw new Error(
		"$geoWithin requires $geometry, $centerSphere, $center, $box, or $polygon",
	);
}

/**
 * Translate $geoIntersects – documents whose geometry intersects a shape.
 *
 * MongoDB: { field: { $geoIntersects: { $geometry: { type: "Polygon", … } } } }
 * SurrealQL: field INTERSECTS $p
 */
function translateGeoIntersects(
	field: string,
	val: Document,
	ctx: Context,
	bindings: Record<string, unknown>,
): string {
	if (!val.$geometry) {
		throw new Error("$geoIntersects requires $geometry");
	}
	const p = nextParam(ctx);
	bindings[p] = val.$geometry;
	return `${field} INTERSECTS $${p}`;
}

/**
 * Translate $near / $nearSphere – nearest documents to a point.
 *
 * MongoDB: { field: { $near: { $geometry: { type: "Point", … }, $maxDistance: 5000 } } }
 * SurrealQL: geo::distance(field, $p) <= $maxDist  (+ ORDER BY geo::distance ASC)
 *
 * Both $near and $nearSphere use spherical geometry via geo::distance()
 * since SurrealDB always computes haversine distances.
 */
function translateNear(
	field: string,
	val: Document,
	ctx: Context,
	bindings: Record<string, unknown>,
): string {
	if (!val.$geometry) {
		throw new Error("$near/$nearSphere requires $geometry");
	}

	const pPoint = nextParam(ctx);
	bindings[pPoint] = val.$geometry;

	const distExpr = `geo::distance(${field}, $${pPoint})`;

	// Set the distance sort (Collection uses this if no explicit sort)
	ctx.nearSort = `ORDER BY ${distExpr} ASC`;

	const conditions: string[] = [];

	if (val.$minDistance !== undefined) {
		const pMin = nextParam(ctx);
		bindings[pMin] = val.$minDistance;
		conditions.push(`${distExpr} >= $${pMin}`);
	}

	if (val.$maxDistance !== undefined) {
		const pMax = nextParam(ctx);
		bindings[pMax] = val.$maxDistance;
		conditions.push(`${distExpr} <= $${pMax}`);
	}

	// If no distance constraints, the sort alone handles "nearest"
	// but we still need to return a valid clause (always-true condition)
	if (conditions.length === 0) {
		return `${distExpr} >= 0`;
	}

	return conditions.join(" AND ");
}

/**
 * Translate a $text search query.
 *
 * MongoDB: { $text: { $search: "coffee shop" } }
 * SurrealQL: field @@ $p0  (OR'd for multiple text-indexed fields)
 *
 * Requires text fields to be registered via `createIndex()`.
 */
function translateTextSearch(
	textOp: Document,
	ctx: Context,
	bindings: Record<string, unknown>,
): string {
	const search = textOp.$search as string;
	if (typeof search !== "string") {
		throw new Error("$text requires a $search string");
	}

	const fields = ctx.textFields;
	if (!fields || fields.length === 0) {
		throw new Error(
			"$text query requires a text index. Call createIndex() with a 'text' field first.",
		);
	}

	const p = nextParam(ctx);
	bindings[p] = search;

	if (fields.length === 1) {
		return `${fields[0]} @@ $${p}`;
	}

	// Multiple text-indexed fields: OR them together
	const fieldClauses = fields.map((f) => `${f} @@ $${p}`);
	return `(${fieldClauses.join(" OR ")})`;
}

/**
 * Translate $elemMatch for a specific field.
 *
 * Strategy:
 * - For a simple equality object `{ k: v }`, use `field CONTAINS $p`
 * - For operator-based conditions, use the `field[WHERE cond]` syntax
 *   and check that at least one element matched.
 */
function translateElemMatch(
	field: string,
	conditions: Document,
	ctx: Context,
	bindings: Record<string, unknown>,
): string {
	const isAllEquality = Object.keys(conditions).every(
		(k) => !k.startsWith("$") && !isOperatorObject(conditions[k]),
	);

	if (isAllEquality) {
		// Simple equality: { $elemMatch: { k: v, k2: v2 } }
		// → field CONTAINS { k: v, k2: v2 }
		const p = nextParam(ctx);
		bindings[p] = conditions;
		return `${field} CONTAINS $${p}`;
	}

	// Check if all keys are operators (apply to the element itself)
	const isAllOperators = Object.keys(conditions).every((k) =>
		k.startsWith("$"),
	);

	if (isAllOperators) {
		// { $elemMatch: { $gte: 80, $lt: 90 } }
		// Operators apply to each element value directly
		// → array::len(field[WHERE $this >= $p0 AND $this < $p1]) > 0
		const subParts: string[] = [];
		for (const [op, val] of Object.entries(conditions)) {
			subParts.push(
				...translateOperators(
					"$this",
					{ [op]: val } as Document,
					ctx,
					bindings,
				).split(" AND "),
			);
		}
		const whereClause = subParts.join(" AND ");
		return `array::len(${field}[WHERE ${whereClause}]) > 0`;
	}

	// Mixed: field conditions with possible operators on sub-fields
	// { $elemMatch: { score: { $gt: 80 }, grade: "A" } }
	// → array::len(field[WHERE score > $p0 AND grade = $p1]) > 0
	const subParts: string[] = [];
	for (const [key, value] of Object.entries(conditions)) {
		if (isOperatorObject(value)) {
			subParts.push(translateOperators(key, value as Document, ctx, bindings));
		} else {
			const p = nextParam(ctx);
			bindings[p] = value;
			subParts.push(`${key} = $${p}`);
		}
	}

	const whereClause = subParts.join(" AND ");
	return `array::len(${field}[WHERE ${whereClause}]) > 0`;
}
