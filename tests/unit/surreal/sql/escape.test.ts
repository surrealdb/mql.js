import { describe, expect, test } from "bun:test";
import {
	escapeField,
	escapeIdentifier,
} from "../../../../src/surreal/sql/escape.ts";

describe("escapeIdentifier", () => {
	test("plain alphanumeric identifiers pass through unquoted", () => {
		expect(escapeIdentifier("users")).toBe("users");
		expect(escapeIdentifier("snake_case")).toBe("snake_case");
		expect(escapeIdentifier("camelCase123")).toBe("camelCase123");
		expect(escapeIdentifier("_underscore")).toBe("_underscore");
	});

	test("identifiers starting with a digit are wrapped in backticks", () => {
		expect(escapeIdentifier("1users")).toBe("`1users`");
	});

	test("identifiers with spaces or hyphens are quoted", () => {
		expect(escapeIdentifier("with spaces")).toBe("`with spaces`");
		expect(escapeIdentifier("dashed-name")).toBe("`dashed-name`");
	});

	test("identifiers with dots are quoted (would otherwise look like a path)", () => {
		expect(escapeIdentifier("a.b")).toBe("`a.b`");
	});

	test("embedded backticks are backslash-escaped", () => {
		expect(escapeIdentifier("weird`name")).toBe("`weird\\`name`");
	});

	test("empty string is quoted (and not silently passed through)", () => {
		// Empty string fails the SAFE_IDENTIFIER regex → goes through the
		// quoted branch.
		expect(escapeIdentifier("")).toBe("``");
	});

	test("unicode characters trigger quoting", () => {
		expect(escapeIdentifier("café")).toBe("`café`");
	});
});

describe("escapeField", () => {
	test("passes dot-notation paths through unchanged", () => {
		expect(escapeField("address.city")).toBe("address.city");
		expect(escapeField("a.b.c.d")).toBe("a.b.c.d");
		expect(escapeField("plain")).toBe("plain");
	});
});
