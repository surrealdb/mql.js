/**
 * `findOne` and the cursor-driven `find()` execution.
 *
 * `executeFind` is exported so the cursor can run the query lazily;
 * `findOne` is a thin synchronous helper that re-uses the same SQL
 * pipeline with `LIMIT 1`.
 */

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
import { resolveOperationPlan } from "../operation-options.ts";
import { readProjection, readSource } from "./read-source.ts";
import { selectRows } from "./select-rows.ts";

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
	const source = readSource(ctx.escapedTable, clause, plan.indexHint, {
		sortClause: translateSort(options?.sort),
		sortFields: sortColumns(options?.sort),
		nearDistance,
		fields: proj.fields,
		limit: 1,
		skip: undefined,
	});

	const sql = statement(
		`SELECT ${readProjection(proj.fields, source.omit)} FROM ${source.from}`,
		source.indexHint,
		source.where && `WHERE ${source.where}`,
		source.orderBy,
		source.limit,
		plan.timeout,
	);

	const rows = await selectRows(ctx, sql, bindings);

	if (rows.length === 0) return null;

	let doc = recordToDocument<TSchema>(rows[0]);
	if (proj.isExclusion || !proj.includeId) {
		doc = applyProjection(doc, proj.excludeFields, proj.includeId) as TSchema;
	}
	return doc;
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

	const { clause, bindings, nearDistance } = translateFilter(
		applyUndefinedPolicy(filter, plan.ignoreUndefined),
		await filterOptionsFor(ctx, filter),
	);
	const fields = state.projectionFields ?? "";
	const source = readSource(ctx.escapedTable, clause, plan.indexHint, {
		sortClause: translateSort(state.sort),
		sortFields: sortColumns(state.sort),
		nearDistance,
		fields,
		limit: state.limit,
		skip: state.skip,
	});

	const sql = statement(
		`SELECT ${readProjection(fields, source.omit)} FROM ${source.from}`,
		source.indexHint,
		source.where && `WHERE ${source.where}`,
		source.orderBy,
		source.limit,
		source.start,
		plan.timeout,
	);

	const rows = await selectRows(ctx, sql, bindings);

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
