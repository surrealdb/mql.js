import type { Collection } from "./collection.ts";
import { createCollection } from "./collection.ts";
import { MongoServerError } from "./errors.ts";
import type { MongoClient } from "./mongo-client.ts";
import type { CollectionInfo, Document } from "./types.ts";

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

	/** Shorthand to the underlying Surreal instance. */
	private get surreal() {
		return this._client._surreal;
	}

	/**
	 * Execute a SurrealQL query and return the first statement's result.
	 */
	private async exec<T = unknown>(
		query: string,
		bindings?: Record<string, unknown>,
	): Promise<T> {
		try {
			const results = await this.surreal.query<[T]>(query, bindings);
			return results[0];
		} catch (err) {
			throw new MongoServerError(
				err instanceof Error ? err.message : String(err),
			);
		}
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

	/**
	 * Returns a list of collections (tables) in this database.
	 */
	async listCollections(): Promise<CollectionInfo[]> {
		const info = await this.exec<Record<string, unknown>>("INFO FOR DB");

		if (!info) return [];

		// SurrealDB returns { tables: { tableName: "DEFINE TABLE ...", ... }, ... }
		const tables = (info.tables ?? info.tb ?? {}) as Record<string, unknown>;

		return Object.keys(tables).map((name) => ({
			name,
			type: "collection" as const,
		}));
	}

	/**
	 * Explicitly creates a collection (table) in SurrealDB.
	 * Returns a Collection instance for the created table.
	 */
	async createCollection<TSchema extends Document = Document>(
		name: string,
	): Promise<Collection<TSchema>> {
		await this.exec(`DEFINE TABLE ${escapeTable(name)}`);
		return createCollection<TSchema>(this, name);
	}

	/**
	 * Drops (removes) a collection (table) from the database.
	 */
	async dropCollection(name: string): Promise<boolean> {
		try {
			await this.exec(`REMOVE TABLE ${escapeTable(name)}`);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Drops the entire database.
	 */
	async dropDatabase(): Promise<boolean> {
		try {
			await this.exec(`REMOVE DATABASE ${escapeTable(this.databaseName)}`);
			return true;
		} catch {
			return false;
		}
	}
}

/** Escape a table/database name for use in SurrealQL. */
function escapeTable(name: string): string {
	if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
		return name;
	}
	return `\`${name.replace(/`/g, "\\`")}\``;
}

/**
 * @internal Factory that avoids circular-import issues.
 */
export function createDb(client: MongoClient, name: string): Db {
	return new Db(client, name);
}
