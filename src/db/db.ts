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
	CollectionInfo,
	CollectionOptions,
	CreateCollectionOptions,
	Document,
	DropCollectionOptions,
	DropDatabaseOptions,
	ListCollectionsOptions,
} from "../types.ts";
import {
	createCollectionTable,
	dropCollectionTable,
	dropDatabase,
	listCollections,
} from "./database-operations.ts";

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
	 * The executor this call's statements run through: the caller's transaction
	 * when they passed a session in one, the client's connection otherwise.
	 */
	private executor(
		options: { readonly session?: ClientSession } | undefined,
	): Promise<QueryExecutor> {
		return sessionExecutor(
			options?.session,
			this._client,
			this._client._executor,
		);
	}
}

/** @internal Factory that avoids circular-import issues. */
export function createDb(client: MongoClient, name: string): Db {
	return new Db(client, name);
}
