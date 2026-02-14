import type { ObjectId } from "./object-id.ts";

// ---------------------------------------------------------------------------
// Core document types
// ---------------------------------------------------------------------------

/** Base document type – a plain JSON-like object. */
export interface Document {
	[key: string]: unknown;
}

/**
 * Makes `_id` optional unless the schema explicitly requires it.
 * Mirrors MongoDB's `OptionalUnlessRequiredId`.
 */
export type OptionalId<TSchema extends Document> = TSchema extends {
	_id: unknown;
}
	? TSchema
	: TSchema & { _id?: ObjectId | string | number };

/** Document with `_id` stripped – used for `replaceOne` replacements. */
export type WithoutId<TSchema extends Document> = Omit<TSchema, "_id">;

// ---------------------------------------------------------------------------
// Filter types
// ---------------------------------------------------------------------------

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
}

/** Operators that can be applied to a single field value. */
export type FieldOperators<T = unknown> = ComparisonOperators<T> &
	ElementOperators &
	EvaluationOperators & {
		$not?: FieldOperators<T>;
	};

/**
 * Query filter – either a partial schema match or operator expressions.
 * Mirrors MongoDB's `Filter<TSchema>`.
 */
export type Filter<TSchema extends Document = Document> = {
	[P in keyof TSchema]?: TSchema[P] | FieldOperators<TSchema[P]>;
} & {
	$and?: Filter<TSchema>[];
	$or?: Filter<TSchema>[];
	$nor?: Filter<TSchema>[];
} & {
	/** Allow arbitrary dotted-path keys. */
	[key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Update types
// ---------------------------------------------------------------------------

/** Update operators – mirrors MongoDB's `UpdateFilter`. */
export interface UpdateFilter<TSchema extends Document = Document> {
	$set?: Partial<TSchema> & Document;
	$unset?: { [key: string]: "" | true | 1 };
	$inc?: { [key: string]: number };
	$mul?: { [key: string]: number };
	$min?: { [key: string]: unknown };
	$max?: { [key: string]: unknown };
	$push?: { [key: string]: unknown };
	$pull?: { [key: string]: unknown };
	$addToSet?: { [key: string]: unknown };
	$rename?: { [key: string]: string };
	$currentDate?: { [key: string]: true | { $type: "date" | "timestamp" } };
}

// ---------------------------------------------------------------------------
// Sort / Projection
// ---------------------------------------------------------------------------

/** Sort specification: 1 = ascending, -1 = descending. */
export type Sort =
	| { [key: string]: 1 | -1 | "asc" | "desc" }
	| [string, 1 | -1 | "asc" | "desc"][]
	| string;

/** Projection specification: 1 = include, 0 = exclude. */
export type Projection = { [key: string]: 1 | 0 | boolean };

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface InsertOneResult {
	acknowledged: boolean;
	insertedId: ObjectId | string | number;
}

export interface InsertManyResult {
	acknowledged: boolean;
	insertedCount: number;
	insertedIds: Record<number, ObjectId | string | number>;
}

export interface UpdateResult {
	acknowledged: boolean;
	matchedCount: number;
	modifiedCount: number;
	upsertedId: ObjectId | string | number | null;
	upsertedCount: number;
}

export interface DeleteResult {
	acknowledged: boolean;
	deletedCount: number;
}

export interface ModifyResult<TSchema extends Document = Document> {
	value: TSchema | null;
	ok: number;
}

export interface BulkWriteResult {
	acknowledged: boolean;
	insertedCount: number;
	matchedCount: number;
	modifiedCount: number;
	deletedCount: number;
	upsertedCount: number;
	insertedIds: Record<number, ObjectId | string | number>;
	upsertedIds: Record<number, ObjectId | string | number>;
}

// ---------------------------------------------------------------------------
// Options types
// ---------------------------------------------------------------------------

export interface FindOptions {
	projection?: Projection;
	sort?: Sort;
	limit?: number;
	skip?: number;
}

export interface UpdateOptions {
	upsert?: boolean;
}

export interface ReplaceOptions {
	upsert?: boolean;
}

export interface FindOneAndUpdateOptions {
	projection?: Projection;
	sort?: Sort;
	upsert?: boolean;
	returnDocument?: "before" | "after";
	includeResultMetadata?: boolean;
}

export interface FindOneAndDeleteOptions {
	projection?: Projection;
	sort?: Sort;
	includeResultMetadata?: boolean;
}

export interface FindOneAndReplaceOptions {
	projection?: Projection;
	sort?: Sort;
	upsert?: boolean;
	returnDocument?: "before" | "after";
	includeResultMetadata?: boolean;
}

export interface CountDocumentsOptions {
	skip?: number;
	limit?: number;
}

export interface MongoClientOptions {
	/** SurrealDB namespace to use. Defaults to "default". */
	namespace?: string;
	/** SurrealDB database – overrides the database in the connection URL. */
	database?: string;
}
