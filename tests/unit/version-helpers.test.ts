import { describe, expect, test } from "bun:test";
import {
	firstApplicable,
	getTargetVersion,
	runIfVersion,
	satisfies,
} from "../helpers/version.ts";

describe("version helpers", () => {
	test("getTargetVersion reflects MQL_SURREAL_VERSION (or latest fallback)", () => {
		const v = getTargetVersion();
		// At minimum it should be a normalised semver triple.
		expect(v).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test("satisfies(): a range that includes the target succeeds", () => {
		// The current target itself must satisfy `>= itself`.
		const v = getTargetVersion();
		expect(satisfies(`>=${v}`)).toBe(true);
		expect(satisfies("<0.0.1")).toBe(false);
	});

	test("runIfVersion runs the block when the range matches", () => {
		let called = false;
		runIfVersion(">=0.0.1", () => {
			called = true;
		});
		expect(called).toBe(true);
	});

	test("runIfVersion does not run the block when the range fails", () => {
		let called = false;
		runIfVersion("<0.0.1", () => {
			called = true;
		});
		expect(called).toBe(false);
	});

	test("firstApplicable picks the highest-applicable entry", () => {
		const log: string[] = [];
		firstApplicable([
			[
				">=99999.0.0",
				() => {
					log.push("future");
				},
			],
			[
				">=2.0.0",
				() => {
					log.push("v2-or-newer");
				},
			],
			[
				"<2.0.0",
				() => {
					log.push("legacy");
				},
			],
		]);
		// The first impossible entry is skipped, the second matches and stops resolution.
		expect(log).toEqual(["v2-or-newer"]);
	});

	test("firstApplicable runs nothing when no entry matches", () => {
		const log: string[] = [];
		firstApplicable([
			[
				"<0.0.1",
				() => {
					log.push("a");
				},
			],
		]);
		expect(log).toEqual([]);
	});
});
