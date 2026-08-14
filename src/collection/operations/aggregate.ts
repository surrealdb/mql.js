/**
 * Running an aggregation pipeline.
 *
 * The translation is in `src/translators/aggregate`; this is the operation that
 * executes it and turns the rows back into documents.
 *
 * Decoding is where a pipeline differs from a `find()`. A read returns stored
 * records, so `recordToDocument` maps SurrealDB's `id` back to `_id`. A pipeline
 * mostly does not: once a `$group` or `$project` has run, the rows are computed
 * values with a literal `_id` field and no record identity at all. Running the
 * identity mapping over those would invent an `_id` where the caller had
 * excluded one, so it is applied only while the rows are still records — which
 * is exactly when the pipeline never reshaped them.
 */

import { reviveBsonValues } from "../../surreal/bson-codec.ts";
import { statement } from "../../surreal/sql/statement.ts";
import { translatePipeline } from "../../translators/aggregate/index.ts";
import type { AggregateOptions, Document } from "../../types.ts";
import { recordToDocument, toMongoId } from "../../utils/id.ts";
import {
	filterOptionsFor,
	type OperationContext,
} from "../operation-context.ts";
import { resolveOperationPlan } from "../operation-options.ts";
import { selectRows } from "./select-rows.ts";

export async function executeAggregate<TSchema extends Document>(
	ctx: OperationContext,
	pipeline: readonly Document[],
	options?: AggregateOptions,
): Promise<TSchema[]> {
	const plan = await resolveOperationPlan(ctx, options);
	const filterOptions = await filterOptionsFor(ctx, undefined);

	const { sql, bindings, isBatch } = translatePipeline(pipeline, {
		table: ctx.escapedTable,
		collection: ctx.collectionName,
		dialect: filterOptions.dialect,
		textFields: filterOptions.textFields,
	});

	// A `$lookup` binds its outer and joined rows ahead of the statement that reads
	// them, so the answer is the last frame rather than the first.
	const rows = await selectRows(ctx, statement(sql, plan.timeout), bindings, {
		lastFrame: isBatch,
	});

	// A pipeline of only row-preserving stages ($match/$sort/$limit/$skip/$unwind)
	// still yields stored records, and those carry their identity in `id`.
	if (!reshapes(pipeline))
		return rows.map((row) => recordToDocument<TSchema>(row));

	return rows.map((row) => reviveAggregated(row) as TSchema);
}

/**
 * Decode one row of a reshaped pipeline.
 *
 * The rows are computed values rather than records, so the `id` → `_id` mapping
 * a read does would invent an identity. One thing still has to be mapped: a
 * `$project` or `$group` that named `_id` selected SurrealDB's `id` column into
 * it, so that field holds a `RecordId` and the caller is owed the `_id` they
 * inserted. `toMongoId` passes anything that is not a record id straight
 * through, so a `$group` key that happens to be called `_id` and holds a string
 * is untouched.
 */
function reviveAggregated(row: Record<string, unknown>): Document {
	return mapIdentities(reviveBsonValues(row)) as Document;
}

/**
 * Map every `_id` in the value, however deep, through the read path's `toMongoId`.
 *
 * Depth matters because of `$lookup`: the joined documents sit inside an array
 * field, each carrying an `_id` that is still a `RecordId`, and a later `$unwind`
 * or `$project` can move them anywhere in the document. Walking rather than
 * reaching for a known field is what survives that.
 *
 * Safe to apply blindly: `toMongoId` passes through anything that is not a record
 * id, so a `$group` key that happens to be called `_id` and holds a string is
 * untouched.
 */
function mapIdentities(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(mapIdentities);

	if (value === null || typeof value !== "object") return value;
	// Only plain objects are walked. A `Date`, an `ObjectId` or a `RecordId` is a
	// value, and rebuilding it field by field would destroy it.
	if (Object.getPrototypeOf(value) !== Object.prototype) return value;

	const mapped: Document = {};
	for (const [key, nested] of Object.entries(value as Document)) {
		mapped[key] = key === "_id" ? toMongoId(nested) : mapIdentities(nested);
	}
	return mapped;
}

/** Stages that replace the document shape, so the rows are no longer records. */
const RESHAPING_STAGES = new Set(["$group", "$project", "$count"]);

function reshapes(pipeline: readonly Document[]): boolean {
	return pipeline.some((stage) =>
		Object.keys(stage ?? {}).some((name) => RESHAPING_STAGES.has(name)),
	);
}
