/**
 * `findOneAndUpdate`, `findOneAndDelete`, `findOneAndReplace`.
 *
 * MongoDB's "find and modify" methods all share the same shape:
 *   1. resolve the matching record id
 *   2. mutate it
 *   3. return the document (before or after) and an optional modify-result wrapper
 */

import type { RecordId } from "surrealdb";
import { MongoServerError } from "../../errors.ts";
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
	UpdateFilter,
	WithoutId,
} from "../../types.ts";
import { recordToDocument } from "../../utils/id.ts";
import {
	filterOptionsFor,
	type OperationContext,
} from "../operation-context.ts";

function wrap<TSchema extends Document>(
	value: TSchema | null,
	includeMetadata: boolean | undefined,
): TSchema | ModifyResult<TSchema> | null {
	if (includeMetadata) {
		return { value, ok: value ? 1 : 0 } as ModifyResult<TSchema>;
	}
	return value;
}

export async function findOneAndUpdate<TSchema extends Document>(
	ctx: OperationContext,
	filter: Filter<TSchema>,
	update: UpdateFilter<TSchema>,
	options?: FindOneAndUpdateOptions,
): Promise<TSchema | ModifyResult<TSchema> | null> {
	const returnBefore =
		!options?.returnDocument || options.returnDocument === "before";

	const { clause: whereClause, bindings: filterBindings } = translateFilter(
		filter as Document,
		filterOptionsFor(ctx),
	);

	const paramOffset = Object.keys(filterBindings).length;
	const { clause: setClause, bindings: updateBindings } = translateUpdate(
		update as Document,
		paramOffset,
		{ arrayFilters: options?.arrayFilters },
	);
	const allBindings: Record<string, unknown> = {
		...filterBindings,
		...updateBindings,
	};

	let findSql = `SELECT id FROM ${ctx.escapedTable}`;
	if (whereClause) findSql += ` WHERE ${whereClause}`;
	findSql += " LIMIT 1";

	const found = await ctx.executor.query<Record<string, unknown>[]>(
		findSql,
		filterBindings,
	);

	if (!found || found.length === 0) {
		return wrap<TSchema>(null, options?.includeResultMetadata);
	}

	allBindings.__rid = found[0].id;
	const returnClause = returnBefore ? "RETURN BEFORE" : "RETURN AFTER";
	const rows = await ctx.executor.query<Record<string, unknown>[]>(
		`UPDATE $__rid ${setClause} ${returnClause}`,
		allBindings,
	);

	const value =
		rows && rows.length > 0 ? recordToDocument<TSchema>(rows[0]) : null;
	return wrap(value, options?.includeResultMetadata);
}

export async function findOneAndDelete<TSchema extends Document>(
	ctx: OperationContext,
	filter: Filter<TSchema>,
	options?: FindOneAndDeleteOptions,
): Promise<TSchema | ModifyResult<TSchema> | null> {
	const { clause, bindings } = translateFilter(
		filter as Document,
		filterOptionsFor(ctx),
	);

	let findSql = `SELECT id FROM ${ctx.escapedTable}`;
	if (clause) findSql += ` WHERE ${clause}`;
	findSql += " LIMIT 1";

	const found = await ctx.executor.query<Record<string, unknown>[]>(
		findSql,
		bindings,
	);

	if (!found || found.length === 0) {
		return wrap<TSchema>(null, options?.includeResultMetadata);
	}

	const rows = await ctx.executor.query<Record<string, unknown>[]>(
		"DELETE $__rid RETURN BEFORE",
		{ __rid: found[0].id },
	);

	const value =
		rows && rows.length > 0 ? recordToDocument<TSchema>(rows[0]) : null;
	return wrap(value, options?.includeResultMetadata);
}

export async function findOneAndReplace<TSchema extends Document>(
	ctx: OperationContext,
	filter: Filter<TSchema>,
	replacement: WithoutId<TSchema>,
	options?: FindOneAndReplaceOptions,
): Promise<TSchema | ModifyResult<TSchema> | null> {
	const returnBefore =
		!options?.returnDocument || options.returnDocument === "before";

	const { clause: whereClause, bindings: filterBindings } = translateFilter(
		filter as Document,
		filterOptionsFor(ctx),
	);

	if (!whereClause) {
		throw new MongoServerError("findOneAndReplace requires a non-empty filter");
	}

	const findSql = `SELECT * FROM ${ctx.escapedTable} WHERE ${whereClause} LIMIT 1`;
	const existing = await ctx.executor.query<Record<string, unknown>[]>(
		findSql,
		filterBindings,
	);

	if (!existing || existing.length === 0) {
		return wrap<TSchema>(null, options?.includeResultMetadata);
	}

	const before = recordToDocument<TSchema>(existing[0]);
	const rid = existing[0].id as RecordId;

	const paramOffset = Object.keys(filterBindings).length;
	const { clause: contentClause, bindings: contentBindings } =
		translateReplacement(replacement as Document, paramOffset);
	const allBindings: Record<string, unknown> = {
		...filterBindings,
		...contentBindings,
		rid,
	};

	const rows = await ctx.executor.query<Record<string, unknown>[]>(
		`UPDATE $rid ${contentClause} RETURN AFTER`,
		allBindings,
	);

	const after =
		rows && rows.length > 0 ? recordToDocument<TSchema>(rows[0]) : null;
	const value = returnBefore ? before : after;
	return wrap(value, options?.includeResultMetadata);
}
