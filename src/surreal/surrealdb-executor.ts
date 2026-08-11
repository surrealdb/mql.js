/**
 * Real-driver adapter implementing the `QueryExecutor` port on top of the
 * `surrealdb` SDK. All exception translation happens here so that callers
 * never see raw `surrealdb` errors.
 */

import type { Surreal } from "surrealdb";
import { mapQueryError } from "./error-mapper.ts";
import type { QueryExecutor } from "./query-executor.ts";

export class SurrealdbExecutor implements QueryExecutor {
	private readonly surreal: Surreal;
	private _serverVersion: string | undefined;

	constructor(surreal: Surreal, serverVersion?: string) {
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

	async query<T = unknown>(
		sql: string,
		bindings?: Record<string, unknown>,
	): Promise<T> {
		try {
			const results = await this.surreal.query<[T]>(sql, bindings);
			return results[0];
		} catch (err) {
			throw mapQueryError(err);
		}
	}

	async close(): Promise<void> {
		await this.surreal.close();
	}
}
