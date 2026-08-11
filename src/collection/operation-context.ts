/**
 * Bundle of dependencies passed to every collection operation.
 *
 * Holding these in one value object lets the operation modules stay as
 * pure functions (`insertOne(ctx, doc)`, `findOne(ctx, filter)`, …) –
 * easy to compose and easy to test with a fake `QueryExecutor`.
 */

import type { QueryExecutor } from "../surreal/query-executor.ts";
import type { SurrealDialect } from "../translators/dialect/index.ts";
import type { TranslateFilterOptions } from "../translators/filter.ts";
import type { IndexRegistry } from "./index-registry.ts";

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
}

/** Build the `translateFilter` options from the current operation context. */
export function filterOptionsFor(
	ctx: OperationContext,
): TranslateFilterOptions {
	const fields = ctx.indexes.textFields;
	return {
		textFields: fields.length > 0 ? [...fields] : undefined,
		dialect: ctx.dialect,
		collection: ctx.collectionName,
	};
}
