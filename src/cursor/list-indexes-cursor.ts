/**
 * MongoDB-compatible `ListIndexesCursor`.
 *
 * `listIndexes()` returns a cursor rather than an array because that is what
 * every MongoDB consumer writes against — `await col.listIndexes().toArray()`.
 * The listing itself is a single `INFO FOR TABLE` round trip with no server-side
 * cursor behind it, so the whole result is materialised on first consumption and
 * then walked locally; batching would be a fiction.
 */

import { MongoCursorExhaustedError } from "../errors.ts";
import type { IndexDescriptionInfo } from "../types.ts";

/** Hook the cursor uses to fetch the listing, injected by the `Collection`. */
export type ListIndexesRunner = () => Promise<IndexDescriptionInfo[]>;

export class ListIndexesCursor {
	private _results: IndexDescriptionInfo[] | null = null;
	private _index = 0;
	private _closed = false;

	private readonly _runner: ListIndexesRunner;

	/** @internal */
	constructor(runner: ListIndexesRunner) {
		this._runner = runner;
	}

	get closed(): boolean {
		return this._closed;
	}

	async toArray(): Promise<IndexDescriptionInfo[]> {
		this._throwIfClosed();
		await this._execute();
		return this._results!.slice();
	}

	async next(): Promise<IndexDescriptionInfo | null> {
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
		iterator: (description: IndexDescriptionInfo) => boolean | void,
	): Promise<void> {
		this._throwIfClosed();
		await this._execute();
		for (const description of this._results ?? []) {
			if (iterator(description) === false) break;
		}
	}

	async close(): Promise<void> {
		this._closed = true;
		this._results = null;
	}

	/** Rewind to the start, discarding the materialised listing. */
	rewind(): this {
		this._index = 0;
		this._results = null;
		this._closed = false;
		return this;
	}

	clone(): ListIndexesCursor {
		return new ListIndexesCursor(this._runner);
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<IndexDescriptionInfo> {
		this._throwIfClosed();
		await this._execute();
		for (const description of this._results ?? []) yield description;
	}

	private async _execute(): Promise<void> {
		if (this._results !== null) return;
		this._results = await this._runner();
	}

	private _throwIfClosed(): void {
		if (this._closed) throw new MongoCursorExhaustedError();
	}
}
