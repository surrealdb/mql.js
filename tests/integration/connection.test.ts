/**
 * Connection behaviour against a live SurrealDB server.
 *
 * The credential cases are the ones that cannot be proven by inspecting a parse
 * result: a password is only demonstrably correct if the server accepts it, and
 * the whole point of percent-decoding is that the undecoded form does not
 * authenticate.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import {
	MongoCompatibilityError,
	MongoNotConnectedError,
	MongoServerError,
} from "../../src/errors.ts";
import { MongoClient } from "../../src/index.ts";
import { waitForSurreal } from "./helpers.ts";

const PORT = 18135;
const NAMESPACE = "connns";
const DATABASE = "conndb";

/** A password made entirely of the characters a URI must escape. */
const AWKWARD_PASSWORD = "p@ssw/rd:%x";
const AWKWARD_ENCODED = encodeURIComponent(AWKWARD_PASSWORD);

let proc: Subprocess;
const clients: MongoClient[] = [];

/** Track every client so a failed assertion cannot leave a socket open. */
function track(client: MongoClient): MongoClient {
	clients.push(client);
	return client;
}

beforeAll(async () => {
	proc = Bun.spawn(
		[
			"surreal",
			"start",
			"--bind",
			`127.0.0.1:${PORT}`,
			"--username",
			"root",
			"--password",
			"root",
			"memory",
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	await waitForSurreal(PORT, 10000, proc);

	const root = track(
		new MongoClient(
			`mongodb://root:root@127.0.0.1:${PORT}/${DATABASE}?namespace=${NAMESPACE}`,
		),
	);
	await root.connect();
	await root._executor.query(
		`DEFINE USER awkward ON ROOT PASSWORD '${AWKWARD_PASSWORD}' ROLES OWNER;
		 DEFINE USER scoped ON DATABASE PASSWORD 'scopedpass' ROLES OWNER;`,
	);
});

afterAll(async () => {
	for (const client of clients) await client.close().catch(() => {});
	proc.kill();
});

describe("credentials", () => {
	test("a percent-encoded password authenticates, decoded", async () => {
		const client = track(
			new MongoClient(
				`mongodb://awkward:${AWKWARD_ENCODED}@127.0.0.1:${PORT}/${DATABASE}?namespace=${NAMESPACE}`,
			),
		);
		await client.connect();

		const collection = client.db().collection("things");
		const inserted = await collection.insertOne({ ok: true });
		expect(inserted.acknowledged).toBe(true);
	});

	test("the undecoded form does not authenticate, which is why decoding matters", async () => {
		const client = track(
			new MongoClient(
				`mongodb://awkward:${encodeURIComponent(AWKWARD_ENCODED)}@127.0.0.1:${PORT}/${DATABASE}?namespace=${NAMESPACE}`,
			),
		);

		await expect(client.connect()).rejects.toThrow(MongoServerError);
	});

	test("authSource names a database whose own users can sign in", async () => {
		const client = track(
			new MongoClient(
				`mongodb://scoped:scopedpass@127.0.0.1:${PORT}/${DATABASE}?namespace=${NAMESPACE}&authSource=${DATABASE}`,
			),
		);
		await client.connect();

		const found = await client.db().collection("things").findOne({ ok: true });
		expect(found).not.toBeNull();
	});

	test("a database user cannot sign in at root level, so authSource is load-bearing", async () => {
		const client = track(
			new MongoClient(
				`mongodb://scoped:scopedpass@127.0.0.1:${PORT}/${DATABASE}?namespace=${NAMESPACE}`,
			),
		);

		await expect(client.connect()).rejects.toThrow(MongoServerError);
	});

	test("a wrong password fails with an authentication error", async () => {
		const client = track(
			new MongoClient(
				`mongodb://root:nope@127.0.0.1:${PORT}/${DATABASE}?namespace=${NAMESPACE}`,
			),
		);

		await expect(client.connect()).rejects.toThrow(MongoServerError);
	});
});

describe("lifecycle", () => {
	function connectionString(query = ""): string {
		return `mongodb://root:root@127.0.0.1:${PORT}/${DATABASE}?namespace=${NAMESPACE}${query}`;
	}

	test("an operation on a never-connected client connects on its own", async () => {
		const client = track(new MongoClient(connectionString()));

		const collection = client.db().collection("lazy");
		const inserted = await collection.insertOne({ n: 1 });

		expect(inserted.acknowledged).toBe(true);
		expect(client.serverVersion).toBeDefined();
	});

	test("concurrent first operations share one connection", async () => {
		const client = track(new MongoClient(connectionString()));
		const collection = client.db().collection("concurrent");

		const results = await Promise.all([
			collection.insertOne({ n: 1 }),
			collection.insertOne({ n: 2 }),
			collection.insertOne({ n: 3 }),
		]);

		expect(results).toHaveLength(3);
		expect(await collection.countDocuments()).toBe(3);
	});

	test("an operation after close() fails rather than reconnecting", async () => {
		const client = track(new MongoClient(connectionString()));
		const collection = client.db().collection("closed");
		await client.connect();
		await client.close();

		await expect(collection.countDocuments()).rejects.toThrow(
			MongoNotConnectedError,
		);
	});

	test("the static connect() returns a usable client", async () => {
		const client = track(await MongoClient.connect(connectionString()));

		const collection = client.db().collection("static");
		await collection.insertOne({ n: 1 });
		expect(await collection.countDocuments()).toBe(1);
	});

	test("the client's timeoutMS becomes a TIMEOUT on every operation", async () => {
		const client = track(new MongoClient(connectionString("&timeoutMS=30000")));
		await client.connect();

		// A budget this large cannot expire; what is under test is that a statement
		// carrying the clause still runs, so the clause is in a position SurrealQL
		// accepts on each statement shape.
		const collection = client.db().collection("budgeted");
		await collection.insertOne({ n: 1 });
		await collection.updateOne({ n: 1 }, { $set: { n: 2 } });
		await collection.findOneAndUpdate({ n: 2 }, { $set: { n: 3 } });
		expect(await collection.findOne({ n: 3 })).not.toBeNull();
		expect(await collection.countDocuments({ n: 3 })).toBe(1);
		await collection.deleteOne({ n: 3 });
		expect(await collection.countDocuments()).toBe(0);
	});

	test("a connection refused by the server fails fast", async () => {
		// Port 1 is closed on every platform this runs on.
		const client = track(
			new MongoClient(
				`mongodb://root:root@127.0.0.1:1/${DATABASE}?namespace=${NAMESPACE}&connectTimeoutMS=2000`,
			),
		);

		await expect(client.connect()).rejects.toThrow();
	});

	test("an unsupportable option is refused before a socket is opened", () => {
		expect(() => new MongoClient(connectionString("&w=0"))).toThrow(
			MongoCompatibilityError,
		);
	});
});
