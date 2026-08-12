/**
 * `updateOne` / `updateMany` operations.
 *
 * SurrealQL doesn't accept `LIMIT` on `UPDATE`, so `updateOne` names its one
 * record in a subquery of the update — one statement, so the match and the write
 * cannot be separated (see `modify-one.ts`) — while `updateMany` operates on the
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
import {
	matchesAnyRecord,
	oneRecordTarget,
	writeOneRecord,
} from "./modify-one.ts";
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

	const {
		clause: whereClause,
		bindings: filterBindings,
		nearDistance,
	} = translateFilter(criteria, await filterOptionsFor(ctx, filter));

	if (single) {
		const rows = await updateOneMatch(
			ctx,
			whereClause,
			filterBindings,
			document,
			plan,
			options,
			nearDistance,
		);
		if (rows.length > 0 || !options?.upsert) return makeUpdateResult(rows);
		const inserted = await insertUpserted(
			ctx,
			criteria,
			document,
			plan,
			options,
		);
		return makeUpdateResult([], inserted.insertedId);
	}

	// An upsert has to know whether *anything* matches before it writes: MongoDB
	// updates every match, or inserts exactly one document when there are none,
	// and no single statement says both.
	if (
		options?.upsert &&
		!(await matchesAnyRecord(ctx, whereClause, plan, filterBindings))
	) {
		const inserted = await insertUpserted(
			ctx,
			criteria,
			document,
			plan,
			options,
		);
		return makeUpdateResult([], inserted.insertedId);
	}

	return updateWhere(ctx, whereClause, filterBindings, document, plan, options);
}

/** Update the single record the filter picks out, and report what it touched. */
async function updateOneMatch(
	ctx: OperationContext,
	whereClause: string,
	filterBindings: Record<string, unknown>,
	update: Document,
	plan: OperationPlan,
	options?: UpdateOptions,
	nearDistance?: string,
): Promise<Record<string, unknown>[]> {
	const { clause, bindings } = translateUpdate(
		update,
		Object.keys(filterBindings).length,
		{ arrayFilters: options?.arrayFilters },
	);

	return writeOneRecord(
		ctx,
		statement(
			`UPDATE ${oneRecordTarget(ctx, whereClause, plan, undefined, nearDistance)}`,
			clause,
			plan.timeout,
		),
		{ ...filterBindings, ...bindings },
	);
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
