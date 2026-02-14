import Surreal from "surrealdb";
import { parseConnectionString } from "./connection.ts";
import type { Db } from "./db.ts";
import { createDb } from "./db.ts";
import { MongoNetworkError, MongoNotConnectedError } from "./errors.ts";
import type { MongoClientOptions } from "./types.ts";

export class MongoClient {
	/** @internal */
	readonly _surreal: Surreal;
	/** @internal */
	_connected: boolean;

	private readonly _url: string;
	private readonly _options: MongoClientOptions;
	private _defaultDbName?: string;

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

		try {
			await this._surreal.connect(parsed.surrealUrl, {
				versionCheck: false,
			});
		} catch (err) {
			throw new MongoNetworkError(
				`Failed to connect to SurrealDB: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		// Authenticate if credentials are present
		if (parsed.username && parsed.password) {
			await this._surreal.signin({
				username: parsed.username,
				password: parsed.password,
			});
		}

		// Select namespace + database if available
		if (parsed.namespace || parsed.database) {
			await this._surreal.use({
				namespace: parsed.namespace,
				database: parsed.database,
			});
		}

		this._connected = true;
		return this;
	}

	/**
	 * Close the connection and release resources.
	 */
	async close(): Promise<void> {
		if (this._connected) {
			await this._surreal.close();
			this._connected = false;
		}
	}

	/**
	 * Return a Db instance. If `dbName` is omitted the database from
	 * the connection string is used.
	 */
	db(dbName?: string): Db {
		if (!this._connected) {
			throw new MongoNotConnectedError();
		}
		const name = dbName ?? this._defaultDbName;
		if (!name) {
			throw new MongoNotConnectedError();
		}
		return createDb(this, name);
	}
}
