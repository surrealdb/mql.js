/** Default SurrealDB namespace when none is specified. */
export const DEFAULT_NAMESPACE = "default";

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
