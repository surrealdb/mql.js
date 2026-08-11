/**
 * `countDocuments` and `estimatedDocumentCount` operations.
 */

import { translateFilter } from "../../translators/filter.ts";
import type { CountDocumentsOptions, Document, Filter } from "../../types.ts";
import {
	filterOptionsFor,
	type OperationContext,
} from "../operation-context.ts";

export async function countDocuments<TSchema extends Document>(
	ctx: OperationContext,
	filter?: Filter<TSchema>,
	options?: CountDocumentsOptions,
): Promise<number> {
	const { clause, bindings } = translateFilter(
		filter as Document,
		await filterOptionsFor(ctx, filter as Document),
	);

	let sql = `SELECT count() AS count FROM ${ctx.escapedTable}`;
	if (clause) sql += ` WHERE ${clause}`;
	sql += " GROUP ALL";
	if (options?.skip) sql += ` START ${options.skip}`;
	if (options?.limit) sql += ` LIMIT ${options.limit}`;

	const rows = await ctx.executor.query<{ count: number }[]>(sql, bindings);

	if (!rows || rows.length === 0) return 0;
	return rows[0].count ?? 0;
}

export function estimatedDocumentCount(ctx: OperationContext): Promise<number> {
	return countDocuments(ctx);
}
