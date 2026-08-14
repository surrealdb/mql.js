/**
 * The types that appear in the signatures of the methods this driver declares
 * but does not implement.
 *
 * They exist so those signatures can be the *final* ones — the same parameters
 * and the same return type the method will have once it is real — which is what
 * makes filling one in an additive change rather than a breaking one. Each is
 * modelled on `mongodb.d.ts` with the line cited.
 *
 * None is exported from `src/index.ts`, and that is deliberate. A public export
 * is a name frozen at 1.0.0 that has to be kept afterwards, and the lesson of
 * the `BulkWriteResult` export — a type nothing in the driver could produce —
 * is that adding more of them costs later freedom for no present use. A caller
 * cannot do anything with an `AggregationCursor` this driver never returns, so
 * the name stays internal until there is something behind it. `BulkWriteResult`
 * itself is the exception: it is already exported, and un-exporting it is the
 * breaking change we would have to undo.
 *
 * The placeholder result types are declared without members on purpose. Adding
 * members later is additive; declaring a full cursor API now would be inventing
 * a surface nothing implements.
 */

import type { Document, OptionalId, WithoutId } from "./documents.ts";
import type { Filter } from "./filter.ts";
import type {
	CollationOptions,
	CommandOperationOptions,
	Hint,
	Sort,
} from "./options.ts";
import type { UpdateFilter } from "./update.ts";

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Options for `aggregate`. Mirrors MongoDB's `AggregateOptions` (mongodb.d.ts:451). */
export interface AggregateOptions extends CommandOperationOptions {
	/** Let the server spill temporary results to disk. */
	allowDiskUse?: boolean;
	/** Documents per batch. */
	batchSize?: number;
	/** Skip document-level validation on a `$out`/`$merge` write. */
	bypassDocumentValidation?: boolean;
	/** Cursor configuration for the `aggregate` command. */
	cursor?: Document;
	/** Time a tailable `getMore` waits for data. */
	maxAwaitTimeMS?: number;
	/** Index to force for the first stage. */
	hint?: Hint;
	/** `$$var` bindings available to the pipeline. */
	let?: Document;
	/** Collection `$out` writes into. */
	out?: string;
}

// ---------------------------------------------------------------------------
// Change streams
// ---------------------------------------------------------------------------

/** A change-stream resume token. Mirrors MongoDB's `ResumeToken` (mongodb.d.ts:7826). */
export type ResumeToken = unknown;

/**
 * Options for `watch`. Mirrors MongoDB's `ChangeStreamOptions`
 * (mongodb.d.ts:1492).
 */
export interface ChangeStreamOptions
	extends Omit<AggregateOptions, "writeConcern"> {
	/** Whether an update event carries the post-image of the document. */
	fullDocument?: string;
	/** Whether an update or delete event carries the pre-image of the document. */
	fullDocumentBeforeChange?: string;
	/** Resume immediately after the event this token names. */
	resumeAfter?: ResumeToken;
	/** Resume after the event this token names, including an invalidating one. */
	startAfter?: ResumeToken;
	/** Start from a cluster time rather than from a token. */
	startAtOperationTime?: unknown;
	/** Include DDL events such as `createIndexes` and `modify`. */
	showExpandedEvents?: boolean;
}

/**
 * One change event. Mirrors MongoDB's `ChangeStreamDocument`
 * (mongodb.d.ts:1321).
 */
export interface ChangeStreamDocument<TSchema extends Document = Document>
	extends Document {
	/** @internal Keeps the parameter used, so the type is not silently structural. */
	readonly _changeStreamSchema?: TSchema;
}

/**
 * The stream `watch` returns.
 *
 * In MongoDB this extends an event emitter; this driver has none, which is part
 * of why change streams are refused rather than approximated.
 */
export interface ChangeStream<
	TSchema extends Document = Document,
	TChange extends Document = ChangeStreamDocument<TSchema>,
> {
	/** @internal Keeps the parameters used, so the type is not silently structural. */
	readonly _changeStreamTypes?: readonly [TSchema, TChange];
}

// ---------------------------------------------------------------------------
// Bulk writes
// ---------------------------------------------------------------------------

/** Mirrors MongoDB's `InsertOneModel` (mongodb.d.ts:5222). */
export interface InsertOneModel<TSchema extends Document = Document> {
	document: OptionalId<TSchema>;
}

/** Mirrors MongoDB's `ReplaceOneModel` (mongodb.d.ts:7790). */
export interface ReplaceOneModel<TSchema extends Document = Document> {
	filter: Filter<TSchema>;
	replacement: WithoutId<TSchema>;
	collation?: CollationOptions;
	hint?: Hint;
	upsert?: boolean;
	sort?: Sort;
}

/** Mirrors MongoDB's `UpdateOneModel` (mongodb.d.ts:8814). */
export interface UpdateOneModel<TSchema extends Document = Document> {
	filter: Filter<TSchema>;
	update: UpdateFilter<TSchema> | Document[];
	arrayFilters?: Document[];
	collation?: CollationOptions;
	hint?: Hint;
	upsert?: boolean;
	sort?: Sort;
}

/** Mirrors MongoDB's `UpdateManyModel` (mongodb.d.ts:8794). */
export interface UpdateManyModel<TSchema extends Document = Document> {
	filter: Filter<TSchema>;
	update: UpdateFilter<TSchema> | Document[];
	arrayFilters?: Document[];
	collation?: CollationOptions;
	hint?: Hint;
	upsert?: boolean;
}

/** Mirrors MongoDB's `DeleteOneModel` (mongodb.d.ts:4171). */
export interface DeleteOneModel<TSchema extends Document = Document> {
	filter: Filter<TSchema>;
	collation?: CollationOptions;
	hint?: Hint;
}

/** Mirrors MongoDB's `DeleteManyModel` (mongodb.d.ts:4161). */
export interface DeleteManyModel<TSchema extends Document = Document> {
	filter: Filter<TSchema>;
	collation?: CollationOptions;
	hint?: Hint;
}

/**
 * One entry of a `bulkWrite` batch. Mirrors MongoDB's
 * `AnyBulkWriteOperation` (mongodb.d.ts:599).
 */
export type AnyBulkWriteOperation<TSchema extends Document = Document> =
	| { insertOne: InsertOneModel<TSchema> }
	| { replaceOne: ReplaceOneModel<TSchema> }
	| { updateOne: UpdateOneModel<TSchema> }
	| { updateMany: UpdateManyModel<TSchema> }
	| { deleteOne: DeleteOneModel<TSchema> }
	| { deleteMany: DeleteManyModel<TSchema> };

/**
 * The builder `initializeOrderedBulkOp` returns. Mirrors MongoDB's
 * `OrderedBulkOperation` (mongodb.d.ts:7536).
 */
export interface OrderedBulkOperation {
	/** @internal Distinguishes the ordered builder from the unordered one. */
	readonly _ordered?: true;
}

/**
 * The builder `initializeUnorderedBulkOp` returns. Mirrors MongoDB's
 * `UnorderedBulkOperation` (mongodb.d.ts:8713).
 */
export interface UnorderedBulkOperation {
	/** @internal Distinguishes the unordered builder from the ordered one. */
	readonly _ordered?: false;
}

// ---------------------------------------------------------------------------
// Atlas Search indexes
// ---------------------------------------------------------------------------

/**
 * An Atlas Search index specification. Mirrors MongoDB's
 * `SearchIndexDescription` (mongodb.d.ts:7981).
 */
export interface SearchIndexDescription extends Document {
	name?: string;
	definition: Document;
	type?: string;
}

/**
 * Options for `listSearchIndexes`. Mirrors MongoDB's
 * `ListSearchIndexesOptions` (mongodb.d.ts:5419).
 */
export type ListSearchIndexesOptions = Omit<
	AggregateOptions,
	"readConcern" | "writeConcern"
>;

/** The cursor `listSearchIndexes` returns. */
export interface ListSearchIndexesCursor {
	/** @internal Keeps the type nominal rather than matching any empty object. */
	readonly _listSearchIndexesCursor?: true;
}

// ---------------------------------------------------------------------------
// Renaming
// ---------------------------------------------------------------------------

/**
 * Options for `rename` and `renameCollection`. Mirrors MongoDB's
 * `RenameOptions` (mongodb.d.ts:7777).
 */
export interface RenameOptions extends CommandOperationOptions {
	/** Drop the target collection first if it already exists. */
	dropTarget?: boolean;
	/** Dead in the official driver since 4.x; declared for signature parity. */
	new_collection?: boolean;
}
