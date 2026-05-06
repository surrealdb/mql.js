/**
 * SurrealDB 2.x dialect.
 *
 * Encodes the SurrealQL choices that apply when the connected server speaks
 * the legacy v2 grammar (regex via `~`, `type::is::*` namespacing, `SEARCH`
 * as the full-text keyword, built-in `blank` analyzer).
 */
import { BSON_TYPE_NAMES_V2 } from "./bson-types.ts";
import type { SurrealDialect } from "./dialect-strategy.ts";

export class V2Dialect implements SurrealDialect {
	readonly id = "v2";
	readonly fullTextKeyword = "SEARCH" as const;

	regexMatch(field: string, paramRef: string): string {
		return `${field} ~ ${paramRef}`;
	}

	typeCheckFn(bson: string | number): string | undefined {
		return BSON_TYPE_NAMES_V2[bson as keyof typeof BSON_TYPE_NAMES_V2];
	}

	ensureBlankAnalyzerSql(): string | null {
		return null;
	}
}
