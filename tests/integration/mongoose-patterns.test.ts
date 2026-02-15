/**
 * Mongoose-like pattern tests using mql.js directly.
 *
 * These tests validate that common mongoose workflows (schemas, model CRUD,
 * subdocuments, population, pagination, etc.) can be expressed naturally
 * using the mql.js API surface — without requiring mongoose as a dependency.
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Collection, Db, ObjectId } from "../../src/index.ts";
import {
	type SurrealTestContext,
	setupSurreal,
	teardownSurreal,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// Schema-like interfaces (TypeScript replaces mongoose schemas)
// ---------------------------------------------------------------------------

interface User {
	[key: string]: unknown;
	_id?: ObjectId | string | number;
	name: string;
	email: string;
	age: number;
	role: "admin" | "user" | "moderator";
	createdAt?: string;
}

interface Post {
	[key: string]: unknown;
	_id?: ObjectId | string | number;
	title: string;
	body: string;
	authorId: ObjectId | string | number;
	tags: string[];
	comments: Comment[];
	likes: number;
	published: boolean;
}

interface Comment {
	author: string;
	text: string;
	createdAt: string;
}

interface Product {
	[key: string]: unknown;
	_id?: ObjectId | string | number;
	name: string;
	price: number;
	category: string;
	stock: number;
	specs: { key: string; value: string }[];
}

let ctx: SurrealTestContext;
let db: Db;
let users: Collection<User>;
let posts: Collection<Post>;
let products: Collection<Product>;
const PORT = 18742;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
	ctx = await setupSurreal(PORT);
	db = ctx.db;
});

afterAll(async () => {
	await teardownSurreal(ctx);
});

beforeEach(async () => {
	users = db.collection<User>("mg_users");
	posts = db.collection<Post>("mg_posts");
	products = db.collection<Product>("mg_products");
	try {
		await users.deleteMany({});
		await posts.deleteMany({});
		await products.deleteMany({});
	} catch {
		// ignore
	}
});

// ---------------------------------------------------------------------------
// Model-like CRUD round-trip
// ---------------------------------------------------------------------------

describe("model-like CRUD round-trip", () => {
	test("insert → find → update → delete lifecycle", async () => {
		// CREATE
		const insertResult = await users.insertOne({
			name: "Alice",
			email: "alice@example.com",
			age: 30,
			role: "admin",
		});
		expect(insertResult.acknowledged).toBe(true);

		// READ
		const found = await users.findOne({ name: "Alice" });
		expect(found).not.toBeNull();
		expect(found?.name).toBe("Alice");
		expect(found?.email).toBe("alice@example.com");

		// UPDATE
		const updateResult = await users.updateOne(
			{ name: "Alice" },
			{ $set: { age: 31, role: "moderator" } },
		);
		expect(updateResult.modifiedCount).toBe(1);

		const updated = await users.findOne({ name: "Alice" });
		expect(updated?.age).toBe(31);
		expect(updated?.role).toBe("moderator");

		// DELETE
		const deleteResult = await users.deleteOne({ name: "Alice" });
		expect(deleteResult.deletedCount).toBe(1);

		const gone = await users.findOne({ name: "Alice" });
		expect(gone).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Subdocument patterns
// ---------------------------------------------------------------------------

describe("subdocument patterns", () => {
	test("nested objects work correctly", async () => {
		await products.insertOne({
			name: "Laptop",
			price: 999,
			category: "electronics",
			stock: 50,
			specs: [
				{ key: "CPU", value: "M3" },
				{ key: "RAM", value: "16GB" },
				{ key: "Storage", value: "512GB" },
			],
		});

		const product = await products.findOne({ name: "Laptop" });
		expect(product?.specs).toHaveLength(3);
		expect(product?.specs[0].key).toBe("CPU");
	});

	test("arrays of subdocuments can be queried", async () => {
		await products.insertMany([
			{
				name: "Laptop",
				price: 999,
				category: "electronics",
				stock: 50,
				specs: [{ key: "CPU", value: "M3" }],
			},
			{
				name: "Phone",
				price: 699,
				category: "electronics",
				stock: 100,
				specs: [{ key: "CPU", value: "A17" }],
			},
		]);

		const results = await products
			.find({ category: "electronics", price: { $lt: 800 } })
			.toArray();
		expect(results).toHaveLength(1);
		expect(results[0].name).toBe("Phone");
	});

	test("update nested subdocument arrays with $push", async () => {
		await products.insertOne({
			name: "Laptop",
			price: 999,
			category: "electronics",
			stock: 50,
			specs: [{ key: "CPU", value: "M3" }],
		});

		await products.updateOne(
			{ name: "Laptop" },
			{ $push: { specs: { key: "GPU", value: "10-core" } } },
		);

		const updated = await products.findOne({ name: "Laptop" });
		expect(updated?.specs).toHaveLength(2);
		expect(updated?.specs[1].key).toBe("GPU");
	});

	test("embedded comments in posts", async () => {
		const userResult = await users.insertOne({
			name: "Alice",
			email: "alice@example.com",
			age: 30,
			role: "user",
		});

		await posts.insertOne({
			title: "Hello World",
			body: "First post content",
			authorId: userResult.insertedId,
			tags: ["intro", "hello"],
			comments: [
				{ author: "Bob", text: "Great post!", createdAt: "2024-01-01" },
				{ author: "Charlie", text: "Welcome!", createdAt: "2024-01-02" },
			],
			likes: 5,
			published: true,
		});

		const post = await posts.findOne({ title: "Hello World" });
		expect(post?.comments).toHaveLength(2);
		expect(post?.comments[0].author).toBe("Bob");
	});
});

// ---------------------------------------------------------------------------
// Population-like pattern (manual reference resolution)
// ---------------------------------------------------------------------------

describe("population-like pattern", () => {
	test("stores references and resolves them manually", async () => {
		// Create a user
		const userResult = await users.insertOne({
			name: "Alice",
			email: "alice@example.com",
			age: 30,
			role: "user",
		});

		// Create posts referencing the user
		await posts.insertMany([
			{
				title: "Post 1",
				body: "Content 1",
				authorId: userResult.insertedId,
				tags: ["tech"],
				comments: [],
				likes: 3,
				published: true,
			},
			{
				title: "Post 2",
				body: "Content 2",
				authorId: userResult.insertedId,
				tags: ["life"],
				comments: [],
				likes: 7,
				published: true,
			},
		]);

		// "Populate": find posts by author name (since ObjectId refs
		// require special handling in SurrealDB)
		const userPosts = await posts
			.find({ authorId: userResult.insertedId })
			.toArray();
		expect(userPosts).toHaveLength(2);

		// Resolve the author by name
		const author = await users.findOne({ name: "Alice" });
		expect(author).not.toBeNull();
		expect(author?.name).toBe("Alice");
	});
});

// ---------------------------------------------------------------------------
// Virtuals-like pattern (computed fields)
// ---------------------------------------------------------------------------

describe("virtuals-like pattern", () => {
	test("compute derived fields after retrieval", async () => {
		await products.insertMany([
			{
				name: "Widget",
				price: 10,
				category: "misc",
				stock: 100,
				specs: [],
			},
			{
				name: "Gadget",
				price: 25,
				category: "misc",
				stock: 50,
				specs: [],
			},
		]);

		const docs = await products.find({}).toArray();
		const withVirtuals = docs.map((p) => ({
			...p,
			totalValue: p.price * p.stock,
			inStock: p.stock > 0,
		}));

		expect(withVirtuals[0].totalValue).toBeDefined();
		expect(withVirtuals[0].inStock).toBe(true);
		// Verify computation
		const widget = withVirtuals.find((p) => p.name === "Widget");
		expect(widget?.totalValue).toBe(1000);
	});
});

// ---------------------------------------------------------------------------
// Middleware-like pattern (pre/post hooks via wrappers)
// ---------------------------------------------------------------------------

describe("middleware-like pattern", () => {
	test("pre-save hook: set createdAt before insert", async () => {
		// Simulate a pre-save middleware
		async function createUser(data: {
			name: string;
			email: string;
			age: number;
			role: User["role"];
		}) {
			return users.insertOne({
				...data,
				createdAt: new Date().toISOString(),
			});
		}

		await createUser({
			name: "Alice",
			email: "alice@example.com",
			age: 30,
			role: "user",
		});

		const user = await users.findOne({ name: "Alice" });
		expect(user?.createdAt).toBeDefined();
		expect(typeof user?.createdAt).toBe("string");
	});

	test("post-find hook: transform results", async () => {
		await users.insertMany([
			{ name: "Alice", email: "alice@example.com", age: 30, role: "admin" },
			{ name: "Bob", email: "bob@example.com", age: 25, role: "user" },
		]);

		// Simulate a post-find middleware
		async function findUsersWithDefaults(filter: Record<string, unknown>) {
			const docs = await users.find(filter).toArray();
			// Post-processing: add default properties
			return docs.map((u) => ({
				...u,
				displayName: u.name.toUpperCase(),
				isAdmin: u.role === "admin",
			}));
		}

		const results = await findUsersWithDefaults({});
		expect(results).toHaveLength(2);
		expect(results[0].displayName).toBeDefined();

		const alice = results.find((u) => u.name === "Alice");
		expect(alice?.isAdmin).toBe(true);
		expect(alice?.displayName).toBe("ALICE");
	});
});

// ---------------------------------------------------------------------------
// Lean-like queries (projection for performance)
// ---------------------------------------------------------------------------

describe("lean-like queries", () => {
	test("projection returns only requested fields", async () => {
		await users.insertMany([
			{ name: "Alice", email: "alice@example.com", age: 30, role: "admin" },
			{ name: "Bob", email: "bob@example.com", age: 25, role: "user" },
		]);

		// "Lean" query: only name and email
		const results = await users
			.find({}, { projection: { name: 1, email: 1 } })
			.toArray();

		expect(results).toHaveLength(2);
		for (const r of results) {
			expect(r.name).toBeDefined();
			expect(r.email).toBeDefined();
			expect(r.age).toBeUndefined();
			expect(r.role).toBeUndefined();
		}
	});

	test("exclusion projection hides specific fields", async () => {
		await users.insertOne({
			name: "Alice",
			email: "alice@example.com",
			age: 30,
			role: "admin",
		});

		const result = await users.findOne(
			{ name: "Alice" },
			{ projection: { email: 0 } },
		);

		expect(result?.name).toBe("Alice");
		expect(result?.email).toBeUndefined();
		expect(result?.age).toBe(30);
	});
});

// ---------------------------------------------------------------------------
// Pagination pattern
// ---------------------------------------------------------------------------

describe("pagination pattern", () => {
	test("skip/limit with sort provides paginated results", async () => {
		// Insert 10 users
		const docs: User[] = [];
		for (let i = 0; i < 10; i++) {
			docs.push({
				name: `User${i.toString().padStart(2, "0")}`,
				email: `user${i}@test.com`,
				age: 20 + i,
				role: "user",
			});
		}
		await users.insertMany(docs);

		const pageSize = 3;

		// Page 1
		const page1 = await users
			.find({})
			.sort({ age: 1 })
			.skip(0)
			.limit(pageSize)
			.toArray();
		expect(page1).toHaveLength(3);
		expect(page1[0].name).toBe("User00");
		expect(page1[2].name).toBe("User02");

		// Page 2
		const page2 = await users
			.find({})
			.sort({ age: 1 })
			.skip(pageSize)
			.limit(pageSize)
			.toArray();
		expect(page2).toHaveLength(3);
		expect(page2[0].name).toBe("User03");
		expect(page2[2].name).toBe("User05");

		// Page 4 (last, partial)
		const page4 = await users
			.find({})
			.sort({ age: 1 })
			.skip(pageSize * 3)
			.limit(pageSize)
			.toArray();
		expect(page4).toHaveLength(1);
		expect(page4[0].name).toBe("User09");

		// Total count for pagination metadata
		const total = await users.countDocuments();
		expect(total).toBe(10);
	});

	test("filtered pagination", async () => {
		const docs: User[] = [];
		for (let i = 0; i < 8; i++) {
			docs.push({
				name: `User${i}`,
				email: `user${i}@test.com`,
				age: 20 + i,
				role: i % 2 === 0 ? "admin" : "user",
			});
		}
		await users.insertMany(docs);

		// Paginate only admins
		const admins = await users
			.find({ role: "admin" })
			.sort({ age: 1 })
			.skip(1)
			.limit(2)
			.toArray();
		expect(admins).toHaveLength(2);
		for (const a of admins) {
			expect(a.role).toBe("admin");
		}

		const adminCount = await users.countDocuments({ role: "admin" });
		expect(adminCount).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// Bulk operations pattern
// ---------------------------------------------------------------------------

describe("bulk operations pattern", () => {
	test("insertMany + updateMany + deleteMany workflow", async () => {
		// Bulk insert
		const insertResult = await users.insertMany([
			{ name: "Alice", email: "a@test.com", age: 30, role: "admin" },
			{ name: "Bob", email: "b@test.com", age: 25, role: "user" },
			{ name: "Charlie", email: "c@test.com", age: 35, role: "user" },
			{ name: "Diana", email: "d@test.com", age: 28, role: "user" },
		]);
		expect(insertResult.insertedCount).toBe(4);

		// Bulk update
		const updateResult = await users.updateMany(
			{ role: "user" },
			{ $set: { role: "moderator" } },
		);
		expect(updateResult.matchedCount).toBe(3);

		// Bulk delete
		const deleteResult = await users.deleteMany({
			age: { $lt: 30 },
		});
		expect(deleteResult.deletedCount).toBe(2);

		// Verify remaining
		const remaining = await users.find({}).toArray();
		expect(remaining).toHaveLength(2);
	});
});
