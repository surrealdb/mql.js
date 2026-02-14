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
import { MongoClient, type ObjectId } from "../../src/index.ts";

interface Doc {
	[key: string]: unknown;
	_id?: ObjectId | string | number;
	name: string;
	age: number;
	score?: number;
}

let surrealProcess: Subprocess;
let client: MongoClient;
let db: Db;
let col: Collection<Doc>;
const PORT = 18735;

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

beforeAll(async () => {
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
		`mongodb://root:root@127.0.0.1:${PORT}/cursordb?namespace=test`,
	);
	await client.connect();
	db = client.db("cursordb");
});

afterAll(async () => {
	await client.close();
	surrealProcess.kill();
});

beforeEach(async () => {
	col = db.collection<Doc>("people");
	try {
		await col.deleteMany({});
	} catch {
		// ignore
	}

	// Seed test data
	await col.insertMany([
		{ name: "Alice", age: 30, score: 85 },
		{ name: "Bob", age: 25, score: 92 },
		{ name: "Charlie", age: 35, score: 78 },
		{ name: "Diana", age: 28, score: 95 },
		{ name: "Eve", age: 32, score: 88 },
	]);
});

describe("FindCursor chaining", () => {
	test("sort + limit + skip combined", async () => {
		const results = await col
			.find({})
			.sort({ age: 1 })
			.skip(1)
			.limit(2)
			.toArray();
		expect(results).toHaveLength(2);
		expect(results[0].name).toBe("Diana"); // age 28
		expect(results[1].name).toBe("Alice"); // age 30
	});

	test("projection includes only specified fields", async () => {
		const results = await col
			.find({}, { projection: { name: 1, age: 1 } })
			.toArray();
		expect(results).toHaveLength(5);
		for (const r of results) {
			expect(r.name).toBeDefined();
			expect(r.age).toBeDefined();
			expect(r.score).toBeUndefined();
		}
	});

	test("projection via cursor.project()", async () => {
		const results = await col.find({}).project({ name: 1 }).toArray();
		expect(results).toHaveLength(5);
		for (const r of results) {
			expect(r.name).toBeDefined();
			expect(r.age).toBeUndefined();
		}
	});

	test("projection with _id: 0", async () => {
		const results = await col
			.find({}, { projection: { _id: 0, name: 1, age: 1 } })
			.toArray();
		for (const r of results) {
			expect(r._id).toBeUndefined();
			expect(r.name).toBeDefined();
		}
	});
});

describe("FindCursor iteration", () => {
	test("next() returns null when exhausted", async () => {
		const cursor = col.find({ name: "Alice" });
		const first = await cursor.next();
		expect(first).not.toBeNull();
		const second = await cursor.next();
		expect(second).toBeNull();
	});

	test("hasNext() returns correct state", async () => {
		const cursor = col.find({ name: "Alice" });
		expect(await cursor.hasNext()).toBe(true);
		await cursor.next();
		expect(await cursor.hasNext()).toBe(false);
	});

	test("forEach stops on false return", async () => {
		const names: string[] = [];
		await col
			.find({})
			.sort({ age: 1 })
			// biome-ignore lint/suspicious/useIterableCallbackReturn: our forEach intentionally supports returning false
			.forEach((doc) => {
				names.push(doc.name);
				if (names.length >= 2) return false;
			});
		expect(names).toHaveLength(2);
	});

	test("count() returns total matches", async () => {
		const count = await col.find({ age: { $gte: 30 } }).count();
		expect(count).toBe(3);
	});
});

describe("FindCursor lifecycle", () => {
	test("close() prevents further iteration", async () => {
		const cursor = col.find({});
		await cursor.close();
		expect(cursor.closed).toBe(true);
		expect(() => cursor.toArray()).toThrow();
	});

	test("rewind() allows re-iteration", async () => {
		const cursor = col.find({ name: "Alice" });
		const first = await cursor.toArray();
		expect(first).toHaveLength(1);

		cursor.rewind();
		const second = await cursor.toArray();
		expect(second).toHaveLength(1);
		expect(second[0].name).toBe("Alice");
	});

	test("clone() creates independent cursor", async () => {
		const cursor = col.find({}).sort({ age: 1 }).limit(2);
		const cloned = cursor.clone();

		const original = await cursor.toArray();
		const copy = await cloned.toArray();

		expect(original).toHaveLength(2);
		expect(copy).toHaveLength(2);
		expect(original[0].name).toBe(copy[0].name);
	});
});
