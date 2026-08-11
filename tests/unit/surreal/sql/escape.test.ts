import { describe, expect, test } from "bun:test";
import {
	escapeFieldList,
	escapeFieldPath,
	escapeIdentifier,
	quoteIdentifier,
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
		expect(escapeIdentifier("")).toBe("``");
	});

	test("unicode characters trigger quoting", () => {
		expect(escapeIdentifier("café")).toBe("`café`");
	});

	test("SurrealQL keywords are quoted even though they look safe", () => {
		// Verified against 3.x: these fail to parse in an identifier position.
		for (const word of ["select", "if", "let", "return", "delete", "value"]) {
			expect(escapeIdentifier(word)).toBe(`\`${word}\``);
		}
	});

	test("keyword matching is case-insensitive", () => {
		expect(escapeIdentifier("SELECT")).toBe("`SELECT`");
		expect(escapeIdentifier("Select")).toBe("`Select`");
	});

	test("words that parse fine unquoted are left alone", () => {
		// Deliberately not over-quoting keeps generated SurrealQL readable.
		for (const word of ["field", "type", "group", "order", "limit", "table"]) {
			expect(escapeIdentifier(word)).toBe(word);
		}
	});
});

describe("quoteIdentifier", () => {
	test("always quotes, even a safe identifier", () => {
		expect(quoteIdentifier("users")).toBe("`users`");
	});

	test("escapes backslashes before backticks so the escape cannot be escaped", () => {
		// A trailing backslash would otherwise escape the closing backtick and
		// let the rest of the name out of the quoted region.
		expect(quoteIdentifier("a\\")).toBe("`a\\\\`");
	});
});

describe("escapeFieldPath", () => {
	test("a simple field is unchanged", () => {
		expect(escapeFieldPath("plain")).toBe("plain");
	});

	test("dot-notation stays a nested access, escaped per segment", () => {
		expect(escapeFieldPath("address.city")).toBe("address.city");
		expect(escapeFieldPath("a.b.c.d")).toBe("a.b.c.d");
	});

	test("only the offending segment is quoted", () => {
		expect(escapeFieldPath("profile.first name")).toBe("profile.`first name`");
		expect(escapeFieldPath("a-b.c")).toBe("`a-b`.c");
	});

	test("a numeric segment becomes a SurrealQL array index", () => {
		// `items.0.sku` is a parse error in SurrealQL, so this was never valid.
		expect(escapeFieldPath("items.0.sku")).toBe("items[0].sku");
		expect(escapeFieldPath("a.10")).toBe("a[10]");
	});

	test("a leading numeric segment is a field name, not an index", () => {
		// There is no preceding array to index into.
		expect(escapeFieldPath("0")).toBe("`0`");
		expect(escapeFieldPath("0.sku")).toBe("`0`.sku");
	});

	test("keyword segments are quoted mid-path", () => {
		expect(escapeFieldPath("doc.select")).toBe("doc.`select`");
		expect(escapeFieldPath("scores.value")).toBe("scores.`value`");
	});
});

describe("injection resistance", () => {
	/**
	 * These are the shapes that made an unescaped field path exploitable: a
	 * filter key is attacker-controlled whenever an application builds filters
	 * from request input. Escaped, each one can only ever name a field.
	 */
	const hostile = [
		"1=1 OR normal",
		"x` = 1 OR true OR `",
		"a` OR true --",
		"name`; REMOVE TABLE users; --",
		"*",
		") OR (1=1",
	];

	for (const key of hostile) {
		test(`"${key}" cannot escape its identifier position`, () => {
			const escaped = escapeFieldPath(key);
			// It must be a single quoted region: opening and closing backticks
			// only, with every interior backtick neutralised.
			expect(escaped.startsWith("`")).toBe(true);
			expect(escaped.endsWith("`")).toBe(true);
			const interior = escaped.slice(1, -1);
			// No unescaped backtick may appear inside.
			expect(/(?<!\\)`/.test(interior)).toBe(false);
		});
	}

	test("a hostile segment inside a path is contained too", () => {
		const escaped = escapeFieldPath("profile.x` = 1 OR true OR `");
		expect(escaped).toBe("profile.`x\\` = 1 OR true OR \\``");
	});
});

describe("escapeFieldList", () => {
	test("escapes each path and joins with a comma", () => {
		expect(escapeFieldList(["a", "b"])).toBe("a, b");
		expect(escapeFieldList(["first name", "profile.email"])).toBe(
			"`first name`, profile.email",
		);
	});

	test("returns an empty string for no fields", () => {
		expect(escapeFieldList([])).toBe("");
	});
});
