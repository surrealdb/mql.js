/**
 * `findOne` and the cursor-driven `find()` execution.
 *
 * `executeFind` is exported so the cursor can run the query lazily;
 * `findOne` is a thin synchronous helper that re-uses the same SQL
 * pipeline with `LIMIT 1`.
 */

import { MongoErrorCode, MongoServerError } from "../../errors.ts";
import { statement } from "../../surreal/sql/statement.ts";
import { translateFilter } from "../../translators/filter.ts";
import { translateProjection } from "../../translators/projection.ts";
import { sortColumns, translateSort } from "../../translators/sort.ts";
import type { Document, Filter, FindOptions, Sort } from "../../types.ts";
import { applyProjection, recordToDocument } from "../../utils/id.ts";
import { applyUndefinedPolicy } from "../../utils/undefined.ts";
import {
	filterOptionsFor,
	type OperationContext,
} from "../operation-context.ts";
import {
	type OperationPlan,
	resolveOperationPlan,
} from "../operation-options.ts";

export async function findOne<TSchema extends Document>(
	ctx: OperationContext,
	filter?: Filter<TSchema>,
	options?: FindOptions,
): Promise<TSchema | null> {
	const plan = await resolveOperationPlan(ctx, options, { indexHint: true });

	const { clause, bindings, nearSort } = translateFilter(
		applyUndefinedPolicy(filter as Document, plan.ignoreUndefined),
		await filterOptionsFor(ctx, filter as Document),
	);
	const proj = translateProjection(options?.projection);
	const sortClause = translateSort(options?.sort) || nearSort || "";

	const sql = statement(
		`SELECT ${proj.fields || "*"} FROM ${ctx.escapedTable}`,
		plan.indexHint,
		clause && `WHERE ${clause}`,
		sortClause,
		"LIMIT 1",
		plan.timeout,
	);

	const rows = await ctx.executor.query<Record<string, unknown>[]>(
		sql,
		bindings,
	);

	if (!rows || rows.length === 0) return null;

	let doc = recordToDocument<TSchema>(rows[0]);
	if (proj.isExclusion || !proj.includeId) {
		doc = applyProjection(doc, proj.excludeFields, proj.includeId) as TSchema;
	}
	return doc;
}

/**
 * The `SELECT id … LIMIT 1` every "modify one document" operation starts with.
 *
 * `UPDATE` and `DELETE` take no `LIMIT` in SurrealQL, so the one record to touch
 * has to be resolved first. Shared so the caller's index hint, `sort` and time
 * limit reach that lookup rather than only the write that follows it — the sort
 * in particular *is* the choice of which document gets modified.
 */
export function selectOneIdSql(
	ctx: OperationContext,
	whereClause: string,
	plan: OperationPlan,
	sort?: Sort | null,
): string {
	// Every column the sort orders by is selected alongside `id`, because
	// SurrealDB refuses an `ORDER BY` naming an idiom the field list does not:
	// `SELECT id FROM t ORDER BY k` is a parse error. Only `id` is ever read out.
	const columns = ["id", ...sortColumns(sort).filter((c) => c !== "id")];

	return statement(
		`SELECT ${columns.join(", ")} FROM ${ctx.escapedTable}`,
		plan.indexHint,
		whereClause && `WHERE ${whereClause}`,
		translateSort(sort),
		"LIMIT 1",
		plan.timeout,
	);
}

/**
 * Resolve the single record a modify-one operation will touch, or `undefined`
 * when the filter matches nothing.
 *
 * A collection that has never been written to matches nothing in MongoDB — and
 * an `upsert` then creates it — while SurrealDB refuses to read a table it holds
 * no definition for. Reading that refusal as "no match" is what makes
 * `updateOne(filter, update, { upsert: true })` create the first document of a
 * collection, and what keeps `deleteOne` on an empty collection a `deletedCount`
 * of `0` rather than an error.
 */
export async function selectOneId(
	ctx: OperationContext,
	whereClause: string,
	plan: OperationPlan,
	bindings: Record<string, unknown>,
	sort?: Sort | null,
): Promise<unknown> {
	const sql = selectOneIdSql(ctx, whereClause, plan, sort);

	let rows: Record<string, unknown>[] | undefined;
	try {
		rows = await ctx.executor.query<Record<string, unknown>[]>(sql, bindings);
	} catch (err) {
		if (!isMissingNamespace(err)) throw err;
		return undefined;
	}

	return rows && rows.length > 0 ? rows[0].id : undefined;
}

/** True for SurrealDB's refusal to read a table or database that has no definition. */
function isMissingNamespace(err: unknown): boolean {
	return (
		err instanceof MongoServerError &&
		err.code === MongoErrorCode.NamespaceNotFound
	);
}

/** Options resolved by the cursor before delegating to `executeFind`. */
export interface ExecuteFindOptions {
	sort?: Sort;
	limit?: number;
	skip?: number;
	projectionFields?: string;
	projectionExcludeFields?: string[];
	projectionIncludeId?: boolean;
}

/**
 * Run a cursor's query.
 *
 * `state` is what the cursor resolved from its chaining methods; `options` is
 * what the caller passed to `find()` and the cursor never reinterprets — the
 * index hint, the time limit and the `undefined` policy.
 */
export async function executeFind<TSchema extends Document>(
	ctx: OperationContext,
	filter: Document | undefined,
	state: ExecuteFindOptions,
	options?: FindOptions,
): Promise<TSchema[]> {
	const plan = await resolveOperationPlan(ctx, options, { indexHint: true });

	const { clause, bindings, nearSort } = translateFilter(
		applyUndefinedPolicy(filter, plan.ignoreUndefined),
		await filterOptionsFor(ctx, filter),
	);
	const sortClause = translateSort(state.sort) || nearSort || "";

	const sql = statement(
		`SELECT ${state.projectionFields || "*"} FROM ${ctx.escapedTable}`,
		plan.indexHint,
		clause && `WHERE ${clause}`,
		sortClause,
		state.limit !== undefined && `LIMIT ${state.limit}`,
		state.skip !== undefined && `START ${state.skip}`,
		plan.timeout,
	);

	const rows =
		(await ctx.executor.query<Record<string, unknown>[]>(sql, bindings)) ?? [];

	let docs = rows.map((r) => recordToDocument<TSchema>(r));

	const needsPostProcess =
		(state.projectionExcludeFields &&
			state.projectionExcludeFields.length > 0) ||
		state.projectionIncludeId === false;

	if (needsPostProcess) {
		docs = docs.map(
			(d) =>
				applyProjection(
					d,
					state.projectionExcludeFields ?? [],
					state.projectionIncludeId ?? true,
				) as TSchema,
		);
	}

	return docs;
}
