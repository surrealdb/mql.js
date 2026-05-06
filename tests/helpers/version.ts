/**
 * Version-aware test helpers.
 *
 * The target SurrealDB version is read from the `MQL_SURREAL_VERSION` env
 * variable (set externally or by `tests/setup.ts` from the local `surreal`
 * binary). Helpers below decide whether to run a `describe` / `test` block
 * based on whether that target satisfies a semver range.
 *
 * Examples:
 *   runIfVersion(">=3.0.0", () => { describe("v3 syntax", () => ...); });
 *   firstApplicable([
 *     [">=4.0.0", () => describe("v4", ...)],
 *     [">=3.0.0", () => describe("v3", ...)],
 *     [">=2.0.0", () => describe("v2", ...)],
 *   ]);
 */

import { coerce, satisfies as semverSatisfies } from "semver";

/** Default target when nothing is set: a sentinel that satisfies every `>=X` range. */
const LATEST_FALLBACK = "9999.0.0";

const RAW_VERSION = process.env.MQL_SURREAL_VERSION ?? LATEST_FALLBACK;
const NORMALIZED = coerce(RAW_VERSION)?.version ?? LATEST_FALLBACK;

/** The semver-normalised target SurrealDB version used for filtering tests. */
export function getTargetVersion(): string {
	return NORMALIZED;
}

/** Returns true when the target version satisfies the provided semver range. */
export function satisfies(range: string): boolean {
	return semverSatisfies(NORMALIZED, range);
}

/** Run `fn` only when the target version satisfies `range`. */
export function runIfVersion(range: string, fn: () => void): void {
	if (satisfies(range)) fn();
}

/**
 * Run the first block whose range is satisfied by the target version.
 * Order entries from most-specific (newest) to least-specific (oldest) to
 * naturally express "use the v4 variant if running v4, else v3, else v2".
 */
export function firstApplicable(
	entries: Array<readonly [range: string, fn: () => void]>,
): void {
	for (const [range, fn] of entries) {
		if (satisfies(range)) {
			fn();
			return;
		}
	}
}
