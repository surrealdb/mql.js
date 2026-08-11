/**
 * `insertOne` / `insertMany` operations.
 *
 * Both go through SurrealQL rather than the SDK's `create`/`insert` shortcuts,
 * because only a statement can carry the `TIMEOUT` clause a caller's
 * `maxTimeMS` becomes. The documents themselves are still bound parameters, so
 * the encoding — `RecordId`s, dates, nested objects — is unchanged.
 */

import type { ObjectId } from "../../object-id.ts";
import { withTypedDuplicateId } from "../../surreal/error-mapper.ts";
import { statement } from "../../surreal/sql/statement.ts";
import type {
	BulkWriteOptions,
	Document,
	InsertManyResult,
	InsertOneOptions,
	InsertOneResult,
	OptionalId,
} from "../../types.ts";
import { prepareInsert } from "../../utils/id.ts";
import {
	makeInsertManyResult,
	makeInsertOneResult,
} from "../../utils/result.ts";
import { applyUndefinedPolicy } from "../../utils/undefined.ts";
import type { OperationContext } from "../operation-context.ts";
import { resolveOperationPlan } from "../operation-options.ts";

export async function insertOne<TSchema extends Document>(
	ctx: OperationContext,
	doc: OptionalId<TSchema>,
	options?: InsertOneOptions,
): Promise<InsertOneResult> {
	// `CREATE` has no `WITH` clause position, and MongoDB's insert options carry
	// no `hint` either, so there is no index hint to resolve.
	const plan = await resolveOperationPlan(ctx, options);
	const prepared = prepareInsert(
		ctx.collectionName,
		applyUndefinedPolicy(doc as Document, plan.ignoreUndefined),
	);

	try {
		await ctx.executor.query(
			statement("CREATE $__rid CONTENT $__doc", plan.timeout),
			{ __rid: prepared.recordId, __doc: prepared.data },
		);
	} catch (err) {
		// A collision reports the record as a string, which loses whether the `_id`
		// was `42` or `"42"`. The prepared id is the typed original.
		throw withTypedDuplicateId(err, [prepared.insertedId]);
	}
	return makeInsertOneResult(prepared.insertedId);
}

export async function insertMany<TSchema extends Document>(
	ctx: OperationContext,
	docs: OptionalId<TSchema>[],
	options?: BulkWriteOptions,
): Promise<InsertManyResult> {
	const plan = await resolveOperationPlan(ctx, options);

	const insertedIds: (ObjectId | string | number)[] = [];
	const docsWithId: Document[] = [];

	for (const doc of docs) {
		const prepared = prepareInsert(
			ctx.collectionName,
			applyUndefinedPolicy(doc as Document, plan.ignoreUndefined),
		);
		insertedIds.push(prepared.insertedId);
		docsWithId.push({ ...prepared.data, id: prepared.recordId });
	}

	try {
		await ctx.executor.query(
			statement(`INSERT INTO ${ctx.escapedTable} $__docs`, plan.timeout),
			{ __docs: docsWithId },
		);
	} catch (err) {
		throw withTypedDuplicateId(err, insertedIds);
	}
	return makeInsertManyResult(insertedIds);
}
