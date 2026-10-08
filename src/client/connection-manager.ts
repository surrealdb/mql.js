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
import {
	MongoCompatibilityError,
	MongoNetworkError,
	MongoNetworkTimeoutError,
	MongoServerSelectionError,
} from "../errors.ts";
import { mapConnectError } from "../surreal/error-mapper.ts";
import { escapeIdentifier } from "../surreal/sql/escape.ts";

export interface ConnectArgs {
	url: string;
	options: ConnectOptions;
	/** Milliseconds allowed for the connection to become ready; `0` for no limit. */
	connectTimeoutMS?: number;
	/** Milliseconds allowed to find a usable server; `0` for no limit. */
	serverSelectionTimeoutMS?: number;
}

/**
 * Refuse a `ws://` or `wss://` connection in a runtime with nothing to open it.
 *
 * The SDK opens its socket with `globalThis.WebSocket` and has no other source
 * for one here, and when that is missing it fails by throwing a `TypeError`
 * ("WebSocketImpl is not a constructor") from inside a loop nothing awaits — so
 * the caller's `connect()` never settles, or the process dies on an unhandled
 * rejection, depending on the runtime. Node has no global `WebSocket` before 22;
 * 20.10 and later have one behind `--experimental-websocket`. Said here, up front,
 * in the caller's own call, it is a line to act on.
 *
 * `http://` and `https://` need none: they go through `fetch`.
 */
export function assertTransportAvailable(url: string): void {
	if (!/^wss?:/i.test(url)) return;
	if (typeof globalThis.WebSocket === "function") return;

	throw new MongoCompatibilityError(
		"This runtime has no global WebSocket, which ws:// and wss:// connections need. Node.js has one from version 22, and on 20.10 and later behind `node --experimental-websocket`. Upgrade, pass that flag, or connect over http:// or https:// instead — which needs none, but has no sessions, no transactions and no query streaming.",
	);
}

/** A connect budget that expired, and the error it is reported as. */
interface Budget {
	readonly limitMS: number;
	readonly error: () => Error;
}

export class ConnectionManager {
	constructor(private readonly surreal: Surreal) {}

	/** Connect with the fail-fast race; returns nothing on success. */
	async connect({
		url,
		options,
		connectTimeoutMS,
		serverSelectionTimeoutMS,
	}: ConnectArgs): Promise<void> {
		// Before the SDK is touched, and outside the `try` below so that it is
		// reported as what it is rather than mapped as a connection failure.
		assertTransportAvailable(url);

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

		const budget = tightestBudget(connectTimeoutMS, serverSelectionTimeoutMS);
		const timer = new Timer();

		try {
			await Promise.race([
				this.surreal.connect(url, options).then(() => {
					connectSettled = true;
				}),
				guard,
				...(budget ? [timer.expire(budget)] : []),
			]);
		} catch (err) {
			// The SDK's `connect()` cannot be cancelled, so an expired budget leaves
			// an attempt running: close it rather than leave a socket opening behind
			// a promise nobody is waiting on any more.
			if (!connectSettled) await this.surreal.close().catch(() => {});
			throw mapConnectError(err);
		} finally {
			timer.cancel();
			unsubError();
		}
	}

	/**
	 * Best-effort creation of the target namespace and database so a freshly
	 * pointed connection behaves like MongoDB, which creates a database (and
	 * collection) implicitly on first write. Newer SurrealDB versions no
	 * longer auto-create them, so without this the first operation fails with
	 * `The namespace '<ns>' does not exist`.
	 *
	 * Any error — most commonly a non-root user that lacks `DEFINE` permission
	 * but is connecting to an already-existing namespace — is intentionally
	 * ignored: ensuring existence must never turn a usable connection into a
	 * failed one.
	 */
	async ensureNamespaceAndDatabase(
		namespace: string | undefined,
		database: string | undefined,
	): Promise<void> {
		const statements: string[] = [];
		if (namespace) {
			statements.push(
				`DEFINE NAMESPACE IF NOT EXISTS ${escapeIdentifier(namespace)}`,
			);
		}
		if (database) {
			statements.push(
				`DEFINE DATABASE IF NOT EXISTS ${escapeIdentifier(database)}`,
			);
		}
		if (statements.length === 0) return;

		try {
			// `.responses()` and not the awaited query. The awaited form throws at the
			// first statement that fails, and since SDK 2.1.0 a 3.3+ server also
			// cancels the statements behind it. These are independent and best-effort
			// — a user may be allowed to define a database but not the namespace it
			// lives in — so every one has to be sent whatever the one before did.
			await this.surreal.query(`${statements.join("; ")};`).responses();
		} catch {
			// Intentionally ignored — see the doc comment above.
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

/**
 * The connect budget that binds, of MongoDB's two.
 *
 * `connectTimeoutMS` bounds establishing a connection and
 * `serverSelectionTimeoutMS` bounds finding a server to establish it to. Against
 * a single named SurrealDB node those are the same wait, so the tighter one
 * decides — honouring only the larger would break the promise the smaller made.
 * `0` means "no limit" in MongoDB, so it takes no part.
 */
function tightestBudget(
	connectTimeoutMS: number | undefined,
	serverSelectionTimeoutMS: number | undefined,
): Budget | undefined {
	const budgets: Budget[] = [];

	if (connectTimeoutMS !== undefined && connectTimeoutMS > 0) {
		budgets.push({
			limitMS: connectTimeoutMS,
			error: () =>
				new MongoNetworkTimeoutError(
					`connection timed out after ${connectTimeoutMS} ms`,
				),
		});
	}
	if (serverSelectionTimeoutMS !== undefined && serverSelectionTimeoutMS > 0) {
		budgets.push({
			limitMS: serverSelectionTimeoutMS,
			error: () =>
				new MongoServerSelectionError(
					`Server selection timed out after ${serverSelectionTimeoutMS} ms`,
				),
		});
	}

	return budgets.sort((a, b) => a.limitMS - b.limitMS)[0];
}

/**
 * A cancellable delay.
 *
 * The handle has to be cleared on every exit: an outstanding timer keeps a Node
 * process alive well past the connect it was guarding.
 */
class Timer {
	private handle: ReturnType<typeof setTimeout> | undefined;

	expire(budget: Budget): Promise<never> {
		return new Promise<never>((_, reject) => {
			this.handle = setTimeout(() => reject(budget.error()), budget.limitMS);
		});
	}

	cancel(): void {
		if (this.handle !== undefined) clearTimeout(this.handle);
		this.handle = undefined;
	}
}
