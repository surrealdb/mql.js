/**
 * MongoDB-compatible `AggregationCursor`.
 *
 * `aggregate()` returns one synchronously, as the real driver does, and nothing
 * is sent until it is consumed. The same shape as `ListCollectionsCursor` and
 * `ListIndexesCursor`, for the same reason: a consumer written against MongoDB
 * calls `.toArray()` on the returned value, and against a promise that reads
 * `.toArray` off a `Promise` and calls `undefined`.
 *
 * A pipeline is one SurrealQL statement with no server-side cursor behind it, so
 * the whole result is materialised on first consumption and then walked locally.
 * Batching would be a fiction, and `batchSize` is accepted and ignored for the
 * same reason it is on the other cursors.
 */

import { MongoCursorExhaustedError } from "../errors.ts";
import type { Document } from "../types.ts";

/** Hook the cursor uses to run the pipeline, injected by the collection. */
export type AggregationRunner<TSchema extends Document> = () => Promise<
	TSchema[]
>;

export class AggregationCursor<TSchema extends Document = Document> {
	private _results: TSchema[] | null = null;
	private _index = 0;
	private _closed = false;

	private readonly _runner: AggregationRunner<TSchema>;

	/** @internal */
	constructor(runner: AggregationRunner<TSchema>) {
		this._runner = runner;
	}

	get closed(): boolean {
		return this._closed;
	}

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

	async forEach(
		// biome-ignore lint/suspicious/noConfusingVoidType: matches MongoDB driver's forEach signature
		iterator: (doc: TSchema) => boolean | void,
	): Promise<void> {
		this._throwIfClosed();
		await this._execute();
		for (const doc of this._results ?? []) {
			if (iterator(doc) === false) break;
		}
	}

	async close(): Promise<void> {
		this._closed = true;
		this._results = null;
	}

	/** Rewind to the start, discarding the materialised results. */
	rewind(): this {
		this._index = 0;
		this._results = null;
		this._closed = false;
		return this;
	}

	clone(): AggregationCursor<TSchema> {
		return new AggregationCursor<TSchema>(this._runner);
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<TSchema> {
		this._throwIfClosed();
		await this._execute();
		for (const doc of this._results ?? []) yield doc;
	}

	private async _execute(): Promise<void> {
		if (this._results !== null) return;
		this._results = await this._runner();
	}

	private _throwIfClosed(): void {
		if (this._closed) throw new MongoCursorExhaustedError();
	}
}
