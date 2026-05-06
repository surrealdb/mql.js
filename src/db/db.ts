/**
 * MongoDB-compatible Db facade.
 *
 * Slim wrapper that produces `Collection` instances and delegates the
 * SurrealDB-side database admin commands to `database-operations.ts`.
 */

import type { MongoClient } from "../client/mongo-client.ts";
import type { Collection } from "../collection/collection.ts";
import { createCollection } from "../collection/collection.ts";
import type { CollectionInfo, Document } from "../types.ts";
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
	): Collection<TSchema> {
		return createCollection<TSchema>(this, name);
	}

	/** Returns a list of collections (tables) in this database. */
	listCollections(): Promise<CollectionInfo[]> {
		return listCollections(this._client._executor);
	}

	/**
	 * Explicitly creates a collection (table) in SurrealDB.
	 * Returns a Collection instance for the created table.
	 */
	async createCollection<TSchema extends Document = Document>(
		name: string,
	): Promise<Collection<TSchema>> {
		await createCollectionTable(this._client._executor, name);
		return createCollection<TSchema>(this, name);
	}

	/** Drops (removes) a collection (table) from the database. */
	dropCollection(name: string): Promise<boolean> {
		return dropCollectionTable(this._client._executor, name);
	}

	/** Drops the entire database. */
	dropDatabase(): Promise<boolean> {
		return dropDatabase(this._client._executor, this.databaseName);
	}
}

/** @internal Factory that avoids circular-import issues. */
export function createDb(client: MongoClient, name: string): Db {
	return new Db(client, name);
}
