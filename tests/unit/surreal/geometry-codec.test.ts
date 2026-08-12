import { describe, expect, test } from "bun:test";
import {
	Geometry,
	GeometryCollection,
	GeometryLine,
	GeometryMultiLine,
	GeometryMultiPoint,
	GeometryMultiPolygon,
	GeometryPoint,
	GeometryPolygon,
} from "surrealdb";
import {
	MongoCompatibilityError,
	MongoInvalidArgumentError,
} from "../../../src/errors.ts";
import {
	encodeBsonValue,
	reviveBsonValues,
} from "../../../src/surreal/bson-codec.ts";
import {
	isGeoJsonGeometry,
	rejectGeometryDocument,
} from "../../../src/surreal/geometry-codec.ts";

/** One well-formed sample of each type SurrealDB models. */
const SAMPLES = {
	Point: { type: "Point", coordinates: [1, 2] },
	LineString: {
		type: "LineString",
		coordinates: [
			[0, 0],
			[1, 1],
			[2, 0],
		],
	},
	Polygon: {
		type: "Polygon",
		coordinates: [
			[
				[0, 0],
				[2, 0],
				[2, 2],
				[0, 2],
				[0, 0],
			],
		],
	},
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
		coordinates: [
			[
				[
					[0, 0],
					[1, 0],
					[1, 1],
					[0, 1],
					[0, 0],
				],
			],
			[
				[
					[5, 5],
					[6, 5],
					[6, 6],
					[5, 6],
					[5, 5],
				],
			],
		],
	},
	GeometryCollection: {
		type: "GeometryCollection",
		geometries: [
			{ type: "Point", coordinates: [0, 0] },
			{
				type: "LineString",
				coordinates: [
					[0, 0],
					[1, 1],
				],
			},
		],
	},
} as const;

const CLASSES = {
	Point: GeometryPoint,
	LineString: GeometryLine,
	Polygon: GeometryPolygon,
	MultiPoint: GeometryMultiPoint,
	MultiLineString: GeometryMultiLine,
	MultiPolygon: GeometryMultiPolygon,
	GeometryCollection: GeometryCollection,
} as const;

describe("what is recognised as a geometry", () => {
	test("all seven GeoJSON geometry types are", () => {
		for (const [type, sample] of Object.entries(SAMPLES)) {
			expect(isGeoJsonGeometry(sample)).toBe(true);
			expect(encodeBsonValue(sample)).toBeInstanceOf(
				CLASSES[type as keyof typeof CLASSES],
			);
		}
	});

	test("an object with a field beside the coordinates is data, and keeps it", () => {
		// Converting it would store the geometry and *drop* the extra field, since
		// SurrealDB's geometry holds coordinates and nothing else.
		const labelled = { type: "Point", coordinates: [1, 2], name: "home" };

		expect(isGeoJsonGeometry(labelled)).toBe(false);
		expect(encodeBsonValue(labelled)).toBe(labelled);
	});

	test("a type outside the seven is data", () => {
		for (const value of [
			{ type: "Circle", coordinates: [0, 0] },
			{ type: "Feature", coordinates: [0, 0] },
			{ type: "point", coordinates: [0, 0] },
			{ type: 5, coordinates: [0, 0] },
		]) {
			expect(isGeoJsonGeometry(value)).toBe(false);
			expect(encodeBsonValue(value)).toBe(value);
		}
	});

	test("coordinates that are not an array are data, not a broken geometry", () => {
		for (const value of [
			{ type: "Polygon", coordinates: "see attachment" },
			{ type: "Point", coordinates: null },
			{ type: "GeometryCollection", geometries: "none" },
		]) {
			expect(isGeoJsonGeometry(value)).toBe(false);
			expect(encodeBsonValue(value)).toBe(value);
		}
	});

	test("the payload key has to match the type", () => {
		for (const value of [
			{ type: "Point", geometries: [] },
			{ type: "GeometryCollection", coordinates: [] },
		]) {
			expect(isGeoJsonGeometry(value)).toBe(false);
		}
	});

	test("a class instance is never a geometry, whatever fields it has", () => {
		class Marker {
			type = "Point";
			coordinates = [1, 2];
		}
		expect(isGeoJsonGeometry(new Marker())).toBe(false);
	});
});

describe("what is refused once recognised", () => {
	test("a position must be exactly two finite numbers", () => {
		for (const coordinates of [
			[1],
			[1, 2, 3],
			[1, "2"],
			[Number.NaN, 0],
			[Number.POSITIVE_INFINITY, 0],
		]) {
			expect(() => encodeBsonValue({ type: "Point", coordinates })).toThrow(
				MongoInvalidArgumentError,
			);
		}
	});

	test("a line needs two positions", () => {
		expect(() =>
			encodeBsonValue({ type: "LineString", coordinates: [[0, 0]] }),
		).toThrow(/at least two positions/);
	});

	test("a linear ring must be closed, and long enough to enclose an area", () => {
		expect(() =>
			encodeBsonValue({
				type: "Polygon",
				coordinates: [
					[
						[0, 0],
						[1, 0],
						[1, 1],
						[0, 1],
					],
				],
			}),
		).toThrow(/must be closed/);

		expect(() =>
			encodeBsonValue({
				type: "Polygon",
				coordinates: [
					[
						[0, 0],
						[1, 0],
						[0, 0],
					],
				],
			}),
		).toThrow(/at least four positions/);
	});

	test("an empty geometry is refused rather than stored as one no query can use", () => {
		for (const value of [
			{ type: "Polygon", coordinates: [] },
			{ type: "MultiPoint", coordinates: [] },
			{ type: "MultiPolygon", coordinates: [] },
			{ type: "GeometryCollection", geometries: [] },
		]) {
			expect(() => encodeBsonValue(value)).toThrow(MongoInvalidArgumentError);
		}
	});

	test("a collection member that is not a geometry is refused", () => {
		expect(() =>
			encodeBsonValue({
				type: "GeometryCollection",
				geometries: [{ type: "Point", coordinates: [0, 0] }, { note: "later" }],
			}),
		).toThrow(/every member must be a GeoJSON geometry/);
	});
});

describe("round trip", () => {
	test("every type survives encode and decode unchanged", () => {
		for (const sample of Object.values(SAMPLES)) {
			const encoded = encodeBsonValue(sample);
			expect(encoded).toBeInstanceOf(Geometry);
			expect(reviveBsonValues(encoded)).toEqual(sample);
		}
	});

	test("a geometry reads back as GeoJSON, which is what MongoDB returns", () => {
		expect(reviveBsonValues<unknown>(new GeometryPoint([1, 2]))).toEqual({
			type: "Point",
			coordinates: [1, 2],
		});
	});

	test("a caller's own SDK geometry comes back as GeoJSON too", () => {
		// The two are the same stored value, so there is nothing to tell them apart
		// by on the way back.
		const encoded = encodeBsonValue(new GeometryPoint([3, 4]));
		expect(reviveBsonValues(encoded)).toEqual({
			type: "Point",
			coordinates: [3, 4],
		});
	});

	test("every other value passes through the read path untouched", () => {
		for (const value of [
			1,
			"x",
			null,
			undefined,
			[1, 2],
			{ a: 1 },
			new Date(0),
		]) {
			expect(reviveBsonValues(value)).toBe(value);
		}
	});
});

describe("a document that is itself a geometry", () => {
	test("is refused, naming the way round it", () => {
		expect(() => rejectGeometryDocument(SAMPLES.Point)).toThrow(
			MongoCompatibilityError,
		);
		expect(() => rejectGeometryDocument(SAMPLES.Point)).toThrow(
			/Nest it under a field of its own/,
		);
	});

	test("a document merely holding one is fine", () => {
		expect(() =>
			rejectGeometryDocument({ name: "home", location: SAMPLES.Point }),
		).not.toThrow();
		expect(() => rejectGeometryDocument({})).not.toThrow();
	});
});
