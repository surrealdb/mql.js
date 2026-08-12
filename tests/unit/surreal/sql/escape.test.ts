import { describe, expect, test } from "bun:test";
import {
	escapeFieldList,
	escapeFieldPath,
	escapeIdentifier,
	unescapeSurrealString,
} from "../../../../src/surreal/sql/escape.ts";

describe("escapeIdentifier", () => {
	test("plain alphanumeric identifiers are quoted too", () => {
		expect(escapeIdentifier("users")).toBe("`users`");
		expect(escapeIdentifier("snake_case")).toBe("`snake_case`");
		expect(escapeIdentifier("camelCase123")).toBe("`camelCase123`");
		expect(escapeIdentifier("_underscore")).toBe("`_underscore`");
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

	test("escapes backslashes before backticks so the escape cannot be escaped", () => {
		// A trailing backslash would otherwise escape the closing backtick and
		// let the rest of the name out of the quoted region.
		expect(escapeIdentifier("a\\")).toBe("`a\\\\`");
	});

	/**
	 * Every name is quoted, including the ones that would have been legal bare.
	 * The list below is not decoration: each word was measured to fail *bare* in
	 * at least one position this driver emits an identifier in, on SurrealDB
	 * 3.2.3. Ten of them — `alter`, `function`, `rebuild`, `sleep`, `only`,
	 * `overwrite`, `and`, `rand`, `table`, `tb` — were missed by the hand-kept
	 * reserved-word list this replaced, so a collection or field with any of
	 * those names was simply broken.
	 */
	const MEASURED_BARE_FAILURES = [
		"alter",
		"and",
		"break",
		"continue",
		"create",
		"define",
		"delete",
		"explain",
		"false",
		"for",
		"function",
		"if",
		"info",
		"insert",
		"let",
		"none",
		"null",
		"only",
		"overwrite",
		"rand",
		"rebuild",
		"relate",
		"remove",
		"return",
		"select",
		"sleep",
		"table",
		"tb",
		"throw",
		"true",
		"update",
		"upsert",
		"value",
	];

	test("every word measured to fail bare is quoted", () => {
		for (const word of MEASURED_BARE_FAILURES) {
			expect(escapeIdentifier(word)).toBe(`\`${word}\``);
			expect(escapeIdentifier(word.toUpperCase())).toBe(
				`\`${word.toUpperCase()}\``,
			);
		}
	});

	/**
	 * The four most dangerous of those, because bare they do not fail loudly:
	 * `SELECT * FROM none` answers `[]`, `FROM true` answers `[true]`, and a
	 * field named `null` projects as `{"null": null}`. A caller with a
	 * collection so named would be answered wrongly rather than refused.
	 */
	test("words that read as a literal rather than failing are quoted", () => {
		for (const word of ["none", "null", "true", "false"]) {
			expect(escapeIdentifier(word)).toBe(`\`${word}\``);
		}
	});
});

describe("escapeFieldPath", () => {
	test("a simple field is quoted", () => {
		expect(escapeFieldPath("plain")).toBe("`plain`");
	});

	test("dot-notation stays a nested access, escaped per segment", () => {
		expect(escapeFieldPath("address.city")).toBe("`address`.`city`");
		expect(escapeFieldPath("a.b.c.d")).toBe("`a`.`b`.`c`.`d`");
	});

	test("a segment needing escaping is no different from one that does not", () => {
		expect(escapeFieldPath("profile.first name")).toBe(
			"`profile`.`first name`",
		);
		expect(escapeFieldPath("a-b.c")).toBe("`a-b`.`c`");
	});

	test("a numeric segment becomes a SurrealQL array index", () => {
		// `items.0.sku` is a parse error in SurrealQL, so this was never valid.
		expect(escapeFieldPath("items.0.sku")).toBe("`items`[0].`sku`");
		expect(escapeFieldPath("a.10")).toBe("`a`[10]");
	});

	test("a leading numeric segment is a field name, not an index", () => {
		// There is no preceding array to index into.
		expect(escapeFieldPath("0")).toBe("`0`");
		expect(escapeFieldPath("0.sku")).toBe("`0`.`sku`");
	});

	test("keyword segments are quoted mid-path", () => {
		expect(escapeFieldPath("doc.select")).toBe("`doc`.`select`");
		expect(escapeFieldPath("scores.value")).toBe("`scores`.`value`");
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
		expect(escaped).toBe("`profile`.`x\\` = 1 OR true OR \\``");
	});
});

describe("escapeFieldList", () => {
	test("escapes each path and joins with a comma", () => {
		expect(escapeFieldList(["a", "b"])).toBe("`a`, `b`");
		expect(escapeFieldList(["first name", "profile.email"])).toBe(
			"`first name`, `profile`.`email`",
		);
	});

	test("returns an empty string for no fields", () => {
		expect(escapeFieldList([])).toBe("");
	});
});

/**
 * The spellings here are what a live 3.x server printed for a record id and for
 * the value in a unique-index violation, character by character. They are the
 * only evidence left of a value's exact bytes once the server has named it in an
 * error, and that value is reported back to the caller as their own `_id` — so an
 * escape read wrongly is a primary key altered in the report.
 */
describe("unescapeSurrealString", () => {
	const escapes: [string, string][] = [
		["a\\tb", "a\tb"],
		["a\\nb", "a\nb"],
		["a\\rb", "a\rb"],
		["a\\fb", "a\fb"],
		["a\\0b", "a\0b"],
		["a\\u{8}b", "a\bb"],
		["a\\u{1f600}b", "a\u{1f600}b"],
		["a\\u0041b", "aAb"],
		["a\\\\b", "a\\b"],
		["a\\`b", "a`b"],
		["a\\'b", "a'b"],
		['a\\"b', 'a"b'],
	];

	for (const [printed, text] of escapes) {
		test(`\`${printed}\` is ${JSON.stringify(text)}`, () => {
			expect(unescapeSurrealString(printed)).toBe(text);
		});
	}

	test("text with no escape in it is returned unchanged", () => {
		const plain = "urn:uuid:1234";
		expect(unescapeSurrealString(plain)).toBe(plain);
	});

	test("undoes exactly what escapeIdentifier does", () => {
		for (const name of ["a`b", "a\\b", "back\\`tick", "plain"]) {
			const quoted = escapeIdentifier(name);
			expect(unescapeSurrealString(quoted.slice(1, -1))).toBe(name);
		}
	});

	// An escape the table does not name means the character itself, which is what
	// the quote escapes need; a malformed code point is not a code point.
	test("keeps the character of an escape it does not recognise", () => {
		expect(unescapeSurrealString("a\\zb")).toBe("azb");
		expect(unescapeSurrealString("a\\u{zz}b")).toBe("au{zz}b");
		expect(unescapeSurrealString("a\\u{110000}b")).toBe("au{110000}b");
		expect(unescapeSurrealString("trailing\\")).toBe("trailing\\");
	});
});
