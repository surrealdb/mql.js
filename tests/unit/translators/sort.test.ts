import { describe, expect, test } from "bun:test";
import { translateSort } from "../../../src/translators/sort.ts";

describe("translateSort", () => {
	test("null / undefined returns empty string", () => {
		expect(translateSort(null)).toBe("");
		expect(translateSort(undefined)).toBe("");
	});

	test("string shorthand", () => {
		expect(translateSort("name")).toBe("ORDER BY name ASC");
	});

	test("object with ascending", () => {
		expect(translateSort({ name: 1 })).toBe("ORDER BY name ASC");
	});

	test("object with descending", () => {
		expect(translateSort({ age: -1 })).toBe("ORDER BY age DESC");
	});

	test("object with multiple fields", () => {
		expect(translateSort({ name: 1, age: -1 })).toBe(
			"ORDER BY name ASC, age DESC",
		);
	});

	test("array of tuples", () => {
		expect(
			translateSort([
				["name", 1],
				["age", -1],
			]),
		).toBe("ORDER BY name ASC, age DESC");
	});

	test("string direction values", () => {
		expect(
			translateSort({ name: "asc", age: "desc" } as Record<
				string,
				1 | -1 | "asc" | "desc"
			>),
		).toBe("ORDER BY name ASC, age DESC");
	});

	test("empty object returns empty string", () => {
		expect(translateSort({})).toBe("");
	});
});
