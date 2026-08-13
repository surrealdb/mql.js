/**
 * The client's events, against a real server.
 *
 * `open`, `close` and `error` are claims about a connection, so they are asserted
 * by making one rather than by driving a fake: that `open` follows the connection
 * actually being established — including when a caller never calls `connect()` and
 * the first operation does it — and that a failure to connect reaches a listener
 * as well as the caller.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { MongoClient } from "../../src/index.ts";
import { waitForSurreal } from "./helpers.ts";

const PORT = 18145;

let proc: Subprocess | undefined;
const clients: MongoClient[] = [];

/** A server, started per test that needs one so `close` can be observed. */
async function server(): Promise<void> {
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
	await waitForSurreal(PORT);
}

function client(
	url = `mongodb://root:root@127.0.0.1:${PORT}/evdb?namespace=ev`,
) {
	const created = new MongoClient(url);
	clients.push(created);
	return created;
}

afterEach(async () => {
	for (const created of clients.splice(0)) {
		await created.close().catch(() => {});
	}
	proc?.kill();
	proc = undefined;
	await new Promise((resolve) => setTimeout(resolve, 50));
});

describe("MongoClient events", () => {
	test("connect() emits open, with the client as the payload", async () => {
		await server();
		const mql = client();

		const opened: unknown[] = [];
		mql.on("open", (c) => opened.push(c));

		await mql.connect();
		expect(opened).toEqual([mql]);
	});

	test("the first operation emits open too, without an explicit connect", async () => {
		// `open` marks the connection being established, and a caller's first
		// operation establishes it.
		await server();
		const mql = client();

		let opens = 0;
		mql.on("open", () => {
			opens += 1;
		});

		await mql.db("evdb").collection("docs").insertOne({ a: 1 });
		expect(opens).toBe(1);
	});

	test("connect() on an already-open client does not emit open again", async () => {
		await server();
		const mql = client();

		let opens = 0;
		mql.on("open", () => {
			opens += 1;
		});

		await mql.connect();
		await mql.connect();
		expect(opens).toBe(1);
	});

	test("close() emits close once", async () => {
		await server();
		const mql = client();
		await mql.connect();

		const closed: unknown[] = [];
		mql.on("close", (c) => closed.push(c));

		await mql.close();
		await mql.close();
		expect(closed).toEqual([mql]);
	});

	test("close() on a client that never connected emits nothing", async () => {
		const mql = client();
		let closes = 0;
		mql.on("close", () => {
			closes += 1;
		});

		await mql.close();
		expect(closes).toBe(0);
	});

	test("a failure to connect reaches a listener and the caller", async () => {
		// No server on this port. The event is a notification, never the only
		// report — the rejection still happens.
		const mql = client("mongodb://root:root@127.0.0.1:18199/nope?namespace=ev");

		const errors: Error[] = [];
		mql.on("error", (err) => errors.push(err));

		await expect(mql.connect()).rejects.toThrow();
		expect(errors.length).toBe(1);
		expect(errors[0]).toBeInstanceOf(Error);
	});

	test("a connection error with nobody listening does not become an uncaught throw", async () => {
		// Node's EventEmitter would re-raise it. The caller already has the
		// rejection; crashing them as well would be a regression.
		const mql = client("mongodb://root:root@127.0.0.1:18199/nope?namespace=ev");
		await expect(mql.connect()).rejects.toThrow();
	});

	test("once, off and listenerCount work on the client itself", async () => {
		await server();
		const mql = client();

		let onces = 0;
		mql.once("open", () => {
			onces += 1;
		});
		const removed = () => {
			throw new Error("this listener was removed and must not run");
		};
		mql.on("open", removed);
		expect(mql.listenerCount("open")).toBe(2);
		mql.off("open", removed);
		expect(mql.listenerCount("open")).toBe(1);

		await mql.connect();
		await mql.close();
		await mql.connect();
		expect(onces).toBe(1);
	});

	test("reconnecting after close emits open again", async () => {
		await server();
		const mql = client();

		let opens = 0;
		mql.on("open", () => {
			opens += 1;
		});

		await mql.connect();
		await mql.close();
		await mql.connect();
		expect(opens).toBe(2);
	});
});
