import type { ObjectId } from "../object-id.ts";

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

/** Metadata about a collection, as returned by `Db.listCollections`. */
export interface CollectionInfo {
	name: string;
	type: "collection";
}
