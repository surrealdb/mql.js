/**
 * The single policy every per-operation option passes through.
 *
 * MongoDB's operations share one option surface, so the decision about each
 * field belongs in one place rather than being re-taken in `updateOne` and
 * `updateMany` separately. Each option is classified exactly once here:
 *
 *   - **honoured** — `maxTimeMS`/`timeoutMS` become a `TIMEOUT` clause, `hint`
 *     becomes `WITH INDEX`, `ignoreUndefined` decides what a caller's
 *     `undefined` becomes, `session` routes the statement into the transaction
 *     that session is running (resolved by the collection, not here — the gate
 *     validates options rather than executing against them);
 *   - **accepted, no effect** — only where the option cannot change what the
 *     caller gets or what survives a restart, each one listed with its reason
 *     alongside `REJECTED_OPTIONS` below;
 *   - **rejected** — everything whose absence would change the answer or the
 *     durability the caller asked for.
 *
 * The gate reads the whole options object, not just the fields the calling
 * operation happens to consume: TypeScript's excess-property check disappears
 * the moment an options object is computed rather than written inline, which is
 * exactly how mongoose and every other wrapper layer builds one.
 *
 * Options this driver does not recognise at all are deliberately tolerated.
 * Real MongoDB drivers ignore unknown keys, and a strict allowlist would reject
 * anything a newer driver version — or mongoose's own bookkeeping — passes
 * through.
 */

import {
	MongoCompatibilityError,
	MongoErrorCode,
	MongoInvalidArgumentError,
	MongoServerError,
} from "../errors.ts";
import { escapeIdentifier } from "../surreal/sql/escape.ts";
import type { CommandOperationOptions, Document, Hint } from "../types.ts";
import type { IndexInventory } from "./index-definition.ts";
import { ID_INDEX_NAME } from "./index-definition.ts";
import type { ClientDefaults, OperationContext } from "./operation-context.ts";
import { readIndexInventory } from "./operations/indexes.ts";

/**
 * Options as the gate takes them.
 *
 * Every per-operation options type in this driver extends
 * `CommandOperationOptions`, so one parameter type covers all of them — and the
 * gate reads keys beyond the ones it declares, because the caller's object is
 * whatever the caller built.
 */
export type AnyOperationOptions = CommandOperationOptions;

/**
 * Read an option the static type does not necessarily declare.
 *
 * The whole point of the gate is that the runtime object may carry more than its
 * type admits: a computed `FindOptions` can still contain `writeConcern`, and
 * TypeScript's excess-property check only ever applied to object literals.
 */
function optionValue(options: AnyOperationOptions, name: string): unknown {
	return (options as Record<string, unknown>)[name];
}

/**
 * The statement modifiers a caller's options resolve to.
 *
 * Rendered clauses rather than raw values, so each operation splices them into
 * its statement at the position SurrealQL requires instead of re-deriving the
 * syntax. Both are `""` when the caller asked for nothing.
 */
export interface OperationPlan {
	/** `WITH INDEX …` / `WITH NOINDEX`, placed directly after `FROM <table>`. */
	readonly indexHint: string;
	/** `TIMEOUT <duration>`, which SurrealQL requires as the final clause. */
	readonly timeout: string;
	/** True when `undefined` properties are dropped instead of stored as `null`. */
	readonly ignoreUndefined: boolean;
}

/** A plan that asks for nothing, for operations with no options to resolve. */
export const NO_PLAN: OperationPlan = {
	indexHint: "",
	timeout: "",
	ignoreUndefined: false,
};

/*
 * Options accepted and then ignored, and why each is inert. None can change
 * which documents the caller gets back, or whether a write survives — which is
 * what separates them from the rejected options below.
 *
 *   - `comment`: SurrealDB has no query-level comment mechanism (`COMMENT`
 *     exists only on DDL), and a comment is diagnostic by definition: MongoDB
 *     surfaces it in the profiler and returns the same documents either way.
 *   - `readPreference`: chooses a replica-set member to read from. There is one
 *     node, and reading from it is *stronger* than the secondary read any
 *     non-primary preference asks for, so no promise is broken.
 *   - `readConcern: 'local' | 'majority' | 'available'`: on a single node these
 *     collapse into the same read. `'linearizable'` does not, and is rejected
 *     below — as MongoDB itself rejects it off a replica set.
 *   - `readConcern: 'snapshot'`: satisfied by construction. It asks that every
 *     read in the operation — or, with a session, in the transaction — come from
 *     one consistent point in time, and SurrealDB's MVCC gives exactly that: a
 *     statement is a transaction, and a read inside an open transaction does not
 *     observe a commit another connection made after the transaction began
 *     (verified against 3.1 and 3.2). Nothing here is a promise about a second
 *     node, so nothing is left unkept.
 *   - `writeConcern` other than `w: 0` and `w > 1`: this driver always waits for
 *     the server's acknowledgement, which is at least what `w: 1`,
 *     `w: 'majority'`, `journal` and `wtimeoutMS` ask for on a one-node
 *     deployment.
 *   - `batchSize`, `maxAwaitTimeMS`, `noCursorTimeout`, `timeout`, `cursor`:
 *     server-cursor mechanics. Results are materialised in one round trip, so
 *     there is no cursor to batch, expire, or keep alive.
 *   - `allowDiskUse`: lets the server spill a sort to disk. A performance
 *     permission, never visible in results.
 *   - `allowPartialResults`: tolerates unavailable shards. There are none.
 *   - `oplogReplay`: MongoDB 4.4 and later ignore it too.
 *   - `ordered` on a delete: each call emits a single statement, so there is no
 *     batch whose ordering could matter. (`insertMany` does have a batch, and
 *     rejects `ordered: false` below.)
 *   - `willRetryWrite`: driver-internal retryable-write bookkeeping.
 *   - `authdb`: names the database to authenticate against, which is settled
 *     before any operation runs.
 *   - `bypassDocumentValidation: false`, `sparse`-style explicit defaults: a
 *     request for the behaviour this driver already has.
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

/**
 * The default refusal: this driver cannot serve the option, and here is why.
 *
 * `MongoCompatibilityError` rather than a server error, because the request is
 * valid MongoDB — it is this driver that cannot honour it.
 */
function unsupported(option: string, reason: string): () => Error {
	return () =>
		new MongoCompatibilityError(
			`Option '${option}' is not supported: ${reason}`,
		);
}

/**
 * The BSON serialisation family.
 *
 * This driver encodes CBOR and never imports `bson`, so none of these has a
 * referent: there is no serialiser whose behaviour they could select. Accepting
 * one would tell a caller their `Long`s come back as `bigint`, or their reads as
 * raw buffers, when nothing of the sort happens.
 */
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

const REJECTED_OPTIONS: readonly RejectionRule[] = [
	{
		option: "writeConcern",
		applies: (value) => writeConcernRejection(value) !== undefined,
		reject: writeConcernError,
	},
	{
		option: "readConcern",
		// `snapshot` asks the store to *be* something — one consistent point in
		// time per operation or transaction — which SurrealDB is, so it is accepted
		// above. `linearizable` asks the server to *do* something before answering:
		// confirm that no newer primary has been elected, so the read reflects every
		// majority-acknowledged write that preceded it. There is no election to
		// confirm and no step this driver performs in its place, so accepting it
		// would promise a check that never happens.
		applies: (value) => readConcernLevel(value) === "linearizable",
		// MongoDB's own refusal, verbatim and with its code.
		reject: (value) =>
			new MongoServerError(
				`node needs to be a replica set member to use readConcern: ${readConcernLevel(value)}`,
				{ code: MongoErrorCode.NotAReplicaSet },
			),
	},
	{
		option: "bypassDocumentValidation",
		applies: (value) => value === true,
		reject: unsupported(
			"bypassDocumentValidation",
			"SurrealDB enforces `ASSERT` and field types inside the storage engine, so document validation cannot be bypassed",
		),
	},
	{
		option: "collation",
		applies: supplied,
		reject: unsupported(
			"collation",
			"SurrealDB compares strings by code point, so a locale-aware comparison would silently match and order differently",
		),
	},
	{
		option: "let",
		applies: supplied,
		reject: unsupported(
			"let",
			"`$$var` references need an expression compiler this driver does not have, so the variables would never be substituted",
		),
	},
	{
		option: "explain",
		applies: supplied,
		reject: unsupported(
			"explain",
			"SurrealDB's `EXPLAIN` describes a different planner, so its output would not be a plan MongoDB tooling can read",
		),
	},
	{
		// Only `insertMany` sends a batch, and only there can ordering be a
		// request. MongoDB's default is `true`, expressed by omitting the option,
		// so `false` is the only value that asks for something.
		option: "ordered",
		applies: (value) => value === false,
		reject: unsupported(
			"ordered",
			"SurrealDB inserts a batch atomically, so one failure rolls the whole batch back and the documents `ordered: false` promises to keep would never be written",
		),
	},
	{
		option: "forceServerObjectId",
		applies: (value) => value === true,
		reject: unsupported(
			"forceServerObjectId",
			"the id would be generated inside SurrealDB, leaving the reported `insertedId` with nothing truthful to say",
		),
	},
	{
		option: "returnKey",
		applies: (value) => value === true,
		reject: unsupported(
			"returnKey",
			"SurrealDB cannot return index keys in place of documents, so whole documents would come back instead",
		),
	},
	{
		option: "showRecordId",
		applies: (value) => value === true,
		reject: unsupported(
			"showRecordId",
			"SurrealDB exposes no storage-level record identifier to report as `$recordId`",
		),
	},
	{
		option: "singleBatch",
		applies: (value) => value === true,
		reject: unsupported(
			"singleBatch",
			"results are materialised in one round trip, so the truncation to a single batch that MongoDB performs would not happen",
		),
	},
	{
		option: "tailable",
		applies: (value) => value === true,
		reject: unsupported(
			"tailable",
			"SurrealDB has no capped collections, so a cursor cannot stay open for later writes",
		),
	},
	{
		option: "awaitData",
		applies: (value) => value === true,
		reject: unsupported(
			"awaitData",
			"SurrealDB has no capped collections, so there is no tailable cursor to block on",
		),
	},
	{
		option: "min",
		applies: supplied,
		reject: unsupported(
			"min",
			"SurrealDB has no index-bound clause, so the scan would not be restricted to the range",
		),
	},
	{
		option: "max",
		applies: supplied,
		reject: unsupported(
			"max",
			"SurrealDB has no index-bound clause, so the scan would not be restricted to the range",
		),
	},
	{
		option: "out",
		applies: supplied,
		reject: unsupported(
			"out",
			"writing results into another collection has no SurrealQL equivalent, so the output collection would never be created",
		),
	},
	{
		option: "dbName",
		applies: supplied,
		reject: unsupported(
			"dbName",
			"the operation would run against the connected database rather than the one named",
		),
	},
	...BSON_OPTIONS.map((option) => ({
		option,
		applies: supplied,
		reject: unsupported(
			option,
			"this driver encodes CBOR and has no BSON layer, so no serialisation setting has anything to select",
		),
	})),
];

/**
 * The `level` of a read concern given in either of MongoDB's two shapes.
 *
 * Exported so the client-option gate classifies `?readConcernLevel=` by the same
 * rule that classifies a per-operation `readConcern`.
 */
export function readConcernLevel(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "object" && value !== null) {
		const level = (value as { level?: unknown }).level;
		if (typeof level === "string") return level;
	}
	return undefined;
}

/**
 * Why a write concern cannot be served, or `undefined` when it can.
 *
 * Exported for the client-option gate: a durability promise made in the
 * connection string is the same promise made per operation.
 */
export function writeConcernRejection(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const w = (value as { w?: unknown }).w;

	if (w === 0) {
		return "`w: 0` asks for an unacknowledged write, and this driver always waits for SurrealDB to acknowledge before resolving";
	}
	if (typeof w === "number" && w > 1) {
		return "cannot use 'w' > 1 when a host is not replicated";
	}
	return undefined;
}

/** The error for a write concern this driver cannot serve. */
export function writeConcernError(value: unknown): Error {
	const reason = writeConcernRejection(value) ?? "";
	// `w > 1` is the request MongoDB itself refuses on an unreplicated host, with
	// that message and code 2. `w: 0` is one MongoDB honours, so refusing it is
	// this driver's own incompatibility and says so in its own words.
	const w = (value as { w?: unknown }).w;
	return typeof w === "number" && w > 1
		? new MongoServerError(reason, { code: MongoErrorCode.BadValue })
		: new MongoCompatibilityError(
				`Option 'writeConcern' is not supported: ${reason}`,
			);
}

/**
 * Reject every option this driver cannot honour, before any statement runs.
 *
 * Called by every operation, with whatever the caller passed — including the
 * fields that operation has no use for.
 */
export function assertSupportedOptions(
	options: AnyOperationOptions | undefined,
	redefined: readonly string[] = [],
): void {
	if (!options) return;

	for (const rule of REJECTED_OPTIONS) {
		if (redefined.includes(rule.option)) continue;
		const value = optionValue(options, rule.option);
		if (rule.applies(value)) throw rule.reject(value);
	}
}

/**
 * Option names an index specification gives a meaning of their own.
 *
 * `min` and `max` bound a query's index scan in `FindOptions`, which this driver
 * cannot express — but in `CreateIndexesOptions` they are the coordinate limits
 * of a `2d` index, a different option that the index surface classifies as
 * accepted-and-inert. Reading the query rule against an index option would
 * refuse a valid `createIndex`.
 */
const INDEX_REDEFINED_OPTIONS = ["min", "max"] as const;

/**
 * Reject every option an index operation cannot honour.
 *
 * The same policy as `assertSupportedOptions`, minus the names an index
 * specification defines differently. `maxTimeMS` is accepted and inert here
 * rather than honoured: SurrealDB's `DEFINE INDEX`, `REMOVE INDEX` and
 * `INFO FOR TABLE` take no `TIMEOUT` clause.
 */
export function assertSupportedIndexOptions(
	options: AnyOperationOptions | undefined,
): void {
	assertSupportedOptions(options, INDEX_REDEFINED_OPTIONS);
}

/**
 * Collection-shaping options `DEFINE TABLE` has no counterpart for.
 *
 * Each of these changes what the caller is writing to, so returning an ordinary
 * table for a request that asked for a capped one — or for a view, or a
 * time-series collection — misrepresents the storage rather than merely
 * omitting a refinement. `max` is listed here for its `createCollection`
 * meaning (a document cap), distinct from the query and index-bound options of
 * the same name.
 */
const UNSUPPORTED_COLLECTION_OPTIONS: ReadonlyArray<{
	readonly option: string;
	readonly because: string;
}> = [
	{ option: "capped", because: "SurrealDB tables are not fixed-size" },
	{ option: "size", because: "there is no capped-collection byte limit" },
	{ option: "max", because: "there is no capped-collection document limit" },
	{
		option: "validator",
		because:
			"document validation is expressed as SurrealDB `ASSERT` clauses on a table definition, which this driver does not generate",
	},
	{ option: "validationLevel", because: "there is no document validator" },
	{ option: "validationAction", because: "there is no document validator" },
	{ option: "timeseries", because: "there are no time-series collections" },
	{
		option: "expireAfterSeconds",
		because: "SurrealDB has no TTL mechanism, so documents would never expire",
	},
	{ option: "viewOn", because: "there are no views" },
	{ option: "pipeline", because: "aggregation is not implemented" },
	{ option: "clusteredIndex", because: "there are no clustered indexes" },
];

/**
 * Reject every `createCollection` option that cannot shape the table.
 *
 * Applied on top of the shared policy, which still governs `session`,
 * `writeConcern` and the rest.
 */
export function assertSupportedCollectionOptions(
	options: AnyOperationOptions | undefined,
): void {
	// `max` means a document cap here, not the index bound the query rule reads.
	assertSupportedOptions(options, ["max"]);
	if (!options) return;

	for (const { option, because } of UNSUPPORTED_COLLECTION_OPTIONS) {
		if (optionValue(options, option) === undefined) continue;
		throw new MongoCompatibilityError(
			`Option '${option}' is not supported when creating a collection: ${because}.`,
		);
	}
}

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

/**
 * Render `maxTimeMS`/`timeoutMS` as the `TIMEOUT` clause SurrealQL takes.
 *
 * The tightest budget binds when several are given, whether they came from the
 * operation or from the client's `timeoutMS`: each is a promise that the
 * operation will not run longer than its value, and honouring only one would
 * break the other. MongoDB reads `0` as "no limit", so it yields no clause.
 */
function timeoutClause(
	options: AnyOperationOptions | undefined,
	defaults: ClientDefaults | undefined,
): string {
	const budgets = options
		? ["maxTimeMS", "timeoutMS"]
				.map((option) => readTimeout(options, option))
				.filter((value): value is number => value !== undefined && value > 0)
		: [];

	const inherited = defaults?.timeoutMS;
	if (inherited !== undefined && inherited > 0) budgets.push(inherited);

	if (budgets.length === 0) return "";
	return `TIMEOUT ${Math.min(...budgets)}ms`;
}

/**
 * The largest time limit MongoDB accepts, which is a signed 32-bit millisecond
 * count — about 24 days.
 *
 * Exported so the client-option gate holds `timeoutMS` to the same ceiling: a
 * client-wide budget becomes the same `TIMEOUT` clause.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Validate one timeout option, the way MongoDB validates it. */
function readTimeout(
	options: AnyOperationOptions,
	option: string,
): number | undefined {
	const value = optionValue(options, option);
	if (value === undefined || value === null) return undefined;

	if (typeof value !== "number" || Number.isNaN(value)) {
		throw new MongoInvalidArgumentError(
			`Option '${option}' must be a number, got ${JSON.stringify(value)}`,
		);
	}
	if (value < 0) {
		throw new MongoServerError(
			`BSON field '${option}' value must be >= 0, actual value '${value}'`,
			{ code: MongoErrorCode.BadValue },
		);
	}
	if (!Number.isInteger(value)) {
		throw new MongoServerError(`Expected an integer: ${option}: ${value}`, {
			code: MongoErrorCode.FailedToParse,
		});
	}
	// MongoDB's timeouts are 32-bit, and the ceiling has to be enforced rather
	// than passed on: JavaScript renders anything from 1e21 upwards in exponent
	// notation, so `TIMEOUT 1e+21ms` would reach SurrealDB as a parse error
	// naming a token the caller never wrote.
	if (value > MAX_TIMEOUT_MS) {
		throw new MongoServerError(
			`BSON field '${option}' value must be <= ${MAX_TIMEOUT_MS}, actual value '${value}'`,
			{ code: MongoErrorCode.BadValue },
		);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Index hints
// ---------------------------------------------------------------------------

/**
 * `$natural` is MongoDB's way of naming the collection's natural order, so
 * hinting it means "do not use an index at all".
 */
const NATURAL_HINT = "$natural";

/**
 * Resolve a caller's `hint` to a `WITH` clause.
 *
 * The hint is checked against the collection's real indexes rather than passed
 * through, because SurrealDB *silently ignores* a `WITH INDEX` naming an index
 * that does not exist — the query succeeds having used none. MongoDB raises
 * `BadValue` for the same request, so passing it through would turn a caller's
 * explicit "use this index" into an unnoticed full scan.
 */
async function indexHintClause(
	ctx: OperationContext,
	hint: Hint,
): Promise<string> {
	if (isNaturalHint(hint)) return "WITH NOINDEX";

	const inventory = await readIndexInventory(ctx);
	const name = resolveHintName(inventory, hint);

	// `_id_` names the identity SurrealDB maintains itself, which every access
	// path already uses; there is no `DEFINE INDEX` behind it to name in a
	// `WITH INDEX` clause.
	if (name === ID_INDEX_NAME) return "";

	// A MongoDB index may be several SurrealDB indexes — one per field of a
	// multi-field text index — and the clause has to name the ones that exist.
	const physical = inventory.physical
		.filter((index) => index.name === name)
		.map((index) => escapeIdentifier(index.physicalName));

	return physical.length > 0 ? `WITH INDEX ${physical.join(", ")}` : "";
}

/** True for `{ $natural: … }`, in either the string or the key-pattern form. */
function isNaturalHint(hint: Hint): boolean {
	return typeof hint === "object" && hint !== null && NATURAL_HINT in hint;
}

/** The MongoDB index name a hint refers to, or a `BadValue` rejection. */
function resolveHintName(inventory: IndexInventory, hint: Hint): string {
	const match =
		typeof hint === "string"
			? inventory.descriptions.find((index) => index.name === hint)
			: inventory.descriptions.find((index) => keysMatch(index.key, hint));

	if (!match) {
		throw new MongoServerError(
			`error processing query: planner returned error :: caused by :: hint provided does not correspond to an existing index: ${JSON.stringify(hint)}`,
			{ code: MongoErrorCode.BadValue },
		);
	}
	return match.name;
}

/**
 * True when a key-pattern hint describes exactly this index.
 *
 * Field order and direction both count, as they do in MongoDB: hinting
 * `{age: -1}` at an ascending `age` index is a `BadValue` there, because it is
 * not the index the caller named.
 */
function keysMatch(indexKey: Document, hint: Document): boolean {
	const indexFields = Object.keys(indexKey);
	const hintFields = Object.keys(hint);

	if (indexFields.length !== hintFields.length) return false;
	return hintFields.every(
		(field, position) =>
			indexFields[position] === field && indexKey[field] === hint[field],
	);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Which statement modifiers the calling statement has room for. */
export interface PlanFeatures {
	/**
	 * True when the statement has a `WITH` clause position. Every statement this
	 * driver emits does except `CREATE` and `INSERT`, and MongoDB's insert
	 * options carry no `hint` either.
	 */
	readonly indexHint?: boolean;
}

/**
 * Validate a caller's options and resolve them into statement modifiers.
 *
 * Every operation funnels through this, so an option cannot be honoured in one
 * method and dropped in another. Costs an extra round trip only when a `hint`
 * has to be checked against the collection's indexes.
 */
export async function resolveOperationPlan(
	ctx: OperationContext,
	options: AnyOperationOptions | undefined,
	features: PlanFeatures = {},
): Promise<OperationPlan> {
	assertSupportedOptions(options);

	const defaults = ctx.defaults;
	if (!options && !defaults) return NO_PLAN;

	const hint = options
		? (optionValue(options, "hint") as Hint | undefined)
		: undefined;
	return {
		indexHint:
			features.indexHint && hint !== undefined
				? await indexHintClause(ctx, hint)
				: "",
		timeout: timeoutClause(options, defaults),
		// The operation's own answer wins, including an explicit `false` against a
		// client that asked for `true`: a caller who names the option on the call
		// is overriding the client-wide default, not restating it.
		ignoreUndefined:
			options?.ignoreUndefined ?? defaults?.ignoreUndefined ?? false,
	};
}
