/**
 * Centralised error translation: anything thrown by the underlying SurrealDB
 * SDK (or by network/auth issues) is converted to the corresponding
 * MongoDB-shaped error class, with the numeric `code` a real MongoDB server
 * would have returned.
 *
 * The SDK exposes a structured taxonomy (`ServerError.kind`, `.details`,
 * `.code`, `.cause`), so most mappings key off the error class rather than its
 * message. The index failures are the exception: SurrealDB reports a
 * unique-index violation, a missing index and a duplicate index name as generic
 * `InternalError`s whose only distinguishing feature is their message, so those
 * are matched by pattern.
 *
 * Message matching is fragile by nature — a reworded server error stops being
 * recognised and degrades to an uncoded `MongoServerError`. It is used only
 * where the alternative is having no code at all, each pattern is anchored and
 * verified against a live server, and the integration suite runs every
 * supported SurrealDB minor so a rewording surfaces as a test failure rather
 * than as silently missing `err.code`. The originating error is always preserved
 * as `cause`.
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
	QueryError,
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
	MongoErrorLabel,
	MongoNetworkError,
	MongoServerError,
	type WriteError,
} from "../errors.ts";
import type { ObjectIdLike } from "../object-id.ts";
import { isObjectId, ObjectId } from "../object-id.ts";
import { parseRecordIdString } from "../utils/id.ts";
import { objectIdFromPrintedForm } from "./bson-codec.ts";
import { unescapeSurrealString } from "./sql/escape.ts";

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
 *
 * The record group is greedy to the last backtick rather than stopping at the
 * first, because SurrealDB quotes an id part that is not a bare identifier with
 * backticks of its own: an `_id` of `'urn:uuid:1234'` is named as
 * ``users:`urn:uuid:1234` ``.
 */
const DUPLICATE_INDEX_PATTERN =
	/Database index `(?<index>[^`]+)` already contains (?<value>.+), with record `(?<record>.+)`/s;

/**
 * Index-lifecycle rejections, matched by message for the same reason as
 * duplicate keys: SurrealDB reports them without a distinguishing error class.
 *
 * `createIndex` and `dropIndex` compare against the live index list before
 * emitting DDL, so these fire only when the definitions change underneath them —
 * a concurrent create or drop. Without them such a race would surface as an
 * uncoded server error rather than the `27`/`86` a MongoDB caller branches on.
 */
const INDEX_LIFECYCLE_PATTERNS: ReadonlyArray<{
	readonly pattern: RegExp;
	readonly code: number;
	/** MongoDB's own wording for the same failure. */
	readonly message: (name: string) => string;
}> = [
	{
		pattern: /^The index '(?<name>.*)' does not exist$/,
		code: MongoErrorCode.IndexNotFound,
		message: (name) => `index not found with name [${name}]`,
	},
	{
		pattern: /^The index '(?<name>.*)' already exists$/,
		code: MongoErrorCode.IndexKeySpecsConflict,
		message: (name) =>
			`An existing index has the same name as the requested index. Requested index name: ${name}`,
	},
];

/**
 * The `TIMEOUT` clause firing, which is how `maxTimeMS` is enforced.
 *
 * Verified against 3.x: `The query was not executed because it exceeded the
 * timeout: 1ns`. MongoDB reports the same event as code 50 with its own wording,
 * which is what applications and mongoose branch on.
 */
const QUERY_TIMEOUT_PATTERN =
	/^The query was not executed because it exceeded the timeout/;

/**
 * A concurrent transaction having written the same data first.
 *
 * SurrealDB's transactions are optimistic: both writers' statements succeed, and
 * whichever commits second is rejected. 3.2 and later report it as a
 * `QueryError` carrying `details.kind === "TransactionConflict"`, so the class is
 * asked first; 3.0 and 3.1 report the same event as a bare `InternalError` whose
 * message is the only evidence, which is what the pattern is for. Both wordings
 * were verified against live 3.0.5 and 3.2.3 servers.
 */
const TRANSACTION_CONFLICT_PATTERN = /\bTransaction conflict: /;

/** True when `err` is a write/write conflict the caller may retry. */
function isTransactionConflict(err: unknown, message: string): boolean {
	if (err instanceof QueryError && err.isTransactionConflict) return true;
	return TRANSACTION_CONFLICT_PATTERN.test(message);
}

/**
 * The transaction handle naming a transaction the server no longer holds — the
 * SDK's wording when a statement, commit or cancel reaches a spent handle.
 */
const TRANSACTION_GONE_PATTERN = /^Transaction not found$/;

/** Assertion / type-coercion rejections, which MongoDB reports as code 121. */
const VALIDATION_PATTERNS = [
	/^Couldn't coerce value for field/,
	/but field must conform to:/,
	/^Found .* for field .*, with record/,
];

/**
 * Parse a SurrealQL scalar literal (`'str'`, `42`, `true`, `NONE`).
 *
 * An `ObjectId` is one of these too: it is stored as a tagged object, so the
 * value a unique index rejected is named as `{ "$oid": '6a7b…' }` and has to be
 * reported back as the id the caller indexed.
 */
function parseScalar(literal: string): unknown {
	const text = literal.trim();
	const objectId = objectIdFromPrintedForm(text);
	if (objectId) return objectId;

	// A string literal's contents are unescaped, not just unwrapped: SurrealDB
	// prints a tab as `\t` and switches to double quotes (escaping any it
	// contains) for a value holding a single one, so the caller's own value is
	// only recovered by undoing that.
	for (const quote of ["'", '"']) {
		if (text.length > 1 && text.startsWith(quote) && text.endsWith(quote)) {
			return unescapeSurrealString(text.slice(1, -1));
		}
	}

	if (text === "true") return true;
	if (text === "false") return false;
	if (text === "NONE" || text === "NULL") return null;
	const asNumber = Number(text);
	return Number.isNaN(asNumber) ? text : asNumber;
}

/**
 * Split a compound index value (`[1, 'x, y']`) into its elements, respecting
 * quoted segments and nested object or array literals, so neither a comma inside
 * a string nor one inside `{ "$oid": … }` is treated as a separator.
 */
function parseValueList(literal: string): unknown[] {
	return splitTopLevel(literal.trim().slice(1, -1)).map(parseScalar);
}

/** Where a scan through a printed list currently is. */
interface ScanState {
	/** The quote character the scan is inside, if any. */
	quote: string | undefined;
	/** How many object or array literals deep the scan is. */
	depth: number;
	/** Whether the previous character was a backslash inside a string. */
	escaped: boolean;
}

/** Advance `state` over `char`, and say whether it separates two elements. */
function isSeparator(char: string, state: ScanState): boolean {
	if (state.quote) {
		// An escaped quote does not end the string, so the scan must step over it:
		// treating the `"` of `"a\"b, c"` as the closing quote would make the comma
		// after it look like a separator and split one value into two.
		if (state.escaped) {
			state.escaped = false;
			return false;
		}
		if (char === "\\") {
			state.escaped = true;
			return false;
		}
		if (char === state.quote) state.quote = undefined;
		return false;
	}
	if (char === "'" || char === '"') {
		state.quote = char;
		return false;
	}
	if (char === "{" || char === "[") state.depth += 1;
	if (char === "}" || char === "]") state.depth -= 1;
	return char === "," && state.depth === 0;
}

/** Split on commas that are outside any quoted string, object or array. */
function splitTopLevel(text: string): string[] {
	const state: ScanState = { quote: undefined, depth: 0, escaped: false };
	const parts: string[] = [];
	let current = "";

	for (const char of text) {
		if (isSeparator(char, state)) {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim() !== "") parts.push(current);

	return parts;
}

/**
 * Recover the indexed fields and their directions from an index name.
 *
 * Only works for the `field_1` / `field_-1` / `a_1_b_-1` convention this driver
 * generates itself (see `createIndex`). A caller-supplied `name` cannot be
 * decomposed, in which case `keyPattern` is omitted rather than guessed at.
 *
 * The direction is carried rather than assumed ascending: MongoDB's
 * `keyPattern` reports the index's real direction, so a `{age: -1}` index has to
 * come back as `{age: -1}` — and the name is where that survives.
 */
function keyFromIndexName(indexName: string): [string, number][] | undefined {
	const tokens = indexName.split("_");
	const fields: [string, number][] = [];
	let current: string[] = [];

	// Walk left to right accumulating name parts until a direction token closes
	// the field. This keeps underscores inside field names intact, so
	// `first_name_1` yields ["first_name", 1] and `a_1_b_-1` yields
	// [["a", 1], ["b", -1]].
	for (const token of tokens) {
		if (token === "1" || token === "-1") {
			if (current.length === 0) return undefined;
			fields.push([current.join("_"), Number(token)]);
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
	/** `{ field: direction }` shape, when derivable from the index name. */
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

	const collection = parseRecordIdString(record).collection;

	const fields = keyFromIndexName(indexName);
	let keyPattern: Record<string, number> | undefined;
	let keyValue: Record<string, unknown> | undefined;

	if (fields && fields.length === values.length) {
		keyPattern = {};
		keyValue = {};
		for (const [i, [field, direction]] of fields.entries()) {
			keyPattern[field] = direction;
			keyValue[field] = values[i];
		}
	}

	return { indexName, collection, values, keyPattern, keyValue };
}

/**
 * Render one colliding value as MongoDB renders it in the message.
 *
 * An `ObjectId` prints as `ObjectId('…')` rather than as its JSON string, which
 * is what the server writes and therefore what anything matching on the message
 * expects to see.
 */
function formatDuplicateValue(value: unknown): string {
	return isObjectId(value)
		? `ObjectId('${value.toHexString()}')`
		: JSON.stringify(value);
}

/** Render a duplicate key the way MongoDB renders it, for message parity. */
function formatDuplicateKeyMessage(info: DuplicateKeyInfo): string {
	const namespace = info.collection ? ` collection: ${info.collection}` : "";
	const dupKey = info.keyValue
		? Object.entries(info.keyValue)
				.map(([field, value]) => `${field}: ${formatDuplicateValue(value)}`)
				.join(", ")
		: info.values.map(formatDuplicateValue).join(", ");

	return `E11000 duplicate key error${namespace} index: ${info.indexName} dup key: { ${dupKey} }`;
}

/**
 * Name of the index MongoDB reports for an `_id` collision. Every collection
 * has it implicitly, so it is the index a duplicate `_id` is attributed to.
 */
const ID_INDEX = "_id_";

/**
 * Describe an `_id` collision, given the record SurrealDB says already exists.
 *
 * The record arrives as text, so the `_id` is recovered from the way SurrealDB
 * printed it — quoting distinguishes the string `"42"` from the number `42`, and
 * an id containing a colon survives intact. `knownId` overrides that when the
 * caller's own value is to hand, so the reported id is the very object they
 * passed in.
 */
export function duplicateIdInfo(
	recordId: string,
	knownId?: unknown,
): DuplicateKeyInfo {
	const parsed = parseRecordIdString(recordId);
	const value = knownId !== undefined ? knownId : parsed.id;

	return {
		indexName: ID_INDEX,
		collection: parsed.collection,
		values: [value],
		keyPattern: { _id: 1 },
		keyValue: { _id: value },
	};
}

/**
 * Restate a duplicate `_id` using the value the caller supplied.
 *
 * The server names the offending record as text, and while that text is enough to
 * recover the id's type, it is not the caller's own instance: an `ObjectId` from
 * `bson` or mongoose has to be reported back as itself, because `keyValue._id` is
 * what application code compares against the id it tried to write.
 *
 * Any error that is not an `_id` collision, and any collision whose record does
 * not match a candidate, is returned untouched.
 */
export function withTypedDuplicateId(
	err: unknown,
	candidates: readonly unknown[],
): unknown {
	if (!(err instanceof MongoServerError)) return err;
	if (err.code !== MongoErrorCode.DuplicateKey) return err;

	const cause = err.cause;
	if (!(cause instanceof AlreadyExistsError) || !cause.recordId) return err;

	const rejected = parseRecordIdString(cause.recordId).id;
	const typed = candidates.find((candidate) =>
		namesSameId(candidate, rejected),
	);
	if (typed === undefined) return err;

	return duplicateKeyError(duplicateIdInfo(cause.recordId, typed), cause);
}

/** True when a candidate `_id` is the one the server rejected. */
function namesSameId(candidate: unknown, rejected: unknown): boolean {
	if (rejected instanceof ObjectId) {
		if (typeof candidate === "string" || isObjectId(candidate)) {
			return rejected.equals(candidate as string | ObjectIdLike);
		}
		return false;
	}
	return candidate === rejected;
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
		// A record that already exists is a duplicate *key*, not a duplicate
		// namespace: it is `_id` colliding, which MongoDB reports as 11000 from
		// the implicit `_id_` index. Discriminated structurally on the error's own
		// `recordId`, which SurrealDB populates only for the record case — a
		// duplicate table or namespace carries `tableName` or neither and stays
		// `NamespaceExists`.
		matches: (err) => err instanceof AlreadyExistsError && !!err.recordId,
		// The server's own wording is discarded here: MongoDB's `E11000 …` message
		// is what applications and mongoose match on, and it is rebuilt from the
		// record id rather than translated from the SurrealDB text.
		build: (_message, cause) => {
			const recordId = (cause as AlreadyExistsError).recordId as string;
			return duplicateKeyError(duplicateIdInfo(recordId), cause);
		},
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

	// A write/write conflict is the one server failure a caller can do something
	// about, so it carries the code MongoDB reports for it and the label the
	// transaction retry loop reads. The label is attached whether or not the
	// statement ran inside an explicit transaction, because a lone SurrealQL
	// statement is itself a transaction: re-running it is exactly as safe.
	if (isTransactionConflict(err, message)) {
		const conflict = new MongoServerError(
			"WriteConflict error: this operation conflicted with another operation. Please retry your operation or multi-document transaction.",
			{ code: MongoErrorCode.WriteConflict, cause: err },
		);
		conflict.addErrorLabel(MongoErrorLabel.TransientTransactionError);
		return conflict;
	}

	// A statement, commit or cancel that reached a handle the server has already
	// released. MongoDB reports the same mistake as `NoSuchTransaction`, which is
	// what a caller branches on; the SDK's wording stays reachable as the cause.
	if (TRANSACTION_GONE_PATTERN.test(message)) {
		return new MongoServerError("Transaction is not in progress", {
			code: MongoErrorCode.NoSuchTransaction,
			cause: err,
		});
	}

	// A `TIMEOUT` clause firing is the caller's own `maxTimeMS` expiring, so it
	// carries MongoDB's `MaxTimeMSExpired` code and message rather than being
	// reported as an opaque query failure. The SurrealDB text is preserved as the
	// cause, which is where the duration that was exceeded remains visible.
	if (QUERY_TIMEOUT_PATTERN.test(message)) {
		return new MongoServerError("operation exceeded time limit", {
			code: MongoErrorCode.MaxTimeMSExpired,
			cause: err,
		});
	}

	for (const rule of INDEX_LIFECYCLE_PATTERNS) {
		const match = rule.pattern.exec(message);
		if (match?.groups) {
			return new MongoServerError(rule.message(match.groups.name as string), {
				code: rule.code,
				cause: err,
			});
		}
	}

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
