/**
 * `distinct` operation.
 */

import { escapeFieldPath } from "../../surreal/sql/escape.ts";
import { statement } from "../../surreal/sql/statement.ts";
import {
	isIdField,
	SURREAL_ID_FIELD,
} from "../../translators/filter/id-field.ts";
import { translateFilter } from "../../translators/filter.ts";
import type { DistinctOptions, Document, Filter } from "../../types.ts";
import { applyUndefinedPolicy } from "../../utils/undefined.ts";
import {
	filterOptionsFor,
	type OperationContext,
} from "../operation-context.ts";
import { resolveOperationPlan } from "../operation-options.ts";

export async function distinct<
	T = unknown,
	TSchema extends Document = Document,
>(
	ctx: OperationContext,
	key: string,
	filter?: Filter<TSchema>,
	options?: DistinctOptions,
): Promise<T[]> {
	const plan = await resolveOperationPlan(ctx, options, { indexHint: true });

	const { clause, bindings } = translateFilter(
		applyUndefinedPolicy(filter as Document, plan.ignoreUndefined),
		await filterOptionsFor(ctx, filter as Document),
	);

	// `_id` is stored as SurrealDB's `id` column.
	const column = isIdField(key) ? SURREAL_ID_FIELD : escapeFieldPath(key);
	const sql = statement(
		`SELECT array::distinct(${column}) AS vals FROM ${ctx.escapedTable}`,
		plan.indexHint,
		clause && `WHERE ${clause}`,
		"GROUP ALL",
		plan.timeout,
	);

	const rows = await ctx.executor.query<{ vals: T[] }[]>(sql, bindings);

	if (!rows || rows.length === 0) return [];
	return rows[0].vals ?? [];
}
