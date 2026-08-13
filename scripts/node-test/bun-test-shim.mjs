/**
 * `bun:test`, implemented over `node:test`.
 *
 * The suite is written against Bun's test API and runs under Bun in CI. This
 * exists so the *same* tests can also run under Node, which is the runtime the
 * package is published for — and, more to the point, a different WebSocket
 * implementation. `surrealdb`'s WS engine resolves
 * `options.websocketImpl ?? globalThis.WebSocket`, and this driver never passes
 * one, so under Bun the transport is Bun's native class and under Node it is
 * undici's. Every integration test exercises code that Bun-only testing never
 * reaches.
 *
 * Only what the suite imports is implemented: `describe`, `test`, `expect`,
 * `beforeAll`, `afterAll`, `beforeEach`, `afterEach`, plus `test.each`,
 * `test.skip` and `test.only`. No mocking API is used anywhere in `tests/`, so
 * none is provided — a shim that pretends to more than it has is worse than one
 * that is honestly narrow.
 */

import {
	after,
	afterEach,
	before,
	beforeEach,
	it,
	describe as nodeDescribe,
} from "node:test";
import { expect } from "expect";
import * as jestExtended from "jest-extended";

// `toContainKey`, `toStartWith` and `toBeEmpty` are the three matchers the suite
// uses that the standalone `expect` package does not carry.
expect.extend(
	Object.fromEntries(
		Object.entries(jestExtended).filter(
			([, value]) => typeof value === "function",
		),
	),
);

/**
 * Bun runs a scope's `beforeAll` hooks sequentially, in registration order;
 * `node:test` runs sibling `before()` hooks **concurrently**.
 *
 * That difference is not cosmetic. Two `beforeAll`s where the second reads what
 * the first assigned — which is how several of these files start a server and
 * then connect to it — fail wholesale under the concurrent reading. So each
 * scope's hooks are collected and registered as one hook that awaits them in
 * order, which is Bun's behaviour.
 */
const newScope = () => ({
	before: { queue: [], registered: false },
	after: { queue: [], registered: false },
});

const scopes = [newScope()];

const serialised = (slot, register) => (fn) => {
	const scope = scopes[scopes.length - 1][slot];
	scope.queue.push(fn);
	if (scope.registered) return;
	scope.registered = true;
	register(async () => {
		for (const hook of scope.queue) await hook();
	});
};

const describe = Object.assign(
	(name, fn) =>
		nodeDescribe(name, function wrapped(...args) {
			// Pushed for the duration of the body, so hooks register against the
			// scope that declared them rather than the file's root.
			scopes.push(newScope());
			try {
				return fn.apply(this, args);
			} finally {
				scopes.pop();
			}
		}),
	{
		skip: (name, fn) => nodeDescribe.skip(name, fn),
		only: (name, fn) => nodeDescribe.only(name, fn),
	},
);

const test = Object.assign((name, fn) => it(name, fn), {
	skip: (name, fn) => it.skip(name, fn ?? (() => {})),
	only: (name, fn) => it.only(name, fn),
	todo: (name) => it.todo(name),
	// Bun's `test.each(cases)(name, fn)` spreads an array case into arguments.
	// The index is appended because `node:test` has no `%s` interpolation and two
	// cases would otherwise share a name.
	each: (cases) => (name, fn) => {
		for (const [index, testCase] of cases.entries()) {
			it(`${name} [${index}]`, () =>
				Array.isArray(testCase) ? fn(...testCase) : fn(testCase));
		}
	},
});

export { describe, test, test as it, expect, beforeEach, afterEach };
export const beforeAll = serialised("before", before);
export const afterAll = serialised("after", after);
