/**
 * Rows delivered one at a time, and stoppable from outside.
 *
 * Everything that reads a result a row at a time — a cursor's `next()`, a
 * `for await` over one — is built from the same small iterators, and the port
 * method they implement is `QueryExecutor.queryRows`. They are written out as
 * plain objects with `next` and `return` rather than as `async function*`
 * generators, and that is not a style choice: the SDK learned it the hard way
 * (its #703). `return()` on a generator that is parked on a read does not run
 * until the read finishes, so a consumer that stopped early would wait for the
 * very rows it no longer wants; the objects here act on `return()` at once.
 */

import { mapQueryError } from "./error-mapper.ts";

const FINISHED: IteratorReturnResult<undefined> = {
	done: true,
	value: undefined,
};

/**
 * What a streamed query's frame must answer.
 *
 * Structural rather than the SDK's own class so a unit test can supply frames
 * without a connection, and so this file does not depend on a type the SDK does
 * not export under that name.
 */
export interface StreamedFrame {
	/** The index of the statement this frame belongs to. */
	readonly query: number;
	isValue(): boolean;
	isError(): boolean;
	/** On a value frame: the row. */
	readonly value?: unknown;
	/** On an error frame: the statement's failure. */
	readonly error?: unknown;
}

/** The next row of `statement`, throwing on any statement's failure. */
async function nextRow<T>(
	frames: AsyncIterator<StreamedFrame>,
	statement: number,
): Promise<IteratorResult<T, undefined>> {
	for (;;) {
		const step = await frames.next();
		if (step.done) return FINISHED;
		const frame = step.value;
		if (frame.isError()) throw mapQueryError(frame.error);
		if (frame.isValue() && frame.query === statement) {
			return { done: false, value: frame.value as T };
		}
	}
}

/**
 * What a stream falls back to when the server turns it away before running it.
 */
export interface StreamFallback<T> {
	/** Whether `err` is that refusal — one that proves nothing was executed. */
	when(err: unknown): boolean;
	/** The rows, read some other way. */
	rows(): AsyncIterableIterator<T>;
}

/**
 * The rows of one statement of a streamed query.
 *
 * `open` starts the query, given a signal that stops it: aborting it is what the
 * SDK turns into a `query_cancel` to the server, so a consumer that returns
 * early stops the server producing rows nobody will read.
 *
 * An error frame for **any** statement is thrown, not only the wanted one. The
 * statement in front of it may be a `USE DB` that failed, and a read that carried
 * on past that would answer from the wrong database without saying so — the
 * buffered path throws on it, and this one has to agree.
 *
 * A value is yielded as soon as its frame arrives, before the statement's done
 * frame, so an error can follow rows the caller already has. That is the cost of
 * streaming, and it is the same one a MongoDB `getMore` has.
 *
 * `fallback` is for the one failure that says the query never ran: a server that
 * will not take another stream. MongoDB has no limit on open cursors, so a cursor
 * refused for this is read some other way rather than failed — but only before a
 * single row has been delivered, because a refusal after that is not that
 * refusal, and reading again would run the query twice.
 */
export function streamRows<T>(
	open: (signal: AbortSignal) => AsyncIterable<StreamedFrame>,
	statement: number,
	fallback?: StreamFallback<T>,
): AsyncIterableIterator<T> {
	const abort = new AbortController();
	let frames: AsyncIterator<StreamedFrame> | undefined;
	let fellBack: AsyncIterableIterator<T> | undefined;
	let delivered = false;
	let finished = false;

	const iterator: AsyncIterableIterator<T> = {
		async next() {
			if (finished) return FINISHED;
			if (fellBack) return fellBack.next();
			try {
				frames ??= open(abort.signal)[Symbol.asyncIterator]();
				const step = await nextRow<T>(frames, statement);
				if (step.done) finished = true;
				else delivered = true;
				return step;
			} catch (err) {
				// `return()` while this read was parked aborts the signal, which makes
				// the read throw: that is the consumer leaving, not a failure.
				const left = finished;
				finished = true;
				abort.abort();
				if (left) return FINISHED;
				if (!delivered && fallback?.when(err)) {
					finished = false;
					fellBack = fallback.rows();
					return fellBack.next();
				}
				throw mapQueryError(err);
			}
		},

		async return() {
			if (fellBack) {
				finished = true;
				return fellBack.return?.() ?? FINISHED;
			}
			if (!finished) {
				finished = true;
				abort.abort();
				// Not awaited: a generator's `return()` queues behind the read it
				// interrupts, and the abort above is what ends that read.
				void frames?.return?.()?.catch(() => undefined);
			}
			return FINISHED;
		},

		[Symbol.asyncIterator]() {
			return iterator;
		},
	};
	return iterator;
}

/**
 * Rows that were read whole and are handed out one at a time.
 *
 * What a statement inside a transaction does, and what anything that cannot be
 * streamed falls back to. `load` runs on the first read, not when this is
 * built, so nothing is sent until the rows are wanted — and a `load` that fails
 * ends the iterator rather than leaving it to run the query again.
 */
export function bufferedRows<T>(
	load: () => Promise<readonly T[]>,
): AsyncIterableIterator<T> {
	let rows: readonly T[] | undefined;
	let index = 0;
	let finished = false;

	const iterator: AsyncIterableIterator<T> = {
		async next() {
			if (finished) return FINISHED;
			if (rows === undefined) {
				try {
					rows = await load();
				} catch (err) {
					finished = true;
					throw err;
				}
			}
			if (index >= rows.length) {
				finished = true;
				return FINISHED;
			}
			return { done: false, value: rows[index++] as T };
		},

		async return() {
			finished = true;
			return FINISHED;
		},

		[Symbol.asyncIterator]() {
			return iterator;
		},
	};
	return iterator;
}

/**
 * Rows from an iterator that cannot be built until something asynchronous has
 * happened — a connection to establish, a context to resolve.
 *
 * `return()` before the first read costs nothing: the source was never built.
 */
export function deferredRows<T>(
	open: () => Promise<AsyncIterableIterator<T>>,
): AsyncIterableIterator<T> {
	let source: AsyncIterableIterator<T> | undefined;
	let finished = false;

	const iterator: AsyncIterableIterator<T> = {
		async next() {
			if (finished) return FINISHED;
			try {
				source ??= await open();
				// `return()` may have landed while `open` was running.
				if (finished) {
					await source.return?.();
					return FINISHED;
				}
				const step = await source.next();
				if (step.done) finished = true;
				return step;
			} catch (err) {
				finished = true;
				throw err;
			}
		},

		async return() {
			finished = true;
			await source?.return?.();
			return FINISHED;
		},

		[Symbol.asyncIterator]() {
			return iterator;
		},
	};
	return iterator;
}

/** `source`'s rows, each passed through `transform`. */
export function mapRows<T, U>(
	source: AsyncIterableIterator<T>,
	transform: (row: T) => U,
): AsyncIterableIterator<U> {
	const iterator: AsyncIterableIterator<U> = {
		async next() {
			const step = await source.next();
			return step.done
				? FINISHED
				: { done: false, value: transform(step.value) };
		},

		async return() {
			await source.return?.();
			return FINISHED;
		},

		[Symbol.asyncIterator]() {
			return iterator;
		},
	};
	return iterator;
}

/**
 * `source`, except that a failure `isEmpty` recognises means "no rows".
 *
 * How a collection that was never written to reads: MongoDB answers empty and
 * SurrealDB refuses (see `selectRows`). The refusal arrives on the first read,
 * so that is where this turns it into an ordinary end.
 */
export function rowsOrNoneWhen<T>(
	source: AsyncIterableIterator<T>,
	isEmpty: (err: unknown) => boolean,
): AsyncIterableIterator<T> {
	let finished = false;

	const iterator: AsyncIterableIterator<T> = {
		async next() {
			if (finished) return FINISHED;
			try {
				const step = await source.next();
				if (step.done) finished = true;
				return step;
			} catch (err) {
				finished = true;
				if (isEmpty(err)) return FINISHED;
				throw err;
			}
		},

		async return() {
			finished = true;
			await source.return?.();
			return FINISHED;
		},

		[Symbol.asyncIterator]() {
			return iterator;
		},
	};
	return iterator;
}
