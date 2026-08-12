import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ConnectOptions } from "surrealdb";
import { Surreal } from "surrealdb";
import { MongoClient } from "../../../src/client/mongo-client.ts";
import {
	MongoInvalidArgumentError,
	MongoNotConnectedError,
	MongoServerSelectionError,
} from "../../../src/errors.ts";

/**
 * What the stubbed SDK recorded, so a test can assert on what actually reached
 * `Surreal.connect()` rather than on an intermediate representation.
 */
interface Recording {
	connects: Array<{ url: string; options: ConnectOptions }>;
	queries: string[];
	closes: number;
}

type Stub = {
	recording: Recording;
	/** Make the next `connect()` hang, to exercise the connect budget. */
	hang: boolean;
};

const originals = {
	connect: Surreal.prototype.connect,
	query: Surreal.prototype.query,
	version: Surreal.prototype.version,
	close: Surreal.prototype.close,
	subscribe: Surreal.prototype.subscribe,
};

let stub: Stub;

beforeEach(() => {
	stub = { recording: { connects: [], queries: [], closes: 0 }, hang: false };

	Surreal.prototype.connect = (async (
		url: string | URL,
		options?: ConnectOptions,
	) => {
		stub.recording.connects.push({
			url: String(url),
			options: options ?? {},
		});
		if (stub.hang) await new Promise(() => {});
		return true;
	}) as typeof Surreal.prototype.connect;

	Surreal.prototype.query = (async (sql: string) => {
		stub.recording.queries.push(sql);
		return [];
	}) as unknown as typeof Surreal.prototype.query;

	Surreal.prototype.version = (async () => ({
		version: "surrealdb-3.2.4",
	})) as typeof Surreal.prototype.version;

	Surreal.prototype.close = (async () => {
		stub.recording.closes += 1;
		return true;
	}) as typeof Surreal.prototype.close;

	Surreal.prototype.subscribe = (() =>
		() => {}) as unknown as typeof Surreal.prototype.subscribe;
});

afterEach(() => {
	Object.assign(Surreal.prototype, originals);
});

describe("MongoClient: connect payload", () => {
	test("the percent-decoded password is what reaches SurrealDB", async () => {
		const client = new MongoClient(
			"mongodb://user:p%40ssw%2Frd@127.0.0.1:8000/mydb?namespace=ns",
		);
		await client.connect();

		const [attempt] = stub.recording.connects;
		expect(attempt?.url).toBe("ws://127.0.0.1:8000/rpc");
		expect(attempt?.options.authentication).toEqual({
			username: "user",
			password: "p@ssw/rd",
		});
		expect(attempt?.options.namespace).toBe("ns");
		expect(attempt?.options.database).toBe("mydb");
	});

	test("a username with no password signs in with an empty one", async () => {
		const client = new MongoClient("mongodb://user@127.0.0.1:8000/mydb");
		await client.connect();

		expect(stub.recording.connects[0]?.options.authentication).toEqual({
			username: "user",
			password: "",
		});
	});

	test("no credentials means no authentication payload", async () => {
		const client = new MongoClient("mongodb://127.0.0.1:8000/mydb");
		await client.connect();

		expect(stub.recording.connects[0]?.options.authentication).toBeUndefined();
	});

	test("the auth option overrides the string's userinfo", async () => {
		const client = new MongoClient("mongodb://u1:p1@127.0.0.1:8000/mydb", {
			auth: { username: "u2", password: "p2" },
		});
		await client.connect();

		expect(stub.recording.connects[0]?.options.authentication).toEqual({
			username: "u2",
			password: "p2",
		});
	});

	test("authSource names a database whose own users are signed in", async () => {
		const client = new MongoClient(
			"mongodb://u:p@127.0.0.1:8000/mydb?namespace=ns&authSource=accounts",
		);
		await client.connect();

		expect(stub.recording.connects[0]?.options.authentication).toEqual({
			namespace: "ns",
			database: "accounts",
			username: "u",
			password: "p",
		});
	});

	test("authSource=admin keeps the root signin MongoDB reserves it for", async () => {
		const client = new MongoClient(
			"mongodb://u:p@127.0.0.1:8000/mydb?authSource=admin",
		);
		await client.connect();

		expect(stub.recording.connects[0]?.options.authentication).toEqual({
			username: "u",
			password: "p",
		});
	});

	test("authSource=$external is refused", async () => {
		const client = new MongoClient(
			"mongodb://u:p@127.0.0.1:8000/mydb?authSource=$external",
		);
		await expect(client.connect()).rejects.toThrow(/\$external/);
	});

	test("reconnect is disabled unless the caller asks", async () => {
		await new MongoClient("mongodb://127.0.0.1:8000/mydb").connect();
		expect(stub.recording.connects[0]?.options.reconnect).toBe(false);

		await new MongoClient("mongodb://127.0.0.1:8000/mydb", {
			reconnect: { attempts: 5 },
		}).connect();
		expect(stub.recording.connects[1]?.options.reconnect).toEqual({
			attempts: 5,
		});
	});
});

describe("MongoClient: lifecycle", () => {
	test("the connection string is parsed by the constructor", () => {
		expect(() => new MongoClient("mongodb://h:8000/db?wibble=1")).toThrow(
			"option wibble is not supported",
		);
	});

	test("db() works before connect(), and the first operation connects", async () => {
		const client = new MongoClient("mongodb://127.0.0.1:8000/mydb");
		const collection = client.db().collection("things");

		expect(stub.recording.connects).toHaveLength(0);

		await collection.countDocuments();

		expect(stub.recording.connects).toHaveLength(1);
	});

	test("concurrent operations share a single connect", async () => {
		const client = new MongoClient("mongodb://127.0.0.1:8000/mydb");
		const collection = client.db().collection("things");

		await Promise.all([
			collection.countDocuments(),
			collection.countDocuments(),
			collection.countDocuments(),
		]);

		expect(stub.recording.connects).toHaveLength(1);
	});

	test("connect() is idempotent", async () => {
		const client = new MongoClient("mongodb://127.0.0.1:8000/mydb");
		await client.connect();
		await client.connect();

		expect(stub.recording.connects).toHaveLength(1);
	});

	test("db() names the database from the string, or MongoDB's default", () => {
		expect(new MongoClient("mongodb://h:8000/mydb").db().databaseName).toBe(
			"mydb",
		);
		expect(new MongoClient("mongodb://h:8000").db().databaseName).toBe("test");
		expect(
			new MongoClient("mongodb://h:8000/mydb").db("other").databaseName,
		).toBe("other");
	});

	test("db() rejects a name MongoDB rejects", () => {
		const client = new MongoClient("mongodb://h:8000/mydb");
		expect(() => client.db("a.b")).toThrow(MongoInvalidArgumentError);
		expect(() => client.db("a.b")).toThrow(
			"Database names cannot contain the character '.'",
		);
	});

	test("db() accepts every other name MongoDB accepts", () => {
		// Measured against the official driver (7.5.0): `.` is the only character it
		// refuses client-side. A name mongod would then reject — over 63 bytes, or
		// containing `$` — is accepted by both, and by SurrealDB, which has no such
		// restriction to reject it with.
		const client = new MongoClient("mongodb://h:8000/mydb");
		for (const name of ["a$b", "a b", "A".repeat(64), "a/b", 'a"b']) {
			expect(client.db(name).databaseName).toBe(name);
		}
	});

	test("db('') means the connection string's database, as MongoDB's does", () => {
		// Measured: the official driver reports `test` for `db("")` against a client
		// with no database in its string, i.e. it treats an empty name as none given.
		expect(new MongoClient("mongodb://h:8000/mydb").db("").databaseName).toBe(
			"mydb",
		);
		expect(new MongoClient("mongodb://h:8000").db("").databaseName).toBe(
			"test",
		);
	});

	test("an operation after close() fails instead of reconnecting", async () => {
		const client = new MongoClient("mongodb://127.0.0.1:8000/mydb");
		const collection = client.db().collection("things");
		await client.connect();
		await client.close();

		await expect(collection.countDocuments()).rejects.toThrow(
			MongoNotConnectedError,
		);
		expect(stub.recording.connects).toHaveLength(1);
	});

	test("options reports the merged view of every setting", () => {
		const client = new MongoClient(
			"mongodb://h:8000/db?retryWrites=true&maxPoolSize=7",
			{ appName: "svc" },
		);
		expect(client.options.retryWrites).toBe(true);
		expect(client.options.maxPoolSize).toBe(7);
		expect(client.options.appName).toBe("svc");
	});

	test("the static connect() returns a connected client", async () => {
		const client = await MongoClient.connect("mongodb://127.0.0.1:8000/mydb");
		expect(client).toBeInstanceOf(MongoClient);
		expect(stub.recording.connects).toHaveLength(1);
	});

	test("the namespace and database are created up front", async () => {
		const client = new MongoClient(
			"mongodb://127.0.0.1:8000/mydb?namespace=ns",
		);
		await client.connect();

		expect(stub.recording.queries[0]).toContain(
			"DEFINE NAMESPACE IF NOT EXISTS `ns`",
		);
		expect(stub.recording.queries[0]).toContain(
			"DEFINE DATABASE IF NOT EXISTS `mydb`",
		);
	});
});

/**
 * Which database a statement is sent to.
 *
 * The connected database is by far the most common case, so it is asserted here
 * as an absence: no prefix, one statement, nothing extra on the wire. A named
 * database gets the prefix, and the executor behind it is shared rather than
 * rebuilt, because `client.db("x").collection("y")` is written inline and in
 * loops.
 */
describe("MongoClient: per-database addressing", () => {
	/** Everything sent after the connect-time namespace/database definition. */
	function statements(): string[] {
		return stub.recording.queries.slice(1);
	}

	test("the connected database's statements are sent unchanged", async () => {
		const client = new MongoClient("mongodb://127.0.0.1:8000/mydb");
		await client.connect();

		await client.db().collection("things").countDocuments();
		await client.db("mydb").collection("things").countDocuments();

		expect(statements()).toHaveLength(2);
		for (const sql of statements()) expect(sql).not.toContain("USE DB");
	});

	test("another database's statements name it", async () => {
		const client = new MongoClient("mongodb://127.0.0.1:8000/mydb");
		await client.connect();

		await client.db("other").collection("things").countDocuments();

		expect(statements()[0]).toStartWith("USE DB `other`; ");
	});

	test("one executor is shared by every db() naming the same database", () => {
		const client = new MongoClient("mongodb://127.0.0.1:8000/mydb");

		expect(client.db("other")._connection).toBe(client.db("other")._connection);
		expect(client.db("other")._connection).not.toBe(client.db()._connection);
		expect(client.db("mydb")._connection).toBe(client.db()._connection);
	});

	test("db(name) before connect() connects on its first statement", async () => {
		const client = new MongoClient("mongodb://127.0.0.1:8000/mydb");
		const collection = client.db("other").collection("things");

		expect(stub.recording.connects).toHaveLength(0);

		await collection.countDocuments();

		expect(stub.recording.connects).toHaveLength(1);
	});

	test("a reconnect leaves the same handles addressing the same databases", async () => {
		const client = new MongoClient("mongodb://127.0.0.1:8000/mydb");
		const other = client.db("other").collection("things");
		await client.connect();
		await other.countDocuments();
		await client.close();

		// Nothing per-database was held open, so there is nothing to re-establish:
		// the handle from before the reconnect addresses the same database after it.
		await client.connect();
		await other.countDocuments();

		expect(stub.recording.connects).toHaveLength(2);
		expect(statements().at(-1)).toStartWith("USE DB `other`; ");
	});

	test("db(name) after close() fails instead of reconnecting", async () => {
		const client = new MongoClient("mongodb://127.0.0.1:8000/mydb");
		await client.connect();
		await client.close();

		await expect(
			client.db("other").collection("things").countDocuments(),
		).rejects.toThrow(MongoNotConnectedError);
	});
});

describe("MongoClient: connect budget", () => {
	test("a connect that never completes fails with the caller's budget", async () => {
		stub.hang = true;
		const client = new MongoClient(
			"mongodb://127.0.0.1:8000/mydb?serverSelectionTimeoutMS=30",
		);

		await expect(client.connect()).rejects.toThrow(MongoServerSelectionError);
	});

	test("the tighter of the two budgets is the one reported", async () => {
		stub.hang = true;
		const client = new MongoClient(
			"mongodb://127.0.0.1:8000/mydb?serverSelectionTimeoutMS=5000&connectTimeoutMS=30",
		);

		await expect(client.connect()).rejects.toThrow(
			"connection timed out after 30 ms",
		);
	});

	test("an expired budget closes the attempt it abandoned", async () => {
		stub.hang = true;
		const client = new MongoClient(
			"mongodb://127.0.0.1:8000/mydb?connectTimeoutMS=20",
		);

		await expect(client.connect()).rejects.toThrow();
		expect(stub.recording.closes).toBeGreaterThan(0);
	});

	test("a failed connect can be retried", async () => {
		stub.hang = true;
		const client = new MongoClient(
			"mongodb://127.0.0.1:8000/mydb?connectTimeoutMS=20",
		);

		await expect(client.connect()).rejects.toThrow();
		stub.hang = false;
		await client.connect();

		expect(stub.recording.connects).toHaveLength(2);
	});
});
