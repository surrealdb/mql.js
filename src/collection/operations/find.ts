/**
 * `findOne` and the cursor-driven `find()` execution.
 *
 * `executeFind` is exported so the cursor can run the query lazily;
 * `findOne` is a thin synchronous helper that re-uses the same SQL
 * pipeline with `LIMIT 1`.
 */

import { isMissingTableError } from "../../surreal/error-mapper.ts";
import {
	deferredRows,
	mapRows,
	rowsOrNoneWhen,
} from "../../surreal/row-stream.ts";
import { statement } from "../../surreal/sql/statement.ts";
import { translateFilter } from "../../translators/filter.ts";
import { translateProjection } from "../../translators/projection.ts";
import { sortColumns, translateSort } from "../../translators/sort.ts";
import type { Document, Filter, FindOptions, Sort } from "../../types.ts";
import { recordToDocument } from "../../utils/id.ts";
import { applyUndefinedPolicy } from "../../utils/undefined.ts";
import {
	filterOptionsFor,
	type OperationContext,
} from "../operation-context.ts";
import { resolveOperationPlan } from "../operation-options.ts";
import { projectionOmit, readProjection, readSource } from "./read-source.ts";
import { selectRows } from "./select-rows.ts";

/** Combine a `$near` subquery's own omit with the caller's excluded fields. */
function combineOmit(sourceOmit: string, projectionOmitClause: string): string {
	return [sourceOmit, projectionOmitClause].filter(Boolean).join(", ");
}

export async function findOne<TSchema extends Document>(
	ctx: OperationContext,
	filter?: Filter<TSchema>,
	options?: FindOptions,
): Promise<TSchema | null> {
	const plan = await resolveOperationPlan(ctx, options, { indexHint: true });

	const { clause, bindings, nearDistance } = translateFilter(
		applyUndefinedPolicy(filter as Document, plan.ignoreUndefined),
		await filterOptionsFor(ctx, filter as Document),
	);
	const proj = translateProjection(options?.projection);
	const omit = projectionOmit(proj.excludeFields, proj.includeId);
	const source = readSource(ctx.escapedTable, clause, plan.indexHint, {
		sortClause: translateSort(options?.sort),
		sortFields: sortColumns(options?.sort),
		nearDistance,
		columns: proj.columns,
		limit: 1,
		skip: undefined,
	});

	const sql = statement(
		`SELECT ${readProjection(proj.columns, combineOmit(source.omit, omit))} FROM ${source.from}`,
		source.indexHint,
		source.where && `WHERE ${source.where}`,
		source.orderBy,
		source.limit,
		plan.timeout,
	);

	const rows = await selectRows(ctx, sql, bindings);

	if (rows.length === 0) return null;

	return recordToDocument<TSchema>(rows[0]);
}

/** Options resolved by the cursor before delegating to `executeFind`. */
export interface ExecuteFindOptions {
	sort?: Sort;
	limit?: number;
	skip?: number;
	projectionColumns?: readonly string[];
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
	const { sql, bindings } = await planFind(ctx, filter, state, options);
	const rows = await selectRows(ctx, sql, bindings);

	return rows.map((r) => recordToDocument<TSchema>(r));
}

/**
 * The same query as `executeFind`, read a document at a time as the server
 * produces them.
 *
 * Nothing is built or sent until the first read, so a cursor that is created and
 * never consumed costs nothing, and a translation refusal surfaces from the
 * first read exactly where `executeFind`'s would have.
 */
export function streamFind<TSchema extends Document>(
	ctx: OperationContext,
	filter: Document | undefined,
	state: ExecuteFindOptions,
	options?: FindOptions,
): AsyncIterableIterator<TSchema> {
	const rows = deferredRows(async () => {
		const { sql, bindings } = await planFind(ctx, filter, state, options);
		return ctx.executor.queryRows<Record<string, unknown>>(sql, bindings);
	});

	return mapRows(
		// A collection that was never written to reads as empty, as `selectRows`
		// makes it for the buffered path.
		rowsOrNoneWhen(rows, (err) => isMissingTableError(err, ctx.collectionName)),
		(row) => recordToDocument<TSchema>(row),
	);
}

/** The statement a cursor's state compiles to, and what it binds. */
async function planFind(
	ctx: OperationContext,
	filter: Document | undefined,
	state: ExecuteFindOptions,
	options?: FindOptions,
): Promise<{ sql: string; bindings: Record<string, unknown> }> {
	const plan = await resolveOperationPlan(ctx, options, { indexHint: true });

	const { clause, bindings, nearDistance } = translateFilter(
		applyUndefinedPolicy(filter, plan.ignoreUndefined),
		await filterOptionsFor(ctx, filter),
	);
	const columns = state.projectionColumns ?? [];
	const omit = projectionOmit(
		state.projectionExcludeFields ?? [],
		state.projectionIncludeId ?? true,
	);
	const source = readSource(ctx.escapedTable, clause, plan.indexHint, {
		sortClause: translateSort(state.sort),
		sortFields: sortColumns(state.sort),
		nearDistance,
		columns,
		limit: state.limit,
		skip: state.skip,
	});

	const sql = statement(
		`SELECT ${readProjection(columns, combineOmit(source.omit, omit))} FROM ${source.from}`,
		source.indexHint,
		source.where && `WHERE ${source.where}`,
		source.orderBy,
		source.limit,
		source.start,
		plan.timeout,
	);

	return { sql, bindings };
}
