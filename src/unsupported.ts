/**
 * The documented edge of the driver: every MongoDB method that exists on this
 * API but cannot be served, and the refusal each one raises.
 *
 * A method the caller can reach has to say something useful when it cannot be
 * served. Leaving it off the class entirely produces
 * `TypeError: col.aggregate is not a function`, which tells a caller only that
 * a property is missing — not whether this driver is broken, out of date, or
 * deliberately narrow. An ORM probing for a capability cannot tell those apart
 * either, so it cannot fall back.
 *
 * Two error classes, chosen by *what the caller addressed*:
 *
 *   - A **method** on `Collection`, `Db` or `MongoClient` is part of this
 *     driver's API, so an unimplemented one raises `MongoCompatibilityError` —
 *     the same class the option gate uses for a request that is valid MongoDB
 *     and that this driver cannot honour. It sits under `MongoAPIError` and
 *     `MongoDriverError`, which is where a driver-side limitation belongs.
 *   - A **command name** passed to `Db.command()` addresses a server command
 *     surface, so an unrouted one raises the `MongoServerError` a real mongod
 *     raises (`59`, `CommandNotFound`) rather than a driver error. That routing
 *     lives in `src/db/run-command.ts`.
 *
 * The refusal also fails in the shape the real method returns. A method
 * MongoDB declares `async` rejects its promise; a method that returns a value
 * synchronously throws synchronously. Which leaves one deliberate divergence,
 * recorded in the README: MongoDB's `aggregate()`, `watch()` and
 * `initialize*BulkOp()` hand back a cursor or a builder *without contacting the
 * server*, so a caller who never iterates never sees an error there, while here
 * the call itself throws. Deferring the failure into iteration would move it
 * away from the call that caused it — and for `watch()` it would have to arrive
 * on the returned stream's `'error'` event, which a caller who never attaches a
 * listener never sees at all.
 */

import { MongoCompatibilityError } from "./errors.ts";

/** Why a feature cannot be served, and where the caller should go instead. */
export interface UnsupportedFeature {
	/** The reason, phrased as the obstacle rather than as a missing to-do. */
	readonly because: string;
	/** The route that does work, so the refusal is actionable. */
	readonly instead: string;
}

/**
 * The aggregation framework.
 *
 * A partial translation is worse than none: a pipeline whose later stages were
 * dropped still returns documents, so the caller gets a plausible wrong answer
 * instead of an error.
 */
export const AGGREGATION: UnsupportedFeature = {
	because:
		"the aggregation pipeline has no SurrealQL translation here, and a partial one would answer with documents that silently ignored the stages it could not translate",
	instead:
		"Use find() with a filter, sort, skip, limit and projection, countDocuments() or distinct() for the single-stage equivalents, or run SurrealQL through the SurrealDB client this driver wraps.",
};

/**
 * Batched writes of mixed models in one call.
 *
 * The gap is not the loop — it is the per-model result accounting and the
 * ordered/unordered failure semantics that `BulkWriteResult` reports.
 */
export const BULK_WRITE: UnsupportedFeature = {
	because:
		"mixing insert, update, replace and delete models into one batch needs the per-model result accounting and the ordered/unordered failure semantics that BulkWriteResult reports, and neither is implemented",
	instead:
		"Call the single-purpose methods, or run them inside session.withTransaction() so they commit or roll back as a unit.",
};

/**
 * Change streams.
 *
 * The obstacle is the resume contract, and only that. Somewhere to deliver the
 * events is not a gap: `MqlEventEmitter` is exported and is what `MongoClient`
 * already extends, so a `ChangeStream` would have an emitter to be built on.
 */
export const CHANGE_STREAMS: UnsupportedFeature = {
	because:
		"SurrealDB's live queries carry a different event shape and no resume token, so a ChangeStream built on them could not be resumed after a disconnect the way callers depend on",
	instead:
		"Subscribe to a SurrealDB live query through the SurrealDB client this driver wraps.",
};

/** Atlas Search and Vector Search index management. */
export const SEARCH_INDEXES: UnsupportedFeature = {
	because:
		"Atlas Search indexes are a MongoDB Atlas service, and there is no SurrealDB counterpart to define one against",
	instead:
		"Use createIndex() with a text index, which this driver defines as a SurrealDB full-text search index.",
};

/** Renaming a collection. */
export const RENAME_COLLECTION: UnsupportedFeature = {
	because:
		"SurrealDB has no statement that renames a table, and copying every record under a new name is not something a rename should do behind the caller's back",
	instead:
		"Create the new collection, copy the documents across yourself, then dropCollection() the old one.",
};

/**
 * The refusal for an unimplemented method.
 *
 * `method` is written as the caller sees it — `Collection.aggregate()` — so the
 * message names the thing that was called rather than the internals behind it.
 */
export function unsupported(
	method: string,
	feature: UnsupportedFeature,
): MongoCompatibilityError {
	return new MongoCompatibilityError(
		`${method} is not implemented by @surrealdb/mql: ${feature.because}. ${feature.instead}`,
	);
}
