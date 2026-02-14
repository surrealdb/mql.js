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
export function prepareInsert(table: string, doc: Document): PreparedInsert {
	const { _id, ...rest } = doc;

	let insertedId: ObjectId | string | number;
	let recordId: RecordId | undefined;

	if (_id !== undefined && _id !== null) {
		if (_id instanceof ObjectId) {
			insertedId = _id;
			recordId = new RecordId(table, _id.toHexString());
		} else if (typeof _id === "string") {
			insertedId = _id;
			recordId = new RecordId(table, _id);
		} else if (typeof _id === "number") {
			insertedId = _id;
			recordId = new RecordId(table, _id);
		} else {
			// Treat as string fallback
			insertedId = String(_id);
			recordId = new RecordId(table, String(_id));
		}
	} else {
		// Generate a new ObjectId
		const oid = new ObjectId();
		insertedId = oid;
		recordId = new RecordId(table, oid.toHexString());
	}

	return { recordId, data: rest, insertedId };
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
