/**
 * Geospatial operators: $geoWithin, $geoIntersects, $near, $nearSphere.
 *
 * MongoDB shapes are translated to SurrealDB's native geo functions and
 * GeoJSON-aware comparison operators (INSIDE / INTERSECTS / geo::distance).
 */

import type { Document } from "../../../types.ts";
import type { FilterOperator } from "../operator-registry.ts";
import type { TranslateContext } from "../translate-context.ts";

/** Earth's mean radius in metres, used for $centerSphere radian→metre conversion. */
const EARTH_RADIUS_M = 6_378_100;

function translateGeoWithin(
	field: string,
	val: Document,
	ctx: TranslateContext,
): string {
	if (val.$geometry) {
		const p = ctx.bind(val.$geometry);
		return `${field} INSIDE $${p}`;
	}

	if (val.$centerSphere) {
		const [center, radiusRad] = val.$centerSphere as [[number, number], number];
		const pCenter = ctx.bind({ type: "Point", coordinates: center });
		const pDist = ctx.bind(radiusRad * EARTH_RADIUS_M);
		return `geo::distance(${field}, $${pCenter}) <= $${pDist}`;
	}

	if (val.$center) {
		const [center, radius] = val.$center as [[number, number], number];
		const pCenter = ctx.bind({ type: "Point", coordinates: center });
		const pDist = ctx.bind(radius);
		return `geo::distance(${field}, $${pCenter}) <= $${pDist}`;
	}

	if (val.$box) {
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
		const p = ctx.bind(polygon);
		return `${field} INSIDE $${p}`;
	}

	if (val.$polygon) {
		const points = val.$polygon as [number, number][];
		const ring = [...points];
		const first = ring[0];
		const last = ring[ring.length - 1];
		if (first[0] !== last[0] || first[1] !== last[1]) {
			ring.push([...first] as [number, number]);
		}
		const p = ctx.bind({ type: "Polygon", coordinates: [ring] });
		return `${field} INSIDE $${p}`;
	}

	throw new Error(
		"$geoWithin requires $geometry, $centerSphere, $center, $box, or $polygon",
	);
}

function translateGeoIntersects(
	field: string,
	val: Document,
	ctx: TranslateContext,
): string {
	if (!val.$geometry) {
		throw new Error("$geoIntersects requires $geometry");
	}
	const p = ctx.bind(val.$geometry);
	return `${field} INTERSECTS $${p}`;
}

function translateNear(
	field: string,
	val: Document,
	ctx: TranslateContext,
): string {
	if (!val.$geometry) {
		throw new Error("$near/$nearSphere requires $geometry");
	}

	const pPoint = ctx.bind(val.$geometry);
	const distExpr = `geo::distance(${field}, $${pPoint})`;

	ctx.setNearSort(`ORDER BY ${distExpr} ASC`);

	const conditions: string[] = [];

	if (val.$minDistance !== undefined) {
		const pMin = ctx.bind(val.$minDistance);
		conditions.push(`${distExpr} >= $${pMin}`);
	}
	if (val.$maxDistance !== undefined) {
		const pMax = ctx.bind(val.$maxDistance);
		conditions.push(`${distExpr} <= $${pMax}`);
	}

	if (conditions.length === 0) {
		return `${distExpr} >= 0`;
	}
	return conditions.join(" AND ");
}

export const geospatialOperators: FilterOperator[] = [
	{
		name: "$geoWithin",
		translate(field, value, ctx) {
			return translateGeoWithin(field, value as Document, ctx);
		},
	},
	{
		name: "$geoIntersects",
		translate(field, value, ctx) {
			return translateGeoIntersects(field, value as Document, ctx);
		},
	},
	{
		name: "$near",
		translate(field, value, ctx) {
			return translateNear(field, value as Document, ctx);
		},
	},
	{
		name: "$nearSphere",
		translate(field, value, ctx) {
			return translateNear(field, value as Document, ctx);
		},
	},
];
