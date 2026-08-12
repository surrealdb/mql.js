/** Default SurrealDB namespace when none is specified. */
export const DEFAULT_NAMESPACE = "default";

/**
 * The MongoDB release `buildInfo` reports compatibility with.
 *
 * This is a compatibility target, not a claim to be that server. It is reported
 * because the field has a defined meaning: `buildInfo.version` is *the MongoDB
 * version*, and clients feature-gate on it with a semantic-version comparison.
 * Putting SurrealDB's own `3.2.x` there would not be a truthful answer to that
 * question but an answer to a different one — read as MongoDB 3.2 it is below
 * the floor of every currently supported MongoDB driver (the `mongodb` package
 * this driver is validated against supports 4.2 upwards), so a client would
 * disable sessions, transactions and `$expr`, all of which work here.
 *
 * SurrealDB's real version is reported alongside it as `surrealdbVersion`, so
 * nothing is hidden — see `buildInfoReply` in `src/db/run-command.ts`.
 *
 * `8.0` is chosen because it is a current MongoDB major inside the supported
 * window, and because over-claiming degrades safely in this driver: every
 * feature it does not implement now raises a named, documented error at the call
 * that asked for it, whereas under-claiming makes a client quietly stop using
 * features that do work. The pair of fields is the frozen contract; the number
 * is a documented constant that may be raised as the parity suite is validated
 * against newer MongoDB releases.
 */
export const MONGODB_COMPATIBILITY_VERSION = "8.0.0";

/**
 * `MONGODB_COMPATIBILITY_VERSION` in the four-element form MongoDB reports,
 * where the fourth element is the release candidate number (`0` for a release).
 */
export const MONGODB_COMPATIBILITY_VERSION_ARRAY: readonly number[] = [
	8, 0, 0, 0,
];

/**
 * Database used when the connection string names none and no override is given.
 *
 * MongoDB's own default, so `new MongoClient(uri).db()` names a database here
 * exactly as it does there instead of failing.
 */
export const DEFAULT_DATABASE = "test";

/** Default SurrealDB RPC path. */
export const RPC_PATH = "/rpc";

/**
 * Port assumed when the connection string omits one, by resolved scheme.
 *
 * A plaintext endpoint gets SurrealDB's own default of 8000 rather than the
 * URL-standard 80, because `mongodb://localhost/mydb` means "the SurrealDB on
 * this machine". An encrypted one gets 443: TLS termination is what a hosted or
 * reverse-proxied deployment does, and those listen on the HTTPS port.
 */
export const DEFAULT_PORTS: Record<string, string> = {
	"ws:": "8000",
	"http:": "8000",
	"wss:": "443",
	"https:": "443",
};

/**
 * Time allowed for the connection to become ready, in milliseconds.
 *
 * Both of MongoDB's connect-phase budgets default to 30 seconds
 * (`connectTimeoutMS` and `serverSelectionTimeoutMS`), and this driver honours
 * both against the same single connect attempt.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** Time allowed to find a usable server, in milliseconds. MongoDB's default. */
export const DEFAULT_SERVER_SELECTION_TIMEOUT_MS = 30_000;
