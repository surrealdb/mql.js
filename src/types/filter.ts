import type { Document } from "./documents.ts";

/** Comparison operators applicable to a single field. */
export interface ComparisonOperators<T = unknown> {
	$eq?: T;
	$ne?: T;
	$gt?: T;
	$gte?: T;
	$lt?: T;
	$lte?: T;
	$in?: T[];
	$nin?: T[];
}

/** Element operators. */
export interface ElementOperators {
	$exists?: boolean;
}

/** Evaluation operators. */
export interface EvaluationOperators {
	$regex?: RegExp | string;
	$type?: string | number;
	$mod?: [number, number];
}

/** Array operators. */
export interface ArrayOperators {
	$all?: unknown[];
	$elemMatch?: Document;
	$size?: number;
}

/** A `[longitude, latitude]` position, the order GeoJSON writes it in. */
export type Position = [number, number];

/**
 * A GeoJSON geometry, as this driver stores it and hands it back.
 *
 * The seven types SurrealDB models, which are GeoJSON's own. Written as a union
 * rather than as `{type: string; coordinates: unknown}` because the driver's
 * recognition rule is exactly this shape — a plain object with a known `type` and
 * matching coordinates, and no other field — so a type that admitted more would
 * describe values that are stored as ordinary data instead. See "Geospatial" in
 * the README.
 */
export type GeoJsonGeometry =
	| { type: "Point"; coordinates: Position }
	| { type: "LineString"; coordinates: Position[] }
	| { type: "Polygon"; coordinates: Position[][] }
	| { type: "MultiPoint"; coordinates: Position[] }
	| { type: "MultiLineString"; coordinates: Position[][] }
	| { type: "MultiPolygon"; coordinates: Position[][][] }
	| { type: "GeometryCollection"; geometries: GeoJsonGeometry[] };

/** The distance band a `$near`/`$nearSphere` may carry. */
export interface DistanceBounds {
	/** Lower bound: metres for a `$geometry` point, radians for a legacy pair. */
	$minDistance?: number;
	/** Upper bound: metres for a `$geometry` point, radians for a legacy pair. */
	$maxDistance?: number;
}

/** Geospatial operators. */
export interface GeospatialOperators extends DistanceBounds {
	$geoWithin?: {
		$geometry?: GeoJsonGeometry;
		$box?: [Position, Position];
		$center?: [Position, number];
		$centerSphere?: [Position, number];
		$polygon?: Position[];
	};
	$geoIntersects?: {
		$geometry: GeoJsonGeometry;
	};
	$near?: { $geometry: GeoJsonGeometry } & DistanceBounds;
	/**
	 * A GeoJSON point, or the legacy `[longitude, latitude]` pair — whose
	 * `$minDistance`/`$maxDistance` sit beside the operator and are read as
	 * radians, as MongoDB reads them.
	 */
	$nearSphere?: ({ $geometry: GeoJsonGeometry } & DistanceBounds) | Position;
}

/** Operators that can be applied to a single field value. */
export type FieldOperators<T = unknown> = ComparisonOperators<T> &
	ElementOperators &
	EvaluationOperators &
	ArrayOperators &
	GeospatialOperators & {
		$not?: FieldOperators<T>;
	};

/**
 * The element type of an array field, and `never` for anything else.
 *
 * Written with the `[T] extends [_]` form so a union field type is asked the
 * question as a whole rather than member by member: distributing would split
 * `ObjectId | string | number` into three separate conditions, and an `$in`
 * listing an ObjectId *and* a number would stop compiling.
 */
type ElementOf<T> = [NonNullable<T>] extends [ReadonlyArray<infer U>]
	? U
	: never;

/**
 * What one field may be compared against, mirroring MongoDB's `Condition`.
 *
 * An array field also accepts a single element, because MongoDB's equality
 * matches an array that *contains* the value — `{editors: id}` finds a document
 * whose `editors` holds that id — and this driver translates it that way. Typing
 * only the whole array would make the commonest array query uncompilable.
 */
export type Condition<T> = T | ElementOf<T> | FieldOperators<T>;

/**
 * Query filter – either a partial schema match or operator expressions.
 * Mirrors MongoDB's `Filter<TSchema>`.
 */
export type Filter<TSchema extends Document = Document> = {
	[P in keyof TSchema]?: Condition<TSchema[P]>;
} & {
	$and?: Filter<TSchema>[];
	$or?: Filter<TSchema>[];
	$nor?: Filter<TSchema>[];
	$text?: {
		$search: string;
		$language?: string;
		$caseSensitive?: boolean;
		$diacriticSensitive?: boolean;
	};
} & {
	/** Allow arbitrary dotted-path keys. */
	[key: string]: unknown;
};
