/**
 * Real-driver adapter implementing the `QueryExecutor` port on top of the
 * `surrealdb` SDK. All exception translation happens here so that callers
 * never see raw `surrealdb` errors.
 */

import { Features, type Surreal } from "surrealdb";
import { MongoCompatibilityError } from "../errors.ts";
import { ScopedExecutor } from "./database-scope.ts";
import { isStreamCapRefusal, mapQueryError } from "./error-mapper.ts";
import type { StatementOutcome } from "./query-executor.ts";
import { bufferedRows, type StreamedFrame, streamRows } from "./row-stream.ts";
import type { TransactionScope } from "./transaction-executor.ts";
import { TransactionExecutor } from "./transaction-executor.ts";

/** Read the SDK's per-statement responses into this driver's own shape. */
export function responseOutcomes(
	responses: readonly {
		success: boolean;
		result?: unknown;
		error?: unknown;
	}[],
): readonly StatementOutcome[] {
	return responses.map((response) => ({
		ok: response.success,
		value: response.result,
		error: response.success ? undefined : mapQueryError(response.error),
	}));
}

export class SurrealdbExecutor extends ScopedExecutor {
	private readonly surreal: Surreal;
	private _serverVersion: string | undefined;

	constructor(surreal: Surreal, serverVersion?: string) {
		super(undefined);
		this.surreal = surreal;
		this._serverVersion = serverVersion;
	}

	get serverVersion(): string | undefined {
		return this._serverVersion;
	}

	/** @internal Used by ConnectionManager once the server version is detected. */
	setServerVersion(version: string | undefined): void {
		this._serverVersion = version;
	}

	protected async dispatch(
		sql: string,
		bindings?: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<readonly unknown[]> {
		// A signal that has already aborted sends nothing, and says why.
		signal?.throwIfAborted();
		try {
			const query = this.surreal.query(sql, bindings);
			return await (signal ? query.signal(signal) : query);
		} catch (err) {
			// The signal's own reason is the answer, whatever the SDK made of it.
			signal?.throwIfAborted();
			throw mapQueryError(err);
		}
	}

	protected async dispatchEach(
		sql: string,
		bindings?: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<readonly StatementOutcome[]> {
		signal?.throwIfAborted();
		try {
			const query = this.surreal.query(sql, bindings);
			return responseOutcomes(
				await (signal ? query.signal(signal) : query).responses(),
			);
		} catch (err) {
			signal?.throwIfAborted();
			// A failure here is the dispatch itself failing — a dropped connection, a
			// parse error in the whole query — rather than one statement of it, and
			// the caller cannot attribute that to a document.
			throw mapQueryError(err);
		}
	}

	/**
	 * Stream the rows of the statement at `frame`.
	 *
	 * `.stream()` and not `.rows()`, which flattens every statement into one run of
	 * rows: the `USE DB` a scoped statement carries answers with an object, and
	 * `.rows()` would hand it to the caller as the first document. Frames say which
	 * statement they belong to, so the wanted one is picked out by index.
	 *
	 * Against a server that cannot stream — anything before 3.3.0, or the HTTP
	 * engine — the SDK answers the same call buffered, so the rows arrive together
	 * and everything else here is unchanged.
	 */
	protected dispatchRows(
		sql: string,
		bindings: Record<string, unknown> | undefined,
		frame: number,
		signal?: AbortSignal,
	): AsyncIterableIterator<unknown> {
		return streamRows(
			(own) => {
				// The stream's own signal is what a consumer leaving aborts. The
				// caller's is added beside it rather than combined with it: the SDK
				// applies every signal it is given, which is `AbortSignal.any` without
				// needing a runtime that has it.
				const query = this.surreal.query(sql, bindings).signal(own);
				return (
					signal ? query.signal(signal) : query
				).stream() as AsyncIterable<StreamedFrame>;
			},
			frame,
			{
				// MongoDB has no limit on open cursors and the server has one on open
				// streams. A cursor over that limit is read whole instead: the server
				// refused it outright, so nothing ran and nothing runs twice.
				when: isStreamCapRefusal,
				rows: () =>
					bufferedRows(async () => {
						const frames = await this.dispatch(sql, bindings, signal);
						return (frames[frame] as unknown[] | undefined) ?? [];
					}),
			},
			signal,
		);
	}

	/**
	 * Open a SurrealDB transaction and return an executor scoped to it.
	 *
	 * The transaction is opened on the connection rather than on any one database:
	 * a session may touch several, and a statement in it says which as it goes out.
	 *
	 * The connection must already be up, because whether transactions are
	 * available is a property of the engine that was selected for it. The SDK
	 * answers that through `isFeatureSupported`, which covers both halves of the
	 * question — an engine without the capability (its HTTP engine has none) and a
	 * server too old to offer it — and is asked here rather than inferred from the
	 * URL scheme, so a caller supplying their own engine gets a truthful answer.
	 *
	 * The whole of it is translated, the capability question included: that
	 * question is put to the live connection, so a connection that has dropped
	 * since the caller's `startTransaction()` answers it by throwing, and the
	 * caller must see this driver's network error rather than the SDK's.
	 */
	async beginTransaction(): Promise<TransactionScope> {
		try {
			if (!this.surreal.isFeatureSupported(Features.Transactions)) {
				throw new MongoCompatibilityError(
					"Transactions are not available on this connection: the SurrealDB engine in use does not support them. A WebSocket connection to SurrealDB 3.0.0 or newer is required.",
				);
			}

			const transaction = await this.surreal.beginTransaction();
			return new TransactionExecutor(transaction, this._serverVersion);
		} catch (err) {
			throw mapQueryError(err);
		}
	}

	async close(): Promise<void> {
		await this.surreal.close();
	}
}
