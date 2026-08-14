/**
 * The documented edge of the driver, pinned.
 *
 * Every method this driver declares and does not implement is exercised here,
 * with its error class and the whole of its message asserted. That makes the
 * boundary machine-checked rather than aspirational: the README's list of what
 * is unsupported cannot drift from what the code raises, and a method that
 * quietly starts working — or quietly stops saying why it does not — fails a
 * test.
 *
 * Two properties matter beyond the wording:
 *
 *   - **the class**, because it is what a caller branches on. A driver-side
 *     limitation is a `MongoCompatibilityError` under `MongoAPIError` and
 *     `MongoDriverError`; a command name the server surface does not have is a
 *     `MongoServerError` with mongod's own code.
 *   - **the failure shape**, because a promise-returning method has to reject
 *     rather than throw synchronously. A caller who only attached `.catch()`
 *     would miss a synchronous throw entirely.
 *
 * Nothing here needs a server: every refusal happens before any statement is
 * built, which is itself part of the contract.
 */

import { describe, expect, test } from "bun:test";
import type { Collection, Db } from "../../src/index.ts";
import {
	MongoAPIError,
	MongoClient,
	MongoCompatibilityError,
	MongoDriverError,
	MongoError,
	MongoErrorCode,
	MongoServerError,
} from "../../src/index.ts";

function client(): MongoClient {
	return new MongoClient("mongodb://127.0.0.1:8000/testdb");
}

function db(): Db {
	return client().db("testdb");
}

function collection(): Collection {
	return db().collection("things");
}

// ---------------------------------------------------------------------------
// Methods that return a value synchronously
// ---------------------------------------------------------------------------

/**
 * A cursor- or builder-returning method throws at the call.
 *
 * This is the driver's one deliberate divergence from MongoDB's shape rather
 * than an omission: MongoDB builds the cursor without contacting the server, so
 * a caller who never iterates never sees a failure there. Asserting the throw is
 * synchronous is asserting that divergence on purpose — the failure names the
 * call that caused it instead of arriving at an `await` somewhere else, or on an
 * `'error'` event no one attached a listener to.
 */
describe("a method MongoDB answers with a lazy cursor throws at the call", () => {
	const cases: readonly [string, () => unknown, string][] = [
		[
			"Db.aggregate()",
			() => db().aggregate([{ $match: {} }]),
			"Db.aggregate() is not implemented by @surrealdb/mql: a database-level pipeline reads from a source stage such as $documents or $currentOp rather than from a collection, and none of those has a SurrealDB counterpart to draw rows from. Use db.collection(name).aggregate(pipeline), which is implemented, or run SurrealQL through the SurrealDB client this driver wraps.",
		],
		[
			"Collection.watch()",
			() => collection().watch(),
			"Collection.watch() is not implemented by @surrealdb/mql: SurrealDB's live queries carry a different event shape and no resume token, so a ChangeStream built on them could not be resumed after a disconnect the way callers depend on. Subscribe to a SurrealDB live query through the SurrealDB client this driver wraps.",
		],
		[
			"Db.watch()",
			() => db().watch(),
			"Db.watch() is not implemented by @surrealdb/mql: SurrealDB's live queries carry a different event shape and no resume token, so a ChangeStream built on them could not be resumed after a disconnect the way callers depend on. Subscribe to a SurrealDB live query through the SurrealDB client this driver wraps.",
		],
		[
			"MongoClient.watch()",
			() => client().watch(),
			"MongoClient.watch() is not implemented by @surrealdb/mql: SurrealDB's live queries carry a different event shape and no resume token, so a ChangeStream built on them could not be resumed after a disconnect the way callers depend on. Subscribe to a SurrealDB live query through the SurrealDB client this driver wraps.",
		],
		[
			"Collection.initializeOrderedBulkOp()",
			() => collection().initializeOrderedBulkOp(),
			"Collection.initializeOrderedBulkOp() is not implemented by @surrealdb/mql: mixing insert, update, replace and delete models into one batch needs the per-model result accounting and the ordered/unordered failure semantics that BulkWriteResult reports, and neither is implemented. Call the single-purpose methods, or run them inside session.withTransaction() so they commit or roll back as a unit.",
		],
		[
			"Collection.initializeUnorderedBulkOp()",
			() => collection().initializeUnorderedBulkOp(),
			"Collection.initializeUnorderedBulkOp() is not implemented by @surrealdb/mql: mixing insert, update, replace and delete models into one batch needs the per-model result accounting and the ordered/unordered failure semantics that BulkWriteResult reports, and neither is implemented. Call the single-purpose methods, or run them inside session.withTransaction() so they commit or roll back as a unit.",
		],
		[
			"Collection.listSearchIndexes()",
			() => collection().listSearchIndexes(),
			"Collection.listSearchIndexes() is not implemented by @surrealdb/mql: Atlas Search indexes are a MongoDB Atlas service, and there is no SurrealDB counterpart to define one against. Use createIndex() with a text index, which this driver defines as a SurrealDB full-text search index.",
		],
	];

	for (const [name, call, message] of cases) {
		test(`${name} throws MongoCompatibilityError`, () => {
			expect(call).toThrow(MongoCompatibilityError);
			expect(call).toThrow(message);
		});
	}
});

// ---------------------------------------------------------------------------
// Methods that return a promise
// ---------------------------------------------------------------------------

/**
 * A promise-returning method rejects rather than throwing.
 *
 * `expect(fn()).rejects` only holds if the call itself returned a promise, so
 * this is the assertion that the refusal fails in the shape the real method
 * returns.
 */
describe("a method MongoDB answers with a promise rejects", () => {
	const cases: readonly [string, () => Promise<unknown>, string][] = [
		[
			"Collection.bulkWrite()",
			() => collection().bulkWrite([{ insertOne: { document: { a: 1 } } }]),
			"Collection.bulkWrite() is not implemented by @surrealdb/mql: mixing insert, update, replace and delete models into one batch needs the per-model result accounting and the ordered/unordered failure semantics that BulkWriteResult reports, and neither is implemented. Call the single-purpose methods, or run them inside session.withTransaction() so they commit or roll back as a unit.",
		],
		[
			"Collection.rename()",
			() => collection().rename("other"),
			"Collection.rename() is not implemented by @surrealdb/mql: SurrealDB has no statement that renames a table, and copying every record under a new name is not something a rename should do behind the caller's back. Create the new collection, copy the documents across yourself, then dropCollection() the old one.",
		],
		[
			"Db.renameCollection()",
			() => db().renameCollection("things", "other"),
			"Db.renameCollection() is not implemented by @surrealdb/mql: SurrealDB has no statement that renames a table, and copying every record under a new name is not something a rename should do behind the caller's back. Create the new collection, copy the documents across yourself, then dropCollection() the old one.",
		],
		[
			"Collection.createSearchIndex()",
			() => collection().createSearchIndex({ definition: {} }),
			"Collection.createSearchIndex() is not implemented by @surrealdb/mql: Atlas Search indexes are a MongoDB Atlas service, and there is no SurrealDB counterpart to define one against. Use createIndex() with a text index, which this driver defines as a SurrealDB full-text search index.",
		],
		[
			"Collection.createSearchIndexes()",
			() => collection().createSearchIndexes([{ definition: {} }]),
			"Collection.createSearchIndexes() is not implemented by @surrealdb/mql: Atlas Search indexes are a MongoDB Atlas service, and there is no SurrealDB counterpart to define one against. Use createIndex() with a text index, which this driver defines as a SurrealDB full-text search index.",
		],
		[
			"Collection.dropSearchIndex()",
			() => collection().dropSearchIndex("idx"),
			"Collection.dropSearchIndex() is not implemented by @surrealdb/mql: Atlas Search indexes are a MongoDB Atlas service, and there is no SurrealDB counterpart to define one against. Use createIndex() with a text index, which this driver defines as a SurrealDB full-text search index.",
		],
		[
			"Collection.updateSearchIndex()",
			() => collection().updateSearchIndex("idx", {}),
			"Collection.updateSearchIndex() is not implemented by @surrealdb/mql: Atlas Search indexes are a MongoDB Atlas service, and there is no SurrealDB counterpart to define one against. Use createIndex() with a text index, which this driver defines as a SurrealDB full-text search index.",
		],
	];

	for (const [name, call, message] of cases) {
		test(`${name} rejects with MongoCompatibilityError`, async () => {
			const promise = call();
			expect(promise).toBeInstanceOf(Promise);
			await expect(promise).rejects.toBeInstanceOf(MongoCompatibilityError);
			await expect(promise).rejects.toThrow(message);
		});
	}
});

// ---------------------------------------------------------------------------
// Where the refusals sit in the hierarchy
// ---------------------------------------------------------------------------

describe("an unimplemented method is a driver-side error, not a server one", () => {
	test("it narrows through the driver branch of the hierarchy", () => {
		let caught: unknown;
		try {
			collection().initializeOrderedBulkOp();
		} catch (error) {
			caught = error;
		}

		// The chain a caller's `catch` may test at any level.
		expect(caught).toBeInstanceOf(MongoCompatibilityError);
		expect(caught).toBeInstanceOf(MongoAPIError);
		expect(caught).toBeInstanceOf(MongoDriverError);
		expect(caught).toBeInstanceOf(MongoError);
		// Not the server's fault, and carrying no server error code to suggest it was.
		expect(caught).not.toBeInstanceOf(MongoServerError);
		expect((caught as MongoCompatibilityError).code).toBeUndefined();
		expect((caught as Error).name).toBe("MongoCompatibilityError");
	});

	test("a TypeError is no longer what a caller gets", () => {
		// The whole point of declaring these methods: before they existed, every
		// call above was `TypeError: … is not a function`, which says nothing about
		// whether the driver is broken, old, or deliberately narrow.
		expect(() => collection().initializeOrderedBulkOp()).not.toThrow(TypeError);
		expect(typeof collection().aggregate).toBe("function");
		expect(typeof collection().bulkWrite).toBe("function");
		expect(typeof collection().watch).toBe("function");
		expect(typeof db().command).toBe("function");
		expect(typeof db().admin).toBe("function");
		expect(typeof db().stats).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// The command surface refuses differently, on purpose
// ---------------------------------------------------------------------------

describe("an unrouted command is a server-level failure", () => {
	test("an unknown command name reports what a real mongod reports", async () => {
		const promise = db().command({ totallyMadeUpCommand: 1 });
		await expect(promise).rejects.toBeInstanceOf(MongoServerError);
		await expect(promise).rejects.toThrow(
			"no such command: 'totallyMadeUpCommand'",
		);

		const error = await promise.catch((e: MongoServerError) => e);
		expect(error.code).toBe(MongoErrorCode.CommandNotFound);
		expect(error.codeName).toBe("CommandNotFound");
	});

	test("a real MongoDB command this driver does not route reports the same", async () => {
		// Deliberate, and documented: `aggregate` is a command a real mongod has, so
		// `no such command` is not literally true of MongoDB. Keeping one rule for
		// the router beats a curated list of every mongod command that would go
		// stale with each MongoDB release — and `CommandNotFound` is the failure
		// every command caller already handles.
		for (const name of [
			"aggregate",
			"collMod",
			"count",
			"distinct",
			"findAndModify",
			"getMore",
			"serverStatus",
		]) {
			const promise = db().command({ [name]: "things" });
			await expect(promise).rejects.toThrow(`no such command: '${name}'`);
		}
	});

	test("command names are matched exactly, as mongod matches them", async () => {
		await expect(db().command({ Ping: 1 })).rejects.toThrow(
			"no such command: 'Ping'",
		);
	});

	test("a command document naming nothing is the caller's mistake", async () => {
		await expect(db().command({})).rejects.toThrow(
			"Command document must contain at least one field naming the command to run",
		);
	});

	test("a command MongoDB restricts to the admin database is refused elsewhere", async () => {
		for (const name of ["listDatabases", "replSetGetStatus"]) {
			const promise = db().command({ [name]: 1 });
			await expect(promise).rejects.toThrow(
				`${name} may only be run against the admin database.`,
			);
			const error = await promise.catch((e: MongoServerError) => e);
			expect(error.code).toBe(MongoErrorCode.Unauthorized);
		}
	});

	test("replSetGetStatus answers as a mongod outside a replica set does", async () => {
		const promise = db().admin().replSetGetStatus();
		await expect(promise).rejects.toBeInstanceOf(MongoServerError);
		await expect(promise).rejects.toThrow("not running with --replSet");

		const error = await promise.catch((e: MongoServerError) => e);
		expect(error.code).toBe(MongoErrorCode.NoReplicationEnabled);
		expect(error.codeName).toBe("NoReplicationEnabled");
	});

	test("serverInfo is a driver method, not a command — as in MongoDB", async () => {
		// A real mongod has no `serverInfo` command; the official driver's
		// `Admin.serverInfo()` sends `buildInfo`. Both halves of that are kept.
		await expect(db().command({ serverInfo: 1 })).rejects.toThrow(
			"no such command: 'serverInfo'",
		);
		expect(await db().admin().serverInfo()).toMatchObject({ ok: 1 });
	});

	test("an Admin method whose command is not routed inherits CommandNotFound", async () => {
		const admin = db().admin();
		await expect(admin.serverStatus()).rejects.toThrow(
			"no such command: 'serverStatus'",
		);
		await expect(admin.removeUser("bob")).rejects.toThrow(
			"no such command: 'dropUser'",
		);
		await expect(admin.validateCollection("things")).rejects.toThrow(
			"no such command: 'validate'",
		);
	});
});
