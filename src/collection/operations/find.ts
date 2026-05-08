/**
 * `findOne` and the cursor-driven `find()` execution.
 *
 * `executeFind` is exported so the cursor can run the query lazily;
 * `findOne` is a thin synchronous helper that re-uses the same SQL
 * pipeline with `LIMIT 1`.
 */

import { translateFilter } from "../../translators/filter.ts";
import { translateProjection } from "../../translators/projection.ts";
import { translateSort } from "../../translators/sort.ts";
import type { Document, Filter, FindOptions, Sort } from "../../types.ts";
import { applyProjection, recordToDocument } from "../../utils/id.ts";
import {
	filterOptionsFor,
	type OperationContext,
} from "../operation-context.ts";

export async function findOne<TSchema extends Document>(
	ctx: OperationContext,
	filter?: Filter<TSchema>,
	options?: FindOptions,
): Promise<TSchema | null> {
	const { clause, bindings, nearSort } = translateFilter(
		filter as Document,
		filterOptionsFor(ctx),
	);
	const proj = translateProjection(options?.projection);
	const sortClause = translateSort(options?.sort) || nearSort || "";

	const fields = proj.fields || "*";
	let sql = `SELECT ${fields} FROM ${ctx.escapedTable}`;
	if (clause) sql += ` WHERE ${clause}`;
	if (sortClause) sql += ` ${sortClause}`;
	sql += " LIMIT 1";

	const rows = await ctx.executor.query<Record<string, unknown>[]>(
		sql,
		bindings,
	);

	if (!rows || rows.length === 0) return null;

	let doc = recordToDocument<TSchema>(rows[0]);
	if (proj.isExclusion || !proj.includeId) {
		doc = applyProjection(doc, proj.excludeFields, proj.includeId) as TSchema;
	}
	return doc;
}

/** Options resolved by the cursor before delegating to `executeFind`. */
export interface ExecuteFindOptions {
	sort?: Sort;
	limit?: number;
	skip?: number;
	projectionFields?: string;
	projectionExcludeFields?: string[];
	projectionIncludeId?: boolean;
}

export async function executeFind<TSchema extends Document>(
	ctx: OperationContext,
	filter: Document | undefined,
	options: ExecuteFindOptions,
): Promise<TSchema[]> {
	const { clause, bindings, nearSort } = translateFilter(
		filter,
		filterOptionsFor(ctx),
	);
	const sortClause = translateSort(options.sort) || nearSort || "";

	const fields = options.projectionFields || "*";
	let sql = `SELECT ${fields} FROM ${ctx.escapedTable}`;
	if (clause) sql += ` WHERE ${clause}`;
	if (sortClause) sql += ` ${sortClause}`;
	if (options.limit !== undefined) sql += ` LIMIT ${options.limit}`;
	if (options.skip !== undefined) sql += ` START ${options.skip}`;

	const rows =
		(await ctx.executor.query<Record<string, unknown>[]>(sql, bindings)) ?? [];

	let docs = rows.map((r) => recordToDocument<TSchema>(r));

	const needsPostProcess =
		(options.projectionExcludeFields &&
			options.projectionExcludeFields.length > 0) ||
		options.projectionIncludeId === false;

	if (needsPostProcess) {
		docs = docs.map(
			(d) =>
				applyProjection(
					d,
					options.projectionExcludeFields ?? [],
					options.projectionIncludeId ?? true,
				) as TSchema,
		);
	}

	return docs;
}
