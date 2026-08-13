/**
 * The shared machinery of the single-document writes: `updateOne`, `deleteOne`,
 * `replaceOne` and the three `findOneAnd*`.
 *
 * All six mean the same thing — find the one document the filter matches, under
 * the caller's `sort` where there is one, and modify *that* document — and
 * MongoDB performs each of them atomically. SurrealQL accepts neither `ORDER BY`
 * nor `LIMIT` on `UPDATE`/`DELETE`, so the record has to be named some other
 * way, and the way it is named decides how nearly that atomicity is reproduced:
 *
 *   - resolving the id in one round trip and writing it in the next leaves a
 *     window a whole network hop wide, in which another client can delete the
 *     row or change it out of the filter, so the write lands on a document that
 *     no longer matches. Measured against a live 3.2 server, four clients racing
 *     to claim one pending document produced two or more winners in **498 of 500
 *     attempts**;
 *   - naming it in a *subquery* of the write makes the pair one statement, and
 *     one SurrealQL statement is one transaction. That closes the window: the
 *     same contest produced a single winner in **972 of 1000 attempts**, the
 *     losers seeing what MongoDB shows them — no match.
 *
 * The remaining few per cent were not the shape's, and not this driver's to fix.
 * Two transactions could both read the record, both commit, and the second write
 * be dropped with no conflict reported — so both callers were told
 * `modifiedCount: 1` and one of the writes was simply not there. It belongs to
 * the **in-memory storage engine**, and the way to see that is to change nothing
 * but the engine: the same statements, on the same 3.2.3 binary, over 1600
 * contests on `rocksdb` produced a single winner every time, while `memory`
 * produced 10 double claims in 3000. `rocksdb` also reported two to three times
 * as many conflicts, which is the same fact from the other side — the collisions
 * `memory` lost are the ones it failed to detect. Fixed in SurrealDB 3.3.0.
 *
 * Wrapping the statement in an explicit transaction does not substitute for that
 * fix, which is worth stating because it looks as though it should: on the
 * in-memory engine `BEGIN`/`COMMIT` around the identical statement still produced
 * 4 double claims in 3000 contests. An earlier note here claimed otherwise on the
 * strength of 500 clean attempts, which at a rate near 0.1% is what a run that
 * simply never hit it looks like.
 *
 * So the single statement stays, and it is also the cheapest of the three shapes
 * — one round trip instead of two, 0.115 ms against 0.216 ms per uncontended
 * `updateOne`, where an explicit transaction around the pair costs 0.312 ms.
 * Paying that on every write would not have bought the guarantee anyway. A
 * caller's session still carries these statements, because SurrealDB refuses
 * `BEGIN` inside a transaction and an operation given one has to join it rather
 * than open another; it just is not the reason the write is atomic.
 */

import { MongoErrorCode, MongoServerError } from "../../errors.ts";
import { isMissingTableError } from "../../surreal/error-mapper.ts";
import { escapeIdentifier } from "../../surreal/sql/escape.ts";
import { statement } from "../../surreal/sql/statement.ts";
import { SURREAL_ID_FIELD } from "../../translators/filter/id-field.ts";
import { sortColumns, translateSort } from "../../translators/sort.ts";
import type { Sort } from "../../types.ts";
import type { OperationContext } from "../operation-context.ts";
import type { OperationPlan } from "../operation-options.ts";
import { DISTANCE_ALIAS } from "./read-source.ts";

/**
 * How many times a write conflict is re-issued before it reaches the caller.
 *
 * Contention resolves as soon as the winner has committed, so the retry is
 * short-lived by nature: across 300 contests between eight clients for one
 * document — 2400 statements, most of them losers — not one conflict reached the
 * caller. Five bounds a pathological hot key rather than sizing the common case.
 */
const CONFLICT_ATTEMPTS = 5;

/** First backoff between attempts, doubling from there. */
const CONFLICT_BACKOFF_MS = 1;

/**
 * The SurrealQL expression naming the one record a write will touch.
 *
 * Spliced in where `UPDATE`/`DELETE` take their target, so the record is chosen
 * and modified inside a single statement.
 */
export function oneRecordTarget(
	ctx: OperationContext,
	whereClause: string,
	plan: OperationPlan,
	sort?: Sort | null,
	nearDistance?: string,
): string {
	const sortClause = translateSort(sort);

	// Every column the sort orders by is selected alongside `id`, because
	// SurrealDB refuses an `ORDER BY` naming an idiom the field list does not:
	// `SELECT id FROM t ORDER BY k` is a parse error. The enclosing
	// `SELECT VALUE id` then reduces each row to the bare record id a write
	// target takes, discarding the sort columns nothing reads.
	//
	// A `$near` orders by distance, which is why it has to be projected under an
	// alias here too rather than named in the `ORDER BY` — the same rule, and the
	// same reason as in `near-query.ts`. An explicit sort wins over it, as it does
	// in MongoDB, in which case the distance is not projected at all.
	const distance = sortClause ? undefined : nearDistance;
	const alias = escapeIdentifier(DISTANCE_ALIAS);
	const columns = [
		SURREAL_ID_FIELD,
		...sortColumns(sort)
			.map((column) => column.column)
			.filter((column) => column !== SURREAL_ID_FIELD),
	];
	if (distance) columns.push(`${distance} AS ${alias}`);

	const match = statement(
		`SELECT ${columns.join(", ")} FROM ${ctx.escapedTable}`,
		plan.indexHint,
		whereClause && `WHERE ${whereClause}`,
		sortClause || (distance && `ORDER BY ${alias} ASC`),
		"LIMIT 1",
	);

	// The caller's `TIMEOUT` goes on the enclosing statement, which bounds the
	// subquery with it; SurrealQL takes only one and it has to come last.
	return `(SELECT VALUE id FROM (${match}))`;
}

/**
 * Run a single-document write and return the records it touched.
 *
 * Two failures are answered here rather than passed on, because neither is
 * something the caller did:
 *
 *   - a collection that has never been written to matches nothing in MongoDB —
 *     and an `upsert` then creates it — while SurrealDB refuses to read a table
 *     it holds no definition for. Reading that refusal as "no match" is what
 *     makes `updateOne(filter, update, {upsert: true})` create the first
 *     document of a collection, and `deleteOne` on an empty collection a
 *     `deletedCount` of `0`. Only *this* collection being undefined counts, and
 *     only as a missing table — see `isMissingTableError`, which is what keeps a
 *     mistyped database name from reading as an empty one;
 *   - a write conflict means a concurrent transaction reached the same record
 *     first, and that the statement rolled back whole — so re-issuing it can
 *     neither duplicate nor half-apply anything. MongoDB resolves the same
 *     contention by serialising rather than by failing, so re-issuing is what
 *     restores the answer a caller expects: the loser of a race sees the
 *     document already gone, not an error class MongoDB never raises.
 *
 * A conflict inside a caller's transaction is left alone. It belongs to that
 * transaction, which the server has already given up on; only re-running the
 * whole of it can clear the conflict, which is what `withTransaction` does with
 * the `TransientTransactionError` label the conflict carries.
 */
export function writeOneRecord(
	ctx: OperationContext,
	sql: string,
	bindings: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
	return run<Record<string, unknown>>(ctx, sql, bindings);
}

/**
 * Whether the filter matches anything at all.
 *
 * For the one operation that has to know before it writes: `updateMany` with
 * `upsert` either updates every match or inserts exactly one document, and no
 * single statement expresses both.
 */
export async function matchesAnyRecord(
	ctx: OperationContext,
	whereClause: string,
	plan: OperationPlan,
	bindings: Record<string, unknown>,
): Promise<boolean> {
	const ids = await run<unknown>(
		ctx,
		statement(
			`SELECT VALUE id FROM ${ctx.escapedTable}`,
			plan.indexHint,
			whereClause && `WHERE ${whereClause}`,
			"LIMIT 1",
			plan.timeout,
		),
		bindings,
	);
	return ids.length > 0;
}

/** The retrying, missing-collection-tolerant execution both of the above share. */
async function run<T>(
	ctx: OperationContext,
	sql: string,
	bindings: Record<string, unknown>,
): Promise<T[]> {
	for (let attempt = 1; ; attempt++) {
		try {
			return (await ctx.executor.query<T[]>(sql, bindings)) ?? [];
		} catch (err) {
			if (isMissingTableError(err, ctx.collectionName)) return [];
			if (
				ctx.inTransaction ||
				attempt >= CONFLICT_ATTEMPTS ||
				!isWriteConflict(err)
			) {
				throw err;
			}
			await sleep(Math.random() * CONFLICT_BACKOFF_MS * 2 ** (attempt - 1));
		}
	}
}

/** A concurrent transaction having written the same record first. */
function isWriteConflict(err: unknown): boolean {
	return (
		err instanceof MongoServerError && err.code === MongoErrorCode.WriteConflict
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
