/**
 * SurrealDB 3.x dialect — the baseline dialect for this driver.
 *
 * Uses `type::is_*` type-check functions — including `type::is_point`, spelled
 * `type::is::point` before 3.x — `string::matches()` for regex comparison, and
 * `FULLTEXT` in index definitions. The `blank` analyzer is not built in and must
 * be defined explicitly.
 */
import { BSON_TYPE_CHECK_FNS } from "./bson-types.ts";
import type { SurrealDialect } from "./dialect-strategy.ts";

export class V3Dialect implements SurrealDialect {
	readonly id = "v3";
	readonly fullTextKeyword = "FULLTEXT" as const;

	regexMatch(field: string, paramRef: string): string {
		return `string::matches(${field}, ${paramRef})`;
	}

	typeCheckFn(bson: string | number): string | undefined {
		return BSON_TYPE_CHECK_FNS[bson as keyof typeof BSON_TYPE_CHECK_FNS];
	}

	pointCheck(field: string): string {
		return `type::is_point(${field})`;
	}

	geometryCheck(field: string): string {
		return `type::is_geometry(${field})`;
	}

	ensureBlankAnalyzerSql(): string | null {
		return "DEFINE ANALYZER IF NOT EXISTS blank TOKENIZERS blank FILTERS lowercase";
	}
}
