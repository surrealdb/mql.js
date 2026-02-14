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
		expect(clause).toBe("SET price *= $p0");
		expect(bindings).toEqual({ p0: 1.1 });
	});

	// -----------------------------------------------------------------
	// $min / $max
	// -----------------------------------------------------------------
	test("$min", () => {
		const { clause, bindings } = translateUpdate({ $min: { low: 5 } });
		expect(clause).toBe("SET low = math::min(low, $p0)");
		expect(bindings).toEqual({ p0: 5 });
	});

	test("$max", () => {
		const { clause, bindings } = translateUpdate({ $max: { high: 100 } });
		expect(clause).toBe("SET high = math::max(high, $p0)");
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
