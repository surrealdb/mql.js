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

	/**
	 * Record the distance expression a `$near`/`$nearSphere` orders by.
	 *
	 * An expression rather than an `ORDER BY`, because SurrealDB's `ORDER BY`
	 * takes a field path: the expression has to be projected under an alias in a
	 * subquery, which only the operation assembling the statement can arrange.
	 */
	setNearOrder(distanceExpression: string): void;

	/**
	 * Translate a sub-expression that cannot carry a `$near`.
	 *
	 * A `$near` names an ordering over the whole result set as well as a
	 * predicate, so it has to hold for every row the query returns. Inside a
	 * disjunction it does not: a row matched by the *other* branch of an `$or` need
	 * not have a point in that field at all, and the distance the ordering projects
	 * for it is undefined. MongoDB refuses the same thing with `geo $near must be
	 * top-level expr`, and `setNearOrder` refuses it here.
	 */
	withoutNearOrder<T>(translate: () => T): T;

	/** Translate a field with multiple operators (used by `$not`). */
	translateOperators(field: string, ops: Document): string;
	/** Translate a sub-document (used by `$elemMatch` mixed conditions). */
	translateFieldCondition(field: string, value: unknown): string;
}
