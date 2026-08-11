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

/** GeoJSON geometry object. */
export interface GeoJsonGeometry {
	type: string;
	coordinates: unknown;
}

/** Geospatial operators. */
export interface GeospatialOperators {
	$geoWithin?: {
		$geometry?: GeoJsonGeometry;
		$box?: [[number, number], [number, number]];
		$center?: [[number, number], number];
		$centerSphere?: [[number, number], number];
		$polygon?: [number, number][];
	};
	$geoIntersects?: {
		$geometry: GeoJsonGeometry;
	};
	$near?: {
		$geometry: GeoJsonGeometry;
		$maxDistance?: number;
		$minDistance?: number;
	};
	$nearSphere?: {
		$geometry: GeoJsonGeometry;
		$maxDistance?: number;
		$minDistance?: number;
	};
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
