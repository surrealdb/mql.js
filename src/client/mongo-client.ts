/**
 * MongoDB-compatible `MongoClient` facade.
 *
 * Holds the SurrealDB executor (driver port) and resolves it once on
 * `connect()`. Connection bring-up, version detection and error
 * translation each live in a focused helper so this class can stay
 * narrow and easily mockable in tests.
 */

import { type ConnectOptions, type RootAuth, Surreal } from "surrealdb";
import type { Db } from "../db/db.ts";
import { createDb } from "../db/db.ts";
import { MongoNotConnectedError } from "../errors.ts";
import type { QueryExecutor } from "../surreal/query-executor.ts";
import { SurrealdbExecutor } from "../surreal/surrealdb-executor.ts";
import type { MongoClientOptions } from "../types.ts";
import { ConnectionManager } from "./connection-manager.ts";
import { parseConnectionString } from "./connection-string.ts";

export class MongoClient {
	/** @internal Backwards-compatibility shim used by integration helpers. */
	readonly _surreal: Surreal;
	/** @internal Driver port consumed by `Db` / `Collection` / `FindCursor`. */
	readonly _executor: SurrealdbExecutor;
	/** @internal */
	_connected: boolean;

	private readonly _url: string;
	private readonly _options: MongoClientOptions;
	private readonly _connectionManager: ConnectionManager;
	private _defaultDbName?: string;
	private _serverVersion: string | undefined;

	/**
	 * Create a new MongoClient instance.
	 *
	 * @param url     - MongoDB-style connection string
	 *                  (e.g. `mongodb://user:pass@host:port/database`).
	 * @param options - Optional client settings such as namespace or database overrides.
	 */
	constructor(url: string, options?: MongoClientOptions) {
		this._url = url;
		this._options = options ?? {};
		this._surreal = new Surreal();
		this._executor = new SurrealdbExecutor(this._surreal);
		this._connectionManager = new ConnectionManager(this._surreal);
		this._connected = false;
	}

	/**
	 * Connect to SurrealDB using the MongoDB-style connection string.
	 * Returns `this` for chaining (matches MongoDB driver behaviour).
	 */
	async connect(): Promise<this> {
		const parsed = parseConnectionString(this._url, {
			namespace: this._options.namespace,
			database: this._options.database,
		});

		this._defaultDbName = parsed.database;

		const connectOptions = this.buildConnectOptions(parsed);

		await this._connectionManager.connect({
			url: parsed.surrealUrl,
			options: connectOptions,
		});

		this._connected = true;

		this._serverVersion = await this._connectionManager.detectServerVersion();
		this._executor.setServerVersion(this._serverVersion);

		return this;
	}

	/**
	 * Version reported by the connected SurrealDB server (e.g. "3.0.4").
	 * Returns `undefined` when not connected or detection failed.
	 */
	get serverVersion(): string | undefined {
		return this._serverVersion;
	}

	/** The underlying executor – useful for advanced/extensions or tests. */
	get executor(): QueryExecutor {
		return this._executor;
	}

	/** Close the connection and release resources. */
	async close(): Promise<void> {
		if (this._connected) {
			await this._executor.close();
			this._connected = false;
		}
	}

	/**
	 * Return a Db instance. If `dbName` is omitted the database from
	 * the connection string is used.
	 */
	db(dbName?: string): Db {
		if (!this._connected) throw new MongoNotConnectedError();
		const name = dbName ?? this._defaultDbName;
		if (!name) throw new MongoNotConnectedError();
		return createDb(this, name);
	}

	private buildConnectOptions(parsed: {
		namespace?: string;
		database?: string;
		username?: string;
		password?: string;
	}): ConnectOptions {
		const options: ConnectOptions = {
			versionCheck: false,
			// Disable engine-level reconnect so a failed initial connection
			// surfaces immediately. This preserves the v1 fail-fast behaviour
			// users of this driver have come to expect from connect().
			reconnect: false,
		};

		if (parsed.namespace) options.namespace = parsed.namespace;
		if (parsed.database) options.database = parsed.database;
		if (parsed.username && parsed.password) {
			const authentication: RootAuth = {
				username: parsed.username,
				password: parsed.password,
			};
			options.authentication = authentication;
		}

		return options;
	}
}
