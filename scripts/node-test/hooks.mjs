/**
 * The module hooks `register.mjs` installs: what lets Node load this repository's
 * tests.
 *
 * Written so that one pair of functions serves both ways Node can run hooks. They
 * are synchronous under `registerHooks` and asynchronous under `register`, and
 * the only difference is that `next` returns a promise in the second — which is
 * harmless here, because nothing below reads what `next` returned, it only hands
 * it back.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const shim = new URL("./bun-test-shim.mjs", import.meta.url).href;

/** `bun:test` has no Node counterpart, so it is mapped to the adapter beside this file. */
export function resolve(specifier, context, next) {
	if (specifier === "bun:test") return { url: shim, shortCircuit: true };
	return next(specifier, context);
}

/** TypeScript is stripped by esbuild, for the reason `register.mjs` gives. */
export function load(url, context, next) {
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
}
