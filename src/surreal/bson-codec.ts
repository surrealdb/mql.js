/**
 * How BSON values cross the SurrealDB boundary.
 *
 * SurrealDB has no ObjectId, so one has to be represented in terms that
 * SurrealDB does have. This module owns that representation — writing it on the
 * way out and reading it on the way back in — so there is exactly one answer to
 * "what is an ObjectId stored as" and the write and read paths cannot drift.
 *
 * ## The stored form
 *
 * An ObjectId is stored as the single-field object
 *
 *     { "$oid": "6a7b933c2627a1d7fdb21827" }
 *
 * wherever it appears: as a record id, as a field value, inside an array, and
 * inside a filter or an update operand. `$oid` is MongoDB Extended JSON's own
 * spelling for an ObjectId, so the value is self-describing to anyone reading it
 * in SurrealDB's tooling, and `$`-prefixed field names are reserved in MongoDB —
 * which keeps the form from colliding with a document a caller wrote themselves.
 * Reconstruction is deliberately narrow for the same reason: exactly one field,
 * named `$oid`, holding exactly 24 lowercase hex characters.
 *
 * A tagged object is a plain SurrealDB object, so equality (`=`), membership
 * (`INSIDE`, from `$in`), `ORDER BY` and unique indexes all behave. Ordering
 * even stays chronological, because comparing the objects compares the hex
 * inside them and the leading bytes of an ObjectId are its timestamp.
 *
 * ## Which side does what
 *
 * Encoding rides the SDK's `valueEncodeVisitor`, which the CBOR codec calls for
 * every value at every depth on its way to the wire. That reaches places a
 * hand-written walk would have to be taught about one at a time — `CONTENT`
 * documents, `SET` operands, bound filter values, array elements — and it
 * applies the same rewrite to a filter as to the document it has to match.
 *
 * Decoding cannot ride `valueDecodeVisitor`: the codec only calls it for values
 * that arrive tagged on the wire (datetimes, record ids, UUIDs), never for the
 * plain objects a stored `{"$oid": …}` decodes to. Reconstruction therefore
 * happens in this driver's own read path — see `recordToDocument` — which walks
 * every returned document anyway to map `id` back to `_id`.
 *
 * A geometry cannot ride the decode visitor either, though for the opposite
 * reason: it *is* wire-tagged, so the visitor does see it — but it sees a
 * composite geometry's **parts** as well, one tag at a time, and hands each of
 * them back to the constructor of the geometry that encloses it. Rewriting a
 * `GeometryLine` to GeoJSON therefore leaves `new GeometryPolygon(…)` holding
 * plain objects where it expects lines, and the decode never finishes: measured
 * against a live server, a `Point` round-tripped and every `Polygon` hung the
 * connection with no error at all. So geometry joins the walk too, and
 * `geometry-codec.ts` explains why it has to be stored as SurrealDB's own type in
 * the first place.
 *
 * Dates need neither: `useNativeDates` makes the SDK decode a SurrealDB datetime
 * to a real `Date` instead of its own `DateTime` wrapper, so a `Date` written by
 * a caller comes back as a `Date`, with its milliseconds intact.
 *
 * Every other BSON type — `Decimal128`, `Long`, `Binary`, `UUID`, `Timestamp`,
 * `Code`, `MinKey`/`MaxKey`, `DBRef` — has no representation here and is refused
 * on the way out, for the reason `encodeBsonValue` explains.
 */

import { type CodecOptions, Geometry } from "surrealdb";
import { MongoCompatibilityError } from "../errors.ts";
import { isObjectId, ObjectId } from "../object-id.ts";
import { encodeGeoJson, toGeoJson } from "./geometry-codec.ts";

/** The field name an ObjectId is stored under: Extended JSON's spelling. */
export const OBJECT_ID_TAG = "$oid";

/**
 * The stored form of an ObjectId.
 *
 * Declared over an index signature because that is what SurrealDB's `RecordId`
 * accepts as an id part: the same tagged object addresses a record and lives
 * inside a document.
 */
export interface TaggedObjectId extends Record<string, unknown> {
	[OBJECT_ID_TAG]: string;
}

/** Exactly what this driver writes: 24 lowercase hex characters. */
const STORED_HEX = /^[0-9a-f]{24}$/;

/** The stored form of `value`. */
export function toTaggedObjectId(value: {
	toHexString(): string;
}): TaggedObjectId {
	return { [OBJECT_ID_TAG]: value.toHexString().toLowerCase() };
}

/**
 * The ObjectId `value` stores, or `undefined` when it is not a stored ObjectId.
 *
 * Anything else — including an object that merely has a `$oid` field alongside
 * others, or one whose `$oid` is not a hex string — is left alone, because it is
 * a document some caller wrote rather than an id this driver encoded.
 */
export function fromTaggedObjectId(value: unknown): ObjectId | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}

	const keys = Object.keys(value);
	if (keys.length !== 1 || keys[0] !== OBJECT_ID_TAG) return undefined;

	const hex = (value as Record<string, unknown>)[OBJECT_ID_TAG];
	if (typeof hex !== "string" || !STORED_HEX.test(hex)) return undefined;

	return new ObjectId(hex);
}

/**
 * The stored form as SurrealDB and the SDK *print* it — `{ "$oid": '6a7b…' }`
 * and `{ "$oid": s"6a7b…" }` respectively.
 *
 * Server messages name values as SurrealQL literals rather than as data: a
 * duplicate-key failure quotes the record id it rejected, and a unique-index
 * violation quotes the value that collided. Both have to be read back as the
 * `ObjectId` a caller would recognise, so the printed spelling of the stored form
 * is pinned here alongside the form itself.
 */
const PRINTED_OBJECT_ID =
	/^\{\s*(?:"\$oid"|'\$oid')\s*:\s*s?['"](?<hex>[0-9a-f]{24})['"]\s*\}$/;

/** The ObjectId a printed stored form names, if that is what `text` is. */
export function objectIdFromPrintedForm(text: string): ObjectId | undefined {
	const match = PRINTED_OBJECT_ID.exec(text.trim());
	return match?.groups ? new ObjectId(match.groups.hex) : undefined;
}

/**
 * The SDK's encode visitor: rewrite an ObjectId to its stored form.
 *
 * Ids from `bson` and mongoose are rewritten too, since they are ObjectIds as
 * far as anything reading the data is concerned — a document written through
 * mongoose must be queryable with an id from this driver, and vice versa.
 *
 * Everything else is returned untouched, including the SDK's own value classes
 * and `Date`, which the codec handles itself — except a BSON value of a type
 * this driver cannot represent, which is refused rather than written. Nothing
 * would stop it being encoded: it is an object, so it would be stored as
 * whatever its internal fields happen to be and read back as a plain object of
 * those fields. A named error at the point of the write is worth more than a
 * document that reads fine until someone calls a method on the value.
 */
export function encodeBsonValue(value: unknown): unknown {
	if (isObjectId(value)) return toTaggedObjectId(value);

	// GeoJSON is checked before the class-instance rules below because it is the
	// one *plain object* this driver rewrites: `geometry-codec.ts` states the
	// recognition rule, which is narrow enough that a caller's own document is
	// left as data.
	const geometry = encodeGeoJson(value);
	if (geometry) return geometry;

	// Only a BSON *value* is refused, which is why this asks for a class instance
	// rather than for the marker alone: every BSON implementation carries
	// `_bsontype` on its prototype, while a plain object carrying a field of that
	// name is a caller's own document — `{note: {_bsontype: 'draft'}}` is data, and
	// MongoDB would store it without comment.
	if (isClassInstance(value)) {
		const bsontype = (value as { _bsontype?: unknown })._bsontype;
		if (typeof bsontype === "string") {
			throw new MongoCompatibilityError(
				`BSON type '${bsontype}' is not supported: SurrealDB has no equivalent, and storing it as a plain object would hand back a value that is no longer a ${bsontype}. See "BSON types" in the README for what to use instead.`,
			);
		}
	}

	return value;
}

/** True for an object whose fields this driver may walk and rebuild. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** True for an object that is an instance of something, rather than plain data. */
function isClassInstance(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		!isPlainObject(value)
	);
}

/**
 * Rebuild the BSON values inside a decoded value.
 *
 * Walks arrays and plain objects to any depth, replacing every stored ObjectId
 * with an `ObjectId` and every geometry with the GeoJSON it was written as.
 * Nothing else is touched, and a value containing neither is returned as-is
 * rather than copied — a read of documents with no ids in them costs one walk and
 * no allocation.
 *
 * Other class instances (`Date`, `RecordId`, `Uuid`, …) are left alone: they are
 * already the values they should be, and descending into one would only produce
 * a lookalike that had lost its prototype. A geometry is the exception because
 * MongoDB's own answer to "what is a geometry" is GeoJSON, and a `Geometry`
 * arrives fully built rather than needing to be walked.
 */
export function reviveBsonValues<T>(value: T): T {
	const objectId = fromTaggedObjectId(value);
	if (objectId) return objectId as unknown as T;

	if (value instanceof Geometry) return toGeoJson(value) as unknown as T;

	if (Array.isArray(value)) {
		let changed = false;
		const revived = value.map((element) => {
			const next = reviveBsonValues(element);
			if (next !== element) changed = true;
			return next;
		});
		return (changed ? revived : value) as unknown as T;
	}

	if (!isPlainObject(value)) return value;

	return reviveBsonDocument(value) as unknown as T;
}

/**
 * Rebuild the BSON values inside the *fields* of a decoded document.
 *
 * A document is not itself a value, and the difference matters at the top level
 * of a read: a caller whose document is exactly `{"$oid": "<24 hex>"}` — one
 * field, named like the tag — has written a document, not an id. Revived as a
 * value it would become an `ObjectId`, and since a document is handed back by
 * spreading its fields, the field would vanish from the result entirely rather
 * than merely changing type. So the fields are candidates and the document is
 * not.
 */
export function reviveBsonDocument<T extends Record<string, unknown>>(
	document: T,
): T {
	let changed = false;
	const revived: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(document)) {
		const next = reviveBsonValues(field);
		if (next !== field) changed = true;
		revived[key] = next;
	}
	return (changed ? revived : document) as T;
}

/**
 * The codec configuration every connection this driver opens is built with.
 *
 * `useNativeDates` costs the nanosecond precision a SurrealDB datetime can
 * carry: a value written by SurrealDB itself with sub-millisecond digits arrives
 * here rounded to milliseconds. That is the right trade for a MongoDB-compatible
 * driver, whose own date type is a millisecond `Date` and cannot express more.
 */
export const BSON_CODEC_OPTIONS: CodecOptions = {
	useNativeDates: true,
	valueEncodeVisitor: encodeBsonValue,
};
