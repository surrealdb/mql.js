import { describe, expect, test } from "bun:test";
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
		expect(r.fields).toBe("name, age");
		expect(r.isExclusion).toBe(false);
		expect(r.includeId).toBe(true);
	});

	test("inclusion with _id: 0 excludes id", () => {
		const r = translateProjection({ _id: 0, name: 1 });
		expect(r.fields).toBe("name");
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

	test("boolean true/false works like 1/0", () => {
		const r = translateProjection({ name: true, age: true } as Record<
			string,
			0 | 1 | boolean
		>);
		expect(r.fields).toBe("name, age");
	});
});
