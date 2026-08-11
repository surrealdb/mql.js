/**
 * Database-level admin operations: list collections, create/drop a
 * collection, drop the whole database.
 *
 * Each function takes a plain `QueryExecutor` so it can be unit tested
 * without instantiating the full `Db` facade.
 */

import { MongoInvalidArgumentError } from "../errors.ts";
import type { QueryExecutor } from "../surreal/query-executor.ts";
import { escapeIdentifier } from "../surreal/sql/escape.ts";
import type { CollectionInfo, Document } from "../types.ts";

/**
 * Fields a `listCollections` filter may constrain.
 *
 * MongoDB filters the command's *reply*, so the predicate applies to the
 * `{name, type}` documents rather than to stored rows — which is why this is
 * matched in memory instead of going through the filter translator. Only the
 * two fields the reply actually carries are supported; anything else would be
 * a predicate over data this driver does not have, so it is refused rather
 * than quietly matching everything.
 */
const LIST_COLLECTIONS_FILTER_FIELDS = ["name", "type"] as const;

/** Does `value` satisfy `condition`, for the subset of operators supported? */
function matchesCollectionField(value: string, condition: unknown): boolean {
	if (typeof condition === "string") return value === condition;

	if (condition instanceof RegExp) return condition.test(value);

	if (condition && typeof condition === "object") {
		return Object.entries(condition as Record<string, unknown>).every(
			([operator, operand]) => {
				switch (operator) {
					case "$eq":
						return value === operand;
					case "$ne":
						return value !== operand;
					case "$in":
						return Array.isArray(operand) && operand.includes(value);
					case "$nin":
						return Array.isArray(operand) && !operand.includes(value);
					case "$regex":
						return new RegExp(
							operand instanceof RegExp ? operand.source : String(operand),
						).test(value);
					default:
						throw new MongoInvalidArgumentError(
							`Unsupported operator in a listCollections filter: ${operator}`,
						);
				}
			},
		);
	}

	return false;
}

export async function listCollections(
	exec: QueryExecutor,
	filter?: Document,
): Promise<CollectionInfo[]> {
	if (filter) {
		for (const field of Object.keys(filter)) {
			if (
				!(LIST_COLLECTIONS_FILTER_FIELDS as readonly string[]).includes(field)
			) {
				throw new MongoInvalidArgumentError(
					`Unsupported field in a listCollections filter: ${field}. Only ${LIST_COLLECTIONS_FILTER_FIELDS.join(" and ")} are reported for a collection.`,
				);
			}
		}
	}

	const info = await exec.query<Record<string, unknown>>("INFO FOR DB");
	if (!info) return [];

	const tables = (info.tables ?? info.tb ?? {}) as Record<string, unknown>;
	const collections = Object.keys(tables).map((name) => ({
		name,
		type: "collection" as const,
	}));

	if (!filter) return collections;

	return collections.filter((collection) =>
		Object.entries(filter).every(([field, condition]) =>
			matchesCollectionField(
				collection[field as (typeof LIST_COLLECTIONS_FILTER_FIELDS)[number]],
				condition,
			),
		),
	);
}

export async function createCollectionTable(
	exec: QueryExecutor,
	name: string,
): Promise<void> {
	await exec.query(`DEFINE TABLE ${escapeIdentifier(name)}`);
}

export async function dropCollectionTable(
	exec: QueryExecutor,
	name: string,
): Promise<boolean> {
	try {
		await exec.query(`REMOVE TABLE ${escapeIdentifier(name)}`);
		return true;
	} catch {
		return false;
	}
}

export async function dropDatabase(
	exec: QueryExecutor,
	name: string,
): Promise<boolean> {
	try {
		await exec.query(`REMOVE DATABASE ${escapeIdentifier(name)}`);
		return true;
	} catch {
		return false;
	}
}
