/**
 * Geospatial queries against a real server.
 *
 * Every assertion here is about a *result set*, because that is where the
 * previous shape failed: `$geoWithin` and `$geoIntersects` returned `[]` for a
 * point plainly inside the polygon — no error, just nothing — and `$near` did not
 * parse at all. A test that only inspects generated SurrealQL cannot tell either
 * of those from a working query, so these run the query.
 *
 * The storage half is checked the same way as the BSON values are: a geometry
 * that survives the write but comes back as something else still compares equal
 * to filters encoded the same wrong way, so each case reads the value back and
 * asserts on the GeoJSON it returns with, in every position a value can occupy.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { GeometryPoint } from "surrealdb";
import type { Collection, Db } from "../../src/index.ts";
import {
	MongoCompatibilityError,
	MongoInvalidArgumentError,
} from "../../src/index.ts";
import type { Document } from "../../src/types.ts";
import { setupSurreal, teardownSurreal } from "./helpers.ts";

const PORT = 18139;

interface Place extends Document {
	_id?: string;
	name?: string;
	loc?: unknown;
	shape?: unknown;
	place?: { loc?: unknown };
	stops?: unknown[];
	tags?: string[];
}

let proc: Subprocess;
let client: Parameters<typeof teardownSurreal>[0]["client"];
let db: Db;
let seq = 0;

/** A fresh collection per test: the server keeps data between them. */
function freshCollection(): Collection<Place> {
	seq += 1;
	return db.collection<Place>(`geo_${seq}`);
}

const point = (x: number, y: number) => ({
	type: "Point" as const,
	coordinates: [x, y],
});

/** A box around lower Manhattan, closed as GeoJSON requires. */
const MANHATTAN = {
	type: "Polygon" as const,
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

/** Three points, one far outside, plus documents with nothing geospatial in them. */
async function seedPlaces(): Promise<Collection<Place>> {
	const col = freshCollection();
	await col.insertMany([
		{ name: "ny", loc: NY },
		{ name: "nynear", loc: NY_NEAR },
		{ name: "far", loc: FAR },
		{ name: "nogeo" },
		{ name: "strloc", loc: "hello" },
	]);
	return col;
}

async function names(
	col: Collection<Place>,
	filter: Document,
	options?: Parameters<Collection<Place>["find"]>[1],
): Promise<(string | undefined)[]> {
	const docs = await col.find(filter, options).toArray();
	return docs.map((doc) => doc.name);
}

beforeAll(async () => {
	const ctx = await setupSurreal<Place>(PORT, "geodb");
	proc = ctx.process;
	client = ctx.client;
	db = ctx.db;
});

afterAll(async () => {
	await teardownSurreal({ process: proc, client } as never);
});

describe("storing a geometry", () => {
	test("a top-level field reads back as the GeoJSON it was written as", async () => {
		const col = freshCollection();
		await col.insertOne({ name: "ny", loc: NY });

		const found = await col.findOne({ name: "ny" });
		expect(found?.loc).toEqual(NY);
		// The value a caller will `JSON.stringify`, which is what MongoDB returns.
		expect(JSON.stringify(found?.loc)).toBe(JSON.stringify(NY));
	});

	test("all seven geometry types survive the round trip", async () => {
		const samples: Record<string, unknown> = {
			Point: point(1, 2),
			LineString: {
				type: "LineString",
				coordinates: [
					[0, 0],
					[1, 1],
					[2, 0],
				],
			},
			Polygon: MANHATTAN,
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
					[
						[2, 2],
						[3, 3],
					],
				],
			},
			MultiPolygon: {
				type: "MultiPolygon",
				coordinates: [MANHATTAN.coordinates],
			},
			GeometryCollection: {
				type: "GeometryCollection",
				geometries: [point(0, 0), MANHATTAN],
			},
		};

		const col = freshCollection();
		for (const [name, geometry] of Object.entries(samples)) {
			await col.insertOne({ name, loc: geometry });
			const found = await col.findOne({ name });
			expect(found?.loc).toEqual(geometry);
		}
	});

	test("a nested field, an array element and an array of sub-documents", async () => {
		const col = freshCollection();
		await col.insertOne({
			name: "trip",
			place: { loc: NY },
			stops: [NY, FAR, { at: NY_NEAR }],
		});

		const found = await col.findOne({ name: "trip" });
		expect(found?.place?.loc).toEqual(NY);
		expect(found?.stops?.[0]).toEqual(NY);
		expect(found?.stops?.[1]).toEqual(FAR);
		expect((found?.stops?.[2] as { at: unknown }).at).toEqual(NY_NEAR);
	});

	test("a geometry written by $set is queryable, not merely stored", async () => {
		const col = freshCollection();
		await col.insertOne({ name: "later" });
		await col.updateOne({ name: "later" }, { $set: { loc: NY } });

		expect(
			await names(col, { loc: { $geoWithin: { $geometry: MANHATTAN } } }),
		).toEqual(["later"]);
	});

	test("a geometry pushed onto an array is queryable", async () => {
		const col = freshCollection();
		await col.insertOne({ name: "route", stops: [] });
		await col.updateOne({ name: "route" }, { $push: { stops: NY } });

		const found = await col.findOne({ name: "route" });
		expect(found?.stops).toEqual([NY]);
		expect(
			await names(col, { stops: { $geoIntersects: { $geometry: MANHATTAN } } }),
		).toEqual(["route"]);
	});

	test("an SDK geometry a caller passes in comes back as GeoJSON", async () => {
		const col = freshCollection();
		await col.insertOne({
			name: "sdk",
			loc: new GeometryPoint([-73.9667, 40.78]),
		});

		const found = await col.findOne({ name: "sdk" });
		expect(found?.loc).toEqual(NY);
	});

	test("an object with a field beside the coordinates is stored as written", async () => {
		const col = freshCollection();
		const labelled = { type: "Point", coordinates: [1, 2], label: "home" };
		await col.insertOne({ name: "labelled", loc: labelled });

		// Converting it would have dropped `label`, so it stays a plain object —
		// and, being one, matches no geospatial query.
		const found = await col.findOne({ name: "labelled" });
		expect(found?.loc).toEqual(labelled);
	});

	test("half-formed GeoJSON is refused rather than stored unqueryable", async () => {
		const col = freshCollection();
		await expect(
			col.insertOne({
				name: "open",
				loc: {
					type: "Polygon",
					coordinates: [
						[
							[0, 0],
							[1, 0],
							[1, 1],
							[0, 1],
						],
					],
				},
			}),
		).rejects.toThrow(MongoInvalidArgumentError);
	});

	test("a document that is nothing but a geometry names the way round it", async () => {
		const col = freshCollection();
		await expect(col.insertOne({ ...NY } as Place)).rejects.toThrow(
			MongoCompatibilityError,
		);
	});

	test("a geometry field answers $type 'object', as it does in MongoDB", async () => {
		const col = freshCollection();
		await col.insertMany([
			{ name: "geo", loc: NY },
			{ name: "obj", loc: { a: 1 } as unknown as Place["loc"] },
			{ name: "str", loc: "here" as unknown as Place["loc"] },
		]);

		// The geometry SurrealDB stores is not one of its objects, but the value the
		// caller wrote and reads back is a JSON object, and MongoDB reports one.
		expect((await names(col, { loc: { $type: "object" } })).sort()).toEqual([
			"geo",
			"obj",
		]);
	});

	test("a legacy coordinate pair is data, and matches no geospatial query", async () => {
		const col = freshCollection();
		await col.insertMany([
			{ name: "pair", loc: [-73.9667, 40.78] as unknown as Place["loc"] },
			{
				name: "object",
				loc: { lng: -73.9667, lat: 40.78 } as unknown as Place["loc"],
			},
			{ name: "geojson", loc: NY },
		]);

		// MongoDB reads both of the first two as points and matches them. Only
		// GeoJSON becomes a SurrealDB geometry here, so only GeoJSON is found —
		// a divergence worth pinning, because the two forms fail silently rather
		// than by refusing the query.
		expect(
			await names(col, { loc: { $geoWithin: { $geometry: MANHATTAN } } }),
		).toEqual(["geojson"]);
		expect(
			await names(col, {
				loc: {
					$geoWithin: {
						$box: [
							[-74, 40.7],
							[-73.9, 40.8],
						],
					},
				},
			}),
		).toEqual(["geojson"]);
		expect(await names(col, { loc: { $near: { $geometry: NY } } })).toEqual([
			"geojson",
		]);
	});

	test("a position carrying an altitude is refused rather than losing it", async () => {
		const col = freshCollection();

		// MongoDB stores `[lng, lat, alt]` and ignores the altitude when it indexes.
		// SurrealDB's geometry holds two ordinates, so accepting this would mean
		// silently dropping what the caller wrote.
		await expect(
			col.insertOne({
				name: "withAltitude",
				loc: {
					type: "Point",
					coordinates: [1, 2, 300],
				} as unknown as Place["loc"],
			}),
		).rejects.toThrow(MongoInvalidArgumentError);
	});
});

describe("$geoWithin", () => {
	test("matches the points inside the polygon and nothing else", async () => {
		const col = await seedPlaces();
		expect(
			await names(col, { loc: { $geoWithin: { $geometry: MANHATTAN } } }),
		).toEqual(["ny", "nynear"]);
	});

	test("matches a whole shape contained in the polygon, not one merely overlapping", async () => {
		const col = freshCollection();
		await col.insertMany([
			{
				name: "inside",
				shape: {
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
				shape: {
					type: "Polygon",
					coordinates: [
						[
							[-5, -5],
							[5, -5],
							[5, 5],
							[-5, 5],
							[-5, -5],
						],
					],
				},
			},
		]);

		const unitSquare = {
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
		expect(
			await names(col, { shape: { $geoWithin: { $geometry: unitSquare } } }),
		).toEqual(["inside"]);
	});

	test("$box matches the same points as the equivalent polygon", async () => {
		const col = await seedPlaces();
		expect(
			await names(col, {
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

	test("$polygon matches inside its ring, planar as MongoDB measures it", async () => {
		const col = freshCollection();
		await col.insertMany([
			{ name: "p0", loc: point(0, 0) },
			{ name: "p1", loc: point(1, 0) },
			{ name: "p2", loc: point(2, 0) },
		]);

		// The hypotenuse of this triangle passes below (0, 0) and above (1, 0), which
		// is what tells a flat ring from a geodesic one.
		expect(
			await names(col, {
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

	test("$center is a circle in degrees; $centerSphere the same circle in radians", async () => {
		const col = freshCollection();
		await col.insertMany([
			{ name: "p0", loc: point(0, 0) },
			{ name: "p1", loc: point(1, 0) },
			{ name: "p2", loc: point(2, 0) },
		]);

		expect(
			await names(col, { loc: { $geoWithin: { $center: [[0, 0], 1.5] } } }),
		).toEqual(["p0", "p1"]);
		expect(
			await names(col, {
				loc: { $geoWithin: { $centerSphere: [[0, 0], (1.5 * Math.PI) / 180] } },
			}),
		).toEqual(["p0", "p1"]);
	});

	test("a legacy shape matches point-like values only, as MongoDB does", async () => {
		const col = freshCollection();
		await col.insertMany([
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
			await names(col, {
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
		expect(
			await names(col, { loc: { $geoWithin: { $center: [[0.5, 0.5], 1] } } }),
		).toEqual(["pt"]);
	});

	test("composes with an ordinary condition and with a sort", async () => {
		const col = await seedPlaces();
		expect(
			await names(
				col,
				{
					name: { $ne: "nynear" },
					loc: { $geoWithin: { $geometry: MANHATTAN } },
				},
				{ sort: { name: -1 } },
			),
		).toEqual(["ny"]);
	});
});

describe("the polygon boundary", () => {
	const square = {
		type: "Polygon",
		coordinates: [
			[
				[0, -1],
				[1, -1],
				[1, 1],
				[0, 1],
				[0, -1],
			],
		],
	};

	test("a point on the edge is within, as it is in MongoDB", async () => {
		const col = freshCollection();
		await col.insertMany([
			{ name: "onEdge", loc: point(1, 0) },
			{ name: "onCorner", loc: point(0, -1) },
			{ name: "inside", loc: point(0.5, 0) },
			{ name: "outside", loc: point(2, 0) },
		]);

		// `INSIDE` alone tests the interior and would exclude the two boundary
		// points, which is a wrong answer rather than a rounding difference; for a
		// point, `INTERSECTS` means exactly "inside or on the edge".
		for (const operator of ["$geoWithin", "$geoIntersects"]) {
			expect(
				(
					await names(col, { loc: { [operator]: { $geometry: square } } })
				).sort(),
			).toEqual(["inside", "onCorner", "onEdge"]);
		}
	});

	test("the legacy shapes count their boundary too", async () => {
		const col = freshCollection();
		await col.insertMany([
			{ name: "onEdge", loc: point(1, 0) },
			{ name: "inside", loc: point(0.5, 0) },
			{ name: "outside", loc: point(2, 0) },
		]);

		for (const shape of [
			{
				$box: [
					[0, -1],
					[1, 1],
				],
			},
			{
				$polygon: [
					[0, -1],
					[1, -1],
					[1, 1],
					[0, 1],
				],
			},
		]) {
			expect((await names(col, { loc: { $geoWithin: shape } })).sort()).toEqual(
				["inside", "onEdge"],
			);
		}
	});

	test("a point on a slanted legacy-$polygon edge is within", async () => {
		const col = freshCollection();
		await col.insertMany([
			{ name: "onHypotenuse", loc: point(0, 0) },
			{ name: "inside", loc: point(0.5, -0.5) },
			{ name: "outside", loc: point(-1, 1) },
		]);

		// Every boundary point of the triangle is within, which is what MongoDB
		// answers for a vertex, for an axis-aligned edge, and for this same point
		// under `$geometry`. MongoDB's legacy `$polygon` alone excludes a point on a
		// slanted edge, and reproducing that inconsistency would mean giving one of
		// the five `$geoWithin` forms a boundary rule of its own.
		expect(
			(
				await names(col, {
					loc: {
						$geoWithin: {
							$polygon: [
								[-1, -1],
								[1, -1],
								[1, 1],
							],
						},
					},
				})
			).sort(),
		).toEqual(["inside", "onHypotenuse"]);
	});

	test("a line lying along the edge is not within, though it does intersect", async () => {
		const col = freshCollection();
		await col.insertMany([
			{
				name: "onEdge",
				loc: {
					type: "LineString",
					coordinates: [
						[1, -1],
						[1, 1],
					],
				},
			},
			{
				name: "inside",
				loc: {
					type: "LineString",
					coordinates: [
						[0.2, 0],
						[0.8, 0],
					],
				},
			},
		]);

		// The boundary-inclusive reading is confined to point-valued fields: for a
		// stored line or polygon, `INTERSECTS` would also match one merely
		// overlapping the edge from outside, so containment stays the interior test.
		expect(
			await names(col, { loc: { $geoWithin: { $geometry: square } } }),
		).toEqual(["inside"]);
		expect(
			(
				await names(col, { loc: { $geoIntersects: { $geometry: square } } })
			).sort(),
		).toEqual(["inside", "onEdge"]);
	});
});

describe("$geoIntersects", () => {
	test("matches anything overlapping the geometry, contained or not", async () => {
		const col = freshCollection();
		await col.insertMany([
			{ name: "inside", loc: point(0.5, 0.5) },
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

		const unitSquare = {
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
		const matched = await names(col, {
			loc: { $geoIntersects: { $geometry: unitSquare } },
		});
		expect(matched.sort()).toEqual(["inside", "straddling"]);
	});

	test("a point geometry matches the documents holding that point", async () => {
		const col = await seedPlaces();
		expect(
			await names(col, { loc: { $geoIntersects: { $geometry: NY } } }),
		).toEqual(["ny"]);
	});
});

describe("$near and $nearSphere", () => {
	test("orders by distance ascending", async () => {
		const col = await seedPlaces();
		expect(await names(col, { loc: { $near: { $geometry: NY } } })).toEqual([
			"ny",
			"nynear",
			"far",
		]);
	});

	test("the distance alias never reaches the caller", async () => {
		const col = await seedPlaces();
		const docs = await col
			.find({ loc: { $near: { $geometry: NY } } })
			.toArray();

		for (const doc of docs) {
			expect(Object.keys(doc).sort()).toEqual(["_id", "loc", "name"]);
		}
	});

	test("$maxDistance and $minDistance bound the band, in metres", async () => {
		const col = await seedPlaces();

		expect(
			await names(col, {
				loc: { $near: { $geometry: NY, $maxDistance: 20000 } },
			}),
		).toEqual(["ny", "nynear"]);
		expect(
			await names(col, {
				loc: { $near: { $geometry: NY, $minDistance: 1, $maxDistance: 20000 } },
			}),
		).toEqual(["nynear"]);
		expect(
			await names(col, {
				loc: { $near: { $geometry: NY, $minDistance: 20000 } },
			}),
		).toEqual(["far"]);
	});

	test("a metre bound is measured on MongoDB's sphere, not SurrealDB's", async () => {
		const col = freshCollection();
		await col.insertMany([
			{ name: "here", loc: point(0, 0) },
			{ name: "adegree", loc: point(0, 1) },
		]);

		// A degree of latitude is 111 318.8 m to MongoDB and 111 195.1 m to
		// `geo::distance`; a bound of 111 250 m therefore falls between them, and
		// passing the number through unconverted would include the point MongoDB
		// excludes.
		expect(
			await names(col, {
				loc: { $near: { $geometry: point(0, 0), $maxDistance: 111_250 } },
			}),
		).toEqual(["here"]);
		expect(
			await names(col, {
				loc: { $near: { $geometry: point(0, 0), $maxDistance: 111_400 } },
			}),
		).toEqual(["here", "adegree"]);
	});

	test("$nearSphere with a coordinate pair takes its bound in radians", async () => {
		const col = await seedPlaces();

		expect(
			await names(col, {
				loc: {
					$nearSphere: [-73.9667, 40.78],
					$maxDistance: 20000 / 6_378_100,
				},
			}),
		).toEqual(["ny", "nynear"]);
	});

	test("documents with no point in that field are not returned", async () => {
		const col = await seedPlaces();
		const matched = await names(col, { loc: { $near: { $geometry: NY } } });

		expect(matched).not.toContain("nogeo");
		expect(matched).not.toContain("strloc");
	});

	test("an explicit sort replaces the distance ordering", async () => {
		const col = await seedPlaces();
		expect(
			await names(
				col,
				{ loc: { $near: { $geometry: NY } } },
				{ sort: { name: -1 } },
			),
		).toEqual(["nynear", "ny", "far"]);
	});

	test("composes with limit, skip and a projection", async () => {
		const col = await seedPlaces();

		expect(
			await names(col, { loc: { $near: { $geometry: NY } } }, { limit: 2 }),
		).toEqual(["ny", "nynear"]);
		expect(
			await names(col, { loc: { $near: { $geometry: NY } } }, { skip: 1 }),
		).toEqual(["nynear", "far"]);
		expect(
			await names(
				col,
				{ loc: { $near: { $geometry: NY } } },
				{ skip: 1, limit: 1 },
			),
		).toEqual(["nynear"]);

		const projected = await col
			.find(
				{ loc: { $near: { $geometry: NY } } },
				{ projection: { name: 1, _id: 0 } },
			)
			.toArray();
		expect(projected).toEqual([
			{ name: "ny" },
			{ name: "nynear" },
			{ name: "far" },
		]);
	});

	test("composes with other filter conditions", async () => {
		const col = await seedPlaces();
		expect(
			await names(col, {
				name: { $ne: "nynear" },
				loc: { $near: { $geometry: NY } },
			}),
		).toEqual(["ny", "far"]);
	});

	test("streams in distance order through a cursor", async () => {
		const col = await seedPlaces();
		const seen: (string | undefined)[] = [];
		for await (const doc of col.find({ loc: { $near: { $geometry: NY } } })) {
			seen.push(doc.name);
		}
		expect(seen).toEqual(["ny", "nynear", "far"]);
	});

	test("findOne returns the nearest document", async () => {
		const col = await seedPlaces();
		expect(
			(await col.findOne({ loc: { $near: { $geometry: NY } } }))?.name,
		).toBe("ny");
	});

	test("deleteOne and findOneAndUpdate act on the nearest document", async () => {
		const col = await seedPlaces();

		const updated = await col.findOneAndUpdate(
			{ loc: { $near: { $geometry: NY } } },
			{ $set: { tags: ["closest"] } },
		);
		expect((updated as Place | null)?.name).toBe("ny");

		await col.deleteOne({ loc: { $near: { $geometry: NY } } });
		expect(await names(col, { loc: { $near: { $geometry: NY } } })).toEqual([
			"nynear",
			"far",
		]);
	});

	test("deleteMany and countDocuments apply the band", async () => {
		const col = await seedPlaces();

		expect(
			await col.countDocuments({
				loc: { $near: { $geometry: NY, $maxDistance: 20000 } },
			}),
		).toBe(2);
		const deleted = await col.deleteMany({
			loc: { $near: { $geometry: NY, $maxDistance: 20000 } },
		});
		expect(deleted.deletedCount).toBe(2);
	});

	test("distinct applies the band, which MongoDB rejects outright", async () => {
		const col = await seedPlaces();

		expect(
			(
				await col.distinct("name", {
					loc: { $near: { $geometry: NY, $maxDistance: 20000 } },
				})
			).sort(),
		).toEqual(["ny", "nynear"]);
	});

	test("a field holding a non-point geometry is not ordered by distance", async () => {
		const col = freshCollection();
		await col.insertMany([
			{ name: "pt", loc: point(0, 0) },
			{
				name: "poly",
				loc: {
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
				},
			},
		]);

		// A distance to a polygon is `NONE` in SurrealDB, which would sort ahead of
		// every real distance and compare true against any upper bound. MongoDB
		// measures to the nearest point of the shape and returns both.
		expect(
			await names(col, { loc: { $near: { $geometry: point(10, 10) } } }),
		).toEqual(["pt"]);
	});

	test("works inside a transaction", async () => {
		const col = await seedPlaces();
		const session = client.startSession();

		try {
			await session.withTransaction(async () => {
				const nearest = await col.findOne(
					{ loc: { $near: { $geometry: NY } } },
					{ session },
				);
				expect(nearest?.name).toBe("ny");

				await col.updateOne(
					{ loc: { $near: { $geometry: NY } } },
					{ $set: { tags: ["visited"] } },
					{ session },
				);
			});
		} finally {
			await session.endSession();
		}

		expect((await col.findOne({ name: "ny" }))?.tags).toEqual(["visited"]);
	});
});
