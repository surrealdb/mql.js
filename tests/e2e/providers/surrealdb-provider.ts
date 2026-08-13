/**
 * Provider that runs an in-memory SurrealDB inside Docker and connects the
 * `@surrealdb/mql` (mql.js) driver against it.
 *
 * Crucially, the only thing this file does differently from
 * `mongodb-provider.ts` is import a different `MongoClient`. Same API,
 * same return type, fully Liskov-substitutable in the scenarios.
 */

import { MongoClient as MqlMongoClient } from "../../../src/index.ts";
import type { MongoLikeClient } from "../contracts/mongo-like.ts";
import type { DatabaseProvider } from "./database-provider.ts";
import {
	pullImage,
	type RunningContainer,
	startContainerOnFreePort,
	waitUntilReady,
} from "./docker-container.ts";

export interface SurrealDbDockerProviderOptions {
	/** Docker image to use. */
	readonly image?: string;
	/** Host port to expose 8000 on. Random by default. */
	readonly hostPort?: number;
	/** Database name to use. */
	readonly databaseName?: string;
	/** How long to wait for SurrealDB to respond on /health. */
	readonly readinessTimeoutMs?: number;
}

/**
 * Pinned so a SurrealDB release cannot silently change what the parity suite
 * proves. Override with `MQL_SURREALDB_IMAGE` (CI matrixes this across every
 * supported 3.x minor plus `nightly`).
 */
const DEFAULT_IMAGE =
	process.env.MQL_SURREALDB_IMAGE ?? "surrealdb/surrealdb:v3.2.4";
const DEFAULT_DATABASE = "e2e_parity";
const SURREALDB_INTERNAL_PORT = 8000;

export class SurrealDbDockerProvider implements DatabaseProvider {
	readonly name = "mql.js + surrealdb (docker)";
	readonly requiresGeospatialIndex = false;

	private readonly _image: string;
	private readonly _requestedPort: number | undefined;
	private readonly _databaseName: string;
	private readonly _readinessTimeoutMs: number;

	/** Settled in `start()`, once a port is known to be free. */
	private _hostPort = 0;
	private _container: RunningContainer | undefined;
	private _client: MqlMongoClient | undefined;

	constructor(options: SurrealDbDockerProviderOptions = {}) {
		this._image = options.image ?? DEFAULT_IMAGE;
		this._requestedPort = options.hostPort;
		this._databaseName = options.databaseName ?? DEFAULT_DATABASE;
		this._readinessTimeoutMs = options.readinessTimeoutMs ?? 60_000;
	}

	async start(): Promise<MongoLikeClient> {
		await pullImage(this._image);

		const started = await startContainerOnFreePort(
			(hostPort) => ({
				image: this._image,
				containerName: `mql-e2e-surreal-${hostPort}`,
				publishPorts: [`${hostPort}:${SURREALDB_INTERNAL_PORT}`],
				args: [
					"start",
					"--bind",
					`0.0.0.0:${SURREALDB_INTERNAL_PORT}`,
					"--user",
					"root",
					"--pass",
					"root",
					"memory",
				],
			}),
			this._requestedPort,
		);
		this._container = started.container;
		this._hostPort = started.hostPort;

		await waitUntilReady(async () => {
			const resp = await fetch(`http://127.0.0.1:${this._hostPort}/health`);
			return resp.ok;
		}, this._readinessTimeoutMs);

		this._client = new MqlMongoClient(
			`mongodb://root:root@127.0.0.1:${this._hostPort}/${this._databaseName}?namespace=test`,
		);
		await this._client.connect();
		return this._client as unknown as MongoLikeClient;
	}

	async stop(): Promise<void> {
		try {
			await this._client?.close();
		} finally {
			this._client = undefined;
			await this._container?.stop();
			this._container = undefined;
		}
	}
}
