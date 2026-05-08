/**
 * Single source of truth for "which SurrealDB dialect am I talking to?".
 *
 * Treats `undefined` as "latest" because unknown versions almost always
 * correspond to a fresh install; older v2 servers must be detected
 * explicitly via `MongoClient.serverVersion` after `connect()`.
 */
import type { SurrealDialect } from "./dialect-strategy.ts";
import { V2Dialect } from "./v2-dialect.ts";
import { V3Dialect } from "./v3-dialect.ts";

const V2 = new V2Dialect();
const V3 = new V3Dialect();

/** Pick the dialect strategy that matches a SurrealDB server version string. */
export function resolveDialect(version: string | undefined): SurrealDialect {
	if (!version) return V3;
	const major = Number.parseInt(version.split(".")[0] ?? "0", 10);
	if (!Number.isFinite(major)) return V3;
	return major >= 3 ? V3 : V2;
}

/** Convenience predicate, kept for symmetry with the previous helper. */
export function isV3Dialect(version: string | undefined): boolean {
	return resolveDialect(version).id === "v3";
}
