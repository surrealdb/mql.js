/**
 * The executor every `Db` and `Collection` runs through.
 *
 * Its job is the connection precondition. `MongoClient.db()` may be called
 * before `connect()` — the official driver allows it, mongoose relies on it, and
 * a `Db` obtained that way must still work — so the connection is established on
 * the first statement instead of being demanded up front. Once the client has
 * been closed, the same statement fails with the error the official driver
 * raises rather than silently reopening a connection the caller ended.
 */

import { MongoNotConnectedError } from "../errors.ts";
import type { QueryExecutor } from "../surreal/query-executor.ts";

/** What the executor needs from the client that owns it. */
export interface ConnectionGate {
	/** Resolve once the connection is ready, connecting if it is not. */
	ensureConnected(): Promise<void>;
	/** True once `close()` has been called. */
	isClosed(): boolean;
}

export class ClientExecutor implements QueryExecutor {
	constructor(
		private readonly inner: QueryExecutor,
		private readonly gate: ConnectionGate,
	) {}

	get serverVersion(): string | undefined {
		return this.inner.serverVersion;
	}

	async query<T = unknown>(
		sql: string,
		bindings?: Record<string, unknown>,
	): Promise<T> {
		if (this.gate.isClosed()) {
			throw new MongoNotConnectedError(
				"Client must be connected before running operations",
			);
		}
		await this.gate.ensureConnected();
		return this.inner.query<T>(sql, bindings);
	}

	async close(): Promise<void> {
		await this.inner.close();
	}
}
