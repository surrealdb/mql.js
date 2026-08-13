/**
 * Verify the packaged tarball the way a consumer meets it.
 *
 * Everything before this script tests the repository. This tests the artefact: it
 * packs the package, installs it into throwaway ESM and CommonJS projects, loads
 * it under Node, and type-checks a real consumer against the shipped
 * declarations. Nothing in CI had ever done that — every job ran under Bun,
 * against `src/` — which is how the package came to ship ESM types for its
 * CommonJS entry point without anything noticing.
 *
 * The type-check is the part that earns its keep. `attw` and `publint` both pass
 * a package whose declarations do not compile in a stock project: they check how
 * the entry points resolve, not whether the types they resolve to are usable. Two
 * real defects showed up only here — declarations naming `AsyncDisposable`
 * without asking for the lib that defines it, and CommonJS declarations importing
 * an ESM module in a way `module: node16` rejects.
 *
 * Run with `bun run scripts/verify-package.ts`. Requires `node` and `npm` on PATH.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A command to run, and where. */
interface Step {
	readonly label: string;
	readonly cwd: string;
	readonly command: string[];
	/** Output that must appear for the step to count as passing. */
	readonly expect?: string;
}

const failures: string[] = [];

async function run(step: Step): Promise<void> {
	const proc = Bun.spawn(step.command, {
		cwd: step.cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const output = `${stdout}${stderr}`.trim();

	const met = step.expect === undefined || output.includes(step.expect);
	if (code === 0 && met) {
		console.log(`  ✓ ${step.label}`);
		return;
	}

	failures.push(step.label);
	console.log(`  ✗ ${step.label} (exit ${code})`);
	for (const line of output.split("\n").slice(0, 25)) {
		console.log(`      ${line}`);
	}
}

const CONSUMER_TS = `import { MongoClient, ObjectId, type Filter, type Document } from "@surrealdb/mql";

// A consumer's own generic, to exercise the exported types rather than just the
// value exports: an entry point that resolves but whose types do not compile is
// the failure this catches.
async function claim<T extends Document>(client: MongoClient, filter: Filter<T>) {
	const collection = client.db("app").collection<T>("jobs");
	const found = await collection.findOne(filter);
	return found?._id;
}

const client = new MongoClient("mongodb://localhost:8000/app?namespace=ns");
const oid: ObjectId = new ObjectId();
void claim(client, { _id: oid } as Filter<Document>);
`;

const ESM_LOAD = `import { MongoClient, ObjectId, MongoErrorCode, MONGODB_COMPATIBILITY_VERSION } from "@surrealdb/mql";
if (typeof MongoClient !== "function") throw new Error("MongoClient is not a constructor");
if (new ObjectId().toHexString().length !== 24) throw new Error("ObjectId is wrong");
if (MongoErrorCode.DuplicateKey !== 11000) throw new Error("error codes missing");
if (!MONGODB_COMPATIBILITY_VERSION) throw new Error("compatibility version missing");
console.log("esm-ok");
`;

const CJS_LOAD = `const { MongoClient, ObjectId, MongoErrorCode } = require("@surrealdb/mql");
if (typeof MongoClient !== "function") throw new Error("MongoClient is not a constructor");
if (new ObjectId().toHexString().length !== 24) throw new Error("ObjectId is wrong");
if (MongoErrorCode.DuplicateKey !== 11000) throw new Error("error codes missing");
console.log("cjs-ok");
`;

/** `module: node16` is the strict setting; it is what rejects illegal CJS type imports. */
const TSCONFIG = JSON.stringify(
	{
		compilerOptions: {
			module: "node16",
			moduleResolution: "node16",
			target: "es2022",
			strict: true,
			noEmit: true,
			// Deliberately on: the point is whether the *shipped* declarations compile.
			skipLibCheck: false,
		},
		files: ["consumer.ts"],
	},
	null,
	2,
);

const repo = process.cwd();
const tarball = join(repo, await pack());
const workspace = mkdtempSync(join(tmpdir(), "mql-consume-"));

async function pack(): Promise<string> {
	const proc = Bun.spawn(["npm", "pack", "--silent"], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "inherit",
	});
	const name = (await new Response(proc.stdout).text())
		.trim()
		.split("\n")
		.pop();
	if ((await proc.exited) !== 0 || !name) throw new Error("npm pack failed");
	return name;
}

console.log(`packed ${tarball}`);

try {
	for (const kind of ["esm", "cjs"] as const) {
		const dir = join(workspace, kind);
		console.log(`\n${kind} consumer (${dir})`);

		writeFileSync(
			join(mkdirp(dir), "package.json"),
			JSON.stringify(
				{
					name: `consume-${kind}`,
					version: "1.0.0",
					private: true,
					...(kind === "esm" ? { type: "module" } : {}),
				},
				null,
				2,
			),
		);
		writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
		writeFileSync(join(dir, "consumer.ts"), CONSUMER_TS);
		writeFileSync(
			join(dir, kind === "esm" ? "load.js" : "load.cjs"),
			kind === "esm" ? ESM_LOAD : CJS_LOAD,
		);

		await run({
			label: `${kind}: install the tarball`,
			cwd: dir,
			command: [
				"npm",
				"install",
				"--silent",
				"--no-audit",
				"--no-fund",
				tarball,
				"typescript@5",
			],
		});
		await run({
			label: `${kind}: ${kind === "esm" ? "import" : "require"} under Node`,
			cwd: dir,
			command: ["node", kind === "esm" ? "load.js" : "load.cjs"],
			expect: `${kind}-ok`,
		});
		await run({
			label: `${kind}: a consumer type-checks against the shipped declarations`,
			cwd: dir,
			command: ["./node_modules/.bin/tsc", "-p", "tsconfig.json"],
		});
	}

	console.log("\npackage checks");
	await run({
		label: "attw: every entry point resolves to types of the right format",
		cwd: repo,
		command: ["npx", "--yes", "@arethetypeswrong/cli@latest", "--pack", "."],
		expect: "No problems found",
	});
	await run({
		label: "publint: no packaging errors",
		cwd: repo,
		command: ["npx", "--yes", "publint@latest", "--strict"],
	});
} finally {
	rmSync(workspace, { recursive: true, force: true });
	rmSync(tarball, { force: true });
}

function mkdirp(dir: string): string {
	Bun.spawnSync(["mkdir", "-p", dir]);
	return dir;
}

if (failures.length > 0) {
	console.log(`\n${failures.length} check(s) failed:`);
	for (const failure of failures) console.log(`  - ${failure}`);
	process.exit(1);
}
console.log(
	"\nthe packaged tarball is consumable from Node in both module systems",
);
