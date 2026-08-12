/**
 * Utilities for mapping between MongoDB's `_id` field and SurrealDB's
 * `RecordId`-based `id` field.
 *
 * The `_id` a caller supplies is theirs: whatever type it has, and whatever
 * characters it contains, a read has to hand back the same value. That is why an
 * `ObjectId` is stored tagged (see `bson-codec.ts`) rather than as a bare hex
 * string — the tag is what tells the two apart on the way back, so a string that
 * happens to look like an ObjectId stays a string, and a record id containing a
 * colon needs no unpicking.
 */

import { RecordId, StringRecordId } from "surrealdb";
import { MongoInvalidArgumentError } from "../errors.ts";
import { isObjectId, ObjectId } from "../object-id.ts";
import {
	fromTaggedObjectId,
	objectIdFromPrintedForm,
	reviveBsonDocument,
	toTaggedObjectId,
} from "../surreal/bson-codec.ts";
import { rejectGeometryDocument } from "../surreal/geometry-codec.ts";
import { unescapeSurrealString } from "../surreal/sql/escape.ts";
import type { Document } from "../types.ts";

/** The types MongoDB's `_id` takes in this driver. */
export type MongoId = ObjectId | string | number;

// ---------------------------------------------------------------------------
// Outbound: MongoDB document → SurrealDB record
// ---------------------------------------------------------------------------

export interface PreparedInsert {
	/** The RecordId to use for the SurrealDB record, or undefined to auto-generate. */
	recordId: RecordId | undefined;
	/** The document data (without _id). */
	data: Document;
	/** The _id value to return to the caller. */
	insertedId: MongoId;
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
 * A string is used exactly as given, colons and all: SurrealDB's `RecordId`
 * carries the table separately, so the id part never needs escaping or splitting.
 *
 * Returns `undefined` for a value that cannot address a record, so callers can
 * decide whether that means "no match" or "invalid argument".
 */
export function toRecordId(table: string, id: unknown): RecordId | undefined {
	if (id instanceof RecordId) return id;
	if (isObjectId(id)) return new RecordId(table, toTaggedObjectId(id));
	if (typeof id === "string") return new RecordId(table, id);
	if (typeof id === "number") {
		// A record id must be a whole number. SurrealDB accepts `1.5` on the wire
		// and then never answers — no result, no error, no timeout — so a value
		// that cannot address a record is refused here instead of hanging the
		// caller. MongoDB would store it, which makes this a divergence, but a
		// clear rejection beats a request that never returns.
		if (!Number.isInteger(id)) {
			throw new MongoInvalidArgumentError(
				`An '_id' of ${id} is not a valid record id: SurrealDB record ids must be whole numbers. Use a string or an ObjectId for a non-integer identifier.`,
			);
		}
		return new RecordId(table, id);
	}

	// The stored form itself, which is what a caller who read a document in
	// SurrealDB's tooling and copied the id back out would be holding.
	const tagged = fromTaggedObjectId(id);
	if (tagged) return new RecordId(table, toTaggedObjectId(tagged));

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

	// Checked on the id-stripped payload, since that is what becomes the record's
	// content and therefore what the codec sees.
	rejectGeometryDocument(rest);

	if (_id === undefined || _id === null) {
		const oid = new ObjectId();
		return {
			recordId: toRecordId(table, oid),
			data: rest,
			insertedId: oid,
		};
	}

	// A caller holding the stored form of an id gets the id back, not the object
	// they happened to write it as.
	const supplied = fromTaggedObjectId(_id) ?? _id;

	const recordId = toRecordId(table, supplied);
	if (recordId) {
		return {
			recordId,
			data: rest,
			insertedId: supplied as MongoId,
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
 *
 * Every other field is walked as well, because an `ObjectId` stored inside a
 * document — nested, in an array, or in an array of sub-documents — is a tagged
 * object on the wire and has to be rebuilt into the id the caller wrote.
 */
export function recordToDocument<T extends Document = Document>(
	record: Record<string, unknown>,
): T {
	const { id, ...rest } = record;

	return { _id: toMongoId(id), ...reviveBsonDocument(rest) } as unknown as T;
}

/**
 * The MongoDB `_id` for the value SurrealDB returned in the `id` column.
 *
 * A `StringRecordId` is a record id the wire carried as text, so its table
 * prefix is stripped with the same escaping rules SurrealDB printed it under. A
 * bare string is *not* assumed to be one: `'urn:uuid:1234'` is a perfectly good
 * id, and splitting it on the first colon would hand back `'uuid:1234'` — the
 * caller's primary key, silently truncated.
 */
export function toMongoId(id: unknown): MongoId | unknown {
	if (id instanceof RecordId) return recordIdToMongoId(id);
	if (id instanceof StringRecordId) {
		return parseRecordIdString(id.toString()).id;
	}
	return id;
}

/**
 * Convert a RecordId's id part into the appropriate MongoDB `_id` value.
 *
 * The id part is already unescaped and typed by the SDK, so a string is returned
 * exactly as stored — no unwrapping, and no promotion of a hex-looking string to
 * an `ObjectId`, which would change the type of a key its owner supplied as a
 * string.
 */
function recordIdToMongoId(rid: RecordId): MongoId {
	const idPart = rid.id;

	if (typeof idPart === "number") return idPart;
	if (typeof idPart === "string") return idPart;

	const objectId = fromTaggedObjectId(idPart);
	if (objectId) return objectId;

	// Fallback for record ids this driver did not write: a UUID, an array or an
	// object id part, rendered as text rather than dropped.
	return String(idPart);
}

// ---------------------------------------------------------------------------
// Inbound: a record id SurrealDB rendered as text
// ---------------------------------------------------------------------------

/** The delimiters SurrealDB quotes a non-simple table or id part with. */
const ID_QUOTES: readonly (readonly [string, string])[] = [
	["`", "`"],
	["⟨", "⟩"],
];

/** A bare integer id part. A *string* id part is always printed quoted. */
const PRINTED_INTEGER = /^-?\d+$/;

/** A stringified record id, split back into the parts it names. */
export interface ParsedRecordId {
	/** The table part, or `undefined` when the text carries none. */
	collection: string | undefined;
	/** The `_id` a read of that record would return. */
	id: MongoId;
}

/** Index of the unescaped `close` delimiter at or after `from`, or `-1`. */
function findClosing(text: string, from: number, close: string): number {
	for (let i = from; i < text.length; i += 1) {
		if (text[i] === "\\") {
			i += 1;
			continue;
		}
		if (text[i] === close) return i;
	}
	return -1;
}

/**
 * Recover the `_id` and collection from a record id SurrealDB rendered as text.
 *
 * A duplicate-key failure names the offending record as a string rather than as a
 * typed `RecordId` — `users:6a7b…`, ``users:`urn:uuid:1234` ``, `users:42`,
 * `users:{ "$oid": '6a7b…' }` — and the `_id` reported back to the caller has to
 * be the value a read of that record would have produced. That is why the
 * quoting matters: it is the only thing distinguishing the number `42` from the
 * string `"42"`, and unpicking it wrongly is how an id containing a colon loses
 * its first segment.
 */
export function parseRecordIdString(text: string): ParsedRecordId {
	const [collection, idPart] = splitRecordIdString(text);
	return { collection, id: parseIdPart(idPart) };
}

/** Split `table:id` into its two parts, respecting a quoted table name. */
function splitRecordIdString(text: string): [string | undefined, string] {
	for (const [open, close] of ID_QUOTES) {
		if (!text.startsWith(open)) continue;
		const end = findClosing(text, 1, close);
		if (end < 0 || text[end + 1] !== ":") break;
		return [unescapeSurrealString(text.slice(1, end)), text.slice(end + 2)];
	}

	const separator = text.indexOf(":");
	if (separator < 0) return [undefined, text];
	return [text.slice(0, separator), text.slice(separator + 1)];
}

/** The `_id` an id part rendered as text stands for. */
function parseIdPart(text: string): MongoId {
	for (const [open, close] of ID_QUOTES) {
		if (text.length > 1 && text.startsWith(open) && text.endsWith(close)) {
			// Decoded, not merely de-backslashed: a tab inside an id is printed as
			// the two characters `\t`, and dropping the backslash would report the
			// caller's `'tab\there'` back to them as `'tabthere'`.
			return unescapeSurrealString(text.slice(1, -1));
		}
	}

	const objectId = objectIdFromPrintedForm(text);
	if (objectId) return objectId;

	if (PRINTED_INTEGER.test(text)) return Number(text);

	return text;
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
