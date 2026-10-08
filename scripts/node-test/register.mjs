/**
 * What Node needs before it can run this suite: `--import` this file.
 *
 * Two hooks and a global. The hooks live in `hooks.mjs`, and are installed one of
 * two ways: `registerHooks` (Node 22.15 and later), which runs them in this
 * thread, or `register` (Node 20.6 and later), which runs them in a worker. The
 * floor `engines.node` declares is 20.19.0, and only the second exists there, so
 * both are wired — they are the same functions, since neither looks at what the
 * next hook returns. Set `MQL_NODE_TEST_ASYNC_HOOKS=1` to take the second path on
 * a Node that has the first, which is how it is exercised without an old Node.
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

import * as nodeModule from "node:module";

import "./bun-globals.mjs";

import * as hooks from "./hooks.mjs";

const useAsyncHooks =
	process.env.MQL_NODE_TEST_ASYNC_HOOKS === "1" ||
	typeof nodeModule.registerHooks !== "function";

if (useAsyncHooks) {
	nodeModule.register("./hooks.mjs", import.meta.url);
} else {
	nodeModule.registerHooks(hooks);
}
