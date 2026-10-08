/**
 * MongoDB-compatible `ListCollectionsCursor`.
 *
 * `Db.listCollections()` returns a cursor **synchronously**, as the real driver
 * does, rather than a promise of an array. The difference is not cosmetic: every
 * consumer written against MongoDB calls `db.listCollections().toArray()`, and
 * against a promise that reads `.toArray` off a `Promise` and calls `undefined`.
 * Mongoose does exactly this — `const cursor = this.db.listCollections()` at
 * `lib/connection.js:896` — so the shape was the difference between an ORM
 * working and not.
 *
 * The listing itself is one `INFO FOR DB` round trip with no server-side cursor
 * behind it, so the whole result is materialised on first consumption and then
 * walked locally, exactly as `ListIndexesCursor` does. Batching would be a
 * fiction, and `batchSize` is accepted and ignored for the same reason.
 */

import { MongoCursorExhaustedError } from "../errors.ts";
import type { CollectionInfo } from "../types.ts";
import { CursorSignal } from "./cursor-rows.ts";

/** Hook the cursor uses to fetch the listing, injected by the `Db`. */
export type ListCollectionsRunner = () => Promise<CollectionInfo[]>;

export class ListCollectionsCursor {
	private _results: CollectionInfo[] | null = null;
	private _index = 0;
	private _closed = false;

	private readonly _runner: ListCollectionsRunner;
	private readonly _signal: CursorSignal;
	private readonly _abort: AbortSignal | undefined;

	/** @internal */
	constructor(runner: ListCollectionsRunner, signal?: AbortSignal) {
		this._runner = runner;
		this._abort = signal;
		this._signal = new CursorSignal(
			signal,
			() => void this.close().catch(() => undefined),
		);
	}

	get closed(): boolean {
		return this._closed;
	}

	async toArray(): Promise<CollectionInfo[]> {
		this._signal.throwIfAborted();
		this._throwIfClosed();
		await this._execute();
		return this._results!.slice();
	}

	async next(): Promise<CollectionInfo | null> {
		this._signal.throwIfAborted();
		this._throwIfClosed();
		await this._execute();
		if (this._index >= this._results!.length) return null;
		return this._results![this._index++];
	}

	async hasNext(): Promise<boolean> {
		this._signal.throwIfAborted();
		this._throwIfClosed();
		await this._execute();
		return this._index < this._results!.length;
	}

	async forEach(
		// biome-ignore lint/suspicious/noConfusingVoidType: matches MongoDB driver's forEach signature
		iterator: (info: CollectionInfo) => boolean | void,
	): Promise<void> {
		this._signal.throwIfAborted();
		this._throwIfClosed();
		await this._execute();
		for (const info of this._results ?? []) {
			this._signal.throwIfAborted();
			if (iterator(info) === false) break;
		}
	}

	async close(): Promise<void> {
		this._closed = true;
		this._results = null;
		this._signal.release();
	}

	/** Rewind to the start, discarding the materialised listing. */
	rewind(): this {
		this._index = 0;
		this._results = null;
		this._closed = false;
		this._signal.watch();
		return this;
	}

	clone(): ListCollectionsCursor {
		return new ListCollectionsCursor(this._runner, this._abort);
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<CollectionInfo> {
		this._signal.throwIfAborted();
		this._throwIfClosed();
		await this._execute();
		for (const info of this._results ?? []) {
			yield info;
			this._signal.throwIfAborted();
		}
	}

	private async _execute(): Promise<void> {
		if (this._results !== null) return;
		this._results = await this._runner();
	}

	private _throwIfClosed(): void {
		if (this._closed) throw new MongoCursorExhaustedError();
	}
}
