/**
 * Driver-agnostic scenarios for three shapes where what MongoDB answers is the
 * entire question.
 *
 * Every expectation here is a *result*: which documents came back, which fields
 * each one carries, and in what order. That is the only kind of assertion worth
 * making about these, because a driver can be self-consistently wrong about all
 * three and no unit test against it alone would call it wrong.
 *
 *   - **a projection composed with a sort.** Which fields a projected document
 *     carries, and which order a sorted read returns them in, are decided
 *     independently, and the corners where they interact — `_id` arriving
 *     unasked, an exclusion projection hiding the very field the read ordered by,
 *     a dotted path — are easy to get individually right and jointly wrong.
 *   - **a read of a collection that was never written to.** SurrealDB refuses to
 *     read a table it has no definition for; MongoDB treats it as empty.
 *   - **an empty filter on `replaceOne` / `findOneAndReplace`.** MongoDB replaces
 *     the first matching document.
 *
 * One shape is deliberately absent: an inclusion projection sorted by a field it
 * does not name. SurrealDB requires every `ORDER BY` idiom to appear in the
 * statement's own field list, MongoDB requires nothing of the kind, and the two
 * engines therefore cannot be asked the same question — `@surrealdb/mql` refuses
 * that read and says so. `tests/integration/sort-projection.test.ts` pins the
 * refusal, shape by shape, against the engine that has the constraint.
 *
 * Where the two engines legitimately differ elsewhere, the scenario asserts the
 * part they agree on rather than pretending otherwise. "First" with no sort means
 * natural order to both, but natural order is not a promised property of either,
 * so the empty-filter cases assert that *exactly one* document was replaced and
 * the rest were untouched — which is the guarantee MongoDB documents.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
	MongoLikeClient,
	MongoLikeCollection,
	MongoLikeDb,
	MongoLikeDocument,
} from "../contracts/mongo-like.ts";
import type { DatabaseProvider } from "../providers/database-provider.ts";

interface TaggedDoc {
	[key: string]: unknown;
	_id?: unknown;
	tag?: string;
	k?: number;
	extra?: number;
	a?: { b?: number; c?: string };
}

export function registerParityGapScenarios(provider: DatabaseProvider): void {
	describe(`E2E parity gaps – ${provider.name}`, () => {
		let client: MongoLikeClient;
		let db: MongoLikeDb;
		let sequence = 0;

		/**
		 * A collection of its own per test.
		 *
		 * The missing-collection cases need a name nothing has ever written to, and
		 * SurrealDB's in-memory store keeps data for the lifetime of the server, so a
		 * shared name would be defined by the time the second test asked.
		 */
		function fresh(prefix: string): MongoLikeCollection<TaggedDoc> {
			sequence += 1;
			return db.collection<TaggedDoc>(`${prefix}_${sequence}`);
		}

		beforeAll(async () => {
			client = await provider.start();
			db = client.db();
		}, 120_000);

		afterAll(async () => {
			await provider.stop();
		}, 30_000);

		/** Three documents whose `_id`, `tag` and `k` orders are all different. */
		async function seeded(): Promise<MongoLikeCollection<TaggedDoc>> {
			const coll = fresh("gaps");
			await coll.insertMany([
				{ _id: 1, tag: "t1", k: 3, extra: 1, a: { b: 2, c: "c1" } },
				{ _id: 2, tag: "t2", k: 1, extra: 2, a: { b: 3, c: "c2" } },
				{ _id: 3, tag: "t3", k: 2, extra: 3, a: { b: 1, c: "c3" } },
			]);
			return coll;
		}

		// -----------------------------------------------------------------
		// A projection composed with a sort
		// -----------------------------------------------------------------

		describe("a projection composed with a sort", () => {
			test("returns the projected documents in sort order", async () => {
				const coll = await seeded();

				const found = await coll
					.find({}, { projection: { tag: 1, k: 1 }, sort: { k: 1 } })
					.toArray();

				// `_id` comes back because MongoDB includes it unless asked not to, and
				// `extra` does not, because the projection did not ask for it.
				expect(found).toEqual([
					{ _id: 2, tag: "t2", k: 1 },
					{ _id: 3, tag: "t3", k: 2 },
					{ _id: 1, tag: "t1", k: 3 },
				]);
			});

			test("findOne returns the first of them", async () => {
				const coll = await seeded();

				const found = await coll.findOne(
					{},
					{ projection: { tag: 1, k: 1 }, sort: { k: 1 } },
				);

				expect(found).toEqual({ _id: 2, tag: "t2", k: 1 });
			});

			test("sorts on several fields, in the order they were given", async () => {
				const coll = await seeded();

				const found = await coll
					.find(
						{},
						{
							projection: { tag: 1, k: 1, extra: 1 },
							sort: { extra: -1, k: 1 },
						},
					)
					.toArray();

				expect(found).toEqual([
					{ _id: 3, tag: "t3", k: 2, extra: 3 },
					{ _id: 2, tag: "t2", k: 1, extra: 2 },
					{ _id: 1, tag: "t1", k: 3, extra: 1 },
				]);
			});

			test("sorts on a dotted path, projecting that path alone", async () => {
				const coll = await seeded();

				const found = await coll
					.find({}, { projection: { "a.b": 1 }, sort: { "a.b": 1 } })
					.toArray();

				// A dotted projection reshapes the sub-document: `a` comes back holding
				// `b` and not `c`, and the ordering is by the value inside it.
				expect(found).toEqual([
					{ _id: 3, a: { b: 1 } },
					{ _id: 1, a: { b: 2 } },
					{ _id: 2, a: { b: 3 } },
				]);
			});

			test("pages the sorted, projected set", async () => {
				const coll = await seeded();

				const page = await coll
					.find({}, { projection: { tag: 1, k: 1 }, sort: { k: 1 } })
					.skip(1)
					.limit(1)
					.toArray();

				expect(page).toEqual([{ _id: 3, tag: "t3", k: 2 }]);
			});

			test("holds however the cursor was chained", async () => {
				const coll = await seeded();
				const expected: MongoLikeDocument[] = [
					{ _id: 2, tag: "t2", k: 1 },
					{ _id: 3, tag: "t3", k: 2 },
					{ _id: 1, tag: "t1", k: 3 },
				];

				expect(
					await coll
						.find({})
						.project({ tag: 1, k: 1 })
						.sort({ k: 1 })
						.toArray(),
				).toEqual(expected);
				expect(
					await coll
						.find({})
						.sort({ k: 1 })
						.project({ tag: 1, k: 1 })
						.toArray(),
				).toEqual(expected);
			});

			test("an exclusion projection hides the field it sorted by", async () => {
				const coll = await seeded();

				const found = await coll
					.find({}, { projection: { k: 0, extra: 0, a: 0 }, sort: { k: 1 } })
					.toArray();

				// The read is ordered by `k` and no document that comes back carries one.
				expect(found).toEqual([
					{ _id: 2, tag: "t2" },
					{ _id: 3, tag: "t3" },
					{ _id: 1, tag: "t1" },
				]);
			});

			test("a projection of _id alone returns only _id", async () => {
				const coll = await seeded();

				const found = await coll
					.find({}, { projection: { _id: 1 }, sort: { _id: -1 } })
					.toArray();

				// Naming one field to include means one field comes back, even when the
				// field named is the identity.
				expect(found).toEqual([{ _id: 3 }, { _id: 2 }, { _id: 1 }]);
			});

			test("a projection that suppresses _id returns neither it nor the rest", async () => {
				const coll = await seeded();

				const found = await coll
					.find({}, { projection: { tag: 1, _id: 0 }, sort: { tag: -1 } })
					.toArray();

				expect(found).toEqual([{ tag: "t3" }, { tag: "t2" }, { tag: "t1" }]);
			});

			test("an inclusion projection alone still carries _id", async () => {
				const coll = await seeded();

				const found = await coll
					.find({}, { projection: { tag: 1 } })
					.sort({ _id: 1 })
					.toArray();

				expect(found).toEqual([
					{ _id: 1, tag: "t1" },
					{ _id: 2, tag: "t2" },
					{ _id: 3, tag: "t3" },
				]);
			});
		});

		// -----------------------------------------------------------------
		// A collection that does not exist
		// -----------------------------------------------------------------

		describe("a collection that was never written to", () => {
			test("find answers with no documents", async () => {
				expect(await fresh("void").find({}).toArray()).toEqual([]);
			});

			test("find answers empty however it is projected and sorted", async () => {
				// The sorted-and-projected read is a different statement shape, so it
				// has to tolerate the missing table too.
				expect(
					await fresh("void")
						.find({}, { projection: { tag: 1, k: 1 }, sort: { k: 1 } })
						.toArray(),
				).toEqual([]);
			});

			test("findOne answers null", async () => {
				expect(await fresh("void").findOne({})).toBeNull();
			});

			test("iterating a cursor yields nothing", async () => {
				expect(await fresh("void").find({}).next()).toBeNull();
			});

			test("countDocuments and estimatedDocumentCount answer zero", async () => {
				expect(await fresh("void").countDocuments({})).toBe(0);
				expect(await fresh("void").estimatedDocumentCount()).toBe(0);
			});

			test("distinct answers with no values", async () => {
				expect(await fresh("void").distinct("tag")).toEqual([]);
			});

			test("deleteOne and deleteMany report nothing deleted", async () => {
				expect((await fresh("void").deleteOne({ tag: "t" })).deletedCount).toBe(
					0,
				);
				expect((await fresh("void").deleteMany({})).deletedCount).toBe(0);
			});

			test("updateOne and updateMany report nothing matched", async () => {
				const one = await fresh("void").updateOne(
					{ tag: "t" },
					{ $set: { k: 1 } },
				);
				expect(one.matchedCount).toBe(0);
				expect(one.modifiedCount).toBe(0);

				const many = await fresh("void").updateMany({}, { $set: { k: 1 } });
				expect(many.matchedCount).toBe(0);
			});

			test("replaceOne reports nothing matched", async () => {
				const result = await fresh("void").replaceOne({ tag: "t" }, { k: 1 });
				expect(result.matchedCount).toBe(0);
				expect(result.modifiedCount).toBe(0);
			});

			test("all three findOneAnd* answer null", async () => {
				expect(
					await fresh("void").findOneAndUpdate(
						{ tag: "t" },
						{ $set: { k: 1 } },
					),
				).toBeNull();
				expect(await fresh("void").findOneAndDelete({ tag: "t" })).toBeNull();
				expect(
					await fresh("void").findOneAndReplace({ tag: "t" }, { k: 1 }),
				).toBeNull();
			});

			test("an upsert creates the collection rather than being told it is empty", async () => {
				const coll = fresh("void");

				const result = await coll.updateOne(
					{ tag: "seed" },
					{ $set: { k: 7 } },
					{ upsert: true },
				);

				expect(result.matchedCount).toBe(0);
				expect(result.upsertedId).not.toBeNull();
				const stored = await coll.find({}).toArray();
				expect(stored).toHaveLength(1);
				expect(stored[0].tag).toBe("seed");
				expect(stored[0].k).toBe(7);
			});

			test("an insert creates the collection", async () => {
				const coll = fresh("void");
				await coll.insertOne({ tag: "first" });
				expect(await coll.countDocuments({})).toBe(1);
			});
		});

		// -----------------------------------------------------------------
		// An empty filter on a replacement
		// -----------------------------------------------------------------

		describe("an empty filter on a replacement", () => {
			test("replaceOne replaces exactly one document", async () => {
				const coll = await seeded();

				const result = await coll.replaceOne({}, { tag: "replaced", k: 99 });

				expect(result.matchedCount).toBe(1);
				expect(result.modifiedCount).toBe(1);

				// Which one is natural order, which neither engine promises — but that
				// it was one of them, and that the other two are untouched, both do.
				const after = await coll.find({}).sort({ _id: 1 }).toArray();
				expect(after).toHaveLength(3);
				expect(after.filter((d) => d.tag === "replaced")).toHaveLength(1);
				const untouched = after.filter((d) => d.tag !== "replaced");
				expect(untouched.every((d) => d.extra !== undefined)).toBe(true);
			});

			test("findOneAndReplace returns the document it replaced", async () => {
				const coll = await seeded();

				const before = await coll.findOneAndReplace({}, { tag: "replaced" });

				// The pre-image is one of the seeded documents, complete — the default
				// `returnDocument` is `"before"`.
				expect(before).not.toBeNull();
				expect(["t1", "t2", "t3"]).toContain(before?.tag ?? "");
				expect(before?.k).toBeDefined();

				const after = await coll.find({}).toArray();
				expect(after.filter((d) => d.tag === "replaced")).toHaveLength(1);
			});

			test("a sort decides which document an empty filter replaces", async () => {
				const coll = await seeded();

				const before = await coll.findOneAndReplace(
					{},
					{ tag: "replaced" },
					{ sort: { k: -1 } },
				);

				// `k: 3` is the largest, so it is the document a descending sort names.
				expect(before?.tag).toBe("t1");
				expect(before?.k).toBe(3);
			});

			test("an empty filter matching nothing reports nothing matched", async () => {
				const coll = fresh("empty");
				await coll.insertOne({ tag: "gone" });
				await coll.deleteMany({});

				const result = await coll.replaceOne({}, { tag: "replaced" });

				expect(result.matchedCount).toBe(0);
				expect(result.modifiedCount).toBe(0);
			});

			test("an empty filter with upsert inserts the replacement", async () => {
				const coll = fresh("empty");

				const result = await coll.replaceOne(
					{},
					{ tag: "created" },
					{
						upsert: true,
					},
				);

				expect(result.upsertedId).not.toBeNull();
				const stored = await coll.find({}).toArray();
				expect(stored).toHaveLength(1);
				expect(stored[0].tag).toBe("created");
			});
		});
	});
}
