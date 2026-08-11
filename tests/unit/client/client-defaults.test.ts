/**
 * The two client options that are defaults for every operation.
 *
 * A client-level setting that never reaches a statement is the trap this policy
 * exists to prevent, so these assert on the SurrealQL the operations emit.
 */

import { describe, expect, test } from "bun:test";
import { findOne } from "../../../src/collection/operations/find.ts";
import { insertOne } from "../../../src/collection/operations/insert.ts";
import { makeContext } from "../../helpers/operation-context.ts";

describe("timeoutMS from the client", () => {
	test("becomes a TIMEOUT clause on an operation that passes no options", async () => {
		const { ctx, executor } = makeContext({ defaults: { timeoutMS: 750 } });
		await findOne(ctx, {});

		expect(executor.queries[0]?.sql).toContain("TIMEOUT 750ms");
	});

	test("yields to a tighter per-operation budget", async () => {
		const { ctx, executor } = makeContext({ defaults: { timeoutMS: 750 } });
		await findOne(ctx, {}, { maxTimeMS: 100 });

		expect(executor.queries[0]?.sql).toContain("TIMEOUT 100ms");
	});

	test("binds when the per-operation budget is looser", async () => {
		const { ctx, executor } = makeContext({ defaults: { timeoutMS: 100 } });
		await findOne(ctx, {}, { maxTimeMS: 5000 });

		expect(executor.queries[0]?.sql).toContain("TIMEOUT 100ms");
	});

	test("adds no clause when the client set no budget", async () => {
		const { ctx, executor } = makeContext();
		await findOne(ctx, {});

		expect(executor.queries[0]?.sql).not.toContain("TIMEOUT");
	});
});

describe("ignoreUndefined from the client", () => {
	test("drops undefined properties on an operation that passes no options", async () => {
		const { ctx, executor } = makeContext({
			defaults: { ignoreUndefined: true },
		});
		await insertOne(ctx, { name: "a", nickname: undefined });

		expect(JSON.stringify(executor.queries[0]?.bindings)).not.toContain(
			"nickname",
		);
	});

	test("is overridden by an explicit false on the operation", async () => {
		const { ctx, executor } = makeContext({
			defaults: { ignoreUndefined: true },
		});
		await insertOne(
			ctx,
			{ name: "a", nickname: undefined },
			{
				ignoreUndefined: false,
			},
		);

		expect(JSON.stringify(executor.queries[0]?.bindings)).toContain("nickname");
	});
});
