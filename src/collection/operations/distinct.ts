/**
 * `distinct` operation.
 */

import { escapeFieldPath } from "../../surreal/sql/escape.ts";
import { translateFilter } from "../../translators/filter.ts";
import type { Document, Filter } from "../../types.ts";
import {
	filterOptionsFor,
	type OperationContext,
} from "../operation-context.ts";

export async function distinct<
	T = unknown,
	TSchema extends Document = Document,
>(ctx: OperationContext, key: string, filter?: Filter<TSchema>): Promise<T[]> {
	const { clause, bindings } = translateFilter(
		filter as Document,
		filterOptionsFor(ctx),
	);

	let sql = `SELECT array::distinct(${escapeFieldPath(key)}) AS vals FROM ${ctx.escapedTable}`;
	if (clause) sql += ` WHERE ${clause}`;
	sql += " GROUP ALL";

	const rows = await ctx.executor.query<{ vals: T[] }[]>(sql, bindings);

	if (!rows || rows.length === 0) return [];
	return rows[0].vals ?? [];
}
