/**
 * Utilities for transforming SurrealDB query results into MongoDB-shaped
 * result objects (InsertOneResult, UpdateResult, DeleteResult, etc.).
 */

import type { ObjectId } from "../object-id.ts";
import type {
	DeleteResult,
	Document,
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
	matchedRecords: Document[],
	upsertedId?: ObjectId | string | number | null,
): UpdateResult {
	return {
		acknowledged: true,
		matchedCount: matchedRecords.length,
		modifiedCount: matchedRecords.length,
		upsertedId: upsertedId ?? null,
		upsertedCount: upsertedId != null ? 1 : 0,
	};
}

/** Build a DeleteResult from the count of deleted records. */
export function makeDeleteResult(deletedCount: number): DeleteResult {
	return {
		acknowledged: true,
		deletedCount,
	};
}
