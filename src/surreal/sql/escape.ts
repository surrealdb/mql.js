/**
 * SurrealQL identifier escaping, and the inverse.
 *
 * Every identifier this driver splices into SQL — table names, database names,
 * index names and document field paths — goes through here. Values never do;
 * they are always sent as bound parameters.
 *
 * The reverse direction lives here too (`unescapeSurrealString`), because it is
 * the same knowledge read backwards: SurrealDB names values in its error
 * messages as SurrealQL literals, so recovering the text one stands for means
 * undoing exactly the escaping described below.
 *
 * Escaping field paths is not cosmetic. Without it:
 *   - a legal MongoDB field name containing a space (`{'first name': 'x'}`)
 *     produces a SurrealQL parse error;
 *   - a name containing a hyphen (`{'a-b': 1}`) is silently reinterpreted as
 *     subtraction, so the query returns the wrong documents;
 *   - and a crafted filter key is evaluated as an expression — a filter of
 *     `{'x` = 1 OR true OR `': 1}` matches every row. Filter keys routinely
 *     come from request input, which makes that an injection vector.
 */

/** Identifiers matching this need no quoting (unless reserved — see below). */
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** A path segment that is purely digits, i.e. a MongoDB array index. */
const ARRAY_INDEX = /^\d+$/;

/**
 * SurrealQL keywords that are rejected in an identifier position unless quoted.
 *
 * Determined empirically against SurrealDB 3.x rather than guessed: each
 * candidate keyword was used as a field name in every position this driver
 * emits one (WHERE, ORDER BY, SELECT list, SET target, DEFINE INDEX FIELDS and
 * as a function argument) and this is the union of those that failed to parse.
 * Quoting was then confirmed to fix all of them in all positions.
 *
 * Deliberately minimal — words that parse fine unquoted (`field`, `type`,
 * `group`, `order`, `limit`, `table`, `start`, `content`, `where`, `from`, …)
 * are left alone so generated SurrealQL stays readable.
 */
const RESERVED_WORDS = new Set([
	"break",
	"continue",
	"create",
	"define",
	"delete",
	"explain",
	"false",
	"for",
	"if",
	"info",
	"insert",
	"let",
	"none",
	"null",
	"relate",
	"remove",
	"return",
	"select",
	"throw",
	"true",
	"update",
	"upsert",
	"value",
]);

/**
 * Wrap `name` in backticks unconditionally, escaping any embedded backtick.
 *
 * The backslash escape is what stops a hostile identifier terminating the
 * quoted region and injecting SurrealQL; it round-trips correctly on 3.x.
 */
export function quoteIdentifier(name: string): string {
	return `\`${name.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;
}

/** True when `name` can be emitted bare. */
function isBareIdentifier(name: string): boolean {
	return SAFE_IDENTIFIER.test(name) && !RESERVED_WORDS.has(name.toLowerCase());
}

/**
 * Escape a table, database or index name for inclusion in a SurrealQL
 * statement. Plain identifiers pass through; anything else — including a name
 * that collides with a SurrealQL keyword — is quoted.
 */
export function escapeIdentifier(name: string): string {
	return isBareIdentifier(name) ? name : quoteIdentifier(name);
}

/**
 * Escape a MongoDB dot-notation field path for SurrealQL.
 *
 * Each segment is escaped independently, so `profile.email` stays a nested
 * access rather than becoming one field literally named `profile.email`.
 *
 * A purely numeric segment is a MongoDB array index and becomes SurrealQL
 * bracket syntax: `items.0.sku` → `items[0].sku`. (`items.0.sku` is a parse
 * error in SurrealQL, so passing it through unchanged never worked.) A leading
 * numeric segment is treated as a field name instead, since there is no
 * preceding array to index into.
 */
export function escapeFieldPath(field: string): string {
	const segments = field.split(".");
	let path = "";

	for (const [i, segment] of segments.entries()) {
		if (i > 0 && ARRAY_INDEX.test(segment)) {
			path += `[${segment}]`;
			continue;
		}
		path +=
			i === 0 ? escapeIdentifier(segment) : `.${escapeIdentifier(segment)}`;
	}

	return path;
}

/**
 * Escape a comma-separated list of field paths, as used by `DEFINE INDEX …
 * FIELDS a, b`.
 */
export function escapeFieldList(fields: readonly string[]): string {
	return fields.map(escapeFieldPath).join(", ");
}

/**
 * The single-character escapes SurrealDB emits inside a quoted string or
 * identifier, verified against 3.x by round-tripping each control character
 * through a record id and through a unique-index violation message.
 *
 * A backspace is *not* in the table: SurrealDB prints it as `\u{8}`, which the
 * code-point form below covers.
 */
const STRING_ESCAPES: Readonly<Record<string, string>> = {
	"0": "\0",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};

/** A `\u{1f600}` or `\uXXXX` escape's code point, and where it ends. */
interface CodePointEscape {
	/** The character the escape stands for. */
	char: string;
	/** Index of the escape's last character. */
	end: number;
}

/** Read the code point of a `\u{…}` or `\uXXXX` escape whose digits start at `from`. */
function readCodePoint(
	text: string,
	from: number,
): CodePointEscape | undefined {
	const braced = text[from] === "{";
	const start = braced ? from + 1 : from;
	const close = braced ? text.indexOf("}", start) : start + 4;

	if (close < 0 || close > text.length) return undefined;

	const digits = text.slice(start, close);
	if (!/^[0-9a-fA-F]{1,6}$/.test(digits)) return undefined;

	const code = Number.parseInt(digits, 16);
	if (code > 0x10ffff) return undefined;

	return { char: String.fromCodePoint(code), end: braced ? close : close - 1 };
}

/**
 * Recover the text a quoted SurrealQL string or identifier stands for.
 *
 * The escaping matters because it is the only thing that survives of a value's
 * exact bytes once SurrealDB has printed it: a duplicate-key failure names the
 * record it rejected and a unique-index violation names the value that collided,
 * and both are reported back to the caller as their own `_id` or field value.
 * Merely dropping the backslashes turns an `_id` of `'tab\there'` into
 * `'tabthere'` — the caller's primary key, silently altered in the report they
 * are told it collided with.
 *
 * An unrecognised escape yields the character itself, which is exactly right for
 * the quote and backslash escapes (`\\`, `` \` ``, `\'`, `\"`).
 */
export function unescapeSurrealString(text: string): string {
	if (!text.includes("\\")) return text;

	let out = "";
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];

		// A trailing backslash escapes nothing, so it is its own character.
		if (char !== "\\" || i === text.length - 1) {
			out += char;
			continue;
		}

		i += 1;
		const escaped = text[i];

		if (escaped === "u") {
			const point = readCodePoint(text, i + 1);
			if (point) {
				out += point.char;
				i = point.end;
				continue;
			}
		}

		out += STRING_ESCAPES[escaped] ?? escaped;
	}

	return out;
}
