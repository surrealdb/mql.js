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
	/** Driver port used for every read/write. */
	readonly executor: QueryExecutor;
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
