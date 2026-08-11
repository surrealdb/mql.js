/**
 * Centralised error translation: anything thrown by the underlying SurrealDB
 * SDK (or by network/auth issues) is converted to the corresponding
 * MongoDB-shaped error class, with the numeric `code` a real MongoDB server
 * would have returned.
 *
 * The SDK exposes a structured taxonomy (`ServerError.kind`, `.details`,
 * `.code`, `.cause`), so most mappings key off the error class rather than its
 * message. Duplicate-key detection is the exception: SurrealDB reports a
 * unique-index violation as a generic `InternalError` whose only distinguishing
 * feature is its message, so that one case is matched by pattern. The
 * originating error is always preserved as `cause`.
 */

import {
	AlreadyExistsError,
	AuthenticationError,
	CallTerminatedError,
	ConnectionUnavailableError,
	HttpConnectionError,
	InternalError,
	MissingNamespaceDatabaseError,
	NotAllowedError,
	NotFoundError,
	ReconnectExhaustionError,
	ServerError,
	ThrownError,
	UnexpectedConnectionError,
	UnsupportedEngineError,
	UnsupportedFeatureError,
	UnsupportedVersionError,
	ValidationError,
} from "surrealdb";
import {
	MongoCompatibilityError,
	MongoError,
	MongoErrorCode,
	MongoNetworkError,
	MongoServerError,
	type WriteError,
} from "../errors.ts";

/** Normalise an unknown thrown value to a string message. */
function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Duplicate key
// ---------------------------------------------------------------------------

/**
 * SurrealDB's unique-index violation message. Verified against 3.x for single,
 * compound, numeric and dotted-path index fields:
 *
 *   Database index `email_1` already contains 'a@b.c', with record `users:abc`
 *   Database index `ab` already contains [1, 'x'], with record `c:abc`
 *   Database index `ni` already contains 42, with record `n:abc`
 */
const DUPLICATE_INDEX_PATTERN =
	/Database index `(?<index>[^`]+)` already contains (?<value>.+), with record `(?<record>[^`]+)`/s;

/** Assertion / type-coercion rejections, which MongoDB reports as code 121. */
const VALIDATION_PATTERNS = [
	/^Couldn't coerce value for field/,
	/but field must conform to:/,
	/^Found .* for field .*, with record/,
];

/** Parse a SurrealQL scalar literal (`'str'`, `42`, `true`, `NONE`). */
function parseScalar(literal: string): unknown {
	const text = literal.trim();
	if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
	if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
	if (text === "true") return true;
	if (text === "false") return false;
	if (text === "NONE" || text === "NULL") return null;
	const asNumber = Number(text);
	return Number.isNaN(asNumber) ? text : asNumber;
}

/**
 * Split a compound index value (`[1, 'x, y']`) into its elements, respecting
 * quoted segments so a comma inside a string is not treated as a separator.
 */
function parseValueList(literal: string): unknown[] {
	const inner = literal.trim().slice(1, -1);
	const parts: string[] = [];
	let current = "";
	let quote: string | undefined;

	for (const char of inner) {
		if (quote) {
			if (char === quote) quote = undefined;
			current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}
		if (char === ",") {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim() !== "") parts.push(current);

	return parts.map(parseScalar);
}

/**
 * Recover the indexed field names from an index name.
 *
 * Only works for the `field_1` / `field_-1` / `a_1_b_-1` convention this driver
 * generates itself (see `createIndex`). A caller-supplied `name` cannot be
 * decomposed, in which case `keyPattern` is omitted rather than guessed at.
 */
function fieldsFromIndexName(indexName: string): string[] | undefined {
	const tokens = indexName.split("_");
	const fields: string[] = [];
	let current: string[] = [];

	// Walk left to right accumulating name parts until a direction token closes
	// the field. This keeps underscores inside field names intact, so
	// `first_name_1` yields ["first_name"] and `a_1_b_-1` yields ["a", "b"].
	for (const token of tokens) {
		if (token === "1" || token === "-1") {
			if (current.length === 0) return undefined;
			fields.push(current.join("_"));
			current = [];
			continue;
		}
		current.push(token);
	}

	// A trailing remainder means the name does not follow the convention (a
	// caller-supplied name, or a non-btree suffix like `title_text`).
	if (current.length > 0 || fields.length === 0) return undefined;

	return fields;
}

export interface DuplicateKeyInfo {
	/** Name of the index that rejected the write. */
	indexName: string;
	/** Table (collection) the conflicting record belongs to. */
	collection: string | undefined;
	/** Values that collided. */
	values: unknown[];
	/** `{ field: 1 }` shape, when derivable from the index name. */
	keyPattern: Record<string, number> | undefined;
	/** `{ field: value }` shape, when derivable from the index name. */
	keyValue: Record<string, unknown> | undefined;
}

/**
 * Recognise a unique-index violation and pull the MongoDB-shaped detail out of
 * it. Returns `undefined` when `message` is not a duplicate-key error.
 */
export function parseDuplicateKeyError(
	message: string,
): DuplicateKeyInfo | undefined {
	const match = DUPLICATE_INDEX_PATTERN.exec(message);
	if (!match?.groups) return undefined;

	const indexName = match.groups.index as string;
	const rawValue = (match.groups.value as string).trim();
	const record = match.groups.record as string;

	const values = rawValue.startsWith("[")
		? parseValueList(rawValue)
		: [parseScalar(rawValue)];

	const collection = record.includes(":")
		? record.slice(0, record.indexOf(":"))
		: undefined;

	const fields = fieldsFromIndexName(indexName);
	let keyPattern: Record<string, number> | undefined;
	let keyValue: Record<string, unknown> | undefined;

	if (fields && fields.length === values.length) {
		keyPattern = {};
		keyValue = {};
		for (const [i, field] of fields.entries()) {
			keyPattern[field] = 1;
			keyValue[field] = values[i];
		}
	}

	return { indexName, collection, values, keyPattern, keyValue };
}

/** Render a duplicate key the way MongoDB renders it, for message parity. */
function formatDuplicateKeyMessage(info: DuplicateKeyInfo): string {
	const namespace = info.collection ? ` collection: ${info.collection}` : "";
	const dupKey = info.keyValue
		? Object.entries(info.keyValue)
				.map(([field, value]) => `${field}: ${JSON.stringify(value)}`)
				.join(", ")
		: info.values.map((value) => JSON.stringify(value)).join(", ");

	return `E11000 duplicate key error${namespace} index: ${info.indexName} dup key: { ${dupKey} }`;
}

/** Build the `MongoServerError` for a duplicate-key violation. */
export function duplicateKeyError(
	info: DuplicateKeyInfo,
	cause?: unknown,
): MongoServerError {
	return new MongoServerError(formatDuplicateKeyMessage(info), {
		code: MongoErrorCode.DuplicateKey,
		keyPattern: info.keyPattern,
		keyValue: info.keyValue,
		cause,
	});
}

/** The `writeErrors` entry MongoDB reports for a duplicate key. */
export function duplicateKeyWriteError(
	info: DuplicateKeyInfo,
	index: number,
): WriteError {
	return {
		index,
		code: MongoErrorCode.DuplicateKey,
		errmsg: formatDuplicateKeyMessage(info),
		...(info.keyPattern ? { keyPattern: info.keyPattern } : {}),
		...(info.keyValue ? { keyValue: info.keyValue } : {}),
	};
}

// ---------------------------------------------------------------------------
// Query errors
// ---------------------------------------------------------------------------

/** True when the SDK error represents a lost/unavailable connection. */
function isConnectionError(err: unknown): boolean {
	return (
		err instanceof ConnectionUnavailableError ||
		err instanceof HttpConnectionError ||
		err instanceof UnexpectedConnectionError ||
		err instanceof ReconnectExhaustionError ||
		err instanceof CallTerminatedError
	);
}

/** True when the SDK error means "this deployment cannot do that". */
function isCompatibilityError(err: unknown): boolean {
	return (
		err instanceof UnsupportedFeatureError ||
		err instanceof UnsupportedVersionError ||
		err instanceof UnsupportedEngineError
	);
}

/** A server error carrying the MongoDB code for this class of failure. */
function serverError(code: number) {
	return (message: string, cause: unknown): MongoError =>
		new MongoServerError(message, { code, cause });
}

/**
 * Ordered class-to-error mapping, consulted top to bottom.
 *
 * Expressed as data rather than a chain of `if`s so adding a SurrealDB error
 * kind is a one-line change and the whole mapping is readable at a glance.
 */
const QUERY_ERROR_RULES: ReadonlyArray<{
	matches: (err: unknown) => boolean;
	build: (message: string, cause: unknown) => MongoError;
}> = [
	{
		matches: isConnectionError,
		build: (message, cause) => new MongoNetworkError(message, { cause }),
	},
	{
		matches: isCompatibilityError,
		build: (message, cause) => new MongoCompatibilityError(message, { cause }),
	},
	{
		matches: (err) => err instanceof AuthenticationError,
		build: serverError(MongoErrorCode.AuthenticationFailed),
	},
	{
		matches: (err) => err instanceof NotAllowedError,
		build: serverError(MongoErrorCode.Unauthorized),
	},
	{
		matches: (err) =>
			err instanceof NotFoundError ||
			err instanceof MissingNamespaceDatabaseError,
		build: serverError(MongoErrorCode.NamespaceNotFound),
	},
	{
		matches: (err) => err instanceof AlreadyExistsError,
		build: serverError(MongoErrorCode.NamespaceExists),
	},
	{
		matches: (err) => err instanceof ValidationError,
		build: (message, cause) =>
			new MongoServerError(message, {
				code: message.startsWith("Parse error")
					? MongoErrorCode.FailedToParse
					: MongoErrorCode.BadValue,
				cause,
			}),
	},
	{
		// `Internal` covers a lot of ground, so only the recognisable
		// validation failures get a code; the rest stay deliberately uncoded
		// rather than being labelled with a plausible-but-wrong one.
		matches: (err) => err instanceof InternalError,
		build: (message, cause) =>
			new MongoServerError(message, {
				code: VALIDATION_PATTERNS.some((pattern) => pattern.test(message))
					? MongoErrorCode.DocumentValidationFailure
					: undefined,
				cause,
			}),
	},
	{
		// A user-level `THROW`, plus forward-compatible fallthrough for any
		// ServerError kind this driver does not yet know about.
		matches: (err) => err instanceof ThrownError || err instanceof ServerError,
		build: (message, cause) => new MongoServerError(message, { cause }),
	},
];

/**
 * Map an error thrown by `surrealdb.Surreal.query()`/`create()`/`insert()`
 * into the closest MongoDB error. Existing `MongoError`s pass through so a
 * translated error is never re-wrapped.
 */
export function mapQueryError(err: unknown): MongoError {
	if (err instanceof MongoError) return err;

	const message = messageOf(err);

	// A unique-index violation arrives as a generic InternalError; only the
	// message identifies it. Checked first because it is the one server error
	// applications branch on (`err.code === 11000`).
	const duplicate = parseDuplicateKeyError(message);
	if (duplicate) return duplicateKeyError(duplicate, err);

	for (const rule of QUERY_ERROR_RULES) {
		if (rule.matches(err)) return rule.build(message, err);
	}

	// Anything else — including a bare `Error` from a query result — is treated
	// as a server rejection, since that is where it came from.
	return new MongoServerError(message, { cause: err });
}

/**
 * Map an error thrown by `surrealdb.Surreal.connect()` or by the connection
 * watchdog into the appropriate Mongo error class.
 */
export function mapConnectError(err: unknown): Error {
	if (err instanceof MongoError) return err;

	const message = messageOf(err);

	if (isCompatibilityError(err)) {
		return new MongoCompatibilityError(message, { cause: err });
	}

	if (err instanceof AuthenticationError) {
		return new MongoServerError(message, {
			code: MongoErrorCode.AuthenticationFailed,
			cause: err,
		});
	}

	if (err instanceof NotAllowedError) {
		return new MongoServerError(message, {
			code: MongoErrorCode.Unauthorized,
			cause: err,
		});
	}

	if (err instanceof ServerError) {
		return new MongoServerError(message, { cause: err });
	}

	return new MongoNetworkError(`Failed to connect to SurrealDB: ${message}`, {
		cause: err,
	});
}
