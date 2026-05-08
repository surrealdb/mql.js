/**
 * Real-driver adapter implementing the `QueryExecutor` port on top of the
 * `surrealdb` SDK. All exception translation happens here so that callers
 * never see raw `surrealdb` errors.
 */

import { type RecordId, type Surreal, Table } from "surrealdb";
import type { Document } from "../types.ts";
import { mapQueryError } from "./error-mapper.ts";
import type { QueryExecutor, RecordIdLike } from "./query-executor.ts";

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

	async createRecord(recordId: RecordIdLike, content: Document): Promise<void> {
		try {
			await this.surreal.create(recordId as RecordId).content(content);
		} catch (err) {
			throw mapQueryError(err);
		}
	}

	async insertMany(table: Table | string, docs: Document[]): Promise<void> {
		const tableRef = table instanceof Table ? table : new Table(table);
		try {
			await this.surreal.insert<Document>(tableRef, docs);
		} catch (err) {
			throw mapQueryError(err);
		}
	}

	async close(): Promise<void> {
		await this.surreal.close();
	}
}
