/**
 * `replaceOne` operation.
 *
 * SurrealQL has no equivalent of MongoDB's "replace document" mode on `UPDATE`,
 * so the matching record is named in a subquery and given new `CONTENT` — one
 * statement, so nothing can change the document between the match and the
 * replacement (see `modify-one.ts`).
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
import { oneRecordTarget, writeOneRecord } from "./modify-one.ts";
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

	const {
		clause: whereClause,
		bindings: filterBindings,
		nearDistance,
	} = translateFilter(
		criteria,
		await filterOptionsFor(ctx, filter as Document),
	);

	if (!whereClause) {
		throw new MongoInvalidArgumentError(
			"replaceOne requires a non-empty filter",
		);
	}

	const { clause: contentClause, bindings: contentBindings } =
		translateReplacement(document, Object.keys(filterBindings).length);

	const rows = await writeOneRecord(
		ctx,
		statement(
			`UPDATE ${oneRecordTarget(ctx, whereClause, plan, options?.sort, nearDistance)} ${contentClause}`,
			plan.timeout,
		),
		{ ...filterBindings, ...contentBindings },
	);

	if (rows.length > 0 || !options?.upsert) return makeUpdateResult(rows);

	const inserted = await insertUpsertedReplacement(
		ctx,
		criteria,
		document,
		plan,
	);
	return makeUpdateResult([], inserted.insertedId);
}
