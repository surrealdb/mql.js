/**
 * Utilities for transforming SurrealDB query results into MongoDB-shaped
 * result objects (InsertOneResult, UpdateResult, DeleteResult, etc.).
 */

import type { ObjectId } from "../object-id.ts";
import type {
	DeleteResult,
	InsertManyResult,
	InsertOneResult,
	UpdateResult,
} from "../types.ts";

/** Build an InsertOneResult. */
export function makeInsertOneResult(
	insertedId: ObjectId | string | number,
): InsertOneResult {
	return {
		acknowledged: true,
		insertedId,
	};
}

/** Build an InsertManyResult. */
export function makeInsertManyResult(
	insertedIds: (ObjectId | string | number)[],
): InsertManyResult {
	const idsMap: Record<number, ObjectId | string | number> = {};
	for (let i = 0; i < insertedIds.length; i++) {
		idsMap[i] = insertedIds[i];
	}
	return {
		acknowledged: true,
		insertedCount: insertedIds.length,
		insertedIds: idsMap,
	};
}

/** Build an UpdateResult from the SurrealDB query response. */
export function makeUpdateResult(
	diffs: readonly unknown[],
	upsertedId?: ObjectId | string | number | null,
): UpdateResult {
	return {
		acknowledged: true,
		matchedCount: diffs.length,
		modifiedCount: diffs.filter(isChanged).length,
		upsertedId: upsertedId ?? null,
		upsertedCount: upsertedId != null ? 1 : 0,
	};
}

/**
 * Did this record actually change?
 *
 * The write statements ask for `RETURN DIFF`, which answers with one JSON-patch
 * list per matched record — empty when the update left the document as it found
 * it. That is the only thing that separates MongoDB's two counts: an update
 * setting a field to the value it already holds is **matched but not modified**,
 * and this driver reported it as modified until the `bulkWrite` parity scenarios
 * put the question to a real `mongod`.
 *
 * Anything that is not a list is treated as a change, so a server that stopped
 * answering in diffs would over-report rather than silently report nothing
 * modified.
 */
function isChanged(diff: unknown): boolean {
	return !Array.isArray(diff) || diff.length > 0;
}

/** Build a DeleteResult from the count of deleted records. */
export function makeDeleteResult(deletedCount: number): DeleteResult {
	return {
		acknowledged: true,
		deletedCount,
	};
}
