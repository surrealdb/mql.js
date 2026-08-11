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

import { escapeFieldPath } from "../surreal/sql/escape.ts";
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

function normaliseDirection(dir: 1 | -1 | "asc" | "desc"): "ASC" | "DESC" {
	if (dir === 1 || dir === "asc") return "ASC";
	return "DESC";
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
