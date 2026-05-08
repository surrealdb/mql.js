import { describe, expect, test } from "bun:test";
import {
	BSON_TYPE_NAMES_V2,
	isV3Dialect,
	resolveDialect,
	V2Dialect,
	V3Dialect,
} from "../../../src/translators/dialect/index.ts";

describe("resolveDialect", () => {
	test("undefined version → v3 (assume latest)", () => {
		expect(resolveDialect(undefined).id).toBe("v3");
	});

	test("garbage / non-numeric major → v3 fallback", () => {
		expect(resolveDialect("not-a-version").id).toBe("v3");
		expect(resolveDialect("").id).toBe("v3");
	});

	test("major < 3 → v2", () => {
		expect(resolveDialect("2.0.0").id).toBe("v2");
		expect(resolveDialect("2.3.7").id).toBe("v2");
		expect(resolveDialect("1.5.0").id).toBe("v2");
	});

	test("major >= 3 → v3", () => {
		expect(resolveDialect("3.0.0").id).toBe("v3");
		expect(resolveDialect("3.0.4").id).toBe("v3");
		expect(resolveDialect("4.99.0").id).toBe("v3");
	});
});

describe("isV3Dialect", () => {
	test("matches resolveDialect().id === 'v3'", () => {
		for (const v of [undefined, "2.0.0", "3.0.0", "garbage"]) {
			expect(isV3Dialect(v)).toBe(resolveDialect(v).id === "v3");
		}
	});
});

describe("V2Dialect", () => {
	const v2 = new V2Dialect();

	test("regex match uses the legacy `~` operator", () => {
		expect(v2.regexMatch("name", "$p0")).toBe("name ~ $p0");
	});

	test("type-check uses the namespaced `type::is::*` form", () => {
		expect(v2.typeCheckFn("string")).toBe("type::is::string");
		expect(v2.typeCheckFn(2)).toBe("type::is::string");
		expect(v2.typeCheckFn("number")).toBe("type::is::number");
	});

	test("typeCheckFn returns undefined for unsupported BSON aliases", () => {
		expect(v2.typeCheckFn("binData")).toBeUndefined();
	});

	test("full-text keyword is SEARCH", () => {
		expect(v2.fullTextKeyword).toBe("SEARCH");
	});

	test("ensureBlankAnalyzerSql() returns null on v2 (built-in)", () => {
		expect(v2.ensureBlankAnalyzerSql()).toBeNull();
	});
});

describe("V3Dialect", () => {
	const v3 = new V3Dialect();

	test("regex match uses string::matches()", () => {
		expect(v3.regexMatch("name", "$p0")).toBe("string::matches(name, $p0)");
	});

	test("type-check renames namespace to `type::is_*`", () => {
		expect(v3.typeCheckFn("string")).toBe("type::is_string");
		expect(v3.typeCheckFn(2)).toBe("type::is_string");
		expect(v3.typeCheckFn("number")).toBe("type::is_number");
		expect(v3.typeCheckFn("date")).toBe("type::is_datetime");
	});

	test("typeCheckFn returns undefined for unsupported BSON aliases", () => {
		expect(v3.typeCheckFn("binData")).toBeUndefined();
	});

	test("full-text keyword is FULLTEXT", () => {
		expect(v3.fullTextKeyword).toBe("FULLTEXT");
	});

	test("ensureBlankAnalyzerSql() emits the analyzer DDL on v3", () => {
		expect(v3.ensureBlankAnalyzerSql()).toBe(
			"DEFINE ANALYZER IF NOT EXISTS blank TOKENIZERS blank FILTERS lowercase",
		);
	});
});

describe("BSON_TYPE_NAMES_V2 table", () => {
	test("covers all documented MongoDB type aliases", () => {
		const aliases = [
			"double",
			"string",
			"object",
			"array",
			"bool",
			"date",
			"null",
			"int",
			"long",
			"decimal",
			"number",
		];
		for (const alias of aliases) {
			expect(BSON_TYPE_NAMES_V2[alias]).toMatch(/^type::is::/);
		}
	});

	test("numeric BSON codes mirror the named aliases", () => {
		expect(BSON_TYPE_NAMES_V2[1]).toBe(BSON_TYPE_NAMES_V2.double);
		expect(BSON_TYPE_NAMES_V2[2]).toBe(BSON_TYPE_NAMES_V2.string);
		expect(BSON_TYPE_NAMES_V2[3]).toBe(BSON_TYPE_NAMES_V2.object);
		expect(BSON_TYPE_NAMES_V2[4]).toBe(BSON_TYPE_NAMES_V2.array);
		expect(BSON_TYPE_NAMES_V2[8]).toBe(BSON_TYPE_NAMES_V2.bool);
		expect(BSON_TYPE_NAMES_V2[9]).toBe(BSON_TYPE_NAMES_V2.date);
		expect(BSON_TYPE_NAMES_V2[10]).toBe(BSON_TYPE_NAMES_V2.null);
		expect(BSON_TYPE_NAMES_V2[16]).toBe(BSON_TYPE_NAMES_V2.int);
		expect(BSON_TYPE_NAMES_V2[18]).toBe(BSON_TYPE_NAMES_V2.long);
		expect(BSON_TYPE_NAMES_V2[19]).toBe(BSON_TYPE_NAMES_V2.decimal);
	});
});
