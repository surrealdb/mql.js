/**
 * How a GeoJSON geometry crosses the SurrealDB boundary.
 *
 * SurrealDB *has* geometry — seven types matching GeoJSON's own, each with a
 * GeoJSON constructor and a GeoJSON `toJSON()` — and its geometry operators
 * (`INSIDE`, `INTERSECTS`, `geo::distance`) work on that type and on nothing
 * else. A GeoJSON object stored as an ordinary object is therefore not merely
 * slower to query: `INSIDE` against it is `false` for every polygon, and
 * `geo::distance` refuses it. So a geometry has to be stored as a geometry, and
 * this module owns that translation in both directions.
 *
 * ## Which side does what
 *
 * Encoding rides the SDK's `valueEncodeVisitor`, alongside the ObjectId rewrite
 * in `bson-codec.ts` — the codec calls it for every value at every depth, which
 * is what makes a geometry work in a top-level field, nested, inside an array,
 * in a `$set` operand and as a filter operand without any of those positions
 * being taught about geometry separately.
 *
 * Decoding joins the document walk in `reviveBsonValues`, alongside the ObjectId
 * rewrite, though for a different reason than ObjectId's. A geometry *is*
 * wire-tagged (CBOR tags 88–94), so `valueDecodeVisitor` does see it — but it
 * also sees a composite geometry's **parts**, one tag at a time, and hands each
 * of them back to the constructor of the geometry enclosing it. Rewriting a
 * `GeometryLine` to GeoJSON there would leave `new GeometryPolygon(…)` holding
 * plain objects where it expects lines, and the decode never finishes: measured
 * against a live server, a `Point` round-tripped and every `Polygon` hung the
 * connection with no error at all. The walk sees each geometry only once it is
 * fully built, which is the only point at which it is safe to rewrite.
 *
 * A geometry consequently reads back as **GeoJSON**, not as the SDK's
 * `GeometryPoint`: that is the value MongoDB returns, it is what a caller will
 * `JSON.stringify`, and it is indistinguishable on the wire from the GeoJSON the
 * caller wrote. A caller who passes a `GeometryPoint` in gets GeoJSON back for
 * the same reason — the two are the same stored value.
 *
 * ## What counts as a geometry
 *
 * A GeoJSON object is a plain object with a `type` and some coordinates, which a
 * caller could perfectly well have written as data — so recognition is narrow,
 * for the reason it is narrow for `$oid`. A value is a geometry only when it is
 *
 *   - a plain object (not a class instance, not an array),
 *   - carrying **exactly two** own keys,
 *   - whose `type` is one of the seven GeoJSON geometry types, and
 *   - whose other key is `coordinates` holding an array — or, for
 *     `GeometryCollection`, `geometries` holding an array.
 *
 * The two-key rule is not fussiness. SurrealDB's geometry holds coordinates and
 * nothing else, so converting `{type, coordinates, name}` would store the object
 * and *drop `name`* — silent data loss on a document that was never a geometry.
 * Requiring the payload to be an array draws the same line from the other side:
 * `{type: "Polygon", coordinates: "see attachment"}` is prose, and is stored as
 * written.
 *
 * Once an object is recognised, coordinates SurrealDB's geometry cannot hold are
 * an **error** rather than a fallback to plain-object storage. Half-formed
 * GeoJSON has only bad outcomes otherwise: stored as an object it would match no
 * geospatial query ever again, and guessed at — closing an open ring, dropping an
 * ordinate — it would hand back something other than what was written.
 *
 * For a malformed geometry MongoDB reaches the same conclusion, once the
 * collection has the `2dsphere` index that makes it queryable: an unclosed ring
 * is rejected on insert there too. Two rules here are stricter than that, and
 * both are stricter because SurrealDB's geometry has nowhere to put the value:
 * a position carrying a third ordinate — GeoJSON's optional altitude, which
 * MongoDB stores and ignores — and a position that is not a pair of finite
 * numbers. Storing the first would mean dropping the altitude a caller wrote.
 */

import {
	Geometry,
	type GeometryCollection,
	type GeometryLine,
	type GeometryMultiLine,
	type GeometryMultiPoint,
	type GeometryMultiPolygon,
	type GeometryPoint,
	type GeometryPolygon,
} from "surrealdb";
import {
	MongoCompatibilityError,
	MongoInvalidArgumentError,
} from "../errors.ts";

/** The geometry types GeoJSON defines and SurrealDB models. */
export const GEOJSON_TYPES = [
	"Point",
	"LineString",
	"Polygon",
	"MultiPoint",
	"MultiLineString",
	"MultiPolygon",
	"GeometryCollection",
] as const;

export type GeoJsonType = (typeof GEOJSON_TYPES)[number];

/** A GeoJSON geometry, as a caller writes it and as a read hands it back. */
export interface GeoJsonGeometry {
	type: GeoJsonType;
	coordinates?: unknown;
	geometries?: unknown;
}

/** The SDK geometry classes, whose union is what `Geometry.fromJSON` returns. */
export type SurrealGeometry =
	| GeometryPoint
	| GeometryLine
	| GeometryPolygon
	| GeometryMultiPoint
	| GeometryMultiLine
	| GeometryMultiPolygon
	| GeometryCollection;

const GEOJSON_TYPE_SET: ReadonlySet<string> = new Set(GEOJSON_TYPES);

/** The key holding a `GeometryCollection`'s members rather than coordinates. */
const COLLECTION_KEY = "geometries";

/** True for an object whose fields this driver may read as data. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Is `value` shaped like a GeoJSON geometry?
 *
 * Shape only — the coordinates inside may still be nonsense, which
 * `toSurrealGeometry` is what reports. Splitting the two is the point: this
 * answers "did the caller mean a geometry", and only if they did is a bad
 * geometry worth an error.
 */
export function isGeoJsonGeometry(value: unknown): value is GeoJsonGeometry {
	if (!isPlainObject(value)) return false;

	const keys = Object.keys(value);
	if (keys.length !== 2 || !keys.includes("type")) return false;

	const type = value.type;
	if (typeof type !== "string" || !GEOJSON_TYPE_SET.has(type)) return false;

	const payloadKey =
		type === "GeometryCollection" ? COLLECTION_KEY : "coordinates";
	return keys.includes(payloadKey) && Array.isArray(value[payloadKey]);
}

/**
 * Refuse a *document* that is itself shaped like a geometry.
 *
 * A document and a value are the same bytes to the codec, so a document whose
 * only fields are `type` and `coordinates` is a geometry by the rule above — and
 * SurrealDB will not accept one where a record's content belongs, answering
 * `Cannot use (0, 0) in a CONTENT clause`. Saying so here names the rule and the
 * way round it instead. The value position is unaffected, which is why nesting
 * the geometry under a field of its own works.
 *
 * MongoDB stores such a document as written, so this is a divergence; it is the
 * price of geometry being queryable at all, and it is confined to a document
 * with no other field in it.
 */
export function rejectGeometryDocument(document: unknown): void {
	if (!isGeoJsonGeometry(document)) return;

	throw new MongoCompatibilityError(
		`A document cannot consist only of '${Object.keys(document).join("' and '")}': that is how a GeoJSON ${document.type} is stored, and SurrealDB cannot hold a geometry where a document belongs. Nest it under a field of its own — {location: {...}} — or give the document another field.`,
	);
}

/** The GeoJSON a decoded SurrealDB geometry stands for. */
export function toGeoJson(geometry: Geometry): GeoJsonGeometry {
	return geometry.toJSON() as GeoJsonGeometry;
}

/**
 * The SurrealDB geometry `value` describes, or `undefined` when `value` is not
 * shaped like a geometry at all.
 *
 * Throws when it is shaped like one but cannot be built — see the module note on
 * why that is an error rather than a fallback.
 */
export function encodeGeoJson(value: unknown): SurrealGeometry | undefined {
	return isGeoJsonGeometry(value) ? toSurrealGeometry(value) : undefined;
}

/**
 * Build the SurrealDB geometry a recognised GeoJSON object describes.
 *
 * The coordinates are validated here rather than left to the SDK, which builds
 * whatever it is handed: `{type: "Point", coordinates: [1]}` becomes a point with
 * one ordinate and `{type: "Polygon", coordinates: []}` a polygon with no ring,
 * neither of which any geometry operator can use.
 */
export function toSurrealGeometry(value: GeoJsonGeometry): SurrealGeometry {
	validateGeometry(value);
	return Geometry.fromJSON(
		value as Parameters<typeof Geometry.fromJSON>[0],
	) as SurrealGeometry;
}

/** Reject a recognised geometry whose coordinates cannot describe one. */
function validateGeometry(value: GeoJsonGeometry): void {
	switch (value.type) {
		case "Point":
			validatePosition(value.coordinates, "Point");
			return;
		case "LineString":
			validateLine(value.coordinates, "LineString");
			return;
		case "Polygon":
			validatePolygon(value.coordinates, "Polygon");
			return;
		case "MultiPoint":
			validateMembers(value.coordinates, "MultiPoint", (member) =>
				validatePosition(member, "MultiPoint"),
			);
			return;
		case "MultiLineString":
			validateMembers(value.coordinates, "MultiLineString", (member) =>
				validateLine(member, "MultiLineString"),
			);
			return;
		case "MultiPolygon":
			validateMembers(value.coordinates, "MultiPolygon", (member) =>
				validatePolygon(member, "MultiPolygon"),
			);
			return;
		case "GeometryCollection":
			validateCollection(value.geometries);
			return;
	}
}

/** A GeoJSON position: exactly two finite ordinates, longitude then latitude. */
function validatePosition(value: unknown, type: GeoJsonType): void {
	if (
		!Array.isArray(value) ||
		value.length !== 2 ||
		!value.every((n) => typeof n === "number" && Number.isFinite(n))
	) {
		throw invalid(
			type,
			"a position must be an array of exactly two finite numbers, [longitude, latitude]",
		);
	}
}

/** A GeoJSON LineString's coordinates: two or more positions. */
function validateLine(value: unknown, type: GeoJsonType): void {
	if (!Array.isArray(value) || value.length < 2) {
		throw invalid(type, "a line must have at least two positions");
	}
	for (const position of value) validatePosition(position, type);
}

/**
 * A GeoJSON Polygon's coordinates: one or more linear rings.
 *
 * A ring is closed, which is what makes it enclose anything: four positions is
 * the fewest that can, since the last repeats the first.
 */
function validatePolygon(value: unknown, type: GeoJsonType): void {
	if (!Array.isArray(value) || value.length === 0) {
		throw invalid(type, "a polygon must have at least one linear ring");
	}

	for (const ring of value) {
		if (!Array.isArray(ring) || ring.length < 4) {
			throw invalid(
				type,
				"a linear ring must have at least four positions, the last repeating the first",
			);
		}
		for (const position of ring) validatePosition(position, type);

		const [first] = ring;
		const last = ring[ring.length - 1];
		if (first[0] !== last[0] || first[1] !== last[1]) {
			throw invalid(
				type,
				"a linear ring must be closed: its first and last positions must be equal",
			);
		}
	}
}

/** A multi-geometry's coordinates: one or more members of the singular type. */
function validateMembers(
	value: unknown,
	type: GeoJsonType,
	validateMember: (member: unknown) => void,
): void {
	if (!Array.isArray(value) || value.length === 0) {
		throw invalid(type, "a multi-geometry must have at least one member");
	}
	for (const member of value) validateMember(member);
}

/**
 * A GeometryCollection's members: one or more geometries.
 *
 * Each member has to be recognisable as a geometry in its own right. A member
 * that is not is an error rather than data, because the collection around it has
 * already said what it is.
 */
function validateCollection(value: unknown): void {
	if (!Array.isArray(value) || value.length === 0) {
		throw invalid(
			"GeometryCollection",
			"a collection must have at least one geometry",
		);
	}

	for (const member of value) {
		if (!isGeoJsonGeometry(member)) {
			throw invalid(
				"GeometryCollection",
				`every member must be a GeoJSON geometry with a 'type' of ${GEOJSON_TYPES.join(", ")} and matching coordinates`,
			);
		}
		validateGeometry(member);
	}
}

function invalid(
	type: GeoJsonType,
	problem: string,
): MongoInvalidArgumentError {
	return new MongoInvalidArgumentError(`Invalid GeoJSON ${type}: ${problem}.`);
}
