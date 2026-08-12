/**
 * Building the `FROM` source of a read, and placing its ordering.
 *
 * SurrealDB requires every `ORDER BY` idiom to appear in the statement's own
 * field list. A `SELECT *` satisfies that trivially, and so does a field list
 * that happens to name what the ordering names, so most reads order in place. The
 * two ways a read can be ordered part company at exactly the point where it does
 * not hold:
 *
 *   - **the caller's `sort`** names fields, so a field list *can* carry it, and
 *     when it does the `ORDER BY` sits on the statement itself. When it does not —
 *     `SELECT tag FROM t ORDER BY k`, which SurrealDB rejects with
 *     `Missing order idiom \`k\` in statement selection` — the read is **refused**
 *     with a `MongoCompatibilityError` naming the columns the field list is
 *     missing. MongoDB answers that shape, so this is a documented divergence, and
 *     the constraint is SurrealDB's rather than this driver's: it is filed as
 *     `surrealdb/surrealdb-private#900`, and relaxing it upstream makes every such
 *     read order in place with no change here.
 *   - **`$near`** cannot be carried by any field list. "Nearest first" is an
 *     ordering by a computed distance, and `ORDER BY` takes an idiom rather than
 *     an expression, so `ORDER BY geo::distance(loc, $p) ASC` does not even parse
 *     (`Unexpected token '::'`). The distance is therefore projected under an
 *     alias in a **subquery**, whose `*` carries it, ordered by that alias inside,
 *     and hidden on the way out:
 *
 *     SELECT * OMIT __mql_distance
 *       FROM (
 *         SELECT *, geo::distance(loc, $p0) AS __mql_distance
 *           FROM place WHERE type::is_point(loc)
 *          ORDER BY __mql_distance ASC
 *          LIMIT 10
 *       )
 *
 * A subquery would satisfy the constraint for the caller's `sort` too — order a
 * `SELECT *` inside, project outside — and it is not used, because it is not free.
 * Measured on 3.2.x, a sorted, projected, paged read costs 2.7 to 4.1 times what
 * the same read ordered in place costs, widening as the table grows, and paying
 * that on every projected read to serve one shape trades a loud, explainable
 * refusal for a quiet cliff under the reads that already work. Nor is there a
 * cheaper way round: naming the ordering's columns in the field list alongside the
 * caller's and stripping them afterwards is what `oneRecordTarget` does, and it
 * works *there* because the only field it wants is `id`, so an enclosing
 * `SELECT VALUE id` discards the extras for free. A read's field list is the
 * caller's projection, so a sort on `a.b` under a projection of `a.c` would have
 * to select `a.c, a.b`, then delete `b` from the returned `a` and delete `a`
 * itself if nothing else survived — reshaping nested documents by hand, without
 * touching a sort column the projection legitimately asked for too, and leaking
 * whatever that reshaping missed into the caller's documents.
 *
 * Details of the `$near` shape that are load-bearing, each established against a
 * live server rather than reasoned about:
 *
 *   - the `ORDER BY` belongs to the **inner** select, and its ordering survives
 *     into the outer one. An outer `ORDER BY` cannot name the alias at all once
 *     the outer field list is a projection that does not mention it;
 *   - `WHERE` and `WITH INDEX` follow the ordering inwards. They have to: they
 *     select the rows being ordered;
 *   - `LIMIT` and `START` follow it inwards too. The enclosing select filters
 *     nothing, so paging the ordered rows and paging the projection of them are
 *     the same rows either way — but only the inner placement lets SurrealDB
 *     answer `ORDER BY … LIMIT n` from an index rather than ordering everything
 *     the filter matched and discarding all but a page of it, which on 3.2.x is
 *     several times the work;
 *   - `TIMEOUT` stays on the **outer** select: SurrealQL takes one, and it has to
 *     come last, so it bounds the whole statement rather than the subquery;
 *   - `OMIT` is only needed when the outer select is `*`; an explicit field list
 *     cannot carry an alias it does not name.
 *
 * The two orderings never meet, because MongoDB does not ask them to: an explicit
 * `sort` wins over the ordering `$near` implies, so a read either orders in place
 * by the caller's fields or nests to order by distance, never both.
 */

import { MongoCompatibilityError } from "../../errors.ts";
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

/** How a read is to be ordered, and what its field list will be. */
export interface ReadOrdering {
	/** The caller's `sort` as an `ORDER BY` clause, empty when there is none. */
	readonly sortClause: string;
	/**
	 * The columns that `sortClause` orders by, escaped as the field list escapes
	 * them, so the two can be compared directly.
	 */
	readonly sortFields: readonly string[];
	/** The distance expression a `$near` reported, if the filter had one. */
	readonly nearDistance: string | undefined;
	/**
	 * The `SELECT` field list an inclusion projection asks for, empty for `*`.
	 *
	 * This is what decides whether the caller's `sort` can be served: a `*` carries
	 * every idiom an `ORDER BY` could name, and a field list carries only what it
	 * names.
	 */
	readonly fields: string;
	/** How many documents the caller wants, if it said. */
	readonly limit: number | undefined;
	/** How many documents the caller wants skipped, if it said. */
	readonly skip: number | undefined;
}

/** What a read needs to know about its source beyond its filter. */
export interface ReadSource {
	/** `FROM` source: the table, or the subquery that carries the ordering. */
	readonly from: string;
	/** `WHERE` clause for the enclosing statement, empty once the subquery has it. */
	readonly where: string;
	/** `WITH INDEX` hint, empty once the subquery has it. */
	readonly indexHint: string;
	/** `ORDER BY` clause for the enclosing statement, empty once the subquery has it. */
	readonly orderBy: string;
	/** `LIMIT` clause for the enclosing statement, empty once the subquery has it. */
	readonly limit: string;
	/** `START` clause for the enclosing statement, empty once the subquery has it. */
	readonly start: string;
	/** Fields to omit from a `SELECT *`, empty when there is no alias to hide. */
	readonly omit: string;
}

/**
 * Build the `FROM` source for a read, ordered as `ordering` asks.
 *
 * Returns the plain table with every clause left where it was when the read needs
 * no ordering, or needs one its own field list can carry; a subquery when the
 * ordering is `$near`'s computed distance, which no field list can name. Throws
 * `MongoCompatibilityError` when the caller's `sort` names a column the field list
 * does not.
 */
export function readSource(
	table: string,
	where: string,
	indexHint: string,
	ordering: ReadOrdering,
): ReadSource {
	const { sortClause, sortFields, nearDistance, fields, limit, skip } =
		ordering;
	const limitClause = limit !== undefined ? `LIMIT ${limit}` : "";
	const startClause = skip !== undefined ? `START ${skip}` : "";

	const inPlace = (orderBy: string): ReadSource => ({
		from: table,
		where,
		indexHint,
		orderBy,
		limit: limitClause,
		start: startClause,
		omit: "",
	});

	/**
	 * Wrap an ordered select as the source of the enclosing statement.
	 *
	 * Every clause the subquery has taken over is emptied here rather than at each
	 * call site, so a clause cannot end up emitted twice.
	 */
	const nest = (select: string, orderBy: string, omit: string): ReadSource => ({
		from: `(${statement(select, indexHint, where && `WHERE ${where}`, orderBy, limitClause, startClause)})`,
		where: "",
		indexHint: "",
		orderBy: "",
		limit: "",
		start: "",
		omit,
	});

	// An explicit `sort` wins over the distance ordering `$near` implies, exactly
	// as it does in MongoDB — so the distance is not projected at all, and only one
	// of the two branches below can apply.
	if (sortClause) {
		// A `*` carries every idiom an `ORDER BY` could name, so it orders in place.
		if (!fields) return inPlace(sortClause);

		// An explicit field list only carries what it names. SurrealDB rejects an
		// ordering by anything else — `Missing order idiom` — so a sort the
		// projection does not select cannot be served.
		const projected = new Set(fields.split(",").map((field) => field.trim()));
		const missing = sortFields.filter((field) => !projected.has(field));
		if (missing.length > 0) {
			throw new MongoCompatibilityError(
				`Sorting by ${missing.join(", ")} while projecting a different set of fields is not supported: SurrealDB requires every ORDER BY field to appear in the statement's own field list. Include ${missing.length === 1 ? "that field" : "those fields"} in the projection, use an exclusion projection instead, or sort the results after reading them.`,
			);
		}

		return inPlace(sortClause);
	}

	if (!nearDistance) return inPlace("");

	const alias = escapeIdentifier(DISTANCE_ALIAS);
	return nest(
		`SELECT *, ${nearDistance} AS ${alias} FROM ${table}`,
		`ORDER BY ${alias} ASC`,
		alias,
	);
}

/** The `SELECT` field list for a read, hiding any alias from a `*`. */
export function readProjection(fields: string, omit: string): string {
	if (fields) return fields;
	return omit ? `* OMIT ${omit}` : "*";
}
