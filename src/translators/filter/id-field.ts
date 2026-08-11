/**
 * `_id` filter translation.
 *
 * SurrealDB stores a document's identity as a `RecordId` in a column called
 * `id`; `prepareInsert` strips MongoDB's `_id` and writes it there, and
 * `recordToDocument` maps it back on the way out. Nothing performed the
 * equivalent rewrite on the *query* side, so `translateFilter({_id: oid})`
 * emitted `_id = $p0` against records that have no `_id` column at all.
 *
 * The comparison could therefore never be true. `findOne({_id})` returned
 * null, `updateOne({_id})` reported `matchedCount: 0`, and `deleteOne({_id})`
 * reported `deletedCount: 0` and deleted nothing — all without raising an
 * error, while reads handed back an `_id` that could not be queried with.
 *
 * This module rewrites the field to `id` and coerces the compared values to
 * `RecordId`s, using the same mapping as the write path.
 */

import type { Document } from "../../types.ts";
import { toRecordId } from "../../utils/id.ts";

/** The MongoDB identity field. */
export const MONGO_ID_FIELD = "_id";

/** The SurrealDB column MongoDB's `_id` is stored in. */
export const SURREAL_ID_FIELD = "id";

/** Operators whose operand is a single `_id` value. */
const SCALAR_ID_OPERATORS = new Set([
	"$eq",
	"$ne",
	"$gt",
	"$gte",
	"$lt",
	"$lte",
]);

/** Operators whose operand is an array of `_id` values. */
const ARRAY_ID_OPERATORS = new Set(["$in", "$nin"]);

/** True when `field` addresses the document identity. */
export function isIdField(field: string): boolean {
	return field === MONGO_ID_FIELD;
}

/** True for `{ $gt: … }`-style operator objects (as opposed to a plain value). */
function isOperatorObject(value: unknown): boolean {
	if (value === null || typeof value !== "object") return false;
	if (Array.isArray(value)) return false;
	const keys = Object.keys(value as Document);
	return keys.length > 0 && keys.every((key) => key.startsWith("$"));
}

/**
 * Coerce one compared `_id` value to a `RecordId`.
 *
 * A value that cannot address a record is passed through unchanged rather than
 * rejected: the resulting comparison simply matches nothing, which is what
 * MongoDB does for an `_id` that cannot exist.
 */
function coerceValue(table: string, value: unknown): unknown {
	return toRecordId(table, value) ?? value;
}

/**
 * Rewrite the right-hand side of an `_id` condition so every compared value is
 * a `RecordId`.
 *
 * Handles implicit equality (`{_id: x}`), operator objects (`{_id: {$ne: x}}`)
 * and the array-valued membership operators (`{_id: {$in: [a, b]}}`).
 * Operators that do not compare identity values — `$exists`, `$type` — are left
 * untouched so they still apply to the `id` column.
 */
export function coerceIdCondition(table: string, value: unknown): unknown {
	if (!isOperatorObject(value)) return coerceValue(table, value);

	const rewritten: Document = {};
	for (const [operator, operand] of Object.entries(value as Document)) {
		if (ARRAY_ID_OPERATORS.has(operator) && Array.isArray(operand)) {
			rewritten[operator] = operand.map((item) => coerceValue(table, item));
		} else if (SCALAR_ID_OPERATORS.has(operator)) {
			rewritten[operator] = coerceValue(table, operand);
		} else {
			rewritten[operator] = operand;
		}
	}
	return rewritten;
}
