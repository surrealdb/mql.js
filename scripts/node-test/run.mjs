/**
 * Run a directory's `*.test.ts` files under Node's test runner.
 *
 * `node --test "dir/**\/*.test.ts"` leaves the expanding to Node, and Node only
 * learned to expand a glob in 21. The engines floor this package declares is
 * 20.19.0, where the pattern is taken for a file name — "Could not find
 * 'tests/integration/**\/*.test.ts'" — so the suite could be run on every Node
 * but the oldest one it claims to support. The files are collected here instead,
 * which every version can do.
 *
 * Usage: `node scripts/node-test/run.mjs <dir>...` — each directory is walked
 * for `*.test.ts`. The `--import` of `register.mjs` is added here, so a script
 * names the directory and nothing else.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const register = join(root, "scripts", "node-test", "register.mjs");

/** Every `*.test.ts` under `directory`, in a stable order. */
function testFiles(directory) {
	const found = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...testFiles(path));
		else if (entry.name.endsWith(".test.ts")) found.push(path);
	}
	return found.sort();
}

const directories = process.argv.slice(2);
if (directories.length === 0) {
	console.error("usage: run.mjs <directory>...");
	process.exit(2);
}

const files = directories.flatMap((directory) =>
	testFiles(resolve(root, directory)),
);
if (files.length === 0) {
	// A directory that holds no tests is a mistake in the caller, and a green run
	// of nothing would hide it.
	console.error(`no *.test.ts files under: ${directories.join(", ")}`);
	process.exit(2);
}

const { status } = spawnSync(
	process.execPath,
	["--import", register, "--test", ...files],
	{ stdio: "inherit", cwd: root },
);
process.exit(status ?? 1);
