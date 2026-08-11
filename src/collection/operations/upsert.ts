/**
 * The insert half of an upsert.
 *
 * MongoDB does not create an empty document and then update it: the new
 * document starts as the equality constraints of the *filter*, and the update
 * is applied on top. That is what makes get-or-create work — the document
 * created for `{email: e}` carries `email: e`, so the next call finds it instead
 * of inserting a second one — and it is why `updateOne({_id: x}, …,
 * {upsert: true})` creates the document under the id the caller named.
 *
 * SurrealDB's `UPSERT … WHERE` cannot express any of that: it applies only the
 * `SET` clause, so a record created that way is missing every field the filter
 * asked for and gets a generated id. The seed is therefore built here, prepended
 * to the caller's update, and applied as one statement — assignments run left to
 * right in SurrealQL, so a `$inc` still sees the seeded value first, exactly as
 * MongoDB's own seed-then-apply order does.
 */

import type { ObjectId } from "../../object-id.ts";
import { statement } from "../../surreal/sql/statement.ts";
import { MONGO_ID_FIELD } from "../../translators/filter/id-field.ts";
import { translateUpdate } from "../../translators/update.ts";
import type { Document } from "../../types.ts";
import { prepareInsert } from "../../utils/id.ts";
import type { OperationContext } from "../operation-context.ts";
import type { OperationPlan } from "../operation-options.ts";

/** What the inserting half of an upsert produced. */
export interface UpsertedDocument {
	/** The `_id` reported as `upsertedId`. */
	readonly insertedId: ObjectId | string | number;
	/** The record as it now stands, for operations that return the document. */
	readonly record: Record<string, unknown> | undefined;
}

/**
 * Field-level operators whose value is an equality the created document must
 * satisfy. Everything else — ranges, negations, regular expressions — describes
 * a set of values rather than one, so MongoDB seeds nothing from it.
 */
const EQUALITY_OPERATOR = "$eq";
const MEMBERSHIP_OPERATOR = "$in";

/**
 * Build the document MongoDB would seed an upsert's insert with.
 *
 * Only equalities contribute, because only an equality names the value the new
 * document must hold: `{age: {$gt: 21}}` says nothing about what `age` should
 * be, and MongoDB creates the document without it.
 */
export function seedFromFilter(filter: Document | undefined): Document {
	const seed: Document = {};
	if (!filter) return seed;

	for (const [key, value] of Object.entries(filter)) {
		if (key.startsWith("$")) {
			Object.assign(seed, seedFromOperator(key, value));
			continue;
		}

		const equality = equalityOf(value);
		if (equality !== undefined) seed[key] = equality;
	}

	return seed;
}

/**
 * What a top-level operator contributes to the seed.
 *
 * `$and` is walked because it is a conjunction of constraints that all have to
 * hold; `$or` is walked only when it has a single branch, which is the shape
 * MongoDB collapses into a plain constraint. `$nor` and the rest describe sets of
 * documents rather than one, so they contribute nothing.
 */
function seedFromOperator(operator: string, value: unknown): Document {
	if (operator === "$and") {
		const seed: Document = {};
		for (const branch of asBranches(value)) {
			Object.assign(seed, seedFromFilter(branch));
		}
		return seed;
	}

	if (operator === "$or") {
		const branches = asBranches(value);
		return branches.length === 1 ? seedFromFilter(branches[0]) : {};
	}

	return {};
}

/** The `$and`/`$or` branches of a value, or none if it is not a list. */
function asBranches(value: unknown): Document[] {
	return Array.isArray(value) ? (value.filter(isDocument) as Document[]) : [];
}

function isDocument(value: unknown): value is Document {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The single value a field constraint pins the field to, or `undefined`.
 *
 * A `$in` with exactly one element is an equality — MongoDB seeds from it, and
 * for the same reason it seeds from `$eq`: there is only one value the document
 * could hold and still match. A regular expression is not one, even written as a
 * bare value, so it seeds nothing.
 */
function equalityOf(constraint: unknown): unknown {
	if (constraint instanceof RegExp) return undefined;
	if (!isOperatorObject(constraint)) return constraint;

	if (EQUALITY_OPERATOR in constraint) {
		return constraint[EQUALITY_OPERATOR];
	}
	const membership = constraint[MEMBERSHIP_OPERATOR];
	if (Array.isArray(membership) && membership.length === 1) {
		return membership[0];
	}
	return undefined;
}

/** True for `{$op: …}`, the shape that constrains a field rather than equalling it. */
function isOperatorObject(value: unknown): value is Record<string, unknown> {
	return (
		isDocument(value) && Object.keys(value).some((key) => key.startsWith("$"))
	);
}

/**
 * Fold the seed into the caller's update as leading `$set` assignments.
 *
 * `$set` first so the update's own operators are applied afterwards and win:
 * `{a: 1}` filtered with `{$inc: {a: 5}}` has to produce `6`, which is what
 * MongoDB produces.
 */
function withSeed(update: Document, seed: Document): Document {
	if (Object.keys(seed).length === 0) return update;

	const { $set: callerSet, ...rest } = update as {
		$set?: Document;
	} & Document;
	return { $set: { ...seed, ...callerSet }, ...rest };
}

/**
 * Insert the document an upsert asks for, and return what it became.
 *
 * `filter` supplies the seed and, when it pins `_id`, the record's identity;
 * `update` is applied on top. Called only once the caller's filter has been
 * established to match nothing.
 */
export async function insertUpserted(
	ctx: OperationContext,
	filter: Document | undefined,
	update: Document,
	plan: OperationPlan,
	options?: { readonly arrayFilters?: Document[] },
): Promise<UpsertedDocument> {
	const seed = seedFromFilter(filter);
	// `_id` addresses the record rather than living inside it, so it leaves the
	// seed and becomes the `RecordId` the statement creates.
	const { [MONGO_ID_FIELD]: id, ...fields } = seed;
	const prepared = prepareInsert(ctx.collectionName, { _id: id });

	const { clause, bindings } = translateUpdate(withSeed(update, fields), 0, {
		arrayFilters: options?.arrayFilters,
		// The statement inserts by definition, so `$setOnInsert` applies.
		upsert: true,
	});

	const rows = await ctx.executor.query<Record<string, unknown>[]>(
		statement("UPSERT $__rid", clause, "RETURN AFTER", plan.timeout),
		{ ...bindings, __rid: prepared.recordId },
	);

	return {
		insertedId: prepared.insertedId,
		record: rows?.[0],
	};
}

/**
 * Insert the *replacement* an upserting replace asks for.
 *
 * A replacement is the whole document, so nothing is seeded from the filter
 * beyond the `_id` it may pin — MongoDB creates exactly the document handed to
 * it.
 */
export async function insertUpsertedReplacement(
	ctx: OperationContext,
	filter: Document | undefined,
	replacement: Document,
	plan: OperationPlan,
): Promise<UpsertedDocument> {
	const seededId = seedFromFilter(filter)[MONGO_ID_FIELD];
	const prepared = prepareInsert(ctx.collectionName, {
		...replacement,
		_id: replacement[MONGO_ID_FIELD] ?? seededId,
	});

	const rows = await ctx.executor.query<Record<string, unknown>[]>(
		statement("CREATE $__rid CONTENT $__doc RETURN AFTER", plan.timeout),
		{ __rid: prepared.recordId, __doc: prepared.data },
	);

	return {
		insertedId: prepared.insertedId,
		record: rows?.[0],
	};
}
