/**
 * What `buildInfo` reports, and why both numbers are in it.
 *
 * `buildInfo.version` is the field clients feature-gate on, and the gate is a
 * semantic-version comparison against MongoDB releases. These tests pin the two
 * halves of the answer that keeps that honest *and* useful: a MongoDB-compatible
 * `version` under the name whose meaning is fixed, and SurrealDB's real version
 * under a name that says what it is.
 *
 * The lower bound is the load-bearing assertion. Reporting SurrealDB's own
 * `3.2.x` in `version` would be read as MongoDB 3.2 — below the minimum server
 * of every currently supported MongoDB driver — so a client would disable
 * sessions, transactions and `$expr`, all of which this driver implements. The
 * test therefore asserts the reported version is not merely present but above
 * that floor.
 */

import { describe, expect, test } from "bun:test";
import {
	MONGODB_COMPATIBILITY_VERSION,
	MongoClient,
	MongoNetworkError,
} from "../../src/index.ts";

/** The oldest server the `mongodb` package this driver targets supports. */
const MONGODB_DRIVER_MINIMUM = [4, 2, 0];

function parse(version: string): number[] {
	return version.split(".").map(Number);
}

/** Is `a` at least `b`, compared as MongoDB versions are? */
function atLeast(a: readonly number[], b: readonly number[]): boolean {
	for (let i = 0; i < b.length; i += 1) {
		const left = a[i] ?? 0;
		const right = b[i] ?? 0;
		if (left !== right) return left > right;
	}
	return true;
}

function db() {
	return new MongoClient("mongodb://127.0.0.1:8000/testdb").db("testdb");
}

describe("buildInfo", () => {
	test("reports a MongoDB version in the field whose meaning is fixed", async () => {
		const info = await db().command({ buildInfo: 1 });

		expect(info.version).toBe(MONGODB_COMPATIBILITY_VERSION);
		expect(info.versionArray).toEqual([8, 0, 0, 0]);
		expect(info.ok).toBe(1);
	});

	test("the reported version clears the floor every live client gates on", () => {
		// The point of not reporting SurrealDB's `3.x` here: a client comparing this
		// against MongoDB releases must not conclude it is talking to a server older
		// than the ones its own driver supports.
		expect(
			atLeast(parse(MONGODB_COMPATIBILITY_VERSION), MONGODB_DRIVER_MINIMUM),
		).toBe(true);
	});

	test("versionArray agrees with version, in MongoDB's four-element form", async () => {
		const info = await db().command({ buildInfo: 1 });
		const [major, minor, patch] = parse(info.version as string);

		expect(info.versionArray).toEqual([major, minor, patch, 0]);
	});

	test("the real SurrealDB version is reported under its own name", async () => {
		const client = new MongoClient("mongodb://127.0.0.1:8000/testdb");
		// Nothing is invented for a server that has not been reached: the field is
		// absent rather than `null`, so "not reported" is distinguishable from
		// "reported as nothing".
		expect(client.serverVersion).toBeUndefined();
		expect(
			await client.db("testdb").command({ buildInfo: 1 }),
		).not.toContainKey("surrealdbVersion");
	});

	test("no build field describes a mongod binary that is not running", async () => {
		const info = await db().command({ buildInfo: 1 });

		for (const invented of [
			"gitVersion",
			"buildEnvironment",
			"storageEngines",
			"allocator",
			"javascriptEngine",
			"maxBsonObjectSize",
			"openssl",
		]) {
			expect(info).not.toContainKey(invented);
		}
	});
});

describe("ping", () => {
	test("reaches the server, so an unreachable one is reported as unreachable", async () => {
		// The assertion that keeps `ping` worth calling. mongod's `ping` is a round
		// trip and callers use it as their health check, so answering `ok: 1` from
		// the driver alone would report a deployment that is not there as healthy —
		// the one thing a liveness probe must never do.
		const unreachable = new MongoClient(
			"mongodb://127.0.0.1:19999/testdb?namespace=test",
		);

		await expect(
			unreachable.db("testdb").command({ ping: 1 }),
		).rejects.toBeInstanceOf(MongoNetworkError);
		await expect(
			unreachable.db("testdb").admin().ping(),
		).rejects.toBeInstanceOf(MongoNetworkError);
	});
});
