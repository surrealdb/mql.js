/**
 * `deleteOne` / `deleteMany` operations.
 *
 * `deleteMany` is a single `DELETE … WHERE`; `deleteOne` names its one record in
 * a subquery, since SurrealQL takes no `LIMIT` on a delete — see
 * `modify-one.ts` for why that is a subquery rather than a prior round trip.
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
import { oneRecordTarget, writeOneRecord } from "./modify-one.ts";

export async function deleteOne<TSchema extends Document>(
	ctx: OperationContext,
	filter: Filter<TSchema>,
	options?: DeleteOptions,
): Promise<DeleteResult> {
	const plan = await resolveOperationPlan(ctx, options, { indexHint: true });

	const { clause, bindings, nearDistance } = translateFilter(
		applyUndefinedPolicy(filter as Document, plan.ignoreUndefined),
		await filterOptionsFor(ctx, filter as Document),
	);

	const rows = await writeOneRecord(
		ctx,
		statement(
			`DELETE ${oneRecordTarget(ctx, clause, plan, undefined, nearDistance)}`,
			"RETURN BEFORE",
			plan.timeout,
		),
		bindings,
	);
	return makeDeleteResult(rows.length);
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
