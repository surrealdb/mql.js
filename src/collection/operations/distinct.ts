/**
 * `distinct` operation.
 */

import { reviveBsonValues } from "../../surreal/bson-codec.ts";
import { escapeFieldPath } from "../../surreal/sql/escape.ts";
import { statement } from "../../surreal/sql/statement.ts";
import {
	isIdField,
	SURREAL_ID_FIELD,
} from "../../translators/filter/id-field.ts";
import { translateFilter } from "../../translators/filter.ts";
import type { DistinctOptions, Document, Filter } from "../../types.ts";
import { toMongoId } from "../../utils/id.ts";
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
	const values = rows[0].vals ?? [];

	// `distinct` hands raw column values to the caller rather than documents, so
	// it has to do for itself what `recordToDocument` does for a read: turn the
	// `id` column's `RecordId`s back into `_id` values, and rebuild any stored
	// `ObjectId` into the id it was written as.
	return values.map((value) =>
		isIdField(key) ? (toMongoId(value) as T) : reviveBsonValues(value),
	);
}
