/**
 * MongoDB-compatible `AggregationCursor`.
 *
 * `aggregate()` returns one synchronously, as the real driver does, and nothing
 * is sent until it is consumed. The same shape as `ListCollectionsCursor` and
 * `ListIndexesCursor`, for the same reason: a consumer written against MongoDB
 * calls `.toArray()` on the returned value, and against a promise that reads
 * `.toArray` off a `Promise` and calls `undefined`.
 *
 * Read a document at a time — `next()`, `hasNext()`, `forEach()`, `for await` —
 * the rows are streamed as the server produces them and leaving early stops the
 * server producing the rest (see `CursorRows`); `toArray()` reads the whole result
 * in one response. The server chooses how the rows are framed, so `batchSize` is
 * accepted and ignored: there is no batch size to honour, and pretending to would
 * be a fiction.
 */

import { MongoCursorExhaustedError } from "../errors.ts";
import type { Document } from "../types.ts";
import { CursorRows, CursorSignal } from "./cursor-rows.ts";

/** Hook the cursor uses to run the pipeline, injected by the collection. */
export type AggregationRunner<TSchema extends Document> = () => Promise<
	TSchema[]
>;

/**
 * The hook the cursor uses to read the pipeline a document at a time. Optional: a
 * cursor with none reads everything at once.
 */
export type AggregationStreamer<TSchema extends Document> =
	() => AsyncIterableIterator<TSchema>;

export class AggregationCursor<TSchema extends Document = Document> {
	private _closed = false;

	private readonly _runner: AggregationRunner<TSchema>;
	private readonly _streamer: AggregationStreamer<TSchema> | undefined;
	private readonly _rows: CursorRows<TSchema>;
	private readonly _signal: CursorSignal;
	private readonly _abort: AbortSignal | undefined;

	/** @internal */
	constructor(
		runner: AggregationRunner<TSchema>,
		streamer?: AggregationStreamer<TSchema>,
		signal?: AbortSignal,
	) {
		this._runner = runner;
		this._streamer = streamer;
		this._abort = signal;
		this._signal = new CursorSignal(
			signal,
			() => void this.close().catch(() => undefined),
		);
		this._rows = new CursorRows<TSchema>(runner, streamer);
	}

	get closed(): boolean {
		return this._closed;
	}

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

	async forEach(
		// biome-ignore lint/suspicious/noConfusingVoidType: matches MongoDB driver's forEach signature
		iterator: (doc: TSchema) => boolean | void,
	): Promise<void> {
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

	async close(): Promise<void> {
		this._closed = true;
		this._signal.release();
		await this._rows.release();
	}

	/** Rewind to the start, discarding what has been read. */
	rewind(): this {
		this._rows.reset();
		this._closed = false;
		this._signal.watch();
		return this;
	}

	clone(): AggregationCursor<TSchema> {
		return new AggregationCursor<TSchema>(
			this._runner,
			this._streamer,
			this._abort,
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
				this._signal.throwIfAborted();
			}
		} finally {
			// Breaking out of a `for await` leaves the cursor, as it does in MongoDB.
			if (!exhausted && this._rows.streaming) await this.close();
		}
	}

	private _throwIfClosed(): void {
		if (this._closed) throw new MongoCursorExhaustedError();
	}
}
