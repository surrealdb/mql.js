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
	// `math::min`/`math::max` are numeric-only, so the old shape threw on
	// strings and dates; a conditional assignment has no type restriction.
	test("$min emits a conditional assignment, not math::min", () => {
		const { clause, bindings } = translateUpdate({ $min: { low: 5 } });
		expect(clause).toBe(
			"SET low = IF low IS NONE OR $p0 < low THEN $p0 ELSE low END",
		);
		expect(bindings).toEqual({ p0: 5 });
	});

	test("$max emits a conditional assignment, not math::max", () => {
		const { clause, bindings } = translateUpdate({ $max: { high: 100 } });
		expect(clause).toBe(
			"SET high = IF high IS NONE OR $p0 > high THEN $p0 ELSE high END",
		);
		expect(bindings).toEqual({ p0: 100 });
	});

	test("$min works on a non-numeric value", () => {
		const { clause, bindings } = translateUpdate({ $min: { s: "b" } });
		expect(clause).toBe("SET s = IF s IS NONE OR $p0 < s THEN $p0 ELSE s END");
		expect(bindings).toEqual({ p0: "b" });
	});

	test("$min on a dot-notation path", () => {
		const { clause } = translateUpdate({ $min: { "a.b": 1 } });
		expect(clause).toBe(
			"SET a.b = IF a.b IS NONE OR $p0 < a.b THEN $p0 ELSE a.b END",
		);
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

	test("$pull with an array operand removes that array as one element", () => {
		const { clause, bindings } = translateUpdate({
			$pull: { tags: ["a", "b"] },
		});
		expect(clause).toBe("SET tags -= [$p0]");
		expect(bindings).toEqual({ p0: ["a", "b"] });
	});

	// The predicate and condition-document forms used to bind the whole object
	// as an equality operand, which matched nothing: a silent no-op.
	test("$pull with a comparison predicate", () => {
		const { clause, bindings } = translateUpdate({
			$pull: { n: { $gte: 3 } },
		});
		expect(clause).toBe("SET n = n[WHERE !($this >= $p0)]");
		expect(bindings).toEqual({ p0: 3 });
	});

	test("$pull with multiple predicate operators is ANDed", () => {
		const { clause, bindings } = translateUpdate({
			$pull: { n: { $gte: 2, $lt: 10 } },
		});
		expect(clause).toBe("SET n = n[WHERE !($this >= $p0 AND $this < $p1)]");
		expect(bindings).toEqual({ p0: 2, p1: 10 });
	});

	test("$pull with $in", () => {
		const { clause, bindings } = translateUpdate({
			$pull: { n: { $in: [1, 2] } },
		});
		expect(clause).toBe("SET n = n[WHERE !($this IN $p0)]");
		expect(bindings).toEqual({ p0: [1, 2] });
	});

	test("$pull with a condition document on sub-documents", () => {
		const { clause, bindings } = translateUpdate({
			$pull: { items: { status: "old" } },
		});
		expect(clause).toBe("SET items = items[WHERE !($this.status = $p0)]");
		expect(bindings).toEqual({ p0: "old" });
	});

	test("$pull condition document with a nested operator", () => {
		const { clause, bindings } = translateUpdate({
			$pull: { results: { score: { $gte: 8 }, item: "B" } },
		});
		expect(clause).toBe(
			"SET results = results[WHERE !($this.score >= $p0 AND $this.item = $p1)]",
		);
		expect(bindings).toEqual({ p0: 8, p1: "B" });
	});

	test("$pull condition document escapes the element path", () => {
		const { clause } = translateUpdate({
			$pull: { items: { "a-b.c": 1 } },
		});
		expect(clause).toBe("SET items = items[WHERE !($this.`a-b`.c = $p0)]");
	});

	test("$pull throws on an unsupported predicate operator", () => {
		expect(() => translateUpdate({ $pull: { n: { $size: 1 } } })).toThrow(
			"Unsupported operator in $pull condition: $size",
		);
	});

	test("$pull throws when operators and field names are mixed", () => {
		expect(() => translateUpdate({ $pull: { n: { $gte: 1, s: 2 } } })).toThrow(
			"Cannot mix operators and field names in a $pull condition: $gte",
		);
	});

	// -----------------------------------------------------------------
	// $addToSet
	// -----------------------------------------------------------------
	// `?? []` is what lets $addToSet create the array when the field is
	// absent — `array::union` rejects NONE.
	test("$addToSet", () => {
		const { clause, bindings } = translateUpdate({
			$addToSet: { tags: "unique" },
		});
		expect(clause).toBe("SET tags = array::union(tags ?? [], [$p0])");
		expect(bindings).toEqual({ p0: "unique" });
	});

	// The modifier object used to be bound verbatim, so `$each` wrote
	// `{"$each": [...]}` into the array itself.
	test("$addToSet with $each unwraps the modifier", () => {
		const { clause, bindings } = translateUpdate({
			$addToSet: { tags: { $each: ["b", "c"] } },
		});
		expect(clause).toBe("SET tags = array::union(tags ?? [], $p0)");
		expect(bindings).toEqual({ p0: ["b", "c"] });
	});

	test("$addToSet adds an array operand as a single element", () => {
		const { clause, bindings } = translateUpdate({
			$addToSet: { tags: [1, 2] },
		});
		expect(clause).toBe("SET tags = array::union(tags ?? [], [$p0])");
		expect(bindings).toEqual({ p0: [1, 2] });
	});

	test("$addToSet throws when $each is not an array", () => {
		expect(() =>
			translateUpdate({ $addToSet: { tags: { $each: "b" } } }),
		).toThrow("The argument to $each in $addToSet must be an array");
	});

	test("$addToSet throws on an unrecognized clause alongside $each", () => {
		expect(() =>
			translateUpdate({ $addToSet: { tags: { $each: ["b"], $slice: 2 } } }),
		).toThrow("Unrecognized clause in $addToSet: $slice");
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

	test('$currentDate with {$type: "date"}', () => {
		const { clause, bindings } = translateUpdate({
			$currentDate: { updatedAt: { $type: "date" } },
		});
		expect(clause).toBe("SET updatedAt = time::now()");
		expect(bindings).toEqual({});
	});

	// "timestamp" means a BSON Timestamp, which has no SurrealDB equivalent.
	// The $type discriminator used to be dropped, silently producing a datetime.
	test('$currentDate with {$type: "timestamp"} throws', () => {
		expect(() =>
			translateUpdate({ $currentDate: { updatedAt: { $type: "timestamp" } } }),
		).toThrow("SurrealDB has no BSON Timestamp equivalent");
	});

	test("$currentDate throws on an invalid specification", () => {
		expect(() =>
			translateUpdate({ $currentDate: { updatedAt: false } }),
		).toThrow('must be true or {$type: "date"}');
		expect(() =>
			translateUpdate({ $currentDate: { updatedAt: { $type: "nope" } } }),
		).toThrow('must be true or {$type: "date"}');
	});

	// -----------------------------------------------------------------
	// $setOnInsert
	//
	// MongoDB applies $setOnInsert only when the operation actually inserts,
	// i.e. on an upsert that found nothing. It used to emit `f = f ?? $p`
	// unconditionally, so a plain update wrote the value onto an existing
	// document whenever the field happened to be absent.
	// -----------------------------------------------------------------
	test("$setOnInsert contributes nothing to a plain update", () => {
		const { clause, bindings } = translateUpdate({
			$setOnInsert: { status: "new" },
		});
		expect(clause).toBe("");
		expect(bindings).toEqual({});
	});

	test("$setOnInsert single field on the upsert path", () => {
		const { clause, bindings } = translateUpdate(
			{ $setOnInsert: { status: "new" } },
			0,
			{ upsert: true },
		);
		expect(clause).toBe("SET status = IF id IS NONE THEN $p0 ELSE status END");
		expect(bindings).toEqual({ p0: "new" });
	});

	test("$setOnInsert multiple fields on the upsert path", () => {
		const { clause, bindings } = translateUpdate(
			{ $setOnInsert: { status: "new", createdAt: "2024-01-01" } },
			0,
			{ upsert: true },
		);
		expect(clause).toBe(
			"SET status = IF id IS NONE THEN $p0 ELSE status END, createdAt = IF id IS NONE THEN $p1 ELSE createdAt END",
		);
		expect(bindings).toEqual({ p0: "new", p1: "2024-01-01" });
	});

	test("$setOnInsert combined with $set on the upsert path", () => {
		const { clause, bindings } = translateUpdate(
			{ $set: { name: "Jane" }, $setOnInsert: { status: "new" } },
			0,
			{ upsert: true },
		);
		expect(clause).toBe(
			"SET name = $p0, status = IF id IS NONE THEN $p1 ELSE status END",
		);
		expect(bindings).toEqual({ p0: "Jane", p1: "new" });
	});

	test("$setOnInsert is dropped from a plain update but $set survives", () => {
		const { clause, bindings } = translateUpdate({
			$set: { name: "Jane" },
			$setOnInsert: { status: "new" },
		});
		expect(clause).toBe("SET name = $p0");
		expect(bindings).toEqual({ p0: "Jane" });
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
