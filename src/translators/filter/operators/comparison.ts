/**
 * Comparison operators: $eq, $ne, $gt, $gte, $lt, $lte.
 *
 * The ordering operators ($gt, $gte, $lt, $lte) are plain `field <sql-op>
 * $param` and are generated from one factory. Equality is not: MongoDB's
 * `{f: v}` is neither whole-value equality nor a single SurrealQL operator, so
 * $eq / $ne are built by the exported predicate helpers below. Those helpers
 * are the single definition of "MongoDB equality" for the whole filter
 * translator — the implicit-equality path in `../index.ts` and the
 * `$elemMatch` sub-conditions in `./array.ts` both call them.
 */

import { MONGO_ID_FIELD, SURREAL_ID_FIELD } from "../id-field.ts";
import type { FilterOperator } from "../operator-registry.ts";
import type { TranslateContext } from "../translate-context.ts";

/**
 * True when `field` addresses the document identity.
 *
 * `id` is SurrealDB's identity column (what `_id` is rewritten to once the
 * collection is known) and `_id` is the MongoDB spelling that survives when it
 * is not. An identity is always exactly one present `RecordId` — MongoDB itself
 * refuses to store an array `_id` — so identity comparisons stay plain `=` /
 * `!=` and skip the array- and null-aware arms below, which could only ever
 * add noise (and, for `CONTAINS`, false positives).
 */
export function isIdentityField(field: string): boolean {
	return field === SURREAL_ID_FIELD || field === MONGO_ID_FIELD;
}

/**
 * The dialect's `type::is_array` spelling.
 *
 * Resolved through the dialect rather than hard-coded so a future SurrealDB
 * major can rename it in one place; the fallback keeps the helper total and is
 * unreachable for every dialect this driver supports.
 */
export function arrayTypeCheckFn(ctx: TranslateContext): string {
	return ctx.dialect.typeCheckFn("array") ?? "type::is_array";
}

/**
 * Predicate for `{f: null}`.
 *
 * MongoDB matches both a document whose `f` is explicitly null *and* one that
 * has no `f` at all. SurrealDB keeps those two states distinct — `NULL` for an
 * explicit null, `NONE` for an absent field — so both have to be named.
 *
 * Defect fixed: `f = $p` with a bound `null` only ever matched the explicit
 * null, so `{a: null}` silently missed every document without an `a`.
 */
export function nullEqualityPredicate(field: string): string {
	return `(${field} IS NULL OR ${field} IS NONE)`;
}

/**
 * Predicate for MongoDB equality against `field`.
 *
 * MongoDB equality against an array field matches when the value equals the
 * whole array *or* is one of its elements: `{tags: "a"}` matches both
 * `{tags: "a"}` and `{tags: ["a", "b"]}`, and `{tags: ["a", "b"]}` still
 * matches the whole array. SurrealQL `=` is whole-value equality only, so the
 * element arm has to be spelled out with `CONTAINS`.
 *
 * The `type::is_array` guard on that arm is load-bearing, not defensive:
 * SurrealQL `CONTAINS` is overloaded, and verified live on SurrealDB 3.x
 * `'abc' CONTAINS 'a'` is a substring test (true) while `{k: 1} CONTAINS 'k'`
 * is a key test (true). Without the guard `{t: "a"}` would wrongly match
 * `{t: "abc"}`. `AND` short-circuits, so the guard also keeps the arm from
 * being evaluated for absent fields.
 */
export function equalityPredicate(
	field: string,
	value: unknown,
	ctx: TranslateContext,
): string {
	if (value === null) return nullEqualityPredicate(field);

	const p = ctx.bind(value);
	if (isIdentityField(field)) return `${field} = $${p}`;

	return `(${field} = $${p} OR (${arrayTypeCheckFn(ctx)}(${field}) AND ${field} CONTAINS $${p}))`;
}

/**
 * Predicate for `$ne`, the exact negation of `equalityPredicate`.
 *
 * The array arm has to be negated too: `{tags: {$ne: "a"}}` does *not* match
 * `{tags: ["a", "b"]}` in MongoDB. `{f: {$ne: null}}` matches neither an
 * explicit null nor an absent field.
 */
export function inequalityPredicate(
	field: string,
	value: unknown,
	ctx: TranslateContext,
): string {
	if (value === null) return `(${field} IS NOT NULL AND ${field} IS NOT NONE)`;

	const p = ctx.bind(value);
	if (isIdentityField(field)) return `${field} != $${p}`;

	return `!(${field} = $${p} OR (${arrayTypeCheckFn(ctx)}(${field}) AND ${field} CONTAINS $${p}))`;
}

function makeBinary(name: string, sqlOp: string): FilterOperator {
	return {
		name,
		translate(field, value, ctx) {
			const p = ctx.bind(value);
			return `${field} ${sqlOp} $${p}`;
		},
	};
}

export const comparisonOperators: FilterOperator[] = [
	{
		name: "$eq",
		translate(field, value, ctx) {
			return equalityPredicate(field, value, ctx);
		},
	},
	{
		name: "$ne",
		translate(field, value, ctx) {
			return inequalityPredicate(field, value, ctx);
		},
	},
	makeBinary("$gt", ">"),
	makeBinary("$gte", ">="),
	makeBinary("$lt", "<"),
	makeBinary("$lte", "<="),
];
