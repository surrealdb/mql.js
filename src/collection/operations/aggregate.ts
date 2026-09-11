/**
 * Running an aggregation pipeline.
 *
 * The translation is in `src/translators/aggregate`; this is the operation that
 * executes it and turns the rows back into documents.
 *
 * Decoding is where a pipeline differs from a `find()`. A read returns stored
 * records, so `recordToDocument` maps SurrealDB's `id` back to `_id`. A pipeline
 * mostly does not: once a `$group` or an inclusion `$project` has run, the rows
 * are computed values with a literal `_id` field and no record identity at all.
 * Running the identity mapping over those would invent an `_id` where the
 * caller had excluded one, so it is applied only while the rows are still
 * records — which the translator tracks itself (`identityIsPlainField`) rather
 * than being guessed here from which stage *names* appeared. The guess used to
 * live here, and it was wrong for an exclusion `$project`: `{$project: {secret:
 * 0}}` does not rename anything, but the guess treated any pipeline containing
 * `$project` as reshaped and left a stored row's identity undecoded — the row
 * came back carrying a raw `id` column instead of a decoded `_id`.
 */

import { MongoCompatibilityError } from "../../errors.ts";
import { reviveBsonValues } from "../../surreal/bson-codec.ts";
import { escapeIdentifier } from "../../surreal/sql/escape.ts";
import { statement } from "../../surreal/sql/statement.ts";
import { translatePipeline } from "../../translators/aggregate/index.ts";
import type { AggregateOptions, Document } from "../../types.ts";
import { recordToDocument, toMongoId } from "../../utils/id.ts";
import { IndexRegistry } from "../index-registry.ts";
import {
	filterOptionsFor,
	type OperationContext,
} from "../operation-context.ts";
import { resolveOperationPlan } from "../operation-options.ts";
import { deleteMany } from "./delete.ts";
import { insertMany } from "./insert.ts";
import { replaceOne } from "./replace.ts";
import { selectRows } from "./select-rows.ts";
import { updateOne } from "./update.ts";

export async function executeAggregate<TSchema extends Document>(
	ctx: OperationContext,
	pipeline: readonly Document[],
	options?: AggregateOptions,
): Promise<TSchema[]> {
	const terminal = terminalWrite(pipeline);
	if (terminal) {
		const rows = await executeAggregate<Document>(
			ctx,
			pipeline.slice(0, -1),
			options,
		);
		await runTerminalWrite(ctx, terminal, rows);
		// MongoDB's own aggregate() answers a pipeline ending in $out/$merge with
		// an empty cursor: the rows went to the collection, not to the caller.
		return [];
	}

	const plan = await resolveOperationPlan(ctx, options);
	const filterOptions = await filterOptionsFor(ctx, undefined);

	const { sql, bindings, isBatch, identityIsPlainField } = translatePipeline(
		pipeline,
		{
			table: ctx.escapedTable,
			collection: ctx.collectionName,
			dialect: filterOptions.dialect,
			textFields: filterOptions.textFields,
		},
	);

	// A `$lookup` binds its outer and joined rows ahead of the statement that reads
	// them, so the answer is the last frame rather than the first.
	const rows = await selectRows(ctx, statement(sql, plan.timeout), bindings, {
		lastFrame: isBatch,
	});

	// A pipeline of only row-preserving stages ($match/$sort/$limit/$skip/$unwind,
	// or an exclusion $project/$unset) still yields stored records, and those
	// carry their identity in `id`.
	if (!identityIsPlainField) {
		return rows.map((row) => recordToDocument<TSchema>(row));
	}

	return rows.map((row) => reviveAggregated(row) as TSchema);
}

/**
 * Decode one row of a reshaped pipeline.
 *
 * The rows are computed values rather than records, so the `id` → `_id` mapping
 * a read does would invent an identity. One thing still has to be mapped: a
 * `$project` or `$group` that named `_id` selected SurrealDB's `id` column into
 * it, so that field holds a `RecordId` and the caller is owed the `_id` they
 * inserted. `toMongoId` passes anything that is not a record id straight
 * through, so a `$group` key that happens to be called `_id` and holds a string
 * is untouched.
 */
function reviveAggregated(row: Record<string, unknown>): Document {
	return mapIdentities(reviveBsonValues(row)) as Document;
}

/**
 * Map every `_id` in the value, however deep, through the read path's `toMongoId`.
 *
 * Depth matters because of `$lookup`: the joined documents sit inside an array
 * field, each carrying an `_id` that is still a `RecordId`, and a later `$unwind`
 * or `$project` can move them anywhere in the document. Walking rather than
 * reaching for a known field is what survives that.
 *
 * Safe to apply blindly: `toMongoId` passes through anything that is not a record
 * id, so a `$group` key that happens to be called `_id` and holds a string is
 * untouched.
 */
function mapIdentities(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(mapIdentities);

	if (value === null || typeof value !== "object") return value;
	// Only plain objects are walked. A `Date`, an `ObjectId` or a `RecordId` is a
	// value, and rebuilding it field by field would destroy it.
	if (Object.getPrototypeOf(value) !== Object.prototype) return value;

	const mapped: Document = {};
	for (const [key, nested] of Object.entries(value as Document)) {
		mapped[key] = key === "_id" ? toMongoId(nested) : mapIdentities(nested);
	}
	return mapped;
}

/**
 * `$out` and `$merge` — writing a pipeline's output into a collection.
 *
 * Neither is folded into SQL by the translator: they write, and the translator
 * never touches the executor. This is why they are stripped off here, before
 * `translatePipeline` ever sees them — the rest of the pipeline runs exactly
 * the way any other aggregation does, through the same decode path above, and
 * what comes back is a plain `Document[]` of exactly what the caller would have
 * received had the pipeline ended one stage earlier.
 *
 * That materialised array is then written with the operations that already
 * write correctly — `insertMany`, `replaceOne`, `updateOne` — rather than by
 * re-deriving `_id`'s conversion to a `RecordId` in SurrealQL. `bulkWrite` made
 * the same call for the same reason: rebuilding logic this driver already has,
 * to save a round trip, is where two implementations quietly drift apart. The
 * cost is real and is documented in the README: `$merge` is one statement per
 * document, where MongoDB's is one write to its own storage engine.
 */
interface TerminalWrite {
	readonly kind: "out" | "merge";
	readonly into: string;
	readonly on: "_id";
	readonly whenMatched: "replace" | "merge";
	readonly whenNotMatched: "insert";
}

function terminalWrite(
	pipeline: readonly Document[],
): TerminalWrite | undefined {
	const last = pipeline[pipeline.length - 1];
	if (!last || typeof last !== "object") return undefined;

	if ("$out" in last) return readOutSpec(last.$out);
	if ("$merge" in last) return readMergeSpec(last.$merge);
	return undefined;
}

function readOutSpec(spec: unknown): TerminalWrite {
	if (typeof spec !== "string" || spec.length === 0) {
		throw new MongoCompatibilityError(
			"$out takes the target collection name as a string. The {db, coll} form is not supported: this driver addresses one database per connection, and writing into another one is not something a single aggregate() call can do here.",
		);
	}
	return {
		kind: "out",
		into: spec,
		on: "_id",
		whenMatched: "replace",
		whenNotMatched: "insert",
	};
}

const WHEN_MATCHED = new Set(["replace", "merge"]);

function readMergeSpec(spec: unknown): TerminalWrite {
	const into = typeof spec === "string" ? spec : (spec as Document)?.into;
	if (typeof into !== "string" || into.length === 0) {
		throw new MongoCompatibilityError(
			"$merge takes `into` as a collection name string, or the whole stage as that string. The {db, coll} form of `into` is not supported, for the same reason as $out.",
		);
	}

	const document = typeof spec === "object" && spec !== null ? spec : {};
	const on = (document as Document).on ?? "_id";
	if (on !== "_id") {
		throw new MongoCompatibilityError(
			`$merge's \`on\` is not supported unless it is (or defaults to) "_id": matching on another field would need an index on it in the target collection to do safely, and this driver does not check for one. Given ${JSON.stringify(on)}.`,
		);
	}

	const whenMatched = (document as Document).whenMatched ?? "merge";
	if (typeof whenMatched !== "string" || !WHEN_MATCHED.has(whenMatched)) {
		throw new MongoCompatibilityError(
			`$merge's whenMatched is not supported unless it is "merge" (the default) or "replace". "keepExisting", "fail" and a custom pipeline all need a per-document decision this driver does not make. Given ${JSON.stringify(whenMatched)}.`,
		);
	}

	const whenNotMatched = (document as Document).whenNotMatched ?? "insert";
	if (whenNotMatched !== "insert") {
		throw new MongoCompatibilityError(
			`$merge's whenNotMatched is not supported unless it is "insert" (the default). "discard" and "fail" both change what happens to documents this driver has already committed to writing by the time it would find out. Given ${JSON.stringify(whenNotMatched)}.`,
		);
	}

	return {
		kind: "merge",
		into,
		on: "_id",
		whenMatched: whenMatched as "replace" | "merge",
		whenNotMatched: "insert",
	};
}

async function runTerminalWrite(
	ctx: OperationContext,
	terminal: TerminalWrite,
	rows: readonly Document[],
): Promise<void> {
	const target = targetContext(ctx, terminal.into);

	if (terminal.kind === "out") {
		// MongoDB's $out replaces the whole target collection, atomically from the
		// caller's point of view. `deleteMany` then `insertMany` is two statements
		// rather than one — the same honestly-documented tradeoff `bulkWrite` makes
		// for reusing operations that are already correct.
		await deleteMany(target, {});
		if (rows.length > 0) await insertMany(target, rows as never[]);
		return;
	}

	// $merge, one document at a time: `replace` is `replaceOne` with `upsert`,
	// which already does exactly MongoDB's whenMatched:"replace"/whenNotMatched:
	// "insert". `merge` (MongoDB's default) is `updateOne` with `$set`, which is a
	// shallow merge for exactly the same reason `$set` and `$addFields` already
	// are — fields the incoming document does not name are left alone.
	for (const row of rows) {
		const { _id, ...rest } = row;
		const filter = { _id } as never;
		if (terminal.whenMatched === "replace") {
			await replaceOne(target, filter, rest as never, { upsert: true });
		} else {
			await updateOne(target, filter, { $set: rest } as never, {
				upsert: true,
			});
		}
	}
}

/** An `OperationContext` addressing a different collection over the same connection. */
function targetContext(
	ctx: OperationContext,
	collectionName: string,
): OperationContext {
	return {
		...ctx,
		collectionName,
		escapedTable: escapeIdentifier(collectionName),
		indexes: new IndexRegistry(),
	};
}
