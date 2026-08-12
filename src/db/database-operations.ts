/**
 * Database-level admin operations: list collections and databases, create/drop
 * a collection, drop the whole database, and the counts `dbStats` and
 * `collStats` report.
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

/**
 * Fields a `listDatabases` filter may constrain.
 *
 * The same in-memory reply filtering as `listCollections`, over the one field
 * the reply carries: SurrealDB reports no per-database size, so there is no
 * `sizeOnDisk` or `empty` to predicate on.
 */
const LIST_DATABASES_FILTER_FIELDS = ["name"] as const;

/** Does `value` satisfy `condition`, for the subset of operators supported? */
function matchesReplyField(
	value: string,
	condition: unknown,
	command: string,
): boolean {
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
							`Unsupported operator in a ${command} filter: ${operator}`,
						);
				}
			},
		);
	}

	return false;
}

/** Reject a reply filter naming a field the reply does not carry. */
function assertFilterFields(
	filter: Document | undefined,
	fields: readonly string[],
	command: string,
	subject: string,
): void {
	if (!filter) return;
	for (const field of Object.keys(filter)) {
		if (!fields.includes(field)) {
			throw new MongoInvalidArgumentError(
				`Unsupported field in a ${command} filter: ${field}. Only ${fields.join(" and ")} ${fields.length === 1 ? "is" : "are"} reported for ${subject}.`,
			);
		}
	}
}

export async function listCollections(
	exec: QueryExecutor,
	filter?: Document,
): Promise<CollectionInfo[]> {
	assertFilterFields(
		filter,
		LIST_COLLECTIONS_FILTER_FIELDS,
		"listCollections",
		"a collection",
	);

	const collections = (await listTableNames(exec)).map((name) => ({
		name,
		type: "collection" as const,
	}));

	if (!filter) return collections;

	return collections.filter((collection) =>
		Object.entries(filter).every(([field, condition]) =>
			matchesReplyField(
				collection[field as (typeof LIST_COLLECTIONS_FILTER_FIELDS)[number]],
				condition,
				"listCollections",
			),
		),
	);
}

/**
 * Every table defined in the database `exec` addresses.
 *
 * Shared by `listCollections` and the stats commands, all of which need the same
 * `INFO FOR DB` reply. SurrealDB defines a table on first write, so this is also
 * the answer to "does this collection exist" — which is what `Collection.options`
 * and `Collection.isCapped` ask before reporting on one.
 */
export async function listTableNames(
	exec: QueryExecutor,
): Promise<readonly string[]> {
	const info = await exec.query<Record<string, unknown>>("INFO FOR DB");
	if (!info) return [];

	const tables = (info.tables ?? info.tb ?? {}) as Record<string, unknown>;
	return Object.keys(tables);
}

/**
 * Every database in the connected namespace, as `listDatabases` reports them.
 *
 * A SurrealDB namespace is what a MongoDB deployment is here — the container a
 * connection's databases live in — so `INFO FOR NS` is the counterpart of
 * MongoDB's deployment-wide `listDatabases`.
 */
export async function listDatabaseNames(
	exec: QueryExecutor,
	filter?: Document,
): Promise<readonly string[]> {
	assertFilterFields(
		filter,
		LIST_DATABASES_FILTER_FIELDS,
		"listDatabases",
		"a database",
	);

	const info = await exec.query<Record<string, unknown>>("INFO FOR NS");
	if (!info) return [];

	const databases = (info.databases ?? info.db ?? {}) as Record<
		string,
		unknown
	>;
	const names = Object.keys(databases);

	if (!filter) return names;

	return names.filter((name) =>
		Object.entries(filter).every(([, condition]) =>
			matchesReplyField(name, condition, "listDatabases"),
		),
	);
}

/**
 * Documents stored across the given tables, in one statement.
 *
 * SurrealQL takes several targets in one `FROM`, so the whole database is
 * counted in a single round trip rather than one per table. An empty list has
 * nothing to select from, so it answers without asking.
 */
export async function countDocumentsIn(
	exec: QueryExecutor,
	tables: readonly string[],
): Promise<number> {
	if (tables.length === 0) return 0;

	const targets = tables.map(escapeIdentifier).join(", ");
	const rows = await exec.query<{ count: number }[]>(
		`SELECT count() AS count FROM ${targets} GROUP ALL`,
	);
	return rows?.[0]?.count ?? 0;
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

/**
 * Remove a whole database.
 *
 * The `catch` is what makes `escapeIdentifier` load-bearing here rather than
 * merely correct: a name it failed to quote would be a parse error, the parse
 * error would be swallowed below, and a database that could have been dropped
 * would be reported as one that was not.
 */
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
