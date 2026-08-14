/**
 * `bulkWrite` — mixed insert, update, replace and delete models in one call.
 *
 * Each model is executed through the operation that already implements it, in
 * order, rather than translated afresh here. That is a deliberate choice and the
 * whole design rests on it: `updateOne` with an upsert is a read then a write,
 * `updateMany` with one asks whether anything matches before it writes at all,
 * and the single-record writes retry on a write conflict. Rebuilding those as
 * statements to pack into one dispatch would be a second implementation of the
 * subtlest write logic in the driver, and the two would drift.
 *
 * What that costs is the round trips. MongoDB sends a batch as one message; this
 * sends one statement per model. The counts, the ids, the ordered and unordered
 * failure semantics and the `MongoBulkWriteError` are all exactly MongoDB's —
 * the saving in network round trips is not. That is stated in the README rather
 * than implied by the method existing.
 *
 * Ordering is the same rule `insertMany` follows, for the same reason:
 *
 *   - **`ordered: true`** (the default) stops at the first model that fails and
 *     keeps everything before it. One dispatch per model is what makes "stop
 *     here" expressible — SurrealDB runs every statement it is sent and reports
 *     the failures afterwards, which is the opposite of stopping.
 *   - **`ordered: false`** attempts every model and keeps every success,
 *     reporting all the failures together.
 *
 * Inside a caller's transaction the counts still describe what the models did;
 * whether any of it survives is the transaction's business, exactly as it is for
 * a lone `insertOne` in one.
 */

import type { WriteError } from "../../errors.ts";
import {
	MongoBulkWriteError,
	MongoInvalidArgumentError,
} from "../../errors.ts";
import type {
	AnyBulkWriteOperation,
	BulkWriteOptions,
	BulkWriteResult,
	Document,
} from "../../types.ts";
import type { OperationContext } from "../operation-context.ts";
import { deleteMany, deleteOne } from "./delete.ts";
import { insertOne } from "./insert.ts";
import { replaceOne } from "./replace.ts";
import { updateMany, updateOne } from "./update.ts";

/** The counts a batch accumulates, before they become a result. */
interface Counts {
	insertedCount: number;
	matchedCount: number;
	modifiedCount: number;
	deletedCount: number;
	upsertedCount: number;
	insertedIds: Record<number, unknown>;
	upsertedIds: Record<number, unknown>;
}

const emptyCounts = (): Counts => ({
	insertedCount: 0,
	matchedCount: 0,
	modifiedCount: 0,
	deletedCount: 0,
	upsertedCount: 0,
	insertedIds: {},
	upsertedIds: {},
});

export async function bulkWrite<TSchema extends Document>(
	ctx: OperationContext,
	operations: readonly AnyBulkWriteOperation<TSchema>[],
	options?: BulkWriteOptions,
): Promise<BulkWriteResult> {
	if (!Array.isArray(operations)) {
		throw new MongoInvalidArgumentError(
			"bulkWrite takes an array of write models.",
		);
	}
	if (operations.length === 0) {
		// MongoDB refuses an empty batch rather than answering with zeroes, on the
		// grounds that it is a mistake in the call rather than a write of nothing.
		throw new MongoInvalidArgumentError(
			"bulkWrite requires at least one write model.",
		);
	}

	const ordered = options?.ordered !== false;
	const counts = emptyCounts();
	const writeErrors: WriteError[] = [];

	for (const [index, operation] of operations.entries()) {
		try {
			await applyModel(ctx, operation, index, counts, options);
		} catch (error) {
			writeErrors.push(toWriteError(error, index));
			if (ordered) break;
		}
	}

	const result = toResult(counts);
	if (writeErrors.length === 0) return result;

	throw new MongoBulkWriteError(writeErrors[0]?.errmsg ?? "bulk write failed", {
		code: writeErrors[0]?.code,
		writeErrors,
		result: { ...result, insertedIds: counts.insertedIds },
	});
}

/** Run one model, folding what it did into `counts`. */
async function applyModel<TSchema extends Document>(
	ctx: OperationContext,
	operation: AnyBulkWriteOperation<TSchema>,
	index: number,
	counts: Counts,
	options: BulkWriteOptions | undefined,
): Promise<void> {
	const names = Object.keys(operation ?? {});
	if (names.length !== 1) {
		throw new MongoInvalidArgumentError(
			`Write model at index ${index} must name exactly one operation, and names ${names.length}.`,
		);
	}

	// The batch-level options a model inherits. `ordered` belongs to the batch
	// rather than to any model in it, so it is not passed down.
	const shared = { session: options?.session, comment: options?.comment };
	const model = (operation as unknown as Record<string, Document>)[names[0]];

	switch (names[0]) {
		case "insertOne": {
			const written = await insertOne(ctx, model.document as never, shared);
			counts.insertedCount += 1;
			counts.insertedIds[index] = written.insertedId;
			return;
		}
		case "updateOne":
		case "updateMany": {
			const update = names[0] === "updateOne" ? updateOne : updateMany;
			const done = await update(
				ctx,
				model.filter as never,
				model.update as never,
				{
					...shared,
					upsert: model.upsert as boolean | undefined,
					arrayFilters: model.arrayFilters as Document[] | undefined,
					hint: model.hint as never,
				},
			);
			fold(counts, index, done);
			return;
		}
		case "replaceOne": {
			const done = await replaceOne(
				ctx,
				model.filter as never,
				model.replacement as never,
				{
					...shared,
					upsert: model.upsert as boolean | undefined,
					hint: model.hint as never,
				},
			);
			fold(counts, index, done);
			return;
		}
		case "deleteOne":
		case "deleteMany": {
			const remove = names[0] === "deleteOne" ? deleteOne : deleteMany;
			const done = await remove(ctx, model.filter as never, {
				...shared,
				hint: model.hint as never,
			});
			counts.deletedCount += done.deletedCount;
			return;
		}
		default:
			throw new MongoInvalidArgumentError(
				`Unknown write model "${names[0]}" at index ${index}. Expected insertOne, updateOne, updateMany, replaceOne, deleteOne or deleteMany.`,
			);
	}
}

/** Fold an update-shaped result into the running counts. */
function fold(
	counts: Counts,
	index: number,
	done: {
		matchedCount: number;
		modifiedCount: number;
		upsertedId?: unknown;
	},
): void {
	counts.matchedCount += done.matchedCount;
	counts.modifiedCount += done.modifiedCount;
	// An upsert reports the id it created, and MongoDB counts it apart from the
	// matches — the document was not matched, it was made.
	if (done.upsertedId !== null && done.upsertedId !== undefined) {
		counts.upsertedCount += 1;
		counts.upsertedIds[index] = done.upsertedId;
	}
}

function toResult(counts: Counts): BulkWriteResult {
	return {
		insertedCount: counts.insertedCount,
		matchedCount: counts.matchedCount,
		modifiedCount: counts.modifiedCount,
		deletedCount: counts.deletedCount,
		upsertedCount: counts.upsertedCount,
		insertedIds: counts.insertedIds as BulkWriteResult["insertedIds"],
		upsertedIds: counts.upsertedIds as BulkWriteResult["upsertedIds"],
	};
}

/**
 * Describe one failed model the way MongoDB's `writeErrors` does.
 *
 * The index is the model's position in the caller's array, which is the only
 * thing that lets them tell which of six `updateOne`s was refused.
 */
function toWriteError(error: unknown, index: number): WriteError {
	const server = error as { code?: number; message?: string };
	return {
		index,
		code: typeof server?.code === "number" ? server.code : 8,
		errmsg: error instanceof Error ? error.message : String(error),
	};
}
