import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { Collection, ObjectId } from "../../src/index.ts";
import {
	MongoClient,
	MongoInvalidArgumentError,
	MongoNotConnectedError,
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
	name: string;
	age?: number;
}

let ctx: SurrealTestContext<TestDoc>;
let col: Collection<TestDoc>;
const PORT = 18741;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
	ctx = await setupSurreal<TestDoc>(PORT);
});

afterAll(async () => {
	await teardownSurreal(ctx);
});

beforeEach(async () => {
	col = ctx.collection("error_tests");
	try {
		await col.deleteMany({});
	} catch {
		// ignore
	}
});

// ---------------------------------------------------------------------------
// replaceOne with empty filter
// ---------------------------------------------------------------------------

describe("replaceOne errors", () => {
	test("throws MongoInvalidArgumentError with empty filter", async () => {
		await col.insertOne({ name: "Alice", age: 30 });
		try {
			await col.replaceOne({}, { name: "Replacement" } as TestDoc);
			// Should not reach here
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(MongoInvalidArgumentError);
		}
	});
});

// ---------------------------------------------------------------------------
// findOneAndReplace with empty filter
// ---------------------------------------------------------------------------

describe("findOneAndReplace errors", () => {
	test("throws MongoInvalidArgumentError with empty filter", async () => {
		await col.insertOne({ name: "Alice", age: 30 });
		try {
			await col.findOneAndReplace({}, { name: "Replacement" } as TestDoc);
			// Should not reach here
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(MongoInvalidArgumentError);
		}
	});
});

// ---------------------------------------------------------------------------
// Invalid filter operators
// ---------------------------------------------------------------------------

describe("invalid filter operators", () => {
	test("throws on unsupported filter operator", async () => {
		await col.insertOne({ name: "Alice", age: 30 });
		try {
			await col
				.find({ age: { $invalid: 5 } as Record<string, unknown> })
				.toArray();
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toContain("Unsupported filter operator");
		}
	});
});

// ---------------------------------------------------------------------------
// Invalid update operators
// ---------------------------------------------------------------------------

describe("invalid update operators", () => {
	test("throws on unsupported update operator", async () => {
		await col.insertOne({ name: "Alice", age: 30 });
		try {
			await col.updateOne({ name: "Alice" }, { $fakeOp: { age: 1 } } as Record<
				string,
				unknown
			>);
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toContain("Unsupported update operator");
		}
	});
});

// ---------------------------------------------------------------------------
// Operations on a disconnected client
// ---------------------------------------------------------------------------

describe("operations on disconnected client", () => {
	test("an operation on a never-connected client connects lazily", async () => {
		const disconnected = new MongoClient(
			`mongodb://root:root@127.0.0.1:${PORT}/testdb?namespace=test`,
		);
		// Never called connect(): the official driver allows this, and the first
		// operation is what establishes the connection.
		try {
			await disconnected.db().collection("lazy_ops").insertOne({ n: 1 });
			expect(disconnected.serverVersion).toBeDefined();
		} finally {
			await disconnected.close();
		}
	});

	test("an operation after close() throws MongoNotConnectedError", async () => {
		const tempClient = new MongoClient(
			`mongodb://root:root@127.0.0.1:${PORT}/testdb?namespace=test`,
		);
		await tempClient.connect();
		const collection = tempClient.db().collection("closed_ops");
		await tempClient.close();

		await expect(collection.countDocuments()).rejects.toThrow(
			MongoNotConnectedError,
		);
	});
});

// ---------------------------------------------------------------------------
// deleteOne / deleteMany return 0 for no match
// ---------------------------------------------------------------------------

describe("delete on non-existent documents", () => {
	test("deleteOne returns deletedCount 0 for no match", async () => {
		const result = await col.deleteOne({ name: "Nobody" });
		expect(result.deletedCount).toBe(0);
	});

	test("deleteMany returns deletedCount 0 for no match", async () => {
		const result = await col.deleteMany({ name: "Nobody" });
		expect(result.deletedCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// updateOne returns matchedCount 0 for no match
// ---------------------------------------------------------------------------

describe("update on non-existent documents", () => {
	test("updateOne returns matchedCount 0 for no match", async () => {
		const result = await col.updateOne(
			{ name: "Nobody" },
			{ $set: { age: 99 } },
		);
		expect(result.matchedCount).toBe(0);
		expect(result.modifiedCount).toBe(0);
	});
});
