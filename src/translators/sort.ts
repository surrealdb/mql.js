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
	if (!sort) return "";

	// String shorthand: single field ascending
	if (typeof sort === "string") {
		return `ORDER BY ${escapeSortField(sort)} ASC`;
	}

	// Array of tuples: [["name", 1], ["age", -1]]
	if (Array.isArray(sort)) {
		const parts = sort.map(([field, dir]) => {
			return `${escapeSortField(field)} ${normaliseDirection(dir)}`;
		});
		return parts.length > 0 ? `ORDER BY ${parts.join(", ")}` : "";
	}

	// Object: { name: 1, age: -1 }
	const parts = Object.entries(sort).map(([field, dir]) => {
		return `${escapeSortField(field)} ${normaliseDirection(dir)}`;
	});
	return parts.length > 0 ? `ORDER BY ${parts.join(", ")}` : "";
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
