/**
 * `insertOne` / `insertMany` operations.
 *
 * Both go through SurrealQL rather than the SDK's `create`/`insert` shortcuts,
 * because only a statement can carry the `TIMEOUT` clause a caller's
 * `maxTimeMS` becomes. The documents themselves are still bound parameters, so
 * the encoding — `RecordId`s, dates, nested objects — is unchanged.
 */

import type { BulkWriteOutcome, WriteError } from "../../errors.ts";
import {
	MongoBulkWriteError,
	MongoErrorCode,
	MongoServerError,
} from "../../errors.ts";
import type { ObjectId } from "../../object-id.ts";
import { withTypedDuplicateId } from "../../surreal/error-mapper.ts";
import { statement } from "../../surreal/sql/statement.ts";
import type {
	BulkWriteOptions,
	Document,
	InsertManyResult,
	InsertOneOptions,
	InsertOneResult,
	OptionalId,
} from "../../types.ts";
import { prepareInsert } from "../../utils/id.ts";
import {
	makeInsertManyResult,
	makeInsertOneResult,
} from "../../utils/result.ts";
import { applyUndefinedPolicy } from "../../utils/undefined.ts";
import type { OperationContext } from "../operation-context.ts";
import { resolveOperationPlan } from "../operation-options.ts";

export async function insertOne<TSchema extends Document>(
	ctx: OperationContext,
	doc: OptionalId<TSchema>,
	options?: InsertOneOptions,
): Promise<InsertOneResult> {
	// `CREATE` has no `WITH` clause position, and MongoDB's insert options carry
	// no `hint` either, so there is no index hint to resolve.
	const plan = await resolveOperationPlan(ctx, options);
	const prepared = prepareInsert(
		ctx.collectionName,
		applyUndefinedPolicy(doc as Document, plan.ignoreUndefined),
	);

	try {
		await ctx.executor.query(
			statement("CREATE $__rid CONTENT $__doc", plan.timeout),
			{ __rid: prepared.recordId, __doc: prepared.data },
		);
	} catch (err) {
		// A collision reports the record as a string, which loses whether the `_id`
		// was `42` or `"42"`. The prepared id is the typed original.
		throw withTypedDuplicateId(err, [prepared.insertedId]);
	}
	return makeInsertOneResult(prepared.insertedId);
}

/**
 * Insert a batch, keeping what MongoDB would have kept when part of it fails.
 *
 * MongoDB does not treat a batch as one write. `ordered: true` — the default —
 * inserts in order, stops at the first document the collection refuses, and
 * **keeps the ones before it**; `ordered: false` attempts all of them and keeps
 * every success. Either way the failure is reported as a `MongoBulkWriteError`
 * naming each refused document by its index, alongside a count of what did land.
 * Measured against a real mongod: a duplicate at index 1 of three leaves
 * `["a1", "dup"]` ordered and `["a1", "a2", "dup"]` unordered.
 *
 * `INSERT INTO t $docs` is a single SurrealDB statement and therefore a single
 * transaction, so one refusal rolls the whole batch back — none of the documents
 * MongoDB promises to keep survive. Separate statements in one query do not share
 * that fate: each runs in its own implicit transaction and a failure stops none of
 * the others, which is what makes a partial batch expressible at all (measured on
 * 3.2.3, and `BEGIN`/`COMMIT` around them restores all-or-nothing).
 *
 * So the batch is attempted whole first and only re-issued per document if that
 * fails. The common case keeps its single round trip and its atomicity, and the
 * cost of the per-document shape — n statements, and for `ordered: true` n round
 * trips because "stop here" cannot be expressed in one dispatch — is paid only
 * once something has actually gone wrong. The first attempt having rolled back
 * whole is what makes the re-issue sound rather than a double write.
 *
 * Inside a caller's transaction none of this applies: MongoDB's own
 * `insertMany` in a transaction is all-or-nothing, because the failure aborts the
 * transaction. The single statement is already that, so it is used as-is.
 */
export async function insertMany<TSchema extends Document>(
	ctx: OperationContext,
	docs: OptionalId<TSchema>[],
	options?: BulkWriteOptions,
): Promise<InsertManyResult> {
	const plan = await resolveOperationPlan(ctx, options);

	const insertedIds: (ObjectId | string | number)[] = [];
	const docsWithId: Document[] = [];

	for (const doc of docs) {
		const prepared = prepareInsert(
			ctx.collectionName,
			applyUndefinedPolicy(doc as Document, plan.ignoreUndefined),
		);
		insertedIds.push(prepared.insertedId);
		docsWithId.push({ ...prepared.data, id: prepared.recordId });
	}

	const batch = statement(
		`INSERT INTO ${ctx.escapedTable} $__docs`,
		plan.timeout,
	);

	try {
		await ctx.executor.query(batch, { __docs: docsWithId });
		return makeInsertManyResult(insertedIds);
	} catch (err) {
		// A batch of one has no partial outcome to report, and a caller's transaction
		// is all-or-nothing by definition, so both keep the error as it is.
		if (ctx.inTransaction || docsWithId.length < 2) {
			throw withTypedDuplicateId(err, insertedIds);
		}
	}

	const ordered = options?.ordered !== false;
	const written = ordered
		? await insertOneByOne(ctx, docsWithId, plan.timeout)
		: await insertIndependently(ctx, docsWithId, plan.timeout);

	return reportBatch(written, insertedIds);
}

/** What one document of a re-issued batch did. */
interface DocumentOutcome {
	/** Position in the caller's batch. */
	readonly index: number;
	/** Why it was refused, or `undefined` if it was written. */
	readonly error: unknown;
}

/** The statement one document of a batch is inserted by. */
function insertOneSql(ctx: OperationContext, timeout: string): string {
	return statement(`INSERT INTO ${ctx.escapedTable} $__d`, timeout);
}

/**
 * `ordered: true`: insert in order and stop at the first refusal.
 *
 * One dispatch per document, because a single dispatch would apply the documents
 * after the failure too — SurrealDB runs every statement it is sent and reports
 * the failures afterwards, which is the opposite of stopping. Only reached once
 * the whole-batch attempt has already failed.
 */
async function insertOneByOne(
	ctx: OperationContext,
	docs: readonly Document[],
	timeout: string,
): Promise<DocumentOutcome[]> {
	const sql = insertOneSql(ctx, timeout);
	const outcomes: DocumentOutcome[] = [];

	for (const [index, doc] of docs.entries()) {
		try {
			await ctx.executor.query(sql, { __d: doc });
			outcomes.push({ index, error: undefined });
		} catch (error) {
			outcomes.push({ index, error });
			break;
		}
	}

	return outcomes;
}

/**
 * `ordered: false`: attempt every document, keep every success.
 *
 * One dispatch for the whole batch, since that is exactly what separate
 * statements in one query already do — this is the bulk-load shape a caller asks
 * for `ordered: false` to get, so it must not cost a round trip per document.
 */
async function insertIndependently(
	ctx: OperationContext,
	docs: readonly Document[],
	timeout: string,
): Promise<DocumentOutcome[]> {
	const sql = docs
		.map((_, index) =>
			statement(`INSERT INTO ${ctx.escapedTable} $__d${index}`, timeout),
		)
		.join("; ");
	const bindings = Object.fromEntries(
		docs.map((doc, index) => [`__d${index}`, doc]),
	);

	const outcomes = await ctx.executor.queryEach(sql, bindings);
	return docs.map((_, index) => ({
		index,
		// A statement with no outcome never ran, which the server does not do for
		// this shape; treating it as refused is truthful about not having written it.
		error: outcomes[index]?.ok
			? undefined
			: (outcomes[index]?.error ?? new Error("the statement did not run")),
	}));
}

/**
 * Report a partially applied batch the way MongoDB reports one.
 *
 * A batch where everything landed returns normally; anything else throws, because
 * MongoDB's `insertMany` throws on the first refusal even though it kept the
 * documents before it — and a caller who never inspects the error must not be
 * left believing all of them were written.
 */
function reportBatch(
	outcomes: readonly DocumentOutcome[],
	insertedIds: readonly (ObjectId | string | number)[],
): InsertManyResult {
	const written = outcomes.filter((outcome) => outcome.error === undefined);
	const refused = outcomes.filter((outcome) => outcome.error !== undefined);

	if (refused.length === 0) {
		return makeInsertManyResult(written.map((o) => insertedIds[o.index]));
	}

	const first = refused[0] as DocumentOutcome;
	throw bulkWriteError(
		refused.map((outcome) =>
			writeErrorFor(outcome, insertedIds[outcome.index]),
		),
		{
			insertedCount: written.length,
			insertedIds: Object.fromEntries(
				written.map((o) => [o.index, insertedIds[o.index]]),
			),
		},
		first,
		insertedIds[first.index],
	);
}

/**
 * One refused document, as a `writeErrors` entry.
 *
 * The `_id` is restored to the type the caller supplied: SurrealDB names the
 * record it rejected as a string, which loses whether the `_id` was `42` or
 * `"42"`, and `keyValue` is reported back to the caller as their own key.
 */
function writeErrorFor(
	outcome: DocumentOutcome,
	insertedId: ObjectId | string | number | undefined,
): WriteError {
	const error = withTypedDuplicateId(
		outcome.error,
		insertedId === undefined ? [] : [insertedId],
	);
	const server = error instanceof MongoServerError ? error : undefined;

	return {
		index: outcome.index,
		code: server?.code ?? MongoErrorCode.UnknownError,
		errmsg: error instanceof Error ? error.message : String(error),
		...(server?.keyPattern ? { keyPattern: server.keyPattern } : {}),
		...(server?.keyValue ? { keyValue: server.keyValue } : {}),
	};
}

/**
 * The error a partially applied batch throws.
 *
 * Its top-level `code`, `keyPattern` and `keyValue` are the first refusal's, which
 * is what MongoDB does: a caller checking `err.code === 11000` without walking
 * `writeErrors` still gets a true answer about why the batch stopped.
 */
function bulkWriteError(
	writeErrors: WriteError[],
	result: BulkWriteOutcome,
	first: DocumentOutcome,
	firstId: ObjectId | string | number | undefined,
): MongoBulkWriteError {
	const cause = withTypedDuplicateId(
		first.error,
		firstId === undefined ? [] : [firstId],
	);
	const server = cause instanceof MongoServerError ? cause : undefined;
	const message = cause instanceof Error ? cause.message : String(cause);

	return new MongoBulkWriteError(message, {
		code: server?.code ?? MongoErrorCode.UnknownError,
		cause,
		writeErrors,
		result,
		...(server?.keyPattern ? { keyPattern: server.keyPattern } : {}),
		...(server?.keyValue ? { keyValue: server.keyValue } : {}),
	});
}
