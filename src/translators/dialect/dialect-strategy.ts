/**
 * SurrealDB SQL dialect abstraction.
 *
 * Different SurrealDB major versions ship slightly different SurrealQL:
 *   - v2: `type::is::string`, `field ~ $p` (regex), `SEARCH ANALYZER ...`,
 *         the `blank` analyzer is built-in.
 *   - v3: `type::is_string`, `string::matches(field, $p)`,
 *         `FULLTEXT ANALYZER ...`, `blank` must be defined explicitly.
 *
 * Each `SurrealDialect` implementation encodes one set of those choices.
 * Resolving the dialect once at connect-time (Open/Closed) means new
 * versions can be added without touching the translators or operations.
 */
export interface SurrealDialect {
	/** Human-readable identifier, mainly for diagnostics ("v2", "v3"). */
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
	readonly fullTextKeyword: "FULLTEXT" | "SEARCH";

	/**
	 * SurrealQL statement to ensure the default `blank` analyzer exists,
	 * or `null` when the dialect provides it built-in.
	 */
	ensureBlankAnalyzerSql(): string | null;
}
