/**
 * Provider that runs an in-memory MongoDB inside Docker and connects the
 * official `mongodb` driver against it.
 *
 * Returns the native `MongoClient` typed as `MongoLikeClient` — the
 * structural shape is compatible because the contract was deliberately
 * carved as a subset (Liskov Substitution).
 */

import { MongoClient as NativeMongoClient } from "mongodb";
import type { MongoLikeClient } from "../contracts/mongo-like.ts";
import type { DatabaseProvider } from "./database-provider.ts";
import {
	pullImage,
	type RunningContainer,
	randomHighPort,
	startContainer,
	waitUntilReady,
} from "./docker-container.ts";

export interface MongoDbDockerProviderOptions {
	/** Docker image to use. Pin in CI to avoid unexpected upgrades. */
	readonly image?: string;
	/** Host port to expose 27017 on. Random by default. */
	readonly hostPort?: number;
	/** Database name to use. */
	readonly databaseName?: string;
	/** How long to wait for MongoDB to accept connections. */
	readonly readinessTimeoutMs?: number;
}

const DEFAULT_IMAGE = "mongo:7.0";
const DEFAULT_DATABASE = "e2e_parity";
const MONGODB_INTERNAL_PORT = 27017;

export class MongoDbDockerProvider implements DatabaseProvider {
	readonly name = "mongodb (docker)";

	private readonly _image: string;
	private readonly _hostPort: number;
	private readonly _databaseName: string;
	private readonly _readinessTimeoutMs: number;

	private _container: RunningContainer | undefined;
	private _client: NativeMongoClient | undefined;

	constructor(options: MongoDbDockerProviderOptions = {}) {
		this._image = options.image ?? DEFAULT_IMAGE;
		this._hostPort = options.hostPort ?? randomHighPort();
		this._databaseName = options.databaseName ?? DEFAULT_DATABASE;
		this._readinessTimeoutMs = options.readinessTimeoutMs ?? 60_000;
	}

	async start(): Promise<MongoLikeClient> {
		await pullImage(this._image);

		this._container = await startContainer({
			image: this._image,
			containerName: `mql-e2e-mongo-${this._hostPort}`,
			publishPorts: [`${this._hostPort}:${MONGODB_INTERNAL_PORT}`],
		});

		const url = `mongodb://127.0.0.1:${this._hostPort}/${this._databaseName}?directConnection=true`;
		this._client = new NativeMongoClient(url, {
			serverSelectionTimeoutMS: 2_000,
		});

		// Use the driver's own connect() as the readiness probe so we know
		// the server is fully usable, not just listening on the port.
		await waitUntilReady(async () => {
			try {
				const probe = new NativeMongoClient(url, {
					serverSelectionTimeoutMS: 1_000,
				});
				await probe.connect();
				await probe.db(this._databaseName).command({ ping: 1 });
				await probe.close();
				return true;
			} catch {
				return false;
			}
		}, this._readinessTimeoutMs);

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
