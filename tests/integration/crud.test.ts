import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Subprocess } from "bun";
import type { Collection, Db } from "../../src/index.ts";
import { MongoClient, ObjectId } from "../../src/index.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface TestDoc {
	[key: string]: unknown;
	_id?: ObjectId | string | number;
	name: string;
	age?: number;
	email?: string;
	tags?: string[];
	active?: boolean;
	score?: number;
	address?: { city: string; zip?: string };
}

let surrealProcess: Subprocess;
let client: MongoClient;
let db: Db;
let col: Collection<TestDoc>;
const PORT = 18734; // Use a high port to avoid conflicts

async function waitForSurreal(port: number, timeoutMs = 10000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const resp = await fetch(`http://127.0.0.1:${port}/health`);
			if (resp.ok) return;
		} catch {
			// Not ready yet
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`SurrealDB did not start within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
	// Start SurrealDB in-memory
	surrealProcess = Bun.spawn(
		[
			"surreal",
			"start",
			"--bind",
			`127.0.0.1:${PORT}`,
			"--username",
			"root",
			"--password",
			"root",
			"memory",
		],
		{ stdout: "ignore", stderr: "ignore" },
	);

	await waitForSurreal(PORT);

	client = new MongoClient(
		`mongodb://root:root@127.0.0.1:${PORT}/testdb?namespace=test`,
	);
	await client.connect();
	db = client.db("testdb");
});

afterAll(async () => {
	await client.close();
	surrealProcess.kill();
});

beforeEach(async () => {
	// Clean the collection before each test
	col = db.collection<TestDoc>("users");
	try {
		await col.deleteMany({});
	} catch {
		// Ignore if collection doesn't exist yet
	}
});

// ---------------------------------------------------------------------------
// INSERT
// ---------------------------------------------------------------------------

describe("insertOne", () => {
	test("inserts a document and returns insertedId", async () => {
		const result = await col.insertOne({ name: "Alice", age: 30 });
		expect(result.acknowledged).toBe(true);
		expect(result.insertedId).toBeDefined();
		expect(ObjectId.isValid(result.insertedId)).toBe(true);
	});

	test("inserts with custom _id", async () => {
		const customId = new ObjectId();
		const result = await col.insertOne({
			_id: customId,
			name: "Bob",
			age: 25,
		});
		expect(result.insertedId).toEqual(customId);
	});

	test("inserted document is retrievable", async () => {
		await col.insertOne({ name: "Charlie", age: 35 });
		const found = await col.findOne({ name: "Charlie" });
		expect(found).not.toBeNull();
		expect(found?.name).toBe("Charlie");
		expect(found?.age).toBe(35);
		expect(found?._id).toBeDefined();
	});
});

describe("insertMany", () => {
	test("inserts multiple documents", async () => {
		const result = await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
			{ name: "Charlie", age: 35 },
		]);
		expect(result.acknowledged).toBe(true);
		expect(result.insertedCount).toBe(3);
		expect(Object.keys(result.insertedIds)).toHaveLength(3);
	});

	test("all inserted documents are retrievable", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
		]);
		const all = await col.find({}).toArray();
		expect(all).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// FIND
// ---------------------------------------------------------------------------

describe("findOne", () => {
	test("returns null for no match", async () => {
		const result = await col.findOne({ name: "Nobody" });
		expect(result).toBeNull();
	});

	test("finds by simple equality", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
		]);
		const result = await col.findOne({ name: "Bob" });
		expect(result).not.toBeNull();
		expect(result?.name).toBe("Bob");
		expect(result?.age).toBe(25);
	});

	test("returns _id as ObjectId", async () => {
		await col.insertOne({ name: "Alice", age: 30 });
		const result = await col.findOne({ name: "Alice" });
		expect(result?._id).toBeDefined();
		expect(result?._id instanceof ObjectId).toBe(true);
	});
});

describe("find (cursor)", () => {
	test("toArray returns all matches", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
			{ name: "Charlie", age: 35 },
		]);
		const results = await col.find({}).toArray();
		expect(results).toHaveLength(3);
	});

	test("filter works with comparison operators", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
			{ name: "Charlie", age: 35 },
		]);
		const results = await col.find({ age: { $gt: 28 } }).toArray();
		expect(results).toHaveLength(2);
		expect(results.map((r) => r.name).sort()).toEqual(["Alice", "Charlie"]);
	});

	test("sort ascending", async () => {
		await col.insertMany([
			{ name: "Charlie", age: 35 },
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
		]);
		const results = await col.find({}).sort({ age: 1 }).toArray();
		expect(results.map((r) => r.name)).toEqual(["Bob", "Alice", "Charlie"]);
	});

	test("sort descending", async () => {
		await col.insertMany([
			{ name: "Charlie", age: 35 },
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
		]);
		const results = await col.find({}).sort({ age: -1 }).toArray();
		expect(results.map((r) => r.name)).toEqual(["Charlie", "Alice", "Bob"]);
	});

	test("limit", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
			{ name: "Charlie", age: 35 },
		]);
		const results = await col.find({}).sort({ age: 1 }).limit(2).toArray();
		expect(results).toHaveLength(2);
	});

	test("skip", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
			{ name: "Charlie", age: 35 },
		]);
		const results = await col.find({}).sort({ age: 1 }).skip(1).toArray();
		expect(results).toHaveLength(2);
		expect(results[0].name).toBe("Alice");
	});

	test("next() iterates sequentially", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
		]);
		const cursor = col.find({}).sort({ age: 1 });
		const first = await cursor.next();
		expect(first?.name).toBe("Bob");
		const second = await cursor.next();
		expect(second?.name).toBe("Alice");
		const third = await cursor.next();
		expect(third).toBeNull();
	});

	test("async iteration", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
		]);
		const names: string[] = [];
		for await (const doc of col.find({}).sort({ age: 1 })) {
			names.push(doc.name);
		}
		expect(names).toEqual(["Bob", "Alice"]);
	});

	test("forEach", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
		]);
		const names: string[] = [];
		await col
			.find({})
			.sort({ age: 1 })
			.forEach((doc) => {
				names.push(doc.name);
			});
		expect(names).toEqual(["Bob", "Alice"]);
	});
});

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

describe("updateOne", () => {
	test("$set updates a single document", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
		]);
		const result = await col.updateOne(
			{ name: "Alice" },
			{ $set: { age: 31 } },
		);
		expect(result.acknowledged).toBe(true);
		expect(result.matchedCount).toBe(1);
		expect(result.modifiedCount).toBe(1);

		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.age).toBe(31);
	});

	test("$inc increments a field", async () => {
		await col.insertOne({ name: "Alice", age: 30, score: 100 });
		await col.updateOne({ name: "Alice" }, { $inc: { score: 10 } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.score).toBe(110);
	});

	test("$unset removes a field", async () => {
		await col.insertOne({ name: "Alice", age: 30, email: "a@b.com" });
		await col.updateOne({ name: "Alice" }, { $unset: { email: "" } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.email).toBeUndefined();
	});
});

describe("updateMany", () => {
	test("updates multiple documents", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30, active: false },
			{ name: "Bob", age: 25, active: false },
			{ name: "Charlie", age: 35, active: true },
		]);
		const result = await col.updateMany(
			{ active: false },
			{ $set: { active: true } },
		);
		expect(result.matchedCount).toBe(2);

		const allActive = await col.find({ active: true }).toArray();
		expect(allActive).toHaveLength(3);
	});
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

describe("deleteOne", () => {
	test("deletes a single document", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
		]);
		const result = await col.deleteOne({ name: "Alice" });
		expect(result.acknowledged).toBe(true);
		expect(result.deletedCount).toBe(1);

		const remaining = await col.find({}).toArray();
		expect(remaining).toHaveLength(1);
		expect(remaining[0].name).toBe("Bob");
	});

	test("returns 0 when no match", async () => {
		const result = await col.deleteOne({ name: "Nobody" });
		expect(result.deletedCount).toBe(0);
	});
});

describe("deleteMany", () => {
	test("deletes multiple documents", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
			{ name: "Charlie", age: 35 },
		]);
		const result = await col.deleteMany({ age: { $gte: 30 } });
		expect(result.deletedCount).toBe(2);

		const remaining = await col.find({}).toArray();
		expect(remaining).toHaveLength(1);
	});

	test("empty filter deletes all", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
		]);
		const result = await col.deleteMany({});
		expect(result.deletedCount).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// REPLACE
// ---------------------------------------------------------------------------

describe("replaceOne", () => {
	test("replaces document content", async () => {
		await col.insertOne({ name: "Alice", age: 30, email: "a@b.com" });
		const result = await col.replaceOne({ name: "Alice" }, {
			name: "Alice Updated",
			age: 31,
		} as TestDoc);
		expect(result.matchedCount).toBe(1);

		const replaced = await col.findOne({ name: "Alice Updated" });
		expect(replaced).not.toBeNull();
		expect(replaced?.age).toBe(31);
		// email should be gone since it was a full replacement
		expect(replaced?.email).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// COUNT
// ---------------------------------------------------------------------------

describe("countDocuments", () => {
	test("counts all documents", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
			{ name: "Charlie", age: 35 },
		]);
		const count = await col.countDocuments();
		expect(count).toBe(3);
	});

	test("counts filtered documents", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
			{ name: "Charlie", age: 35 },
		]);
		const count = await col.countDocuments({ age: { $gt: 28 } });
		expect(count).toBe(2);
	});

	test("returns 0 for empty collection", async () => {
		const count = await col.countDocuments();
		expect(count).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// DISTINCT
// ---------------------------------------------------------------------------

describe("distinct", () => {
	test("returns distinct values", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 30 },
			{ name: "Charlie", age: 25 },
		]);
		const ages = await col.distinct<number>("age");
		expect(ages.sort()).toEqual([25, 30]);
	});
});

// ---------------------------------------------------------------------------
// FIND AND MODIFY
// ---------------------------------------------------------------------------

describe("findOneAndUpdate", () => {
	test("returns document before update by default", async () => {
		await col.insertOne({ name: "Alice", age: 30 });
		const result = await col.findOneAndUpdate(
			{ name: "Alice" },
			{ $set: { age: 31 } },
		);
		expect(result).not.toBeNull();
		expect(result?.name).toBe("Alice");
		expect(result?.age).toBe(30); // before
	});

	test("returns document after update with returnDocument: after", async () => {
		await col.insertOne({ name: "Alice", age: 30 });
		const result = await col.findOneAndUpdate(
			{ name: "Alice" },
			{ $set: { age: 31 } },
			{ returnDocument: "after" },
		);
		expect(result).not.toBeNull();
		expect(result?.age).toBe(31);
	});

	test("returns null when no match", async () => {
		const result = await col.findOneAndUpdate(
			{ name: "Nobody" },
			{ $set: { age: 99 } },
		);
		expect(result).toBeNull();
	});
});

describe("findOneAndDelete", () => {
	test("returns deleted document", async () => {
		await col.insertOne({ name: "Alice", age: 30 });
		const result = await col.findOneAndDelete({ name: "Alice" });
		expect(result).not.toBeNull();
		expect(result?.name).toBe("Alice");

		// Should be gone
		const check = await col.findOne({ name: "Alice" });
		expect(check).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// COMPLEX QUERIES
// ---------------------------------------------------------------------------

describe("complex filter queries", () => {
	test("$or filter", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
			{ name: "Charlie", age: 35 },
		]);
		const results = await col
			.find({ $or: [{ name: "Alice" }, { age: { $gt: 32 } }] })
			.toArray();
		expect(results).toHaveLength(2);
	});

	test("$and filter", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30, active: true },
			{ name: "Bob", age: 25, active: true },
			{ name: "Charlie", age: 35, active: false },
		]);
		const results = await col
			.find({ $and: [{ active: true }, { age: { $gte: 28 } }] })
			.toArray();
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("Alice");
	});

	test("$in filter", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
			{ name: "Charlie", age: 35 },
		]);
		const results = await col
			.find({ name: { $in: ["Alice", "Charlie"] } })
			.toArray();
		expect(results).toHaveLength(2);
	});

	test("nested field query (dot notation)", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30, address: { city: "NYC" } },
			{ name: "Bob", age: 25, address: { city: "LA" } },
		]);
		const results = await col.find({ "address.city": "NYC" }).toArray();
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("Alice");
	});
});

// ---------------------------------------------------------------------------
// ARRAY UPDATE OPERATORS
// ---------------------------------------------------------------------------

describe("array update operators", () => {
	test("$push appends to array", async () => {
		await col.insertOne({ name: "Alice", age: 30, tags: ["a", "b"] });
		await col.updateOne({ name: "Alice" }, { $push: { tags: "c" } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.tags).toContain("c");
		expect(updated?.tags).toHaveLength(3);
	});

	test("$pull removes from array", async () => {
		await col.insertOne({ name: "Alice", age: 30, tags: ["a", "b", "c"] });
		await col.updateOne({ name: "Alice" }, { $pull: { tags: "b" } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.tags).not.toContain("b");
	});

	test("$push with $each appends multiple values", async () => {
		await col.insertOne({ name: "Alice", age: 30, tags: ["a"] });
		await col.updateOne(
			{ name: "Alice" },
			{ $push: { tags: { $each: ["b", "c", "d"] } } },
		);
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.tags).toHaveLength(4);
		expect(updated?.tags).toContain("b");
		expect(updated?.tags).toContain("d");
	});

	test("$push with $each and $slice keeps N elements", async () => {
		await col.insertOne({ name: "Alice", age: 30, score: 0, tags: ["a", "b"] });
		await col.updateOne(
			{ name: "Alice" },
			{ $push: { tags: { $each: ["c", "d", "e"], $slice: 3 } } },
		);
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.tags).toHaveLength(3);
	});

	test("$pop removes last element", async () => {
		await col.insertOne({ name: "Alice", age: 30, tags: ["a", "b", "c"] });
		await col.updateOne({ name: "Alice" }, { $pop: { tags: 1 } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.tags).toHaveLength(2);
		expect(updated?.tags).not.toContain("c");
	});

	test("$pop removes first element", async () => {
		await col.insertOne({ name: "Alice", age: 30, tags: ["a", "b", "c"] });
		await col.updateOne({ name: "Alice" }, { $pop: { tags: -1 } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.tags).toHaveLength(2);
		expect(updated?.tags).not.toContain("a");
	});

	test("$pullAll removes all matching values", async () => {
		await col.insertOne({
			name: "Alice",
			age: 30,
			tags: ["a", "b", "c", "d"],
		});
		await col.updateOne({ name: "Alice" }, { $pullAll: { tags: ["b", "d"] } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.tags).toEqual(["a", "c"]);
	});
});

// ---------------------------------------------------------------------------
// DB OPERATIONS
// ---------------------------------------------------------------------------

describe("Db operations", () => {
	test("createCollection creates a table", async () => {
		const newCol = await db.createCollection("test_create_col");
		expect(newCol.collectionName).toBe("test_create_col");
		// Clean up
		await db.dropCollection("test_create_col");
	});

	test("listCollections returns created tables", async () => {
		// The 'users' table exists from beforeEach
		await col.insertOne({ name: "Alice", age: 30 });
		const collections = await db.listCollections();
		const names = collections.map((c) => c.name);
		expect(names).toContain("users");
		for (const c of collections) {
			expect(c.type).toBe("collection");
		}
	});

	test("dropCollection removes a table", async () => {
		await db.createCollection("temp_drop");
		const result = await db.dropCollection("temp_drop");
		expect(result).toBe(true);
		const collections = await db.listCollections();
		const names = collections.map((c) => c.name);
		expect(names).not.toContain("temp_drop");
	});
});

// ---------------------------------------------------------------------------
// ARRAY FILTER OPERATORS
// ---------------------------------------------------------------------------

describe("array filter operators", () => {
	test("$all finds documents with all values", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30, tags: ["a", "b", "c"] },
			{ name: "Bob", age: 25, tags: ["a", "b"] },
			{ name: "Charlie", age: 35, tags: ["a"] },
		]);
		const results = await col.find({ tags: { $all: ["a", "b"] } }).toArray();
		expect(results).toHaveLength(2);
		const names = results.map((r) => r.name).sort();
		expect(names).toEqual(["Alice", "Bob"]);
	});

	test("$size filters by array length", async () => {
		await col.insertMany([
			{ name: "Alice", age: 30, tags: ["a", "b", "c"] },
			{ name: "Bob", age: 25, tags: ["a", "b"] },
			{ name: "Charlie", age: 35, tags: ["a"] },
		]);
		const results = await col.find({ tags: { $size: 2 } }).toArray();
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("Bob");
	});
});
