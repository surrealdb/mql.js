/**
 * Bundle of dependencies passed to every collection operation.
 *
 * Holding these in one value object lets the operation modules stay as
 * pure functions (`insertOne(ctx, doc)`, `findOne(ctx, filter)`, …) –
 * easy to compose and easy to test with a fake `QueryExecutor`.
 */

import type { QueryExecutor } from "../surreal/query-executor.ts";
import type { SurrealDialect } from "../translators/dialect/index.ts";
import {
	type TranslateFilterOptions,
	usesTextSearch,
} from "../translators/filter.ts";
import type { Document } from "../types.ts";
import type { IndexRegistry } from "./index-registry.ts";
import { loadTextFields } from "./operations/indexes.ts";

/**
 * Client-wide settings an operation inherits unless it says otherwise.
 *
 * MongoDB's client options are defaults for every operation run through the
 * client, so the two of them this driver can serve are carried here rather than
 * being accepted at construction and quietly forgotten.
 */
export interface ClientDefaults {
	/** `MongoClientOptions.ignoreUndefined`. */
	readonly ignoreUndefined?: boolean;
	/** `MongoClientOptions.timeoutMS`, as a per-operation time budget. */
	readonly timeoutMS?: number;
}

export interface OperationContext {
	/**
	 * Driver port used for every read/write.
	 *
	 * Resolved per operation from the caller's `session`, so it is either the
	 * client's connection or a transaction opened on it. Nothing below this point
	 * knows which — routing the statement *is* what honouring a session means.
	 */
	readonly executor: QueryExecutor;
	/**
	 * True when `executor` is a transaction the caller opened.
	 *
	 * The one thing an operation has to treat differently, and only because of who
	 * resolves a write conflict: outside a transaction this driver re-issues the
	 * statement, while inside one the conflict belongs to the caller's transaction
	 * and only re-running the whole of it can clear the conflict.
	 */
	readonly inTransaction: boolean;
	/**
	 * The client's connection, for the one statement that must not join the
	 * caller's transaction.
	 *
	 * Only the full-text analyzer needs it. SurrealDB does not show a `DEFINE
	 * INDEX` an analyzer defined earlier in the same transaction, so a text index
	 * created inside one could never name the analyzer it requires. That
	 * definition is a database-level `IF NOT EXISTS` prerequisite shared by every
	 * text index rather than any caller's data, so establishing it immediately
	 * costs nothing if the transaction that asked for it rolls back — while the
	 * index itself stays inside the transaction and is rolled back with it.
	 *
	 * One case remains unserved: a `$text` search issued inside the very
	 * transaction that defined the index, whose snapshot predates the analyzer and
	 * so cannot read it. The `DEFINE INDEX` can, and the search works from the
	 * commit onwards.
	 *
	 * Addressed at this collection's database, like `executor`: an analyzer is
	 * defined per database, so the one a text index names has to be defined in the
	 * database that index lives in.
	 *
	 * Equal to `executor` outside a transaction, where the distinction is moot.
	 */
	readonly connection: QueryExecutor;
	/** The user-facing collection (table) name. */
	readonly collectionName: string;
	/** Pre-escaped table identifier ready for SurrealQL splicing. */
	readonly escapedTable: string;
	/** SurrealDB dialect to target (resolved once at connect time). */
	readonly dialect: SurrealDialect;
	/** Per-collection index/text-field state. */
	readonly indexes: IndexRegistry;
	/** Client-wide option defaults this operation inherits, if any. */
	readonly defaults?: ClientDefaults;
}

/**
 * Build the `translateFilter` options for `filter` in this context.
 *
 * Asynchronous because of `$text`: the fields a text search expands to belong to
 * the collection, not to the `Collection` object in hand, and `Db.collection()`
 * returns a new one every call — so a filter using `$text` has its field list
 * read from the server. Filters that do not use `$text` cost no extra round
 * trip, and the reading is cached on the context's registry for reuse.
 */
export async function filterOptionsFor(
	ctx: OperationContext,
	filter?: Document | null,
): Promise<TranslateFilterOptions> {
	if (!ctx.indexes.loaded && usesTextSearch(filter)) {
		await loadTextFields(ctx);
	}

	const fields = ctx.indexes.textFields;
	return {
		textFields: fields.length > 0 ? [...fields] : undefined,
		dialect: ctx.dialect,
		collection: ctx.collectionName,
	};
}
