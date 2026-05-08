/**
 * SurrealQL identifier escaping. Used for table names, database names and
 * any other places where user-supplied identifiers are spliced into SQL.
 */

/** Plain identifiers that match this pass through unquoted. */
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Escape a table or database name for safe inclusion in a SurrealQL
 * statement. Identifiers that are alphanumeric pass through; anything
 * else is wrapped in backticks (with embedded backticks escaped).
 */
export function escapeIdentifier(name: string): string {
	if (SAFE_IDENTIFIER.test(name)) return name;
	return `\`${name.replace(/`/g, "\\`")}\``;
}

/** Alias used by translators; field paths support dot-notation natively. */
export function escapeField(field: string): string {
	return field;
}
