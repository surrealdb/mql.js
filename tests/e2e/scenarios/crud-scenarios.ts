/**
 * Driver-agnostic E2E scenarios.
 *
 * The scenarios below only ever touch the `MongoLikeClient` contract, so
 * the exact same `describe` block is reused for the official MongoDB
 * driver and for `@surrealdb/mql`. Adding a new scenario means appending
 * a `test()` here — no provider edits needed (Open/Closed).
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type {
	MongoLikeClient,
	MongoLikeCollection,
	MongoLikeDb,
} from "../contracts/mongo-like.ts";
import type { DatabaseProvider } from "../providers/database-provider.ts";

interface UserDoc {
	[key: string]: unknown;
	_id?: unknown;
	name: string;
	age: number;
	email?: string;
	tags?: string[];
	active?: boolean;
}

const COLLECTION_NAME = "users";

/**
 * Register the parity test cases against `provider`. The provider is
 * brought up once per file (`beforeAll`) and torn down at the end
 * (`afterAll`); each test starts from an empty collection.
 */
export function registerCrudScenarios(provider: DatabaseProvider): void {
	describe(`E2E parity – ${provider.name}`, () => {
		let client: MongoLikeClient;
		let db: MongoLikeDb;
		let users: MongoLikeCollection<UserDoc>;

		beforeAll(async () => {
			client = await provider.start();
			db = client.db();
		}, 120_000);

		afterAll(async () => {
			await provider.stop();
		}, 30_000);

		beforeEach(async () => {
			users = db.collection<UserDoc>(COLLECTION_NAME);
			try {
				await users.deleteMany({});
			} catch {
				// Some engines throw on missing tables; ignore.
			}
		});

		// -----------------------------------------------------------------
		// INSERT
		// -----------------------------------------------------------------

		describe("what an update counts as modified", () => {
			// `matchedCount` and `modifiedCount` are different numbers, and this
			// driver reported them as the same one until the bulkWrite parity
			// scenarios put the question to a real mongod.
			test("a $set to the value already there matches but does not modify", async () => {
				await users.insertOne({ name: "Alice", age: 30 });
				const result = await users.updateOne(
					{ name: "Alice" },
					{ $set: { age: 30 } },
				);
				expect(result.matchedCount).toBe(1);
				expect(result.modifiedCount).toBe(0);
			});

			test("a $set to a new value modifies", async () => {
				await users.insertOne({ name: "Alice", age: 30 });
				const result = await users.updateOne(
					{ name: "Alice" },
					{ $set: { age: 31 } },
				);
				expect(result.matchedCount).toBe(1);
				expect(result.modifiedCount).toBe(1);
			});

			test("updateMany counts only the documents it changed", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 31 },
				]);
				const result = await users.updateMany({}, { $set: { age: 30 } });
				expect(result.matchedCount).toBe(2);
				expect(result.modifiedCount).toBe(1);
			});

			test("a replace counts as modified even when the content is identical", async () => {
				// Measured, and not what the $set rule above would predict: MongoDB
				// compares values for an update operator and does not for a
				// whole-document replace. Asserting it of both drivers is what stops
				// the asymmetry being tidied away into a consistency that is wrong.
				await users.insertOne({ name: "Alice", age: 30 });
				const result = await users.replaceOne(
					{ name: "Alice" },
					{ name: "Alice", age: 30 },
				);
				expect(result.matchedCount).toBe(1);
				expect(result.modifiedCount).toBe(1);
			});
		});

		describe("insert", () => {
			test("insertOne acknowledges and returns an id", async () => {
				const result = await users.insertOne({ name: "Alice", age: 30 });
				expect(result.acknowledged).toBe(true);
				expect(result.insertedId).toBeDefined();
			});

			test("insertMany returns the right count", async () => {
				const result = await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
					{ name: "Charlie", age: 35 },
				]);
				expect(result.acknowledged).toBe(true);
				expect(result.insertedCount).toBe(3);
				expect(Object.keys(result.insertedIds)).toHaveLength(3);
			});
		});

		// -----------------------------------------------------------------
		// FIND
		// -----------------------------------------------------------------

		describe("find", () => {
			test("findOne returns null when nothing matches", async () => {
				const found = await users.findOne({ name: "Nobody" });
				expect(found).toBeNull();
			});

			test("findOne retrieves an inserted document", async () => {
				await users.insertOne({ name: "Alice", age: 30 });
				const found = await users.findOne({ name: "Alice" });
				expect(found).not.toBeNull();
				expect(found?.name).toBe("Alice");
				expect(found?.age).toBe(30);
			});

			test("find().toArray returns all matches", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
					{ name: "Charlie", age: 35 },
				]);
				const all = await users.find({}).toArray();
				expect(all).toHaveLength(3);
				const names = all.map((d) => d.name).sort();
				expect(names).toEqual(["Alice", "Bob", "Charlie"]);
			});

			test("find with $gt comparison filter", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
					{ name: "Charlie", age: 35 },
				]);
				const adults = await users.find({ age: { $gt: 28 } }).toArray();
				expect(adults).toHaveLength(2);
				const names = adults.map((d) => d.name).sort();
				expect(names).toEqual(["Alice", "Charlie"]);
			});

			test("find with $in filter", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
					{ name: "Charlie", age: 35 },
				]);
				const subset = await users
					.find({ name: { $in: ["Alice", "Charlie"] } })
					.toArray();
				expect(subset).toHaveLength(2);
			});

			test("find().sort().limit().skip() chain", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
					{ name: "Charlie", age: 35 },
					{ name: "Diana", age: 28 },
				]);
				const page = await users
					.find({})
					.sort({ age: 1 })
					.skip(1)
					.limit(2)
					.toArray();
				expect(page.map((d) => d.name)).toEqual(["Diana", "Alice"]);
			});

			test("$or filter combines clauses", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
					{ name: "Charlie", age: 35 },
				]);
				const matches = await users
					.find({ $or: [{ name: "Alice" }, { age: { $gt: 32 } }] })
					.toArray();
				expect(matches).toHaveLength(2);
				const names = matches.map((d) => d.name).sort();
				expect(names).toEqual(["Alice", "Charlie"]);
			});
		});

		// -----------------------------------------------------------------
		// UPDATE
		// -----------------------------------------------------------------

		describe("update", () => {
			test("$set updates a single document", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
				]);
				const result = await users.updateOne(
					{ name: "Alice" },
					{ $set: { age: 31 } },
				);
				expect(result.matchedCount).toBe(1);
				expect(result.modifiedCount).toBe(1);

				const updated = await users.findOne({ name: "Alice" });
				expect(updated?.age).toBe(31);
			});

			test("$inc increments a numeric field", async () => {
				await users.insertOne({ name: "Alice", age: 30 });
				await users.updateOne({ name: "Alice" }, { $inc: { age: 5 } });
				const updated = await users.findOne({ name: "Alice" });
				expect(updated?.age).toBe(35);
			});

			test("updateMany updates every match", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30, active: false },
					{ name: "Bob", age: 25, active: false },
					{ name: "Charlie", age: 35, active: true },
				]);
				const result = await users.updateMany(
					{ active: false },
					{ $set: { active: true } },
				);
				expect(result.matchedCount).toBe(2);

				const allActive = await users.find({ active: true }).toArray();
				expect(allActive).toHaveLength(3);
			});
		});

		// -----------------------------------------------------------------
		// DELETE
		// -----------------------------------------------------------------

		describe("delete", () => {
			test("deleteOne removes one document", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
				]);
				const result = await users.deleteOne({ name: "Alice" });
				expect(result.deletedCount).toBe(1);

				const remaining = await users.find({}).toArray();
				expect(remaining).toHaveLength(1);
				expect(remaining[0].name).toBe("Bob");
			});

			test("deleteMany removes every match", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
					{ name: "Charlie", age: 35 },
				]);
				const result = await users.deleteMany({ age: { $gte: 30 } });
				expect(result.deletedCount).toBe(2);

				const remaining = await users.find({}).toArray();
				expect(remaining).toHaveLength(1);
				expect(remaining[0].name).toBe("Bob");
			});

			test("deleteOne reports zero matches", async () => {
				const result = await users.deleteOne({ name: "Nobody" });
				expect(result.deletedCount).toBe(0);
			});
		});

		// -----------------------------------------------------------------
		// COUNT
		// -----------------------------------------------------------------

		describe("count", () => {
			test("countDocuments counts everything", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
					{ name: "Charlie", age: 35 },
				]);
				expect(await users.countDocuments()).toBe(3);
			});

			test("countDocuments respects filters", async () => {
				await users.insertMany([
					{ name: "Alice", age: 30 },
					{ name: "Bob", age: 25 },
					{ name: "Charlie", age: 35 },
				]);
				expect(await users.countDocuments({ age: { $gt: 28 } })).toBe(2);
			});
		});

		// -----------------------------------------------------------------
		// FULL ROUND-TRIP
		// -----------------------------------------------------------------

		test("insert → query → update → delete round-trip", async () => {
			await users.insertOne({
				name: "Alice",
				age: 30,
				email: "alice@example.com",
				tags: ["admin"],
			});

			const found = await users.findOne({ name: "Alice" });
			expect(found?.email).toBe("alice@example.com");

			await users.updateOne({ name: "Alice" }, { $set: { age: 31 } });
			const updated = await users.findOne({ name: "Alice" });
			expect(updated?.age).toBe(31);

			const deleted = await users.deleteOne({ name: "Alice" });
			expect(deleted.deletedCount).toBe(1);

			const gone = await users.findOne({ name: "Alice" });
			expect(gone).toBeNull();
		});
	});
}
