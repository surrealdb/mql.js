/**
 * MongoDB-compatible Db facade.
 *
 * Slim wrapper that produces `Collection` instances and delegates the
 * SurrealDB-side database admin commands to `database-operations.ts`.
 *
 * Every method that takes options runs them through the same gate the
 * collection operations use, so an option this driver cannot honour is refused
 * here too rather than being dropped one layer above the code that would have
 * applied it — and a `session` reaches the statement rather than merely being
 * validated, so dropping a database inside a transaction is part of that
 * transaction.
 */

import type { MongoClient } from "../client/mongo-client.ts";
import type { Collection } from "../collection/collection.ts";
import { createCollection } from "../collection/collection.ts";
import {
	assertSupportedCollectionOptions,
	assertSupportedOptions,
} from "../collection/operation-options.ts";
import type { ClientSession } from "../session/client-session.ts";
import { sessionExecutor } from "../session/client-session.ts";
import type { QueryExecutor } from "../surreal/query-executor.ts";
import type {
	AggregateOptions,
	AggregationCursor,
	ChangeStream,
	ChangeStreamDocument,
	ChangeStreamOptions,
	CollectionInfo,
	CollectionOptions,
	CreateCollectionOptions,
	DbStatsOptions,
	Document,
	DropCollectionOptions,
	DropDatabaseOptions,
	ListCollectionsOptions,
	RenameOptions,
	RunCommandOptions,
} from "../types.ts";
import {
	AGGREGATION,
	CHANGE_STREAMS,
	RENAME_COLLECTION,
	unsupported,
} from "../unsupported.ts";
import { Admin } from "./admin.ts";
import {
	createCollectionTable,
	dropCollectionTable,
	dropDatabase,
	listCollections,
} from "./database-operations.ts";
import type { CommandScope } from "./run-command.ts";
import { runCommand } from "./run-command.ts";

export class Db {
	/** The database name. */
	readonly databaseName: string;

	/** @internal */
	readonly _client: MongoClient;

	/** @internal – use `createDb` factory instead. */
	constructor(client: MongoClient, databaseName: string) {
		this._client = client;
		this.databaseName = databaseName;
	}

	/**
	 * Returns a `Collection` instance for the given name.
	 * Does not create the underlying SurrealDB table – that happens
	 * implicitly on first write, matching MongoDB behaviour.
	 *
	 * A `session` here is validated and then dropped, because there is no statement
	 * to route: MongoDB's `CollectionOptions` carries one only through the shared
	 * option shape, and every operation on the returned collection takes its own.
	 */
	collection<TSchema extends Document = Document>(
		name: string,
		options?: CollectionOptions,
	): Collection<TSchema> {
		assertSupportedOptions(options);
		return createCollection<TSchema>(this, name);
	}

	/**
	 * Returns a list of collections (tables) in this database.
	 *
	 * `async` rather than returning the helper's promise directly, so a rejected
	 * option surfaces as a rejected promise. An awaited MongoDB method never
	 * throws synchronously, and a caller who only attached `.catch()` would
	 * otherwise miss it.
	 */
	async listCollections(
		filter?: Document,
		options?: ListCollectionsOptions,
	): Promise<CollectionInfo[]> {
		assertSupportedOptions(options);
		return listCollections(await this.executor(options), filter);
	}

	/**
	 * Explicitly creates a collection (table) in SurrealDB.
	 * Returns a Collection instance for the created table.
	 */
	async createCollection<TSchema extends Document = Document>(
		name: string,
		options?: CreateCollectionOptions,
	): Promise<Collection<TSchema>> {
		assertSupportedCollectionOptions(options);
		await createCollectionTable(await this.executor(options), name);
		return createCollection<TSchema>(this, name);
	}

	/** Drops (removes) a collection (table) from the database. */
	async dropCollection(
		name: string,
		options?: DropCollectionOptions,
	): Promise<boolean> {
		assertSupportedOptions(options);
		return dropCollectionTable(await this.executor(options), name);
	}

	/** Drops the entire database. */
	async dropDatabase(options?: DropDatabaseOptions): Promise<boolean> {
		assertSupportedOptions(options);
		return dropDatabase(await this.executor(options), this.databaseName);
	}

	/**
	 * Every collection in this database, as `Collection` instances.
	 *
	 * The same list `listCollections()` reports, handed back as handles rather
	 * than as `{name, type}` documents.
	 */
	async collections(options?: ListCollectionsOptions): Promise<Collection[]> {
		const infos = await this.listCollections(undefined, options);
		return infos.map((info) => createCollection<Document>(this, info.name));
	}

	// -----------------------------------------------------------------------
	// COMMANDS
	// -----------------------------------------------------------------------

	/**
	 * Run a database command.
	 *
	 * A real router, not a refusal: `ping`, `buildInfo`, `dbStats`, `collStats`,
	 * `create`, `drop`, `listCollections`, `createIndexes` and `dropIndexes` are
	 * answered here, and `listDatabases` and `replSetGetStatus` through
	 * `admin()`. Anything else raises the `59` / `CommandNotFound` a real mongod
	 * raises for a name it does not have — see `src/db/run-command.ts` for why
	 * that is the error even for commands MongoDB itself has.
	 */
	async command(
		command: Document,
		options?: RunCommandOptions,
	): Promise<Document> {
		return this._command(command, options, "database");
	}

	/** The administrative command surface for this connection. */
	admin(): Admin {
		return new Admin(this);
	}

	/**
	 * Counts for this database, as the `dbStats` command reports them.
	 *
	 * Counts only: `collections`, `views`, `objects` and `indexes`. Every byte-size
	 * field MongoDB reports is omitted rather than zeroed, because SurrealDB
	 * exposes no storage-level size to read — see `src/db/run-command.ts`.
	 */
	async stats(options?: DbStatsOptions): Promise<Document> {
		return this.command({ dbStats: 1 }, options);
	}

	// -----------------------------------------------------------------------
	// NOT IMPLEMENTED
	//
	// Declared with the parameters and return type each will have when it becomes
	// real, as an overload over an argument-less body — see the same section in
	// `src/collection/collection.ts` for why.
	// -----------------------------------------------------------------------

	/**
	 * Not implemented. MongoDB returns an `AggregationCursor` here without
	 * contacting the server, so this throws where MongoDB would not have failed
	 * until the cursor was iterated — see `src/unsupported.ts`.
	 */
	aggregate<T extends Document = Document>(
		pipeline?: Document[],
		options?: AggregateOptions,
	): AggregationCursor<T>;
	aggregate<T extends Document = Document>(): AggregationCursor<T> {
		throw unsupported("Db.aggregate()", AGGREGATION);
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
		throw unsupported("Db.watch()", CHANGE_STREAMS);
	}

	/** Not implemented — see `src/unsupported.ts`. */
	renameCollection<TSchema extends Document = Document>(
		fromCollection: string,
		toCollection: string,
		options?: RenameOptions,
	): Promise<Collection<TSchema>>;
	async renameCollection<TSchema extends Document = Document>(): Promise<
		Collection<TSchema>
	> {
		throw unsupported("Db.renameCollection()", RENAME_COLLECTION);
	}

	// -----------------------------------------------------------------------
	// INTERNALS
	// -----------------------------------------------------------------------

	/**
	 * @internal Route a command, knowing which surface it arrived on.
	 *
	 * Shared by `command()` and `Admin.command()` so the two cannot answer the
	 * same command differently.
	 */
	async _command(
		command: Document,
		options: RunCommandOptions | undefined,
		scope: CommandScope,
	): Promise<Document> {
		assertSupportedOptions(options);
		return runCommand(this, command, options, scope);
	}

	/**
	 * @internal The executor a command's statements run through.
	 *
	 * Exposed for the command router and `Admin`, which need the same
	 * session-aware executor the `Db` methods use.
	 */
	_commandExecutor(
		options: { readonly session?: ClientSession } | undefined,
	): Promise<QueryExecutor> {
		return this.executor(options);
	}

	/**
	 * @internal The executor for a statement about the namespace, not this database.
	 *
	 * `INFO FOR NS` and a bare liveness probe ask nothing of any one database, and
	 * addressing one would create it: SurrealDB's `USE` brings a database into
	 * existence, so `client.db("typo").admin().listDatabases()` would otherwise
	 * report `typo` among the databases — an answer the question invented. The
	 * caller's transaction is still honoured; only the database scope is dropped.
	 */
	_namespaceExecutor(
		options: { readonly session?: ClientSession } | undefined,
	): Promise<QueryExecutor> {
		return sessionExecutor(options?.session, this._client, undefined);
	}

	/**
	 * @internal The client's connection, addressing this database.
	 *
	 * The executor an operation uses when no session sends it elsewhere, and the
	 * one an operation compares against to tell whether it is in a transaction.
	 */
	get _connection(): QueryExecutor {
		return this._client._executorFor(this._client._scopeFor(this.databaseName));
	}

	/**
	 * The executor this call's statements run through: the caller's transaction
	 * when they passed a session in one, the client's connection otherwise — and
	 * either way addressed at this database rather than at whichever one the
	 * connection happens to be pointed at.
	 */
	private executor(
		options: { readonly session?: ClientSession } | undefined,
	): Promise<QueryExecutor> {
		return sessionExecutor(options?.session, this._client, this.databaseName);
	}
}

/** @internal Factory that avoids circular-import issues. */
export function createDb(client: MongoClient, name: string): Db {
	return new Db(client, name);
}
