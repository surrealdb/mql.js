import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { ObjectId } from "../../../src/object-id.ts";
import {
	coerceIdCondition,
	isIdField,
} from "../../../src/translators/filter/id-field.ts";
import { translateFilter } from "../../../src/translators/filter.ts";
import { translateSort } from "../../../src/translators/sort.ts";

const TABLE = "users";
const HEX = "6a79de4e66f3582ae2d93606";

describe("isIdField", () => {
	test("recognises only the identity field", () => {
		expect(isIdField("_id")).toBe(true);
		expect(isIdField("id")).toBe(false);
		expect(isIdField("_ida")).toBe(false);
		expect(isIdField("nested._id")).toBe(false);
	});
});

describe("coerceIdCondition", () => {
	test("an ObjectId becomes a RecordId holding its hex string", () => {
		const out = coerceIdCondition(TABLE, new ObjectId(HEX)) as RecordId;
		expect(out).toBeInstanceOf(RecordId);
		expect(String(out.table)).toBe(TABLE);
		expect(out.id).toBe(HEX);
	});

	test("string and numeric ids are preserved verbatim, not stringified", () => {
		expect((coerceIdCondition(TABLE, "abc") as RecordId).id).toBe("abc");
		expect((coerceIdCondition(TABLE, 42) as RecordId).id).toBe(42);
	});

	test("an existing RecordId passes through", () => {
		const rid = new RecordId(TABLE, "abc");
		expect(coerceIdCondition(TABLE, rid)).toBe(rid);
	});

	test("scalar comparison operators have their operand coerced", () => {
		const out = coerceIdCondition(TABLE, { $ne: 42 }) as { $ne: RecordId };
		expect(out.$ne).toBeInstanceOf(RecordId);
		expect(out.$ne.id).toBe(42);
	});

	test("$in and $nin coerce every element", () => {
		const out = coerceIdCondition(TABLE, {
			$in: [new ObjectId(HEX), "abc", 7],
		}) as { $in: RecordId[] };
		expect(out.$in).toHaveLength(3);
		for (const item of out.$in) expect(item).toBeInstanceOf(RecordId);
		expect(out.$in.map((r) => r.id)).toEqual([HEX, "abc", 7]);
	});

	test("operators that do not compare identity are left untouched", () => {
		expect(coerceIdCondition(TABLE, { $exists: true })).toEqual({
			$exists: true,
		});
	});

	test("a value that cannot address a record is passed through, not thrown", () => {
		// The resulting comparison simply matches nothing, as in MongoDB.
		const weird = { nested: true };
		expect(coerceIdCondition(TABLE, weird)).toBe(weird);
	});
});

describe("translateFilter with _id", () => {
	const options = { collection: TABLE };

	test("rewrites the column to `id`", () => {
		const { clause } = translateFilter({ _id: HEX }, options);
		expect(clause).toBe("id = $p0");
	});

	test("binds a RecordId rather than the raw value", () => {
		const { bindings } = translateFilter({ _id: new ObjectId(HEX) }, options);
		const bound = bindings.p0 as RecordId;
		expect(bound).toBeInstanceOf(RecordId);
		expect(String(bound.table)).toBe(TABLE);
		expect(bound.id).toBe(HEX);
	});

	test("$in produces a bound array of RecordIds", () => {
		const { clause, bindings } = translateFilter(
			{ _id: { $in: ["a", "b"] } },
			options,
		);
		expect(clause).toBe("id IN $p0");
		const bound = bindings.p0 as RecordId[];
		expect(bound.every((r) => r instanceof RecordId)).toBe(true);
	});

	test("works nested inside logical operators", () => {
		const { clause } = translateFilter(
			{ $or: [{ _id: "a" }, { name: "x" }] },
			options,
		);
		expect(clause).toBe("(id = $p0 OR name = $p1)");
	});

	test("other fields are unaffected", () => {
		const { clause } = translateFilter({ _id: "a", name: "x" }, options);
		expect(clause).toBe("id = $p0 AND name = $p1");
	});

	test("without a collection the condition is left alone rather than mis-bound", () => {
		// No table means no RecordId can be built. Every in-driver call site
		// supplies one; this only guards direct use of the translator.
		const { clause } = translateFilter({ _id: "a" });
		expect(clause).toBe("_id = $p0");
	});
});

describe("translateSort with _id", () => {
	test("sorts on the `id` column", () => {
		expect(translateSort({ _id: 1 })).toBe("ORDER BY id ASC");
		expect(translateSort({ _id: -1 })).toBe("ORDER BY id DESC");
	});

	test("the string shorthand and tuple form map too", () => {
		expect(translateSort("_id")).toBe("ORDER BY id ASC");
		expect(translateSort([["_id", -1]])).toBe("ORDER BY id DESC");
	});

	test("mixed keys keep their own names", () => {
		expect(translateSort({ _id: 1, name: -1 })).toBe(
			"ORDER BY id ASC, name DESC",
		);
	});
});
