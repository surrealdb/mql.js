/**
 * What Node needs before it can run this suite: `--import` this file.
 *
 * Two hooks and a global.
 *
 * **Resolving `bun:test`.** Node has no such module, and `package.json`
 * `"imports"` cannot help — subpath imports must begin with `#`, so the
 * specifier is not expressible there. A resolve hook is the mechanism that can
 * map it, and it maps it to the adapter alongside this file.
 *
 * **Loading `.ts`.** Node's built-in type stripping is not enough for this
 * repository: three constructor parameter properties are non-erasable syntax
 * (`src/client/client-executor.ts` and `src/client/connection-manager.ts`), and
 * stripping fails on them. Rather than rewrite working source to suit a test
 * runner, the load hook transforms with esbuild, which is already a
 * devDependency and is what the build itself uses.
 *
 * **The `Bun` global**, for the subprocess spawning in the integration and e2e
 * helpers.
 *
 * Every relative import in `tests/` and `src/` already carries an explicit `.ts`
 * extension, and `verbatimModuleSyntax` guarantees `import type { Subprocess }
 * from "bun"` is erased before Node ever tries to resolve `"bun"`, so nothing
 * else needs rewriting.
 */

import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

import "./bun-globals.mjs";

const shim = new URL("./bun-test-shim.mjs", import.meta.url).href;

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "bun:test") return { url: shim, shortCircuit: true };
		return next(specifier, context);
	},

	load(url, context, next) {
		if (!url.startsWith("file:") || !url.endsWith(".ts")) {
			return next(url, context);
		}
		const path = fileURLToPath(url);
		const { code } = transformSync(readFileSync(path, "utf8"), {
			loader: "ts",
			format: "esm",
			target: "esnext",
			sourcefile: path,
		});
		return { format: "module", source: code, shortCircuit: true };
	},
});
