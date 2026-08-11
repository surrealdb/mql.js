/**
 * The single policy every client option passes through.
 *
 * `MongoClientOptions` and the connection string's query parameters are two
 * spellings of the same settings, so they are classified once, together: a
 * string's `?w=0` and a constructor's `{ writeConcern: { w: 0 } }` must not
 * disagree about whether the write is acknowledged. Query values are coerced to
 * the types the options object uses, merged under it, and the merged result is
 * what the gate reads.
 *
 * Each option is honoured, accepted with no effect, or rejected, on the same
 * terms as the per-operation options in `src/collection/operation-options.ts`:
 *
 *   - **honoured** — `tls`/`ssl` select `wss`/`https`, `connectTimeoutMS` and
 *     `serverSelectionTimeoutMS` bound the connect, `timeoutMS` and
 *     `ignoreUndefined` become defaults for every operation, `auth` and
 *     `authSource` decide which SurrealDB user is signed in, and `namespace`,
 *     `database` and `reconnect` are this driver's own settings;
 *   - **accepted, no effect** — settings describing a replica set, a connection
 *     pool, a monitor or a wire format, none of which can change what a caller
 *     reads or whether a write survives;
 *   - **rejected** — everything whose absence would change durability,
 *     confidentiality, the identity of the `_id`s written, or the fact that an
 *     operation cannot hang forever.
 *
 * Unknown keys are treated differently on the two paths, deliberately. A query
 * parameter is hand-written with no type checker in front of it, so `?tls=ture`
 * is a typo that must be caught, and MongoDB rejects it too. An options *object*
 * is usually computed by a wrapper — mongoose and friends attach their own
 * bookkeeping — so an unrecognised property is tolerated there rather than
 * turned into a startup failure.
 */

import {
	MAX_TIMEOUT_MS,
	readConcernLevel,
	writeConcernError,
	writeConcernRejection,
} from "../collection/operation-options.ts";
import {
	DEFAULT_CONNECT_TIMEOUT_MS,
	DEFAULT_SERVER_SELECTION_TIMEOUT_MS,
} from "../constants.ts";
import {
	MongoCompatibilityError,
	MongoErrorCode,
	MongoInvalidArgumentError,
	MongoParseError,
	MongoServerError,
} from "../errors.ts";
import type {
	Auth,
	MongoClientOptions,
	ReconnectSettings,
	TagSet,
	WriteConcernSettings,
} from "../types.ts";

/** Read an option the static type does not necessarily declare. */
function optionValue(options: MongoClientOptions, name: string): unknown {
	return (options as Record<string, unknown>)[name];
}

// ---------------------------------------------------------------------------
// Connection-string parameters
// ---------------------------------------------------------------------------

/**
 * How a query parameter's string is read.
 *
 * Every known parameter declares one, which is also what makes an unknown
 * parameter recognisable: MongoDB's URI grammar carries no type information, so
 * the option's name is the only thing that says how to read its value.
 */
type ValueKind =
	| "boolean"
	| "int"
	| "string"
	| "csv"
	| "tags"
	| "keyValue"
	| "w"
	| "forbidden";

/**
 * The parameters a connection string may carry, and how each is read.
 *
 * Names are matched case-insensitively, as MongoDB matches them. `namespace` is
 * this driver's own addition — SurrealDB needs a namespace and a MongoDB URI has
 * nowhere else to put one — and the official driver rejects it, which is why a
 * `?namespace=` string is not portable back to MongoDB.
 */
const URI_PARAMETERS: Readonly<Record<string, ValueKind>> = {
	namespace: "string",
	reconnect: "boolean",

	tls: "boolean",
	ssl: "boolean",
	connectTimeoutMS: "int",
	socketTimeoutMS: "int",
	serverSelectionTimeoutMS: "int",
	timeoutMS: "int",
	heartbeatFrequencyMS: "int",
	minHeartbeatFrequencyMS: "int",
	localThresholdMS: "int",
	noDelay: "boolean",

	tlsCertificateKeyFile: "string",
	tlsCertificateKeyFilePassword: "string",
	tlsCAFile: "string",
	tlsCRLFile: "string",
	tlsAllowInvalidCertificates: "boolean",
	tlsAllowInvalidHostnames: "boolean",
	tlsInsecure: "boolean",

	proxyHost: "string",
	proxyPort: "int",
	proxyUsername: "string",
	proxyPassword: "string",

	compressors: "csv",
	zlibCompressionLevel: "int",

	authSource: "string",
	authMechanism: "string",
	authMechanismProperties: "keyValue",

	replicaSet: "string",
	directConnection: "boolean",
	loadBalanced: "boolean",
	srvMaxHosts: "int",
	srvServiceName: "string",
	serverMonitoringMode: "string",

	maxPoolSize: "int",
	minPoolSize: "int",
	maxConnecting: "int",
	maxIdleTimeMS: "int",
	waitQueueTimeoutMS: "int",

	readConcernLevel: "string",
	readPreference: "string",
	maxStalenessSeconds: "int",
	readPreferenceTags: "tags",
	w: "w",
	wtimeoutMS: "int",
	journal: "boolean",

	retryReads: "boolean",
	retryWrites: "boolean",
	maxAdaptiveRetries: "int",
	enableOverloadRetargeting: "boolean",

	appName: "string",
	monitorCommands: "boolean",
	mongodbLogPath: "string",
	mongodbLogMaxDocumentLength: "int",

	// Rejected outright by MongoDB in a URI, in these words, because the value is
	// a structure the query grammar cannot express.
	serverApi: "forbidden",
};

/** Canonical spelling for each lower-cased parameter name. */
const CANONICAL_NAMES: ReadonlyMap<string, string> = new Map(
	Object.keys(URI_PARAMETERS).map((name) => [name.toLowerCase(), name]),
);

/** Parameters that may legitimately appear more than once. */
const REPEATABLE = new Set(["readPreferenceTags"]);

/**
 * Read a connection string's query parameters as client options.
 *
 * Coercion failures are MongoDB's, in MongoDB's words: a caller who mistypes
 * `?maxPoolSize=abc` should recognise the error from the official driver.
 */
export function parseUriOptions(query: string): MongoClientOptions {
	const options: Record<string, unknown> = {};
	const seen = new Set<string>();

	for (const [rawName, rawValue] of new URLSearchParams(query)) {
		const name = CANONICAL_NAMES.get(rawName.toLowerCase());
		if (!name) {
			throw new MongoParseError(
				`option ${rawName.toLowerCase()} is not supported`,
			);
		}

		if (seen.has(name) && !REPEATABLE.has(name)) {
			throw new MongoInvalidArgumentError(
				`URI option "${name}" cannot appear more than once in the connection string`,
			);
		}
		seen.add(name);

		const kind = URI_PARAMETERS[name] as ValueKind;
		if (kind === "forbidden") {
			throw new MongoParseError(
				`URI cannot contain \`${name}\`, it can only be passed to the client`,
			);
		}

		if (kind === "tags") {
			const tags = (options[name] as TagSet[] | undefined) ?? [];
			tags.push(readKeyValue(name, rawValue));
			options[name] = tags;
			continue;
		}

		options[name] = readValue(name, kind, rawValue);
	}

	return options as MongoClientOptions;
}

/** Coerce one parameter's string to the type its option is declared with. */
function readValue(name: string, kind: ValueKind, raw: string): unknown {
	switch (kind) {
		case "boolean":
			if (raw === "true") return true;
			if (raw === "false") return false;
			throw new MongoParseError(`${name} must be either "true" or "false"`);
		case "int":
			return readInt(name, raw);
		case "csv":
			return raw.split(",");
		case "keyValue":
			return readKeyValue(name, raw);
		case "w":
			// `w` is the one parameter whose value is a number or a name, which is
			// why MongoDB's own `W` type is `number | 'majority'`.
			return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : raw;
		default:
			return raw;
	}
}

/** A non-negative integer parameter, refused the way MongoDB refuses one. */
function readInt(name: string, raw: string): number {
	if (!/^-?\d+$/.test(raw)) {
		throw new MongoParseError(
			`Expected ${name} to be stringified int value, got: ${raw}`,
		);
	}
	const value = Number.parseInt(raw, 10);
	if (value < 0) {
		throw new MongoParseError(
			`${name} can only be a positive int value, got: ${raw}`,
		);
	}
	return value;
}

/** MongoDB's `key:value,key:value` parameter form. */
function readKeyValue(name: string, raw: string): TagSet {
	const result: TagSet = {};
	for (const pair of raw.split(",")) {
		if (pair === "") continue;
		const separator = pair.indexOf(":");
		if (separator < 1) {
			throw new MongoParseError(
				`${name} must be a comma-separated list of colon-separated key-value pairs, got: ${raw}`,
			);
		}
		result[pair.slice(0, separator)] = pair.slice(separator + 1);
	}
	return result;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/*
 * Options accepted and then ignored, and why each is inert. None can change what
 * a caller reads, whether a write survives, or who is authenticated — which is
 * what separates them from the rejected options below.
 *
 *   - `replicaSet`, `directConnection`, `loadBalanced`, `heartbeatFrequencyMS`,
 *     `minHeartbeatFrequencyMS`, `serverMonitoringMode`, `localThresholdMS`:
 *     describe a topology of several servers and the monitoring that picks
 *     between them. There is one connection to one node, which is what
 *     `directConnection` asks for anyway.
 *   - `maxPoolSize`, `minPoolSize`, `maxConnecting`, `maxIdleTimeMS`,
 *     `waitQueueTimeoutMS`: the SurrealDB SDK multiplexes every operation over a
 *     single connection, so there is no pool to size and no queue to wait in.
 *   - `readPreference`, `maxStalenessSeconds`, `readPreferenceTags`: choose a
 *     replica-set member to read from. Reading from the only node is *stronger*
 *     than the secondary read any non-primary preference asks for.
 *   - `readConcern`/`readConcernLevel` of `local`, `majority` or `available`: on
 *     a single node these collapse into the same read. `linearizable` and
 *     `snapshot` do not, and are rejected below.
 *   - `writeConcern` (and the `w`/`journal`/`wtimeoutMS` aliases) other than
 *     `w: 0` and `w > 1`: this driver always waits for SurrealDB to acknowledge,
 *     which is at least what `w: 1`, `w: 'majority'`, `journal` and `wtimeoutMS`
 *     ask for on a one-node deployment.
 *   - `retryWrites`, `retryReads`, `maxAdaptiveRetries`,
 *     `enableOverloadRetargeting`: nothing is retried, so a failure is reported
 *     rather than hidden — the safe direction, and `false` is honoured exactly.
 *     `retryWrites=true` is in every Atlas string ever pasted, and refusing it
 *     would refuse the string rather than the promise.
 *   - `compressors`, `zlibCompressionLevel`, `noDelay`: transport tuning that
 *     cannot be observed in a result.
 *   - `authMechanism` of `DEFAULT`, `SCRAM-SHA-1`, `SCRAM-SHA-256` or `PLAIN`,
 *     and `authMechanismProperties`: all four describe how a username and
 *     password are exchanged, which SurrealDB's `signin` settles its own way.
 *     The mechanisms that replace the password are rejected below.
 *   - `appName`, `driverInfo`: identification for the server's log. SurrealDB's
 *     RPC handshake carries no client metadata to put them in.
 *   - `mongodbLogPath`, `mongodbLogComponentSeverities`,
 *     `mongodbLogMaxDocumentLength`: diagnostics. This driver emits no log, and a
 *     caller who asked for one notices its absence immediately.
 *   - `serverApi`: declares which version of MongoDB's *command* surface to hold
 *     the server to. This driver speaks SurrealQL and implements one fixed
 *     subset of the CRUD surface, so there is no second version to be held away
 *     from — and a method it does not implement is absent rather than silently
 *     wrong, which is what `strict` exists to guarantee.
 */

/** How a rejected option is recognised and refused. */
interface RejectionRule {
	readonly option: string;
	/** True when the caller's value is the request that cannot be served. */
	readonly applies: (value: unknown) => boolean;
	/** The error for a value `applies` matched. */
	readonly reject: (value: unknown) => Error;
}

/** Present at all — the common case, where any value is a request. */
const supplied = (value: unknown): boolean => value !== undefined;

/** Explicitly asked for — for options whose `false` is what this driver does. */
const enabled = (value: unknown): boolean => value === true;

/**
 * The default refusal: this driver cannot serve the option, and here is why.
 *
 * `MongoCompatibilityError` rather than a parse error, because the option parsed
 * fine and is valid MongoDB — it is this driver that cannot honour it.
 */
function unsupported(option: string, reason: string): () => Error {
	return () =>
		new MongoCompatibilityError(
			`Option '${option}' is not supported: ${reason}`,
		);
}

/**
 * TLS material and validation switches.
 *
 * The SDK connects with the platform's own WebSocket and `fetch`, whose trust
 * decisions are made by the runtime: there is no socket to hand a certificate,
 * a CA file or a "trust anything" flag to. Ignoring one would leave a caller
 * believing a private CA was loaded, or that an expired certificate would be
 * tolerated, when the connection will simply fail.
 */
const TLS_MATERIAL_OPTIONS = [
	"tlsCertificateKeyFile",
	"tlsCertificateKeyFilePassword",
	"tlsCAFile",
	"tlsCRLFile",
] as const;

/** Validation-relaxing switches, refused for the same reason, when asked for. */
const TLS_INSECURE_OPTIONS = [
	"tlsAllowInvalidCertificates",
	"tlsAllowInvalidHostnames",
	"tlsInsecure",
] as const;

/** SOCKS5 proxy settings, none of which the platform transport can apply. */
const PROXY_OPTIONS = [
	"proxyHost",
	"proxyPort",
	"proxyUsername",
	"proxyPassword",
] as const;

/** The BSON serialisation family, minus the one member that has a meaning here. */
const BSON_OPTIONS = [
	"raw",
	"promoteValues",
	"promoteLongs",
	"promoteBuffers",
	"useBigInt64",
	"bsonRegExp",
	"serializeFunctions",
	"checkKeys",
	"fieldsAsRaw",
	"enableUtf8Validation",
] as const;

/** Authentication mechanisms that exchange a username and a password. */
const PASSWORD_MECHANISMS = new Set([
	"DEFAULT",
	"SCRAM-SHA-1",
	"SCRAM-SHA-256",
	"PLAIN",
]);

/** Read-preference modes MongoDB defines, for validating a caller's value. */
const READ_PREFERENCE_MODES = new Set([
	"primary",
	"primaryPreferred",
	"secondary",
	"secondaryPreferred",
	"nearest",
]);

/** Compression algorithms MongoDB names, for validating a caller's value. */
const COMPRESSORS = new Set(["none", "snappy", "zlib", "zstd"]);

const REJECTED_OPTIONS: readonly RejectionRule[] = [
	{
		option: "socketTimeoutMS",
		// `0` is MongoDB's "no limit", and a limit is the only thing being asked for.
		applies: (value) => typeof value === "number" && value > 0,
		reject: unsupported(
			"socketTimeoutMS",
			"the SDK's transport exposes no per-socket inactivity limit, so a stalled operation would wait forever; use 'timeoutMS', which becomes a SurrealQL TIMEOUT on every operation",
		),
	},
	{
		option: "writeConcern",
		applies: (value) => writeConcernRejection(value) !== undefined,
		reject: writeConcernError,
	},
	{
		option: "readConcern",
		applies: (value) => isUnservableReadConcern(value),
		reject: readConcernError,
	},
	{
		option: "readConcernLevel",
		applies: (value) => isUnservableReadConcern(value),
		reject: readConcernError,
	},
	{
		option: "monitorCommands",
		applies: enabled,
		reject: unsupported(
			"monitorCommands",
			"this client emits no command-monitoring events, so the listeners the option exists to feed would never fire",
		),
	},
	{
		option: "pkFactory",
		applies: supplied,
		reject: unsupported(
			"pkFactory",
			"generated `_id`s would be ObjectIds from this driver rather than keys from the factory",
		),
	},
	{
		option: "forceServerObjectId",
		applies: enabled,
		reject: unsupported(
			"forceServerObjectId",
			"the id would be generated inside SurrealDB, leaving the reported `insertedId` with nothing truthful to say",
		),
	},
	{
		option: "autoEncryption",
		applies: supplied,
		reject: unsupported(
			"autoEncryption",
			"there is no client-side encryption layer here, so fields the caller expects to be encrypted would be written in the clear",
		),
	},
	{
		option: "authMechanism",
		applies: (value) =>
			typeof value === "string" && !PASSWORD_MECHANISMS.has(value),
		reject: (value) =>
			new MongoCompatibilityError(
				`Option 'authMechanism' is not supported: SurrealDB authenticates with a username and password, so '${String(value)}' cannot be performed`,
			),
	},
	{
		option: "srvMaxHosts",
		applies: supplied,
		reject: unsupported(
			"srvMaxHosts",
			"`mongodb+srv://` is rejected by this driver, so there is no SRV seedlist to limit",
		),
	},
	{
		option: "srvServiceName",
		applies: supplied,
		reject: unsupported(
			"srvServiceName",
			"`mongodb+srv://` is rejected by this driver, so no SRV record is ever queried",
		),
	},
	...TLS_MATERIAL_OPTIONS.map((option) => ({
		option,
		applies: supplied,
		reject: unsupported(
			option,
			"the connection is made with the platform's WebSocket and fetch implementations, which use the runtime's own trust store and accept no certificate material",
		),
	})),
	...TLS_INSECURE_OPTIONS.map((option) => ({
		option,
		applies: enabled,
		reject: unsupported(
			option,
			"certificate validation is performed by the platform's WebSocket and fetch implementations and cannot be relaxed, so the connection would fail rather than proceed insecurely",
		),
	})),
	...PROXY_OPTIONS.map((option) => ({
		option,
		applies: supplied,
		reject: unsupported(
			option,
			"the platform transport cannot be pointed at a SOCKS5 proxy, so the connection would be made directly to the server instead",
		),
	})),
	...BSON_OPTIONS.map((option) => ({
		option,
		applies: supplied,
		reject: unsupported(
			option,
			"this driver encodes CBOR and has no BSON layer, so no serialisation setting has anything to select",
		),
	})),
];

/** True for a read concern this driver cannot establish on one node. */
function isUnservableReadConcern(value: unknown): boolean {
	const level = readConcernLevel(value);
	return level === "linearizable" || level === "snapshot";
}

/** MongoDB's own refusal for a read concern that needs a replica set. */
function readConcernError(value: unknown): Error {
	return new MongoServerError(
		`node needs to be a replica set member to use readConcern: ${readConcernLevel(value)}`,
		{ code: MongoErrorCode.NotAReplicaSet },
	);
}

/**
 * Reject every client option this driver cannot honour, before connecting.
 *
 * Reads the merged options object rather than the fields it declares: a computed
 * `MongoClientOptions` can carry anything, and TypeScript's excess-property
 * check only ever applied to object literals.
 */
export function assertSupportedClientOptions(
	options: MongoClientOptions,
): void {
	for (const rule of REJECTED_OPTIONS) {
		const value = optionValue(options, rule.option);
		if (rule.applies(value)) throw rule.reject(value);
	}

	// The deprecated aliases are a write concern spelled differently, so they are
	// classified as one rather than slipping past the rule above.
	const aliased = writeConcernAliases(options);
	if (aliased && writeConcernRejection(aliased) !== undefined) {
		throw writeConcernError(aliased);
	}

	assertValidValues(options);
}

/** `w`/`wtimeoutMS`/`journal` as the write concern they stand for. */
function writeConcernAliases(
	options: MongoClientOptions,
): WriteConcernSettings | undefined {
	const { w, wtimeoutMS, journal } = options;
	if (w === undefined && wtimeoutMS === undefined && journal === undefined) {
		return undefined;
	}
	return { w, wtimeoutMS, journal };
}

/**
 * Refuse values that are not valid MongoDB, as MongoDB refuses them.
 *
 * Separate from the rejection rules above: these are not options this driver
 * cannot serve, they are values no driver would accept, and a caller who
 * mistypes a read-preference mode is better off learning it here than having the
 * option silently ignored.
 */
function assertValidValues(options: MongoClientOptions): void {
	assertValidTimeout(options.timeoutMS);

	const mode = readPreferenceMode(options.readPreference);
	if (mode !== undefined && !READ_PREFERENCE_MODES.has(mode)) {
		throw new MongoInvalidArgumentError(
			`Invalid read preference mode "${mode}"`,
		);
	}

	for (const name of compressorNames(options.compressors)) {
		if (!COMPRESSORS.has(name)) {
			throw new MongoInvalidArgumentError(
				`${name} is not a valid compression mechanism. Must be one of: ${[...COMPRESSORS].join(",")}.`,
			);
		}
	}
}

/**
 * Hold a client-wide `timeoutMS` to the range a `TIMEOUT` clause can carry.
 *
 * The connection string's parser already refuses a non-integer, but the
 * constructor's object reaches here uninspected, and this value is rendered into
 * every statement: a fraction or an exponent would surface as a SurrealQL parse
 * error naming a token the caller never wrote.
 */
function assertValidTimeout(timeoutMS: number | undefined): void {
	if (timeoutMS === undefined) return;

	if (!Number.isInteger(timeoutMS) || timeoutMS < 0) {
		throw new MongoInvalidArgumentError(
			`timeoutMS can only be a positive int value, got: ${timeoutMS}`,
		);
	}
	if (timeoutMS > MAX_TIMEOUT_MS) {
		throw new MongoInvalidArgumentError(
			`BSON field 'timeoutMS' value must be <= ${MAX_TIMEOUT_MS}, actual value '${timeoutMS}'`,
		);
	}
}

/** The `mode` of a read preference given in either of MongoDB's two shapes. */
function readPreferenceMode(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "object" && value !== null) {
		const mode = (value as { mode?: unknown }).mode;
		if (typeof mode === "string") return mode;
	}
	return undefined;
}

/** A `compressors` value as the list of names it denotes. */
function compressorNames(value: unknown): string[] {
	if (typeof value === "string") return value.split(",");
	if (Array.isArray(value)) return value.map(String);
	return [];
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** The honoured options, resolved, alongside everything the caller asked for. */
export interface ClientSettings {
	/** Merged view of every option, for `MongoClient.options`. */
	readonly options: MongoClientOptions;
	/** Whether the connection must be encrypted, when the caller said. */
	readonly tls?: boolean;
	/** Connect budget in milliseconds; `0` means no limit. */
	readonly connectTimeoutMS: number;
	/** Server-selection budget in milliseconds; `0` means no limit. */
	readonly serverSelectionTimeoutMS: number;
	/** Default per-operation time budget, when the caller set one. */
	readonly timeoutMS?: number;
	/** Whether `undefined` properties are dropped rather than stored as `null`. */
	readonly ignoreUndefined: boolean;
	/** Credentials, when either the string or the options object carried them. */
	readonly auth?: Auth;
	/** Which SurrealDB user level to sign in at. */
	readonly authSource?: string;
	/** Reconnect behaviour for the WebSocket engine. */
	readonly reconnect: boolean | ReconnectSettings;
}

/**
 * Merge the two sources of client options, classify them, and resolve the ones
 * this driver honours.
 *
 * The constructor's object wins over the connection string, as it does in the
 * official driver: the string is usually configuration and the object usually
 * code, and code is the more specific statement of intent.
 */
export function resolveClientSettings(
	fromUri: MongoClientOptions,
	explicit: MongoClientOptions | undefined,
): ClientSettings {
	const options: MongoClientOptions = { ...fromUri, ...defined(explicit) };

	assertSupportedClientOptions(options);

	return {
		options: Object.freeze(options),
		tls: resolveTls(options),
		connectTimeoutMS: options.connectTimeoutMS ?? DEFAULT_CONNECT_TIMEOUT_MS,
		serverSelectionTimeoutMS:
			options.serverSelectionTimeoutMS ?? DEFAULT_SERVER_SELECTION_TIMEOUT_MS,
		timeoutMS: options.timeoutMS,
		ignoreUndefined: options.ignoreUndefined === true,
		auth: options.auth,
		authSource: options.authSource,
		// Fail fast by default: without this, a connection lost mid-operation is
		// retried in the background while the caller's promise sits unresolved.
		reconnect: options.reconnect ?? false,
	};
}

/**
 * Drop `undefined` properties so an explicitly-absent option does not shadow
 * the connection string's value.
 *
 * A computed options object routinely carries `{ tls: undefined }`, and spreading
 * that over a string's `?tls=true` would silently turn the encryption off.
 */
function defined(options: MongoClientOptions | undefined): MongoClientOptions {
	if (!options) return {};
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(options)) {
		if (value !== undefined) result[key] = value;
	}
	return result as MongoClientOptions;
}

/**
 * Whether the caller asked for encryption, from `tls` and its `ssl` alias.
 *
 * MongoDB requires the two to agree, in these words, because a string that says
 * both `tls=true` and `ssl=false` has no defensible reading.
 */
function resolveTls(options: MongoClientOptions): boolean | undefined {
	const { tls, ssl } = options;
	if (tls !== undefined && ssl !== undefined && tls !== ssl) {
		throw new MongoParseError("All values of tls/ssl must be the same.");
	}
	return tls ?? ssl;
}
