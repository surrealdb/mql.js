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

import { MongoInvalidArgumentError } from "../errors.ts";
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

	// Partition the non-`_id` keys by mode.
	//
	// This used to pick the mode from `otherEntries[0]` alone and then silently
	// ignore every key of the opposite mode, which made the result depend on key
	// *order*: `{ a: 1, b: 0 }` projected `{ a }` while `{ b: 0, a: 1 }` was read
	// as an exclusion and returned every field except `b` — leaking `a`'s
	// siblings. MongoDB rejects such a projection outright, and `_id` is the only
	// key exempt from the rule (`{ a: 1, _id: 0 }` and `{ a: 0, _id: 1 }` are both
	// legal). Enforcing that removes the order-dependence entirely.
	const included = otherEntries.filter(([_, v]) => Boolean(v));
	const excluded = otherEntries.filter(([_, v]) => !v);

	if (included.length > 0 && excluded.length > 0) {
		// Report against the mode of the first key, as MongoDB's message does.
		const inclusionFirst = Boolean(otherEntries[0][1]);
		const offender = inclusionFirst ? excluded[0][0] : included[0][0];
		throw new MongoInvalidArgumentError(
			inclusionFirst
				? `Cannot do exclusion on field ${offender} in inclusion projection`
				: `Cannot do inclusion on field ${offender} in exclusion projection`,
		);
	}

	if (included.length > 0) {
		// Inclusion: SELECT specific fields
		const fieldNames = included.map(([key]) => key);
		return {
			// Escaped for SurrealQL; `excludeFields` below stays unescaped
			// because it is used for in-memory post-processing, not SQL.
			fields: fieldNames.map(escapeFieldPath).join(", "),
			isExclusion: false,
			excludeFields: [],
			includeId,
		};
	}

	// Exclusion: must be applied as post-processing. `excludeFields` stays
	// unescaped — `applyProjection` walks it as document keys, not as SQL.
	return {
		fields: "",
		isExclusion: true,
		excludeFields: excluded.map(([key]) => key),
		includeId,
	};
}
