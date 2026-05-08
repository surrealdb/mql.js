/**
 * Connection lifecycle helper for `MongoClient`.
 *
 * Encapsulates the SurrealDB-version 2.0.3 work-around where
 * `Surreal.connect()` can hang forever when the engine surface emits an
 * `error`/`disconnected` event without surfacing it on the connect
 * promise. We race the connect promise against those events so the
 * caller always fails fast.
 *
 * Also performs the post-connect server-version probe so the rest of
 * the codebase can choose the right SurrealDB dialect.
 */

import type { ConnectOptions, Surreal } from "surrealdb";
import { MongoNetworkError } from "../errors.ts";
import { mapConnectError } from "../surreal/error-mapper.ts";

export interface ConnectArgs {
	url: string;
	options: ConnectOptions;
}

export class ConnectionManager {
	constructor(private readonly surreal: Surreal) {}

	/** Connect with the fail-fast race; returns nothing on success. */
	async connect({ url, options }: ConnectArgs): Promise<void> {
		let connectSettled = false;
		let capturedError: Error | undefined;

		const unsubError = this.surreal.subscribe("error", (err) => {
			capturedError ??= err instanceof Error ? err : new Error(String(err));
		});

		const guard = new Promise<never>((_, reject) => {
			const unsubDisconnected = this.surreal.subscribe("disconnected", () => {
				if (connectSettled) return;
				reject(
					capturedError ??
						new MongoNetworkError(
							"Failed to connect to SurrealDB: connection closed before becoming ready",
						),
				);
				unsubDisconnected();
			});
		});

		try {
			await Promise.race([
				this.surreal.connect(url, options).then(() => {
					connectSettled = true;
				}),
				guard,
			]);
		} catch (err) {
			throw mapConnectError(err);
		} finally {
			unsubError();
		}
	}

	/**
	 * Probe the connected server's version. A failure here intentionally
	 * resolves to `undefined` – translators fall back to the latest
	 * known dialect when the version is unknown.
	 */
	async detectServerVersion(): Promise<string | undefined> {
		try {
			const info = await this.surreal.version();
			const match = info.version.match(/(\d+\.\d+\.\d+)/);
			return match?.[1];
		} catch {
			return undefined;
		}
	}
}
