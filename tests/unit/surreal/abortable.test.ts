import { describe, expect, test } from "bun:test";
import {
	MongoCompatibilityError,
	MongoInvalidArgumentError,
} from "../../../src/errors.ts";
import { abortable } from "../../../src/surreal/abortable.ts";
import { FakeQueryExecutor } from "../../helpers/fake-executor.ts";

describe("abortable", () => {
	test("no signal leaves the executor exactly as it was", () => {
		const executor = new FakeQueryExecutor();
		expect(abortable(executor, undefined, false)).toBe(executor);
		expect(executor.signals).toEqual([]);
	});

	test("a signal scopes the executor to it", () => {
		const executor = new FakeQueryExecutor();
		const controller = new AbortController();
		abortable(executor, controller.signal, false);
		expect(executor.signals).toEqual([controller.signal]);
	});

	test("something that is not an AbortSignal is refused, as MongoDB refuses it", () => {
		const executor = new FakeQueryExecutor();
		for (const bad of [null, true, "abort", {}, { aborted: false }, 7]) {
			expect(() => abortable(executor, bad, false)).toThrow(
				MongoInvalidArgumentError,
			);
		}
		expect(executor.signals).toEqual([]);
	});

	test("a signal inside a transaction is refused, naming why", () => {
		const executor = new FakeQueryExecutor();
		expect(() =>
			abortable(executor, new AbortController().signal, true),
		).toThrow(MongoCompatibilityError);
		expect(() =>
			abortable(executor, new AbortController().signal, true),
		).toThrow(/cannot be stopped/);
		expect(executor.signals).toEqual([]);
	});

	test("an already-aborted signal is still a valid signal", () => {
		const executor = new FakeQueryExecutor();
		const controller = new AbortController();
		controller.abort();
		expect(() => abortable(executor, controller.signal, false)).not.toThrow();
	});
});
