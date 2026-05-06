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
