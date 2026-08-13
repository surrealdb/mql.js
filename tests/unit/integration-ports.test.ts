/**
 * Every integration test file must bind a port no other file binds.
 *
 * This is a test about the tests, which normally is not worth writing. It is
 * here because the failure it prevents is invisible in the runner the suite was
 * written under and expensive in the one it now also runs under.
 *
 * `bun test` runs files sequentially in one process, so two files sharing a port
 * never overlap and the duplicate is harmless. `node --test` runs files in
 * parallel, one process each. Then the second `surreal start` cannot bind, exits
 * immediately, and the file's health check succeeds anyway — against the *other*
 * file's server. Both files pass until the first one's `afterAll` kills that
 * server, at which point the second fails partway through with "You must be
 * connected to a SurrealDB instance", in a file whose setup reported success.
 * Whether it happens at all depends on the interleaving, so it presents as a
 * flake in unrelated tests.
 *
 * `waitForSurreal` now catches this when it happens. This catches it whether or
 * not it happens, which for a non-deterministic fault is the difference that
 * matters.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const INTEGRATION_DIR = join(import.meta.dirname, "..", "integration");

/** `const PORT = 18145;` — the one form every integration file uses. */
const PORT_DECLARATION = /^const PORT = (\d+)/m;

function declaredPorts(): Map<number, string[]> {
	const ports = new Map<number, string[]>();

	for (const file of readdirSync(INTEGRATION_DIR).sort()) {
		if (!file.endsWith(".test.ts")) continue;
		const match = PORT_DECLARATION.exec(
			readFileSync(join(INTEGRATION_DIR, file), "utf8"),
		);
		if (!match) continue;
		const port = Number(match[1]);
		ports.set(port, [...(ports.get(port) ?? []), file]);
	}

	return ports;
}

describe("integration test ports", () => {
	test("no two files bind the same port", () => {
		const clashes = [...declaredPorts()]
			.filter(([, files]) => files.length > 1)
			.map(([port, files]) => `${port}: ${files.join(", ")}`);

		expect(clashes).toEqual([]);
	});

	test("the files that declare one are found at all", () => {
		// Guards the regex rather than the ports: a change to how a port is declared
		// would otherwise make the test above pass by matching nothing.
		expect(declaredPorts().size).toBeGreaterThan(20);
	});
});
