/**
 * `ObjectId` behaviour.
 *
 * Parity with the real `bson` class is asserted separately, in
 * `object-id-parity.test.ts`; this file covers what an ObjectId has to do for
 * *this* driver — stay opaque, stay detectable, and keep its timestamp readable
 * past 2038.
 */

import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { isObjectId, ObjectId, toObjectId } from "../../src/object-id.ts";

const HEX = "507f1f77bcf86cd799439011";

describe("ObjectId generation", () => {
	test("generates a valid 24-char hex string", () => {
		expect(new ObjectId().toHexString()).toMatch(/^[0-9a-f]{24}$/);
	});

	test("each generated id is unique", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 1000; i += 1) ids.add(new ObjectId().toHexString());
		expect(ids.size).toBe(1000);
	});

	test("the first four bytes are the current time in seconds", () => {
		const now = Math.floor(Date.now() / 1000);
		const seconds = Math.floor(new ObjectId().getTimestamp().getTime() / 1000);
		expect(Math.abs(seconds - now)).toBeLessThanOrEqual(1);
	});

	test("generate yields the twelve bytes of an id", () => {
		const bytes = ObjectId.generate();
		expect(bytes).toBeInstanceOf(Uint8Array);
		expect(bytes.length).toBe(12);
	});
});

describe("ObjectId construction", () => {
	test("accepts a 24-character hex string in either case", () => {
		expect(new ObjectId(HEX).toHexString()).toBe(HEX);
		expect(new ObjectId(HEX.toUpperCase()).toHexString()).toBe(HEX);
	});

	test("accepts twelve bytes", () => {
		const bytes = new Uint8Array([
			0x50, 0x7f, 0x1f, 0x77, 0xbc, 0xf8, 0x6c, 0xd7, 0x99, 0x43, 0x90, 0x11,
		]);
		expect(new ObjectId(bytes).toHexString()).toBe(HEX);
	});

	test("copies the bytes it is given, so a later mutation cannot change the id", () => {
		const bytes = new Uint8Array(12);
		const id = new ObjectId(bytes);
		bytes[0] = 0xff;
		expect(id.toHexString()).toBe("000000000000000000000000");
	});

	test("accepts another ObjectId", () => {
		const source = new ObjectId();
		expect(new ObjectId(source).toHexString()).toBe(source.toHexString());
	});

	test("accepts an ObjectId from another BSON implementation", () => {
		const foreign = {
			_bsontype: "ObjectId",
			id: new Uint8Array(12),
			toHexString: () => HEX,
		};
		expect(new ObjectId(foreign).toHexString()).toBe(HEX);
	});

	test("rejects a string that is not 24 hex characters", () => {
		for (const bad of [
			"not-valid",
			"507f1f77bcf86cd79943901",
			"507f1f77bcf86cd7994390111",
			"zzzzzzzzzzzzzzzzzzzzzzzz",
			"",
		]) {
			expect(() => new ObjectId(bad)).toThrow(
				"input must be a 24 character hex string",
			);
		}
	});

	// `bson` removed the number overload, so accepting one would let code work
	// here and throw against the official driver.
	test("rejects a number, pointing at nothing else", () => {
		expect(() => new ObjectId(1_700_000_000 as never)).toThrow(
			"Argument passed in does not match the accepted types",
		);
	});

	test("rejects twelve bytes that are not twelve", () => {
		expect(() => new ObjectId(new Uint8Array(11))).toThrow();
	});
});

describe("ObjectId internals stay hidden", () => {
	// An enumerable internal would make `{...oid}` a *document* rather than an id,
	// and would put driver state into anything that walks a document's own keys.
	test("nothing is enumerable", () => {
		const id = new ObjectId(HEX);
		expect(Object.keys(id)).toEqual([]);
		expect({ ...id }).toEqual({});
		expect(Object.getOwnPropertyNames(id)).toEqual([]);
	});

	test("JSON.stringify renders the hex, not the internals", () => {
		expect(JSON.stringify({ _id: new ObjectId(HEX) })).toBe(`{"_id":"${HEX}"}`);
	});

	test("prints as a constructor call, not as an empty object", () => {
		const id = new ObjectId(HEX);
		expect(inspect(id)).toBe(`new ObjectId('${HEX}')`);
		expect(inspect({ ref: [id] })).toContain(`new ObjectId('${HEX}')`);
		expect(id.inspect()).toBe(`new ObjectId('${HEX}')`);
	});

	test("carries the marker every BSON library recognises", () => {
		const id = new ObjectId(HEX);
		expect(id._bsontype).toBe("ObjectId");
		expect(Object.keys(id)).not.toContain("_bsontype");
		expect(
			Object.getOwnPropertyDescriptor(ObjectId.prototype, "_bsontype")
				?.enumerable,
		).toBe(false);
	});
});

describe("ObjectId equality", () => {
	test("compares against an ObjectId, a hex string and an id-alike", () => {
		const id = new ObjectId(HEX);
		expect(id.equals(new ObjectId(HEX))).toBe(true);
		expect(id.equals(HEX)).toBe(true);
		expect(id.equals(HEX.toUpperCase())).toBe(true);
		expect(id.equals({ toHexString: () => HEX } as never)).toBe(true);
		expect(id.equals(new ObjectId())).toBe(false);
		expect(id.equals(undefined)).toBe(false);
		expect(id.equals(null)).toBe(false);
	});

	test("an id from another BSON implementation compares equal", () => {
		const foreign = {
			_bsontype: "ObjectId",
			id: new Uint8Array(12),
			toHexString: () => HEX,
		};
		expect(new ObjectId(HEX).equals(foreign)).toBe(true);
	});
});

describe("ObjectId timestamps", () => {
	// The four timestamp bytes are *unsigned* seconds. Reading them through a
	// signed 32-bit shift puts every id generated after 2038-01-19 in 1901.
	test("reads a timestamp with the top bit set", () => {
		const id = new ObjectId(`80000000${"0".repeat(16)}`);
		expect(id.getTimestamp().toISOString()).toBe("2038-01-19T03:14:08.000Z");
	});

	test("reads the last timestamp the format can hold", () => {
		const id = new ObjectId(`ffffffff${"0".repeat(16)}`);
		expect(id.getTimestamp().toISOString()).toBe("2106-02-07T06:28:15.000Z");
	});

	test("createFromTime round-trips seconds either side of 2038", () => {
		for (const seconds of [
			0, 1_609_459_200, 2_147_483_647, 2_147_483_648, 4_294_967_295,
		]) {
			const id = ObjectId.createFromTime(seconds);
			expect(id.getTimestamp().getTime()).toBe(seconds * 1000);
			expect(id.toHexString().slice(8)).toBe("0000000000000000");
		}
	});
});

describe("ObjectId conversions", () => {
	test("toString renders hex by default and base64 on request", () => {
		const id = new ObjectId(HEX);
		expect(id.toString()).toBe(HEX);
		expect(id.toString("hex")).toBe(HEX);
		expect(ObjectId.createFromBase64(id.toString("base64")).equals(id)).toBe(
			true,
		);
	});

	test("createFromHexString and createFromBase64 police their lengths", () => {
		expect(() => ObjectId.createFromHexString("abc")).toThrow(
			"hex string must be 24 characters",
		);
		expect(() => ObjectId.createFromBase64("abc")).toThrow(
			"base64 string must be 16 characters",
		);
	});

	test("createFromBase64 rejects characters that are not base64", () => {
		expect(() => ObjectId.createFromBase64("!!!!!!!!!!!!!!!!")).toThrow();
	});

	test("the twelve bytes are readable, and settable", () => {
		const id = new ObjectId(HEX);
		expect([...id.id]).toEqual([
			0x50, 0x7f, 0x1f, 0x77, 0xbc, 0xf8, 0x6c, 0xd7, 0x99, 0x43, 0x90, 0x11,
		]);

		id.id = new Uint8Array(12);
		expect(id.toHexString()).toBe("000000000000000000000000");
	});

	test("isValid is a test of shape, not of intent", () => {
		expect(ObjectId.isValid(HEX)).toBe(true);
		expect(ObjectId.isValid(HEX.toUpperCase())).toBe(true);
		expect(ObjectId.isValid(new ObjectId())).toBe(true);
		expect(ObjectId.isValid(new Uint8Array(12))).toBe(true);
		expect(ObjectId.isValid("nope")).toBe(false);
		expect(ObjectId.isValid("")).toBe(false);
		expect(ObjectId.isValid(123)).toBe(false);
		expect(ObjectId.isValid(null)).toBe(false);
		expect(ObjectId.isValid(undefined)).toBe(false);
	});

	test("cacheHexString keeps the canonical hex, whatever case it was built from", () => {
		ObjectId.cacheHexString = true;
		try {
			const id = new ObjectId(HEX.toUpperCase());
			expect(id.toHexString()).toBe(HEX);
			expect(id.toHexString()).toBe(HEX);
			id.id = new Uint8Array(12);
			expect(id.toHexString()).toBe("000000000000000000000000");
		} finally {
			ObjectId.cacheHexString = undefined;
		}
	});
});

describe("isObjectId", () => {
	test("recognises ids from this driver and from any other", () => {
		expect(isObjectId(new ObjectId())).toBe(true);
		expect(isObjectId({ _bsontype: "ObjectId", toHexString: () => HEX })).toBe(
			true,
		);
	});

	test("rejects anything else, including a lookalike hex string", () => {
		expect(isObjectId(HEX)).toBe(false);
		expect(isObjectId({ toHexString: () => HEX })).toBe(false);
		expect(isObjectId({ _bsontype: "Decimal128" })).toBe(false);
		expect(isObjectId(null)).toBe(false);
		expect(isObjectId(undefined)).toBe(false);
	});
});

describe("toObjectId", () => {
	test("passes this driver's own ids straight through", () => {
		const id = new ObjectId();
		expect(toObjectId(id)).toBe(id);
	});

	test("rebuilds a foreign id as this driver's class", () => {
		const converted = toObjectId({
			_bsontype: "ObjectId",
			id: new Uint8Array(12),
			toHexString: () => HEX,
		} as never);
		expect(converted).toBeInstanceOf(ObjectId);
		expect(converted.toHexString()).toBe(HEX);
	});
});
