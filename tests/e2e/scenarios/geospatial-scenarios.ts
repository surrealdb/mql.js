/**
 * Driver-agnostic geospatial parity scenarios.
 *
 * These run unchanged against a real `mongod` and against SurrealDB through
 * `@surrealdb/mql`, and every expectation below is a *result set* — which
 * documents matched, and in which order. That is the only kind of assertion that
 * catches what went wrong here before: `$geoWithin` returned an empty set for a
 * point plainly inside the polygon, with no error to notice.
 *
 * Two asymmetries are deliberate and are the divergences the README states:
 *
 *   - **the index.** MongoDB refuses `$near` without a `2dsphere` index;
 *     SurrealDB has no such index type, so the query is a full scan and
 *     `createIndex` refuses `2dsphere`. The provider says which it needs.
 *   - **the boundary.** MongoDB counts a point *on* a polygon's edge as within;
 *     SurrealDB's `INSIDE` counts only the interior. No case below places a
 *     point on an edge, because that is the one question the two answer
 *     differently.
 *
 * Everything else is expected to agree exactly, distance bounds included: a
 * metre bound is a MongoDB metre and the driver converts it to the metres
 * SurrealDB measures in, which the `$maxDistance` cases here are sized to detect.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
	MongoLikeClient,
	MongoLikeCollection,
	MongoLikeDb,
	MongoLikeFilter,
} from "../contracts/mongo-like.ts";
import type { DatabaseProvider } from "../providers/database-provider.ts";

interface PlaceDoc {
	[key: string]: unknown;
	_id?: unknown;
	name: string;
	loc?: unknown;
	stops?: unknown[];
}

const point = (x: number, y: number) => ({
	type: "Point",
	coordinates: [x, y],
});

/** A ring covering roughly the New York City area. */
const NYC = {
	type: "Polygon",
	coordinates: [
		[
			[-74.1, 40.6],
			[-73.8, 40.6],
			[-73.8, 40.9],
			[-74.1, 40.9],
			[-74.1, 40.6],
		],
	],
};

const NY = point(-73.9667, 40.78);
const NY_NEAR = point(-73.9, 40.75);
const FAR = point(50, 50);

/** The unit square, used wherever the exact coordinates do not matter. */
const UNIT_SQUARE = {
	type: "Polygon",
	coordinates: [
		[
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
			[0, 0],
		],
	],
};

export function registerGeospatialScenarios(provider: DatabaseProvider): void {
	describe(`E2E geospatial parity – ${provider.name}`, () => {
		let client: MongoLikeClient;
		let db: MongoLikeDb;
		let places: MongoLikeCollection<PlaceDoc>;
		let sequence = 0;

		/**
		 * A collection of its own per test.
		 *
		 * Not tidiness: MongoDB's `2dsphere` index refuses a document whose indexed
		 * field is not a geometry, so a test that stores a string there cannot share
		 * a collection with one that indexed it.
		 */
		function freshCollection(): MongoLikeCollection<PlaceDoc> {
			sequence += 1;
			places = db.collection<PlaceDoc>(`places_${sequence}`);
			return places;
		}

		beforeAll(async () => {
			client = await provider.start();
			db = client.db();
		}, 120_000);

		afterAll(async () => {
			await provider.stop();
		}, 30_000);

		/** The names the filter matches, in the order the engine returns them. */
		async function names(filter: MongoLikeFilter): Promise<string[]> {
			const docs = await places.find(filter).toArray();
			return docs.map((doc) => doc.name);
		}

		/** Seed the three points every `$near` case measures from. */
		async function seedPoints(): Promise<void> {
			freshCollection();
			await places.insertMany([
				{ name: "ny", loc: NY },
				{ name: "nynear", loc: NY_NEAR },
				{ name: "far", loc: FAR },
				{ name: "nogeo" },
			]);
			if (provider.requiresGeospatialIndex) {
				await places.createIndex({ loc: "2dsphere" });
			}
		}

		// -----------------------------------------------------------------
		// Storage
		// -----------------------------------------------------------------

		describe("storage", () => {
			test("GeoJSON is returned as the GeoJSON it was written as", async () => {
				await freshCollection().insertOne({ name: "ny", loc: NY });

				const found = await places.findOne({ name: "ny" });
				expect(found?.loc).toEqual(NY);
			});

			test("a geometry field is an object to $type, as it is to MongoDB", async () => {
				await freshCollection().insertMany([
					{ name: "ny", loc: NY },
					{ name: "nogeo" },
				]);

				expect(await names({ loc: { $type: "object" } })).toEqual(["ny"]);
			});

			test("every geometry type round-trips", async () => {
				const samples: Record<string, unknown> = {
					Point: point(1, 2),
					LineString: {
						type: "LineString",
						coordinates: [
							[0, 0],
							[1, 1],
						],
					},
					Polygon: UNIT_SQUARE,
					MultiPoint: {
						type: "MultiPoint",
						coordinates: [
							[0, 0],
							[1, 1],
						],
					},
					MultiLineString: {
						type: "MultiLineString",
						coordinates: [
							[
								[0, 0],
								[1, 1],
							],
						],
					},
					MultiPolygon: {
						type: "MultiPolygon",
						coordinates: [UNIT_SQUARE.coordinates],
					},
					GeometryCollection: {
						type: "GeometryCollection",
						geometries: [point(0, 0)],
					},
				};

				for (const [name, geometry] of Object.entries(samples)) {
					await freshCollection().insertOne({ name, loc: geometry });
					const found = await places.findOne({ name });
					expect(found?.loc).toEqual(geometry);
				}
			});

			test("a geometry nested in a document and in an array round-trips", async () => {
				await freshCollection().insertOne({
					name: "trip",
					loc: { at: NY },
					stops: [NY, FAR],
				});

				const found = await places.findOne({ name: "trip" });
				expect(found?.loc).toEqual({ at: NY });
				expect(found?.stops).toEqual([NY, FAR]);
			});

			test("a geometry written by $set round-trips and is queryable", async () => {
				await freshCollection().insertOne({ name: "later" });
				await places.updateOne({ name: "later" }, { $set: { loc: NY } });

				expect(
					await names({ loc: { $geoWithin: { $geometry: NYC } } }),
				).toEqual(["later"]);
			});
		});

		// -----------------------------------------------------------------
		// $geoWithin
		// -----------------------------------------------------------------

		describe("$geoWithin", () => {
			test("$geometry matches the points inside the polygon", async () => {
				await seedPoints();
				expect(
					await names({ loc: { $geoWithin: { $geometry: NYC } } }),
				).toEqual(["ny", "nynear"]);
			});

			test("$geometry matches a contained shape but not a straddling one", async () => {
				await freshCollection().insertMany([
					{
						name: "contained",
						loc: {
							type: "Polygon",
							coordinates: [
								[
									[0.1, 0.1],
									[0.2, 0.1],
									[0.2, 0.2],
									[0.1, 0.2],
									[0.1, 0.1],
								],
							],
						},
					},
					{
						name: "straddling",
						loc: {
							type: "Polygon",
							coordinates: [
								[
									[0.5, 0.5],
									[5, 0.5],
									[5, 5],
									[0.5, 5],
									[0.5, 0.5],
								],
							],
						},
					},
				]);

				expect(
					await names({ loc: { $geoWithin: { $geometry: UNIT_SQUARE } } }),
				).toEqual(["contained"]);
			});

			test("a point exactly on the boundary is within, in every form", async () => {
				await freshCollection().insertMany([
					{ name: "corner", loc: point(0, 0) },
					{ name: "edge", loc: point(1, 0.5) },
					{ name: "interior", loc: point(0.5, 0.5) },
					{ name: "outside", loc: point(2, 2) },
				]);
				if (provider.requiresGeospatialIndex) {
					await places.createIndex({ loc: "2dsphere" });
				}

				// An interior-only containment test would drop `corner` and `edge`, so
				// this pins the one place the two engines could disagree by a whole
				// document rather than by a rounding step.
				const expected = ["corner", "edge", "interior"];
				for (const shape of [
					{ $geometry: UNIT_SQUARE },
					{
						$box: [
							[0, 0],
							[1, 1],
						],
					},
					{
						$polygon: [
							[0, 0],
							[1, 0],
							[1, 1],
							[0, 1],
						],
					},
				]) {
					expect((await names({ loc: { $geoWithin: shape } })).sort()).toEqual(
						expected,
					);
				}
			});

			test("$box matches the points its corners enclose", async () => {
				await seedPoints();
				expect(
					await names({
						loc: {
							$geoWithin: {
								$box: [
									[-74.1, 40.6],
									[-73.8, 40.9],
								],
							},
						},
					}),
				).toEqual(["ny", "nynear"]);
			});

			test("$box accepts its corners in either order", async () => {
				await seedPoints();
				expect(
					await names({
						loc: {
							$geoWithin: {
								$box: [
									[-73.8, 40.9],
									[-74.1, 40.6],
								],
							},
						},
					}),
				).toEqual(["ny", "nynear"]);
			});

			test("$polygon is measured flat, not along great circles", async () => {
				await freshCollection().insertMany([
					{ name: "p0", loc: point(0, 0) },
					{ name: "p1", loc: point(1, 0) },
					{ name: "p2", loc: point(2, 0) },
				]);

				// The hypotenuse from (-1, -1) to (1.4, 1) passes above (0, 0) and below
				// (1, 0), so a flat ring excludes p0 and a geodesic one would not.
				expect(
					await names({
						loc: {
							$geoWithin: {
								$polygon: [
									[-1, -1],
									[1.4, -1],
									[1.4, 1],
								],
							},
						},
					}),
				).toEqual(["p1"]);
			});

			test("$center takes its radius in degrees", async () => {
				await freshCollection().insertMany([
					{ name: "p0", loc: point(0, 0) },
					{ name: "p1", loc: point(1, 0) },
					{ name: "p2", loc: point(2, 0) },
				]);

				expect(
					await names({ loc: { $geoWithin: { $center: [[0, 0], 1.5] } } }),
				).toEqual(["p0", "p1"]);
			});

			test("$centerSphere takes its radius in radians", async () => {
				await freshCollection().insertMany([
					{ name: "p0", loc: point(0, 0) },
					{ name: "p1", loc: point(1, 0) },
					{ name: "p2", loc: point(2, 0) },
				]);

				expect(
					await names({
						loc: {
							$geoWithin: { $centerSphere: [[0, 0], (1.5 * Math.PI) / 180] },
						},
					}),
				).toEqual(["p0", "p1"]);
			});

			test("a legacy shape matches point-valued fields only", async () => {
				await freshCollection().insertMany([
					{ name: "pt", loc: point(0.5, 0.5) },
					{
						name: "poly",
						loc: {
							type: "Polygon",
							coordinates: [
								[
									[0.2, 0.2],
									[0.4, 0.2],
									[0.4, 0.4],
									[0.2, 0.4],
									[0.2, 0.2],
								],
							],
						},
					},
				]);

				expect(
					await names({
						loc: {
							$geoWithin: {
								$box: [
									[0, 0],
									[1, 1],
								],
							},
						},
					}),
				).toEqual(["pt"]);
			});

			test("an array of geometries matches if any element does", async () => {
				await freshCollection().insertMany([
					{ name: "hit", stops: [NY, FAR] },
					{ name: "miss", stops: [FAR] },
				]);

				expect(
					await names({ stops: { $geoWithin: { $geometry: NYC } } }),
				).toEqual(["hit"]);
			});

			test("a field holding no geometry matches nothing", async () => {
				await freshCollection().insertMany([
					{ name: "ny", loc: NY },
					{ name: "nogeo" },
					{ name: "strloc", loc: "hello" },
				]);

				expect(
					await names({ loc: { $geoWithin: { $geometry: NYC } } }),
				).toEqual(["ny"]);
			});
		});

		// -----------------------------------------------------------------
		// $geoIntersects
		// -----------------------------------------------------------------

		describe("$geoIntersects", () => {
			test("matches anything overlapping, contained or not", async () => {
				await freshCollection().insertMany([
					{ name: "contained", loc: point(0.5, 0.5) },
					{
						name: "straddling",
						loc: {
							type: "LineString",
							coordinates: [
								[0.5, 0.5],
								[5, 5],
							],
						},
					},
					{ name: "outside", loc: point(9, 9) },
				]);

				const matched = await names({
					loc: { $geoIntersects: { $geometry: UNIT_SQUARE } },
				});
				expect(matched.slice().sort()).toEqual(["contained", "straddling"]);
			});

			test("a point geometry matches the documents holding that point", async () => {
				await freshCollection().insertMany([
					{ name: "ny", loc: NY },
					{ name: "far", loc: FAR },
				]);

				expect(
					await names({ loc: { $geoIntersects: { $geometry: NY } } }),
				).toEqual(["ny"]);
			});

			test("an array of geometries matches if any element does", async () => {
				await freshCollection().insertMany([
					{ name: "hit", stops: [point(0.5, 0.5), point(9, 9)] },
					{ name: "miss", stops: [point(9, 9)] },
				]);

				expect(
					await names({
						stops: { $geoIntersects: { $geometry: UNIT_SQUARE } },
					}),
				).toEqual(["hit"]);
			});
		});

		// -----------------------------------------------------------------
		// $near / $nearSphere
		// -----------------------------------------------------------------

		describe("$near", () => {
			test("returns every document with a point, nearest first", async () => {
				await seedPoints();
				expect(await names({ loc: { $near: { $geometry: NY } } })).toEqual([
					"ny",
					"nynear",
					"far",
				]);
			});

			test("$maxDistance and $minDistance bound the band in metres", async () => {
				await seedPoints();

				expect(
					await names({
						loc: { $near: { $geometry: NY, $maxDistance: 20000 } },
					}),
				).toEqual(["ny", "nynear"]);
				expect(
					await names({
						loc: {
							$near: { $geometry: NY, $minDistance: 1, $maxDistance: 20000 },
						},
					}),
				).toEqual(["nynear"]);
				expect(
					await names({
						loc: { $near: { $geometry: NY, $minDistance: 20000 } },
					}),
				).toEqual(["far"]);
			});

			test("a metre bound means the same distance on both engines", async () => {
				await freshCollection().insertMany([
					{ name: "here", loc: point(0, 0) },
					{ name: "adegree", loc: point(0, 1) },
				]);
				if (provider.requiresGeospatialIndex) {
					await places.createIndex({ loc: "2dsphere" });
				}

				// A degree of latitude is 111 318.8 m on MongoDB's sphere and
				// 111 195.1 m on SurrealDB's, so a bound between the two separates a
				// converted metre from a passed-through one.
				expect(
					await names({
						loc: { $near: { $geometry: point(0, 0), $maxDistance: 111_250 } },
					}),
				).toEqual(["here"]);
				expect(
					await names({
						loc: { $near: { $geometry: point(0, 0), $maxDistance: 111_400 } },
					}),
				).toEqual(["here", "adegree"]);
			});

			test("$nearSphere with a $geometry point behaves as $near does", async () => {
				await seedPoints();
				expect(
					await names({
						loc: { $nearSphere: { $geometry: NY, $maxDistance: 20000 } },
					}),
				).toEqual(["ny", "nynear"]);
			});

			test("$nearSphere with a coordinate pair takes its bound in radians", async () => {
				await seedPoints();
				expect(
					await names({
						loc: {
							$nearSphere: [-73.9667, 40.78],
							$maxDistance: 20000 / 6_378_100,
						},
					}),
				).toEqual(["ny", "nynear"]);
			});

			test("an explicit sort replaces the distance ordering", async () => {
				await seedPoints();
				const docs = await places
					.find({ loc: { $near: { $geometry: NY } } })
					.sort({ name: -1 })
					.toArray();

				expect(docs.map((doc) => doc.name)).toEqual(["nynear", "ny", "far"]);
			});

			test("limit and skip apply after the distance ordering", async () => {
				await seedPoints();

				const limited = await places
					.find({ loc: { $near: { $geometry: NY } } })
					.limit(2)
					.toArray();
				expect(limited.map((doc) => doc.name)).toEqual(["ny", "nynear"]);

				const skipped = await places
					.find({ loc: { $near: { $geometry: NY } } })
					.skip(1)
					.toArray();
				expect(skipped.map((doc) => doc.name)).toEqual(["nynear", "far"]);
			});

			test("composes with an ordinary condition", async () => {
				await seedPoints();
				expect(
					await names({
						name: { $ne: "nynear" },
						loc: { $near: { $geometry: NY } },
					}),
				).toEqual(["ny", "far"]);
			});

			test("returns nothing extra: the distance is not added to the documents", async () => {
				await seedPoints();
				const docs = await places
					.find({ loc: { $near: { $geometry: NY } } })
					.toArray();

				for (const doc of docs) {
					expect(Object.keys(doc).slice().sort()).toEqual([
						"_id",
						"loc",
						"name",
					]);
				}
			});

			test("must be a top-level expression", async () => {
				await seedPoints();

				// Both engines refuse an ordering that cannot hold for every row
				// returned. MongoDB says `geo $near must be top-level expr`.
				for (const filter of [
					{ $or: [{ loc: { $near: { $geometry: NY } } }, { name: "nogeo" }] },
					{ $nor: [{ loc: { $near: { $geometry: NY } } }] },
					{ loc: { $not: { $near: { $geometry: NY } } } },
				]) {
					await expect(places.find(filter).toArray()).rejects.toThrow();
				}
			});

			test("a single-branch $or still carries the ordering", async () => {
				await seedPoints();

				expect(
					await names({ $or: [{ loc: { $near: { $geometry: NY } } }] }),
				).toEqual(["ny", "nynear", "far"]);
			});

			test("deleteMany removes exactly the band", async () => {
				await seedPoints();

				const result = await places.deleteMany({
					loc: { $near: { $geometry: NY, $maxDistance: 20000 } },
				});
				expect(result.deletedCount).toBe(2);
				expect((await names({})).slice().sort()).toEqual(["far", "nogeo"]);
			});

			test("updateMany updates exactly the band", async () => {
				await seedPoints();

				const result = await places.updateMany(
					{ loc: { $near: { $geometry: NY, $maxDistance: 20000 } } },
					{ $set: { visited: true } },
				);
				expect(result.matchedCount).toBe(2);
			});
		});
	});
}
