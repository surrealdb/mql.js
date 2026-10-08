import { describe, expect, test } from "bun:test";
import { ClientExecutor } from "../../../src/client/client-executor.ts";
import { MongoNotConnectedError } from "../../../src/errors.ts";
import { FakeQueryExecutor } from "../../helpers/fake-executor.ts";

function gate(options: { closed?: boolean } = {}) {
	const calls = { ensured: 0 };
	return {
		calls,
		gate: {
			isClosed: () => options.closed ?? false,
			async ensureConnected() {
				calls.ensured += 1;
			},
		},
	};
}

describe("ClientExecutor – streaming rows", () => {
	test("connects on the first read, not when the iterator is built", async () => {
		const inner = new FakeQueryExecutor();
		inner.enqueue([{ a: 1 }, { a: 2 }]);
		const { gate: g, calls } = gate();
		const rows = new ClientExecutor(inner, g).queryRows("SELECT 1");

		expect(calls.ensured).toBe(0);
		expect(inner.queries).toEqual([]);

		const seen: unknown[] = [];
		for await (const row of rows) seen.push(row);
		expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
		expect(calls.ensured).toBe(1);
	});

	test("a closed client refuses with the error the official driver raises", async () => {
		const inner = new FakeQueryExecutor();
		const { gate: g } = gate({ closed: true });
		const rows = new ClientExecutor(inner, g).queryRows("SELECT 1");

		await expect(rows.next()).rejects.toThrow(MongoNotConnectedError);
		expect(inner.queries).toEqual([]);
	});

	test("leaving before the first read costs nothing, and connects nothing", async () => {
		const inner = new FakeQueryExecutor();
		const { gate: g, calls } = gate();
		const rows = new ClientExecutor(inner, g).queryRows("SELECT 1");

		await rows.return?.();
		expect(calls.ensured).toBe(0);
		expect(inner.queries).toEqual([]);
	});
});
