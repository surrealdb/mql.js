/**
 * MongoDB-compatible FindCursor implementation.
 *
 * Lazily executes a SurrealQL SELECT query when results are consumed.
 * Supports the standard MongoDB chaining methods: sort, limit, skip, project.
 */

import type {
	Collection,
	executeFind as executeFindType,
} from "./collection.ts";
import { MongoClientError, MongoCursorExhaustedError } from "./errors.ts";
import { translateProjection } from "./translators/projection.ts";
import type { Document, FindOptions, Projection, Sort } from "./types.ts";

export class FindCursor<TSchema extends Document = Document> {
	/** @internal */
	private _collection: Collection<TSchema>;
	/** @internal */
	private _filter: Document | undefined;
	/** @internal */
	private _sort: Sort | undefined;
	/** @internal */
	private _limit: number | undefined;
	/** @internal */
	private _skip: number | undefined;
	/** @internal */
	private _projection: Projection | undefined;

	/** Cached results after execution. */
	private _results: TSchema[] | null = null;
	/** Current index for next() iteration. */
	private _index = 0;
	/** Whether the cursor has been closed. */
	private _closed = false;

	/** @internal */
	private _executeFn: typeof executeFindType;

	/** @internal */
	constructor(
		collection: Collection<TSchema>,
		executeFn: typeof executeFindType,
		filter?: Document,
		options?: FindOptions,
	) {
		this._collection = collection;
		this._executeFn = executeFn;
		this._filter = filter;
		this._sort = options?.sort;
		this._limit = options?.limit;
		this._skip = options?.skip;
		this._projection = options?.projection;
	}

	/** Whether the cursor is closed. */
	get closed(): boolean {
		return this._closed;
	}

	// -----------------------------------------------------------------------
	// Chaining methods (must be called before consuming results)
	// -----------------------------------------------------------------------

	/**
	 * Sets the sort order. Returns `this` for chaining.
	 */
	sort(sort: Sort): this {
		this._throwIfExecuted();
		this._sort = sort;
		return this;
	}

	/**
	 * Sets the maximum number of documents to return.
	 */
	limit(value: number): this {
		this._throwIfExecuted();
		this._limit = value;
		return this;
	}

	/**
	 * Sets the number of documents to skip.
	 */
	skip(value: number): this {
		this._throwIfExecuted();
		this._skip = value;
		return this;
	}

	/**
	 * Sets the projection (field selection).
	 */
	project(value: Projection): this {
		this._throwIfExecuted();
		this._projection = value;
		return this;
	}

	/**
	 * Sets the query filter.
	 */
	filter(filter: Document): this {
		this._throwIfExecuted();
		this._filter = filter;
		return this;
	}

	// -----------------------------------------------------------------------
	// Consumption methods (trigger query execution)
	// -----------------------------------------------------------------------

	/**
	 * Returns all matching documents as an array.
	 */
	async toArray(): Promise<TSchema[]> {
		this._throwIfClosed();
		await this._execute();
		return this._results!.slice();
	}

	/**
	 * Returns the next document, or `null` when exhausted.
	 */
	async next(): Promise<TSchema | null> {
		this._throwIfClosed();
		await this._execute();

		if (this._index >= this._results!.length) {
			return null;
		}
		return this._results![this._index++];
	}

	/**
	 * Returns `true` if there are more documents to iterate.
	 */
	async hasNext(): Promise<boolean> {
		this._throwIfClosed();
		await this._execute();
		return this._index < this._results!.length;
	}

	/**
	 * Iterates over all documents, calling the provided function for each.
	 * Stops if the function returns `false`.
	 */
	// biome-ignore lint/suspicious/noConfusingVoidType: matches MongoDB driver's forEach signature
	async forEach(iterator: (doc: TSchema) => boolean | void): Promise<void> {
		this._throwIfClosed();
		await this._execute();

		const results = this._results ?? [];
		for (const doc of results) {
			const result = iterator(doc);
			if (result === false) break;
		}
	}

	/**
	 * Returns a new cursor that transforms each document using the
	 * provided function.
	 */
	map<T extends Document>(transform: (doc: TSchema) => T): FindCursor<T> {
		// Create a wrapper that applies the transform after execution
		const mapped = new MappedCursor<TSchema, T>(this, transform);
		return mapped as unknown as FindCursor<T>;
	}

	/**
	 * Returns the count of documents that would be returned.
	 * @deprecated Use `collection.countDocuments()` instead.
	 */
	async count(): Promise<number> {
		this._throwIfClosed();
		await this._execute();
		return this._results!.length;
	}

	/**
	 * Close the cursor and release resources.
	 */
	async close(): Promise<void> {
		this._closed = true;
		this._results = null;
	}

	/**
	 * Rewind the cursor to the beginning.
	 */
	rewind(): this {
		this._index = 0;
		this._results = null;
		this._closed = false;
		return this;
	}

	/**
	 * Returns a new uninitialized copy of this cursor.
	 */
	clone(): FindCursor<TSchema> {
		return new FindCursor<TSchema>(
			this._collection,
			this._executeFn,
			this._filter,
			{
				sort: this._sort,
				limit: this._limit,
				skip: this._skip,
				projection: this._projection,
			},
		);
	}

	// -----------------------------------------------------------------------
	// Async iteration
	// -----------------------------------------------------------------------

	async *[Symbol.asyncIterator](): AsyncGenerator<TSchema> {
		this._throwIfClosed();
		await this._execute();
		const results = this._results ?? [];
		for (const doc of results) {
			yield doc;
		}
	}

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	private async _execute(): Promise<void> {
		if (this._results !== null) return;

		const proj = translateProjection(this._projection);

		this._results = await this._executeFn<TSchema>(
			this._collection,
			this._filter,
			{
				sort: this._sort,
				limit: this._limit,
				skip: this._skip,
				projectionFields: proj.fields || undefined,
				projectionExcludeFields: proj.isExclusion
					? proj.excludeFields
					: undefined,
				projectionIncludeId: proj.includeId,
			},
		);
	}

	private _throwIfExecuted(): void {
		if (this._results !== null) {
			throw new MongoClientError(
				"Cursor options cannot be changed after execution",
			);
		}
	}

	private _throwIfClosed(): void {
		if (this._closed) {
			throw new MongoCursorExhaustedError();
		}
	}
}

/**
 * Internal helper cursor that applies a transform function.
 */
class MappedCursor<TSource extends Document, TTarget extends Document> {
	private _source: FindCursor<TSource>;
	private _transform: (doc: TSource) => TTarget;

	constructor(
		source: FindCursor<TSource>,
		transform: (doc: TSource) => TTarget,
	) {
		this._source = source;
		this._transform = transform;
	}

	async toArray(): Promise<TTarget[]> {
		const docs = await this._source.toArray();
		return docs.map(this._transform);
	}

	async next(): Promise<TTarget | null> {
		const doc = await this._source.next();
		return doc ? this._transform(doc) : null;
	}

	async hasNext(): Promise<boolean> {
		return this._source.hasNext();
	}

	// biome-ignore lint/suspicious/noConfusingVoidType: matches MongoDB driver's forEach signature
	async forEach(iterator: (doc: TTarget) => boolean | void): Promise<void> {
		for await (const doc of this._source) {
			const result = iterator(this._transform(doc));
			if (result === false) break;
		}
	}

	async count(): Promise<number> {
		return this._source.count();
	}

	async close(): Promise<void> {
		return this._source.close();
	}

	get closed(): boolean {
		return this._source.closed;
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<TTarget> {
		for await (const doc of this._source) {
			yield this._transform(doc);
		}
	}
}

/**
 * @internal Factory to avoid circular imports.
 * The `executeFn` is injected by the Collection to break the cycle.
 */
export function createFindCursor<TSchema extends Document>(
	collection: Collection<TSchema>,
	executeFn: typeof executeFindType,
	filter?: Document,
	options?: FindOptions,
): FindCursor<TSchema> {
	return new FindCursor<TSchema>(collection, executeFn, filter, options);
}
