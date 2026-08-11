import { describe, expect, test } from "bun:test";
import { RecordId, StringRecordId } from "surrealdb";
import { ObjectId } from "../../../src/object-id.ts";
import {
	applyProjection,
	parseRecordIdString,
	prepareInsert,
	recordToDocument,
} from "../../../src/utils/id.ts";

describe("prepareInsert", () => {
	test("auto-generates an ObjectId when _id is missing", () => {
		const out = prepareInsert("users", { name: "Alice" });
		expect(out.insertedId).toBeInstanceOf(ObjectId);
		expect(out.recordId).toBeInstanceOf(RecordId);
		expect(out.recordId?.table.name).toBe("users");
		expect(out.recordId?.id).toEqual({
			$oid: (out.insertedId as ObjectId).toHexString(),
		});
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
		expect(out.recordId?.id).toEqual({ $oid: oid.toHexString() });
	});

	// mongoose and anything else built on the `bson` package hands over its own
	// ObjectId class, which has to be stored as an id rather than as an object.
	test("stores an ObjectId from another BSON implementation as an id", () => {
		const hex = "507f1f77bcf86cd799439011";
		const foreign = {
			_bsontype: "ObjectId",
			id: new Uint8Array(12),
			toHexString: () => hex,
		};
		const out = prepareInsert("users", { _id: foreign });
		expect(out.recordId?.id).toEqual({ $oid: hex });
		expect(out.insertedId).toBe(foreign as never);
	});

	test("a string _id that looks like hex is stored as a string", () => {
		const hex = "507f1f77bcf86cd799439011";
		const out = prepareInsert("users", { _id: hex });
		expect(out.recordId?.id).toBe(hex);
		expect(out.insertedId).toBe(hex);
	});

	test("an _id containing colons is stored whole", () => {
		const out = prepareInsert("users", { _id: "urn:uuid:1234" });
		expect(out.recordId?.id).toBe("urn:uuid:1234");
	});

	test("the stored form of an id is accepted as that id", () => {
		const hex = "507f1f77bcf86cd799439011";
		const out = prepareInsert("users", { _id: { $oid: hex } });
		expect(out.insertedId).toBeInstanceOf(ObjectId);
		expect(out.recordId?.id).toEqual({ $oid: hex });
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
	test("RecordId holding the stored form becomes an ObjectId _id", () => {
		const hex = "507f1f77bcf86cd799439011";
		const rid = new RecordId("users", { $oid: hex });
		const doc = recordToDocument({ id: rid, name: "Alice" });
		expect(doc._id).toBeInstanceOf(ObjectId);
		expect((doc._id as ObjectId).toHexString()).toBe(hex);
		expect(doc.name).toBe("Alice");
	});

	test("RecordId with a string id keeps the raw id string", () => {
		const rid = new RecordId("users", "alice-1");
		const doc = recordToDocument({ id: rid });
		expect(doc._id).toBe("alice-1");
	});

	// The caller supplied a string; MongoDB would hand back a string. Promoting it
	// would change the type of a key its owner chose.
	test("a string id that looks like an ObjectId stays a string", () => {
		const hex = "507f1f77bcf86cd799439011";
		const doc = recordToDocument({ id: new RecordId("users", hex) });
		expect(doc._id).toBe(hex);
	});

	test("an id containing colons is returned whole", () => {
		const doc = recordToDocument({
			id: new RecordId("users", "urn:uuid:1234"),
		});
		expect(doc._id).toBe("urn:uuid:1234");
	});

	test("RecordId with numeric id becomes a number _id", () => {
		const rid = new RecordId("users", 42);
		const doc = recordToDocument({ id: rid });
		expect(doc._id).toBe(42);
	});

	test("a record id the wire carried as text is split on its table", () => {
		const doc = recordToDocument({
			id: new StringRecordId("users:⟨urn:uuid:1234⟩"),
		});
		expect(doc._id).toBe("urn:uuid:1234");
	});

	test("a bare string id is left exactly as it arrived", () => {
		// Nothing this driver writes produces one, and `'urn:uuid:1234'` is
		// indistinguishable from a table-qualified id: guessing costs a primary key.
		const doc = recordToDocument({ id: "urn:uuid:1234" });
		expect(doc._id).toBe("urn:uuid:1234");
	});

	test("stored ObjectIds inside the document are rebuilt", () => {
		const hex = "507f1f77bcf86cd799439011";
		const doc = recordToDocument({
			id: new RecordId("posts", 1),
			authorId: { $oid: hex },
			editors: [{ $oid: hex }],
			meta: { reviewers: [{ user: { $oid: hex } }] },
		});

		expect(doc.authorId).toBeInstanceOf(ObjectId);
		expect((doc.editors as ObjectId[])[0]).toBeInstanceOf(ObjectId);
		expect(
			(doc.meta as { reviewers: { user: ObjectId }[] }).reviewers[0].user,
		).toBeInstanceOf(ObjectId);
	});

	test("an object that is not the stored form is left alone", () => {
		const doc = recordToDocument({
			id: new RecordId("posts", 1),
			labelled: { $oid: "507f1f77bcf86cd799439011", note: "mine" },
			short: { $oid: "abc" },
		});

		expect(doc.labelled).toEqual({
			$oid: "507f1f77bcf86cd799439011",
			note: "mine",
		});
		expect(doc.short).toEqual({ $oid: "abc" });
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

// Every spelling here was taken from a live SurrealDB 3.x error message, or from
// the SDK's own `RecordId.toString()`, which is the other place a record id
// arrives as text.
describe("parseRecordIdString", () => {
	test("splits the table from the id", () => {
		expect(parseRecordIdString("users:alice")).toEqual({
			collection: "users",
			id: "alice",
		});
	});

	test("a backtick-quoted id keeps its colons", () => {
		expect(parseRecordIdString("users:`urn:uuid:1234`")).toEqual({
			collection: "users",
			id: "urn:uuid:1234",
		});
	});

	test("an angle-quoted id keeps its colons", () => {
		expect(parseRecordIdString("users:⟨urn:uuid:1234⟩")).toEqual({
			collection: "users",
			id: "urn:uuid:1234",
		});
	});

	test("escapes inside a quoted id are undone", () => {
		expect(parseRecordIdString("users:`back\\`tick`").id).toBe("back`tick");
	});

	/**
	 * The printed spellings here were taken from a live 3.x server. A control
	 * character is escaped rather than emitted, so an id holding one is only
	 * recovered by decoding the escape — dropping the backslash would report an
	 * `_id` of `'tab\there'` back to its owner as `'tabthere'`.
	 */
	test("a control character in a quoted id is decoded, not flattened", () => {
		expect(parseRecordIdString("users:`tab\\there`").id).toBe("tab\there");
		expect(parseRecordIdString("users:`line\\none`").id).toBe("line\none");
		expect(parseRecordIdString("users:`a\\u{8}b`").id).toBe("a\bb");
		expect(parseRecordIdString("users:`a\\\\b`").id).toBe("a\\b");
	});

	test("a quoted table name is decoded the same way", () => {
		expect(parseRecordIdString("`tab\\there`:alice").collection).toBe(
			"tab\there",
		);
	});

	test("a quoted table name is not mistaken for the id", () => {
		expect(parseRecordIdString("`odd:table`:alice")).toEqual({
			collection: "odd:table",
			id: "alice",
		});
	});

	test('quoting distinguishes the number 42 from the string "42"', () => {
		expect(parseRecordIdString("n:42").id).toBe(42);
		expect(parseRecordIdString("s:`42`").id).toBe("42");
	});

	test("the stored form of an ObjectId is read back as one", () => {
		const hex = "507f1f77bcf86cd799439011";
		for (const printed of [
			`users:{ "$oid": '${hex}' }`,
			`users:{ "$oid": s"${hex}" }`,
			`users:{"$oid":"${hex}"}`,
		]) {
			const parsed = parseRecordIdString(printed);
			expect(parsed.id).toBeInstanceOf(ObjectId);
			expect((parsed.id as ObjectId).toHexString()).toBe(hex);
		}
	});

	test("a hex-looking string id stays a string", () => {
		const hex = "507f1f77bcf86cd799439011";
		expect(parseRecordIdString(`users:${hex}`).id).toBe(hex);
	});

	test("text carrying no table reports none", () => {
		expect(parseRecordIdString("alice")).toEqual({
			collection: undefined,
			id: "alice",
		});
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
