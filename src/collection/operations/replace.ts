/**
 * `replaceOne` operation.
 *
 * SurrealQL has no equivalent of MongoDB's "replace document" mode on
 * `UPDATE`, so we look up the matching id first and `UPDATE $rid CONTENT`.
 */

import { MongoInvalidArgumentError } from "../../errors.ts";
import { statement } from "../../surreal/sql/statement.ts";
import { translateFilter } from "../../translators/filter.ts";
import { translateReplacement } from "../../translators/update.ts";
import type {
	Document,
	Filter,
	ReplaceOptions,
	UpdateResult,
	WithoutId,
} from "../../types.ts";
import { makeUpdateResult } from "../../utils/result.ts";
import { applyUndefinedPolicy } from "../../utils/undefined.ts";
import {
	filterOptionsFor,
	type OperationContext,
} from "../operation-context.ts";
import { resolveOperationPlan } from "../operation-options.ts";
import { selectOneId } from "./find.ts";
import { insertUpsertedReplacement } from "./upsert.ts";

export async function replaceOne<TSchema extends Document>(
	ctx: OperationContext,
	filter: Filter<TSchema>,
	replacement: WithoutId<TSchema>,
	options?: ReplaceOptions,
): Promise<UpdateResult> {
	const plan = await resolveOperationPlan(ctx, options, { indexHint: true });
	const criteria = applyUndefinedPolicy(
		filter as Document,
		plan.ignoreUndefined,
	);
	const document = applyUndefinedPolicy(
		replacement as Document,
		plan.ignoreUndefined,
	);

	const { clause: whereClause, bindings: filterBindings } = translateFilter(
		criteria,
		await filterOptionsFor(ctx, filter as Document),
	);

	if (!whereClause) {
		throw new MongoInvalidArgumentError(
			"replaceOne requires a non-empty filter",
		);
	}

	const rid = await selectOneId(
		ctx,
		whereClause,
		plan,
		filterBindings,
		options?.sort,
	);

	if (rid === undefined) {
		if (options?.upsert) {
			const inserted = await insertUpsertedReplacement(
				ctx,
				criteria,
				document,
				plan,
			);
			return makeUpdateResult([], inserted.insertedId);
		}
		return makeUpdateResult([]);
	}

	const { clause: contentClause, bindings: contentBindings } =
		translateReplacement(document, 0);

	const rows = await ctx.executor.query<Record<string, unknown>[]>(
		statement(`UPDATE $__rid ${contentClause}`, plan.timeout),
		{ ...contentBindings, __rid: rid },
	);
	return makeUpdateResult(rows || []);
}
