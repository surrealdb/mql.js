/**
 * SurrealDB 3.x dialect.
 *
 * v3 renamed the `type::is::*` namespace to `type::is_*`, replaced the
 * `~` regex operator with `string::matches()`, swapped `SEARCH` for
 * `FULLTEXT` in index definitions, and dropped the built-in `blank`
 * analyzer (it must be defined explicitly).
 */
import { BSON_TYPE_NAMES_V2 } from "./bson-types.ts";
import type { SurrealDialect } from "./dialect-strategy.ts";

/** Convert a v2 type-check function name (`type::is::*`) to its v3 form. */
function toV3(v2Name: string): string {
	return v2Name.replace(/^type::is::/, "type::is_");
}

export class V3Dialect implements SurrealDialect {
	readonly id = "v3";
	readonly fullTextKeyword = "FULLTEXT" as const;

	regexMatch(field: string, paramRef: string): string {
		return `string::matches(${field}, ${paramRef})`;
	}

	typeCheckFn(bson: string | number): string | undefined {
		const v2Name = BSON_TYPE_NAMES_V2[bson as keyof typeof BSON_TYPE_NAMES_V2];
		return v2Name ? toV3(v2Name) : undefined;
	}

	ensureBlankAnalyzerSql(): string | null {
		return "DEFINE ANALYZER IF NOT EXISTS blank TOKENIZERS blank FILTERS lowercase";
	}
}
