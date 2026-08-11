/**
 * Assembling SurrealQL statements from their clauses.
 *
 * SurrealQL fixes the clause order, and two of the clauses are decided far from
 * where the statement is built: `WITH INDEX` has to sit immediately after
 * `FROM <table>`, and `TIMEOUT` has to be last — putting it before `RETURN`
 * is a parse error, not a slower query. Composing statements from an ordered
 * list of clauses makes both structural, so an operation cannot append a
 * `TIMEOUT` in the wrong place or forget one.
 */

/**
 * Join the given clauses with single spaces, dropping the absent ones.
 *
 * `undefined`, `false` and `""` all mean "this clause does not apply", so a
 * conditional clause can be written inline as `where && \`WHERE ${where}\``
 * without the caller assembling the string by hand.
 */
export function statement(
	...clauses: readonly (string | false | undefined)[]
): string {
	return clauses
		.filter((clause): clause is string => Boolean(clause))
		.join(" ");
}
