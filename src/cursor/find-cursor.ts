/**
 * MongoDB-compatible `FindCursor`.
 *
 * Lazily executes a SurrealQL SELECT (via the injected `FindRunner`) when
 * results are first consumed. All chaining methods (sort/limit/skip/
 * project/filter) mutate the cursor in place; calling them after the
 * query has run throws `MongoClientError`.
 *
 * Read a document at a time — `next()`, `hasNext()`, `forEach()`, `for await` —
 * the rows are streamed as the server produces them (see `CursorRows`), and
 * leaving early stops the server producing the rest. `toArray()` reads the whole
 * result in one response.
 *
 * `map()` returns a new `FindCursor` whose `transform` callback is
 * applied during result materialisation – preserving full chainability
 * (Liskov-safe; the previous `MappedCursor` cast is gone).
 */

import { MongoCursorExhaustedError, MongoCursorInUseError } from "../errors.ts";
import { mapRows } from "../surreal/row-stream.ts";
import { translateProjection } from "../translators/projection.ts";
import type { Document, FindOptions, Projection, Sort } from "../types.ts";
import { CursorRows, CursorSignal } from "./cursor-rows.ts";

/**
 * The "ports"-style hook the cursor uses to actually run its query.
 * Injected by the `Collection` so the cursor doesn't depend on it directly.
 */
export type FindRunner<TSchema extends Document = Document> = (
	options: FindCursorState,
) => Promise<TSchema[]>;

/**
 * The hook the cursor uses to read its query a document at a time. Optional: a
 * cursor with none reads everything at once, as it always did.
 */
export type FindStreamer<TSchema extends Document = Document> = (
	options: FindCursorState,
) => AsyncIterableIterator<TSchema>;

/** State the cursor passes back to its runner. */
export interface FindCursorState {
	filter: Document | undefined;
	sort: Sort | undefined;
	limit: number | undefined;
	skip: number | undefined;
	projectionColumns: readonly string[] | undefined;
	projectionExcludeFields: string[] | undefined;
	projectionIncludeId: boolean | undefined;
}

export class FindCursor<TSchema extends Document = Document> {
	private _filter: Document | undefined;
	private _sort: Sort | undefined;
	private _limit: number | undefined;
	private _skip: number | undefined;
	private _projection: Projection | undefined;

	private _closed = false;

	private readonly _runner: FindRunner<Document>;
	private readonly _streamer: FindStreamer<Document> | undefined;
	private readonly _transform: ((doc: Document) => TSchema) | undefined;
	private readonly _rows: CursorRows<TSchema>;
	private readonly _signal: CursorSignal;
	private readonly _options: FindOptions | undefined;

	/** @internal */
	constructor(
		runner: FindRunner<Document>,
		filter?: Document,
		options?: FindOptions,
		transform?: (doc: Document) => TSchema,
		streamer?: FindStreamer<Document>,
	) {
		this._runner = runner;
		this._streamer = streamer;
		this._options = options;
		this._signal = new CursorSignal(
			options?.signal,
			() => void this.close().catch(() => undefined),
		);
		this._transform = transform;
		this._filter = filter;
		this._sort = options?.sort;
		this._limit = options?.limit;
		this._skip = options?.skip;
		this._projection = options?.projection;
		this._rows = new CursorRows<TSchema>(
			async () => {
				const rows = await this._runner(this._state());
				return this._transform
					? rows.map(this._transform)
					: (rows as unknown as TSchema[]);
			},
			streamer
				? () => {
						const rows = streamer(this._state());
						const transform = this._transform;
						return transform
							? mapRows(rows, transform)
							: (rows as unknown as AsyncIterableIterator<TSchema>);
					}
				: undefined,
		);
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
				signal: this._options?.signal,
			},
			composed,
			this._streamer,
		);
	}

	// -------------------------------------------------------------------
	// Consumption (triggers query execution)
	// -------------------------------------------------------------------

	async toArray(): Promise<TSchema[]> {
		this._signal.throwIfAborted();
		this._throwIfClosed();
		return this._rows.toArray();
	}

	async next(): Promise<TSchema | null> {
		this._signal.throwIfAborted();
		this._throwIfClosed();
		await this._rows.begin();
		const step = await this._rows.next();
		return step.done ? null : step.value;
	}

	async hasNext(): Promise<boolean> {
		this._signal.throwIfAborted();
		this._throwIfClosed();
		await this._rows.begin();
		return this._rows.hasNext();
	}

	// biome-ignore lint/suspicious/noConfusingVoidType: matches MongoDB driver's forEach signature
	async forEach(iterator: (doc: TSchema) => boolean | void): Promise<void> {
		this._signal.throwIfAborted();
		this._throwIfClosed();
		await this._rows.begin();
		for (;;) {
			this._signal.throwIfAborted();
			const step = await this._rows.next();
			if (step.done) return;
			if (iterator(step.value) === false) {
				// Stopping is leaving: what is still being produced is not wanted.
				if (this._rows.streaming) await this.close();
				return;
			}
		}
	}

	/** @deprecated use `collection.countDocuments()` instead. */
	async count(): Promise<number> {
		this._signal.throwIfAborted();
		this._throwIfClosed();
		return this._rows.count();
	}

	async close(): Promise<void> {
		this._closed = true;
		this._signal.release();
		await this._rows.release();
	}

	rewind(): this {
		this._rows.reset();
		this._closed = false;
		this._signal.watch();
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
				signal: this._options?.signal,
			},
			this._transform,
			this._streamer,
		);
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<TSchema> {
		this._signal.throwIfAborted();
		this._throwIfClosed();
		await this._rows.begin();
		let exhausted = false;
		try {
			for (;;) {
				const step = await this._rows.next();
				if (step.done) {
					exhausted = true;
					return;
				}
				yield step.value;
				// MongoDB asks after every document, so a loop whose signal aborted
				// while its body ran is told so rather than handed the next one.
				this._signal.throwIfAborted();
			}
		} finally {
			// Breaking out of a `for await` leaves the cursor, as it does in MongoDB.
			if (!exhausted && this._rows.streaming) await this.close();
		}
	}

	// -------------------------------------------------------------------
	// Internal
	// -------------------------------------------------------------------

	/** What the cursor asks of its runner and its streamer, as it stands now. */
	private _state(): FindCursorState {
		const proj = translateProjection(this._projection);
		return {
			filter: this._filter,
			sort: this._sort,
			limit: this._limit,
			skip: this._skip,
			projectionColumns: proj.columns.length > 0 ? proj.columns : undefined,
			projectionExcludeFields: proj.isExclusion
				? proj.excludeFields
				: undefined,
			projectionIncludeId: proj.includeId,
		};
	}

	private _throwIfExecuted(): void {
		if (this._rows.started) {
			throw new MongoCursorInUseError(
				"Cursor options cannot be changed after execution",
			);
		}
	}

	private _throwIfClosed(): void {
		if (this._closed) throw new MongoCursorExhaustedError();
	}
}
