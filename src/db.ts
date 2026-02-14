import type { Collection } from "./collection.ts";
import { createCollection } from "./collection.ts";
import type { MongoClient } from "./mongo-client.ts";
import type { Document } from "./types.ts";

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
}

/**
 * @internal Factory that avoids circular-import issues.
 */
export function createDb(client: MongoClient, name: string): Db {
	return new Db(client, name);
}
