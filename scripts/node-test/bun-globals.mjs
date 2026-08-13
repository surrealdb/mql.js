/**
 * The `Bun` global, for the parts `tests/` uses.
 *
 * Twelve call sites, all of them starting a subprocess: `surreal` for the
 * integration tests, `docker` and the SurrealDB binary for the e2e providers,
 * and one `spawnSync` in `tests/setup.ts` that reads `surreal version`. Nothing
 * else — no `Bun.$`, no `Bun.sleep`, and the two `Bun.file`/`Bun.write` helpers
 * appear only in build scripts, which Node never runs.
 *
 * Deliberately not a general Bun polyfill. Each member here is shaped by exactly
 * what the tests call on it: `.exited`, `.kill()`, and `.stdout`/`.stderr` as web
 * streams, because `docker-container.ts` feeds them to `new Response(...)`.
 */

import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";

/** Bun accepts `"ignore"`, `"inherit"` or a sink; node wants a stdio string. */
const toStdio = (value) =>
	value === "ignore" || value === "inherit" ? value : "pipe";

globalThis.Bun ??= {
	spawn(argv, options = {}) {
		const [command, ...args] = argv;
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["ignore", toStdio(options.stdout), toStdio(options.stderr)],
		});

		// Bun resolves `exited` with the exit code; a signalled process has none, so
		// it is reported as a failure rather than as a clean 0.
		let exitCode = null;
		const exited = new Promise((resolve, reject) => {
			child.on("error", reject);
			child.on("close", (code, signal) => {
				exitCode = code ?? (signal ? 1 : 0);
				resolve(exitCode);
			});
		});

		return {
			get pid() {
				return child.pid;
			},
			// `null` until the process ends, as Bun's is. `waitForSurreal` reads it to
			// tell "my server is still starting" from "my server is already dead".
			get exitCode() {
				return exitCode;
			},
			exited,
			kill: (signal) => child.kill(signal),
			stdout: child.stdout ? Readable.toWeb(child.stdout) : undefined,
			stderr: child.stderr ? Readable.toWeb(child.stderr) : undefined,
		};
	},

	spawnSync(argv, options = {}) {
		const [command, ...args] = argv;
		const result = spawnSync(command, args, options);
		return {
			exitCode: result.status ?? 1,
			stdout: result.stdout,
			stderr: result.stderr,
			success: result.status === 0,
		};
	},

	file: (path) => ({ text: () => readFile(path, "utf8") }),
	write: (path, contents) => writeFile(path, contents),
};
