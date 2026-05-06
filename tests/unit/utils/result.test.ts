import { describe, expect, test } from "bun:test";
import { ObjectId } from "../../../src/object-id.ts";
import {
	makeDeleteResult,
	makeInsertManyResult,
	makeInsertOneResult,
	makeUpdateResult,
} from "../../../src/utils/result.ts";

describe("makeInsertOneResult", () => {
	test("returns acknowledged + insertedId", () => {
		const oid = new ObjectId();
		expect(makeInsertOneResult(oid)).toEqual({
			acknowledged: true,
			insertedId: oid,
		});
	});

	test("accepts a string id", () => {
		expect(makeInsertOneResult("abc")).toEqual({
			acknowledged: true,
			insertedId: "abc",
		});
	});
});

describe("makeInsertManyResult", () => {
	test("indexes ids by position", () => {
		const a = new ObjectId();
		const b = new ObjectId();
		expect(makeInsertManyResult([a, b])).toEqual({
			acknowledged: true,
			insertedCount: 2,
			insertedIds: { 0: a, 1: b },
		});
	});

	test("empty input yields empty map and zero count", () => {
		expect(makeInsertManyResult([])).toEqual({
			acknowledged: true,
			insertedCount: 0,
			insertedIds: {},
		});
	});
});

describe("makeUpdateResult", () => {
	test("matched and modified counts come from row count", () => {
		const r = makeUpdateResult([{ id: 1 }, { id: 2 }]);
		expect(r).toEqual({
			acknowledged: true,
			matchedCount: 2,
			modifiedCount: 2,
			upsertedId: null,
			upsertedCount: 0,
		});
	});

	test("no rows yields zeros and null upserted id", () => {
		expect(makeUpdateResult([])).toEqual({
			acknowledged: true,
			matchedCount: 0,
			modifiedCount: 0,
			upsertedId: null,
			upsertedCount: 0,
		});
	});

	test("upsertedId increments upsertedCount to 1", () => {
		const r = makeUpdateResult([{ id: 1 }], "upsert-1");
		expect(r.upsertedId).toBe("upsert-1");
		expect(r.upsertedCount).toBe(1);
	});

	test("explicit null upserted id stays at 0 count", () => {
		const r = makeUpdateResult([{ id: 1 }], null);
		expect(r.upsertedCount).toBe(0);
	});
});

describe("makeDeleteResult", () => {
	test("preserves the deleted count", () => {
		expect(makeDeleteResult(3)).toEqual({
			acknowledged: true,
			deletedCount: 3,
		});
	});

	test("zero count is allowed", () => {
		expect(makeDeleteResult(0)).toEqual({
			acknowledged: true,
			deletedCount: 0,
		});
	});
});
