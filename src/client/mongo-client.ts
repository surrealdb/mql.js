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
import type {
	ClientSessionOptions,
	WithSessionCallback,
} from "../session/client-session.ts";
import { ClientSession } from "../session/client-session.ts";
import { BSON_CODEC_OPTIONS } from "../surreal/bson-codec.ts";
import type { QueryExecutor } from "../surreal/query-executor.ts";
import { SurrealdbExecutor } from "../surreal/surrealdb-executor.ts";
import type { TransactionScope } from "../surreal/transaction-executor.ts";
import {
	isUnsupportedVersion,
	MINIMUM_SURREALDB_VERSION,
} from "../translators/dialect/index.ts";
import type {
	ChangeStream,
	ChangeStreamDocument,
	ChangeStreamOptions,
	Document,
	MongoClientOptions,
} from "../types.ts";
import { CHANGE_STREAMS, unsupported } from "../unsupported.ts";
import { resolveAuthentication } from "./authentication.ts";
import type { ConnectionGate } from "./client-executor.ts";
import { ClientExecutor } from "./client-executor.ts";
import type { ClientSettings } from "./client-options.ts";
import { ConnectionManager } from "./connection-manager.ts";
import type { ParsedConnection } from "./connection-string.ts";
import { parseConnectionString } from "./connection-string.ts";
import { MqlEventEmitter } from "./event-emitter.ts";

/**
 * The events a `MongoClient` emits.
 *
 * Deliberately three. The real driver's client emits some thirty, and most of
 * them describe machinery this driver does not have: `serverHeartbeat*` reports a
 * monitor that polls, `server*` and `topology*` report discovery across a
 * replica set or sharded cluster, and `connectionPool*` reports a pool. There is
 * one connection here and nothing polling it, so emitting any of those would be
 * inventing an event rather than reporting one — and a caller that gates on them
 * (mongoose gates on `serverDescriptionChanged` and `topologyDescriptionChanged`)
 * is better served by their absence than by a fiction. Command monitoring
 * (`commandStarted`/`Succeeded`/`Failed`) is absent for a different reason: this
 * driver sends SurrealQL rather than MongoDB commands, so the `commandName` and
 * `command` a listener would read do not exist to report.
 *
 * What remains is what this driver genuinely knows: it opened, it closed, and a
 * connection error reached it.
 */
export interface MongoClientEvents {
	/** The connection is up, after `connect()` or the first operation. */
	open: [client: MongoClient];
	/** The connection has been closed by `close()`. */
	close: [client: MongoClient];
	/**
	 * The connection reported an error.
	 *
	 * Unlike node's `EventEmitter`, an unhandled one is not re-raised as an
	 * uncaught exception — see `MqlEventEmitter`.
	 */
	error: [error: Error];
}

/** One of the event names `MongoClient` emits. */
export type MongoClientEvent = keyof MongoClientEvents;

export class MongoClient extends MqlEventEmitter {
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
	/**
	 * Executors for databases other than the connected one, by name.
	 *
	 * Shared rather than built per call, and that is load-bearing rather than
	 * merely thrifty: an operation tells whether it is running in a transaction by
	 * comparing the executor it was given against the one this database would
	 * otherwise use, so two `db(name)` handles naming the same database must hand
	 * back the *same* executor or every statement would look transactional. It also
	 * keeps `db(name)` cheap, which it has to be — it is written inline and in
	 * loops.
	 *
	 * Each entry is a view of the one connection — nothing is held server-side and
	 * nothing needs re-establishing after a reconnect — so they outlive a `close()`
	 * as harmlessly as `_executor` does, and are never pruned: pruning one a caller
	 * still holds a `Db` for would silently turn its operations transactional.
	 */
	private readonly _scopedExecutors = new Map<string, QueryExecutor>();
	private readonly _gate: ConnectionGate;
	private _serverVersion: string | undefined;
	private _closed = false;
	/** In-flight or completed connect, so concurrent operations share one. */
	private _connecting: Promise<void> | undefined;
	/** Sessions handed out and not yet ended, so `close()` can settle them. */
	private readonly _sessions = new Set<ClientSession>();

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
		super();
		this._parsed = parseConnectionString(url, options);
		this._settings = this._parsed.settings;
		// Every value crossing this connection passes through the BSON codec, which
		// is what makes an `ObjectId` come back an `ObjectId` and a `Date` a `Date`.
		this._surreal = new Surreal({ codecOptions: BSON_CODEC_OPTIONS });
		this._inner = new SurrealdbExecutor(this._surreal);
		this._gate = {
			ensureConnected: () => this.ensureConnected(),
			isClosed: () => this._closed,
		};
		this._executor = new ClientExecutor(this._inner, this._gate);
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

	/**
	 * Create a session, in which operations can share a transaction.
	 *
	 * Synchronous, as the official driver's is: a session is a client-side object
	 * and nothing is asked of the server until a transaction started on it runs
	 * its first statement. That also means a session may be created before
	 * `connect()`.
	 *
	 * Refused up front on an `http://` or `https://` connection. SurrealDB's HTTP
	 * engine has no transactions, and this driver's sessions exist to carry one, so
	 * handing back a session that could never roll anything back would move the
	 * failure to whichever write the caller believed was protected.
	 */
	startSession(options?: ClientSessionOptions): ClientSession {
		const transport = new URL(this._parsed.surrealUrl).protocol.slice(0, -1);
		if (transport === "http" || transport === "https") {
			throw new MongoCompatibilityError(
				`Sessions are not supported over the '${transport}' transport: SurrealDB's HTTP engine has no transaction support, so nothing done in a session opened here could be committed or rolled back as a unit. Connect with 'mongodb://', 'ws://' or 'wss://' instead.`,
			);
		}

		const session = new ClientSession(this, options);
		this._sessions.add(session);
		return session;
	}

	/**
	 * Run `executor` with a session, ending it however the callback finishes.
	 *
	 * The session is only ended, not committed: a transaction the callback started
	 * and did not commit is aborted, as it is by `endSession()`.
	 */
	async withSession<T = unknown>(executor: WithSessionCallback<T>): Promise<T>;
	async withSession<T = unknown>(
		options: ClientSessionOptions,
		executor: WithSessionCallback<T>,
	): Promise<T>;
	async withSession<T = unknown>(
		optionsOrExecutor: ClientSessionOptions | WithSessionCallback<T>,
		possibleExecutor?: WithSessionCallback<T>,
	): Promise<T> {
		const options =
			typeof optionsOrExecutor === "function" ? undefined : optionsOrExecutor;
		const executor =
			typeof optionsOrExecutor === "function"
				? optionsOrExecutor
				: possibleExecutor;

		if (typeof executor !== "function") {
			throw new MongoInvalidArgumentError(
				"Missing required callback argument to withSession()",
			);
		}

		const session = this.startSession(options);
		try {
			return await executor(session);
		} finally {
			await session.endSession();
		}
	}

	/**
	 * Not implemented. MongoDB returns a `ChangeStream` here without contacting
	 * the server, so this throws where MongoDB would have surfaced the failure on
	 * the stream's `'error'` event — see `src/unsupported.ts`.
	 */
	watch<
		TSchema extends Document = Document,
		TChange extends Document = ChangeStreamDocument<TSchema>,
	>(
		pipeline?: Document[],
		options?: ChangeStreamOptions,
	): ChangeStream<TSchema, TChange>;
	watch<
		TSchema extends Document = Document,
		TChange extends Document = ChangeStreamDocument<TSchema>,
	>(): ChangeStream<TSchema, TChange> {
		throw unsupported("MongoClient.watch()", CHANGE_STREAMS);
	}

	/** Close the connection and release resources. */
	async close(): Promise<void> {
		// Sessions first, and while the connection is still up: ending one aborts
		// the transaction it holds, which takes a round trip.
		for (const session of [...this._sessions]) {
			await session.endSession({ force: true }).catch(() => {});
		}
		this._sessions.clear();

		this._closed = true;
		this._connecting = undefined;
		if (this._connected) {
			this._connected = false;
			await this._inner.close();
			// After the connection is actually down, and only when there was one:
			// `close()` on a client that never connected has closed nothing.
			this.emit("close", this);
		}
	}

	/**
	 * @internal Begin a SurrealDB transaction, connecting first if necessary.
	 *
	 * Called by a session when a statement first needs the transaction that
	 * `startTransaction()` promised.
	 */
	async _beginTransaction(): Promise<TransactionScope> {
		if (this._closed) {
			throw new MongoNotConnectedError(
				"Client must be connected before running operations",
			);
		}
		await this.ensureConnected();
		return this._inner.beginTransaction();
	}

	/** @internal Stop tracking a session that has ended. */
	_forgetSession(session: ClientSession): void {
		this._sessions.delete(session);
	}

	/**
	 * Return a `Db` addressing `dbName`. If it is omitted the database from the
	 * connection string is used, or MongoDB's default of `test`.
	 *
	 * Available before `connect()`, as it is in the official driver: the
	 * connection is established by the first operation the `Db` performs. Cheap
	 * and repeatable, also as it is there — `client.db("x").collection("y")`
	 * inline in a loop allocates two façades and asks nothing of the server.
	 *
	 * An empty name is the same as none, which is what the official driver does
	 * with it (measured: `db("")` reports the connection string's database). The
	 * only name refused is one containing `.`, again matching the official driver
	 * — everything else it accepts client-side and leaves to the server, and
	 * SurrealDB accepts names a mongod would reject at that point. See the
	 * README's divergences.
	 */
	db(dbName?: string): Db {
		const name = dbName || this._parsed.database;
		if (name.includes(".")) {
			throw new MongoInvalidArgumentError(
				"Database names cannot contain the character '.'",
			);
		}
		return createDb(this, name);
	}

	/**
	 * @internal How `database` has to be addressed: `undefined` when it is the one
	 * the connection is already pointed at.
	 *
	 * The distinction is the whole of the common-path guarantee. A statement for
	 * the connected database is emitted exactly as it was before per-database
	 * addressing existed — no prefix, no extra frame, no extra round trip — and
	 * only a caller who named a different database pays for one.
	 */
	_scopeFor(database: string): string | undefined {
		return database === this._parsed.database ? undefined : database;
	}

	/** @internal The connection executor for a scope, shared per database name. */
	_executorFor(scope: string | undefined): QueryExecutor {
		if (scope === undefined) return this._executor;

		const existing = this._scopedExecutors.get(scope);
		if (existing) return existing;

		// The same connection gate the connected database goes through, so a
		// `db(name)` obtained before `connect()` connects on its first statement and
		// a `db(name)` used after `close()` fails rather than reopening.
		const scoped = new ClientExecutor(
			this._inner.forDatabase(scope),
			this._gate,
		);
		this._scopedExecutors.set(scope, scoped);
		return scoped;
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
			if (err instanceof Error) this.emit("error", err);
			throw err;
		});
		await this._connecting;
	}

	/**
	 * The connect sequence itself: connect, ensure the target exists, verify.
	 *
	 * `open` is emitted here rather than in `connect()` so it marks the connection
	 * actually being established: a caller's first operation connects too, and
	 * `connect()` on an already-open client has opened nothing. `error` is emitted
	 * for a failure to establish, and the failure is still thrown — the event is a
	 * notification, never the only report.
	 */
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

		this.emit("open", this);
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
