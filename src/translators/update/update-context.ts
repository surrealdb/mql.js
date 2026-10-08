/**
 * Per-`translateUpdate()` mutable context shared across operator handlers.
 *
 * `parts` accumulates `field = expr` fragments that will eventually be
 * joined into the SurrealQL `SET` clause; `bindings` collects the
 * parameters referenced from those fragments.
 */

import type { Document } from "../../types.ts";
import type { SurrealDialect } from "../dialect/index.ts";
import type { PositionalUpdate } from "./positional.ts";

export interface UpdateContext {
	/** Bindings produced so far. Mutated in place by operators. */
	readonly bindings: Record<string, unknown>;
	/** SET-clause fragments to be joined with `, ` at the end. */
	readonly parts: string[];
	/** Optional arrayFilters (used by `$[identifier]` positional updates). */
	readonly arrayFilters: Document[] | undefined;
	/**
	 * SurrealQL dialect to target. A `$pull` or `arrayFilters` condition is a
	 * MongoDB query predicate applied to an array element, and is spelled by the
	 * filter translator's builders, whose type checks come from the dialect.
	 */
	readonly dialect: SurrealDialect;
	/**
	 * True when the statement being built can insert, i.e. it is on the upsert
	 * path. `$setOnInsert` needs this: MongoDB applies it only when the operation
	 * actually inserts, so on a plain update it must contribute nothing.
	 */
	readonly upsert: boolean;

	/** Allocate a new parameter name (`p0`, `p1`, …). */
	nextParam(): string;
	/** Bind a value and return the parameter name. */
	bind(value: unknown): string;
	/**
	 * Resolve a MongoDB field path to SurrealQL syntax. A positional path (`$[]`,
	 * `$[identifier]`) is refused: it is not a path expression, and goes through
	 * `updatePositional`.
	 */
	resolveField(field: string): string;
	/**
	 * Record what an operator does to the value at a positional path, and return
	 * `true`; return `false`, recording nothing, for a path with no positional
	 * marker, which the caller resolves as a plain field.
	 *
	 * The updates to one array are gathered and emitted together once every
	 * operator has run, as one rewrite of it — see `positional.ts`.
	 */
	updatePositional(field: string, update: PositionalUpdate): boolean;
}
