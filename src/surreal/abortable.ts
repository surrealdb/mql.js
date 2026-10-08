/**
 * Scoping an executor to the caller's `AbortSignal`.
 *
 * MongoDB's driver takes a `signal` on six operations — `find`, `findOne`,
 * `countDocuments`, `aggregate`, `Db.command` and `listCollections` — and on the
 * cursors the first, fourth and last return. The same check is made in one place
 * here so that the six cannot disagree about what a bad or unusable signal means.
 */

import {
	MongoCompatibilityError,
	MongoInvalidArgumentError,
} from "../errors.ts";
import type { QueryExecutor } from "./query-executor.ts";

/** Whether `value` is something that can be asked whether it has aborted. */
function isAbortSignal(value: unknown): value is AbortSignal {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as AbortSignal).aborted === "boolean" &&
		typeof (value as AbortSignal).throwIfAborted === "function" &&
		typeof (value as AbortSignal).addEventListener === "function"
	);
}

/**
 * Refuse a `signal` that is not an `AbortSignal`, where the call is made.
 *
 * MongoDB's driver finds out later and worse — a `TypeError` from inside the
 * cursor — so this reports the mistake in the call, in this driver's own error,
 * for the same reason an unsupported option is reported before anything is sent.
 */
export function assertAbortSignal(
	signal: unknown,
): asserts signal is AbortSignal | undefined {
	if (signal !== undefined && !isAbortSignal(signal)) {
		throw new MongoInvalidArgumentError(
			"Option 'signal' must be an AbortSignal",
		);
	}
}

/**
 * Throw the reason of a `signal` that has already aborted, and refuse one that is
 * not a signal at all.
 *
 * For the operation that may answer without sending a statement — `ping` is
 * one — and so would never meet a signal that only the executor consults.
 * MongoDB asks before it does anything else.
 */
export function throwIfAborted(signal: unknown): void {
	assertAbortSignal(signal);
	signal?.throwIfAborted();
}

/**
 * `executor`, with every statement it sends stopped by `signal`; `executor`
 * itself when there is no signal.
 *
 * Refused inside a transaction, where a statement already sent cannot be taken
 * back: the caller would be told the operation was aborted while it went on to
 * run and be committed. See `TransactionExecutor.withSignal`, which gives the
 * same refusal to anything that reaches it directly.
 */
export function abortable(
	executor: QueryExecutor,
	signal: unknown,
	inTransaction: boolean,
): QueryExecutor {
	if (signal === undefined) return executor;

	assertAbortSignal(signal);
	if (inTransaction) {
		throw new MongoCompatibilityError(
			"The 'signal' option is not supported inside a transaction: a statement already sent to a transaction cannot be stopped, so the caller would be told it was aborted while it went on to run. Abort the transaction instead.",
		);
	}

	return executor.withSignal(signal);
}
