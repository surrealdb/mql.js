/**
 * Utilities for mapping between MongoDB's `_id` field and SurrealDB's
 * `RecordId`-based `id` field.
 */

import { RecordId } from "surrealdb";
import { ObjectId } from "../object-id.ts";
import type { Document } from "../types.ts";

// ---------------------------------------------------------------------------
// Outbound: MongoDB document → SurrealDB record
// ---------------------------------------------------------------------------

export interface PreparedInsert {
	/** The RecordId to use for the SurrealDB record, or undefined to auto-generate. */
	recordId: RecordId | undefined;
	/** The document data (without _id). */
	data: Document;
	/** The _id value to return to the caller. */
	insertedId: ObjectId | string | number;
}

/**
 * Convert a MongoDB `_id` value into the `RecordId` that addresses the same
 * record in SurrealDB.
 *
 * This is the single mapping shared by writes (`prepareInsert`) and reads
 * (filter translation). Keeping one implementation is the point: if the two
 * ever disagreed, a document could be inserted under an id that no query could
 * then match — which is exactly the bug this function exists to prevent.
 *
 * Returns `undefined` for a value that cannot address a record, so callers can
 * decide whether that means "no match" or "invalid argument".
 */
export function toRecordId(table: string, id: unknown): RecordId | undefined {
	if (id instanceof RecordId) return id;
	if (id instanceof ObjectId) return new RecordId(table, id.toHexString());
	if (typeof id === "string") return new RecordId(table, id);
	if (typeof id === "number") return new RecordId(table, id);
	return undefined;
}

/**
 * Prepare a document for insertion into SurrealDB.
 *
 * - Extracts `_id`, or generates a fresh `ObjectId` when absent
 * - Converts it to the `RecordId` that will carry the record's identity
 * - Strips `_id` from the data payload, since SurrealDB stores it as `id`
 */
export function prepareInsert(table: string, doc: Document): PreparedInsert {
	const { _id, ...rest } = doc;

	if (_id === undefined || _id === null) {
		const oid = new ObjectId();
		return {
			recordId: new RecordId(table, oid.toHexString()),
			data: rest,
			insertedId: oid,
		};
	}

	const recordId = toRecordId(table, _id);
	if (recordId) {
		return {
			recordId,
			data: rest,
			insertedId: _id as ObjectId | string | number,
		};
	}

	// Anything else (a plain object, a boolean, …) is stringified so it still
	// addresses a stable record rather than being dropped.
	const asString = String(_id);
	return {
		recordId: new RecordId(table, asString),
		data: rest,
		insertedId: asString,
	};
}

// ---------------------------------------------------------------------------
// Inbound: SurrealDB record → MongoDB document
// ---------------------------------------------------------------------------

/**
 * Convert a SurrealDB record (with `id` as RecordId) into a MongoDB-shaped
 * document (with `_id`).
 */
export function recordToDocument<T extends Document = Document>(
	record: Record<string, unknown>,
): T {
	const { id, ...rest } = record;

	let _id: ObjectId | string | number | unknown;

	if (id instanceof RecordId) {
		_id = recordIdToMongoId(id);
	} else if (typeof id === "string") {
		// Sometimes SurrealDB returns stringified record IDs
		_id = stringToMongoId(id);
	} else {
		_id = id;
	}

	return { _id, ...rest } as unknown as T;
}

/**
 * Convert a RecordId's id part into the appropriate MongoDB `_id` value.
 */
function recordIdToMongoId(rid: RecordId): ObjectId | string | number {
	const idPart = rid.id;

	if (typeof idPart === "number") {
		return idPart;
	}

	if (typeof idPart === "string") {
		return stringToMongoId(idPart);
	}

	// Fallback for other types (bigint, arrays, objects, etc.)
	return String(idPart);
}

/**
 * If the string looks like a valid ObjectId (24-char hex), wrap it.
 * Otherwise return as-is.
 *
 * Exported because a duplicate-key error names the offending record as a
 * *string* (`users:6a7b…`) rather than a typed `RecordId`, and the `_id` it
 * reports back has to be the same value a read of that record would have
 * produced. Two implementations would eventually disagree, and the caller would
 * be told their write collided with an id they could not find.
 */
export function stringToMongoId(value: string): ObjectId | string {
	// Strip "table:" prefix if present (stringified RecordId)
	const colonIndex = value.indexOf(":");
	const idStr = colonIndex >= 0 ? value.substring(colonIndex + 1) : value;

	if (ObjectId.isValid(idStr)) {
		return new ObjectId(idStr);
	}
	return idStr;
}

/**
 * Is this a plain data object we may descend into and copy with a spread?
 *
 * Class instances (`ObjectId`, `Date`, `RecordId`, …) are deliberately excluded:
 * spreading one would produce a lookalike that has lost its prototype, and a
 * projection path never addresses their internals anyway.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Delete the leaf addressed by `segments` from `container`, copy-on-write.
 *
 * `container` is assumed to be a copy the caller owns; every sub-document along
 * the path is cloned before being modified so the original document handed to
 * `applyProjection` is never mutated.
 *
 * Nothing is thrown when the path does not resolve: a missing key, or a segment
 * that turns out to be a scalar, simply means there is no leaf to remove —
 * which is what MongoDB does for a path absent from a document.
 */
function excludePath(
	container: Record<string, unknown>,
	segments: string[],
): void {
	const [head, ...rest] = segments;

	if (rest.length === 0) {
		delete container[head];
		return;
	}

	const next = container[head];

	// MongoDB applies a dotted exclusion to *every* element of an array, so
	// `{ "users.pw": 0 }` strips `pw` from each entry of `users`. Skipping arrays
	// here would leak exactly the field the caller asked to hide.
	if (Array.isArray(next)) {
		let changed = false;
		const copy = next.map((element) => {
			if (!isPlainObject(element)) return element;
			const elementCopy = { ...element };
			excludePath(elementCopy, rest);
			changed = true;
			return elementCopy;
		});
		if (changed) container[head] = copy;
		return;
	}

	if (!isPlainObject(next)) return;

	const copy = { ...next };
	excludePath(copy, rest);
	container[head] = copy;
}

/**
 * Apply projection post-processing to a document.
 * Handles exclusion projections and _id suppression.
 *
 * Two defects were fixed here:
 *
 *  1. Exclusion only ever did `delete result[field]`, so a dotted path such as
 *     `auth.pw` matched no key and was a silent no-op — the excluded field was
 *     still returned to the caller. That is a data-exposure bug: excluding a
 *     password hash is the canonical use of a nested exclusion. Dotted paths now
 *     delete the addressed leaf and leave the rest of the sub-document intact.
 *
 *  2. Suppressing `_id` assigned `undefined` instead of deleting the key, so
 *     `"_id" in doc` stayed true and `Object.keys(doc)` still listed `_id`.
 *     MongoDB omits the key entirely.
 */
export function applyProjection(
	doc: Document,
	excludeFields: string[],
	includeId: boolean,
): Document {
	const result = { ...doc };

	for (const field of excludeFields) {
		if (field.includes(".")) {
			excludePath(result, field.split("."));
		} else {
			delete result[field];
		}
	}

	if (!includeId) {
		delete result._id;
	}

	return result;
}
