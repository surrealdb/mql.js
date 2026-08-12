/**
 * Real-driver adapter implementing the `QueryExecutor` port on top of the
 * `surrealdb` SDK. All exception translation happens here so that callers
 * never see raw `surrealdb` errors.
 */

import { Features, type Surreal } from "surrealdb";
import { MongoCompatibilityError } from "../errors.ts";
import { ScopedExecutor } from "./database-scope.ts";
import { mapQueryError } from "./error-mapper.ts";
import type { TransactionScope } from "./transaction-executor.ts";
import { TransactionExecutor } from "./transaction-executor.ts";

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
	): Promise<readonly unknown[]> {
		try {
			return await this.surreal.query(sql, bindings);
		} catch (err) {
			throw mapQueryError(err);
		}
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
