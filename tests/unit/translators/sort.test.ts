import { describe, expect, test } from "bun:test";
import { MongoInvalidArgumentError } from "../../../src/errors.ts";
import { sortColumns, translateSort } from "../../../src/translators/sort.ts";
import type { SortDirection } from "../../../src/types/options.ts";
import type { Sort } from "../../../src/types.ts";

describe("translateSort", () => {
	test("null / undefined returns empty string", () => {
		expect(translateSort(null)).toBe("");
		expect(translateSort(undefined)).toBe("");
	});

	test("string shorthand", () => {
		expect(translateSort("name")).toBe("ORDER BY `name` ASC");
	});

	test("object with ascending", () => {
		expect(translateSort({ name: 1 })).toBe("ORDER BY `name` ASC");
	});

	test("object with descending", () => {
		expect(translateSort({ age: -1 })).toBe("ORDER BY `age` DESC");
	});

	test("object with multiple fields", () => {
		expect(translateSort({ name: 1, age: -1 })).toBe(
			"ORDER BY `name` ASC, `age` DESC",
		);
	});

	test("array of tuples", () => {
		expect(
			translateSort([
				["name", 1],
				["age", -1],
			]),
		).toBe("ORDER BY `name` ASC, `age` DESC");
	});

	test("string direction values", () => {
		expect(
			translateSort({ name: "asc", age: "desc" } as Record<
				string,
				1 | -1 | "asc" | "desc"
			>),
		).toBe("ORDER BY `name` ASC, `age` DESC");
	});

	test("empty object returns empty string", () => {
		expect(translateSort({})).toBe("");
	});

	// -----------------------------------------------------------------------
	// Direction normalisation. `'ascending'` used to fall through to DESC,
	// silently reversing the caller's order.
	// -----------------------------------------------------------------------

	test("long-form 'ascending' / 'descending' are honoured", () => {
		expect(translateSort({ name: "ascending" })).toBe("ORDER BY `name` ASC");
		expect(translateSort({ name: "descending" })).toBe("ORDER BY `name` DESC");
		expect(translateSort({ name: "ascending", age: "descending" })).toBe(
			"ORDER BY `name` ASC, `age` DESC",
		);
	});

	test("long-form directions work in the array-tuple form", () => {
		expect(
			translateSort([
				["name", "ascending"],
				["age", "descending"],
			]),
		).toBe("ORDER BY `name` ASC, `age` DESC");
	});

	test("numeric strings are accepted, as the official driver does", () => {
		// mongodb/lib/sort.js stringifies the direction before matching, so "1"
		// and "-1" are valid at runtime even though `SortDirection` omits them.
		expect(translateSort({ name: "1" as unknown as SortDirection })).toBe(
			"ORDER BY `name` ASC",
		);
		expect(translateSort({ name: "-1" as unknown as SortDirection })).toBe(
			"ORDER BY `name` DESC",
		);
	});

	test("direction matching is case-insensitive", () => {
		expect(translateSort({ name: "ASC" as unknown as SortDirection })).toBe(
			"ORDER BY `name` ASC",
		);
		expect(
			translateSort({ name: "Descending" as unknown as SortDirection }),
		).toBe("ORDER BY `name` DESC");
	});

	test("a missing direction defaults to ascending", () => {
		// `prepareDirection(direction = 1)` in the official driver.
		expect(translateSort({ name: undefined as unknown as SortDirection })).toBe(
			"ORDER BY `name` ASC",
		);
	});

	test("an unrecognised direction throws instead of sorting descending", () => {
		expect(() =>
			translateSort({ name: "sideways" as unknown as SortDirection }),
		).toThrow(MongoInvalidArgumentError);
		expect(() =>
			translateSort({ name: "sideways" as unknown as SortDirection }),
		).toThrow(/Invalid sort direction/);
		// `null` is not covered by the driver's default-parameter fallback.
		expect(() =>
			translateSort({ name: null as unknown as SortDirection }),
		).toThrow(MongoInvalidArgumentError);
		expect(() =>
			translateSort([["name", 2 as unknown as SortDirection]] as Sort),
		).toThrow(MongoInvalidArgumentError);
	});
});

describe("sortColumns", () => {
	/** Just the SurrealQL spellings, for the cases that are only about those. */
	const columns = (sort?: Sort | null) =>
		sortColumns(sort).map((column) => column.column);

	// SurrealDB refuses an `ORDER BY` naming an idiom the field list does not
	// carry, so every statement that projects its fields has to select these.
	test("nothing to order by yields no columns", () => {
		expect(sortColumns(null)).toEqual([]);
		expect(sortColumns(undefined)).toEqual([]);
		expect(sortColumns({})).toEqual([]);
	});

	test("reads the same three shapes the clause does", () => {
		expect(columns("name")).toEqual(["`name`"]);
		expect(columns({ name: 1, age: -1 })).toEqual(["`name`", "`age`"]);
		expect(
			columns([
				["name", 1],
				["age", -1],
			] as Sort),
		).toEqual(["`name`", "`age`"]);
	});

	test("`_id` becomes SurrealDB's `id` column", () => {
		expect(columns({ _id: 1 })).toEqual(["id"]);
	});

	test("paths and awkward names are escaped as idioms", () => {
		expect(columns({ "nested.d": -1 })).toEqual(["`nested`.`d`"]);
		expect(columns({ "weird field": 1 })).toEqual(["`weird field`"]);
	});

	test("a column named twice appears once", () => {
		expect(
			columns([
				["name", 1],
				["name", -1],
			] as Sort),
		).toEqual(["`name`"]);
	});

	/**
	 * The caller's spelling travels with the column because a sort the field list
	 * cannot carry is *reported*, and the report has to name `a.b` rather than
	 * this driver's `` `a`.`b` ``. Keeping the pair together is what stops the two
	 * from being assembled separately and drifting.
	 */
	test("each column carries the name the caller gave it", () => {
		expect(sortColumns({ "nested.d": -1 })).toEqual([
			{ key: "nested.d", column: "`nested`.`d`" },
		]);
		expect(sortColumns({ _id: 1 })).toEqual([{ key: "_id", column: "id" }]);
		expect(sortColumns("weird field")).toEqual([
			{ key: "weird field", column: "`weird field`" },
		]);
	});
});
