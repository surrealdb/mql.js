import { describe, expect, test } from "bun:test";
import {
	translateReplacement,
	translateUpdate,
} from "../../../src/translators/update.ts";

describe("translateUpdate", () => {
	// -----------------------------------------------------------------
	// $set
	// -----------------------------------------------------------------
	test("$set single field", () => {
		const { clause, bindings } = translateUpdate({ $set: { name: "Jane" } });
		expect(clause).toBe("SET name = $p0");
		expect(bindings).toEqual({ p0: "Jane" });
	});

	test("$set multiple fields", () => {
		const { clause, bindings } = translateUpdate({
			$set: { name: "Jane", age: 25 },
		});
		expect(clause).toBe("SET name = $p0, age = $p1");
		expect(bindings).toEqual({ p0: "Jane", p1: 25 });
	});

	// -----------------------------------------------------------------
	// $unset
	// -----------------------------------------------------------------
	test("$unset", () => {
		const { clause, bindings } = translateUpdate({
			$unset: { email: "", phone: "" },
		});
		expect(clause).toBe("SET email = NONE, phone = NONE");
		expect(bindings).toEqual({});
	});

	// -----------------------------------------------------------------
	// $inc
	// -----------------------------------------------------------------
	test("$inc", () => {
		const { clause, bindings } = translateUpdate({ $inc: { visits: 1 } });
		expect(clause).toBe("SET visits += $p0");
		expect(bindings).toEqual({ p0: 1 });
	});

	test("$inc negative (decrement)", () => {
		const { clause, bindings } = translateUpdate({ $inc: { stock: -1 } });
		expect(clause).toBe("SET stock += $p0");
		expect(bindings).toEqual({ p0: -1 });
	});

	// -----------------------------------------------------------------
	// $mul
	// -----------------------------------------------------------------
	test("$mul", () => {
		const { clause, bindings } = translateUpdate({ $mul: { price: 1.1 } });
		expect(clause).toBe("SET price = price * $p0");
		expect(bindings).toEqual({ p0: 1.1 });
	});

	// -----------------------------------------------------------------
	// $min / $max
	// -----------------------------------------------------------------
	test("$min", () => {
		const { clause, bindings } = translateUpdate({ $min: { low: 5 } });
		expect(clause).toBe("SET low = math::min([low, $p0])");
		expect(bindings).toEqual({ p0: 5 });
	});

	test("$max", () => {
		const { clause, bindings } = translateUpdate({ $max: { high: 100 } });
		expect(clause).toBe("SET high = math::max([high, $p0])");
		expect(bindings).toEqual({ p0: 100 });
	});

	// -----------------------------------------------------------------
	// $push / $pull
	// -----------------------------------------------------------------
	test("$push", () => {
		const { clause, bindings } = translateUpdate({
			$push: { tags: "new" },
		});
		expect(clause).toBe("SET tags += [$p0]");
		expect(bindings).toEqual({ p0: "new" });
	});

	test("$pull", () => {
		const { clause, bindings } = translateUpdate({
			$pull: { tags: "old" },
		});
		expect(clause).toBe("SET tags -= [$p0]");
		expect(bindings).toEqual({ p0: "old" });
	});

	// -----------------------------------------------------------------
	// $addToSet
	// -----------------------------------------------------------------
	test("$addToSet", () => {
		const { clause, bindings } = translateUpdate({
			$addToSet: { tags: "unique" },
		});
		expect(clause).toBe("SET tags = array::union(tags, [$p0])");
		expect(bindings).toEqual({ p0: "unique" });
	});

	// -----------------------------------------------------------------
	// $rename
	// -----------------------------------------------------------------
	test("$rename", () => {
		const { clause, bindings } = translateUpdate({
			$rename: { oldName: "newName" },
		});
		expect(clause).toBe("SET newName = oldName, oldName = NONE");
		expect(bindings).toEqual({});
	});

	// -----------------------------------------------------------------
	// $currentDate
	// -----------------------------------------------------------------
	test("$currentDate", () => {
		const { clause, bindings } = translateUpdate({
			$currentDate: { updatedAt: true },
		});
		expect(clause).toBe("SET updatedAt = time::now()");
		expect(bindings).toEqual({});
	});

	// -----------------------------------------------------------------
	// $setOnInsert
	// -----------------------------------------------------------------
	test("$setOnInsert single field", () => {
		const { clause, bindings } = translateUpdate({
			$setOnInsert: { status: "new" },
		});
		expect(clause).toBe("SET status = status ?? $p0");
		expect(bindings).toEqual({ p0: "new" });
	});

	test("$setOnInsert multiple fields", () => {
		const { clause, bindings } = translateUpdate({
			$setOnInsert: { status: "new", createdAt: "2024-01-01" },
		});
		expect(clause).toBe(
			"SET status = status ?? $p0, createdAt = createdAt ?? $p1",
		);
		expect(bindings).toEqual({ p0: "new", p1: "2024-01-01" });
	});

	test("$setOnInsert combined with $set", () => {
		const { clause, bindings } = translateUpdate({
			$set: { name: "Jane" },
			$setOnInsert: { status: "new" },
		});
		expect(clause).toBe("SET name = $p0, status = status ?? $p1");
		expect(bindings).toEqual({ p0: "Jane", p1: "new" });
	});

	// -----------------------------------------------------------------
	// Combined operators
	// -----------------------------------------------------------------
	test("$set + $inc combined", () => {
		const { clause, bindings } = translateUpdate({
			$set: { name: "Jane" },
			$inc: { age: 1 },
		});
		expect(clause).toBe("SET name = $p0, age += $p1");
		expect(bindings).toEqual({ p0: "Jane", p1: 1 });
	});

	// -----------------------------------------------------------------
	// startIndex
	// -----------------------------------------------------------------
	test("startIndex offsets parameter names", () => {
		const { clause, bindings } = translateUpdate({ $set: { x: 1 } }, 5);
		expect(clause).toBe("SET x = $p5");
		expect(bindings).toEqual({ p5: 1 });
	});

	// -----------------------------------------------------------------
	// Dot-notation
	// -----------------------------------------------------------------
	test("dot-notation fields", () => {
		const { clause, bindings } = translateUpdate({
			$set: { "address.city": "NYC" },
		});
		expect(clause).toBe("SET address.city = $p0");
		expect(bindings).toEqual({ p0: "NYC" });
	});

	// -----------------------------------------------------------------
	// Errors
	// -----------------------------------------------------------------
	test("throws on unsupported operator", () => {
		expect(() => translateUpdate({ $bit: { flags: { and: 0 } } })).toThrow(
			"Unsupported update operator: $bit",
		);
	});

	// -----------------------------------------------------------------
	// $push with $each modifier
	// -----------------------------------------------------------------
	test("$push with $each", () => {
		const { clause, bindings } = translateUpdate({
			$push: { scores: { $each: [85, 90] } },
		});
		expect(clause).toBe("SET scores = array::concat(scores, $p0)");
		expect(bindings).toEqual({ p0: [85, 90] });
	});

	test("$push with $each and $sort ascending", () => {
		const { clause, bindings } = translateUpdate({
			$push: { scores: { $each: [85], $sort: 1 } },
		});
		expect(clause).toBe(
			"SET scores = array::sort::asc(array::concat(scores, $p0))",
		);
		expect(bindings).toEqual({ p0: [85] });
	});

	test("$push with $each and $sort descending", () => {
		const { clause, bindings } = translateUpdate({
			$push: { scores: { $each: [85], $sort: -1 } },
		});
		expect(clause).toBe(
			"SET scores = array::sort::desc(array::concat(scores, $p0))",
		);
		expect(bindings).toEqual({ p0: [85] });
	});

	test("$push with $each and $slice positive", () => {
		const { clause, bindings } = translateUpdate({
			$push: { scores: { $each: [85, 90], $slice: 5 } },
		});
		expect(clause).toBe(
			"SET scores = array::slice(array::concat(scores, $p0), 0, $p1)",
		);
		expect(bindings).toEqual({ p0: [85, 90], p1: 5 });
	});

	test("$push with $each and $slice negative", () => {
		const { clause, bindings } = translateUpdate({
			$push: { scores: { $each: [85, 90], $slice: -3 } },
		});
		expect(clause).toBe(
			"SET scores = array::slice(array::concat(scores, $p0), $p1)",
		);
		expect(bindings).toEqual({ p0: [85, 90], p1: -3 });
	});

	test("$push with $each and $position", () => {
		const { clause, bindings } = translateUpdate({
			$push: { scores: { $each: [85], $position: 0 } },
		});
		expect(clause).toBe(
			"SET scores = array::concat(array::concat(array::slice(scores, 0, $p1), $p0), array::slice(scores, $p1))",
		);
		expect(bindings).toEqual({ p0: [85], p1: 0 });
	});

	test("$push with $each + $sort + $slice combined", () => {
		const { clause, bindings } = translateUpdate({
			$push: { scores: { $each: [85, 90], $sort: 1, $slice: 5 } },
		});
		expect(clause).toBe(
			"SET scores = array::slice(array::sort::asc(array::concat(scores, $p0)), 0, $p1)",
		);
		expect(bindings).toEqual({ p0: [85, 90], p1: 5 });
	});

	// -----------------------------------------------------------------
	// $pop
	// -----------------------------------------------------------------
	test("$pop removes last element", () => {
		const { clause, bindings } = translateUpdate({
			$pop: { tags: 1 },
		});
		expect(clause).toBe(
			"SET tags = array::slice(tags, 0, array::len(tags) - 1)",
		);
		expect(bindings).toEqual({});
	});

	test("$pop removes first element", () => {
		const { clause, bindings } = translateUpdate({
			$pop: { tags: -1 },
		});
		expect(clause).toBe("SET tags = array::slice(tags, 1)");
		expect(bindings).toEqual({});
	});

	// -----------------------------------------------------------------
	// $pullAll
	// -----------------------------------------------------------------
	test("$pullAll removes all matching values", () => {
		const { clause, bindings } = translateUpdate({
			$pullAll: { tags: ["a", "b"] },
		});
		expect(clause).toBe("SET tags = array::complement(tags, $p0)");
		expect(bindings).toEqual({ p0: ["a", "b"] });
	});

	// -----------------------------------------------------------------
	// Positional array operators: $[]
	// -----------------------------------------------------------------
	test("$set with $[] updates all elements", () => {
		const { clause, bindings } = translateUpdate({
			$set: { "grades.$[].score": 100 },
		});
		expect(clause).toBe("SET grades[*].score = $p0");
		expect(bindings).toEqual({ p0: 100 });
	});

	test("$inc with $[] increments all elements", () => {
		const { clause, bindings } = translateUpdate({
			$inc: { "scores.$[].value": 5 },
		});
		expect(clause).toBe("SET scores[*].`value` += $p0");
		expect(bindings).toEqual({ p0: 5 });
	});

	test("$unset with $[] removes field from all elements", () => {
		const { clause, bindings } = translateUpdate({
			$unset: { "items.$[].oldField": "" },
		});
		expect(clause).toBe("SET items[*].oldField = NONE");
		expect(bindings).toEqual({});
	});

	// -----------------------------------------------------------------
	// Positional array operators: $[identifier]
	// -----------------------------------------------------------------
	test("$set with $[identifier] and equality arrayFilter", () => {
		const { clause, bindings } = translateUpdate(
			{ $set: { "grades.$[elem].score": 100 } },
			0,
			{ arrayFilters: [{ "elem.grade": "A" }] },
		);
		expect(clause).toBe("SET grades[WHERE grade = $p0].score = $p1");
		expect(bindings).toEqual({ p0: "A", p1: 100 });
	});

	test("$set with $[identifier] and operator arrayFilter", () => {
		const { clause, bindings } = translateUpdate(
			{ $set: { "scores.$[high].passed": true } },
			0,
			{ arrayFilters: [{ "high.value": { $gte: 90 } }] },
		);
		expect(clause).toBe("SET scores[WHERE `value` >= $p0].passed = $p1");
		expect(bindings).toEqual({ p0: 90, p1: true });
	});

	test("$inc with $[identifier] and multiple conditions", () => {
		const { clause, bindings } = translateUpdate(
			{ $inc: { "items.$[item].qty": 1 } },
			0,
			{
				arrayFilters: [{ "item.status": "active", "item.qty": { $lt: 100 } }],
			},
		);
		expect(clause).toBe(
			"SET items[WHERE status = $p0 AND qty < $p1].qty += $p2",
		);
		expect(bindings).toEqual({ p0: "active", p1: 100, p2: 1 });
	});

	test("$[identifier] throws without arrayFilters", () => {
		expect(() =>
			translateUpdate({ $set: { "grades.$[elem].score": 100 } }),
		).toThrow("Positional operator $[elem] requires arrayFilters");
	});

	test("$[identifier] throws with no matching filter", () => {
		expect(() =>
			translateUpdate({ $set: { "grades.$[elem].score": 100 } }, 0, {
				arrayFilters: [{ "other.grade": "A" }],
			}),
		).toThrow('No arrayFilter found for identifier "elem"');
	});

	// -----------------------------------------------------------------
	// Empty
	// -----------------------------------------------------------------
	test("empty update produces empty clause", () => {
		const { clause } = translateUpdate({});
		expect(clause).toBe("");
	});
});

describe("translateReplacement", () => {
	test("produces CONTENT clause", () => {
		const { clause, bindings } = translateReplacement({
			name: "Jane",
			age: 25,
		});
		expect(clause).toBe("CONTENT $p0");
		expect(bindings).toEqual({ p0: { name: "Jane", age: 25 } });
	});

	test("startIndex offsets parameter name", () => {
		const { clause, bindings } = translateReplacement({ x: 1 }, 3);
		expect(clause).toBe("CONTENT $p3");
		expect(bindings).toEqual({ p3: { x: 1 } });
	});
});
