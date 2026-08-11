import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Collection, ObjectId } from "../../src/index.ts";
import {
	MongoCompatibilityError,
	MongoErrorCode,
	MongoServerError,
} from "../../src/index.ts";
import {
	type SurrealTestContext,
	setupSurreal,
	teardownSurreal,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// Test document shape
// ---------------------------------------------------------------------------

interface TestDoc {
	[key: string]: unknown;
	_id?: ObjectId | string | number;
	name?: string;
	age?: number;
	email?: string;
	bio?: string;
	title?: string;
	body?: string;
}

let ctx: SurrealTestContext<TestDoc>;
const PORT = 18739;

/** A collection nobody else touches, so index state is never shared. */
let counter = 0;
function fresh(prefix: string): Collection<TestDoc> {
	counter += 1;
	return ctx.collection(`${prefix}_${counter}`);
}

beforeAll(async () => {
	ctx = await setupSurreal<TestDoc>(PORT);
});

afterAll(async () => {
	await teardownSurreal(ctx);
});

// ---------------------------------------------------------------------------
// createIndex
// ---------------------------------------------------------------------------

describe("createIndex", () => {
	test("creates an index and returns MongoDB's generated name", async () => {
		const col = fresh("create");
		expect(await col.createIndex({ age: 1 })).toBe("age_1");
	});

	test("a descending key uses MongoDB's `field_-1` name and keeps its direction", async () => {
		const col = fresh("desc");
		expect(await col.createIndex({ age: -1 })).toBe("age_-1");

		const [, description] = await col.listIndexes().toArray();
		expect(description.name).toBe("age_-1");
		// SurrealDB B-tree indexes serve both directions, so `-1` is preserved as
		// metadata rather than dropped or rejected.
		expect(description.key).toEqual({ age: -1 });
	});

	test("a compound key keeps its column order", async () => {
		const col = fresh("compound");
		expect(await col.createIndex({ name: 1, age: -1 })).toBe("name_1_age_-1");

		const [, description] = await col.listIndexes().toArray();
		expect(description.key).toEqual({ name: 1, age: -1 });
	});

	test("an index name needing quoting round-trips", async () => {
		const col = fresh("quoted");
		const name = await col.createIndex({ age: 1 }, { name: "by age-desc" });
		expect(name).toBe("by age-desc");
		expect(await col.indexExists("by age-desc")).toBe(true);
	});

	test("a user comment survives alongside the driver's own metadata", async () => {
		const col = fresh("comment");
		await col.createIndex({ age: 1 }, { comment: "it's for reports" });

		const [, description] = await col.listIndexes().toArray();
		expect(description.comment).toBe("it's for reports");
		expect(description.key).toEqual({ age: 1 });
	});
});

// ---------------------------------------------------------------------------
// Idempotency and conflicts
// ---------------------------------------------------------------------------

describe("createIndex idempotency", () => {
	test("re-creating an identical index succeeds and returns the name", async () => {
		const col = fresh("idem");
		expect(await col.createIndex({ age: 1 })).toBe("age_1");
		expect(await col.createIndex({ age: 1 })).toBe("age_1");
		// The second call must not have defined a second index.
		expect(await col.listIndexes().toArray()).toHaveLength(2);
	});

	test("re-creating an identical unique index succeeds", async () => {
		const col = fresh("idem_unique");
		await col.createIndex({ email: 1 }, { unique: true });
		expect(await col.createIndex({ email: 1 }, { unique: true })).toBe(
			"email_1",
		);
	});

	test("a fresh Collection instance is idempotent too", async () => {
		const name = `idem_fresh_${++counter}`;
		await ctx.collection(name).createIndex({ age: 1 });
		// A second `db.collection()` call is a new object with no memory of the
		// first, which is exactly the case that used to throw.
		expect(await ctx.collection(name).createIndex({ age: 1 })).toBe("age_1");
	});

	test("the same name with a different key is IndexKeySpecsConflict (86)", async () => {
		const col = fresh("conflict");
		await col.createIndex({ age: 1 }, { name: "ix" });

		const error = await col
			.createIndex({ name: 1 }, { name: "ix" })
			.catch((e) => e);
		expect(error).toBeInstanceOf(MongoServerError);
		expect(error.code).toBe(MongoErrorCode.IndexKeySpecsConflict);
		expect(error.message).toContain(
			"An existing index has the same name as the requested index",
		);
	});

	test("adding uniqueness to an existing index is a conflict, not a silent no-op", async () => {
		const col = fresh("conflict_unique");
		await col.createIndex({ email: 1 });
		const error = await col
			.createIndex({ email: 1 }, { unique: true })
			.catch((e) => e);
		expect(error.code).toBe(MongoErrorCode.IndexKeySpecsConflict);
	});

	test("the same key under a different name is IndexOptionsConflict (85)", async () => {
		const col = fresh("conflict_name");
		await col.createIndex({ age: 1 });
		const error = await col
			.createIndex({ age: 1 }, { name: "other" })
			.catch((e) => e);
		expect(error.code).toBe(MongoErrorCode.IndexOptionsConflict);
	});
});

// ---------------------------------------------------------------------------
// unique
// ---------------------------------------------------------------------------

describe("unique indexes", () => {
	test("a duplicate is rejected as E11000 with keyPattern and keyValue", async () => {
		const col = fresh("unique");
		await col.createIndex({ email: 1 }, { unique: true });
		await col.insertOne({ email: "a@b.c" });

		const error = await col.insertOne({ email: "a@b.c" }).catch((e) => e);
		expect(error).toBeInstanceOf(MongoServerError);
		expect(error.code).toBe(MongoErrorCode.DuplicateKey);
		expect(error.message).toContain("E11000 duplicate key error");
		expect(error.keyPattern).toEqual({ email: 1 });
		expect(error.keyValue).toEqual({ email: "a@b.c" });
	});

	test("a compound unique index reports every colliding field", async () => {
		const col = fresh("unique_compound");
		await col.createIndex({ name: 1, age: 1 }, { unique: true });
		await col.insertOne({ name: "Alice", age: 30 });

		const error = await col
			.insertOne({ name: "Alice", age: 30 })
			.catch((e) => e);
		expect(error.code).toBe(MongoErrorCode.DuplicateKey);
		expect(error.keyPattern).toEqual({ name: 1, age: 1 });
		expect(error.keyValue).toEqual({ name: "Alice", age: 30 });
	});

	test("a descending unique index reports its real direction", async () => {
		// Verified against a real mongod: keyPattern carries the index's own
		// direction, so `{age: -1}` must not come back as `{age: 1}`.
		const col = fresh("unique_desc");
		await col.createIndex({ age: -1 }, { unique: true });
		await col.insertOne({ age: 7 });

		const error = await col.insertOne({ age: 7 }).catch((e) => e);
		expect(error.code).toBe(MongoErrorCode.DuplicateKey);
		expect(error.keyPattern).toEqual({ age: -1 });
		expect(error.keyValue).toEqual({ age: 7 });
	});

	test("a non-conflicting value still inserts", async () => {
		const col = fresh("unique_ok");
		await col.createIndex({ email: 1 }, { unique: true });
		await col.insertOne({ email: "a@b.c" });
		await col.insertOne({ email: "d@e.f" });
		expect(await col.countDocuments()).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// listIndexes
// ---------------------------------------------------------------------------

describe("listIndexes", () => {
	test("reports `_id_` even for a collection with no indexes of its own", async () => {
		const col = fresh("only_id");
		expect(await col.listIndexes().toArray()).toEqual([
			{ name: "_id_", key: { _id: 1 } },
		]);
	});

	test("indexes are visible from a fresh Collection instance", async () => {
		const name = `list_fresh_${++counter}`;
		await ctx.collection(name).createIndex({ age: 1 });
		await ctx.collection(name).createIndex({ name: 1 }, { name: "name_idx" });

		const descriptions = await ctx.collection(name).listIndexes().toArray();
		expect(descriptions.map((d) => d.name).sort()).toEqual([
			"_id_",
			"age_1",
			"name_idx",
		]);
	});

	test("`_id_` is reported first", async () => {
		const col = fresh("id_first");
		await col.createIndex({ age: 1 });
		const descriptions = await col.listIndexes().toArray();
		expect(descriptions[0]).toEqual({ name: "_id_", key: { _id: 1 } });
	});

	test("unique is reported back", async () => {
		const col = fresh("list_unique");
		await col.createIndex({ email: 1 }, { unique: true });
		const [, description] = await col.listIndexes().toArray();
		expect(description.unique).toBe(true);
	});

	test("the cursor supports next/hasNext/close and async iteration", async () => {
		const col = fresh("cursor");
		await col.createIndex({ age: 1 });

		const cursor = col.listIndexes();
		expect(await cursor.hasNext()).toBe(true);
		expect((await cursor.next())?.name).toBe("_id_");
		expect((await cursor.next())?.name).toBe("age_1");
		expect(await cursor.next()).toBeNull();
		await cursor.close();
		expect(cursor.closed).toBe(true);

		const names: string[] = [];
		for await (const description of col.listIndexes()) {
			names.push(description.name);
		}
		expect(names).toEqual(["_id_", "age_1"]);
	});

	test("an index defined directly in SurrealQL is still reported", async () => {
		const col = fresh("foreign");
		await ctx.client._executor.query(
			`DEFINE INDEX hand ON ${col.collectionName} FIELDS age`,
		);
		const [, description] = await col.listIndexes().toArray();
		expect(description).toEqual({ name: "hand", key: { age: 1 } });
	});

	test("a SurrealQL index claiming the `_id_` name does not displace it", async () => {
		const col = fresh("foreign_id");
		await ctx.client._executor.query(
			`DEFINE INDEX \`_id_\` ON ${col.collectionName} FIELDS age`,
		);

		expect(await col.listIndexes().toArray()).toEqual([
			{ name: "_id_", key: { _id: 1 } },
		]);
		expect(await col.indexInformation()).toEqual({ _id_: [["_id", 1]] });
	});
});

// ---------------------------------------------------------------------------
// dropIndex / dropIndexes
// ---------------------------------------------------------------------------

describe("dropIndex", () => {
	test("removes the index and reports the previous count", async () => {
		const col = fresh("drop");
		await col.createIndex({ age: 1 });

		expect(await col.dropIndex("age_1")).toEqual({ nIndexesWas: 2, ok: 1 });
		expect(await col.listIndexes().toArray()).toHaveLength(1);
	});

	test("a name needing quoting can be dropped", async () => {
		const col = fresh("drop_quoted");
		await col.createIndex({ age: -1 });
		await col.dropIndex("age_-1");
		expect(await col.indexExists("age_-1")).toBe(false);
	});

	test("a missing index is IndexNotFound (27)", async () => {
		const col = fresh("drop_missing");
		const error = await col.dropIndex("nope").catch((e) => e);
		expect(error).toBeInstanceOf(MongoServerError);
		expect(error.code).toBe(MongoErrorCode.IndexNotFound);
		expect(error.message).toBe("index not found with name [nope]");
	});

	test("`_id_` cannot be dropped", async () => {
		const col = fresh("drop_id");
		const error = await col.dropIndex("_id_").catch((e) => e);
		expect(error.code).toBe(MongoErrorCode.InvalidOptions);
	});

	test("dropIndexes leaves only `_id_`", async () => {
		const col = fresh("drop_all");
		await col.createIndex({ age: 1 });
		await col.createIndex({ name: 1 });

		expect(await col.dropIndexes()).toBe(true);
		expect(await col.listIndexes().toArray()).toEqual([
			{ name: "_id_", key: { _id: 1 } },
		]);
	});

	test("a dropped unique index stops rejecting duplicates", async () => {
		const col = fresh("drop_unique");
		await col.createIndex({ email: 1 }, { unique: true });
		await col.insertOne({ email: "a@b.c" });
		await col.dropIndex("email_1");
		await col.insertOne({ email: "a@b.c" });
		expect(await col.countDocuments()).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// createIndexes / indexes / indexExists / indexInformation
// ---------------------------------------------------------------------------

describe("plural and query methods", () => {
	test("createIndexes defines each index and returns the names", async () => {
		const col = fresh("plural");
		expect(
			await col.createIndexes([
				{ key: { age: 1 } },
				{ key: { name: -1 }, name: "custom" },
				{ key: { email: 1 }, unique: true },
			]),
		).toEqual(["age_1", "custom", "email_1"]);
	});

	test("createIndexes is idempotent for an identical batch", async () => {
		const col = fresh("plural_idem");
		await col.createIndexes([{ key: { age: 1 } }]);
		expect(await col.createIndexes([{ key: { age: 1 } }])).toEqual(["age_1"]);
	});

	test("indexes() returns the same descriptions as the cursor", async () => {
		const col = fresh("indexes_method");
		await col.createIndex({ age: 1 });
		expect(await col.indexes()).toEqual(await col.listIndexes().toArray());
	});

	test("indexExists answers for one name and for many", async () => {
		const col = fresh("exists");
		await col.createIndex({ age: 1 });

		expect(await col.indexExists("age_1")).toBe(true);
		expect(await col.indexExists("_id_")).toBe(true);
		expect(await col.indexExists("nope")).toBe(false);
		expect(await col.indexExists(["age_1", "_id_"])).toBe(true);
		expect(await col.indexExists(["age_1", "nope"])).toBe(false);
	});

	test("indexInformation returns the compact mapping by default", async () => {
		const col = fresh("info");
		await col.createIndex({ age: -1 });
		await col.createIndex({ name: 1, email: 1 });

		expect(await col.indexInformation()).toEqual({
			_id_: [["_id", 1]],
			"age_-1": [["age", -1]],
			name_1_email_1: [
				["name", 1],
				["email", 1],
			],
		});
	});

	test("indexInformation({full: true}) returns the descriptions", async () => {
		const col = fresh("info_full");
		await col.createIndex({ age: 1 });
		expect(await col.indexInformation({ full: true })).toEqual(
			await col.indexes(),
		);
	});

	// `indexes` and `indexInformation` default `full` opposite ways round in the
	// official driver, so the two are each other's inverse rather than aliases.
	test("indexes() defaults to the full descriptions", async () => {
		const col = fresh("ix_full_default");
		await col.createIndex({ age: -1 });
		const descriptions = await col.indexes();
		expect(Array.isArray(descriptions)).toBe(true);
		expect(descriptions).toEqual(await col.indexes({ full: true }));
		expect(descriptions.find((d) => d.name === "age_-1")?.key).toEqual({
			age: -1,
		});
	});

	test("indexes({full: false}) returns the compact mapping", async () => {
		const col = fresh("ix_compact");
		await col.createIndex({ age: -1 });
		expect(await col.indexes({ full: false })).toEqual(
			await col.indexInformation(),
		);
		expect(await col.indexes({ full: false })).toEqual({
			_id_: [["_id", 1]],
			"age_-1": [["age", -1]],
		});
	});
});

// ---------------------------------------------------------------------------
// Rejected options and index types
// ---------------------------------------------------------------------------

describe("unsupported options", () => {
	const rejected: readonly [string, Record<string, unknown>][] = [
		["expireAfterSeconds", { expireAfterSeconds: 60 }],
		[
			"partialFilterExpression",
			{ partialFilterExpression: { age: { $gt: 1 } } },
		],
		["collation", { collation: { locale: "en" } }],
		["weights", { weights: { bio: 2 } }],
		["default_language", { default_language: "english" }],
		["language_override", { language_override: "lang" }],
		["wildcardProjection", { wildcardProjection: { age: 1 } }],
		["hidden", { hidden: true }],
		["sparse: false", { sparse: false }],
	];

	for (const [label, options] of rejected) {
		test(`${label} is rejected rather than ignored`, async () => {
			const col = fresh("reject");
			await expect(col.createIndex({ age: 1 }, options)).rejects.toThrow(
				MongoCompatibilityError,
			);
			// Nothing may have been defined on the way to the rejection.
			expect(await col.listIndexes().toArray()).toHaveLength(1);
		});
	}

	for (const type of ["2d", "2dsphere", "geoHaystack", "hashed"] as const) {
		test(`the '${type}' index type is rejected`, async () => {
			const col = fresh("reject_type");
			await expect(col.createIndex({ loc: type })).rejects.toThrow(
				MongoCompatibilityError,
			);
		});
	}

	test("ignored options still produce a working index", async () => {
		const col = fresh("ignored");
		expect(
			await col.createIndex(
				{ age: 1 },
				{ background: true, version: 2, storageEngine: {}, commitQuorum: 1 },
			),
		).toBe("age_1");
		expect(await col.indexExists("age_1")).toBe(true);
	});

	test("omitting sparse is accepted, so a plain unique index works", async () => {
		const col = fresh("sparse_default");
		expect(await col.createIndex({ email: 1 }, { unique: true })).toBe(
			"email_1",
		);
	});

	test("sparse: true is honoured and reported", async () => {
		const col = fresh("sparse_true");
		await col.createIndex({ email: 1 }, { unique: true, sparse: true });
		const [, description] = await col.listIndexes().toArray();
		expect(description.sparse).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Text indexes and $text
// ---------------------------------------------------------------------------

describe("text indexes", () => {
	test("a single-field text index reports its key as text", async () => {
		const col = fresh("text_one");
		expect(await col.createIndex({ bio: "text" })).toBe("bio_text");

		const [, description] = await col.listIndexes().toArray();
		expect(description).toEqual({ name: "bio_text", key: { bio: "text" } });
	});

	test("a multi-field text index is reported as one MongoDB index", async () => {
		const col = fresh("text_many");
		const name = await col.createIndex({ title: "text", body: "text" });

		const descriptions = await col.listIndexes().toArray();
		expect(descriptions).toHaveLength(2);
		expect(descriptions[1]).toEqual({
			name,
			key: { title: "text", body: "text" },
		});
	});

	test("mixing a text field with an ordinary one is rejected", async () => {
		const col = fresh("text_mixed");
		await expect(col.createIndex({ title: "text", age: 1 })).rejects.toThrow(
			MongoCompatibilityError,
		);
	});

	test("$text searches a single indexed field", async () => {
		const col = fresh("text_search");
		await col.createIndex({ bio: "text" });
		await col.insertMany([
			{ name: "Alice", bio: "software engineer at a tech company" },
			{ name: "Bob", bio: "data scientist working on machine learning" },
		]);

		const results = await col
			.find({ $text: { $search: "software" } })
			.toArray();
		expect(results.map((r) => r.name)).toEqual(["Alice"]);
	});

	test("$text searches every field of a multi-field text index", async () => {
		const col = fresh("text_search_many");
		await col.createIndex({ title: "text", body: "text" });
		await col.insertMany([
			{ name: "Alice", title: "surreal", body: "nothing here" },
			{ name: "Bob", title: "nothing here", body: "surreal" },
			{ name: "Carol", title: "unrelated", body: "unrelated" },
		]);

		const results = await col.find({ $text: { $search: "surreal" } }).toArray();
		expect(results.map((r) => r.name).sort()).toEqual(["Alice", "Bob"]);
	});

	test("$text works from a fresh Collection instance", async () => {
		const name = `text_fresh_${++counter}`;
		await ctx.collection(name).createIndex({ bio: "text" });
		await ctx.collection(name).insertOne({ name: "Alice", bio: "surreal" });

		// A new `Collection` object knows nothing about the index until it reads
		// the definitions back from the server.
		const results = await ctx
			.collection(name)
			.find({ $text: { $search: "surreal" } })
			.toArray();
		expect(results.map((r) => r.name)).toEqual(["Alice"]);
	});

	test("the `_textFields` compatibility shim reports the indexed fields", async () => {
		const col = fresh("text_shim");
		await col.createIndex({ title: "text", body: "text" });
		expect(col._textFields).toEqual(["title", "body"]);
	});

	test("a name colliding with a part leaves nothing half-defined", async () => {
		// A multi-field text index called `z` occupies `z_title` and `z_body`. If
		// one of those names is taken, defining the rest would leave an index whose
		// metadata claims both fields are searchable when only one is — and the
		// retry would then find that index equivalent and succeed as a no-op.
		const col = fresh("text_collision");
		await col.createIndex({ age: 1 }, { name: "z_body" });

		const error = await col
			.createIndex({ title: "text", body: "text" }, { name: "z" })
			.catch((e) => e);
		expect(error.code).toBe(MongoErrorCode.IndexKeySpecsConflict);
		expect((await col.listIndexes().toArray()).map((d) => d.name)).toEqual([
			"_id_",
			"z_body",
		]);
	});

	test("dropping a multi-field text index removes every part", async () => {
		const col = fresh("text_drop");
		const name = await col.createIndex({ title: "text", body: "text" });
		await col.dropIndex(name);
		expect(await col.listIndexes().toArray()).toHaveLength(1);
	});
});
