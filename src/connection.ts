import { DEFAULT_NAMESPACE, RPC_PATH } from "./constants.ts";
import { MongoClientError } from "./errors.ts";

/**
 * Parsed connection information extracted from a MongoDB-style URL.
 */
export interface ParsedConnection {
	/** WebSocket or HTTP URL for SurrealDB (with /rpc path). */
	surrealUrl: string;
	/** Database name, if present in the URL path. */
	database?: string;
	/** SurrealDB namespace. */
	namespace: string;
	/** Username from the URL userinfo section. */
	username?: string;
	/** Password from the URL userinfo section. */
	password?: string;
}

const PROTOCOL_MAP: Record<string, string> = {
	"mongodb:": "ws:",
	"mongodb+srv:": "wss:",
	"ws:": "ws:",
	"wss:": "wss:",
	"http:": "http:",
	"https:": "https:",
};

/**
 * Parse a MongoDB-style connection string into SurrealDB connection details.
 *
 * Accepted formats:
 *   mongodb://host:port/dbname
 *   mongodb://user:pass@host:port/dbname?namespace=myns
 *   ws://host:port/dbname           (pass-through)
 *   http://host:port/dbname         (pass-through)
 */
export function parseConnectionString(
	url: string,
	overrides?: { namespace?: string; database?: string },
): ParsedConnection {
	// Replace mongodb:// with ws:// so the URL parser can handle it.
	let normalised = url;
	for (const [from, to] of Object.entries(PROTOCOL_MAP)) {
		if (normalised.startsWith(from)) {
			normalised = `${to}${normalised.slice(from.length)}`;
			break;
		}
	}

	let parsed: URL;
	try {
		parsed = new URL(normalised);
	} catch {
		throw new MongoClientError(`Invalid connection string: ${url}`);
	}

	const protocol = parsed.protocol; // "ws:" or "wss:" or "http:" / "https:"

	// Extract database from the URL path (e.g. /mydb)
	const pathDb =
		parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "") || undefined;

	// Namespace from query string or override
	const namespace =
		overrides?.namespace ??
		parsed.searchParams.get("namespace") ??
		DEFAULT_NAMESPACE;

	const database = overrides?.database ?? pathDb;

	// Build the SurrealDB URL: protocol://host:port/rpc
	const host = parsed.host; // includes port if present
	const surrealUrl = `${protocol}//${host}${RPC_PATH}`;

	return {
		surrealUrl,
		database,
		namespace,
		username: parsed.username || undefined,
		password: parsed.password || undefined,
	};
}
