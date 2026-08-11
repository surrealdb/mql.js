/**
 * `distinct` operation.
 */

import { escapeFieldPath } from "../../surreal/sql/escape.ts";
import {
	isIdField,
	SURREAL_ID_FIELD,
} from "../../translators/filter/id-field.ts";
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
		await filterOptionsFor(ctx, filter as Document),
	);

	// `_id` is stored as SurrealDB's `id` column.
	const column = isIdField(key) ? SURREAL_ID_FIELD : escapeFieldPath(key);
	let sql = `SELECT array::distinct(${column}) AS vals FROM ${ctx.escapedTable}`;
	if (clause) sql += ` WHERE ${clause}`;
	sql += " GROUP ALL";

	const rows = await ctx.executor.query<{ vals: T[] }[]>(sql, bindings);

	if (!rows || rows.length === 0) return [];
	return rows[0].vals ?? [];
}
