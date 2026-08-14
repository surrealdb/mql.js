/**
 * Running a statement whose answer for a collection that does not exist is
 * "no rows".
 *
 * MongoDB treats a collection it has never seen as an empty one. `find` returns
 * `[]`, `findOne` `null`, `countDocuments` `0`, `distinct` `[]`, `deleteMany`
 * `{deletedCount: 0}`, `updateMany` `{matchedCount: 0}` — measured against a real
 * `mongod`, not assumed. SurrealDB instead refuses to read a table it holds no
 * definition for, so every one of those threw where MongoDB answers.
 *
 * Each of those answers is derived from an empty row set by the operation that
 * asked for it, so the tolerance is expressed once, here, as "no rows" — rather
 * than once per operation as `0`, `null`, `[]` and `{deletedCount: 0}`.
 *
 * **Not** in the executor, though, which is the other obvious place for it. The
 * executor is shared by every statement this driver issues and knows nothing about
 * which collection any of them is for, so it could neither check that the missing
 * table is the one the caller asked about nor tell a read from a write that has to
 * create the table. `insertOne`, `insertMany` and the inserting half of an upsert
 * therefore keep going through `ctx.executor.query` directly: their whole purpose
 * is to bring the table into existence, and a "missing table" reported to one of
 * them is a real failure.
 */

import { isMissingTableError } from "../../surreal/error-mapper.ts";
import type { OperationContext } from "../operation-context.ts";

/**
 * Run `sql` and return the rows it produced, or none when the collection does
 * not exist.
 *
 * Also normalises the empty result: SurrealDB answers a statement that matched
 * nothing with `undefined` rather than with an empty array.
 */
export async function selectRows<T = Record<string, unknown>>(
	ctx: OperationContext,
	sql: string,
	bindings?: Record<string, unknown>,
	options?: {
		/**
		 * Read the last statement's result rather than the first.
		 *
		 * For a batch whose earlier statements set something up — an aggregation
		 * `$lookup` binds its outer and joined rows before reading them.
		 */
		readonly lastFrame?: boolean;
	},
): Promise<T[]> {
	try {
		const run = options?.lastFrame
			? ctx.executor.queryLast<T[]>(sql, bindings)
			: ctx.executor.query<T[]>(sql, bindings);
		return (await run) ?? [];
	} catch (err) {
		if (isMissingTableError(err, ctx.collectionName)) return [];
		throw err;
	}
}
