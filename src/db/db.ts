/**
 * MongoDB-compatible Db facade.
 *
 * Slim wrapper that produces `Collection` instances and delegates the
 * SurrealDB-side database admin commands to `database-operations.ts`.
 *
 * Every method that takes options runs them through the same gate the
 * collection operations use, so an option this driver cannot honour is refused
 * here too rather than being dropped one layer above the code that would have
 * applied it.
 */

import type { MongoClient } from "../client/mongo-client.ts";
import type { Collection } from "../collection/collection.ts";
import { createCollection } from "../collection/collection.ts";
import {
	assertSupportedCollectionOptions,
	assertSupportedOptions,
} from "../collection/operation-options.ts";
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
		return listCollections(this._client._executor, filter);
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
		await createCollectionTable(this._client._executor, name);
		return createCollection<TSchema>(this, name);
	}

	/** Drops (removes) a collection (table) from the database. */
	async dropCollection(
		name: string,
		options?: DropCollectionOptions,
	): Promise<boolean> {
		assertSupportedOptions(options);
		return dropCollectionTable(this._client._executor, name);
	}

	/** Drops the entire database. */
	async dropDatabase(options?: DropDatabaseOptions): Promise<boolean> {
		assertSupportedOptions(options);
		return dropDatabase(this._client._executor, this.databaseName);
	}
}

/** @internal Factory that avoids circular-import issues. */
export function createDb(client: MongoClient, name: string): Db {
	return new Db(client, name);
}
