/**
 * Ordering a read by distance.
 *
 * `$near` means "nearest first", and SurrealDB will not order by a distance
 * directly: `ORDER BY` takes an **idiom** — a field path — so
 * `ORDER BY geo::distance(loc, $p) ASC` is a parse error, `Unexpected token
 * '::'`. What it does take is a *projected alias*, and an alias projected in a
 * subquery survives into the statement that reads it. So the distance is
 * selected under a name, ordered by that name, and the name is stripped again on
 * the way out:
 *
 *     SELECT * OMIT __mql_distance
 *       FROM (
 *         SELECT *, geo::distance(loc, $p0) AS __mql_distance
 *           FROM place WHERE type::is_point(loc)
 *          ORDER BY __mql_distance ASC
 *       )
 *      LIMIT 10
 *
 * Two details of that shape are load-bearing, and both were established against
 * a live server:
 *
 *   - the `ORDER BY` belongs to the **inner** select. An outer `ORDER BY` on the
 *     alias parses only while the outer field list happens to carry the alias
 *     too — `SELECT name FROM (…) ORDER BY __mql_distance` fails with `Missing
 *     order idiom`, so a projection would break it. The inner ordering survives
 *     the outer select, which leaves the outer free to project whatever the
 *     caller asked for;
 *   - `LIMIT`, `START` and `TIMEOUT` belong to the **outer** select. Inside they
 *     would truncate the set *before* the caller's paging applied to it.
 *
 * `OMIT` is only needed when the outer select is `*`; an explicit field list
 * cannot carry an alias it does not name.
 */

import { escapeIdentifier } from "../../surreal/sql/escape.ts";
import { statement } from "../../surreal/sql/statement.ts";

/**
 * The alias the projected distance is ordered by.
 *
 * Prefixed so it cannot be mistaken for a caller's field: a document with a
 * field of this exact name would have it shadowed for the duration of one
 * `$near` read.
 */
export const DISTANCE_ALIAS = "__mql_distance";

/** What a distance-ordered read needs to know beyond its filter. */
export interface NearSource {
	/** `FROM` source: the table, or the subquery that carries the ordering. */
	readonly from: string;
	/** `WHERE` clause for the enclosing statement, empty once the subquery has it. */
	readonly where: string;
	/** `WITH INDEX` hint, empty once the subquery has it. */
	readonly indexHint: string;
	/** Fields to omit from a `SELECT *`, empty when there is no alias to hide. */
	readonly omit: string;
}

/**
 * Build the `FROM` source for a read, ordered by distance when one applies.
 *
 * `distance` is the expression `translateFilter` reported for a `$near`, or
 * `undefined` — because the filter has none, or because the caller gave an
 * explicit `sort`, which MongoDB lets win over the implied distance ordering.
 * Without it this is the plain table, and every clause stays where it was.
 */
export function nearSource(
	table: string,
	where: string,
	indexHint: string,
	distance: string | undefined,
): NearSource {
	if (!distance) {
		return { from: table, where, indexHint, omit: "" };
	}

	const alias = escapeIdentifier(DISTANCE_ALIAS);
	const inner = statement(
		`SELECT *, ${distance} AS ${alias} FROM ${table}`,
		indexHint,
		where && `WHERE ${where}`,
		`ORDER BY ${alias} ASC`,
	);

	return { from: `(${inner})`, where: "", indexHint: "", omit: alias };
}

/** The `SELECT` field list for a read, hiding the distance alias from a `*`. */
export function nearProjection(fields: string, omit: string): string {
	if (fields) return fields;
	return omit ? `* OMIT ${omit}` : "*";
}
