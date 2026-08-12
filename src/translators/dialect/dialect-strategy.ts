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

	/**
	 * SurrealQL fragment that tests whether `field` holds a point geometry.
	 *
	 * Not a BSON type, so it has no place in `typeCheckFn`: the geospatial
	 * operators need it because `geo::distance` refuses anything else, and its
	 * spelling moves with the SurrealQL major exactly as `type::is_*` does.
	 */
	pointCheck(field: string): string;

	/**
	 * SurrealQL fragment that tests whether `field` holds any geometry.
	 *
	 * `$type: "object"` needs it: a GeoJSON geometry is stored as SurrealDB's
	 * geometry type, which `type::is_object` answers `false` for, while the value
	 * the caller wrote and reads back is a JSON object — and is one to MongoDB,
	 * which matches it.
	 */
	geometryCheck(field: string): string;

	/** Keyword to use for full-text search index definitions. */
	readonly fullTextKeyword: "FULLTEXT";

	/**
	 * SurrealQL statement to ensure the default `blank` analyzer exists,
	 * or `null` when the dialect provides it built-in.
	 */
	ensureBlankAnalyzerSql(): string | null;
}
