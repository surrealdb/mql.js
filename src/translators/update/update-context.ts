/**
 * Per-`translateUpdate()` mutable context shared across operator handlers.
 *
 * `parts` accumulates `field = expr` fragments that will eventually be
 * joined into the SurrealQL `SET` clause; `bindings` collects the
 * parameters referenced from those fragments.
 */

import type { Document } from "../../types.ts";

export interface UpdateContext {
	/** Bindings produced so far. Mutated in place by operators. */
	readonly bindings: Record<string, unknown>;
	/** SET-clause fragments to be joined with `, ` at the end. */
	readonly parts: string[];
	/** Optional arrayFilters (used by `$[identifier]` positional updates). */
	readonly arrayFilters: Document[] | undefined;

	/** Allocate a new parameter name (`p0`, `p1`, …). */
	nextParam(): string;
	/** Bind a value and return the parameter name. */
	bind(value: unknown): string;
	/** Resolve a possibly-positional MongoDB field path to SurrealQL syntax. */
	resolveField(field: string): string;
}
