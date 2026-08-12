/**
 * Driver-agnostic MongoDB-shaped contract used by the E2E parity suite.
 *
 * Both the official `mongodb` driver and `@surrealdb/mql` are structurally
 * compatible with these interfaces. By having scenarios depend on
 * `MongoLikeClient` instead of either concrete `MongoClient`, swapping the
 * driver is literally a one-line provider change (Dependency Inversion).
 *
 * The interface is intentionally narrow — it only declares what the
 * scenarios in `tests/e2e/scenarios/` actually call (Interface Segregation),
 * which keeps both drivers easily substitutable without a sprawling adapter.
 */

/** Plain document shape both drivers accept and return. */
export interface MongoLikeDocument {
	[key: string]: unknown;
	_id?: unknown;
}

/** Filter expression accepted by `find`/`findOne`/`updateOne`/etc. */
export type MongoLikeFilter = Record<string, unknown>;

/** Update expression accepted by `updateOne`/`updateMany`. */
export type MongoLikeUpdate = Record<string, unknown>;

/** Sort spec accepted by `cursor.sort()`. */
export type MongoLikeSort = Record<string, 1 | -1>;

export interface MongoLikeInsertOneResult {
	acknowledged: boolean;
	insertedId: unknown;
}

export interface MongoLikeInsertManyResult {
	acknowledged: boolean;
	insertedCount: number;
	insertedIds: Record<number, unknown>;
}

export interface MongoLikeUpdateResult {
	acknowledged: boolean;
	matchedCount: number;
	modifiedCount: number;
}

export interface MongoLikeDeleteResult {
	acknowledged: boolean;
	deletedCount: number;
}

/** Minimal cursor surface – the chainable methods both drivers share. */
export interface MongoLikeFindCursor<TSchema extends MongoLikeDocument> {
	sort(spec: MongoLikeSort): MongoLikeFindCursor<TSchema>;
	limit(value: number): MongoLikeFindCursor<TSchema>;
	skip(value: number): MongoLikeFindCursor<TSchema>;
	toArray(): Promise<TSchema[]>;
	next(): Promise<TSchema | null>;
}

export interface MongoLikeCollection<
	TSchema extends MongoLikeDocument = MongoLikeDocument,
> {
	insertOne(doc: TSchema): Promise<MongoLikeInsertOneResult>;
	insertMany(docs: TSchema[]): Promise<MongoLikeInsertManyResult>;
	findOne(filter: MongoLikeFilter): Promise<TSchema | null>;
	find(filter?: MongoLikeFilter): MongoLikeFindCursor<TSchema>;
	updateOne(
		filter: MongoLikeFilter,
		update: MongoLikeUpdate,
	): Promise<MongoLikeUpdateResult>;
	updateMany(
		filter: MongoLikeFilter,
		update: MongoLikeUpdate,
	): Promise<MongoLikeUpdateResult>;
	deleteOne(filter: MongoLikeFilter): Promise<MongoLikeDeleteResult>;
	deleteMany(filter?: MongoLikeFilter): Promise<MongoLikeDeleteResult>;
	countDocuments(filter?: MongoLikeFilter): Promise<number>;
	createIndex(spec: Record<string, unknown>): Promise<string>;
}

export interface MongoLikeDb {
	collection<TSchema extends MongoLikeDocument = MongoLikeDocument>(
		name: string,
	): MongoLikeCollection<TSchema>;
}

export interface MongoLikeClient {
	connect(): Promise<unknown>;
	db(name?: string): MongoLikeDb;
	close(): Promise<void>;
}
