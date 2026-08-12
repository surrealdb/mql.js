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
import { SURREAL_ID_FIELD } from "./filter/id-field.ts";

export interface TranslatedProjection {
	/**
	 * The escaped columns for the `SELECT` field list, e.g. `["id", "`name`"]`.
	 * Empty means `SELECT *` (no projection, or exclusion-only).
	 *
	 * A list rather than the comma-joined string it is emitted as, because the
	 * ordering has to be checked against it: SurrealDB requires every `ORDER BY`
	 * idiom to appear in the field list, and asking "does this list carry that
	 * column?" of a joined string means splitting it on a comma again — which a
	 * field name containing a comma, legal in MongoDB, breaks into fragments that
	 * match nothing. Joining is left to the one place that emits SQL.
	 */
	columns: readonly string[];
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
			columns: [],
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
		// `_id` was the only key, and its two values mean opposite things.
		//
		// `{_id: 1}` is an inclusion projection that happens to name one field, so
		// the answer is a document carrying `_id` and nothing else. Treating it as
		// "no fields named, therefore `SELECT *`" returned every field the caller
		// had just declined to ask for.
		//
		// `{_id: 0}` names no field to include, so everything except `_id` comes
		// back — a `SELECT *` with `includeId` false, which post-processing honours.
		return {
			columns: includeId ? [SURREAL_ID_FIELD] : [],
			isExclusion: false,
			excludeFields: [],
			includeId,
		};
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
		// Inclusion: SELECT specific fields.
		//
		// The identity column leads the list unless the projection suppressed it.
		// MongoDB returns `_id` alongside an inclusion projection without being
		// asked, and `_id` lives in SurrealDB's `id` column rather than in the
		// document — so a field list that does not name `id` comes back without one,
		// and `recordToDocument` then reports an `_id` of `undefined` for a document
		// that has a perfectly good primary key.
		const columns = included.map(([key]) => escapeFieldPath(key));
		if (includeId) columns.unshift(SURREAL_ID_FIELD);

		return {
			// Escaped for SurrealQL; `excludeFields` below stays unescaped
			// because it is used for in-memory post-processing, not SQL.
			columns,
			isExclusion: false,
			excludeFields: [],
			includeId,
		};
	}

	// Exclusion: must be applied as post-processing. `excludeFields` stays
	// unescaped — `applyProjection` walks it as document keys, not as SQL.
	return {
		columns: [],
		isExclusion: true,
		excludeFields: excluded.map(([key]) => key),
		includeId,
	};
}
