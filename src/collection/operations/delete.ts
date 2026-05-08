/**
 * `deleteOne` / `deleteMany` operations.
 */

import { translateFilter } from "../../translators/filter.ts";
import type { DeleteResult, Document, Filter } from "../../types.ts";
import { makeDeleteResult } from "../../utils/result.ts";
import {
	filterOptionsFor,
	type OperationContext,
} from "../operation-context.ts";

export async function deleteOne<TSchema extends Document>(
	ctx: OperationContext,
	filter: Filter<TSchema>,
): Promise<DeleteResult> {
	const { clause, bindings } = translateFilter(
		filter as Document,
		filterOptionsFor(ctx),
	);

	let findSql = `SELECT id FROM ${ctx.escapedTable}`;
	if (clause) findSql += ` WHERE ${clause}`;
	findSql += " LIMIT 1";

	const found = await ctx.executor.query<Record<string, unknown>[]>(
		findSql,
		bindings,
	);

	if (!found || found.length === 0) {
		return makeDeleteResult(0);
	}

	const rows = await ctx.executor.query<Record<string, unknown>[]>(
		"DELETE $__rid RETURN BEFORE",
		{ __rid: found[0].id },
	);
	return makeDeleteResult(rows ? rows.length : 0);
}

export async function deleteMany<TSchema extends Document>(
	ctx: OperationContext,
	filter?: Filter<TSchema>,
): Promise<DeleteResult> {
	const { clause, bindings } = translateFilter(
		filter as Document,
		filterOptionsFor(ctx),
	);

	let sql = `DELETE FROM ${ctx.escapedTable}`;
	if (clause) sql += ` WHERE ${clause}`;
	sql += " RETURN BEFORE";

	const rows = await ctx.executor.query<Record<string, unknown>[]>(
		sql,
		bindings,
	);
	return makeDeleteResult(rows ? rows.length : 0);
}
