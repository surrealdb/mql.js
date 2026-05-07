/**
 * Provider that boots an actual `mongod` process via `mongodb-memory-server`
 * and connects the official `mongodb` driver against it.
 *
 * Unlike `MongoDbDockerProvider`, no Docker daemon is required — the
 * package downloads (and caches) a real MongoDB binary on first run and
 * spawns it bound to a random port in a temp directory. That makes this
 * the preferred provider for "lightweight" parity runs (CI, contributors
 * without Docker, watch loops).
 *
 * The returned object is the native `MongoClient` typed as
 * `MongoLikeClient`; the contract (see `contracts/mongo-like.ts`) is a
 * narrow subset both drivers satisfy structurally — Liskov-substitutable
 * with the SurrealDB-backed mql.js client.
 */

import { MongoClient as NativeMongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { MongoLikeClient } from "../contracts/mongo-like.ts";
import type { DatabaseProvider } from "./database-provider.ts";

export interface MongoDbMemoryProviderOptions {
	/** Database name to use in the generated connection string. */
	readonly databaseName?: string;
	/** Hard cap on how long we wait for `mongod` to boot. */
	readonly readinessTimeoutMs?: number;
}

const DEFAULT_DATABASE = "e2e_parity";
const DEFAULT_READINESS_TIMEOUT_MS = 60_000;

export class MongoDbMemoryProvider implements DatabaseProvider {
	readonly name = "mongodb (in-memory)";

	private readonly _databaseName: string;
	private readonly _readinessTimeoutMs: number;

	private _server: MongoMemoryServer | undefined;
	private _client: NativeMongoClient | undefined;

	constructor(options: MongoDbMemoryProviderOptions = {}) {
		this._databaseName = options.databaseName ?? DEFAULT_DATABASE;
		this._readinessTimeoutMs =
			options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
	}

	async start(): Promise<MongoLikeClient> {
		this._server = await MongoMemoryServer.create({
			instance: { dbName: this._databaseName },
		});

		const uri = this._server.getUri(this._databaseName);
		this._client = new NativeMongoClient(uri, {
			serverSelectionTimeoutMS: this._readinessTimeoutMs,
		});
		await this._client.connect();

		return this._client as unknown as MongoLikeClient;
	}

	async stop(): Promise<void> {
		try {
			await this._client?.close();
		} finally {
			this._client = undefined;
			await this._server?.stop({ doCleanup: true, force: true });
			this._server = undefined;
		}
	}
}

/**
 * Best-effort probe that decides whether `MongoMemoryServer` can actually
 * boot in the current environment. Booting requires either a previously
 * cached `mongod` binary on disk or the ability to download one — both of
 * which fail silently in some CI sandboxes. Surfacing that as a "skip"
 * keeps the parity suite green when the environment is the limitation.
 */
export async function isMongoMemoryServerAvailable(): Promise<boolean> {
	try {
		const server = await MongoMemoryServer.create();
		await server.stop({ doCleanup: true, force: true });
		return true;
	} catch {
		return false;
	}
}
