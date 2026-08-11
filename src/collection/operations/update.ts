/**
 * `updateOne` / `updateMany` operations.
 *
 * SurrealQL doesn't accept `LIMIT` on `UPDATE`, so `updateOne` finds the
 * matching record id first and updates it by id; `updateMany` operates on the
 * whole table through its `WHERE` clause.
 *
 * `upsert` also resolves the match itself rather than deferring to SurrealDB's
 * `UPSERT … WHERE`, because MongoDB's insert is built from the filter — see
 * `upsert.ts`.
 */

import { statement } from "../../surreal/sql/statement.ts";
import { translateFilter } from "../../translators/filter.ts";
import { translateUpdate } from "../../translators/update.ts";
import type {
	Document,
	Filter,
	UpdateFilter,
	UpdateOptions,
	UpdateResult,
} from "../../types.ts";
import { makeUpdateResult } from "../../utils/result.ts";
import { applyUndefinedPolicy } from "../../utils/undefined.ts";
import {
	filterOptionsFor,
	type OperationContext,
} from "../operation-context.ts";
import {
	type OperationPlan,
	resolveOperationPlan,
} from "../operation-options.ts";
import { selectOneId } from "./find.ts";
import { insertUpserted } from "./upsert.ts";

export async function updateOne<TSchema extends Document>(
	ctx: OperationContext,
	filter: Filter<TSchema>,
	update: UpdateFilter<TSchema>,
	options?: UpdateOptions,
): Promise<UpdateResult> {
	return runUpdate(ctx, filter as Document, update as Document, options, true);
}

export async function updateMany<TSchema extends Document>(
	ctx: OperationContext,
	filter: Filter<TSchema>,
	update: UpdateFilter<TSchema>,
	options?: UpdateOptions,
): Promise<UpdateResult> {
	return runUpdate(ctx, filter as Document, update as Document, options, false);
}

async function runUpdate(
	ctx: OperationContext,
	filter: Document,
	update: Document,
	options: UpdateOptions | undefined,
	single: boolean,
): Promise<UpdateResult> {
	const plan = await resolveOperationPlan(ctx, options, { indexHint: true });
	const document = applyUndefinedPolicy(update, plan.ignoreUndefined);
	const criteria = applyUndefinedPolicy(filter, plan.ignoreUndefined);

	const { clause: whereClause, bindings: filterBindings } = translateFilter(
		criteria,
		await filterOptionsFor(ctx, filter),
	);

	// `updateOne` has to know which record to touch, and an upsert has to know
	// whether to touch one at all, so both resolve the match before writing.
	if (single || options?.upsert) {
		const rid = await selectOneId(ctx, whereClause, plan, filterBindings);

		if (rid === undefined) {
			if (!options?.upsert) return makeUpdateResult([]);
			const inserted = await insertUpserted(
				ctx,
				criteria,
				document,
				plan,
				options,
			);
			return makeUpdateResult([], inserted.insertedId);
		}

		if (single) {
			return updateById(ctx, rid, document, plan, options);
		}
	}

	return updateWhere(ctx, whereClause, filterBindings, document, plan, options);
}

/** Update the one record `rid` addresses. */
async function updateById(
	ctx: OperationContext,
	rid: unknown,
	update: Document,
	plan: OperationPlan,
	options?: UpdateOptions,
): Promise<UpdateResult> {
	const { clause, bindings } = translateUpdate(update, 0, {
		arrayFilters: options?.arrayFilters,
	});

	const rows = await ctx.executor.query<Record<string, unknown>[]>(
		statement("UPDATE $__rid", clause, plan.timeout),
		{ ...bindings, __rid: rid },
	);
	return makeUpdateResult(rows || []);
}

/** Update every record the filter matches. */
async function updateWhere(
	ctx: OperationContext,
	whereClause: string,
	filterBindings: Record<string, unknown>,
	update: Document,
	plan: OperationPlan,
	options?: UpdateOptions,
): Promise<UpdateResult> {
	const { clause, bindings } = translateUpdate(
		update,
		Object.keys(filterBindings).length,
		{ arrayFilters: options?.arrayFilters },
	);

	const sql = statement(
		`UPDATE ${ctx.escapedTable}`,
		plan.indexHint,
		clause,
		whereClause && `WHERE ${whereClause}`,
		plan.timeout,
	);

	const rows = await ctx.executor.query<Record<string, unknown>[]>(sql, {
		...filterBindings,
		...bindings,
	});
	return makeUpdateResult(rows || []);
}
