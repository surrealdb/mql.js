/**
 * Single source of truth for "which SurrealDB dialect am I talking to?".
 *
 * This driver requires **SurrealDB 3.0.0 or newer**. An older server speaks a
 * grammar this driver no longer emits (`type::is::*` instead of `type::is_*`,
 * `~` instead of `string::matches()`, `SEARCH` instead of `FULLTEXT`), so
 * rather than silently generating queries it cannot run, `resolveDialect`
 * rejects it.
 *
 * `undefined` is treated as "latest": version detection is best-effort, and an
 * unknown version is far more likely to be a fresh install than a legacy one.
 * `MongoClient.connect()` performs the authoritative check.
 */
import { MongoCompatibilityError } from "../../errors.ts";
import type { SurrealDialect } from "./dialect-strategy.ts";
import { V3Dialect } from "./v3-dialect.ts";

/** Lowest SurrealDB version this driver supports. */
export const MINIMUM_SURREALDB_VERSION = "3.0.0";

const V3 = new V3Dialect();

/** Parse the major version out of a version string, or `undefined`. */
export function majorVersionOf(
	version: string | undefined,
): number | undefined {
	if (!version) return undefined;
	const major = Number.parseInt(version.split(".")[0] ?? "", 10);
	return Number.isFinite(major) ? major : undefined;
}

/**
 * Returns true when `version` is known to be older than the minimum supported
 * SurrealDB release. An unparseable or absent version is not "unsupported" —
 * it is simply unknown.
 */
export function isUnsupportedVersion(version: string | undefined): boolean {
	const major = majorVersionOf(version);
	return major !== undefined && major < 3;
}

/**
 * Pick the dialect strategy for a SurrealDB server version string.
 *
 * @throws {MongoCompatibilityError} when the server predates
 *   {@link MINIMUM_SURREALDB_VERSION}.
 */
export function resolveDialect(version: string | undefined): SurrealDialect {
	if (isUnsupportedVersion(version)) {
		throw new MongoCompatibilityError(
			`SurrealDB ${version} is not supported: @surrealdb/mql requires SurrealDB ${MINIMUM_SURREALDB_VERSION} or newer.`,
		);
	}
	return V3;
}
