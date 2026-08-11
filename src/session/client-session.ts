/**
 * MongoDB-compatible `ClientSession`, backed by a real SurrealDB transaction.
 *
 * A session is a client-side object: `MongoClient.startSession()` is
 * synchronous and nothing reaches the server until `startTransaction()` is
 * followed by an actual statement. From there the session owns a
 * `TransactionScope` — a `QueryExecutor` bound to a SurrealDB transaction — and
 * every operation handed this session runs through that instead of the base
 * connection. The isolation is the server's, not a simulation: a read inside the
 * transaction sees its own uncommitted writes and a read outside does not.
 *
 * The state machine, the misuse errors and the `withTransaction` retry
 * semantics are MongoDB's, because transaction code is written against them:
 * `withTransaction` retrying a callback whose error is labelled
 * `TransientTransactionError` is how applications survive a write conflict
 * without writing a retry loop themselves.
 */

import { Uuid } from "surrealdb";
import type { MongoClient } from "../client/mongo-client.ts";
import { assertSupportedOptions } from "../collection/operation-options.ts";
import {
	MongoErrorCode,
	MongoErrorLabel,
	MongoExpiredSessionError,
	MongoInvalidArgumentError,
	MongoNetworkError,
	MongoServerError,
	MongoTransactionError,
} from "../errors.ts";
import type { QueryExecutor } from "../surreal/query-executor.ts";
import type { TransactionScope } from "../surreal/transaction-executor.ts";
import type { CommandOperationOptions } from "../types.ts";
import { Transaction, TransactionState } from "./transaction.ts";

/**
 * Configuration for a transaction. Mirrors MongoDB's `TransactionOptions`
 * (mongodb.d.ts:8651).
 *
 * MongoDB's own shape also carries `session`, purely as a by-product of the
 * `Omit` it is built from — it names the session whose transaction is being
 * started, which is the receiver. It is dropped here rather than accepted and
 * ignored.
 */
export interface TransactionOptions
	extends Omit<CommandOperationOptions, "timeoutMS" | "session"> {
	/**
	 * Longest a commit may take, in milliseconds. Honoured: the commit is raced
	 * against this budget, and losing the race is reported the way MongoDB
	 * reports a commit that outran `maxCommitTimeMS` — code 50, labelled
	 * `UnknownTransactionCommitResult`, because the commit is still in flight and
	 * may yet apply.
	 */
	maxCommitTimeMS?: number;
}

/**
 * Settings for a new session. Mirrors MongoDB's `ClientSessionOptions`
 * (mongodb.d.ts:2470).
 */
export interface ClientSessionOptions {
	/**
	 * Whether reads in this session observe its own prior writes. Accepted, no
	 * effect: there is one node, so every read already does.
	 */
	causalConsistency?: boolean;
	/**
	 * Whether every read comes from one snapshot. Rejected, with MongoDB's own
	 * refusal: a snapshot session pins one point in time for every read the
	 * session makes, transaction or not, and outside a transaction a statement is
	 * its own — so the pin has nothing to hold. `readConcern: 'snapshot'` *is*
	 * honoured, on an operation or client-wide, because there the scope of the
	 * promise is the operation or the caller's transaction, which SurrealDB's MVCC
	 * already gives.
	 */
	snapshot?: boolean;
	/** Options every transaction started on this session inherits. */
	defaultTransactionOptions?: TransactionOptions;
}

/** Settings for `endSession`. Mirrors MongoDB's `EndSessionOptions`. */
export interface EndSessionOptions {
	/** Discard client-side state without waiting on the server. */
	force?: boolean;
}

/**
 * Identifier for a session. Mirrors MongoDB's `ServerSessionId`, whose `id` is a
 * BSON `Binary` holding a UUID; this driver has no BSON layer, so the UUID is
 * carried as its canonical string form.
 */
export interface ClientSessionId {
	id: string;
}

/** Callback run inside a transaction by `ClientSession.withTransaction`. */
export type WithTransactionCallback<T = unknown> = (
	session: ClientSession,
) => Promise<T>;

/** Callback run with a session by `MongoClient.withSession`. */
export type WithSessionCallback<T = unknown> = (
	session: ClientSession,
) => Promise<T>;

/**
 * How long `withTransaction` keeps retrying when the caller names no budget, in
 * milliseconds.
 *
 * MongoDB's figure, and it transfers directly: a SurrealDB write conflict is
 * resolved by whichever writer commits first, so retrying is bounded by how long
 * a caller is willing to contend rather than by anything about the store.
 */
const MAX_WITH_TRANSACTION_TIMEOUT_MS = 120_000;

/** Backoff between `withTransaction` attempts, matching the MongoDB driver. */
const BACKOFF_INITIAL_MS = 5;
const BACKOFF_MAX_MS = 500;
const BACKOFF_GROWTH = 1.5;

/** How one `withTransaction` attempt finished. */
type AttemptOutcome<T> =
	| { readonly committed: true; readonly result: T }
	| { readonly committed: false; readonly error: unknown };

export class ClientSession implements AsyncDisposable {
	/** The client this session belongs to; operations must use the same one. */
	readonly client: MongoClient;

	/** True once `endSession()` has been called. */
	hasEnded = false;

	/**
	 * True for sessions the caller asked for, as opposed to ones a driver creates
	 * implicitly per operation. Always true here: this driver has no implicit
	 * sessions, because without a session an operation simply uses the connection.
	 */
	readonly explicit = true;

	/** What this session guarantees beyond a bare connection. */
	readonly supports: { causalConsistency: boolean };

	/** Options every transaction started on this session inherits. */
	defaultTransactionOptions: TransactionOptions;

	private readonly _id: ClientSessionId;
	private _transaction = new Transaction();
	/** The live SurrealDB transaction, once a statement has needed one. */
	private scope: TransactionScope | undefined;
	/** In-flight acquisition, so two concurrent statements share one handle. */
	private acquiring: Promise<TransactionScope> | undefined;
	/** Set when the current transaction's commit was attempted and rejected. */
	private commitFailure: { readonly cause: unknown } | undefined;

	/** @internal Sessions are created by `MongoClient.startSession()`. */
	constructor(client: MongoClient, options?: ClientSessionOptions) {
		if (options?.snapshot === true) {
			throw new MongoServerError(
				"node needs to be a replica set member to use snapshot sessions",
				{ code: MongoErrorCode.NotAReplicaSet },
			);
		}

		this.client = client;
		// The SDK's generator rather than `crypto.randomUUID()`, which browsers
		// expose only in a secure context — and this driver ships a browser bundle.
		this._id = { id: Uuid.v4().toString() };
		this.supports = { causalConsistency: options?.causalConsistency ?? true };
		this.defaultTransactionOptions = { ...options?.defaultTransactionOptions };
	}

	/** This session's identifier. */
	get id(): ClientSessionId | undefined {
		return this._id;
	}

	/** The current transaction's state, whether or not one is active. */
	get transaction(): Transaction {
		return this._transaction;
	}

	/** Whether statements issued with this session run inside a transaction. */
	inTransaction(): boolean {
		return this._transaction.isActive;
	}

	/** True when `session` is this same session. */
	equals(session: ClientSession): boolean {
		return session instanceof ClientSession && session._id.id === this._id.id;
	}

	/**
	 * Refuse to be serialised.
	 *
	 * A session is a handle on a live transaction, so a copy of one is
	 * meaningless. MongoDB defines the same trap because a session reaching a
	 * document — via a spread of an options object, most often — would otherwise
	 * be written to the database.
	 */
	toBSON(): never {
		throw new MongoInvalidArgumentError(
			"ClientSession cannot be serialized to BSON.",
		);
	}

	/**
	 * Begin a transaction.
	 *
	 * Synchronous, and deliberately so: MongoDB's is, which means a caller may
	 * start a transaction on a client that has not connected yet. Nothing reaches
	 * SurrealDB until a statement needs the transaction, at which point
	 * `beginTransaction()` is issued for it.
	 */
	startTransaction(options?: TransactionOptions): void {
		this.assertUsable();
		if (this.inTransaction()) {
			throw new MongoTransactionError("Transaction already in progress");
		}

		const resolved: TransactionOptions = {
			...this.defaultTransactionOptions,
			...options,
		};
		// The same gate every operation's options pass through: a durability or
		// consistency promise this driver cannot keep must be refused here too,
		// before any statement inherits it.
		assertSupportedOptions(resolved);

		this._transaction = new Transaction(resolved);
		this._transaction.transition(TransactionState.StartingTransaction);
		this.scope = undefined;
		this.acquiring = undefined;
		this.commitFailure = undefined;
	}

	/**
	 * Apply everything done in the current transaction.
	 *
	 * A commit that fails cannot be retried: SurrealDB's transaction handle is
	 * spent by the attempt, and a second `commitTransaction()` therefore replays
	 * the original failure rather than pretending to try again.
	 */
	async commitTransaction(): Promise<void> {
		this.assertUsable();
		const state = this._transaction.state;

		if (state === TransactionState.NoTransaction) {
			throw new MongoTransactionError("No transaction started");
		}
		if (
			state === TransactionState.StartingTransaction ||
			state === TransactionState.TransactionCommittedEmpty
		) {
			// Nothing was ever sent, so there is nothing to commit and no round trip
			// worth making.
			this._transaction.transition(TransactionState.TransactionCommittedEmpty);
			return;
		}
		if (state === TransactionState.TransactionAborted) {
			throw new MongoTransactionError(
				"Cannot call commitTransaction after calling abortTransaction",
			);
		}
		if (state === TransactionState.TransactionCommitted) {
			// Repeating a commit that succeeded is harmless: the work is already
			// durable, which is what MongoDB's own re-sent commit establishes.
			if (!this.commitFailure) return;
			throw new MongoTransactionError(
				"Cannot retry commitTransaction: the commit already failed, and SurrealDB's transaction handle is consumed by the attempt",
				{ cause: this.commitFailure.cause },
			);
		}

		const scope = this.takeScope();
		try {
			await withCommitBudget(
				scope.commit(),
				this._transaction.options.maxCommitTimeMS,
			);
		} catch (error) {
			this.commitFailure = { cause: error };
			throw labelUnknownCommitResult(error);
		} finally {
			this._transaction.transition(TransactionState.TransactionCommitted);
		}
	}

	/**
	 * Discard everything done in the current transaction.
	 *
	 * A failure to reach the server is swallowed, as MongoDB swallows it: the
	 * transaction is being abandoned either way, and the reason the caller is
	 * aborting is nearly always more interesting than the abort's own trouble.
	 */
	async abortTransaction(): Promise<void> {
		this.assertUsable();
		const state = this._transaction.state;

		if (state === TransactionState.NoTransaction) {
			throw new MongoTransactionError("No transaction started");
		}
		if (state === TransactionState.StartingTransaction) {
			this._transaction.transition(TransactionState.TransactionAborted);
			return;
		}
		if (state === TransactionState.TransactionAborted) {
			throw new MongoTransactionError("Cannot call abortTransaction twice");
		}
		if (
			state === TransactionState.TransactionCommitted ||
			state === TransactionState.TransactionCommittedEmpty
		) {
			throw new MongoTransactionError(
				"Cannot call abortTransaction after calling commitTransaction",
			);
		}

		const scope = this.takeScope();
		try {
			await scope.cancel();
		} catch {
			// Intentionally ignored — see the doc comment above.
		} finally {
			this._transaction.transition(TransactionState.TransactionAborted);
		}
	}

	/**
	 * Run `fn` in a transaction, committing when it returns and aborting when it
	 * throws.
	 *
	 * `fn` may run more than once. A write conflict — two transactions touching
	 * the same record, where SurrealDB lets both write and rejects whichever
	 * commits second — arrives labelled `TransientTransactionError`, and that is
	 * a genuine invitation to retry: nothing about the conflict recurs on a
	 * second attempt against fresh data. So the whole callback is re-run, with
	 * jittered backoff, until it succeeds or the budget runs out.
	 *
	 * MongoDB additionally retries the *commit alone* on
	 * `UnknownTransactionCommitResult`. That has no counterpart here, because
	 * SurrealDB's transaction handle is consumed by the commit attempt: there is
	 * nothing left to re-commit against. Such a failure is surfaced with the
	 * label intact so a caller can see that the outcome is genuinely unknown,
	 * rather than being retried against a handle the server has released.
	 *
	 * `fn` must await every operation it starts. An error it swallows is an error
	 * this method cannot see, and it will commit a transaction the caller knows
	 * to be broken.
	 *
	 * @param options - Transaction options, plus `timeoutMS` to bound the retrying
	 *                  rather than accepting the default two minutes.
	 */
	async withTransaction<T = unknown>(
		fn: WithTransactionCallback<T>,
		options?: TransactionOptions & { timeoutMS?: number },
	): Promise<T> {
		const { timeoutMS, ...transactionOptions } = options ?? {};
		const deadline =
			performance.now() + (timeoutMS ?? MAX_WITH_TRANSACTION_TIMEOUT_MS);
		let lastError: unknown;

		for (let attempt = 0; ; attempt += 1) {
			if (attempt > 0) {
				const backoffMS = backoffFor(attempt);
				if (performance.now() + backoffMS >= deadline) throw lastError;
				await sleep(backoffMS);
			}

			this.startTransaction(transactionOptions);
			const outcome = await this.attemptTransaction(fn);
			if (outcome.committed) return outcome.result;

			lastError = outcome.error;
			if (!isRetryable(outcome.error) || performance.now() >= deadline) {
				throw outcome.error;
			}
		}
	}

	/**
	 * One pass of a `withTransaction` callback and the commit that follows it.
	 *
	 * Returns rather than throws, so the retry decision is taken in one place
	 * instead of being repeated at each of the ways an attempt can fail.
	 */
	private async attemptTransaction<T>(
		fn: WithTransactionCallback<T>,
	): Promise<AttemptOutcome<T>> {
		let result: T;
		try {
			const running = fn(this);
			if (!isPromiseLike(running)) {
				throw new MongoInvalidArgumentError(
					"Function provided to `withTransaction` must return a Promise",
				);
			}
			result = await running;
		} catch (error) {
			if (this.inTransaction()) await this.abortTransaction();
			return { committed: false, error };
		}

		// A callback that committed or aborted for itself has said what it wants;
		// committing again over the top would be second-guessing it.
		if (!this.inTransaction()) return { committed: true, result };

		try {
			await this.commitTransaction();
			return { committed: true, result };
		} catch (error) {
			return { committed: false, error };
		}
	}

	/**
	 * Release this session. An open transaction is aborted, as MongoDB aborts it:
	 * a caller who ends a session without committing has not committed.
	 */
	async endSession(_options?: EndSessionOptions): Promise<void> {
		if (this.hasEnded) return;
		try {
			if (this.inTransaction()) await this.abortTransaction();
		} catch {
			// A session is being released; there is nothing left to report to.
		} finally {
			this.hasEnded = true;
			this.client._forgetSession(this);
		}
	}

	/** Alias for `endSession()`, so `await using session = …` works. */
	async [Symbol.asyncDispose](): Promise<void> {
		await this.endSession({ force: true });
	}

	/**
	 * @internal The executor a statement issued with this session must use.
	 *
	 * Outside a transaction that is the base connection, exactly as if no session
	 * had been passed. Inside one it is the transaction, acquired on first use —
	 * which is where `startTransaction()`'s deferred round trip finally happens.
	 */
	async _executor(fallback: QueryExecutor): Promise<QueryExecutor> {
		this.assertUsable();
		if (!this.inTransaction()) return fallback;
		return this.acquireScope();
	}

	/**
	 * Acquire the SurrealDB transaction, once.
	 *
	 * The in-flight promise is shared so two statements issued back to back
	 * cannot each begin a transaction, which would leave one of them orphaned and
	 * the other invisible to the session.
	 */
	private async acquireScope(): Promise<TransactionScope> {
		if (this.scope) return this.scope;
		this.acquiring ??= this.client._beginTransaction().then(
			async (scope) => {
				// A caller who aborted, committed or ended the session while this was
				// still in flight settled a transaction that had not opened yet. It has
				// now, so close it here — nothing will ever ask for it again, and the
				// statement waiting on it must fail rather than run outside the
				// transaction the caller believes was discarded.
				if (!this._transaction.isStarting) {
					await scope.cancel().catch(() => {});
					return scope;
				}
				this.scope = scope;
				// Only now is there a transaction on the server.
				this._transaction.transition(TransactionState.TransactionInProgress);
				return scope;
			},
			(error: unknown) => {
				this.acquiring = undefined;
				throw error;
			},
		);
		return this.acquiring;
	}

	/**
	 * The live transaction, for a commit or abort that needs to reach the server.
	 *
	 * Only reached from `TRANSACTION_IN_PROGRESS`, which is entered when the handle
	 * is stored. The handle is therefore absent for one reason: a commit or abort
	 * took it and has not finished, so the state still says in progress. That is a
	 * caller racing two settle calls against one transaction, and it is named as
	 * such rather than reported as the driver losing track of its own state.
	 */
	private takeScope(): TransactionScope {
		const scope = this.scope;
		if (!scope) {
			throw new MongoTransactionError(
				"Cannot commit or abort a transaction while another commit or abort is still in flight",
			);
		}
		this.scope = undefined;
		this.acquiring = undefined;
		return scope;
	}

	private assertUsable(): void {
		if (this.hasEnded) throw new MongoExpiredSessionError();
	}
}

/**
 * The executor an operation must run through, given whatever the caller put in
 * `options.session`.
 *
 * This is the only thing an operation needs to know about sessions: pass the
 * caller's value and the connection it would otherwise have used, and run the
 * statement against what comes back.
 */
export async function sessionExecutor(
	session: unknown,
	client: MongoClient,
	fallback: QueryExecutor,
): Promise<QueryExecutor> {
	if (session === undefined || session === null) return fallback;

	if (!(session instanceof ClientSession)) {
		throw new MongoInvalidArgumentError(
			"Option 'session' must be a ClientSession obtained from MongoClient.startSession()",
		);
	}
	if (session.client !== client) {
		throw new MongoInvalidArgumentError(
			"ClientSession must be from the same MongoClient",
		);
	}

	return session._executor(fallback);
}

/**
 * Whether a failed attempt is worth repeating from the top.
 *
 * Only the transient label counts. A commit whose result is unknown must not be
 * re-run: repeating the callback could apply the same writes twice.
 */
function isRetryable(error: unknown): boolean {
	return (
		error instanceof Error &&
		"hasErrorLabel" in error &&
		typeof error.hasErrorLabel === "function" &&
		error.hasErrorLabel(MongoErrorLabel.TransientTransactionError) === true
	);
}

/**
 * Mark a commit failure whose outcome nobody can know.
 *
 * A commit that failed because the connection went away may still have been
 * applied: the request had already left, and what is missing is the reply. That
 * is exactly what MongoDB's `UnknownTransactionCommitResult` says, and MongoDB
 * attaches it to the same case — a network failure on a commit — so a caller who
 * branches on the label to decide whether re-doing the work is safe reads the
 * truth here too. Without it, an unknown outcome would be indistinguishable from
 * a commit that provably did not happen.
 *
 * The label also keeps such a failure away from `withTransaction`'s retry, which
 * repeats only what is labelled transient; replaying a callback over a commit
 * that may have landed could apply its writes twice.
 */
function labelUnknownCommitResult(error: unknown): unknown {
	if (error instanceof MongoNetworkError) {
		error.addErrorLabel(MongoErrorLabel.UnknownTransactionCommitResult);
	}
	return error;
}

/** Jittered exponential backoff before attempt number `attempt`. */
function backoffFor(attempt: number): number {
	const ceiling = Math.min(
		BACKOFF_INITIAL_MS * BACKOFF_GROWTH ** (attempt - 1),
		BACKOFF_MAX_MS,
	);
	return Math.random() * ceiling;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as PromiseLike<unknown>).then === "function"
	);
}

/**
 * Bound a commit by `maxCommitTimeMS`.
 *
 * Losing the race does not cancel the commit — the request is already with the
 * server — so the outcome really is unknown, and it is reported with the code
 * and the label MongoDB uses to say exactly that.
 */
async function withCommitBudget(
	commit: Promise<void>,
	maxCommitTimeMS: number | undefined,
): Promise<void> {
	if (maxCommitTimeMS === undefined || maxCommitTimeMS <= 0) return commit;

	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			const error = new MongoServerError("operation exceeded time limit", {
				code: MongoErrorCode.MaxTimeMSExpired,
			});
			error.addErrorLabel(MongoErrorLabel.UnknownTransactionCommitResult);
			reject(error);
		}, maxCommitTimeMS);
	});

	try {
		await Promise.race([commit, expiry]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
