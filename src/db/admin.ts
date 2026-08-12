/**
 * MongoDB-compatible `Admin` facade, returned by `Db.admin()`.
 *
 * Every method here is a thin wrapper over `command()`, exactly as the official
 * driver's `Admin` is — `buildInfo()` sends `{buildInfo: 1}`, `ping()` sends
 * `{ping: 1}`. Keeping that structure is what makes the boundary consistent: a
 * method cannot answer differently from the command it stands for, and a method
 * whose command this driver does not route inherits the command surface's
 * `CommandNotFound` rather than needing a refusal of its own.
 *
 * `serverInfo()` is the one place where the method and the command genuinely
 * differ, and MongoDB is where the difference comes from: there is no
 * `serverInfo` command — a real mongod answers `{serverInfo: 1}` with
 * `no such command: 'serverInfo'`, measured — and the driver's `serverInfo()`
 * sends `buildInfo`. This does the same, so `db.command({serverInfo: 1})` is
 * refused while `admin().serverInfo()` works, in both drivers alike.
 *
 * There is no separate `admin` database: SurrealDB has no such convention, so
 * `Db.admin()` is bound to the `Db` it came from. That decides the commands
 * MongoDB restricts to the admin database — `listDatabases` and
 * `replSetGetStatus` are answered here and refused on `Db.command()`, with
 * mongod's own `13`/`Unauthorized` — and it means a database-scoped command sent
 * through `Admin.command()` reports on that `Db` rather than on a database
 * called `admin`.
 */

import type {
	CommandOperationOptions,
	Document,
	ListDatabasesOptions,
	ListDatabasesResult,
	RunCommandOptions,
} from "../types.ts";
import type { Db } from "./db.ts";

export class Admin {
	/** @internal */
	private readonly _db: Db;

	/** @internal – use `Db.admin()` instead. */
	constructor(db: Db) {
		this._db = db;
	}

	/**
	 * Run an administrative command.
	 *
	 * Routed by the same router as `Db.command()`, told that it arrived on the
	 * admin surface — see `src/db/run-command.ts` for what is answered and what
	 * raises `CommandNotFound`.
	 */
	async command(
		command: Document,
		options?: RunCommandOptions,
	): Promise<Document> {
		return this._db._command(command, options, "admin");
	}

	/** Check that the server is reachable. */
	async ping(options?: CommandOperationOptions): Promise<Document> {
		return this.command({ ping: 1 }, options);
	}

	/**
	 * Server build information.
	 *
	 * Reports a MongoDB-compatible `version` plus the real `surrealdbVersion` —
	 * see `MONGODB_COMPATIBILITY_VERSION` in `src/constants.ts` for why both.
	 */
	async buildInfo(options?: CommandOperationOptions): Promise<Document> {
		return this.command({ buildInfo: 1 }, options);
	}

	/** Server build information. `buildInfo` under its other name, as in MongoDB. */
	async serverInfo(options?: CommandOperationOptions): Promise<Document> {
		return this.command({ buildInfo: 1 }, options);
	}

	/**
	 * Runtime counters and state.
	 *
	 * Not routed: nothing SurrealDB reports maps onto `serverStatus`'s sections,
	 * and a reply containing only `ok` would be read as a server with no
	 * connections, no operations and no memory in use. Raises the command
	 * surface's `CommandNotFound`.
	 */
	async serverStatus(options?: CommandOperationOptions): Promise<Document> {
		return this.command({ serverStatus: 1 }, options);
	}

	/**
	 * The databases in the connected SurrealDB namespace.
	 *
	 * Routed through `command()` like every other method here, rather than reading
	 * the namespace directly: `filter` is an argument of the `listDatabases`
	 * command, so passing it through the command document is what makes the method
	 * and the command one implementation — and it is what puts the caller's
	 * options through the same gate, so an option this driver cannot honour is
	 * refused here too instead of being dropped.
	 */
	async listDatabases(
		options?: ListDatabasesOptions,
	): Promise<ListDatabasesResult> {
		const reply = await this.command(
			options?.filter === undefined
				? { listDatabases: 1 }
				: { listDatabases: 1, filter: options.filter },
			options,
		);
		// A command reply is an open document; the method's return type names its
		// fields, so they are read out rather than asserted over the whole reply.
		return {
			databases: reply.databases as ListDatabasesResult["databases"],
			ok: reply.ok as ListDatabasesResult["ok"],
		};
	}

	/**
	 * Replica-set status.
	 *
	 * Answered the way a mongod that is not a replica-set member answers it:
	 * `76` / `NoReplicationEnabled`, `not running with --replSet`. There is one
	 * SurrealDB node and no set to report on, so this is the same answer for the
	 * same reason rather than a stand-in for one.
	 */
	async replSetGetStatus(options?: CommandOperationOptions): Promise<Document> {
		return this.command({ replSetGetStatus: 1 }, options);
	}

	/**
	 * Remove a user.
	 *
	 * Not routed: SurrealDB users are defined per namespace, database or root with
	 * `REMOVE USER`, and mapping MongoDB's per-database user model onto that would
	 * have to guess which level the caller meant. Raises the command surface's
	 * `CommandNotFound`; use `REMOVE USER` through the SurrealDB client.
	 */
	async removeUser(
		username: string,
		options?: CommandOperationOptions,
	): Promise<boolean> {
		await this.command({ dropUser: username }, options);
		return true;
	}

	/**
	 * Check a collection's storage for damage.
	 *
	 * Not routed: SurrealDB exposes no equivalent check, and reporting `valid: true`
	 * without having looked would be the least useful lie available. Raises the
	 * command surface's `CommandNotFound`.
	 */
	async validateCollection(
		collectionName: string,
		options?: CommandOperationOptions,
	): Promise<Document> {
		return this.command({ validate: collectionName }, options);
	}
}
