/**
 * Static parity check for the mql.js public surface vs. the official
 * MongoDB driver.
 *
 * The runtime parity suite (see `tests/e2e/parity-in-memory.test.ts` and
 * `tests/e2e/parity.test.ts`) proves the two drivers behave the same on
 * a live database. This file proves the *types* line up: every call the
 * scenarios make against `mongodb`'s `Db`/`Collection`/`FindCursor` also
 * type-checks against the mql.js equivalents (and vice versa).
 *
 * Strategy: instead of asserting structural assignability between the
 * two driver class hierarchies (which would be near-impossible — mongodb
 * uses generic-heavy `WithId`/`OptionalUnlessRequiredId` transforms that
 * mql.js intentionally doesn't replicate verbatim), we write *call-site
 * parity probes*. Each probe contains the exact call shapes the parity
 * scenarios use. If either driver drifts, the corresponding probe fails
 * to compile under `tsc --noEmit`.
 *
 * No `as` casts are used; tsc carries the assertion.
 */

import { describe, expect, test } from "bun:test";
import {
	type ClientSession as MongoClientSession,
	type Collection as MongoCollection,
	type Db as MongoDb,
	type FindCursor as MongoFindCursor,
	MongoClient as NativeMongoClient,
} from "mongodb";
import type {
	ClientSession as MqlClientSession,
	Db as MqlDb,
} from "../../src/index.ts";
import {
	Admin as MqlAdmin,
	Collection as MqlCollection,
	Db as MqlDbClass,
	FindCursor as MqlFindCursor,
	MongoClient as MqlMongoClient,
} from "../../src/index.ts";

// ---------------------------------------------------------------------------
// 1. The shared "user" shape every parity scenario operates on.
//
//    Each driver requires a schema assignable to its internal `Document`:
//      - mongodb's `Document` (re-exported from `bson`) is
//        `{ [key: string]: any }`.
//      - mql.js's `Document` is `{ [key: string]: unknown }`.
//
//    `any` admits anything, including the well-typed fields below, so
//    mongodb users typically write the schema *without* an explicit
//    index signature. mql.js's stricter `unknown` requires it. We model
//    that difference honestly by defining one schema per driver, both
//    backed by the same `ParityUserFields` interface so a field rename
//    on one side becomes a type error on both.
//
//    If mql.js ever loosens its `Document` to `any`, the two schemas
//    can collapse into one and the probes still compile.
// ---------------------------------------------------------------------------

interface ParityUserFields {
	name: string;
	age: number;
	email?: string;
	tags?: string[];
	active?: boolean;
}

interface MongoParityUser extends ParityUserFields {}

interface MqlParityUser extends ParityUserFields {
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 2. Call-site parity probes — these MUST type-check or the build fails.
//
//    Each probe takes a typed handle (Db / Collection / FindCursor) and
//    exercises every operation the parity scenarios use. The function
//    bodies never run; their existence is the assertion.
// ---------------------------------------------------------------------------

function _useMongoDb(db: MongoDb): MongoCollection<MongoParityUser> {
	return db.collection<MongoParityUser>("users");
}

function _useMqlDb(db: MqlDb): MqlCollection<MqlParityUser> {
	return db.collection<MqlParityUser>("users");
}

async function _useMongoCollection(
	col: MongoCollection<MongoParityUser>,
): Promise<unknown> {
	return [
		await col.insertOne({ name: "Alice", age: 30 }),
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
		]),
		await col.findOne({ name: "Alice" }),
		await col.findOne({ age: { $gt: 18 } }),
		await col.find({}).toArray(),
		await col
			.find({ age: { $gt: 28 } })
			.sort({ age: 1 })
			.skip(1)
			.limit(2)
			.toArray(),
		await col
			.find({ $or: [{ name: "Alice" }, { age: { $gt: 32 } }] })
			.toArray(),
		await col.find({ name: { $in: ["Alice", "Bob"] } }).toArray(),
		await col.updateOne({ name: "Alice" }, { $set: { age: 31 } }),
		await col.updateOne({ name: "Alice" }, { $inc: { age: 1 } }),
		await col.updateMany({ active: false }, { $set: { active: true } }),
		await col.deleteOne({ name: "Alice" }),
		await col.deleteMany({ age: { $gte: 30 } }),
		await col.countDocuments(),
		await col.countDocuments({ age: { $gt: 28 } }),
	];
}

async function _useMqlCollection(
	col: MqlCollection<MqlParityUser>,
): Promise<unknown> {
	return [
		await col.insertOne({ name: "Alice", age: 30 }),
		await col.insertMany([
			{ name: "Alice", age: 30 },
			{ name: "Bob", age: 25 },
		]),
		await col.findOne({ name: "Alice" }),
		await col.findOne({ age: { $gt: 18 } }),
		await col.find({}).toArray(),
		await col
			.find({ age: { $gt: 28 } })
			.sort({ age: 1 })
			.skip(1)
			.limit(2)
			.toArray(),
		await col
			.find({ $or: [{ name: "Alice" }, { age: { $gt: 32 } }] })
			.toArray(),
		await col.find({ name: { $in: ["Alice", "Bob"] } }).toArray(),
		await col.updateOne({ name: "Alice" }, { $set: { age: 31 } }),
		await col.updateOne({ name: "Alice" }, { $inc: { age: 1 } }),
		await col.updateMany({ active: false }, { $set: { active: true } }),
		await col.deleteOne({ name: "Alice" }),
		await col.deleteMany({ age: { $gte: 30 } }),
		await col.countDocuments(),
		await col.countDocuments({ age: { $gt: 28 } }),
	];
}

// ---------------------------------------------------------------------------
// 2b. Index-surface probes.
//
//     Written once per driver over the same call shapes: every index method,
//     every `IndexSpecification` form, and the option groups. If a signature
//     drifts — an option that is no longer accepted, a return type that is no
//     longer awaited the same way — the corresponding probe stops compiling.
// ---------------------------------------------------------------------------

async function _useMongoIndexes(
	col: MongoCollection<MongoParityUser>,
	session: MongoClientSession,
): Promise<unknown> {
	const cursor = col.listIndexes();
	return [
		// Index DDL is transactional on both drivers, so `session` has to be
		// nameable on the call rather than reachable only through a cast.
		await col.createIndex({ age: 1 }, { session }),
		await col.createIndexes([{ key: { age: 1 } }], { session }),
		await col.listIndexes({ session }).toArray(),
		await col.indexInformation({ session }),
		await col.dropIndexes({ session }),
		await col.createIndex({ age: 1 }),
		await col.createIndex({ age: -1 }, { name: "by_age_desc" }),
		await col.createIndex({ email: 1 }, { unique: true, sparse: true }),
		await col.createIndex("name"),
		await col.createIndex(["name", "age"]),
		await col.createIndex([["age", -1]]),
		await col.createIndex(new Map([["age", 1]])),
		await col.createIndex({ age: 1 }, { background: true, version: 2 }),
		await col.createIndexes([
			{ key: { age: 1 } },
			{ key: { name: 1 }, name: "n" },
		]),
		await cursor.toArray(),
		await col.listIndexes().next(),
		await col.listIndexes().hasNext(),
		await col.indexes(),
		await col.indexExists("age_1"),
		await col.indexExists(["age_1", "n"]),
		await col.indexInformation(),
		await col.indexInformation({ full: true }),
		await col.dropIndex("age_1"),
		await col.dropIndexes(),
	];
}

async function _useMqlIndexes(
	col: MqlCollection<MqlParityUser>,
	session: MqlClientSession,
): Promise<unknown> {
	const cursor = col.listIndexes();
	return [
		await col.createIndex({ age: 1 }, { session }),
		await col.createIndexes([{ key: { age: 1 } }], { session }),
		await col.listIndexes({ session }).toArray(),
		await col.indexInformation({ session }),
		await col.dropIndexes({ session }),
		await col.createIndex({ age: 1 }),
		await col.createIndex({ age: -1 }, { name: "by_age_desc" }),
		await col.createIndex({ email: 1 }, { unique: true, sparse: true }),
		await col.createIndex("name"),
		await col.createIndex(["name", "age"]),
		await col.createIndex([["age", -1]]),
		await col.createIndex(new Map([["age", 1]])),
		await col.createIndex({ age: 1 }, { background: true, version: 2 }),
		await col.createIndexes([
			{ key: { age: 1 } },
			{ key: { name: 1 }, name: "n" },
		]),
		await cursor.toArray(),
		await col.listIndexes().next(),
		await col.listIndexes().hasNext(),
		await col.indexes(),
		await col.indexExists("age_1"),
		await col.indexExists(["age_1", "n"]),
		await col.indexInformation(),
		await col.indexInformation({ full: true }),
		await col.dropIndex("age_1"),
		await col.dropIndexes(),
	];
}

// ---------------------------------------------------------------------------
// 2c. Boundary-surface probes.
//
//     The methods this driver declares and refuses have to carry the signature
//     they will have once they are real, so filling one in is additive rather
//     than breaking. Written as the same call shapes against both drivers: if a
//     stub's parameters or return type drift from MongoDB's, the mql.js probe
//     stops compiling while the mongodb one still does.
//
//     The calls are never made — the refusals are asserted in
//     `tests/unit/unsupported.test.ts`. What is asserted here is that they
//     *type-check*, which the function bodies below never reaching a runtime
//     does not weaken.
// ---------------------------------------------------------------------------

function _useMongoBoundary(
	client: NativeMongoClient,
	db: MongoDb,
	col: MongoCollection<MongoParityUser>,
): readonly unknown[] {
	return [
		() =>
			col.aggregate([{ $match: { name: "Alice" } }], { allowDiskUse: true }),
		() => col.aggregate<MongoParityUser>(),
		() => col.bulkWrite([{ insertOne: { document: { name: "A", age: 1 } } }]),
		() => col.bulkWrite([{ deleteMany: { filter: { age: { $lt: 0 } } } }], {}),
		() => col.initializeOrderedBulkOp(),
		() => col.initializeUnorderedBulkOp({}),
		() => col.watch([{ $match: {} }], { fullDocument: "updateLookup" }),
		() => col.rename("renamed", { dropTarget: true }),
		() => col.listSearchIndexes(),
		() => col.listSearchIndexes("named"),
		() => col.createSearchIndex({ name: "s", definition: {} }),
		() => col.createSearchIndexes([{ definition: {} }]),
		() => col.dropSearchIndex("s"),
		() => col.updateSearchIndex("s", {}),
		() => db.aggregate([{ $match: {} }]),
		() => db.watch(),
		() => db.renameCollection("from", "to"),
		() => client.watch(),
		// Implemented on both, and reached through the same call shapes.
		() => db.command({ ping: 1 }),
		() => db.command({ dbStats: 1 }, {}),
		() => db.admin().ping(),
		() => db.admin().buildInfo(),
		() => db.admin().serverInfo(),
		() => db.admin().listDatabases({ nameOnly: true }),
		() => db.admin().command({ ping: 1 }),
		() => db.stats(),
		() => db.stats({ scale: 1024 }),
		() => db.collections(),
		() => col.drop(),
		() => col.options(),
		() => col.isCapped(),
	];
}

function _useMqlBoundary(
	client: MqlMongoClient,
	db: MqlDb,
	col: MqlCollection<MqlParityUser>,
): readonly unknown[] {
	return [
		() =>
			col.aggregate([{ $match: { name: "Alice" } }], { allowDiskUse: true }),
		() => col.aggregate<MqlParityUser>(),
		() => col.bulkWrite([{ insertOne: { document: { name: "A", age: 1 } } }]),
		() => col.bulkWrite([{ deleteMany: { filter: { age: { $lt: 0 } } } }], {}),
		() => col.initializeOrderedBulkOp(),
		() => col.initializeUnorderedBulkOp({}),
		() => col.watch([{ $match: {} }], { fullDocument: "updateLookup" }),
		() => col.rename("renamed", { dropTarget: true }),
		() => col.listSearchIndexes(),
		() => col.listSearchIndexes("named"),
		() => col.createSearchIndex({ name: "s", definition: {} }),
		() => col.createSearchIndexes([{ definition: {} }]),
		() => col.dropSearchIndex("s"),
		() => col.updateSearchIndex("s", {}),
		() => db.aggregate([{ $match: {} }]),
		() => db.watch(),
		() => db.renameCollection("from", "to"),
		() => client.watch(),
		() => db.command({ ping: 1 }),
		() => db.command({ dbStats: 1 }, {}),
		() => db.admin().ping(),
		() => db.admin().buildInfo(),
		() => db.admin().serverInfo(),
		() => db.admin().listDatabases({ nameOnly: true }),
		() => db.admin().command({ ping: 1 }),
		() => db.stats(),
		() => db.stats({ scale: 1024 }),
		() => db.collections(),
		() => col.drop(),
		() => col.options(),
		() => col.isCapped(),
	];
}

/**
 * The awaited results line up too, for the ones that resolve to a document.
 *
 * A caller reading `info.version` off either driver's `buildInfo()` has to
 * compile against both, which is what makes the reply an actual `Document`
 * rather than a narrower shape of this driver's choosing.
 */
async function _useCommandReplies(
	db: MqlDb | MongoDb,
): Promise<readonly unknown[]> {
	const info = await db.admin().buildInfo();
	const stats = await db.stats();
	const databases = await db.admin().listDatabases();
	return [info.version, stats.collections, databases.databases[0]?.name];
}

async function _useMongoCursor(
	cursor: MongoFindCursor<MongoParityUser>,
): Promise<unknown> {
	return [
		await cursor.sort({ age: 1 }).limit(5).skip(1).toArray(),
		await cursor.next(),
	];
}

async function _useMqlCursor(
	cursor: MqlFindCursor<MqlParityUser>,
): Promise<unknown> {
	return [
		await cursor.sort({ age: 1 }).limit(5).skip(1).toArray(),
		await cursor.next(),
	];
}

async function _useClient(
	client: MqlMongoClient | NativeMongoClient,
): Promise<unknown> {
	await client.connect();
	const db = client.db();
	await client.close();
	return db;
}

// Reading the probes at runtime keeps imports retained even with
// aggressive tree-shaking; the real value is that they had to compile.
const _probesExist: readonly unknown[] = [
	_useMongoDb,
	_useMqlDb,
	_useMongoCollection,
	_useMqlCollection,
	_useMongoIndexes,
	_useMqlIndexes,
	_useMongoBoundary,
	_useMqlBoundary,
	_useCommandReplies,
	_useMongoCursor,
	_useMqlCursor,
	_useClient,
];

// ---------------------------------------------------------------------------
// 3. Runtime prototype handles for mongodb's classes.
//
//    `mongodb` v7 exports `Collection` and `FindCursor` as types only;
//    the only safe way to grab their runtime prototype is from a real
//    instance produced by `MongoClient`. We never connect, so the temp
//    client is closed best-effort below.
// ---------------------------------------------------------------------------

const tempClient: NativeMongoClient = new NativeMongoClient(
	"mongodb://127.0.0.1:1/parity-types-only",
);
const tempDb: MongoDb = tempClient.db("parity-types-only");
const tempCollection: MongoCollection<MongoParityUser> =
	tempDb.collection<MongoParityUser>("parity_types");
const tempCursor: MongoFindCursor<MongoParityUser> = tempCollection.find();

const mongoCollectionPrototype: object = Object.getPrototypeOf(tempCollection);
const mongoCursorPrototype: object = Object.getPrototypeOf(tempCursor);

void tempClient.close().catch(() => undefined);

// ---------------------------------------------------------------------------
// 4. Runtime sanity check — keeps the file an actual Bun test, and
//    catches missing-method drift even outside a `tsc` invocation.
// ---------------------------------------------------------------------------

const COLLECTION_METHODS: readonly string[] = [
	"createIndex",
	"createIndexes",
	"dropIndex",
	"dropIndexes",
	"indexes",
	"indexExists",
	"indexInformation",
	"listIndexes",
	"insertOne",
	"insertMany",
	"findOne",
	"find",
	"updateOne",
	"updateMany",
	"deleteOne",
	"deleteMany",
	"countDocuments",
	// The boundary is part of the surface: a method that only refuses still has to
	// be there, or a caller gets `TypeError: … is not a function` instead of a
	// reason. These are the ones both drivers must expose.
	"aggregate",
	"bulkWrite",
	"initializeOrderedBulkOp",
	"initializeUnorderedBulkOp",
	"watch",
	"rename",
	"drop",
	"options",
	"isCapped",
	"listSearchIndexes",
	"createSearchIndex",
	"createSearchIndexes",
	"dropSearchIndex",
	"updateSearchIndex",
];

const DB_METHODS: readonly string[] = [
	"collection",
	"createCollection",
	"dropCollection",
	"dropDatabase",
	"listCollections",
	"collections",
	"command",
	"admin",
	"stats",
	"aggregate",
	"watch",
	"renameCollection",
];

const ADMIN_METHODS: readonly string[] = [
	"command",
	"ping",
	"buildInfo",
	"serverInfo",
	"serverStatus",
	"listDatabases",
	"replSetGetStatus",
	"removeUser",
	"validateCollection",
];

const CURSOR_METHODS: readonly string[] = [
	"sort",
	"limit",
	"skip",
	"toArray",
	"next",
];

const CLIENT_METHODS: readonly string[] = ["connect", "db", "close"];

function hasMethod(prototype: object, method: string): boolean {
	return typeof (prototype as Record<string, unknown>)[method] === "function";
}

describe("public-API parity (mql.js vs. mongodb)", () => {
	test("MongoClient classes expose the same scenario-critical methods", () => {
		for (const method of CLIENT_METHODS) {
			expect(hasMethod(NativeMongoClient.prototype, method)).toBe(true);
			expect(hasMethod(MqlMongoClient.prototype, method)).toBe(true);
		}
	});

	test("Collection classes expose the same scenario-critical methods", () => {
		for (const method of COLLECTION_METHODS) {
			expect(hasMethod(mongoCollectionPrototype, method)).toBe(true);
			expect(hasMethod(MqlCollection.prototype, method)).toBe(true);
		}
	});

	test("FindCursor classes expose the same chainable methods", () => {
		for (const method of CURSOR_METHODS) {
			expect(hasMethod(mongoCursorPrototype, method)).toBe(true);
			expect(hasMethod(MqlFindCursor.prototype, method)).toBe(true);
		}
	});

	test("Db classes expose the same database-level methods", () => {
		const mongoDbPrototype: object = Object.getPrototypeOf(tempDb);
		for (const method of DB_METHODS) {
			expect(hasMethod(mongoDbPrototype, method)).toBe(true);
			expect(hasMethod(MqlDbClass.prototype, method)).toBe(true);
		}
	});

	test("Admin classes expose the same administrative methods", () => {
		const mongoAdminPrototype: object = Object.getPrototypeOf(tempDb.admin());
		for (const method of ADMIN_METHODS) {
			expect(hasMethod(mongoAdminPrototype, method)).toBe(true);
			expect(hasMethod(MqlAdmin.prototype, method)).toBe(true);
		}
	});

	test("call-site parity probes exist (and therefore compiled)", () => {
		expect(_probesExist).toHaveLength(12);
		for (const probe of _probesExist) {
			expect(typeof probe).toBe("function");
		}
	});
});
