/**
 * `findOneAndUpdate`, `findOneAndDelete`, `findOneAndReplace`.
 *
 * MongoDB's "find and modify" methods all share the same shape:
 *   1. resolve the matching record id — under the caller's `sort`, which is what
 *      decides *which* document is modified when several match
 *   2. mutate it, or insert the document an `upsert` asks for
 *   3. return the document (before or after), projected, and an optional
 *      modify-result wrapper
 *
 * The `sort` is applied to the id lookup rather than to the write, because
 * SurrealQL's `UPDATE`/`DELETE` take neither `ORDER BY` nor `LIMIT`; the
 * projection is applied to the document the write returns, because `RETURN
 * BEFORE`/`RETURN AFTER` hand back the whole record.
 */

import { MongoInvalidArgumentError } from "../../errors.ts";
import { statement } from "../../surreal/sql/statement.ts";
import { translateFilter } from "../../translators/filter.ts";
import {
	translateReplacement,
	translateUpdate,
} from "../../translators/update.ts";
import type {
	Document,
	Filter,
	FindOneAndDeleteOptions,
	FindOneAndReplaceOptions,
	FindOneAndUpdateOptions,
	ModifyResult,
	Projection,
	UpdateFilter,
	WithoutId,
} from "../../types.ts";
import { recordToDocument } from "../../utils/id.ts";
import { projectDocument } from "../../utils/projection.ts";
import { applyUndefinedPolicy } from "../../utils/undefined.ts";
import {
	filterOptionsFor,
	type OperationContext,
} from "../operation-context.ts";
import { resolveOperationPlan } from "../operation-options.ts";
import { selectOneId } from "./find.ts";
import { insertUpserted, insertUpsertedReplacement } from "./upsert.ts";

/** What the write did, in the terms `lastErrorObject` reports. */
interface ModifyOutcome {
	/** Documents affected. */
	readonly n: number;
	/** Absent for a delete, which MongoDB reports without it. */
	readonly updatedExisting?: boolean;
	/** The `_id` an upsert created. */
	readonly upserted?: unknown;
}

/**
 * Shape the return value the way the caller asked for it.
 *
 * `includeResultMetadata` swaps the document for MongoDB's command reply, whose
 * `lastErrorObject` is the only place an upsert is visible: the document itself
 * is `null` when `returnDocument` is `"before"` and something was created.
 */
function wrap<TSchema extends Document>(
	value: TSchema | null,
	options: { includeResultMetadata?: boolean } | undefined,
	outcome: ModifyOutcome,
): TSchema | ModifyResult<TSchema> | null {
	if (!options?.includeResultMetadata) return value;

	const lastErrorObject: Document = { n: outcome.n };
	if (outcome.updatedExisting !== undefined) {
		lastErrorObject.updatedExisting = outcome.updatedExisting;
	}
	if (outcome.upserted !== undefined) {
		lastErrorObject.upserted = outcome.upserted;
	}

	return {
		lastErrorObject,
		value,
		ok: 1,
	} as ModifyResult<TSchema>;
}

/** The document a returned record becomes, projected as the caller asked. */
function toProjected<TSchema extends Document>(
	record: Record<string, unknown> | undefined,
	projection: Projection | undefined,
): TSchema | null {
	if (!record) return null;
	return projectDocument(recordToDocument(record), projection) as TSchema;
}

/** True when the caller wants the document as it was before the write. */
function wantsBefore(returnDocument: "before" | "after" | undefined): boolean {
	return returnDocument !== "after";
}

export async function findOneAndUpdate<TSchema extends Document>(
	ctx: OperationContext,
	filter: Filter<TSchema>,
	update: UpdateFilter<TSchema>,
	options?: FindOneAndUpdateOptions,
): Promise<TSchema | ModifyResult<TSchema> | null> {
	const plan = await resolveOperationPlan(ctx, options, { indexHint: true });
	const criteria = applyUndefinedPolicy(
		filter as Document,
		plan.ignoreUndefined,
	);
	const document = applyUndefinedPolicy(
		update as Document,
		plan.ignoreUndefined,
	);

	const { clause: whereClause, bindings: filterBindings } = translateFilter(
		criteria,
		await filterOptionsFor(ctx, filter as Document),
	);

	const rid = await selectOneId(
		ctx,
		whereClause,
		plan,
		filterBindings,
		options?.sort,
	);

	if (rid === undefined) {
		if (!options?.upsert) {
			return wrap<TSchema>(null, options, { n: 0, updatedExisting: false });
		}
		const inserted = await insertUpserted(
			ctx,
			criteria,
			document,
			plan,
			options,
		);
		// MongoDB returns `null` for the "before" of a document that did not exist,
		// while still reporting the insert in `lastErrorObject`.
		const value = wantsBefore(options.returnDocument)
			? null
			: toProjected<TSchema>(inserted.record, options.projection);
		return wrap(value, options, {
			n: 1,
			updatedExisting: false,
			upserted: inserted.insertedId,
		});
	}

	const { clause: setClause, bindings: updateBindings } = translateUpdate(
		document,
		0,
		{ arrayFilters: options?.arrayFilters },
	);

	const rows = await ctx.executor.query<Record<string, unknown>[]>(
		statement(
			"UPDATE $__rid",
			setClause,
			wantsBefore(options?.returnDocument) ? "RETURN BEFORE" : "RETURN AFTER",
			plan.timeout,
		),
		{ ...updateBindings, __rid: rid },
	);

	const value = toProjected<TSchema>(rows?.[0], options?.projection);
	return wrap(value, options, { n: 1, updatedExisting: true });
}

export async function findOneAndDelete<TSchema extends Document>(
	ctx: OperationContext,
	filter: Filter<TSchema>,
	options?: FindOneAndDeleteOptions,
): Promise<TSchema | ModifyResult<TSchema> | null> {
	const plan = await resolveOperationPlan(ctx, options, { indexHint: true });

	const { clause, bindings } = translateFilter(
		applyUndefinedPolicy(filter as Document, plan.ignoreUndefined),
		await filterOptionsFor(ctx, filter as Document),
	);

	const rid = await selectOneId(ctx, clause, plan, bindings, options?.sort);

	if (rid === undefined) {
		return wrap<TSchema>(null, options, { n: 0 });
	}

	const rows = await ctx.executor.query<Record<string, unknown>[]>(
		statement("DELETE $__rid RETURN BEFORE", plan.timeout),
		{ __rid: rid },
	);

	const value = toProjected<TSchema>(rows?.[0], options?.projection);
	return wrap(value, options, { n: value ? 1 : 0 });
}

export async function findOneAndReplace<TSchema extends Document>(
	ctx: OperationContext,
	filter: Filter<TSchema>,
	replacement: WithoutId<TSchema>,
	options?: FindOneAndReplaceOptions,
): Promise<TSchema | ModifyResult<TSchema> | null> {
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
			"findOneAndReplace requires a non-empty filter",
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
		if (!options?.upsert) {
			return wrap<TSchema>(null, options, { n: 0, updatedExisting: false });
		}
		const inserted = await insertUpsertedReplacement(
			ctx,
			criteria,
			document,
			plan,
		);
		const value = wantsBefore(options.returnDocument)
			? null
			: toProjected<TSchema>(inserted.record, options.projection);
		return wrap(value, options, {
			n: 1,
			updatedExisting: false,
			upserted: inserted.insertedId,
		});
	}

	const { clause: contentClause, bindings: contentBindings } =
		translateReplacement(document, 0);

	const rows = await ctx.executor.query<Record<string, unknown>[]>(
		statement(
			`UPDATE $__rid ${contentClause}`,
			wantsBefore(options?.returnDocument) ? "RETURN BEFORE" : "RETURN AFTER",
			plan.timeout,
		),
		{ ...contentBindings, __rid: rid },
	);

	const value = toProjected<TSchema>(rows?.[0], options?.projection);
	return wrap(value, options, { n: 1, updatedExisting: true });
}
