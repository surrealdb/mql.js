/**
 * SurrealDB SQL dialect abstraction.
 *
 * SurrealDB majors ship slightly different SurrealQL, so each
 * `SurrealDialect` implementation encodes one coherent set of those choices —
 * `V3Dialect` (the current baseline) uses `type::is_string`,
 * `string::matches(field, $p)` and `FULLTEXT ANALYZER ...`.
 *
 * The seam exists so a future major can be added without touching the
 * translators or operations: resolve the dialect once at connect-time
 * (Open/Closed) and pass it through. SurrealDB 2.x is no longer supported —
 * `resolveDialect` rejects it rather than emitting a grammar it cannot run.
 */
export interface SurrealDialect {
	/** Human-readable identifier, mainly for diagnostics ("v3"). */
	readonly id: string;

	/**
	 * SurrealQL fragment that tests whether `field` matches the regex bound
	 * to `paramRef` (`$p0`, `$p1`, …).
	 */
	regexMatch(field: string, paramRef: string): string;

	/**
	 * Map a BSON type alias or numeric code to the SurrealQL `type::is_*`
	 * function name. Returns `undefined` when the BSON type isn't supported.
	 */
	typeCheckFn(bson: string | number): string | undefined;

	/** Keyword to use for full-text search index definitions. */
	readonly fullTextKeyword: "FULLTEXT";

	/**
	 * SurrealQL statement to ensure the default `blank` analyzer exists,
	 * or `null` when the dialect provides it built-in.
	 */
	ensureBlankAnalyzerSql(): string | null;
}
