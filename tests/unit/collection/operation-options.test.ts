/**
 * The per-operation option gate.
 *
 * Validation only — the statement shapes each option produces are asserted next
 * to the operation that produces them.
 */

import { describe, expect, test } from "bun:test";
import {
	assertSupportedIndexOptions,
	assertSupportedOptions,
	resolveOperationPlan,
} from "../../../src/collection/operation-options.ts";
import {
	MongoErrorCode,
	MongoInvalidArgumentError,
	MongoServerError,
} from "../../../src/errors.ts";
import { makeContext } from "../../helpers/operation-context.ts";

/** The rendered `TIMEOUT` clause for a caller's options, or `""`. */
async function timeoutFor(options: Record<string, unknown>): Promise<string> {
	const { ctx } = makeContext();
	return (await resolveOperationPlan(ctx, options)).timeout;
}

describe("assertSupportedOptions", () => {
	test("no options, and unknown keys, are accepted", () => {
		expect(() => assertSupportedOptions(undefined)).not.toThrow();
		expect(() =>
			assertSupportedOptions({
				translateAliases: false,
				_bookkeeping: 1,
			} as never),
		).not.toThrow();
	});

	test("`session` is honoured elsewhere, so the gate has nothing to say about it", () => {
		// The gate decides which options this driver can serve; a session is served
		// by routing the statement into its transaction, which the collection does
		// when it builds the operation's context. Refusing it here would make every
		// transactional call impossible — and validating it here would duplicate
		// `sessionExecutor`, the one place that can tell a live session from an
		// ended one or one belonging to another client.
		expect(() =>
			assertSupportedOptions({ session: {} as never }),
		).not.toThrow();
		// A computed options bag routinely carries the key with nothing in it.
		expect(() =>
			assertSupportedOptions({ session: undefined as never }),
		).not.toThrow();
	});

	test("a value that asks for existing behaviour is not a request", () => {
		expect(() =>
			assertSupportedOptions({ bypassDocumentValidation: false } as never),
		).not.toThrow();
		expect(() =>
			assertSupportedOptions({ ordered: true } as never),
		).not.toThrow();
		expect(() =>
			assertSupportedOptions({ writeConcern: { w: 1 } }),
		).not.toThrow();
		expect(() =>
			assertSupportedOptions({ readConcern: { level: "majority" } }),
		).not.toThrow();
	});

	test("`min`/`max` are query index bounds this driver cannot express", () => {
		expect(() => assertSupportedOptions({ min: { a: 1 } } as never)).toThrow(
			/'min' is not supported/,
		);
	});

	test("an index specification's `min`/`max` mean something else", () => {
		// `CreateIndexesOptions.min`/`max` are a 2d index's coordinate limits, which
		// the index surface accepts and ignores.
		expect(() =>
			assertSupportedIndexOptions({ min: -180, max: 180 } as never),
		).not.toThrow();
		// Only those two names are redefined; the rest of the policy still applies,
		// so an index operation cannot smuggle in an option a query could not.
		expect(() =>
			assertSupportedIndexOptions({ collation: { locale: "en" } }),
		).toThrow(/'collation' is not supported/);
		expect(() =>
			assertSupportedIndexOptions({ readConcern: "linearizable" }),
		).toThrow(MongoServerError);
	});
});

describe("maxTimeMS / timeoutMS", () => {
	test("a limit becomes a millisecond duration, and the tightest one binds", async () => {
		expect(await timeoutFor({ maxTimeMS: 250 })).toBe("TIMEOUT 250ms");
		expect(await timeoutFor({ timeoutMS: 40 })).toBe("TIMEOUT 40ms");
		expect(await timeoutFor({ maxTimeMS: 250, timeoutMS: 40 })).toBe(
			"TIMEOUT 40ms",
		);
	});

	test("MongoDB's `0` for no limit yields no clause", async () => {
		expect(await timeoutFor({ maxTimeMS: 0 })).toBe("");
		expect(await timeoutFor({ maxTimeMS: undefined })).toBe("");
		expect(await timeoutFor({ maxTimeMS: null as never })).toBe("");
	});

	test("a non-number is a caller error", async () => {
		await expect(
			timeoutFor({ maxTimeMS: "500" as never }),
		).rejects.toBeInstanceOf(MongoInvalidArgumentError);
		await expect(timeoutFor({ maxTimeMS: Number.NaN })).rejects.toBeInstanceOf(
			MongoInvalidArgumentError,
		);
	});

	test("a negative or fractional limit is refused as MongoDB refuses it", async () => {
		await expect(timeoutFor({ maxTimeMS: -1 })).rejects.toThrow(
			/must be >= 0, actual value '-1'/,
		);
		await expect(timeoutFor({ maxTimeMS: 1.5 })).rejects.toThrow(
			/Expected an integer/,
		);
	});

	test("a limit past MongoDB's 32-bit ceiling is refused, not rendered", async () => {
		// `${1e21}` is `1e+21`, which is not a SurrealQL duration: rendering it
		// would turn the caller's time limit into a parse error.
		for (const value of [2_147_483_648, 1e21, Number.MAX_SAFE_INTEGER]) {
			const err = await timeoutFor({ maxTimeMS: value }).then(
				() => undefined,
				(e: unknown) => e as MongoServerError,
			);
			expect(err).toBeInstanceOf(MongoServerError);
			expect(err?.code).toBe(MongoErrorCode.BadValue);
			expect(err?.message).toContain("must be <= 2147483647");
		}
		expect(await timeoutFor({ maxTimeMS: 2_147_483_647 })).toBe(
			"TIMEOUT 2147483647ms",
		);
	});

	test("a client-wide budget applies, and an operation may tighten it", async () => {
		const { ctx } = makeContext({ defaults: { timeoutMS: 5_000 } });
		expect((await resolveOperationPlan(ctx, undefined)).timeout).toBe(
			"TIMEOUT 5000ms",
		);
		expect((await resolveOperationPlan(ctx, { maxTimeMS: 100 })).timeout).toBe(
			"TIMEOUT 100ms",
		);
		expect(
			(await resolveOperationPlan(ctx, { maxTimeMS: 60_000 })).timeout,
		).toBe("TIMEOUT 5000ms");
	});
});
