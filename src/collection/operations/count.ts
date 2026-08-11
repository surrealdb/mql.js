/**
 * `countDocuments` and `estimatedDocumentCount` operations.
 *
 * `skip` and `limit` bound the count rather than the result set, so they cannot
 * be appended to the aggregate: SurrealDB computes `count()` over the whole
 * matching set and then applies `START`/`LIMIT` to the single row that comes
 * out, leaving the count untouched. The bounded form counts a subquery that has
 * already been narrowed, which is what MongoDB's `$skip`/`$limit` stages ahead
 * of `$count` do.
 */

import { MongoInvalidArgumentError } from "../../errors.ts";
import { statement } from "../../surreal/sql/statement.ts";
import { translateFilter } from "../../translators/filter.ts";
import type {
	CountDocumentsOptions,
	Document,
	EstimatedDocumentCountOptions,
	Filter,
} from "../../types.ts";
import { applyUndefinedPolicy } from "../../utils/undefined.ts";
import {
	filterOptionsFor,
	type OperationContext,
} from "../operation-context.ts";
import {
	type OperationPlan,
	resolveOperationPlan,
} from "../operation-options.ts";

/** How far a count is bounded, once validated. */
interface CountBounds {
	readonly skip?: number;
	readonly limit?: number;
}

export async function countDocuments<TSchema extends Document>(
	ctx: OperationContext,
	filter?: Filter<TSchema>,
	options?: CountDocumentsOptions,
): Promise<number> {
	const plan = await resolveOperationPlan(ctx, options, { indexHint: true });
	const bounds = resolveBounds(options);

	const { clause, bindings } = translateFilter(
		applyUndefinedPolicy(filter as Document, plan.ignoreUndefined),
		await filterOptionsFor(ctx, filter as Document),
	);

	const rows = await ctx.executor.query<{ count: number }[]>(
		countSql(ctx, clause, plan, bounds),
		bindings,
	);

	if (!rows || rows.length === 0) return 0;
	return rows[0].count ?? 0;
}

export async function estimatedDocumentCount(
	ctx: OperationContext,
	options?: EstimatedDocumentCountOptions,
): Promise<number> {
	// No filter, and no `hint`/`skip`/`limit` in MongoDB's option surface either:
	// this counts the whole collection, so there is nothing to narrow.
	const plan = await resolveOperationPlan(ctx, options);
	const rows = await ctx.executor.query<{ count: number }[]>(
		countSql(ctx, "", plan, {}),
	);

	if (!rows || rows.length === 0) return 0;
	return rows[0].count ?? 0;
}

/**
 * Build the counting statement, bounding the set first when asked to.
 *
 * The unbounded form counts in place; the bounded form counts the ids of a
 * narrowed subquery, which is the only way `START`/`LIMIT` can reach the rows
 * being counted rather than the row reporting the count.
 */
function countSql(
	ctx: OperationContext,
	whereClause: string,
	plan: OperationPlan,
	bounds: CountBounds,
): string {
	if (bounds.skip === undefined && bounds.limit === undefined) {
		return statement(
			`SELECT count() AS count FROM ${ctx.escapedTable}`,
			plan.indexHint,
			whereClause && `WHERE ${whereClause}`,
			"GROUP ALL",
			plan.timeout,
		);
	}

	const bounded = statement(
		`SELECT id FROM ${ctx.escapedTable}`,
		plan.indexHint,
		whereClause && `WHERE ${whereClause}`,
		// `START` before `LIMIT`, matching the order MongoDB's `$skip` and `$limit`
		// stages apply in.
		bounds.skip !== undefined && `START ${bounds.skip}`,
		bounds.limit !== undefined && `LIMIT ${bounds.limit}`,
	);

	return statement(
		`SELECT count() AS count FROM (${bounded}) GROUP ALL`,
		plan.timeout,
	);
}

/**
 * Validate `skip`/`limit` and drop the values that ask for nothing.
 *
 * MongoDB rejects a negative bound and a `limit` of zero, and the messages are
 * kept because they name the stage a caller sees in MongoDB's own error. A
 * `skip` of zero skips nothing, so it needs no clause and no subquery.
 */
function resolveBounds(options?: CountDocumentsOptions): CountBounds {
	const { skip, limit } = options ?? {};

	if (skip !== undefined && (!Number.isInteger(skip) || skip < 0)) {
		throw new MongoInvalidArgumentError(
			`invalid argument to $skip stage: Expected a non-negative number in: $skip: ${skip}`,
		);
	}
	if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
		throw new MongoInvalidArgumentError(
			`invalid argument to $limit stage: Expected a non-negative number in: $limit: ${limit}`,
		);
	}
	if (limit === 0) {
		throw new MongoInvalidArgumentError("the limit must be positive");
	}

	return {
		skip: skip === 0 ? undefined : skip,
		limit,
	};
}
