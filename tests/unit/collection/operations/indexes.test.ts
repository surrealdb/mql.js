import { describe, expect, test } from "bun:test";
import type { SurrealIndexInfo } from "../../../../src/collection/index-definition.ts";
import {
	createIndex,
	createIndexes,
	dropIndex,
	dropIndexes,
	indexExists,
	indexInformation,
	listIndexes,
} from "../../../../src/collection/operations/indexes.ts";
import {
	MongoCompatibilityError,
	MongoErrorCode,
	MongoInvalidArgumentError,
	MongoServerError,
} from "../../../../src/errors.ts";
import { V3Dialect } from "../../../../src/translators/dialect/index.ts";
import { FakeQueryExecutor } from "../../../helpers/fake-executor.ts";
import { makeContext } from "../../../helpers/operation-context.ts";

/** Program the next `INFO FOR TABLE … STRUCTURE` read. */
function serverIndexes(
	executor: FakeQueryExecutor,
	infos: SurrealIndexInfo[],
): void {
	executor.enqueue({ indexes: infos });
}

/** The `INFO FOR TABLE` read every index operation starts with. */
const INFO_SQL = "INFO FOR TABLE `users` STRUCTURE";

/** Metadata comment for an index this driver would have written. */
function meta(
	name: string,
	key: Record<string, unknown>,
	extra: Record<string, unknown> = {},
): string {
	return JSON.stringify({ mql: 1, name, key, ...extra });
}

describe("createIndex – SQL emitted", () => {
	test("reads the existing indexes, then defines the new one", async () => {
		const { ctx, executor } = makeContext();
		const name = await createIndex(ctx, { age: 1 });

		expect(name).toBe("age_1");
		expect(executor.queries.map((q) => q.sql)).toEqual([
			INFO_SQL,
			"DEFINE INDEX `age_1` ON `users` FIELDS `age` COMMENT $mqlIndexMeta",
		]);
		expect(executor.queries[1].bindings).toEqual({
			mqlIndexMeta: meta("age_1", { age: 1 }),
		});
	});

	test("descending direction uses MongoDB's `field_-1` name and is preserved", async () => {
		const { ctx, executor } = makeContext();
		const name = await createIndex(ctx, { age: -1 });

		expect(name).toBe("age_-1");
		expect(executor.queries[1].sql).toBe(
			"DEFINE INDEX `age_-1` ON `users` FIELDS `age` COMMENT $mqlIndexMeta",
		);
		// `-1` has nowhere to go in the DDL, so the metadata is what keeps it.
		expect(executor.queries[1].bindings).toEqual({
			mqlIndexMeta: meta("age_-1", { age: -1 }),
		});
	});

	test("compound index emits a comma-separated FIELDS list in key order", async () => {
		const { ctx, executor } = makeContext();
		const name = await createIndex(ctx, { a: 1, b: -1 });

		expect(name).toBe("a_1_b_-1");
		expect(executor.queries[1].sql).toBe(
			"DEFINE INDEX `a_1_b_-1` ON `users` FIELDS `a`, `b` COMMENT $mqlIndexMeta",
		);
	});

	test("unique index emits UNIQUE", async () => {
		const { ctx, executor } = makeContext();
		await createIndex(ctx, { email: 1 }, { unique: true });

		expect(executor.queries[1].sql).toBe(
			"DEFINE INDEX `email_1` ON `users` FIELDS `email` UNIQUE COMMENT $mqlIndexMeta",
		);
		expect(executor.queries[1].bindings).toEqual({
			mqlIndexMeta: meta("email_1", { email: 1 }, { unique: true }),
		});
	});

	test("explicit name overrides the generated one and is escaped", async () => {
		const { ctx, executor } = makeContext();
		const name = await createIndex(ctx, { age: 1 }, { name: "by age" });

		expect(name).toBe("by age");
		expect(executor.queries[1].sql).toBe(
			"DEFINE INDEX `by age` ON `users` FIELDS `age` COMMENT $mqlIndexMeta",
		);
	});

	test("nested field paths are escaped segment by segment", async () => {
		const { ctx, executor } = makeContext();
		await createIndex(ctx, { "profile.email": 1 });
		expect(executor.queries[1].sql).toContain("FIELDS `profile`.`email`");
	});

	test("_id is indexed as SurrealDB's `id` column", async () => {
		const { ctx, executor } = makeContext();
		await createIndex(ctx, { _id: 1, tenant: 1 });
		expect(executor.queries[1].sql).toBe(
			"DEFINE INDEX `_id_1_tenant_1` ON `users` FIELDS `id`, `tenant` COMMENT $mqlIndexMeta",
		);
	});

	test("a user comment travels in the metadata alongside the key", async () => {
		const { ctx, executor } = makeContext();
		await createIndex(ctx, { a: 1 }, { comment: "it's mine" });
		expect(executor.queries[1].bindings).toEqual({
			mqlIndexMeta: meta("a_1", { a: 1 }, { comment: "it's mine" }),
		});
	});

	test("the comment is bound, never spliced, so quotes cannot break out", async () => {
		const { ctx, executor } = makeContext();
		await createIndex(ctx, { a: 1 }, { comment: "' OR true --" });
		expect(executor.queries[1].sql).toContain("COMMENT $mqlIndexMeta");
		expect(executor.queries[1].sql).not.toContain("OR true");
	});
});

describe("createIndex – specification forms", () => {
	test("a bare field name means ascending", async () => {
		const { ctx } = makeContext();
		expect(await createIndex(ctx, "email")).toBe("email_1");
	});

	test("a list of field names becomes a compound ascending index", async () => {
		const { ctx, executor } = makeContext();
		expect(await createIndex(ctx, ["f", "g"])).toBe("f_1_g_1");
		expect(executor.queries[1].sql).toContain("FIELDS `f`, `g`");
	});

	test("a single [field, direction] tuple is one key, not two", async () => {
		const { ctx } = makeContext();
		expect(await createIndex(ctx, ["k", -1])).toBe("k_-1");
	});

	test("a list of tuples preserves order", async () => {
		const { ctx } = makeContext();
		expect(
			await createIndex(ctx, [
				["c", 1],
				["d", -1],
			]),
		).toBe("c_1_d_-1");
	});

	test("a Map is accepted and keeps its insertion order", async () => {
		const { ctx } = makeContext();
		const spec = new Map<string, 1 | -1>([
			["b", -1],
			["a", 1],
		]);
		expect(await createIndex(ctx, spec)).toBe("b_-1_a_1");
	});

	test("an empty specification is rejected", async () => {
		const { ctx, executor } = makeContext();
		await expect(createIndex(ctx, {})).rejects.toThrow(
			MongoInvalidArgumentError,
		);
		expect(executor.queries).toHaveLength(0);
	});
});

describe("createIndex – text indexes", () => {
	test("defines the blank analyzer, then a FULLTEXT index", async () => {
		const { ctx, executor } = makeContext({ dialect: new V3Dialect() });
		const name = await createIndex(ctx, { title: "text" });

		expect(name).toBe("title_text");
		expect(executor.queries.map((q) => q.sql)).toEqual([
			INFO_SQL,
			"DEFINE ANALYZER IF NOT EXISTS blank TOKENIZERS blank FILTERS lowercase",
			"DEFINE INDEX `title_text` ON `users` FIELDS `title` FULLTEXT ANALYZER blank BM25 HIGHLIGHTS COMMENT $mqlIndexMeta",
		]);
		expect(ctx.indexes.textFields).toEqual(["title"]);
	});

	// SurrealDB does not show a `DEFINE INDEX` an analyzer defined earlier in the
	// same transaction, so a text index created inside one would fail with "the
	// analyzer does not exist" if the prerequisite travelled with it. The analyzer
	// is a database-level `IF NOT EXISTS` definition shared by every text index, so
	// it goes to the connection while the index stays in the caller's transaction —
	// and is rolled back with it.
	test("the analyzer a caller's transaction needs is defined outside it", async () => {
		const connection = new FakeQueryExecutor();
		const { ctx, executor } = makeContext({
			dialect: new V3Dialect(),
			inTransaction: true,
			connection,
		});

		await createIndex(ctx, { title: "text" });

		expect(connection.queries.map((q) => q.sql)).toEqual([
			"DEFINE ANALYZER IF NOT EXISTS blank TOKENIZERS blank FILTERS lowercase",
		]);
		expect(executor.queries.map((q) => q.sql)).toEqual([
			INFO_SQL,
			"DEFINE INDEX `title_text` ON `users` FIELDS `title` FULLTEXT ANALYZER blank BM25 HIGHLIGHTS COMMENT $mqlIndexMeta",
		]);
	});

	test("a multi-field text index becomes one FULLTEXT index per field", async () => {
		const { ctx, executor } = makeContext({ dialect: new V3Dialect() });
		const name = await createIndex(ctx, { title: "text", body: "text" });

		// SurrealDB rejects FULLTEXT over more than one column, so the single
		// MongoDB index is implemented as one index per field, suffixed to keep
		// the SurrealDB names distinct.
		expect(name).toBe("title_text_body_text");
		const defines = executor.queries
			.map((q) => q.sql)
			.filter((sql) => sql.startsWith("DEFINE INDEX"));
		expect(defines).toEqual([
			"DEFINE INDEX `title_text_body_text_title` ON `users` FIELDS `title` FULLTEXT ANALYZER blank BM25 HIGHLIGHTS COMMENT $mqlIndexMeta",
			"DEFINE INDEX `title_text_body_text_body` ON `users` FIELDS `body` FULLTEXT ANALYZER blank BM25 HIGHLIGHTS COMMENT $mqlIndexMeta",
		]);
		expect(ctx.indexes.textFields).toEqual(["title", "body"]);
	});

	test("both parts carry the same MongoDB name in their metadata", async () => {
		const { ctx, executor } = makeContext({ dialect: new V3Dialect() });
		await createIndex(ctx, { title: "text", body: "text" }, { name: "ft" });

		const comments = executor.queries
			.filter((q) => q.bindings?.mqlIndexMeta)
			.map((q) => JSON.parse(q.bindings?.mqlIndexMeta as string).name);
		expect(comments).toEqual(["ft", "ft"]);
	});

	test("mixing a text field with an ordinary one is rejected", async () => {
		const { ctx, executor } = makeContext({ dialect: new V3Dialect() });
		await expect(createIndex(ctx, { title: "text", views: 1 })).rejects.toThrow(
			MongoCompatibilityError,
		);
		expect(executor.queries).toHaveLength(0);
	});
});

describe("createIndex – rejected options", () => {
	const rejected: readonly [string, Record<string, unknown>][] = [
		["expireAfterSeconds", { expireAfterSeconds: 60 }],
		["partialFilterExpression", { partialFilterExpression: { a: { $gt: 1 } } }],
		["collation", { collation: { locale: "en" } }],
		["weights", { weights: { a: 2 } }],
		["default_language", { default_language: "english" }],
		["language_override", { language_override: "lang" }],
		["wildcardProjection", { wildcardProjection: { a: 1 } }],
		["hidden", { hidden: true }],
		["sparse", { sparse: false }],
	];

	for (const [option, options] of rejected) {
		test(`${option} throws before any statement is sent`, async () => {
			const { ctx, executor } = makeContext();
			await expect(createIndex(ctx, { a: 1 }, options)).rejects.toThrow(
				MongoCompatibilityError,
			);
			await expect(createIndex(ctx, { a: 1 }, options)).rejects.toThrow(
				new RegExp(`'${option}'`),
			);
			expect(executor.queries).toHaveLength(0);
		});
	}

	test("hidden: false is the default and is accepted", async () => {
		const { ctx } = makeContext();
		expect(await createIndex(ctx, { a: 1 }, { hidden: false })).toBe("a_1");
	});

	test("sparse: true is honoured and reported in the metadata", async () => {
		const { ctx, executor } = makeContext();
		await createIndex(ctx, { a: 1 }, { sparse: true });
		expect(executor.queries[1].bindings).toEqual({
			mqlIndexMeta: meta("a_1", { a: 1 }, { sparse: true }),
		});
	});

	test("omitting sparse is accepted, so an ordinary createIndex never throws", async () => {
		const { ctx } = makeContext();
		expect(await createIndex(ctx, { a: 1 }, { unique: true })).toBe("a_1");
	});
});

describe("createIndex – accepted-but-ignored options", () => {
	const ignored: readonly [string, Record<string, unknown>][] = [
		["background", { background: true }],
		["version", { version: 2 }],
		["textIndexVersion", { textIndexVersion: 3 }],
		["2dsphereIndexVersion", { "2dsphereIndexVersion": 3 }],
		["commitQuorum", { commitQuorum: "votingMembers" }],
		["storageEngine", { storageEngine: { wiredTiger: {} } }],
		["bits", { bits: 26 }],
		["min", { min: -180 }],
		["max", { max: 180 }],
		["bucketSize", { bucketSize: 1 }],
	];

	for (const [option, options] of ignored) {
		test(`${option} is accepted and leaves the DDL unchanged`, async () => {
			const { ctx, executor } = makeContext();
			expect(await createIndex(ctx, { a: 1 }, options)).toBe("a_1");
			expect(executor.queries[1].sql).toBe(
				"DEFINE INDEX `a_1` ON `users` FIELDS `a` COMMENT $mqlIndexMeta",
			);
		});
	}
});

describe("createIndex – rejected index types", () => {
	for (const type of ["2d", "2dsphere", "geoHaystack", "hashed"] as const) {
		test(`'${type}' is rejected instead of creating an ordinary index`, async () => {
			const { ctx, executor } = makeContext();
			await expect(createIndex(ctx, { loc: type })).rejects.toThrow(
				MongoCompatibilityError,
			);
			expect(executor.queries).toHaveLength(0);
		});
	}

	test("an unrecognised direction is rejected", async () => {
		const { ctx } = makeContext();
		await expect(createIndex(ctx, { a: 7 })).rejects.toThrow(
			MongoInvalidArgumentError,
		);
	});

	test("a wildcard key is rejected", async () => {
		const { ctx } = makeContext();
		await expect(createIndex(ctx, { "$**": 1 })).rejects.toThrow(
			MongoCompatibilityError,
		);
	});
});

describe("createIndex – idempotency and conflicts", () => {
	test("re-creating an equivalent index is a no-op returning the name", async () => {
		const { ctx, executor } = makeContext();
		serverIndexes(executor, [
			{
				name: "age_1",
				cols: ["age"],
				index: "",
				comment: meta("age_1", { age: 1 }),
			},
		]);

		expect(await createIndex(ctx, { age: 1 })).toBe("age_1");
		expect(executor.queries.map((q) => q.sql)).toEqual([INFO_SQL]);
	});

	test("an equivalent unique index is also a no-op", async () => {
		const { ctx, executor } = makeContext();
		serverIndexes(executor, [
			{
				name: "email_1",
				cols: ["email"],
				index: "UNIQUE",
				comment: meta("email_1", { email: 1 }, { unique: true }),
			},
		]);

		expect(await createIndex(ctx, { email: 1 }, { unique: true })).toBe(
			"email_1",
		);
		expect(executor.queries).toHaveLength(1);
	});

	test("a different comment does not make the index non-equivalent", async () => {
		const { ctx, executor } = makeContext();
		serverIndexes(executor, [
			{
				name: "a_1",
				cols: ["a"],
				index: "",
				comment: meta("a_1", { a: 1 }, { comment: "old" }),
			},
		]);

		expect(await createIndex(ctx, { a: 1 }, { comment: "new" })).toBe("a_1");
		expect(executor.queries).toHaveLength(1);
	});

	test("the same name with a different key is IndexKeySpecsConflict (86)", async () => {
		const { ctx, executor } = makeContext();
		serverIndexes(executor, [
			{ name: "ix", cols: ["a"], index: "", comment: meta("ix", { a: 1 }) },
		]);

		const error = await createIndex(ctx, { b: 1 }, { name: "ix" }).catch(
			(e) => e,
		);
		expect(error).toBeInstanceOf(MongoServerError);
		expect(error.code).toBe(MongoErrorCode.IndexKeySpecsConflict);
		expect(error.codeName).toBe("IndexKeySpecsConflict");
		expect(error.message).toContain(
			"An existing index has the same name as the requested index",
		);
	});

	test("the same name with a different uniqueness is also a conflict", async () => {
		const { ctx, executor } = makeContext();
		serverIndexes(executor, [
			{ name: "a_1", cols: ["a"], index: "", comment: meta("a_1", { a: 1 }) },
		]);

		const error = await createIndex(ctx, { a: 1 }, { unique: true }).catch(
			(e) => e,
		);
		expect(error.code).toBe(MongoErrorCode.IndexKeySpecsConflict);
	});

	test("the same key under a different name is IndexOptionsConflict (85)", async () => {
		const { ctx, executor } = makeContext();
		serverIndexes(executor, [
			{ name: "a_1", cols: ["a"], index: "", comment: meta("a_1", { a: 1 }) },
		]);

		const error = await createIndex(ctx, { a: 1 }, { name: "other" }).catch(
			(e) => e,
		);
		expect(error.code).toBe(MongoErrorCode.IndexOptionsConflict);
		expect(error.message).toBe(
			"Index already exists with a different name: a_1",
		);
	});

	test("a reordered compound key is a different index, not an equivalent one", async () => {
		const { ctx, executor } = makeContext();
		serverIndexes(executor, [
			{
				name: "ix",
				cols: ["a", "b"],
				index: "",
				comment: meta("ix", { a: 1, b: 1 }),
			},
		]);

		const error = await createIndex(ctx, { b: 1, a: 1 }, { name: "ix" }).catch(
			(e) => e,
		);
		expect(error.code).toBe(MongoErrorCode.IndexKeySpecsConflict);
	});

	test("{_id: 1} creates nothing, matching the implicit index", async () => {
		const { ctx, executor } = makeContext();
		expect(await createIndex(ctx, { _id: 1 })).toBe("_id_1");
		expect(executor.queries).toHaveLength(0);
	});

	test("{_id: -1} is rejected the way MongoDB rejects it", async () => {
		const { ctx } = makeContext();
		await expect(createIndex(ctx, { _id: -1 })).rejects.toThrow(
			MongoInvalidArgumentError,
		);
	});

	test("the reserved name `_id_` cannot be claimed by another key", async () => {
		const { ctx } = makeContext();
		await expect(createIndex(ctx, { a: 1 }, { name: "_id_" })).rejects.toThrow(
			/reserved for the _id index/,
		);
	});

	test("a taken SurrealDB name is refused before any statement runs", async () => {
		// `z_body` is one of the two physical indexes `{title: 'text', body:
		// 'text'}` named `z` would define. Letting the run start would define
		// `z_title` and then fail, leaving an index whose metadata claims both
		// fields are searchable when only one is.
		const { ctx, executor } = makeContext();
		serverIndexes(executor, [
			{
				name: "z_body",
				cols: ["q"],
				index: "",
				comment: meta("z_body", { q: 1 }),
			},
		]);

		const error = await createIndex(
			ctx,
			{ title: "text", body: "text" },
			{ name: "z" },
		).catch((e) => e);
		expect(error.code).toBe(MongoErrorCode.IndexKeySpecsConflict);
		expect(executor.queries.map((q) => q.sql)).toEqual([INFO_SQL]);
	});
});

describe("createIndexes", () => {
	test("creates each index and returns the names in order", async () => {
		const { ctx, executor } = makeContext();
		const names = await createIndexes(ctx, [
			{ key: { m: 1 } },
			{ key: { n: -1 }, name: "custom" },
		]);

		expect(names).toEqual(["m_1", "custom"]);
		expect(
			executor.queries.filter((q) => q.sql.startsWith("DEFINE INDEX")),
		).toHaveLength(2);
	});

	test("per-index options win over the shared ones", async () => {
		const { ctx, executor } = makeContext();
		await createIndexes(ctx, [{ key: { a: 1 }, unique: false }], {
			unique: true,
		});
		expect(executor.queries[1].sql).not.toContain("UNIQUE");
	});

	test("an unsupported option in a later spec stops the whole batch", async () => {
		const { ctx, executor } = makeContext();
		await expect(
			createIndexes(ctx, [
				{ key: { a: 1 } },
				{ key: { b: 1 }, expireAfterSeconds: 60 },
			]),
		).rejects.toThrow(MongoCompatibilityError);
		expect(executor.queries).toHaveLength(0);
	});

	test("an empty batch is rejected", async () => {
		const { ctx } = makeContext();
		await expect(createIndexes(ctx, [])).rejects.toThrow(
			MongoInvalidArgumentError,
		);
	});
});

describe("dropIndex", () => {
	test("removes the index and reports the previous index count", async () => {
		const { ctx, executor } = makeContext();
		serverIndexes(executor, [
			{
				name: "age_1",
				cols: ["age"],
				index: "",
				comment: meta("age_1", { age: 1 }),
			},
		]);

		// `_id_` is always reported, so a table with one real index had two.
		expect(await dropIndex(ctx, "age_1")).toEqual({ nIndexesWas: 2, ok: 1 });
		expect(executor.queries[1].sql).toBe("REMOVE INDEX `age_1` ON `users`");
	});

	test("the index name is escaped rather than interpolated raw", async () => {
		const { ctx, executor } = makeContext();
		serverIndexes(executor, [{ name: "age_-1", cols: ["age"], index: "" }]);

		await dropIndex(ctx, "age_-1");
		expect(executor.queries[1].sql).toBe("REMOVE INDEX `age_-1` ON `users`");
	});

	test("a hostile index name cannot inject SurrealQL", async () => {
		const hostile = "x` ON users; REMOVE TABLE users; --";
		const { ctx, executor } = makeContext();
		serverIndexes(executor, [{ name: hostile, cols: ["a"], index: "" }]);

		await dropIndex(ctx, hostile);
		expect(executor.queries[1].sql).toBe(
			"REMOVE INDEX `x\\` ON users; REMOVE TABLE users; --` ON `users`",
		);
	});

	test("a missing index is IndexNotFound (27)", async () => {
		const { ctx, executor } = makeContext();
		const error = await dropIndex(ctx, "nope").catch((e) => e);

		expect(error).toBeInstanceOf(MongoServerError);
		expect(error.code).toBe(MongoErrorCode.IndexNotFound);
		expect(error.message).toBe("index not found with name [nope]");
		expect(executor.queries.map((q) => q.sql)).toEqual([INFO_SQL]);
	});

	test("`_id_` cannot be dropped", async () => {
		const { ctx } = makeContext();
		const error = await dropIndex(ctx, "_id_").catch((e) => e);
		expect(error.code).toBe(MongoErrorCode.InvalidOptions);
		expect(error.message).toBe("cannot drop _id index");
	});

	test("every part of a multi-field text index is removed", async () => {
		const { ctx, executor } = makeContext();
		serverIndexes(executor, [
			{
				name: "ft_title",
				cols: ["title"],
				index: "FULLTEXT ANALYZER blank",
				comment: meta("ft", { title: "text", body: "text" }),
			},
			{
				name: "ft_body",
				cols: ["body"],
				index: "FULLTEXT ANALYZER blank",
				comment: meta("ft", { title: "text", body: "text" }),
			},
		]);

		await dropIndex(ctx, "ft");
		expect(executor.queries.slice(1).map((q) => q.sql)).toEqual([
			"REMOVE INDEX `ft_title` ON `users`",
			"REMOVE INDEX `ft_body` ON `users`",
		]);
	});

	test("dropping a text index clears its `$text` fields", async () => {
		const { ctx, executor } = makeContext({ dialect: new V3Dialect() });
		await createIndex(ctx, { bio: "text" });
		expect(ctx.indexes.textFields).toEqual(["bio"]);

		serverIndexes(executor, [
			{
				name: "bio_text",
				cols: ["bio"],
				index: "FULLTEXT ANALYZER blank",
				comment: meta("bio_text", { bio: "text" }),
			},
		]);
		await dropIndex(ctx, "bio_text");
		expect(ctx.indexes.textFields).toEqual([]);
	});
});

describe("dropIndexes", () => {
	test("removes every index except the implicit `_id_`", async () => {
		const { ctx, executor } = makeContext();
		serverIndexes(executor, [
			{ name: "a_1", cols: ["a"], index: "" },
			{ name: "b_1", cols: ["b"], index: "" },
		]);

		expect(await dropIndexes(ctx)).toBe(true);
		expect(executor.queries.slice(1).map((q) => q.sql)).toEqual([
			"REMOVE INDEX `a_1` ON `users`",
			"REMOVE INDEX `b_1` ON `users`",
		]);
	});

	test("succeeds when there is nothing to drop", async () => {
		const { ctx, executor } = makeContext();
		expect(await dropIndexes(ctx)).toBe(true);
		expect(executor.queries.map((q) => q.sql)).toEqual([INFO_SQL]);
	});
});

describe("listIndexes", () => {
	test("reads from the server and always includes `_id_` first", async () => {
		const { ctx, executor } = makeContext();
		serverIndexes(executor, [
			{
				name: "age_1",
				cols: ["age"],
				index: "",
				comment: meta("age_1", { age: 1 }),
			},
		]);

		expect(await listIndexes(ctx)).toEqual([
			{ name: "_id_", key: { _id: 1 } },
			{ name: "age_1", key: { age: 1 } },
		]);
	});

	test("reports `_id_` alone for a table with no indexes", async () => {
		const { ctx } = makeContext();
		expect(await listIndexes(ctx)).toEqual([{ name: "_id_", key: { _id: 1 } }]);
	});

	test("the caller's original key is recovered from the metadata", async () => {
		const { ctx, executor } = makeContext();
		serverIndexes(executor, [
			{
				name: "a_1_b_-1",
				cols: ["a", "b"],
				index: "",
				comment: meta("a_1_b_-1", { a: 1, b: -1 }),
			},
		]);

		const [, description] = await listIndexes(ctx);
		expect(description.key).toEqual({ a: 1, b: -1 });
	});

	test("unique and sparse are reported", async () => {
		const { ctx, executor } = makeContext();
		serverIndexes(executor, [
			{
				name: "e_1",
				cols: ["email"],
				index: "UNIQUE",
				comment: meta("e_1", { email: 1 }, { unique: true, sparse: true }),
			},
		]);

		expect((await listIndexes(ctx))[1]).toEqual({
			name: "e_1",
			key: { email: 1 },
			unique: true,
			sparse: true,
		});
	});

	test("a multi-field text index is reported as one index", async () => {
		const { ctx, executor } = makeContext();
		serverIndexes(executor, [
			{
				name: "ft_title",
				cols: ["title"],
				index: "FULLTEXT ANALYZER blank",
				comment: meta("ft", { title: "text", body: "text" }),
			},
			{
				name: "ft_body",
				cols: ["body"],
				index: "FULLTEXT ANALYZER blank",
				comment: meta("ft", { title: "text", body: "text" }),
			},
		]);

		const descriptions = await listIndexes(ctx);
		expect(descriptions).toHaveLength(2);
		expect(descriptions[1]).toEqual({
			name: "ft",
			key: { title: "text", body: "text" },
		});
	});

	test("an index defined outside this driver is described from its columns", async () => {
		const { ctx, executor } = makeContext();
		serverIndexes(executor, [
			{ name: "hand_written", cols: ["a", "b"], index: "UNIQUE" },
			{ name: "ft", cols: ["bio"], index: "FULLTEXT ANALYZER blank BM25" },
		]);

		expect(await listIndexes(ctx)).toEqual([
			{ name: "_id_", key: { _id: 1 } },
			{ name: "hand_written", key: { a: 1, b: 1 }, unique: true },
			{ name: "ft", key: { bio: "text" } },
		]);
	});

	test("a foreign index on `id` is reported as `_id`", async () => {
		const { ctx, executor } = makeContext();
		serverIndexes(executor, [{ name: "by_id", cols: ["id"], index: "" }]);
		expect((await listIndexes(ctx))[1].key).toEqual({ _id: 1 });
	});

	test("a hand-written comment is passed through untouched", async () => {
		const { ctx, executor } = makeContext();
		serverIndexes(executor, [
			{ name: "ix", cols: ["a"], index: "", comment: "written by hand" },
		]);
		expect((await listIndexes(ctx))[1].comment).toBe("written by hand");
	});

	test("reading the listing refreshes the `$text` field cache", async () => {
		const { ctx, executor } = makeContext();
		serverIndexes(executor, [
			{
				name: "bio_text",
				cols: ["bio"],
				index: "FULLTEXT ANALYZER blank",
				comment: meta("bio_text", { bio: "text" }),
			},
		]);

		expect(ctx.indexes.textFields).toEqual([]);
		await listIndexes(ctx);
		expect(ctx.indexes.textFields).toEqual(["bio"]);
	});
});

describe("indexExists / indexInformation", () => {
	function existing(executor: FakeQueryExecutor): void {
		serverIndexes(executor, [
			{ name: "p_1", cols: ["p"], index: "", comment: meta("p_1", { p: 1 }) },
			{
				name: "q_-1",
				cols: ["q"],
				index: "",
				comment: meta("q_-1", { q: -1 }),
			},
		]);
	}

	test("indexExists is true only when every name is present", async () => {
		const a = makeContext();
		existing(a.executor);
		expect(await indexExists(a.ctx, "p_1")).toBe(true);

		const b = makeContext();
		existing(b.executor);
		expect(await indexExists(b.ctx, ["p_1", "nope"])).toBe(false);
	});

	test("indexExists recognises the implicit `_id_`", async () => {
		const { ctx } = makeContext();
		expect(await indexExists(ctx, "_id_")).toBe(true);
	});

	test("indexInformation returns the compact name → key-pairs mapping", async () => {
		const { ctx, executor } = makeContext();
		existing(executor);

		expect(await indexInformation(ctx)).toEqual({
			_id_: [["_id", 1]],
			p_1: [["p", 1]],
			"q_-1": [["q", -1]],
		});
	});

	test("indexInformation({full: true}) returns the descriptions", async () => {
		const { ctx, executor } = makeContext();
		existing(executor);

		expect(await indexInformation(ctx, true)).toEqual([
			{ name: "_id_", key: { _id: 1 } },
			{ name: "p_1", key: { p: 1 } },
			{ name: "q_-1", key: { q: -1 } },
		]);
	});
});
