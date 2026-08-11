/**
 * `deleteOne` / `deleteMany` operations.
 */

import { statement } from "../../surreal/sql/statement.ts";
import { translateFilter } from "../../translators/filter.ts";
import type {
	DeleteOptions,
	DeleteResult,
	Document,
	Filter,
} from "../../types.ts";
import { makeDeleteResult } from "../../utils/result.ts";
import { applyUndefinedPolicy } from "../../utils/undefined.ts";
import {
	filterOptionsFor,
	type OperationContext,
} from "../operation-context.ts";
import { resolveOperationPlan } from "../operation-options.ts";
import { selectOneId } from "./find.ts";

export async function deleteOne<TSchema extends Document>(
	ctx: OperationContext,
	filter: Filter<TSchema>,
	options?: DeleteOptions,
): Promise<DeleteResult> {
	const plan = await resolveOperationPlan(ctx, options, { indexHint: true });

	const { clause, bindings } = translateFilter(
		applyUndefinedPolicy(filter as Document, plan.ignoreUndefined),
		await filterOptionsFor(ctx, filter as Document),
	);

	const rid = await selectOneId(ctx, clause, plan, bindings);

	if (rid === undefined) {
		return makeDeleteResult(0);
	}

	const rows = await ctx.executor.query<Record<string, unknown>[]>(
		statement("DELETE $__rid RETURN BEFORE", plan.timeout),
		{ __rid: rid },
	);
	return makeDeleteResult(rows ? rows.length : 0);
}

export async function deleteMany<TSchema extends Document>(
	ctx: OperationContext,
	filter?: Filter<TSchema>,
	options?: DeleteOptions,
): Promise<DeleteResult> {
	const plan = await resolveOperationPlan(ctx, options, { indexHint: true });

	const { clause, bindings } = translateFilter(
		applyUndefinedPolicy(filter as Document, plan.ignoreUndefined),
		await filterOptionsFor(ctx, filter as Document),
	);

	const sql = statement(
		`DELETE FROM ${ctx.escapedTable}`,
		plan.indexHint,
		clause && `WHERE ${clause}`,
		"RETURN BEFORE",
		plan.timeout,
	);

	const rows = await ctx.executor.query<Record<string, unknown>[]>(
		sql,
		bindings,
	);
	return makeDeleteResult(rows ? rows.length : 0);
}
