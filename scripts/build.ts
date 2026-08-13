import * as esbuild from "esbuild";
import tscPlugin from "esbuild-plugin-tsc";

await Promise.all([
	esbuild.build({
		entryPoints: ["src/index.ts"],
		bundle: true,
		outfile: "dist/index.mjs",
		plugins: [tscPlugin({ force: true })],
		external: ["surrealdb"],
		format: "esm",
		minifyWhitespace: true,
		minifySyntax: true,
		sourcemap: true,
	}),
	esbuild.build({
		entryPoints: ["src/index.ts"],
		bundle: true,
		outfile: "dist/index.cjs",
		plugins: [tscPlugin({ force: true })],
		external: ["surrealdb"],
		format: "cjs",
		minifyWhitespace: true,
		minifySyntax: true,
		sourcemap: true,
	}),
	esbuild.build({
		entryPoints: ["src/index.ts"],
		bundle: true,
		outfile: "dist/index.bundled.mjs",
		plugins: [tscPlugin({ force: true })],
		format: "esm",
		minifyWhitespace: true,
		minifySyntax: true,
		sourcemap: true,
	}),
]);

// Awaited, rather than spawned and left to finish on its own: everything below
// depends on the declarations existing, and so does the packaged result — a build
// that returned before this wrote `index.d.ts` would ship a typeless package, and
// would do it intermittently.
//
// The local binary rather than `bunx`: `bunx <bin>` resolves a *package* of that
// name from the registry when the local one is not an exact match, which rewrites
// `node_modules` as a side effect of a build.
const declarations = Bun.spawn(
	[
		"node_modules/.bin/dts-bundle-generator",
		"-o",
		"dist/index.d.ts",
		"src/index.ts",
		"--no-check",
		"--export-referenced-types",
		"false",
	],
	{ stdout: "inherit", stderr: "inherit" },
);

const declarationsExit = await declarations.exited;
if (declarationsExit !== 0) process.exit(declarationsExit);

/**
 * Make the generated declarations compile in a consumer's project.
 *
 * Two fixes, both found by running `tsc` over an installed copy of the tarball
 * rather than by inspecting the package — `attw` and `publint` pass without them:
 *
 *   - **the lib reference.** The public API includes `await using session =
 *     client.startSession()`, so the declarations name `AsyncDisposable` and
 *     `Symbol.asyncDispose`. Those live in `lib.esnext.disposable`, which a project
 *     on a stock `lib` for its target does not load, so *our* declaration file was
 *     the thing reporting errors in their build. Declaring the requirement in the
 *     file is how a library asks for a lib it needs; it also settles the identical
 *     complaint about `surrealdb`'s own declarations, since the reference is global.
 *   - **the import of `surrealdb`'s types.** `MongoClient` exposes the underlying
 *     `Surreal` instance, so the declarations import its type — and `surrealdb`
 *     ships one ESM-flavoured `.d.ts` for both of its conditions. Under
 *     `module: node16`, a CommonJS declaration file importing that is an error
 *     either way: `TS1479` ("cannot be imported with require") as a value import,
 *     and `TS1541` as a type-only one unless it says how to resolve it. So the
 *     CommonJS copy asks for the ESM resolution explicitly, which is exactly what
 *     it means — the type is only ever read at compile time.
 */
function consumable(declarations: string, module: "esm" | "cjs"): string {
	// Every import in a declaration file is type-only in effect, so saying so
	// costs nothing and is what makes the CommonJS copy legal at all.
	const typeOnly = declarations.replace(/^import \{/m, "import type {");

	const resolved =
		module === "cjs"
			? typeOnly.replace(
					/^(import type \{[^}]*\} from '[^']+');/m,
					'$1 with { "resolution-mode": "import" };',
				)
			: typeOnly;

	return `/// <reference lib="esnext.disposable" />\n${resolved}`;
}

const declarationText = await Bun.file("dist/index.d.ts").text();

// The same declarations under both extensions, differing only in how they reach
// `surrealdb`'s types. The extension is the whole of what tells TypeScript which
// module system a file describes, and pairing ESM-flavoured types with
// `index.cjs` under the `require` condition is what `attw` calls "masquerading as
// ESM".
await Bun.write("dist/index.d.ts", consumable(declarationText, "esm"));
await Bun.write("dist/index.d.cts", consumable(declarationText, "cjs"));
