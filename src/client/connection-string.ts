/**
 * MongoDB connection strings → SurrealDB connection details.
 *
 * The grammar is taken apart by hand rather than handed to `new URL()`, because
 * a MongoDB URI is not a URL in two ways that matter: its authority may list
 * several hosts separated by commas, which `URL` rejects outright, and its
 * userinfo is percent-encoded with rules of its own. `URL` also leaves userinfo
 * encoded, so a password like `p%40ss` would reach SurrealDB with the escape
 * intact and authentication would fail for every password containing `@`, `/`,
 * `:` or `%`.
 *
 * Accepted formats:
 *
 *     mongodb://[user:pass@]host[:port]/[database][?options]
 *     ws://…  wss://…  http://…  https://…    (SurrealDB URLs, same grammar)
 *
 * `mongodb+srv://` is refused: resolving a seedlist needs a DNS SRV lookup, which
 * this driver cannot perform in every runtime it supports (it ships a browser
 * bundle), and the host in such a string is a discovery name rather than a
 * server. Mapping it to `wss://<host>/rpc` — which is what this driver used to
 * do — produces a URL that cannot connect while looking as though it should.
 */

import {
	DEFAULT_DATABASE,
	DEFAULT_NAMESPACE,
	DEFAULT_PORTS,
	RPC_PATH,
} from "../constants.ts";
import { MongoCompatibilityError, MongoParseError } from "../errors.ts";
import type { MongoClientOptions } from "../types.ts";
import type { ClientSettings } from "./client-options.ts";
import { parseUriOptions, resolveClientSettings } from "./client-options.ts";

/**
 * Parsed connection information extracted from a MongoDB-style URL.
 */
export interface ParsedConnection {
	/** WebSocket or HTTP URL for SurrealDB (with /rpc path). */
	surrealUrl: string;
	/** Database name: from the URL path, the overrides, or MongoDB's `test`. */
	database: string;
	/** SurrealDB namespace. */
	namespace: string;
	/** Username from the URL userinfo section, percent-decoded. */
	username?: string;
	/** Password from the URL userinfo section, percent-decoded. */
	password?: string;
	/** Every client option, merged from the string and the constructor. */
	settings: ClientSettings;
}

/** Schemes this driver accepts, and the transport each one selects. */
const SCHEMES: Readonly<Record<string, string>> = {
	"mongodb:": "ws:",
	"ws:": "ws:",
	"wss:": "wss:",
	"http:": "http:",
	"https:": "https:",
};

/** Schemes whose transport is already encrypted. */
const SECURE_SCHEMES: Readonly<Record<string, string>> = {
	"ws:": "wss:",
	"http:": "https:",
};

/**
 * Characters MongoDB requires to be percent-encoded inside userinfo.
 *
 * Left raw they are ambiguous: a `:` would split the password a second time and
 * a `/` would end the authority early, so the value that reached SurrealDB would
 * not be the one the caller wrote.
 */
const UNESCAPED_USERINFO = /[:/?#[\]@]/;

/**
 * Parse a MongoDB-style connection string into SurrealDB connection details.
 *
 * @param url       - the connection string.
 * @param overrides - options from the `MongoClient` constructor, which win over
 *                    anything the string says.
 */
export function parseConnectionString(
	url: string,
	overrides?: MongoClientOptions,
): ParsedConnection {
	const { scheme, authority, path, query } = split(url);
	const transport = resolveScheme(scheme);

	const { userinfo, hosts } = splitAuthority(authority);
	const credentials = parseUserinfo(userinfo);

	const settings = resolveClientSettings(parseUriOptions(query), overrides);

	const protocol = applyTls(scheme, transport, settings.tls);
	const host = singleHost(hosts, url);

	return {
		surrealUrl: surrealUrlFor(protocol, withPort(host, protocol), url),
		// A MongoDB URI has one path segment and SurrealDB needs two names, so the
		// path is the database and the namespace comes from `?namespace=` or the
		// constructor. MongoDB rejects `?namespace=`, which makes such a string
		// this driver's own rather than a portable one.
		database: settings.options.database ?? decode(path) ?? DEFAULT_DATABASE,
		namespace: settings.options.namespace ?? DEFAULT_NAMESPACE,
		username: credentials.username,
		password: credentials.password,
		settings,
	};
}

/** The four regions of a connection string, still encoded. */
interface UriParts {
	scheme: string;
	authority: string;
	path: string;
	query: string;
}

/**
 * Cut the string into scheme, authority, path and query.
 *
 * Done positionally, in the order the grammar puts them, so a `?` inside the
 * path or a `/` inside the query cannot be mistaken for a delimiter.
 */
function split(url: string): UriParts {
	const schemeEnd = url.indexOf("://");
	if (schemeEnd < 1) {
		throw new MongoParseError(
			`Invalid connection string "${url}": expected it to start with "mongodb://", "ws://", "wss://", "http://" or "https://"`,
		);
	}

	const scheme = `${url.slice(0, schemeEnd).toLowerCase()}:`;
	const rest = url.slice(schemeEnd + 3);

	const queryStart = rest.indexOf("?");
	const beforeQuery = queryStart === -1 ? rest : rest.slice(0, queryStart);
	const query = queryStart === -1 ? "" : rest.slice(queryStart + 1);

	const pathStart = beforeQuery.indexOf("/");
	const authority =
		pathStart === -1 ? beforeQuery : beforeQuery.slice(0, pathStart);
	const path = pathStart === -1 ? "" : beforeQuery.slice(pathStart + 1);

	if (authority === "") {
		throw new MongoParseError("Protocol and host list are required in the uri");
	}

	return { scheme, authority, path: trimSlashes(path), query };
}

/** Reject the schemes this driver has no transport for. */
function resolveScheme(scheme: string): string {
	if (scheme === "mongodb+srv:") {
		throw new MongoCompatibilityError(
			"Connection strings using 'mongodb+srv://' are not supported: the host names an SRV record to resolve into a seedlist, and this driver has no DNS resolver in every runtime it targets. Use 'mongodb://host:port' (or 'wss://host'), naming the SurrealDB server directly.",
		);
	}

	const transport = SCHEMES[scheme];
	if (!transport) {
		throw new MongoParseError(
			`Invalid scheme "${scheme.slice(0, -1)}", expected connection string to start with "mongodb://", "ws://", "wss://", "http://" or "https://"`,
		);
	}
	return transport;
}

/** Separate the optional userinfo from the host list. */
function splitAuthority(authority: string): {
	userinfo?: string;
	hosts: string;
} {
	// The last `@` delimits, so a userinfo that legitimately encodes one as `%40`
	// is unaffected; a raw `@` is caught by `parseUserinfo`.
	const at = authority.lastIndexOf("@");
	if (at === -1) return { hosts: authority };

	const userinfo = authority.slice(0, at);
	if (userinfo === "") {
		throw new MongoParseError("URI contained empty userinfo section");
	}
	return { userinfo, hosts: authority.slice(at + 1) };
}

/**
 * Percent-decode the userinfo into credentials.
 *
 * Decoding is what the MongoDB URI specification requires and what every other
 * driver does: `p%40ssw%2Frd` is the password `p@ssw/rd`, and handing SurrealDB
 * the encoded form instead fails authentication with no indication why.
 */
function parseUserinfo(userinfo: string | undefined): {
	username?: string;
	password?: string;
} {
	if (userinfo === undefined) return {};

	const separator = userinfo.indexOf(":");
	const rawUsername =
		separator === -1 ? userinfo : userinfo.slice(0, separator);
	const rawPassword =
		separator === -1 ? undefined : userinfo.slice(separator + 1);

	if (rawUsername === "") {
		throw new MongoParseError("URI contained empty userinfo section");
	}
	if (UNESCAPED_USERINFO.test(rawUsername)) {
		throw new MongoParseError("Username contains unescaped characters");
	}
	if (rawPassword !== undefined && UNESCAPED_USERINFO.test(rawPassword)) {
		throw new MongoParseError("Password contains unescaped characters");
	}

	return {
		username: decodeComponent(rawUsername),
		// An empty password is still a password: `mongodb://user@host/db` means
		// "authenticate as `user`", and connecting anonymously instead would leave
		// the caller believing they were signed in as somebody.
		password:
			rawPassword === undefined ? undefined : decodeComponent(rawPassword),
	};
}

/**
 * The one host this driver connects to.
 *
 * A multi-host string asks for a replica set or a mongos pool: the driver is
 * expected to discover the members, follow elections and fail over. This driver
 * holds one connection to one SurrealDB node, so picking the first host and
 * saying nothing would leave the caller believing they had failover they do not
 * have.
 */
function singleHost(hosts: string, url: string): string {
	const listed = hosts.split(",").filter((host) => host !== "");
	if (listed.length === 0) {
		throw new MongoParseError("Protocol and host list are required in the uri");
	}
	if (listed.length > 1) {
		throw new MongoParseError(
			`Invalid connection string "${url}": ${listed.length} hosts were given, and this driver connects to a single SurrealDB server. Name one host; there is no replica-set discovery or failover to distribute across the rest.`,
		);
	}

	const host = listed[0] as string;
	assertValidHost(host, url);
	return host;
}

/** Reject a host that is not one `host[:port]`, before it reaches the SDK. */
function assertValidHost(host: string, url: string): void {
	const port = portOf(host);
	if (port !== undefined && !/^\d+$/.test(port)) {
		throw new MongoParseError(
			`Invalid connection string "${url}": port "${port}" is not a number`,
		);
	}
}

/** The port a host string carries, if any, IPv6 brackets accounted for. */
function portOf(host: string): string | undefined {
	const separator = host.lastIndexOf(":");
	if (separator === -1) return undefined;
	// `[::1]` has colons of its own; only one after the closing bracket is a port.
	if (host.startsWith("[") && separator < host.indexOf("]")) return undefined;
	return host.slice(separator + 1);
}

/**
 * Fill in the port when the string omits one.
 *
 * Without this, `mongodb://localhost/mydb` connects to port 80 — the URL
 * standard's default for `ws:` — rather than to the SurrealDB nobody is running
 * there.
 */
function withPort(host: string, protocol: string): string {
	if (portOf(host) !== undefined) return host;
	const port = DEFAULT_PORTS[protocol];
	return port === undefined ? host : `${host}:${port}`;
}

/**
 * Apply `tls`/`ssl` to the scheme's transport.
 *
 * MongoDB's schemes say nothing about encryption, so `?tls=true` is how a
 * `mongodb://` string reaches a TLS endpoint. SurrealDB's own schemes do say,
 * which makes `wss://…?tls=false` a contradiction rather than a preference.
 */
function applyTls(
	scheme: string,
	transport: string,
	tls: boolean | undefined,
): string {
	if (tls === undefined) return transport;

	if (tls) return SECURE_SCHEMES[transport] ?? transport;

	if (!(transport in SECURE_SCHEMES)) {
		throw new MongoParseError(
			`tls=false conflicts with the "${scheme.slice(0, -1)}://" connection string scheme, which is always encrypted`,
		);
	}
	return transport;
}

/**
 * The SurrealDB RPC URL for a host, checked before the SDK sees it.
 *
 * Anything left in the host that is not a hostname — a space, a stray bracket —
 * would otherwise surface from inside the SDK as a bare `TypeError` about an
 * invalid URL rather than as a connection-string error the caller can act on.
 */
function surrealUrlFor(protocol: string, host: string, url: string): string {
	const surrealUrl = `${protocol}//${host}${RPC_PATH}`;
	try {
		new URL(surrealUrl);
	} catch {
		throw new MongoParseError(`Invalid connection string "${url}"`);
	}
	return surrealUrl;
}

/** Strip the slashes around a path so `/mydb/` names `mydb`. */
function trimSlashes(path: string): string {
	return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** A percent-decoded path segment, or `undefined` when there was none. */
function decode(path: string): string | undefined {
	return path === "" ? undefined : decodeComponent(path);
}

/** Percent-decode, turning a malformed escape into MongoDB's own error. */
function decodeComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		throw new MongoParseError("URI malformed");
	}
}
