/**
 * Server-compatibility gate.
 *
 * `MongoClient.connect()` must refuse a SurrealDB release older than 3.0.0
 * rather than connecting and then failing every subsequent query with a parse
 * error, because 2.x speaks a SurrealQL grammar this driver no longer emits.
 *
 * The rejection is driven by the version reported by the server, so these
 * tests run against the ordinary (supported) test server and substitute the
 * detected version. That keeps CI free of a second SurrealDB binary while
 * still exercising the real `connect()` code path — the guard, the connection
 * teardown, and the thrown error type.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import {
	MongoClient,
	MongoCompatibilityError,
	MongoNotConnectedError,
} from "../../src/index.ts";
import { waitForSurreal } from "./helpers.ts";

const PORT = 18131;
const URL = `mongodb://root:root@127.0.0.1:${PORT}/compatdb?namespace=compatns`;

/** Force `connect()` to observe `version` from the server-version probe. */
function clientReporting(version: string | undefined): MongoClient {
	const client = new MongoClient(URL);
	const internals = client as unknown as {
		_connectionManager: {
			detectServerVersion: () => Promise<string | undefined>;
		};
	};
	internals._connectionManager.detectServerVersion = async () => version;
	return client;
}

let proc: Subprocess;

beforeAll(async () => {
	proc = Bun.spawn(
		[
			"surreal",
			"start",
			"--bind",
			`127.0.0.1:${PORT}`,
			"--username",
			"root",
			"--password",
			"root",
			"memory",
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	await waitForSurreal(PORT);
});

afterAll(() => {
	proc?.kill();
});

describe("minimum supported SurrealDB version", () => {
	test("connect() rejects a 2.x server with MongoCompatibilityError", async () => {
		const client = clientReporting("2.3.7");
		await expect(client.connect()).rejects.toThrow(MongoCompatibilityError);
	});

	test("the rejection names both the server and the minimum version", async () => {
		const client = clientReporting("2.3.7");
		await expect(client.connect()).rejects.toThrow(/2\.3\.7.*3\.0\.0/);
	});

	test("a rejected connect leaves the client unusable rather than half-open", async () => {
		const client = clientReporting("2.3.7");
		await expect(client.connect()).rejects.toThrow(MongoCompatibilityError);
		expect(() => client.db("compatdb")).toThrow(MongoNotConnectedError);
	});

	test("older majors are rejected too", async () => {
		const client = clientReporting("1.5.0");
		await expect(client.connect()).rejects.toThrow(MongoCompatibilityError);
	});

	test("a 3.x server connects normally", async () => {
		const client = new MongoClient(URL);
		await client.connect();
		try {
			expect(client.serverVersion).toMatch(/^3\./);
			expect(client.db("compatdb").databaseName).toBe("compatdb");
		} finally {
			await client.close();
		}
	});

	test("an undetectable version is allowed through, not rejected", async () => {
		const client = clientReporting(undefined);
		await client.connect();
		try {
			expect(client.serverVersion).toBeUndefined();
		} finally {
			await client.close();
		}
	});
});
