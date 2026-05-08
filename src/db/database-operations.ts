/**
 * Database-level admin operations: list collections, create/drop a
 * collection, drop the whole database.
 *
 * Each function takes a plain `QueryExecutor` so it can be unit tested
 * without instantiating the full `Db` facade.
 */

import type { QueryExecutor } from "../surreal/query-executor.ts";
import { escapeIdentifier } from "../surreal/sql/escape.ts";
import type { CollectionInfo } from "../types.ts";

export async function listCollections(
	exec: QueryExecutor,
): Promise<CollectionInfo[]> {
	const info = await exec.query<Record<string, unknown>>("INFO FOR DB");
	if (!info) return [];

	const tables = (info.tables ?? info.tb ?? {}) as Record<string, unknown>;
	return Object.keys(tables).map((name) => ({
		name,
		type: "collection" as const,
	}));
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
