/**
 * Translates a MongoDB sort specification into a SurrealQL ORDER BY clause.
 *
 * MongoDB sort formats:
 *   { name: 1, age: -1 }                → ORDER BY name ASC, age DESC
 *   [["name", 1], ["age", -1]]          → ORDER BY name ASC, age DESC
 *   "name"                              → ORDER BY name ASC
 *
 * SurrealQL:
 *   ORDER BY field ASC|DESC
 */

import { MongoInvalidArgumentError } from "../errors.ts";
import { escapeFieldPath } from "../surreal/sql/escape.ts";
// Imported from the declaring module rather than the `types.ts` barrel: the
// barrel deliberately re-exports only the public option types, and
// `SortDirection` is an internal helper alias, not new public API.
import type { SortDirection } from "../types/options.ts";
import type { Sort } from "../types.ts";
import { isIdField, SURREAL_ID_FIELD } from "./filter/id-field.ts";

/**
 * Translate a MongoDB sort specification into a SurrealQL ORDER BY clause.
 * Returns an empty string when no sort is specified.
 */
export function translateSort(sort?: Sort | null): string {
	const parts = sortEntries(sort).map(
		([field, dir]) => `${escapeSortField(field)} ${normaliseDirection(dir)}`,
	);
	return parts.length > 0 ? `ORDER BY ${parts.join(", ")}` : "";
}

/** One column a sort orders by, in both spellings. */
export interface SortColumn {
	/** The field as the caller named it — for anything reported back to them. */
	readonly key: string;
	/** The column as `ORDER BY` and the field list spell it. */
	readonly column: string;
}

/**
 * The columns a sort orders by, escaped, without duplicates.
 *
 * SurrealDB requires every `ORDER BY` idiom to appear in the statement's field
 * list, so a `SELECT` that names its fields has to name these too:
 * `SELECT id FROM t ORDER BY k` is a parse error, not a slower query. Returned
 * apart from the clause because only the caller knows what its field list
 * already contains.
 *
 * Both spellings come back together because a column that cannot be ordered by
 * has to be *reported*, and a caller who asked to sort by `a.b` should be told
 * about `a.b` rather than about `` `a`.`b` ``. Pairing them here is what stops
 * the two from being assembled separately and drifting.
 */
export function sortColumns(sort?: Sort | null): SortColumn[] {
	const seen = new Map<string, SortColumn>();
	for (const [key] of sortEntries(sort)) {
		const column = escapeSortField(key);
		if (!seen.has(column)) seen.set(column, { key, column });
	}
	return [...seen.values()];
}

/**
 * The `(field, direction)` pairs a sort denotes, in the order they compare.
 *
 * MongoDB accepts a bare field name, an array of tuples and an object, and the
 * clause and the column list have to agree on how each is read.
 */
function sortEntries(sort?: Sort | null): [string, SortDirection][] {
	if (!sort) return [];
	if (typeof sort === "string") return [[sort, 1]];
	if (Array.isArray(sort)) return sort.map(([field, dir]) => [field, dir]);
	return Object.entries(sort);
}

/**
 * Map a MongoDB sort direction onto `ASC` / `DESC`.
 *
 * Previously this returned ASC only for `1` and `"asc"` and let *everything
 * else* fall through to DESC — so `{ field: "ascending" }`, which MongoDB
 * accepts, sorted backwards. Programmatic callers (mongoose builds sort objects
 * for you) hit that silently, with no error to notice.
 *
 * The accepted set is taken from the official driver's runtime normaliser
 * (`mongodb/lib/sort.js` → `prepareDirection`), which does
 * `` `${direction}`.toLowerCase() `` and then switches on
 * `ascending|asc|1` / `descending|desc|-1`. That is why the numeric *strings*
 * `"1"` / `"-1"` and mixed-case spellings such as `"ASC"` are honoured even
 * though the published `SortDirection` type does not list them: untyped callers
 * legitimately pass them and MongoDB sorts correctly. Nothing outside that set
 * is invented here.
 *
 * An unrecognised direction now throws `MongoInvalidArgumentError` — again
 * matching the official driver — rather than quietly sorting descending.
 */
function normaliseDirection(dir: SortDirection): "ASC" | "DESC" {
	// `prepareDirection(direction = 1)` in the official driver defaults a missing
	// direction to ascending, so `{ field: undefined }` must not throw. `null` is
	// *not* covered by that default and is rejected, exactly as MongoDB does.
	if (dir === undefined) return "ASC";

	switch (String(dir).toLowerCase()) {
		case "1":
		case "asc":
		case "ascending":
			return "ASC";
		case "-1":
		case "desc":
		case "descending":
			return "DESC";
		default:
			throw new MongoInvalidArgumentError(
				`Invalid sort direction: ${JSON.stringify(dir)}`,
			);
	}
}

/**
 * Escape a sort key, mapping `_id` onto SurrealDB's `id` column.
 *
 * Only the field is rewritten: a sort compares no value, so unlike a filter
 * this needs no table name to build a `RecordId` from.
 */
function escapeSortField(field: string): string {
	return isIdField(field) ? SURREAL_ID_FIELD : escapeFieldPath(field);
}
