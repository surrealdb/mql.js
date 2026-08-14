/**
 * `bulkWrite` parity: the same batches, through both drivers.
 *
 * The counting rules are the part worth checking against a real `mongod` rather
 * than against a reading of the documentation, because several of them are
 * arbitrary-looking and none is guessable:
 *
 *   - an upsert counts under `upsertedCount`, not `matchedCount`;
 *   - `modifiedCount` excludes a document an update left byte-identical;
 *   - `insertedIds` and `upsertedIds` are keyed by the model's index in the
 *     caller's array, not by a running counter of insertions;
 *   - `ordered: true` keeps the models before a failure and skips the ones
 *     after it; `ordered: false` attempts all of them.
 *
 * Every one of those is asserted of the official driver here as well as of this
 * one, so a wrong belief fails on the MongoDB leg.
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
	MongoLikeDocument,
} from "../contracts/mongo-like.ts";
import type { DatabaseProvider } from "../providers/database-provider.ts";

const COLLECTION_NAME = "bulk_docs";

interface Doc extends MongoLikeDocument {
	_id?: unknown;
	n?: number;
	tag?: string;
}

export function registerBulkWriteScenarios(provider: DatabaseProvider): void {
	describe(`E2E bulkWrite parity – ${provider.name}`, () => {
		let client: MongoLikeClient;
		let db: MongoLikeDb;
		let docs: MongoLikeCollection<Doc>;

		beforeAll(async () => {
			client = await provider.start();
			db = client.db();
		}, 120_000);

		afterAll(async () => {
			await provider.stop();
		}, 30_000);

		beforeEach(async () => {
			docs = db.collection<Doc>(COLLECTION_NAME);
			try {
				await docs.deleteMany({});
			} catch {
				// Missing collection; ignore.
			}
		});

		test("mixes every model and counts each kind apart", async () => {
			await docs.insertMany([
				{ _id: "keep", n: 1 },
				{ _id: "change", n: 2 },
				{ _id: "gone", n: 3 },
			]);

			const result = await docs.bulkWrite([
				{ insertOne: { document: { _id: "new", n: 4 } } },
				{
					updateOne: { filter: { _id: "change" }, update: { $set: { n: 20 } } },
				},
				{ deleteOne: { filter: { _id: "gone" } } },
			]);

			expect(result.insertedCount).toBe(1);
			expect(result.matchedCount).toBe(1);
			expect(result.modifiedCount).toBe(1);
			expect(result.deletedCount).toBe(1);
			expect(result.upsertedCount).toBe(0);
		});

		test("keys insertedIds by the model's index, not by a count of inserts", async () => {
			const result = await docs.bulkWrite([
				{ deleteMany: { filter: { tag: "absent" } } },
				{ insertOne: { document: { _id: "a", n: 1 } } },
				{ insertOne: { document: { _id: "b", n: 2 } } },
			]);

			expect(result.insertedCount).toBe(2);
			expect(result.insertedIds[1]).toBe("a");
			expect(result.insertedIds[2]).toBe("b");
			expect(result.insertedIds[0]).toBeUndefined();
		});

		test("an upsert counts as upserted rather than matched", async () => {
			const result = await docs.bulkWrite([
				{
					updateOne: {
						filter: { _id: "made" },
						update: { $set: { n: 9 } },
						upsert: true,
					},
				},
			]);

			expect(result.upsertedCount).toBe(1);
			expect(result.matchedCount).toBe(0);
			expect(result.upsertedIds[0]).toBe("made");
			expect(await docs.findOne({ _id: "made" })).toMatchObject({ n: 9 });
		});

		test("updateMany reports every match", async () => {
			await docs.insertMany([
				{ _id: "a", tag: "x", n: 1 },
				{ _id: "b", tag: "x", n: 2 },
				{ _id: "c", tag: "y", n: 3 },
			]);

			const result = await docs.bulkWrite([
				{ updateMany: { filter: { tag: "x" }, update: { $set: { n: 0 } } } },
			]);

			expect(result.matchedCount).toBe(2);
			expect(result.modifiedCount).toBe(2);
		});

		test("a replace counts as a modification", async () => {
			await docs.insertOne({ _id: "r", n: 1, tag: "old" });

			const result = await docs.bulkWrite([
				{ replaceOne: { filter: { _id: "r" }, replacement: { n: 2 } } },
			]);

			expect(result.matchedCount).toBe(1);
			expect(result.modifiedCount).toBe(1);
			expect(await docs.findOne({ _id: "r" })).toMatchObject({ n: 2 });
		});

		test("an update that changes nothing is matched but not modified", async () => {
			// The rule that is easy to get wrong by counting matches twice.
			await docs.insertOne({ _id: "same", n: 5 });

			const result = await docs.bulkWrite([
				{ updateOne: { filter: { _id: "same" }, update: { $set: { n: 5 } } } },
			]);

			expect(result.matchedCount).toBe(1);
			expect(result.modifiedCount).toBe(0);
		});

		describe("when a model fails", () => {
			test("ordered keeps what came before and skips what comes after", async () => {
				await docs.insertOne({ _id: "dup", n: 0 });

				let caught: unknown;
				try {
					await docs.bulkWrite([
						{ insertOne: { document: { _id: "first", n: 1 } } },
						{ insertOne: { document: { _id: "dup", n: 2 } } },
						{ insertOne: { document: { _id: "third", n: 3 } } },
					]);
				} catch (error) {
					caught = error;
				}

				expect(caught).toBeDefined();
				const ids = (await docs.find({}).toArray()).map((d) => d._id).sort();
				expect(ids).toEqual(["dup", "first"]);
			});

			test("unordered attempts every model", async () => {
				await docs.insertOne({ _id: "dup", n: 0 });

				let caught: unknown;
				try {
					await docs.bulkWrite(
						[
							{ insertOne: { document: { _id: "first", n: 1 } } },
							{ insertOne: { document: { _id: "dup", n: 2 } } },
							{ insertOne: { document: { _id: "third", n: 3 } } },
						],
						{ ordered: false },
					);
				} catch (error) {
					caught = error;
				}

				expect(caught).toBeDefined();
				const ids = (await docs.find({}).toArray()).map((d) => d._id).sort();
				expect(ids).toEqual(["dup", "first", "third"]);
			});

			test("the error names the failing model by its index", async () => {
				await docs.insertOne({ _id: "dup", n: 0 });

				let caught: { writeErrors?: { index: number }[] } | undefined;
				try {
					await docs.bulkWrite([
						{ insertOne: { document: { _id: "ok", n: 1 } } },
						{ insertOne: { document: { _id: "dup", n: 2 } } },
					]);
				} catch (error) {
					caught = error as typeof caught;
				}

				expect(caught?.writeErrors?.[0]?.index).toBe(1);
			});
		});
	});
}
