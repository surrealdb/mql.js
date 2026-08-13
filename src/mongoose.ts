/**
 * A mongoose driver backed by `@surrealdb/mql`.
 *
 * ```typescript
 * import mongoose from "mongoose";
 * import { mqlDriver } from "@surrealdb/mql/mongoose";
 *
 * mongoose.setDriver(mqlDriver(mongoose));
 * await mongoose.connect("mongodb://root:root@127.0.0.1:8000/app?namespace=app");
 * ```
 *
 * `mongoose.setDriver()` is mongoose's supported extension point for exactly
 * this, and it is what makes the connection work — not, as it first appears, the
 * `client instanceof mongodb.MongoClient` check in `setClient()`. That check
 * exists, but `mongoose.connect()` never reaches it: `Connection.openUri` calls
 * `createClient()`, which the base `Connection` leaves abstract ("not implemented
 * by driver") and the bundled driver implements by hardcoding
 * `new mongodb.MongoClient(uri, options)`. Overriding `createClient` sidesteps
 * the nominal check rather than defeating it, which is why nothing here patches
 * mongodb or subclasses it.
 *
 * Everything except the connection is mongoose's own: `NativeCollection` forwards
 * method calls to whatever `conn.db.collection(name)` returns and type-checks
 * nothing, so this driver's `Collection` satisfies it structurally.
 *
 * `mongoose` is an optional peer dependency. This module is a separate entry
 * point (`@surrealdb/mql/mongoose`) so that importing the driver never pulls
 * mongoose in, and the browser bundle is untouched.
 */

import { MongoClient } from "./client/mongo-client.ts";
import { MongoCompatibilityError } from "./errors.ts";

/**
 * The shape of mongoose's bundled driver module, and of the `Connection` class
 * this extends.
 *
 * Typed structurally rather than against mongoose's own types: mongoose is an
 * optional peer, so its types may not be installed, and the driver path
 * (`mongoose/lib/drivers/node-mongodb-native`) is private and untyped in any
 * case.
 */
// biome-ignore lint/suspicious/noExplicitAny: mongoose's driver internals are untyped
type Any = any;

/** What `mongoose.setDriver()` accepts. */
export interface MqlMongooseDriver {
	Connection: Any;
	Collection: Any;
	[key: string]: Any;
}

/**
 * The part of the `mongoose` export this needs.
 *
 * Taken from the caller's own mongoose rather than resolved here: it is the
 * instance whose `setDriver` is about to be called, so it is the one whose base
 * classes must be extended. It also means this module imports nothing from
 * mongoose — no private path, no module resolution, nothing for a bundler to
 * follow — and works the same under Node, Bun and a bundler.
 *
 * `mongoose.Connection` and `mongoose.Collection` are the bundled driver's own
 * classes: verified identical to `mongoose/lib/drivers/node-mongodb-native`'s
 * exports by reference.
 */
export interface MqlMongooseLike {
	readonly Connection: Any;
	readonly Collection: Any;
	readonly mongo?: Any;
}

/**
 * Build the driver object to hand to `mongoose.setDriver()`.
 */
export function mqlDriver(mongoose: MqlMongooseLike): MqlMongooseDriver {
	const native = mongoose;

	class MqlConnection extends (native.Connection as Any) {
		/**
		 * Open the connection mongoose is asking for, using this driver's client.
		 *
		 * This is the whole of the integration. The bookkeeping below is what
		 * mongoose's own `_setClient` does — it is module-private, so it has to be
		 * transcribed rather than called — and `onOpen()` is the part that matters:
		 * it moves `readyState` to connected, flushes operations buffered before the
		 * connection was up, and emits `open` on the connection.
		 */
		async createClient(uri: string, connectOptions?: Any): Promise<Any> {
			const settings = connectOptions ?? {};
			const dbName = settings.dbName;
			if (dbName != null) this.$dbName = dbName;

			this._connectionOptions = settings;
			this._connectionString = uri;
			this.readyState = 2; // connecting

			const client = new MongoClient(uri);
			this.client = client;
			// mongoose's own connect path does this; the emitter here is unbounded
			// anyway, so it is accepted and ignored.
			client.setMaxListeners(0);

			await client.connect();

			this.db = dbName != null ? client.db(dbName) : client.db();
			this.name = this.db.databaseName;
			this._closeCalled = false;
			// Read by mongoose's staleness check. There is no heartbeat monitor here
			// and no `serverHeartbeatSucceeded` to update it, so it stays null —
			// which is what keeps `readyState` pinned at connected rather than
			// flipping to disconnected after a heartbeat interval elapses.
			this._lastHeartbeatAt = null;

			this.onOpen();
			return this;
		}

		/**
		 * Adopt a client the caller connected themselves.
		 *
		 * The gate is against *this* driver's `MongoClient`, which is the check the
		 * bundled driver makes against mongodb's. Nothing here references mongodb.
		 */
		setClient(client: Any): Any {
			if (!(client instanceof MongoClient)) {
				throw new MongoCompatibilityError(
					"setClient() expects a MongoClient from @surrealdb/mql. Pass one from this package, or use mongoose.connect() with mongoose.setDriver(mqlDriver()).",
				);
			}
			if (this.readyState !== 0) {
				throw new MongoCompatibilityError(
					"Cannot call setClient() on a connection that is already connected.",
				);
			}

			this.client = client;
			this.db = this.$dbName != null ? client.db(this.$dbName) : client.db();
			this.name = this.db.databaseName;
			this._closeCalled = false;
			this._lastHeartbeatAt = null;

			this.onOpen();
			return this;
		}
	}

	// `Collection` is mongoose's own and is reused as-is: it forwards method calls
	// to whatever `conn.db.collection(name)` returns and type-checks nothing, so
	// this driver's `Collection` satisfies it structurally. `BulkWriteResult` and
	// `ClientEncryption` are only reached by features this driver refuses, so they
	// are passed through when present rather than reimplemented.
	return {
		...(native.mongo ? { BulkWriteResult: native.mongo.BulkWriteResult } : {}),
		Collection: native.Collection,
		Connection: MqlConnection,
	};
}
