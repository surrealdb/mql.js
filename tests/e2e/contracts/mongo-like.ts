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

/** Projection spec accepted by `find`/`findOne`/`cursor.project()`. */
export type MongoLikeProjection = Record<string, 0 | 1>;

/** The `find`/`findOne` options both drivers read the same way. */
export interface MongoLikeFindOptions {
	projection?: MongoLikeProjection;
	sort?: MongoLikeSort;
	limit?: number;
	skip?: number;
}

export interface MongoLikeUpdateResult {
	acknowledged: boolean;
	matchedCount: number;
	modifiedCount: number;
	upsertedId: unknown;
}

export interface MongoLikeDeleteResult {
	acknowledged: boolean;
	deletedCount: number;
}

/**
 * The aggregation cursor surface both drivers share.
 *
 * Narrower than `MongoLikeFindCursor` on purpose: a pipeline says what it does
 * in its stages, so there is nothing to chain afterwards.
 */
export interface MongoLikeAggregationCursor<
	TSchema extends MongoLikeDocument = MongoLikeDocument,
> {
	toArray(): Promise<TSchema[]>;
}

/** Minimal cursor surface – the chainable methods both drivers share. */
export interface MongoLikeFindCursor<TSchema extends MongoLikeDocument> {
	sort(spec: MongoLikeSort): MongoLikeFindCursor<TSchema>;
	limit(value: number): MongoLikeFindCursor<TSchema>;
	skip(value: number): MongoLikeFindCursor<TSchema>;
	project(spec: MongoLikeProjection): MongoLikeFindCursor<MongoLikeDocument>;
	toArray(): Promise<TSchema[]>;
	next(): Promise<TSchema | null>;
}

export interface MongoLikeCollection<
	TSchema extends MongoLikeDocument = MongoLikeDocument,
> {
	insertOne(doc: TSchema): Promise<MongoLikeInsertOneResult>;
	insertMany(docs: TSchema[]): Promise<MongoLikeInsertManyResult>;
	findOne(
		filter: MongoLikeFilter,
		options?: MongoLikeFindOptions,
	): Promise<TSchema | null>;
	find(
		filter?: MongoLikeFilter,
		options?: MongoLikeFindOptions,
	): MongoLikeFindCursor<TSchema>;
	updateOne(
		filter: MongoLikeFilter,
		update: MongoLikeUpdate,
		options?: { upsert?: boolean },
	): Promise<MongoLikeUpdateResult>;
	updateMany(
		filter: MongoLikeFilter,
		update: MongoLikeUpdate,
	): Promise<MongoLikeUpdateResult>;
	replaceOne(
		filter: MongoLikeFilter,
		replacement: MongoLikeDocument,
		options?: { upsert?: boolean },
	): Promise<MongoLikeUpdateResult>;
	deleteOne(filter: MongoLikeFilter): Promise<MongoLikeDeleteResult>;
	deleteMany(filter?: MongoLikeFilter): Promise<MongoLikeDeleteResult>;
	countDocuments(filter?: MongoLikeFilter): Promise<number>;
	estimatedDocumentCount(): Promise<number>;
	distinct(key: string, filter?: MongoLikeFilter): Promise<unknown[]>;
	findOneAndUpdate(
		filter: MongoLikeFilter,
		update: MongoLikeUpdate,
	): Promise<TSchema | null>;
	findOneAndReplace(
		filter: MongoLikeFilter,
		replacement: MongoLikeDocument,
		options?: { sort?: MongoLikeSort },
	): Promise<TSchema | null>;
	findOneAndDelete(filter: MongoLikeFilter): Promise<TSchema | null>;
	createIndex(spec: Record<string, unknown>): Promise<string>;
	aggregate<T extends MongoLikeDocument = MongoLikeDocument>(
		pipeline: MongoLikeDocument[],
	): MongoLikeAggregationCursor<T>;
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
