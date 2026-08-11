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
 * Direction, or type, of a single index key.
 *
 * Mirrors MongoDB's `IndexDirection` (mongodb.d.ts:5170) exactly, `number`
 * arm included. That arm makes the union effectively unchecked, so
 * `createIndex` validates the value at runtime and rejects anything it cannot
 * map onto a SurrealDB index — `1`, `-1` and `"text"` are the directions this
 * driver can serve.
 */
export type IndexDirection =
	| -1
	| 1
	| "2d"
	| "2dsphere"
	| "text"
	| "geoHaystack"
	| "hashed"
	| number;

/** A resolved index key: field path → direction, in column order. */
export type IndexKey = { [key: string]: IndexDirection };

/** One of the shapes an `IndexSpecification` may take. */
type IndexSpecificationEntry =
	| string
	| readonly [string, IndexDirection]
	| IndexKey
	| Map<string, IndexDirection>;

/**
 * Index specification accepted by `createIndex`.
 *
 * Mirrors MongoDB's `IndexSpecification` (mongodb.d.ts:5196), so every form the
 * official driver documents is accepted: `'e'`, `{a: 1, b: -1}`,
 * `[['c', 1], ['d', -1]]`, `['f', 'g']`, `[{h: 1}, {i: -1}]` and `Map`s.
 */
export type IndexSpecification =
	| IndexSpecificationEntry
	| readonly IndexSpecificationEntry[];

/**
 * Locale-aware string comparison settings.
 *
 * Mirrors MongoDB's `CollationOptions`. Named so consumers can reference the
 * type, but collation itself is rejected: SurrealDB compares strings by code
 * point, and quietly ignoring a locale would change which documents an index
 * considers equal.
 */
export interface CollationOptions {
	locale: string;
	caseLevel?: boolean;
	caseFirst?: string;
	strength?: number;
	numericOrdering?: boolean;
	alternate?: string;
	maxVariable?: string;
	backwards?: boolean;
	normalization?: boolean;
}

/**
 * Options for `Collection.createIndex` and `Collection.createIndexes`.
 *
 * The full `CreateIndexesOptions` surface from mongodb.d.ts:3718 is modelled,
 * because a silently dropped option is worse than a rejected one: a caller who
 * asks for a TTL index and gets a plain one has a data-retention bug, not a
 * compatibility gap. Each field is therefore honoured, deliberately ignored, or
 * rejected — see `assertSupportedIndexOptions` in
 * `src/collection/index-definition.ts` for the per-option policy and reasons.
 */
export interface CreateIndexesOptions {
	/** Override the auto-generated index name. Honoured. */
	name?: string;
	/** Create a unique index. Honoured, as SurrealDB's `UNIQUE`. */
	unique?: boolean;
	/** Free-text comment stored with the index. Honoured. */
	comment?: unknown;
	/** Only index documents that contain the key. Honoured when `true`. */
	sparse?: boolean;
	/** Build the index in the background. Ignored, as on MongoDB 4.2+. */
	background?: boolean;
	/** Index format version. Ignored. */
	version?: number;
	/** Replica-set index-build acknowledgement. Ignored. */
	commitQuorum?: number | string;
	/** Per-index storage-engine configuration. Ignored. */
	storageEngine?: Document;
	/** Full-text index format version. Ignored. */
	textIndexVersion?: number;
	/** 2dsphere index format version. Ignored. */
	"2dsphereIndexVersion"?: number;
	/** Geohash precision for `2d` indexes. Ignored. */
	bits?: number;
	/** Lower co-ordinate bound for `2d` indexes. Ignored. */
	min?: number;
	/** Upper co-ordinate bound for `2d` indexes. Ignored. */
	max?: number;
	/** `geoHaystack` bucket width. Ignored. */
	bucketSize?: number;
	/** Seconds after which a document expires. Rejected — no TTL clause. */
	expireAfterSeconds?: number;
	/** Restrict the index to matching documents. Rejected. */
	partialFilterExpression?: Document;
	/** Locale-aware comparison. Rejected. */
	collation?: CollationOptions;
	/** Per-field full-text scoring weights. Rejected. */
	weights?: Document;
	/** Stemming language for a full-text index. Rejected. */
	default_language?: string;
	/** Field naming a per-document full-text language. Rejected. */
	language_override?: string;
	/** Hide the index from the query planner. Rejected when `true`. */
	hidden?: boolean;
	/** Fields a wildcard index covers. Rejected. */
	wildcardProjection?: Document;
}

/**
 * @deprecated Use `CreateIndexesOptions`, which is what the official driver
 * calls this. Retained as an alias so existing annotations keep compiling.
 */
export type CreateIndexOptions = CreateIndexesOptions;

/**
 * One index in a `createIndexes` batch.
 *
 * Mirrors MongoDB's `IndexDescription` (mongodb.d.ts:5147): the per-index
 * options are the same ones `createIndex` takes, with the key alongside them.
 */
export interface IndexDescription extends Omit<CreateIndexesOptions, "name"> {
	name?: string;
	key: IndexKey | Map<string, IndexDirection>;
}

/**
 * One index as reported by `listIndexes`.
 *
 * Mirrors MongoDB's `IndexDescriptionInfo` (mongodb.d.ts:5163). `v` is declared
 * because the official driver reports it, but this driver omits it: it is a
 * MongoDB on-disk format number with no SurrealDB counterpart, and a
 * plausible-looking `2` would be fabricated.
 */
export type IndexDescriptionInfo = Omit<IndexDescription, "key" | "version"> & {
	name: string;
	key: IndexKey;
	v?: number;
} & Document;

/**
 * The compact form `indexInformation()` returns: index name → its key as
 * `[field, direction]` pairs. Mirrors mongodb.d.ts:5158.
 */
export type IndexDescriptionCompact = Record<
	string,
	[name: string, direction: IndexDirection][]
>;

/** Options for `Collection.listIndexes`, `indexes` and `indexExists`. */
// biome-ignore lint/suspicious/noEmptyInterface: mirrors the driver's own placeholder for cursor options this driver has no use for yet
export interface ListIndexesOptions {}

/** Options for `Collection.indexInformation`. Mirrors mongodb.d.ts:5173. */
export interface IndexInformationOptions extends ListIndexesOptions {
	/**
	 * When `true`, return full index descriptions instead of the compact
	 * name → key-pairs mapping.
	 */
	full?: boolean;
}

/** Options for `Collection.dropIndex` and `Collection.dropIndexes`. */
// biome-ignore lint/suspicious/noEmptyInterface: the driver's own options here are all command-level concerns this driver does not model
export interface DropIndexesOptions {}
