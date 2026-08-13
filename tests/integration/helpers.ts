/**
 * Shared test lifecycle helpers for integration tests.
 *
 * Encapsulates the SurrealDB process spawning, health-check polling,
 * client connection, and cleanup logic so each test file only needs
 * to provide a unique port number.
 */

import type { Subprocess } from "bun";
import type { Collection, Db } from "../../src/index.ts";
import { MongoClient } from "../../src/index.ts";
import type { Document } from "../../src/types.ts";

export interface SurrealTestContext<TSchema extends Document = Document> {
	process: Subprocess;
	client: MongoClient;
	db: Db;
	collection: (name: string) => Collection<TSchema>;
	/** Server version reported by the connected SurrealDB instance (e.g. "3.0.4"). */
	serverVersion: string;
}

/**
 * Wait until the SurrealDB HTTP health endpoint responds OK.
 *
 * Pass `proc` whenever the process is to hand. A health check alone cannot tell
 * *whose* server answered: if the port is already taken, `surreal start` exits
 * immediately, this poll succeeds against the other process, and the file runs
 * to the point where that other process is torn down — surfacing as
 * "You must be connected to a SurrealDB instance" partway through, in a file
 * whose setup appeared to succeed. That is a genuinely hard failure to read
 * back to a cause. Watching our own process turns it into an error here, naming
 * the port.
 */
export async function waitForSurreal(
	port: number,
	timeoutMs = 10000,
	proc?: Pick<Subprocess, "exitCode">,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (proc && proc.exitCode !== null) {
			throw new Error(
				`SurrealDB exited with code ${proc.exitCode} before serving ${port}; ` +
					"the port is most likely already in use",
			);
		}
		try {
			const resp = await fetch(`http://127.0.0.1:${port}/health`);
			if (resp.ok) return;
		} catch {
			// Not ready yet
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`SurrealDB did not start within ${timeoutMs}ms`);
}

/**
 * Start a SurrealDB in-memory instance, connect a MongoClient, and
 * return everything the tests need.
 */
export async function setupSurreal<TSchema extends Document = Document>(
	port: number,
	dbName = "testdb",
): Promise<SurrealTestContext<TSchema>> {
	const proc = Bun.spawn(
		[
			"surreal",
			"start",
			"--bind",
			`127.0.0.1:${port}`,
			"--username",
			"root",
			"--password",
			"root",
			"memory",
		],
		{ stdout: "ignore", stderr: "ignore" },
	);

	await waitForSurreal(port, 10000, proc);

	const client = new MongoClient(
		`mongodb://root:root@127.0.0.1:${port}/${dbName}?namespace=test`,
	);
	await client.connect();
	const db = client.db(dbName);

	const serverVersion = client.serverVersion ?? "0.0.0";

	return {
		process: proc,
		client,
		db,
		collection: (name: string) => db.collection<TSchema>(name),
		serverVersion,
	};
}

/**
 * Close the client and kill the SurrealDB process.
 */
export async function teardownSurreal(
	ctx: SurrealTestContext<Document>,
): Promise<void> {
	await ctx.client.close();
	ctx.process.kill();
}
