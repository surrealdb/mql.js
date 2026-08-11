/**
 * `replaceOne` operation.
 *
 * SurrealQL has no equivalent of MongoDB's "replace document" mode on
 * `UPDATE`, so we look up the matching id first and `UPDATE $rid CONTENT`.
 */

import type { RecordId } from "surrealdb";
import { MongoInvalidArgumentError } from "../../errors.ts";
import { translateFilter } from "../../translators/filter.ts";
import { translateReplacement } from "../../translators/update.ts";
import type {
	Document,
	Filter,
	ReplaceOptions,
	UpdateResult,
	WithoutId,
} from "../../types.ts";
import { prepareInsert } from "../../utils/id.ts";
import { makeUpdateResult } from "../../utils/result.ts";
import {
	filterOptionsFor,
	type OperationContext,
} from "../operation-context.ts";

export async function replaceOne<TSchema extends Document>(
	ctx: OperationContext,
	filter: Filter<TSchema>,
	replacement: WithoutId<TSchema>,
	options?: ReplaceOptions,
): Promise<UpdateResult> {
	const { clause: whereClause, bindings: filterBindings } = translateFilter(
		filter as Document,
		filterOptionsFor(ctx),
	);

	if (!whereClause) {
		throw new MongoInvalidArgumentError(
			"replaceOne requires a non-empty filter",
		);
	}

	const findSql = `SELECT * FROM ${ctx.escapedTable} WHERE ${whereClause} LIMIT 1`;
	const existing = await ctx.executor.query<Record<string, unknown>[]>(
		findSql,
		filterBindings,
	);

	if (!existing || existing.length === 0) {
		if (options?.upsert) {
			const prepared = prepareInsert(
				ctx.collectionName,
				replacement as Document,
			);
			await ctx.executor.createRecord(prepared.recordId!, prepared.data);
			return makeUpdateResult([], prepared.insertedId);
		}
		return makeUpdateResult([]);
	}

	const record = existing[0];
	const rid = record.id as RecordId;
	const paramOffset = Object.keys(filterBindings).length;
	const { clause: contentClause, bindings: contentBindings } =
		translateReplacement(replacement as Document, paramOffset);
	const allBindings: Record<string, unknown> = {
		...filterBindings,
		...contentBindings,
		rid,
	};

	const rows = await ctx.executor.query<Record<string, unknown>[]>(
		`UPDATE $rid ${contentClause}`,
		allBindings,
	);
	return makeUpdateResult(rows || []);
}
