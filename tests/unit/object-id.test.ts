import { describe, expect, test } from "bun:test";
import { ObjectId } from "../../src/object-id.ts";

describe("ObjectId", () => {
	test("generates a valid 24-char hex string", () => {
		const id = new ObjectId();
		expect(id.toHexString()).toMatch(/^[0-9a-f]{24}$/);
	});

	test("each generated id is unique", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 1000; i++) {
			ids.add(new ObjectId().toHexString());
		}
		expect(ids.size).toBe(1000);
	});

	test("constructs from a valid hex string", () => {
		const hex = "507f1f77bcf86cd799439011";
		const id = new ObjectId(hex);
		expect(id.toHexString()).toBe(hex);
	});

	test("normalises uppercase hex to lowercase", () => {
		const id = new ObjectId("507F1F77BCF86CD799439011");
		expect(id.toHexString()).toBe("507f1f77bcf86cd799439011");
	});

	test("rejects invalid strings", () => {
		expect(() => new ObjectId("not-valid")).toThrow("Invalid ObjectId");
		expect(() => new ObjectId("507f1f77bcf86cd79943901")).toThrow(); // 23 chars
		expect(() => new ObjectId("507f1f77bcf86cd7994390111")).toThrow(); // 25 chars
		expect(() => new ObjectId("zzzzzzzzzzzzzzzzzzzzzzzz")).toThrow(); // non-hex
	});

	test("constructs from another ObjectId", () => {
		const a = new ObjectId();
		const b = new ObjectId(a);
		expect(b.toHexString()).toBe(a.toHexString());
	});

	test("isValid detects valid strings", () => {
		expect(ObjectId.isValid("507f1f77bcf86cd799439011")).toBe(true);
		expect(ObjectId.isValid("507F1F77BCF86CD799439011")).toBe(true);
		expect(ObjectId.isValid(new ObjectId())).toBe(true);
	});

	test("isValid rejects invalid values", () => {
		expect(ObjectId.isValid("nope")).toBe(false);
		expect(ObjectId.isValid("")).toBe(false);
		expect(ObjectId.isValid(123)).toBe(false);
		expect(ObjectId.isValid(null)).toBe(false);
		expect(ObjectId.isValid(undefined)).toBe(false);
	});

	test("getTimestamp returns embedded Date", () => {
		const now = Math.floor(Date.now() / 1000);
		const id = new ObjectId();
		const ts = id.getTimestamp();
		// Should be within 1 second of now
		expect(Math.abs(Math.floor(ts.getTime() / 1000) - now)).toBeLessThanOrEqual(
			1,
		);
	});

	test("createFromTime embeds the given timestamp", () => {
		const time = 1609459200; // 2021-01-01T00:00:00Z
		const id = ObjectId.createFromTime(time);
		expect(id.getTimestamp().getTime()).toBe(time * 1000);
		// Remaining bytes should be zero
		expect(id.toHexString().substring(8)).toBe("0000000000000000");
	});

	test("equals compares with ObjectId", () => {
		const hex = "507f1f77bcf86cd799439011";
		const a = new ObjectId(hex);
		const b = new ObjectId(hex);
		expect(a.equals(b)).toBe(true);
		expect(a.equals(new ObjectId())).toBe(false);
	});

	test("equals compares with string", () => {
		const hex = "507f1f77bcf86cd799439011";
		const id = new ObjectId(hex);
		expect(id.equals(hex)).toBe(true);
		expect(id.equals("000000000000000000000000")).toBe(false);
	});

	test("toString returns hex string", () => {
		const hex = "507f1f77bcf86cd799439011";
		expect(new ObjectId(hex).toString()).toBe(hex);
	});

	test("toJSON returns hex string", () => {
		const hex = "507f1f77bcf86cd799439011";
		expect(JSON.stringify(new ObjectId(hex))).toBe(`"${hex}"`);
	});
});
