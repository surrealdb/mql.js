/**
 * Provider that runs an in-memory SurrealDB by spawning the local
 * `surreal` binary directly (no Docker) and connects `@surrealdb/mql`
 * (mql.js) to it.
 *
 * This is the SurrealDB counterpart to `MongoDbMemoryProvider`: both
 * skip the heavyweight Docker dependency so the parity suite can run on
 * any developer machine that has the two CLIs installed.
 *
 * The shape returned to scenarios is `MongoLikeClient` — same contract
 * the official MongoDB driver satisfies — making the two providers fully
 * substitutable (Liskov).
 */

import type { Subprocess } from "bun";
import { MongoClient as MqlMongoClient } from "../../../src/index.ts";
import type { MongoLikeClient } from "../contracts/mongo-like.ts";
import type { DatabaseProvider } from "./database-provider.ts";
import { randomHighPort, waitUntilReady } from "./docker-container.ts";

export interface SurrealDbBinaryProviderOptions {
	/** Host port to bind on; random by default. */
	readonly hostPort?: number;
	/** Database name to use in the connection string. */
	readonly databaseName?: string;
	/** SurrealDB namespace passed via the `?namespace=` query parameter. */
	readonly namespace?: string;
	/** Root credentials for the SurrealDB instance. */
	readonly username?: string;
	readonly password?: string;
	/** How long to wait for `/health` to start returning OK. */
	readonly readinessTimeoutMs?: number;
}

const DEFAULT_DATABASE = "e2e_parity";
const DEFAULT_NAMESPACE = "test";
const DEFAULT_USERNAME = "root";
const DEFAULT_PASSWORD = "root";
const DEFAULT_READINESS_TIMEOUT_MS = 30_000;

export class SurrealDbBinaryProvider implements DatabaseProvider {
	readonly name = "mql.js + surrealdb (in-memory)";
	readonly requiresGeospatialIndex = false;

	private readonly _hostPort: number;
	private readonly _databaseName: string;
	private readonly _namespace: string;
	private readonly _username: string;
	private readonly _password: string;
	private readonly _readinessTimeoutMs: number;

	private _process: Subprocess | undefined;
	private _client: MqlMongoClient | undefined;

	constructor(options: SurrealDbBinaryProviderOptions = {}) {
		this._hostPort = options.hostPort ?? randomHighPort();
		this._databaseName = options.databaseName ?? DEFAULT_DATABASE;
		this._namespace = options.namespace ?? DEFAULT_NAMESPACE;
		this._username = options.username ?? DEFAULT_USERNAME;
		this._password = options.password ?? DEFAULT_PASSWORD;
		this._readinessTimeoutMs =
			options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
	}

	async start(): Promise<MongoLikeClient> {
		this._process = Bun.spawn(
			[
				"surreal",
				"start",
				"--bind",
				`127.0.0.1:${this._hostPort}`,
				"--username",
				this._username,
				"--password",
				this._password,
				"memory",
			],
			{ stdout: "ignore", stderr: "ignore" },
		);

		await waitUntilReady(async () => {
			try {
				const resp = await fetch(`http://127.0.0.1:${this._hostPort}/health`);
				return resp.ok;
			} catch {
				return false;
			}
		}, this._readinessTimeoutMs);

		this._client = new MqlMongoClient(
			`mongodb://${this._username}:${this._password}@127.0.0.1:${this._hostPort}/${this._databaseName}?namespace=${this._namespace}`,
		);
		await this._client.connect();

		return this._client as unknown as MongoLikeClient;
	}

	async stop(): Promise<void> {
		try {
			await this._client?.close();
		} finally {
			this._client = undefined;
			this._process?.kill();
			this._process = undefined;
		}
	}
}

/**
 * Resolves to `true` iff a `surreal` binary capable of starting an
 * in-memory instance is on `PATH`. The parity suite uses this to skip
 * gracefully on machines where SurrealDB isn't installed.
 */
export async function isSurrealBinaryAvailable(): Promise<boolean> {
	try {
		const proc = Bun.spawn(["surreal", "version"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const exitCode = await proc.exited;
		return exitCode === 0;
	} catch {
		return false;
	}
}
