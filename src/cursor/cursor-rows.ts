/**
 * What a cursor reads its documents from.
 *
 * A cursor can be read two ways, and which it is depends on the first thing the
 * caller does. `toArray()` wants everything, and the whole result arrives in one
 * response — the form that costs least. `next()`, `hasNext()`, `forEach()` and
 * `for await` want a document at a time, and for those the rows are streamed as
 * the server produces them, so the first document is in hand before the last one
 * has been found, and leaving early stops the server producing the rest.
 *
 * This holds that state once for both cursors, so `FindCursor` and
 * `AggregationCursor` keep only what is theirs: their chaining methods and their
 * `closed` flag.
 *
 * With no stream to open, everything is read whole and walked locally, which is
 * how the cursors worked before and what a cursor with nothing to stream from —
 * every test double — still does.
 */

const DONE: IteratorReturnResult<undefined> = {
	done: true,
	value: undefined,
};

export class CursorRows<T> {
	/** The whole result, once it has been read that way. */
	private results: T[] | null = null;
	private index = 0;
	/** The rows as they arrive, once the cursor has begun to be read that way. */
	private stream: AsyncIterableIterator<T> | null = null;
	/** One row read ahead, so that `hasNext()` can answer without losing it. */
	private peeked: IteratorResult<T, undefined> | undefined;

	constructor(
		private readonly load: () => Promise<T[]>,
		private readonly open?: () => AsyncIterableIterator<T>,
	) {}

	/** True once any rows have been asked for, which is when chaining must stop. */
	get started(): boolean {
		return this.results !== null || this.stream !== null;
	}

	/** True when the rows are being read as a stream, so leaving early matters. */
	get streaming(): boolean {
		return this.stream !== null;
	}

	/** Begin reading a document at a time: stream if a stream can be had. */
	async begin(): Promise<void> {
		if (this.started) return;
		if (this.open) {
			this.stream = this.open();
			return;
		}
		this.results = await this.load();
	}

	/** The next document, or `done` at the end. */
	async next(): Promise<IteratorResult<T, undefined>> {
		if (this.results !== null) {
			return this.index < this.results.length
				? { done: false, value: this.results[this.index++] as T }
				: DONE;
		}
		if (this.peeked !== undefined) {
			const step = this.peeked;
			this.peeked = undefined;
			return step;
		}
		return this.stream ? ((await this.stream.next()) as typeof DONE) : DONE;
	}

	/** Whether there is a next document, reading one ahead to find out. */
	async hasNext(): Promise<boolean> {
		if (this.results !== null) return this.index < this.results.length;
		if (this.stream === null) return false;
		// Assigned only once the read has succeeded, so a failure is thrown rather
		// than remembered as an end.
		this.peeked ??= (await this.stream.next()) as typeof DONE;
		return !this.peeked.done;
	}

	/**
	 * Every document that has not been read yet.
	 *
	 * From a cursor that has not been read at all this is the whole result in one
	 * response; from one that is being streamed it is the rest of the stream.
	 */
	async toArray(): Promise<T[]> {
		if (this.stream !== null) {
			const rest: T[] = [];
			for (;;) {
				const step = await this.next();
				if (step.done) return rest;
				rest.push(step.value);
			}
		}
		this.results ??= await this.load();
		return this.results.slice();
	}

	/** How many documents the query matches, whatever has been read already. */
	async count(): Promise<number> {
		if (this.results !== null) return this.results.length;
		const all = await this.load();
		// A cursor being streamed keeps streaming; one that was not has now read
		// everything, and keeps it.
		if (this.stream === null) this.results = all;
		return all.length;
	}

	/** Stop reading: the server stops producing what nobody will read. */
	async release(): Promise<void> {
		const stream = this.stream;
		this.stream = null;
		this.results = null;
		this.peeked = undefined;
		await stream?.return?.();
	}

	/** Back to the start, ready to be read again from nothing. */
	reset(): void {
		void this.release();
		this.index = 0;
	}
}
