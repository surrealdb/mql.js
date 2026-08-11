import { describe, expect, test } from "bun:test";
import { MongoCompatibilityError } from "../../../src/errors.ts";
import {
	BSON_TYPE_CHECK_FNS,
	isUnsupportedVersion,
	MINIMUM_SURREALDB_VERSION,
	majorVersionOf,
	resolveDialect,
	V3Dialect,
} from "../../../src/translators/dialect/index.ts";

describe("majorVersionOf", () => {
	test("extracts the major version", () => {
		expect(majorVersionOf("3.0.5")).toBe(3);
		expect(majorVersionOf("4.99.0")).toBe(4);
		expect(majorVersionOf("2.3.7")).toBe(2);
	});

	test("returns undefined for absent or unparseable versions", () => {
		expect(majorVersionOf(undefined)).toBeUndefined();
		expect(majorVersionOf("")).toBeUndefined();
		expect(majorVersionOf("not-a-version")).toBeUndefined();
	});
});

describe("isUnsupportedVersion", () => {
	test("flags SurrealDB 2.x and older", () => {
		expect(isUnsupportedVersion("2.3.7")).toBe(true);
		expect(isUnsupportedVersion("2.0.0")).toBe(true);
		expect(isUnsupportedVersion("1.5.0")).toBe(true);
	});

	test("accepts 3.x and newer", () => {
		expect(isUnsupportedVersion("3.0.0")).toBe(false);
		expect(isUnsupportedVersion("3.2.0")).toBe(false);
		expect(isUnsupportedVersion("4.99.0")).toBe(false);
	});

	test("treats an unknown version as supported, not unsupported", () => {
		expect(isUnsupportedVersion(undefined)).toBe(false);
		expect(isUnsupportedVersion("not-a-version")).toBe(false);
	});
});

describe("resolveDialect", () => {
	test("resolves the v3 dialect for supported versions", () => {
		expect(resolveDialect("3.0.0").id).toBe("v3");
		expect(resolveDialect("3.2.0").id).toBe("v3");
		expect(resolveDialect("4.99.0").id).toBe("v3");
	});

	test("defaults to the latest dialect when the version is unknown", () => {
		expect(resolveDialect(undefined).id).toBe("v3");
		expect(resolveDialect("not-a-version").id).toBe("v3");
		expect(resolveDialect("").id).toBe("v3");
	});

	test("rejects SurrealDB 2.x and older", () => {
		expect(() => resolveDialect("2.3.7")).toThrow(MongoCompatibilityError);
		expect(() => resolveDialect("1.0.0")).toThrow(MongoCompatibilityError);
	});

	test("the rejection names the offending and the minimum version", () => {
		expect(() => resolveDialect("2.3.7")).toThrow(
			new RegExp(
				`2\\.3\\.7.*${MINIMUM_SURREALDB_VERSION.replace(/\./g, "\\.")}`,
			),
		);
	});
});

describe("V3Dialect", () => {
	const v3 = new V3Dialect();

	test("regexMatch uses string::matches()", () => {
		expect(v3.regexMatch("name", "$p0")).toBe("string::matches(name, $p0)");
	});

	test("typeCheckFn uses the type::is_* spelling", () => {
		expect(v3.typeCheckFn("string")).toBe("type::is_string");
		expect(v3.typeCheckFn(2)).toBe("type::is_string");
		expect(v3.typeCheckFn("number")).toBe("type::is_number");
		expect(v3.typeCheckFn("date")).toBe("type::is_datetime");
	});

	test("typeCheckFn returns undefined for unsupported BSON aliases", () => {
		expect(v3.typeCheckFn("binData")).toBeUndefined();
	});

	test("fullTextKeyword is FULLTEXT", () => {
		expect(v3.fullTextKeyword).toBe("FULLTEXT");
	});

	test("ensureBlankAnalyzerSql emits the analyzer DDL", () => {
		expect(v3.ensureBlankAnalyzerSql()).toBe(
			"DEFINE ANALYZER IF NOT EXISTS blank TOKENIZERS blank FILTERS lowercase",
		);
	});
});

describe("BSON_TYPE_CHECK_FNS table", () => {
	test("every entry uses the 3.x type::is_* spelling", () => {
		for (const name of Object.values(BSON_TYPE_CHECK_FNS)) {
			expect(name).toMatch(/^type::is_/);
		}
	});

	test("numeric BSON codes alias their string counterparts", () => {
		expect(BSON_TYPE_CHECK_FNS[1]).toBe(BSON_TYPE_CHECK_FNS.double);
		expect(BSON_TYPE_CHECK_FNS[2]).toBe(BSON_TYPE_CHECK_FNS.string);
		expect(BSON_TYPE_CHECK_FNS[3]).toBe(BSON_TYPE_CHECK_FNS.object);
		expect(BSON_TYPE_CHECK_FNS[4]).toBe(BSON_TYPE_CHECK_FNS.array);
		expect(BSON_TYPE_CHECK_FNS[8]).toBe(BSON_TYPE_CHECK_FNS.bool);
		expect(BSON_TYPE_CHECK_FNS[9]).toBe(BSON_TYPE_CHECK_FNS.date);
		expect(BSON_TYPE_CHECK_FNS[10]).toBe(BSON_TYPE_CHECK_FNS.null);
		expect(BSON_TYPE_CHECK_FNS[16]).toBe(BSON_TYPE_CHECK_FNS.int);
		expect(BSON_TYPE_CHECK_FNS[18]).toBe(BSON_TYPE_CHECK_FNS.long);
		expect(BSON_TYPE_CHECK_FNS[19]).toBe(BSON_TYPE_CHECK_FNS.decimal);
	});
});
