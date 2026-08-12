/**
 * E2E parity composition root.
 *
 * The single concrete decision this file makes is "which provider runs the
 * scenarios". Selection is env-driven so CI can target each backend in a
 * dedicated job:
 *
 *   E2E_DRIVER=mongodb bun test tests/e2e   # MongoDB in Docker
 *   E2E_DRIVER=mql     bun test tests/e2e   # mql.js + SurrealDB in Docker
 *   E2E_DRIVER=both    bun test tests/e2e   # run them sequentially (default)
 *
 * Locally, with no env var set, both providers run back-to-back so a
 * developer sees parity (or lack thereof) immediately. When Docker is
 * unavailable the suite degrades to a single skipped test instead of
 * failing the whole run.
 */

import { describe, test } from "bun:test";
import type { DatabaseProvider } from "./providers/database-provider.ts";
import { isDockerAvailable } from "./providers/docker-container.ts";
import { MongoDbDockerProvider } from "./providers/mongodb-provider.ts";
import { SurrealDbDockerProvider } from "./providers/surrealdb-provider.ts";
import { registerCrudScenarios } from "./scenarios/crud-scenarios.ts";
import { registerGeospatialScenarios } from "./scenarios/geospatial-scenarios.ts";
import { registerParityGapScenarios } from "./scenarios/parity-gap-scenarios.ts";

type DriverChoice = "mongodb" | "mql" | "both";

function resolveDriver(): DriverChoice {
	const raw = (process.env.E2E_DRIVER ?? "both").toLowerCase();
	if (raw === "mongodb" || raw === "mql" || raw === "both") return raw;
	throw new Error(
		`Unknown E2E_DRIVER value: "${raw}". Expected "mongodb", "mql", or "both".`,
	);
}

/** One factory per engine: see the loop below for why these are not instances. */
function buildProviders(driver: DriverChoice): (() => DatabaseProvider)[] {
	const providers: (() => DatabaseProvider)[] = [];
	if (driver === "mongodb" || driver === "both") {
		providers.push(() => new MongoDbDockerProvider());
	}
	if (driver === "mql" || driver === "both") {
		providers.push(() => new SurrealDbDockerProvider());
	}
	return providers;
}

const dockerAvailable = await isDockerAvailable();

if (!dockerAvailable) {
	describe("E2E parity (skipped)", () => {
		test.skip("Docker is not available on this machine; install/start docker to run e2e tests", () => {
			// Intentionally blank.
		});
	});
} else {
	// A provider per suite: each scenario file starts and stops its own store, so
	// one instance shared between two of them would be restarted in between.
	for (const build of buildProviders(resolveDriver())) {
		registerCrudScenarios(build());
		registerGeospatialScenarios(build());
		registerParityGapScenarios(build());
	}
}
