/**
 * The transaction state machine a `ClientSession` carries.
 *
 * The states and the legal transitions between them are MongoDB's, because they
 * are what decide which misuse errors a caller sees: `commitTransaction()` on a
 * never-started transaction and on an aborted one are different mistakes with
 * different messages, and only a state machine can tell them apart.
 *
 * Two of the states exist because a transaction is not begun on the server until
 * the first statement needs it. `STARTING_TRANSACTION` is the window in between,
 * and `TRANSACTION_COMMITTED_EMPTY` is what committing from that window means:
 * nothing was ever sent, so there is nothing to commit and no round trip to make.
 * MongoDB defers `startTransaction` the same way, and SurrealDB's
 * `beginTransaction()` — which does make a round trip — is deferred to match, so
 * that a session opened and closed without a statement costs nothing.
 */

import { MongoRuntimeError } from "../errors.ts";
import type { TransactionOptions } from "./client-session.ts";

/** Where a session's transaction is in its lifecycle. */
export const TransactionState = {
	/** No transaction has been started, or the last one has been reset. */
	NoTransaction: "NO_TRANSACTION",
	/** `startTransaction()` was called; nothing has reached the server yet. */
	StartingTransaction: "STARTING_TRANSACTION",
	/** At least one statement is running inside the transaction. */
	TransactionInProgress: "TRANSACTION_IN_PROGRESS",
	/** The transaction was committed. */
	TransactionCommitted: "TRANSACTION_COMMITTED",
	/** The transaction was committed without ever having issued a statement. */
	TransactionCommittedEmpty: "TRANSACTION_COMMITTED_EMPTY",
	/** The transaction was aborted. */
	TransactionAborted: "TRANSACTION_ABORTED",
} as const;

export type TransactionState =
	(typeof TransactionState)[keyof typeof TransactionState];

/**
 * Legal successors of each state.
 *
 * Kept as data because it is the specification: reading it is how one confirms
 * that, for instance, an in-progress transaction can only be committed or
 * aborted. Only the transitions this driver actually makes are listed, so
 * anything else is a bug rather than an unexercised possibility — a session
 * starts each transaction from a fresh `Transaction`, which is why no terminal
 * state leads back to `STARTING_TRANSACTION`.
 */
const TRANSITIONS: Readonly<
	Record<TransactionState, readonly TransactionState[]>
> = {
	[TransactionState.NoTransaction]: [TransactionState.StartingTransaction],
	[TransactionState.StartingTransaction]: [
		TransactionState.TransactionInProgress,
		TransactionState.TransactionCommittedEmpty,
		TransactionState.TransactionAborted,
	],
	[TransactionState.TransactionInProgress]: [
		TransactionState.TransactionCommitted,
		TransactionState.TransactionAborted,
	],
	[TransactionState.TransactionCommitted]: [],
	// A second commit with nothing to commit is a repeat of the same no-op.
	[TransactionState.TransactionCommittedEmpty]: [
		TransactionState.TransactionCommittedEmpty,
	],
	[TransactionState.TransactionAborted]: [],
};

/** The states in which statements may still be issued. */
const ACTIVE_STATES: readonly TransactionState[] = [
	TransactionState.StartingTransaction,
	TransactionState.TransactionInProgress,
];

/** The states from which no further work is possible. */
const TERMINAL_STATES: readonly TransactionState[] = [
	TransactionState.TransactionCommitted,
	TransactionState.TransactionCommittedEmpty,
	TransactionState.TransactionAborted,
];

/**
 * A single transaction's state and the options it was started with.
 *
 * Reachable as `session.transaction` so a caller can ask what state their
 * session is in, which is more informative than `inTransaction()` alone when a
 * `withTransaction` callback needs to know whether it already committed.
 */
export class Transaction {
	/** Options this transaction was started with, after defaults were applied. */
	readonly options: Readonly<TransactionOptions>;

	private _state: TransactionState = TransactionState.NoTransaction;

	constructor(options: Readonly<TransactionOptions> = {}) {
		this.options = options;
	}

	/** Where this transaction is in its lifecycle. */
	get state(): TransactionState {
		return this._state;
	}

	/** True between `startTransaction()` and the first statement. */
	get isStarting(): boolean {
		return this._state === TransactionState.StartingTransaction;
	}

	/** True while statements may still be issued — what `inTransaction()` reports. */
	get isActive(): boolean {
		return ACTIVE_STATES.includes(this._state);
	}

	/**
	 * True once the transaction has finished, whether by commit or by abort.
	 *
	 * Named as MongoDB names it, where the same predicate covers all three
	 * terminal states: what callers ask it is "is this transaction over".
	 */
	get isCommitted(): boolean {
		return TERMINAL_STATES.includes(this._state);
	}

	/**
	 * Move to `next`, or reject the move as a driver bug.
	 *
	 * Every caller checks the current state before transitioning, so an illegal
	 * transition means the driver's own bookkeeping is wrong — not that the caller
	 * did anything. Hence `MongoRuntimeError` rather than a transaction error.
	 */
	transition(next: TransactionState): void {
		if (!TRANSITIONS[this._state].includes(next)) {
			throw new MongoRuntimeError(
				`Attempted illegal state transition from [${this._state}] to [${next}]`,
			);
		}
		this._state = next;
	}
}
