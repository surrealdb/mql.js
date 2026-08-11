import { describe, expect, test } from "bun:test";
import {
	describeIndexes,
	encodeIndexMetadata,
	generateIndexName,
	resolveIndexDefinition,
	resolveIndexKey,
} from "../../../src/collection/index-definition.ts";

describe("resolveIndexKey", () => {
	test("accepts every specification form the official driver documents", () => {
		expect([...resolveIndexKey("e")]).toEqual([["e", 1]]);
		expect([...resolveIndexKey({ a: 1, b: -1 })]).toEqual([
			["a", 1],
			["b", -1],
		]);
		expect([...resolveIndexKey(["f", "g"])]).toEqual([
			["f", 1],
			["g", 1],
		]);
		expect([...resolveIndexKey(["k", -1])]).toEqual([["k", -1]]);
		expect([
			...resolveIndexKey([
				["c", 1],
				["d", -1],
			]),
		]).toEqual([
			["c", 1],
			["d", -1],
		]);
		expect([...resolveIndexKey([{ h: 1 }, { i: -1 }])]).toEqual([
			["h", 1],
			["i", -1],
		]);
		expect([...resolveIndexKey(new Map([["m", -1]]))]).toEqual([["m", -1]]);
	});

	test("a later entry wins for a repeated field", () => {
		expect([...resolveIndexKey([{ a: 1 }, { a: -1 }])]).toEqual([["a", -1]]);
	});

	test("column order survives an integer-like field name", () => {
		// Collecting into a plain object would hoist "2024" ahead of "tag" and
		// index the columns in the wrong order.
		expect([
			...resolveIndexKey([
				["tag", 1],
				["2024", -1],
			]),
		]).toEqual([
			["tag", 1],
			["2024", -1],
		]);
		expect([
			...resolveIndexKey(
				new Map<string, 1 | -1>([
					["tag", 1],
					["2024", -1],
				]),
			),
		]).toEqual([
			["tag", 1],
			["2024", -1],
		]);
	});

	test("['h', 'hashed'] is a two-field list, as in the official driver", () => {
		// `isIndexDirection` omits 'hashed' there, so the pair is not a tuple.
		expect([...resolveIndexKey(["h", "hashed"])]).toEqual([
			["h", 1],
			["hashed", 1],
		]);
	});
});

describe("generateIndexName", () => {
	test("uses MongoDB's field_direction convention", () => {
		expect(generateIndexName(resolveIndexKey({ age: 1 }))).toBe("age_1");
		expect(generateIndexName(resolveIndexKey({ age: -1 }))).toBe("age_-1");
		expect(generateIndexName(resolveIndexKey({ a: 1, b: -1 }))).toBe(
			"a_1_b_-1",
		);
		expect(generateIndexName(resolveIndexKey({ bio: "text" }))).toBe(
			"bio_text",
		);
	});
});

describe("index metadata", () => {
	test("round-trips through a description", () => {
		const definition = resolveIndexDefinition(
			{ a: 1, b: -1 },
			{ unique: true, sparse: true, comment: "why" },
		);
		const comment = encodeIndexMetadata(definition);

		const { descriptions } = describeIndexes([
			{ name: definition.name, cols: ["a", "b"], index: "UNIQUE", comment },
		]);

		expect(descriptions[1]).toEqual({
			name: "a_1_b_-1",
			key: { a: 1, b: -1 },
			unique: true,
			sparse: true,
			comment: "why",
		});
	});

	test("a comment containing quotes and newlines survives verbatim", () => {
		const comment = 'it\'s \\ "quoted"\nand multiline';
		const definition = resolveIndexDefinition({ a: 1 }, { comment });
		const { descriptions } = describeIndexes([
			{
				name: "a_1",
				cols: ["a"],
				index: "",
				comment: encodeIndexMetadata(definition),
			},
		]);
		expect(descriptions[1].comment).toBe(comment);
	});

	test("a non-JSON comment is treated as a hand-written one", () => {
		const { descriptions } = describeIndexes([
			{ name: "ix", cols: ["a"], index: "", comment: "not json {" },
		]);
		expect(descriptions[1]).toEqual({
			name: "ix",
			key: { a: 1 },
			comment: "not json {",
		});
	});

	test("JSON without the driver's marker is treated as a hand-written comment", () => {
		const comment = JSON.stringify({ key: { a: -1 } });
		const { descriptions } = describeIndexes([
			{ name: "ix", cols: ["a"], index: "", comment },
		]);
		// The key is inferred from the columns, not trusted from foreign JSON.
		expect(descriptions[1].key).toEqual({ a: 1 });
		expect(descriptions[1].comment).toBe(comment);
	});

	test("a future metadata version is not mis-parsed", () => {
		const comment = JSON.stringify({ mql: 99, name: "x", key: { a: -1 } });
		const { descriptions } = describeIndexes([
			{ name: "ix", cols: ["a"], index: "", comment },
		]);
		expect(descriptions[1].key).toEqual({ a: 1 });
	});

	test("metadata with an unusable key is not trusted for the name either", () => {
		for (const key of [null, "nope", [1, 2]]) {
			const comment = JSON.stringify({ mql: 1, name: "claimed", key });
			const { descriptions } = describeIndexes([
				{ name: "ix", cols: ["a"], index: "", comment },
			]);
			expect(descriptions[1]).toEqual({ name: "ix", key: { a: 1 }, comment });
		}
	});
});

describe("describeIndexes", () => {
	test("reports the implicit `_id_` index for an empty table", () => {
		expect(describeIndexes([]).descriptions).toEqual([
			{ name: "_id_", key: { _id: 1 } },
		]);
	});

	test("tags every SurrealDB index with the MongoDB index it implements", () => {
		const metadata = JSON.stringify({
			mql: 1,
			name: "ft",
			key: { a: "text", b: "text" },
		});
		const { physical } = describeIndexes([
			{ name: "ft_a", cols: ["a"], index: "FULLTEXT", comment: metadata },
			{ name: "ft_b", cols: ["b"], index: "FULLTEXT", comment: metadata },
			{ name: "plain", cols: ["c"], index: "" },
		]);

		expect(physical).toEqual([
			{ physicalName: "ft_a", name: "ft" },
			{ physicalName: "ft_b", name: "ft" },
			{ physicalName: "plain", name: "plain" },
		]);
	});

	test("an index claiming the `_id_` name does not displace or duplicate it", () => {
		const { descriptions, physical } = describeIndexes([
			{ name: "_id_", cols: ["weird"], index: "" },
			{ name: "other", cols: ["a"], index: "" },
		]);

		expect(descriptions).toEqual([
			{ name: "_id_", key: { _id: 1 } },
			{ name: "other", key: { a: 1 } },
		]);
		// Still physically present, so `dropIndexes` removes it.
		expect(physical).toContainEqual({ physicalName: "_id_", name: "_id_" });
	});
});

describe("resolveIndexDefinition", () => {
	test("carries the SurrealDB columns separately from the MongoDB key", () => {
		const definition = resolveIndexDefinition({ _id: 1, a: -1 });
		expect(definition.columns).toEqual(["id", "a"]);
		expect([...definition.key]).toEqual([
			["_id", 1],
			["a", -1],
		]);
	});

	test("classifies the SurrealDB index kind", () => {
		expect(resolveIndexDefinition({ a: 1 }).kind).toBe("btree");
		expect(resolveIndexDefinition({ a: "text" }).kind).toBe("fulltext");
	});
});
