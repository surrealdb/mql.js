/**
 * E2E parity composition root — in-memory variant.
 *
 * Same parity scenarios as `parity.test.ts`, but the providers don't need
 * Docker:
 *   - The MongoDB run uses `mongodb-memory-server` (downloads + caches a
 *     real `mongod` binary on first run).
 *   - The mql.js run uses the local `surreal` binary started in
 *     `memory` mode.
 *
 * This is the suite a contributor wants on their machine: one command,
 * no daemons, both drivers exercised back-to-back. CI can still pin the
 * Docker variant when reproducibility matters more than turnaround.
 *
 * Driver selection mirrors `parity.test.ts`:
 *
 *   E2E_DRIVER=mongodb bun test tests/e2e/parity-in-memory.test.ts
 *   E2E_DRIVER=mql     bun test tests/e2e/parity-in-memory.test.ts
 *   E2E_DRIVER=both    bun test tests/e2e/parity-in-memory.test.ts  # default
 *
 * Each provider gates itself on its prerequisite (mongod-bootable /
 * surreal-on-PATH) and the suite degrades to a single skipped describe
 * when neither prerequisite is available, so the test run stays green
 * across diverse environments.
 */

import { describe, test } from "bun:test";
import type { DatabaseProvider } from "./providers/database-provider.ts";
import {
	isMongoMemoryServerAvailable,
	MongoDbMemoryProvider,
} from "./providers/mongodb-memory-provider.ts";
import {
	isSurrealBinaryAvailable,
	SurrealDbBinaryProvider,
} from "./providers/surrealdb-binary-provider.ts";
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

interface ResolvedProvider {
	/**
	 * Builds a provider, rather than being one.
	 *
	 * Each scenario file brings its provider up in `beforeAll` and down in
	 * `afterAll`, so two suites sharing one instance would stop and restart the
	 * same store between them. A factory gives each suite a store of its own.
	 */
	readonly create: () => DatabaseProvider;
	readonly name: string;
	readonly available: boolean;
	readonly skipReason: string;
}

async function buildProviders(
	driver: DriverChoice,
): Promise<ResolvedProvider[]> {
	const resolved: ResolvedProvider[] = [];

	if (driver === "mongodb" || driver === "both") {
		const available = await isMongoMemoryServerAvailable();
		resolved.push({
			create: () => new MongoDbMemoryProvider(),
			name: "mongodb (in-memory)",
			available,
			skipReason:
				"mongodb-memory-server cannot bootstrap a mongod binary in this environment",
		});
	}

	if (driver === "mql" || driver === "both") {
		const available = await isSurrealBinaryAvailable();
		resolved.push({
			create: () => new SurrealDbBinaryProvider(),
			name: "mql.js + surrealdb (in-memory)",
			available,
			skipReason:
				"`surreal` binary not found on PATH; install SurrealDB to run the mql.js side",
		});
	}

	return resolved;
}

const resolvedProviders = await buildProviders(resolveDriver());
const anyAvailable = resolvedProviders.some((p) => p.available);

if (!anyAvailable) {
	describe("E2E parity in-memory (skipped)", () => {
		test.skip("No in-memory backend is available on this machine. Install SurrealDB and ensure mongodb-memory-server can download mongod, then re-run.", () => {});
	});
} else {
	for (const { create, name, available, skipReason } of resolvedProviders) {
		if (available) {
			registerCrudScenarios(create());
			registerGeospatialScenarios(create());
			registerParityGapScenarios(create());
		} else {
			describe(`E2E parity – ${name} (skipped)`, () => {
				test.skip(skipReason, () => {});
			});
		}
	}
}
