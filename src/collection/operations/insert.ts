/**
 * `insertOne` / `insertMany` operations.
 */

import type { ObjectId } from "../../object-id.ts";
import type {
	Document,
	InsertManyResult,
	InsertOneResult,
	OptionalId,
} from "../../types.ts";
import { prepareInsert } from "../../utils/id.ts";
import {
	makeInsertManyResult,
	makeInsertOneResult,
} from "../../utils/result.ts";
import type { OperationContext } from "../operation-context.ts";

export async function insertOne<TSchema extends Document>(
	ctx: OperationContext,
	doc: OptionalId<TSchema>,
): Promise<InsertOneResult> {
	const prepared = prepareInsert(ctx.collectionName, doc as Document);
	await ctx.executor.createRecord(prepared.recordId!, prepared.data);
	return makeInsertOneResult(prepared.insertedId);
}

export async function insertMany<TSchema extends Document>(
	ctx: OperationContext,
	docs: OptionalId<TSchema>[],
): Promise<InsertManyResult> {
	const insertedIds: (ObjectId | string | number)[] = [];
	const docsWithId: Document[] = [];

	for (const doc of docs) {
		const prepared = prepareInsert(ctx.collectionName, doc as Document);
		insertedIds.push(prepared.insertedId);
		docsWithId.push({ ...prepared.data, id: prepared.recordId });
	}

	await ctx.executor.insertMany(ctx.collectionName, docsWithId);
	return makeInsertManyResult(insertedIds);
}
