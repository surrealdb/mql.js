/**
 * Per-`translateFilter()`-call context shared between the registry, the
 * top-level walker, and individual operator strategies.
 *
 * Keeping the recursion entry-points on the context (rather than
 * importing the walker directly) avoids cyclic imports between
 * operators and the dispatcher.
 */

import type { Document } from "../../types.ts";
import type { SurrealDialect } from "../dialect/index.ts";

export interface TranslateContext {
	/** SurrealQL dialect to target. */
	readonly dialect: SurrealDialect;
	/** Field names that have a FULLTEXT index (used for `$text`). */
	readonly textFields: string[] | undefined;
	/**
	 * Collection (table) being queried, used to build `RecordId`s for `_id`
	 * conditions. Undefined when the caller did not supply one.
	 */
	readonly collection: string | undefined;

	/** All bindings collected during this call; mutated by operators. */
	readonly bindings: Record<string, unknown>;

	/** Allocate a new parameter name (`p0`, `p1`, …). */
	nextParam(): string;
	/** Bind `value` to a fresh parameter and return the parameter name. */
	bind(value: unknown): string;

	/** Set the implicit ORDER-BY produced by `$near`/`$nearSphere`. */
	setNearSort(orderBy: string): void;

	/** Translate a field with multiple operators (used by `$not`). */
	translateOperators(field: string, ops: Document): string;
	/** Translate a sub-document (used by `$elemMatch` mixed conditions). */
	translateFieldCondition(field: string, value: unknown): string;
}
