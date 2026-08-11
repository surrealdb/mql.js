/**
 * Translates a MongoDB projection specification into a SurrealQL field list.
 *
 * MongoDB projection rules:
 *   - { name: 1, age: 1 }      → include only those fields (+ _id by default)
 *   - { name: 0 }              → exclude those fields (include everything else)
 *   - { _id: 0, name: 1 }     → include name, exclude _id
 *   - Cannot mix inclusion and exclusion (except _id: 0)
 *
 * SurrealQL:
 *   SELECT name, age FROM ...    (inclusion)
 *   SELECT * OMIT name FROM ...  (exclusion)  -- SurrealQL doesn't have OMIT yet
 *     → we fall back to post-processing for exclusion projections
 *
 * For simplicity, this translator handles the inclusion case by returning a
 * field list. Exclusion is handled via a post-processing flag.
 */

import { escapeFieldPath } from "../surreal/sql/escape.ts";
import type { Projection } from "../types.ts";

export interface TranslatedProjection {
	/**
	 * Comma-separated field list for SELECT, e.g. "name, age".
	 * Empty string means SELECT * (no projection or exclusion-only).
	 */
	fields: string;
	/**
	 * When true, the projection is exclusion-based and must be applied
	 * as post-processing (remove listed fields from results).
	 */
	isExclusion: boolean;
	/**
	 * Fields to exclude in post-processing (only populated when isExclusion is true).
	 */
	excludeFields: string[];
	/**
	 * Whether to include `_id` in the results. Defaults to true unless
	 * the projection explicitly sets `_id: 0`.
	 */
	includeId: boolean;
}

export function translateProjection(
	projection?: Projection | null,
): TranslatedProjection {
	if (!projection || Object.keys(projection).length === 0) {
		return {
			fields: "",
			isExclusion: false,
			excludeFields: [],
			includeId: true,
		};
	}

	// Separate _id handling from other fields
	const entries = Object.entries(projection);
	const idEntry = entries.find(([key]) => key === "_id");
	const otherEntries = entries.filter(([key]) => key !== "_id");

	const includeId = idEntry ? Boolean(idEntry[1]) : true;

	if (otherEntries.length === 0) {
		// Only _id was specified
		return { fields: "", isExclusion: false, excludeFields: [], includeId };
	}

	// Determine if this is inclusion or exclusion
	const firstValue = Boolean(otherEntries[0][1]);
	const isInclusion = firstValue;

	if (isInclusion) {
		// Inclusion: SELECT specific fields
		const fieldNames = otherEntries
			.filter(([_, v]) => Boolean(v))
			.map(([key]) => key);
		return {
			// Escaped for SurrealQL; `excludeFields` below stays unescaped
			// because it is used for in-memory post-processing, not SQL.
			fields: fieldNames.map(escapeFieldPath).join(", "),
			isExclusion: false,
			excludeFields: [],
			includeId,
		};
	}

	// Exclusion: must be applied as post-processing
	const excludeFields = otherEntries.filter(([_, v]) => !v).map(([key]) => key);
	return {
		fields: "",
		isExclusion: true,
		excludeFields,
		includeId,
	};
}
