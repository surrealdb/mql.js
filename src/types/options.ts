import type { Document } from "./documents.ts";

/**
 * Direction of a single sort key.
 *
 * Mirrors MongoDB's `SortDirection` (mongodb.d.ts, driver 7.5.0):
 * `1 | -1 | 'asc' | 'desc' | 'ascending' | 'descending'`. The long forms were
 * previously missing here, which let `{ field: 'ascending' }` fall through the
 * translator's `if (dir === 1 || dir === 'asc')` check and sort *descending* —
 * silently reversing the caller's intended order.
 *
 * `{ $meta: string }` is deliberately not modelled: mql.js has no `$meta` sort
 * support, so accepting it in the type would promise something we cannot honour.
 */
export type SortDirection =
	| 1
	| -1
	| "asc"
	| "desc"
	| "ascending"
	| "descending";

/** Sort specification: 1 = ascending, -1 = descending. */
export type Sort =
	| { [key: string]: SortDirection }
	| [string, SortDirection][]
	| string;

/** Projection specification: 1 = include, 0 = exclude. */
export type Projection = { [key: string]: 1 | 0 | boolean };

/** Options for `Collection.find` and `Collection.findOne`. */
export interface FindOptions {
	projection?: Projection;
	sort?: Sort;
	limit?: number;
	skip?: number;
}

/** Options for `Collection.updateOne` and `Collection.updateMany`. */
export interface UpdateOptions {
	upsert?: boolean;
	arrayFilters?: Document[];
}

/** Options for `Collection.replaceOne`. */
export interface ReplaceOptions {
	upsert?: boolean;
}

/** Options for `Collection.findOneAndUpdate`. */
export interface FindOneAndUpdateOptions {
	projection?: Projection;
	sort?: Sort;
	upsert?: boolean;
	returnDocument?: "before" | "after";
	includeResultMetadata?: boolean;
	arrayFilters?: Document[];
}

/** Options for `Collection.findOneAndDelete`. */
export interface FindOneAndDeleteOptions {
	projection?: Projection;
	sort?: Sort;
	includeResultMetadata?: boolean;
}

/** Options for `Collection.findOneAndReplace`. */
export interface FindOneAndReplaceOptions {
	projection?: Projection;
	sort?: Sort;
	upsert?: boolean;
	returnDocument?: "before" | "after";
	includeResultMetadata?: boolean;
}

/** Options for `Collection.countDocuments`. */
export interface CountDocumentsOptions {
	skip?: number;
	limit?: number;
}

/** Options for the `MongoClient` constructor. */
export interface MongoClientOptions {
	/** SurrealDB namespace to use. Defaults to "default". */
	namespace?: string;
	/** SurrealDB database – overrides the database in the connection URL. */
	database?: string;
}

/**
 * Index specification – keys map field names to sort direction (1/-1)
 * or to "text" for full-text search indexes.
 */
export type IndexSpecification = { [key: string]: 1 | -1 | "text" };

/** Options for `Collection.createIndex`. */
export interface CreateIndexOptions {
	/** Custom name for the index. Auto-generated if omitted. */
	name?: string;
}

/** Metadata about an index, as returned by `Collection.listIndexes`. */
export interface IndexDescription {
	name: string;
	key: IndexSpecification;
}
