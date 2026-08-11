/**
 * Test runner preload script.
 *
 * If `MQL_SURREAL_VERSION` isn't already set in the environment, this auto-
 * detects the version of the local `surreal` binary so version-gated tests
 * (see `tests/helpers/version.ts`) target the correct version. When the
 * binary isn't installed (e.g. in unit-test-only CI jobs), the helpers fall
 * back to "latest" which satisfies every `>=X` range.
 *
 * Loaded by `bunfig.toml` via `[test] preload = ["./tests/setup.ts"]`.
 */

import v8 from "node:v8";

/**
 * Shim `v8.startupSnapshot.isBuildingSnapshot` so the `bson` package can be
 * imported under Bun.
 *
 * `bson` (a transitive dependency of the `mongodb` devDependency, which
 * `tests/unit/types-parity.test.ts` reflects against) calls
 * `startupSnapshot?.isBuildingSnapshot?.()` at module scope. Bun exposes the
 * function but throws `NotImplementedError` when it is called, so the optional
 * chaining does not protect against it and importing `mongodb` fails outright.
 * Reporting "not building a snapshot" is correct for every test process.
 */
try {
	const snapshot = v8.startupSnapshot as
		| { isBuildingSnapshot?: () => boolean }
		| undefined;
	if (snapshot) snapshot.isBuildingSnapshot = () => false;
} catch {
	// Nothing to patch (a runtime that implements it properly, e.g. Node).
}

if (!process.env.MQL_SURREAL_VERSION) {
	try {
		const proc = Bun.spawnSync(["surreal", "version"]);
		const out = proc.stdout?.toString() ?? "";
		const match = out.match(/(\d+\.\d+\.\d+)/);
		if (match?.[1]) {
			process.env.MQL_SURREAL_VERSION = match[1];
		}
	} catch {
		// `surreal` binary unavailable; tests fall back to "latest".
	}
}
