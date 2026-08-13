/**
 * Mongoose compatibility tests using mql.js as the underlying driver.
 *
 * Mongoose internally creates its own MongoClient from the `mongodb` package.
 * Since mql.js provides a MongoDB-compatible API over SurrealDB (not the
 * MongoDB wire protocol), we cannot use `mongoose.connect()` directly.
 *
 * Instead, this test manually wires a mongoose Connection to use mql.js's
 * Db and Collection objects. This validates that mongoose's ODM layer
 * (schemas, models, queries) works correctly against the mql.js API surface.
 *
 * Approach:
 *   1. Connect mql.js MongoClient to SurrealDB
 *   2. Create a mongoose Connection and manually set `conn.db` to our Db
 *   3. Mark the connection as connected
 *   4. Define mongoose schemas/models on that connection
 *   5. Test CRUD operations through mongoose's model API
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import mongoose from "mongoose";
import type { Db } from "../../src/index.ts";
import { MongoClient } from "../../src/index.ts";
import { waitForSurreal } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let surrealProcess: import("bun").Subprocess;
let client: MongoClient;
let db: Db;
let conn: mongoose.Connection;
const PORT = 18743;

/**
 * Wire a mongoose Connection to use mql.js's Db, bypassing the normal
 * mongodb driver connection flow.
 */
function wireMongooseConnection(
	connection: mongoose.Connection,
	mqlDb: Db,
	dbName: string,
): void {
	// Set the db object that mongoose uses to create collections
	// biome-ignore lint/suspicious/noExplicitAny: Mongoose internal wiring requires this
	(connection as any).db = mqlDb;
	// biome-ignore lint/suspicious/noExplicitAny: Mongoose internal wiring requires this
	(connection as any)._readyState = 1; // STATES.connected
	// biome-ignore lint/suspicious/noExplicitAny: Mongoose internal wiring requires this
	(connection as any).name = dbName;
	// biome-ignore lint/suspicious/noExplicitAny: Mongoose internal wiring requires this
	(connection as any).$dbName = dbName;

	// Trigger collection initialization for any models already registered
	connection.emit("connected");
	connection.emit("open");
}

beforeAll(async () => {
	// Start SurrealDB
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
	await waitForSurreal(PORT, 10000, surrealProcess);

	// Connect mql.js
	client = new MongoClient(
		`mongodb://root:root@127.0.0.1:${PORT}/mongoosedb?namespace=test`,
	);
	await client.connect();
	db = client.db("mongoosedb");

	// Create and wire a mongoose connection
	const m = new mongoose.Mongoose();
	conn = m.createConnection();
	wireMongooseConnection(conn, db, "mongoosedb");
});

afterAll(async () => {
	// Clean up mongoose
	try {
		// biome-ignore lint/suspicious/noExplicitAny: Mongoose internal wiring for cleanup
		(conn as any)._readyState = 0;
		await conn.close();
	} catch {
		// ignore cleanup errors
	}

	await client.close();
	surrealProcess.kill();
});

// ---------------------------------------------------------------------------
// Schema definitions
// ---------------------------------------------------------------------------

interface IUser {
	name: string;
	email: string;
	age: number;
	role: string;
	tags: string[];
}

interface IPost {
	title: string;
	body: string;
	authorName: string;
	likes: number;
	published: boolean;
	tags: string[];
}

const userSchema = new mongoose.Schema<IUser>({
	name: { type: String, required: true },
	email: { type: String, required: true },
	age: { type: Number, required: true },
	role: { type: String, default: "user" },
	tags: { type: [String], default: [] },
});

const postSchema = new mongoose.Schema<IPost>({
	title: { type: String, required: true },
	body: { type: String, required: true },
	authorName: { type: String, required: true },
	likes: { type: Number, default: 0 },
	published: { type: Boolean, default: false },
	tags: { type: [String], default: [] },
});

// Register models on our wired connection
let User: mongoose.Model<IUser>;
let Post: mongoose.Model<IPost>;

beforeAll(() => {
	User = conn.model<IUser>("User", userSchema);
	Post = conn.model<IPost>("Post", postSchema);
});

beforeEach(async () => {
	// Clean collections before each test using mql.js directly
	const userCol = db.collection("users");
	const postCol = db.collection("posts");
	try {
		await userCol.deleteMany({});
	} catch {
		// ignore
	}
	try {
		await postCol.deleteMany({});
	} catch {
		// ignore
	}
});

// ---------------------------------------------------------------------------
// Model.create()
// ---------------------------------------------------------------------------

describe("Model.create()", () => {
	test("creates a single document", async () => {
		const user = await User.create({
			name: "Alice",
			email: "alice@test.com",
			age: 30,
		});
		expect(user).toBeDefined();
		expect(user.name).toBe("Alice");
		expect(user.email).toBe("alice@test.com");
		expect(user.age).toBe(30);
		expect(user.role).toBe("user"); // default value
		expect(user._id).toBeDefined();
	});

	test("creates multiple documents", async () => {
		const users = await User.create([
			{ name: "Alice", email: "alice@test.com", age: 30 },
			{ name: "Bob", email: "bob@test.com", age: 25 },
		]);
		expect(users).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Model.find()
// ---------------------------------------------------------------------------

describe("Model.find()", () => {
	test("finds all documents", async () => {
		await User.create([
			{ name: "Alice", email: "alice@test.com", age: 30 },
			{ name: "Bob", email: "bob@test.com", age: 25 },
			{ name: "Charlie", email: "charlie@test.com", age: 35 },
		]);

		const users = await User.find({});
		expect(users).toHaveLength(3);
	});

	test("finds with filter", async () => {
		await User.create([
			{ name: "Alice", email: "alice@test.com", age: 30 },
			{ name: "Bob", email: "bob@test.com", age: 25 },
			{ name: "Charlie", email: "charlie@test.com", age: 35 },
		]);

		const users = await User.find({ age: { $gte: 30 } });
		expect(users).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Model.findOne()
// ---------------------------------------------------------------------------

describe("Model.findOne()", () => {
	test("finds a single document", async () => {
		await User.create({ name: "Alice", email: "alice@test.com", age: 30 });

		const user = await User.findOne({ name: "Alice" });
		expect(user).not.toBeNull();
		expect(user?.name).toBe("Alice");
	});

	test("returns null when no match", async () => {
		const user = await User.findOne({ name: "Nobody" });
		expect(user).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Model.updateOne()
// ---------------------------------------------------------------------------

describe("Model.updateOne()", () => {
	test("updates a document with $set", async () => {
		await User.create({ name: "Alice", email: "alice@test.com", age: 30 });

		const result = await User.updateOne(
			{ name: "Alice" },
			{ $set: { age: 31 } },
		);
		expect(result.modifiedCount).toBe(1);

		const updated = await User.findOne({ name: "Alice" });
		expect(updated?.age).toBe(31);
	});
});

// ---------------------------------------------------------------------------
// Model.deleteOne()
// ---------------------------------------------------------------------------

describe("Model.deleteOne()", () => {
	test("deletes a document", async () => {
		await User.create({ name: "Alice", email: "alice@test.com", age: 30 });

		const result = await User.deleteOne({ name: "Alice" });
		expect(result.deletedCount).toBe(1);

		const check = await User.findOne({ name: "Alice" });
		expect(check).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Model.deleteMany()
// ---------------------------------------------------------------------------

describe("Model.deleteMany()", () => {
	test("deletes multiple documents", async () => {
		await User.create([
			{ name: "Alice", email: "alice@test.com", age: 30 },
			{ name: "Bob", email: "bob@test.com", age: 25 },
		]);

		const result = await User.deleteMany({});
		expect(result.deletedCount).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Schema defaults
// ---------------------------------------------------------------------------

describe("schema defaults", () => {
	test("applies default values from schema", async () => {
		const post = await Post.create({
			title: "Hello",
			body: "World",
			authorName: "Alice",
		});

		expect(post.likes).toBe(0);
		expect(post.published).toBe(false);
		expect(post.tags).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Query builder chaining
// ---------------------------------------------------------------------------

describe("query builder chaining", () => {
	test("find().sort().limit() works", async () => {
		await User.create([
			{ name: "Alice", email: "alice@test.com", age: 30 },
			{ name: "Bob", email: "bob@test.com", age: 25 },
			{ name: "Charlie", email: "charlie@test.com", age: 35 },
		]);

		const users = await User.find({}).sort({ age: 1 }).limit(2);
		expect(users).toHaveLength(2);
		expect(users[0].name).toBe("Bob");
		expect(users[1].name).toBe("Alice");
	});

	test("find().select() for projection works", async () => {
		await User.create({
			name: "Alice",
			email: "alice@test.com",
			age: 30,
			role: "admin",
		});

		const user = await User.findOne({ name: "Alice" }).select("name age");
		expect(user?.name).toBe("Alice");
		expect(user?.age).toBe(30);
	});
});

// ---------------------------------------------------------------------------
// countDocuments
// ---------------------------------------------------------------------------

describe("countDocuments", () => {
	test("counts documents matching filter", async () => {
		await User.create([
			{ name: "Alice", email: "alice@test.com", age: 30 },
			{ name: "Bob", email: "bob@test.com", age: 25 },
			{ name: "Charlie", email: "charlie@test.com", age: 35 },
		]);

		const count = await User.countDocuments({ age: { $gte: 30 } });
		expect(count).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// distinct
// ---------------------------------------------------------------------------

describe("distinct", () => {
	test("returns distinct values for a field", async () => {
		await User.create([
			{ name: "Alice", email: "alice@test.com", age: 30, role: "admin" },
			{ name: "Bob", email: "bob@test.com", age: 25, role: "user" },
			{ name: "Charlie", email: "charlie@test.com", age: 35, role: "admin" },
		]);

		const roles = await User.distinct("role");
		expect(roles.sort()).toEqual(["admin", "user"]);
	});
});

// ---------------------------------------------------------------------------
// updateMany
// ---------------------------------------------------------------------------

describe("Model.updateMany()", () => {
	test("updates multiple documents", async () => {
		await User.create([
			{ name: "Alice", email: "alice@test.com", age: 30, role: "user" },
			{ name: "Bob", email: "bob@test.com", age: 25, role: "user" },
		]);

		const result = await User.updateMany(
			{ role: "user" },
			{ $set: { role: "moderator" } },
		);
		expect(result.modifiedCount).toBe(2);

		const updated = await User.find({ role: "moderator" });
		expect(updated).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// findOneAndUpdate
// ---------------------------------------------------------------------------

describe("Model.findOneAndUpdate()", () => {
	test("finds and updates a document", async () => {
		await User.create({ name: "Alice", email: "alice@test.com", age: 30 });

		const updated = await User.findOneAndUpdate(
			{ name: "Alice" },
			{ $set: { age: 31 } },
			{ returnDocument: "after" },
		);
		expect(updated?.age).toBe(31);
	});
});

// ---------------------------------------------------------------------------
// findOneAndDelete
// ---------------------------------------------------------------------------

describe("Model.findOneAndDelete()", () => {
	test("finds and deletes a document", async () => {
		await User.create({ name: "Alice", email: "alice@test.com", age: 30 });

		const deleted = await User.findOneAndDelete({ name: "Alice" });
		expect(deleted?.name).toBe("Alice");

		const check = await User.findOne({ name: "Alice" });
		expect(check).toBeNull();
	});
});
