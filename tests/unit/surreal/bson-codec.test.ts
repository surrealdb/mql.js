/**
 * The BSON representation this driver stores, in both directions.
 *
 * The two halves have to agree exactly: whatever `encodeBsonValue` writes,
 * `reviveBsonValues` has to read back, or a value survives the write and is
 * unrecognisable on the way out.
 */

import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { MongoCompatibilityError } from "../../../src/errors.ts";
import { ObjectId } from "../../../src/object-id.ts";
import {
	BSON_CODEC_OPTIONS,
	encodeBsonValue,
	fromTaggedObjectId,
	OBJECT_ID_TAG,
	objectIdFromPrintedForm,
	reviveBsonDocument,
	reviveBsonValues,
	toTaggedObjectId,
} from "../../../src/surreal/bson-codec.ts";

const HEX = "507f1f77bcf86cd799439011";

describe("the stored form", () => {
	test("is Extended JSON's spelling of an ObjectId", () => {
		expect(OBJECT_ID_TAG).toBe("$oid");
		expect(toTaggedObjectId(new ObjectId(HEX))).toEqual({ $oid: HEX });
	});

	test("holds the canonical lowercase hex", () => {
		expect(toTaggedObjectId(new ObjectId(HEX.toUpperCase()))).toEqual({
			$oid: HEX,
		});
	});

	test("round-trips through both halves", () => {
		const id = new ObjectId();
		const revived = fromTaggedObjectId(encodeBsonValue(id));
		expect(revived).toBeInstanceOf(ObjectId);
		expect(revived?.equals(id)).toBe(true);
	});
});

describe("encodeBsonValue", () => {
	test("rewrites an ObjectId, wherever it comes from", () => {
		expect(encodeBsonValue(new ObjectId(HEX))).toEqual({ $oid: HEX });
		expect(
			encodeBsonValue({
				_bsontype: "ObjectId",
				id: new Uint8Array(12),
				toHexString: () => HEX,
			}),
		).toEqual({ $oid: HEX });
	});

	// A BSON value of any other type has no representation here. Encoding it would
	// store its internals — a `Decimal128` becomes `{bytes: …}` — and read back as
	// a plain object that is no longer a decimal.
	//
	// Each is stood up as a class instance because that is how every BSON
	// implementation carries the marker: `_bsontype` comes from the prototype, and
	// on `bson` 7 it is a getter. Refusing on the marker alone would take a
	// caller's own document with it (see below).
	test("refuses a BSON value it cannot represent, naming its type", () => {
		for (const bsontype of [
			"Decimal128",
			"Long",
			"Binary",
			"UUID",
			"Timestamp",
			"Code",
			"MinKey",
			"MaxKey",
			"DBRef",
			"Int32",
			"Double",
		]) {
			const value = Object.create({ _bsontype: bsontype });

			expect(() => encodeBsonValue(value)).toThrow(MongoCompatibilityError);
			expect(() => encodeBsonValue(value)).toThrow(bsontype);
		}
	});

	// `{note: {_bsontype: 'draft'}}` is a document, and MongoDB stores it without
	// comment. Refusing it because one of its field names is the marker would make
	// a perfectly ordinary document unwritable.
	test("stores a plain object that merely has a _bsontype field", () => {
		const document = { _bsontype: "draft", text: "hi" };
		expect(encodeBsonValue(document)).toBe(document);
	});

	test("leaves every other value exactly as it was", () => {
		const date = new Date();
		const recordId = new RecordId("users", "alice");
		const document = { a: 1, $oid: "not an id" };

		expect(encodeBsonValue(date)).toBe(date);
		expect(encodeBsonValue(recordId)).toBe(recordId);
		expect(encodeBsonValue(document)).toBe(document);
		expect(encodeBsonValue(HEX)).toBe(HEX);
		expect(encodeBsonValue(null)).toBe(null);
		expect(encodeBsonValue(undefined)).toBe(undefined);
	});
});

describe("fromTaggedObjectId", () => {
	test("accepts exactly the form this driver writes", () => {
		expect(fromTaggedObjectId({ $oid: HEX })?.toHexString()).toBe(HEX);
	});

	// Narrow on purpose: a document a caller wrote must not be mistaken for an id.
	test("rejects anything that is not that form", () => {
		expect(fromTaggedObjectId({ $oid: HEX, note: "mine" })).toBeUndefined();
		expect(fromTaggedObjectId({ $oid: "abc" })).toBeUndefined();
		expect(fromTaggedObjectId({ $oid: HEX.toUpperCase() })).toBeUndefined();
		expect(fromTaggedObjectId({ oid: HEX })).toBeUndefined();
		expect(fromTaggedObjectId({ $oid: 7 })).toBeUndefined();
		expect(fromTaggedObjectId([{ $oid: HEX }])).toBeUndefined();
		expect(fromTaggedObjectId(HEX)).toBeUndefined();
		expect(fromTaggedObjectId(null)).toBeUndefined();
	});
});

describe("reviveBsonValues", () => {
	test("rebuilds ids nested in objects, arrays and arrays of objects", () => {
		const revived = reviveBsonValues({
			author: { $oid: HEX },
			editors: [{ $oid: HEX }, { $oid: HEX }],
			reviews: [{ by: { $oid: HEX }, score: 5 }],
			deep: { a: { b: { c: { $oid: HEX } } } },
		});

		expect(revived.author).toBeInstanceOf(ObjectId);
		expect(revived.editors.every((id) => id instanceof ObjectId)).toBe(true);
		expect(revived.reviews[0].by).toBeInstanceOf(ObjectId);
		expect(revived.deep.a.b.c).toBeInstanceOf(ObjectId);
		expect(revived.reviews[0].score).toBe(5);
	});

	test("returns the very same value when there is nothing to rebuild", () => {
		const document = { a: 1, b: [1, 2, { c: "x" }], d: new Date() };
		expect(reviveBsonValues(document)).toBe(document);
	});

	test("leaves class instances alone rather than descending into them", () => {
		const date = new Date();
		const recordId = new RecordId("users", "alice");
		const revived = reviveBsonValues({ date, recordId });

		expect(revived.date).toBe(date);
		expect(revived.recordId).toBe(recordId);
	});

	test("does not mutate the value it was handed", () => {
		const document = { author: { $oid: HEX } };
		reviveBsonValues(document);
		expect(document.author).toEqual({ $oid: HEX });
	});
});

describe("reviveBsonDocument", () => {
	test("rebuilds the ids among a document's fields", () => {
		const revived = reviveBsonDocument({
			author: { $oid: HEX },
			editors: [{ $oid: HEX }],
			title: "x",
		});

		expect(revived.author).toBeInstanceOf(ObjectId);
		expect((revived.editors as unknown[])[0]).toBeInstanceOf(ObjectId);
		expect(revived.title).toBe("x");
	});

	/**
	 * A document is not a value. A caller whose document is exactly one field named
	 * like the tag has written a document, and reading it as an id would not merely
	 * change its type: the read hands a document back by spreading its fields, so
	 * an id has no fields to contribute and the caller's field would be gone.
	 */
	test("never reads a whole document as an id, however much it looks like one", () => {
		const document = { $oid: HEX };
		const revived = reviveBsonDocument(document);

		expect(revived).not.toBeInstanceOf(ObjectId);
		expect(revived.$oid).toBe(HEX);
		expect({ ...revived }).toEqual({ $oid: HEX });
	});

	test("returns the very same document when there is nothing to rebuild", () => {
		const document = { a: 1, b: [1, 2] };
		expect(reviveBsonDocument(document)).toBe(document);
	});
});

describe("objectIdFromPrintedForm", () => {
	// Both spellings come from a live server and from the SDK respectively.
	test("reads the form SurrealDB and the SDK print", () => {
		for (const printed of [
			`{ "$oid": '${HEX}' }`,
			`{ "$oid": s"${HEX}" }`,
			`{"$oid":"${HEX}"}`,
		]) {
			expect(objectIdFromPrintedForm(printed)?.toHexString()).toBe(HEX);
		}
	});

	test("ignores anything else a server message might name", () => {
		expect(objectIdFromPrintedForm(`'${HEX}'`)).toBeUndefined();
		expect(objectIdFromPrintedForm("42")).toBeUndefined();
		expect(objectIdFromPrintedForm(`{ "$oid": 'abc' }`)).toBeUndefined();
		expect(objectIdFromPrintedForm(`{ "oid": '${HEX}' }`)).toBeUndefined();
	});
});

describe("BSON_CODEC_OPTIONS", () => {
	// Without native dates a `Date` comes back as the SDK's `DateTime`, which is
	// not a `Date`: `instanceof Date` is false and `getTime()` is not there.
	test("asks the SDK for native dates and installs the encode visitor", () => {
		expect(BSON_CODEC_OPTIONS.useNativeDates).toBe(true);
		expect(BSON_CODEC_OPTIONS.valueEncodeVisitor).toBe(encodeBsonValue);
	});
});
