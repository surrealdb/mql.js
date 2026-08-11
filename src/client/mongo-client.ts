/**
 * MongoDB-compatible `MongoClient` facade.
 *
 * Holds the SurrealDB executor (driver port) and brings the connection up on
 * `connect()` — or on the first operation, for a caller who never called it.
 * Connection bring-up, option policy, credential mapping and error translation
 * each live in a focused helper so this class can stay narrow and easily
 * mockable in tests.
 */

import { type ConnectOptions, Surreal } from "surrealdb";
import type { ClientDefaults } from "../collection/operation-context.ts";
import type { Db } from "../db/db.ts";
import { createDb } from "../db/db.ts";
import {
	MongoCompatibilityError,
	MongoInvalidArgumentError,
	MongoNotConnectedError,
} from "../errors.ts";
import type { QueryExecutor } from "../surreal/query-executor.ts";
import { SurrealdbExecutor } from "../surreal/surrealdb-executor.ts";
import {
	isUnsupportedVersion,
	MINIMUM_SURREALDB_VERSION,
} from "../translators/dialect/index.ts";
import type { MongoClientOptions } from "../types.ts";
import { resolveAuthentication } from "./authentication.ts";
import { ClientExecutor } from "./client-executor.ts";
import type { ClientSettings } from "./client-options.ts";
import { ConnectionManager } from "./connection-manager.ts";
import type { ParsedConnection } from "./connection-string.ts";
import { parseConnectionString } from "./connection-string.ts";

export class MongoClient {
	/** @internal Backwards-compatibility shim used by integration helpers. */
	readonly _surreal: Surreal;
	/** @internal Driver port consumed by `Db` / `Collection` / `FindCursor`. */
	readonly _executor: QueryExecutor;
	/** @internal */
	_connected: boolean;

	private readonly _inner: SurrealdbExecutor;
	private readonly _parsed: ParsedConnection;
	private readonly _settings: ClientSettings;
	private readonly _connectionManager: ConnectionManager;
	private _serverVersion: string | undefined;
	private _closed = false;
	/** In-flight or completed connect, so concurrent operations share one. */
	private _connecting: Promise<void> | undefined;

	/**
	 * Create a new MongoClient instance.
	 *
	 * The connection string is parsed here rather than on `connect()`, as the
	 * official driver parses it: a mistyped option or an unusable scheme is a
	 * mistake in the string, and the stack that reports it should be the one that
	 * wrote the string.
	 *
	 * @param url     - MongoDB-style connection string
	 *                  (e.g. `mongodb://user:pass@host:port/database`).
	 * @param options - Client settings; see `MongoClientOptions`.
	 */
	constructor(url: string, options?: MongoClientOptions) {
		this._parsed = parseConnectionString(url, options);
		this._settings = this._parsed.settings;
		this._surreal = new Surreal();
		this._inner = new SurrealdbExecutor(this._surreal);
		this._executor = new ClientExecutor(this._inner, {
			ensureConnected: () => this.ensureConnected(),
			isClosed: () => this._closed,
		});
		this._connectionManager = new ConnectionManager(this._surreal);
		this._connected = false;
	}

	/**
	 * Every option this client resolved, from the connection string and the
	 * constructor together.
	 *
	 * Only the options this driver honours carry a default: reporting
	 * `maxPoolSize: 100` because MongoDB defaults to it would suggest a pool that
	 * does not exist.
	 */
	get options(): Readonly<MongoClientOptions> {
		return this._settings.options;
	}

	/**
	 * Connect to SurrealDB using the MongoDB-style connection string.
	 * Returns `this` for chaining (matches MongoDB driver behaviour).
	 *
	 * Idempotent, and safe to call concurrently: a second call joins the first
	 * rather than opening a second connection.
	 */
	async connect(): Promise<this> {
		// An explicit connect reopens a client that was closed, which is the only
		// way back: an operation on a closed client fails rather than reconnecting.
		this._closed = false;
		await this.ensureConnected();
		return this;
	}

	/**
	 * Connect a new client in one step, as `MongoClient.connect()` does in the
	 * official driver.
	 */
	static async connect(
		url: string,
		options?: MongoClientOptions,
	): Promise<MongoClient> {
		return new MongoClient(url, options).connect();
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

	/** @internal Client-wide option defaults every operation inherits. */
	get defaults(): ClientDefaults {
		return {
			ignoreUndefined: this._settings.ignoreUndefined,
			timeoutMS: this._settings.timeoutMS,
		};
	}

	/** Close the connection and release resources. */
	async close(): Promise<void> {
		this._closed = true;
		this._connecting = undefined;
		if (this._connected) {
			this._connected = false;
			await this._inner.close();
		}
	}

	/**
	 * Return a `Db` instance. If `dbName` is omitted the database from the
	 * connection string is used, or MongoDB's default of `test`.
	 *
	 * Available before `connect()`, as it is in the official driver: the
	 * connection is established by the first operation the `Db` performs.
	 */
	db(dbName?: string): Db {
		const name = dbName ?? this._parsed.database;
		if (name.includes(".")) {
			throw new MongoInvalidArgumentError(
				"Database names cannot contain the character '.'",
			);
		}
		return createDb(this, name);
	}

	/**
	 * Bring the connection up, once.
	 *
	 * A failed attempt clears the memo so a later operation retries rather than
	 * replaying the original failure forever.
	 */
	private async ensureConnected(): Promise<void> {
		if (this._connected) return;
		this._connecting ??= this.establish().catch((err: unknown) => {
			this._connecting = undefined;
			throw err;
		});
		await this._connecting;
	}

	/** The connect sequence itself: connect, ensure the target exists, verify. */
	private async establish(): Promise<void> {
		const parsed = this._parsed;

		await this._connectionManager.connect({
			url: parsed.surrealUrl,
			options: this.buildConnectOptions(),
			connectTimeoutMS: this._settings.connectTimeoutMS,
			serverSelectionTimeoutMS: this._settings.serverSelectionTimeoutMS,
		});

		// A `close()` that landed while the connection was still coming up wins:
		// finishing the bring-up would leave a socket open behind a client the
		// caller has already ended.
		if (this._closed) {
			await this._inner.close().catch(() => {});
			throw new MongoNotConnectedError(
				"Client must be connected before running operations",
			);
		}

		this._connected = true;

		// MongoDB creates a database implicitly on first write; newer SurrealDB
		// versions no longer auto-create the namespace/database, so ensure they
		// exist up front or the first operation fails with "namespace does not
		// exist". Best-effort: never fails an otherwise-usable connection.
		await this._connectionManager.ensureNamespaceAndDatabase(
			parsed.namespace,
			parsed.database,
		);

		this._serverVersion = await this._connectionManager.detectServerVersion();

		// Fail fast on a server whose SurrealQL grammar this driver no longer
		// emits, rather than letting every later query fail with a parse error.
		// Detection is best-effort: an undetectable version is allowed through.
		if (isUnsupportedVersion(this._serverVersion)) {
			await this._inner.close().catch(() => {});
			this._connected = false;
			throw new MongoCompatibilityError(
				`SurrealDB ${this._serverVersion} is not supported: @surrealdb/mql requires SurrealDB ${MINIMUM_SURREALDB_VERSION} or newer.`,
			);
		}

		this._inner.setServerVersion(this._serverVersion);
	}

	private buildConnectOptions(): ConnectOptions {
		const { namespace, database, username, password } = this._parsed;

		const options: ConnectOptions = {
			versionCheck: false,
			namespace,
			database,
			// Fail-fast by default, and configurable: without an explicit
			// `reconnect`, a connection lost mid-operation would be re-established in
			// the background while the caller's promise waits with nothing to say.
			reconnect: this._settings.reconnect,
		};

		const authentication = resolveAuthentication({
			username: this._settings.auth?.username ?? username,
			password: this._settings.auth?.password ?? password,
			namespace,
			authSource: this._settings.authSource,
		});
		if (authentication) options.authentication = authentication;

		return options;
	}
}
