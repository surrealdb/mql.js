import { describe, expect, test } from "bun:test";
import { MongoInvalidArgumentError } from "../../../src/errors.ts";
import { translateProjection } from "../../../src/translators/projection.ts";

describe("translateProjection", () => {
	test("null / undefined returns defaults", () => {
		const r = translateProjection(null);
		expect(r.fields).toBe("");
		expect(r.isExclusion).toBe(false);
		expect(r.includeId).toBe(true);
	});

	test("empty object returns defaults", () => {
		const r = translateProjection({});
		expect(r.fields).toBe("");
		expect(r.includeId).toBe(true);
	});

	test("inclusion projection returns field list", () => {
		const r = translateProjection({ name: 1, age: 1 });
		expect(r.fields).toBe("id, `name`, `age`");
		expect(r.isExclusion).toBe(false);
		expect(r.includeId).toBe(true);
	});

	// MongoDB returns `_id` alongside an inclusion projection without being asked
	// for it, and `_id` is SurrealDB's `id` column rather than a document field —
	// so a field list that does not name `id` yields documents with no identity.
	test("an inclusion projection selects the identity column", () => {
		expect(translateProjection({ name: 1 }).fields).toBe("id, `name`");
		expect(translateProjection({ _id: 1, name: 1 }).fields).toBe("id, `name`");
	});

	test("a suppressed _id keeps the identity column out of the field list", () => {
		expect(translateProjection({ name: 1, _id: 0 }).fields).toBe("`name`");
	});

	test("inclusion with _id: 0 excludes id", () => {
		const r = translateProjection({ _id: 0, name: 1 });
		expect(r.fields).toBe("`name`");
		expect(r.includeId).toBe(false);
	});

	test("exclusion projection sets isExclusion", () => {
		const r = translateProjection({ password: 0, secret: 0 });
		expect(r.fields).toBe("");
		expect(r.isExclusion).toBe(true);
		expect(r.excludeFields).toEqual(["password", "secret"]);
		expect(r.includeId).toBe(true);
	});

	test("exclusion with _id: 0", () => {
		const r = translateProjection({ _id: 0, password: 0 });
		expect(r.isExclusion).toBe(true);
		expect(r.excludeFields).toEqual(["password"]);
		expect(r.includeId).toBe(false);
	});

	test("only _id: 0 returns defaults with includeId false", () => {
		const r = translateProjection({ _id: 0 });
		expect(r.fields).toBe("");
		expect(r.isExclusion).toBe(false);
		expect(r.includeId).toBe(false);
	});

	// `{_id: 1}` names one field to include, so the answer carries `_id` and
	// nothing else. Reading "no keys besides `_id`" as "nothing was named,
	// therefore `SELECT *`" handed back every field the caller had just declined to
	// ask for — which for a caller projecting `{_id: 1}` to *avoid* reading a
	// document's contents is the opposite of what it asked.
	test("only _id: 1 selects the identity column alone", () => {
		const r = translateProjection({ _id: 1 });
		expect(r.fields).toBe("id");
		expect(r.isExclusion).toBe(false);
		expect(r.includeId).toBe(true);
	});

	// -----------------------------------------------------------------------
	// Mixing inclusion and exclusion. The mode used to be taken from the first
	// key, so `{ a: 1, b: 0 }` and `{ b: 0, a: 1 }` gave different results.
	// MongoDB rejects the mix outright; `_id` is the only exempt key.
	// -----------------------------------------------------------------------

	test("mixing inclusion and exclusion throws", () => {
		expect(() => translateProjection({ a: 1, b: 0 })).toThrow(
			MongoInvalidArgumentError,
		);
		expect(() => translateProjection({ a: 1, b: 0 })).toThrow(
			"Cannot do exclusion on field b in inclusion projection",
		);
	});

	test("mixing is rejected regardless of key order", () => {
		expect(() => translateProjection({ b: 0, a: 1 })).toThrow(
			MongoInvalidArgumentError,
		);
		expect(() => translateProjection({ b: 0, a: 1 })).toThrow(
			"Cannot do inclusion on field a in exclusion projection",
		);
	});

	test("a pure projection gives the same result in either key order", () => {
		expect(translateProjection({ a: 1, b: 1 }).fields).toBe("id, `a`, `b`");
		expect(translateProjection({ b: 1, a: 1 }).fields).toBe("id, `b`, `a`");
		expect(translateProjection({ a: 0, b: 0 }).excludeFields).toEqual([
			"a",
			"b",
		]);
		expect(translateProjection({ b: 0, a: 0 }).excludeFields).toEqual([
			"b",
			"a",
		]);
	});

	test("_id is exempt from the mixing rule in both directions", () => {
		// `{ a: 1, _id: 0 }` — the documented exception.
		const inclusion = translateProjection({ a: 1, _id: 0 });
		expect(inclusion.fields).toBe("`a`");
		expect(inclusion.isExclusion).toBe(false);
		expect(inclusion.includeId).toBe(false);

		// `{ a: 0, _id: 1 }` — MongoDB also accepts an explicit `_id: 1`
		// alongside exclusions, since `_id` is included by default anyway.
		const exclusion = translateProjection({ a: 0, _id: 1 });
		expect(exclusion.isExclusion).toBe(true);
		expect(exclusion.excludeFields).toEqual(["a"]);
		expect(exclusion.includeId).toBe(true);
	});

	test("nested exclusion paths are passed through unescaped", () => {
		// They are document keys walked in memory by `applyProjection`, not SQL.
		const r = translateProjection({ "auth.pw": 0 });
		expect(r.isExclusion).toBe(true);
		expect(r.excludeFields).toEqual(["auth.pw"]);
	});

	test("boolean true/false works like 1/0", () => {
		const r = translateProjection({ name: true, age: true } as Record<
			string,
			0 | 1 | boolean
		>);
		expect(r.fields).toBe("id, `name`, `age`");
	});
});
