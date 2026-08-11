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
 * Prepare a document for insertion into SurrealDB.
 *
 * - Extracts or generates `_id`
 * - Converts `_id` → RecordId
 * - Strips `_id` from the data payload
 */
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
 */
function stringToMongoId(value: string): ObjectId | string {
	// Strip "table:" prefix if present (stringified RecordId)
	const colonIndex = value.indexOf(":");
	const idStr = colonIndex >= 0 ? value.substring(colonIndex + 1) : value;

	if (ObjectId.isValid(idStr)) {
		return new ObjectId(idStr);
	}
	return idStr;
}

/**
 * Apply projection post-processing to a document.
 * Handles exclusion projections and _id suppression.
 */
export function applyProjection(
	doc: Document,
	excludeFields: string[],
	includeId: boolean,
): Document {
	const result = { ...doc };

	for (const field of excludeFields) {
		delete result[field];
	}

	if (!includeId) {
		result._id = undefined;
	}

	return result;
}
