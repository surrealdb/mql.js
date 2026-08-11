/**
 * `updateOne` / `updateMany` operations and shared SET-builder helpers.
 *
 * SurrealQL doesn't accept `LIMIT` on `UPDATE`, so `updateOne` finds the
 * matching record id first and updates it by id; `updateMany` and
 * `upsert` operate on the whole table.
 */

import type { ObjectId } from "../../object-id.ts";
import { translateFilter } from "../../translators/filter.ts";
import { translateUpdate } from "../../translators/update.ts";
import type {
	Document,
	Filter,
	UpdateFilter,
	UpdateOptions,
	UpdateResult,
} from "../../types.ts";
import { recordToDocument } from "../../utils/id.ts";
import { makeUpdateResult } from "../../utils/result.ts";
import {
	filterOptionsFor,
	type OperationContext,
} from "../operation-context.ts";

export async function updateOne<TSchema extends Document>(
	ctx: OperationContext,
	filter: Filter<TSchema>,
	update: UpdateFilter<TSchema>,
	options?: UpdateOptions,
): Promise<UpdateResult> {
	return runUpdate(ctx, filter as Document, update as Document, {
		...options,
		limit: 1,
	});
}

export async function updateMany<TSchema extends Document>(
	ctx: OperationContext,
	filter: Filter<TSchema>,
	update: UpdateFilter<TSchema>,
	options?: UpdateOptions,
): Promise<UpdateResult> {
	return runUpdate(ctx, filter as Document, update as Document, options);
}

async function runUpdate(
	ctx: OperationContext,
	filter: Document,
	update: Document,
	options?: UpdateOptions & { limit?: number },
): Promise<UpdateResult> {
	const { clause: whereClause, bindings: filterBindings } = translateFilter(
		filter,
		await filterOptionsFor(ctx, filter),
	);

	const paramOffset = Object.keys(filterBindings).length;
	const { clause: setClause, bindings: updateBindings } = translateUpdate(
		update,
		paramOffset,
		// The translator needs to know whether this statement can insert:
		// `$setOnInsert` must contribute nothing to a plain update.
		{ arrayFilters: options?.arrayFilters, upsert: options?.upsert === true },
	);
	const allBindings = { ...filterBindings, ...updateBindings };

	if (options?.limit === 1 && !options?.upsert) {
		return updateOneById(
			ctx,
			whereClause,
			filterBindings,
			setClause,
			allBindings,
		);
	}
	return updateBulk(ctx, whereClause, setClause, allBindings, options);
}

async function updateOneById(
	ctx: OperationContext,
	whereClause: string,
	filterBindings: Record<string, unknown>,
	setClause: string,
	allBindings: Record<string, unknown>,
): Promise<UpdateResult> {
	let findSql = `SELECT id FROM ${ctx.escapedTable}`;
	if (whereClause) findSql += ` WHERE ${whereClause}`;
	findSql += " LIMIT 1";

	const found = await ctx.executor.query<Record<string, unknown>[]>(
		findSql,
		filterBindings,
	);

	if (!found || found.length === 0) {
		return makeUpdateResult([]);
	}

	allBindings.__rid = found[0].id;
	const rows = await ctx.executor.query<Record<string, unknown>[]>(
		`UPDATE $__rid ${setClause}`,
		allBindings,
	);
	return makeUpdateResult(rows || []);
}

async function updateBulk(
	ctx: OperationContext,
	whereClause: string,
	setClause: string,
	allBindings: Record<string, unknown>,
	options?: UpdateOptions,
): Promise<UpdateResult> {
	const verb = options?.upsert ? "UPSERT" : "UPDATE";
	let sql = `${verb} ${ctx.escapedTable} ${setClause}`;
	if (whereClause) sql += ` WHERE ${whereClause}`;

	const rows = await ctx.executor.query<Record<string, unknown>[]>(
		sql,
		allBindings,
	);

	let upsertedId: ObjectId | string | number | null = null;
	if (options?.upsert && rows && rows.length > 0) {
		upsertedId = recordToDocument(rows[0])._id as ObjectId | string | number;
	}

	return makeUpdateResult(rows || [], upsertedId);
}
