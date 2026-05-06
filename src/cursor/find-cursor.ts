/**
 * MongoDB-compatible `FindCursor`.
 *
 * Lazily executes a SurrealQL SELECT (via the injected `FindRunner`) when
 * results are first consumed. All chaining methods (sort/limit/skip/
 * project/filter) mutate the cursor in place; calling them after the
 * query has run throws `MongoClientError`.
 *
 * `map()` returns a new `FindCursor` whose `transform` callback is
 * applied during result materialisation – preserving full chainability
 * (Liskov-safe; the previous `MappedCursor` cast is gone).
 */

import { MongoClientError, MongoCursorExhaustedError } from "../errors.ts";
import { translateProjection } from "../translators/projection.ts";
import type { Document, FindOptions, Projection, Sort } from "../types.ts";

/**
 * The "ports"-style hook the cursor uses to actually run its query.
 * Injected by the `Collection` so the cursor doesn't depend on it directly.
 */
export type FindRunner<TSchema extends Document = Document> = (
	options: FindCursorState,
) => Promise<TSchema[]>;

/** State the cursor passes back to its runner. */
export interface FindCursorState {
	filter: Document | undefined;
	sort: Sort | undefined;
	limit: number | undefined;
	skip: number | undefined;
	projectionFields: string | undefined;
	projectionExcludeFields: string[] | undefined;
	projectionIncludeId: boolean | undefined;
}

export class FindCursor<TSchema extends Document = Document> {
	private _filter: Document | undefined;
	private _sort: Sort | undefined;
	private _limit: number | undefined;
	private _skip: number | undefined;
	private _projection: Projection | undefined;

	private _results: TSchema[] | null = null;
	private _index = 0;
	private _closed = false;

	private readonly _runner: FindRunner<Document>;
	private readonly _transform: ((doc: Document) => TSchema) | undefined;

	/** @internal */
	constructor(
		runner: FindRunner<Document>,
		filter?: Document,
		options?: FindOptions,
		transform?: (doc: Document) => TSchema,
	) {
		this._runner = runner;
		this._transform = transform;
		this._filter = filter;
		this._sort = options?.sort;
		this._limit = options?.limit;
		this._skip = options?.skip;
		this._projection = options?.projection;
	}

	get closed(): boolean {
		return this._closed;
	}

	// -------------------------------------------------------------------
	// Chaining (must be called before consuming results)
	// -------------------------------------------------------------------

	sort(sort: Sort): this {
		this._throwIfExecuted();
		this._sort = sort;
		return this;
	}

	limit(value: number): this {
		this._throwIfExecuted();
		this._limit = value;
		return this;
	}

	skip(value: number): this {
		this._throwIfExecuted();
		this._skip = value;
		return this;
	}

	project(value: Projection): this {
		this._throwIfExecuted();
		this._projection = value;
		return this;
	}

	filter(filter: Document): this {
		this._throwIfExecuted();
		this._filter = filter;
		return this;
	}

	/**
	 * Returns a new cursor that transforms each document. The new cursor is
	 * a real `FindCursor`, so chaining methods like `.sort()`/`.limit()`
	 * still work on it (Liskov compliant).
	 */
	map<T extends Document>(transform: (doc: TSchema) => T): FindCursor<T> {
		const previous = this._transform;
		const composed: (doc: Document) => T = previous
			? (doc) => transform(previous(doc))
			: (doc) => transform(doc as TSchema);

		return new FindCursor<T>(
			this._runner,
			this._filter,
			{
				sort: this._sort,
				limit: this._limit,
				skip: this._skip,
				projection: this._projection,
			},
			composed,
		);
	}

	// -------------------------------------------------------------------
	// Consumption (triggers query execution)
	// -------------------------------------------------------------------

	async toArray(): Promise<TSchema[]> {
		this._throwIfClosed();
		await this._execute();
		return this._results!.slice();
	}

	async next(): Promise<TSchema | null> {
		this._throwIfClosed();
		await this._execute();
		if (this._index >= this._results!.length) return null;
		return this._results![this._index++];
	}

	async hasNext(): Promise<boolean> {
		this._throwIfClosed();
		await this._execute();
		return this._index < this._results!.length;
	}

	// biome-ignore lint/suspicious/noConfusingVoidType: matches MongoDB driver's forEach signature
	async forEach(iterator: (doc: TSchema) => boolean | void): Promise<void> {
		this._throwIfClosed();
		await this._execute();
		for (const doc of this._results ?? []) {
			if (iterator(doc) === false) break;
		}
	}

	/** @deprecated use `collection.countDocuments()` instead. */
	async count(): Promise<number> {
		this._throwIfClosed();
		await this._execute();
		return this._results!.length;
	}

	async close(): Promise<void> {
		this._closed = true;
		this._results = null;
	}

	rewind(): this {
		this._index = 0;
		this._results = null;
		this._closed = false;
		return this;
	}

	clone(): FindCursor<TSchema> {
		return new FindCursor<TSchema>(
			this._runner,
			this._filter,
			{
				sort: this._sort,
				limit: this._limit,
				skip: this._skip,
				projection: this._projection,
			},
			this._transform,
		);
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<TSchema> {
		this._throwIfClosed();
		await this._execute();
		for (const doc of this._results ?? []) yield doc;
	}

	// -------------------------------------------------------------------
	// Internal
	// -------------------------------------------------------------------

	private async _execute(): Promise<void> {
		if (this._results !== null) return;

		const proj = translateProjection(this._projection);

		const rows = await this._runner({
			filter: this._filter,
			sort: this._sort,
			limit: this._limit,
			skip: this._skip,
			projectionFields: proj.fields || undefined,
			projectionExcludeFields: proj.isExclusion
				? proj.excludeFields
				: undefined,
			projectionIncludeId: proj.includeId,
		});

		this._results = this._transform
			? rows.map(this._transform)
			: (rows as unknown as TSchema[]);
	}

	private _throwIfExecuted(): void {
		if (this._results !== null) {
			throw new MongoClientError(
				"Cursor options cannot be changed after execution",
			);
		}
	}

	private _throwIfClosed(): void {
		if (this._closed) throw new MongoCursorExhaustedError();
	}
}
