import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { ObjectId } from "../../../src/object-id.ts";
import {
	applyProjection,
	prepareInsert,
	recordToDocument,
} from "../../../src/utils/id.ts";

describe("prepareInsert", () => {
	test("auto-generates an ObjectId when _id is missing", () => {
		const out = prepareInsert("users", { name: "Alice" });
		expect(out.insertedId).toBeInstanceOf(ObjectId);
		expect(out.recordId).toBeInstanceOf(RecordId);
		expect(out.recordId?.table.name).toBe("users");
		expect(out.recordId?.id).toBe((out.insertedId as ObjectId).toHexString());
		expect(out.data).toEqual({ name: "Alice" });
	});

	test("auto-generates a fresh ObjectId for null _id", () => {
		const out = prepareInsert("users", { _id: null, name: "Alice" });
		expect(out.insertedId).toBeInstanceOf(ObjectId);
		expect(out.data).toEqual({ name: "Alice" });
	});

	test("preserves a string _id verbatim", () => {
		const out = prepareInsert("users", { _id: "alice-1", name: "Alice" });
		expect(out.insertedId).toBe("alice-1");
		expect(out.recordId?.id).toBe("alice-1");
		expect(out.data).toEqual({ name: "Alice" });
		expect(out.data._id).toBeUndefined();
	});

	test("preserves a numeric _id verbatim", () => {
		const out = prepareInsert("users", { _id: 42, name: "Alice" });
		expect(out.insertedId).toBe(42);
		expect(out.recordId?.id).toBe(42);
	});

	test("uses an existing ObjectId without re-generating", () => {
		const oid = new ObjectId();
		const out = prepareInsert("users", { _id: oid, name: "Alice" });
		expect(out.insertedId).toBe(oid);
		expect(out.recordId?.id).toBe(oid.toHexString());
	});

	test("falls back to String(_id) for non-string/number/ObjectId types", () => {
		const out = prepareInsert("users", { _id: true as unknown as string });
		expect(out.insertedId).toBe("true");
		expect(out.recordId?.id).toBe("true");
	});

	test("does not mutate the input document", () => {
		const input = { _id: "abc", name: "x" };
		prepareInsert("users", input);
		expect(input).toEqual({ _id: "abc", name: "x" });
	});

	test("table on RecordId matches the supplied table name", () => {
		const out = prepareInsert("with spaces", {});
		expect(out.recordId?.table.name).toBe("with spaces");
	});
});

describe("recordToDocument", () => {
	test("RecordId with hex id becomes an ObjectId _id", () => {
		const rid = new RecordId("users", "507f1f77bcf86cd799439011");
		const doc = recordToDocument({ id: rid, name: "Alice" });
		expect(doc._id).toBeInstanceOf(ObjectId);
		expect((doc._id as ObjectId).toHexString()).toBe(
			"507f1f77bcf86cd799439011",
		);
		expect(doc.name).toBe("Alice");
	});

	test("RecordId with non-hex string keeps the raw id string", () => {
		const rid = new RecordId("users", "alice-1");
		const doc = recordToDocument({ id: rid });
		expect(doc._id).toBe("alice-1");
	});

	test("RecordId with numeric id becomes a number _id", () => {
		const rid = new RecordId("users", 42);
		const doc = recordToDocument({ id: rid });
		expect(doc._id).toBe(42);
	});

	test("string id 'table:hex' is unwrapped to ObjectId", () => {
		const doc = recordToDocument({
			id: "users:507f1f77bcf86cd799439011",
		});
		expect(doc._id).toBeInstanceOf(ObjectId);
		expect((doc._id as ObjectId).toHexString()).toBe(
			"507f1f77bcf86cd799439011",
		);
	});

	test("string id 'table:non-hex' falls back to plain string", () => {
		const doc = recordToDocument({ id: "users:alice-1" });
		expect(doc._id).toBe("alice-1");
	});

	test("plain non-hex string id is returned as-is", () => {
		const doc = recordToDocument({ id: "alice-1" });
		expect(doc._id).toBe("alice-1");
	});

	test("numeric id passes through", () => {
		const doc = recordToDocument({ id: 7 });
		expect(doc._id).toBe(7);
	});

	test("preserves non-id fields", () => {
		const doc = recordToDocument({ id: 1, a: "x", b: 2, c: { nested: true } });
		expect(doc).toEqual({ _id: 1, a: "x", b: 2, c: { nested: true } });
	});

	test("RecordId fallback for unusual id types stringifies", () => {
		// surrealdb's RecordId allows array/object id values; verify the
		// id-conversion fallback uses String(idPart) for those.
		const rid = new RecordId("users", ["a", "b"]);
		const doc = recordToDocument({ id: rid });
		expect(typeof doc._id).toBe("string");
	});
});

describe("applyProjection", () => {
	test("removes excluded fields", () => {
		const out = applyProjection({ a: 1, b: 2, c: 3 }, ["b"], true);
		expect(out).toEqual({ a: 1, c: 3 });
	});

	test("removes multiple excluded fields", () => {
		const out = applyProjection({ a: 1, b: 2, c: 3 }, ["a", "c"], true);
		expect(out).toEqual({ b: 2 });
	});

	test("removes the _id key entirely when includeId is false", () => {
		// Previously this assigned `undefined`, which left an explicit `_id` key:
		// `"_id" in doc` was true and `Object.keys` still listed it. MongoDB omits
		// the key altogether.
		const out = applyProjection({ _id: "x", a: 1 }, [], false);
		expect("_id" in out).toBe(false);
		expect(Object.keys(out)).toEqual(["a"]);
		expect(out.a).toBe(1);
	});

	test("does not mutate the input document", () => {
		const input = { a: 1, b: 2 };
		applyProjection(input, ["a"], true);
		expect(input).toEqual({ a: 1, b: 2 });
	});

	test("excluding a missing field is a no-op", () => {
		const out = applyProjection({ a: 1 }, ["doesNotExist"], true);
		expect(out).toEqual({ a: 1 });
	});

	// -----------------------------------------------------------------------
	// Dotted exclusion paths. `delete result["auth.pw"]` matched no key, so a
	// nested exclusion was a silent no-op and returned the field anyway — a
	// data-exposure bug, since that is how a caller hides a password hash.
	// -----------------------------------------------------------------------

	test("dotted path deletes the leaf and keeps its siblings", () => {
		const out = applyProjection(
			{ _id: "x", auth: { pw: "secret", user: "u" }, a: 1 },
			["auth.pw"],
			true,
		);
		expect(out).toEqual({ _id: "x", auth: { user: "u" }, a: 1 });
	});

	test("dotted path works at arbitrary depth", () => {
		const out = applyProjection(
			{ auth: { deep: { x: 1, y: 2 }, pw: "p" } },
			["auth.deep.x"],
			true,
		);
		expect(out).toEqual({ auth: { deep: { y: 2 }, pw: "p" } });
	});

	test("dotted path strips the leaf from every element of an array", () => {
		const out = applyProjection(
			{ users: [{ name: "a", pw: "1" }, { name: "b", pw: "2" }, 7] },
			["users.pw"],
			true,
		);
		expect(out).toEqual({ users: [{ name: "a" }, { name: "b" }, 7] });
	});

	test("a missing or scalar path segment is a no-op, not a throw", () => {
		const doc = { a: 1, auth: { user: "u" } };
		expect(() =>
			applyProjection(doc, ["nope.x", "a.b.c", "auth.deep.x"], true),
		).not.toThrow();
		expect(
			applyProjection(doc, ["nope.x", "a.b.c", "auth.deep.x"], true),
		).toEqual(doc);
	});

	test("does not mutate nested sub-documents of the input", () => {
		const input = {
			auth: { pw: "secret", user: "u" },
			users: [{ pw: "q", name: "n" }],
		};
		applyProjection(input, ["auth.pw", "users.pw"], true);
		expect(input).toEqual({
			auth: { pw: "secret", user: "u" },
			users: [{ pw: "q", name: "n" }],
		});
	});

	test("mixes top-level and dotted exclusions", () => {
		const out = applyProjection(
			{ _id: "x", a: 1, auth: { pw: "p", user: "u" } },
			["a", "auth.pw"],
			false,
		);
		expect(out).toEqual({ auth: { user: "u" } });
	});

	test("leaves class instances in the path untouched", () => {
		// Spreading an ObjectId would produce a prototype-less lookalike; a
		// projection path never addresses its internals, so it must be skipped.
		const oid = new ObjectId();
		const out = applyProjection({ ref: oid, a: 1 }, ["ref.id"], true);
		expect(out.ref).toBe(oid);
	});
});
