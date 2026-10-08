/**
 * Equality operators: $eq and $ne.
 *
 * MongoDB's `{f: v}` is neither whole-value equality nor a single SurrealQL
 * operator, so $eq / $ne are built by the exported predicate helpers below.
 * Those helpers are the single definition of "MongoDB equality" for the whole
 * filter translator — the implicit-equality path in `../index.ts`, the
 * `$elemMatch` sub-conditions in `./array.ts` and the `$gte: null` / `$lte: null`
 * arms of `./range.ts` all call them. The ordering operators ($gt, $gte, $lt,
 * $lte) live in `./range.ts`.
 */

import { escapeIdentifier } from "../../../surreal/sql/escape.ts";
import { MONGO_ID_FIELD, SURREAL_ID_FIELD } from "../id-field.ts";
import type { FilterOperator } from "../operator-registry.ts";
import type { TranslateContext } from "../translate-context.ts";

/**
 * What the predicate builders in this file and in `./range.ts` need of a
 * translation context: the dialect their type checks are spelled in, and a way
 * to bind the operand.
 *
 * A narrower contract than `TranslateContext`, so that the update translator —
 * whose `$pull` and `arrayFilters` conditions are the same MongoDB predicates
 * applied to an array element — can use them without a filter context it has no
 * other use for.
 */
export type PredicateContext = Pick<TranslateContext, "dialect" | "bind">;

/**
 * The field an `$elemMatch` addresses its own element by.
 *
 * Conditions written without a field name — `{tags: {$elemMatch: {$gt: 5}}}` —
 * apply to the element itself, and SurrealQL's name for the element a filtered
 * projection (`field[WHERE …]`) is currently visiting is `$this`. An operator
 * handed this as its field is therefore looking at one array element rather than
 * at a document field, which changes what it may do with an array: see
 * `./range.ts`.
 */
export const ELEMENT_FIELD = "$this";

/**
 * True when `field` addresses the document identity.
 *
 * `id` is SurrealDB's identity column (what `_id` is rewritten to once the
 * collection is known) and `_id` is the MongoDB spelling that survives when it
 * is not. An identity is always exactly one present `RecordId` — MongoDB itself
 * refuses to store an array `_id` — so identity comparisons stay plain `=` /
 * `!=` and skip the array- and null-aware arms below, which could only ever
 * add noise (and, for `CONTAINS`, false positives).
 *
 * What arrives here is emitted SurrealQL, not the caller's field name: the
 * operators are handed an escaped path and nothing else. So the MongoDB spelling
 * is recognised through `escapeIdentifier` rather than as a bare string, which is
 * what keeps the two sides from drifting — `id` is the driver's own column name
 * and is emitted as-is, while `_id` reaches an operator quoted, exactly as every
 * other field path does.
 */
export function isIdentityField(field: string): boolean {
	return (
		field === SURREAL_ID_FIELD || field === escapeIdentifier(MONGO_ID_FIELD)
	);
}

/**
 * The dialect's `type::is_array` spelling.
 *
 * Resolved through the dialect rather than hard-coded so a future SurrealDB
 * major can rename it in one place; the fallback keeps the helper total and is
 * unreachable for every dialect this driver supports.
 */
export function arrayTypeCheckFn(ctx: PredicateContext): string {
	return ctx.dialect.typeCheckFn("array") ?? "type::is_array";
}

/**
 * Arm of `{f: null}` for an array field: an element that is an explicit null.
 *
 * MongoDB's equality against an array field matches when any element equals the
 * operand, so `{f: null}` matches `{f: [1, null]}` as `{f: 1}` does. It does not
 * descend: `{f: [[null]]}` has one element, an array. A path that crosses an
 * array of documents is covered too — `{"items.x": null}` reads `x` out of every
 * item, SurrealQL evaluates that to the list of them, and a list holding a null
 * is an array holding one.
 *
 * What it cannot see is an element that is *absent*: MongoDB also counts an item
 * with no `x` as null, so `[{y: 1}]` matches `{"items.x": null}`. SurrealQL
 * stands `NONE` in for that item, and for a scalar element too — `v.a` over
 * `[1, 2]` is `[NONE, NONE]`, which MongoDB does not match — so the two cannot be
 * told apart from the list, and naming `NONE` would trade one wrong answer for
 * another. It is left unmatched, as it always was.
 *
 * Guarded by `type::is_array` for the reason `equalityPredicate`'s `CONTAINS`
 * arm is: `CONTAINS` is overloaded over strings and objects.
 */
function nullElementArm(field: string, ctx: PredicateContext): string {
	return `(${arrayTypeCheckFn(ctx)}(${field}) AND ${field} CONTAINS NULL)`;
}

/**
 * True when `field` is a value to compare as a whole, with no elements to look
 * inside: the document identity, which is one RecordId, and an `$elemMatch`
 * element, which is the value being matched.
 */
function isWholeValue(field: string): boolean {
	return isIdentityField(field) || field === ELEMENT_FIELD;
}

/**
 * Predicate for `{f: null}`.
 *
 * MongoDB matches both a document whose `f` is explicitly null *and* one that
 * has no `f` at all. SurrealDB keeps those two states distinct — `NULL` for an
 * explicit null, `NONE` for an absent field — so both have to be named. As with
 * every equality, an array field matches when one of its elements does: see
 * `nullElementArm`.
 *
 * Defects fixed: `f = $p` with a bound `null` only ever matched the explicit
 * null, so `{a: null}` silently missed every document without an `a`; and the
 * `IS NULL OR IS NONE` that replaced it saw only the field itself, so
 * `{a: null}` missed `a: [1, null]` and `{"items.x": null}` missed
 * `items: [{x: null}]`.
 */
export function nullEqualityPredicate(
	field: string,
	ctx: PredicateContext,
): string {
	const own = `${field} IS NULL OR ${field} IS NONE`;
	if (isWholeValue(field)) return `(${own})`;
	return `(${own} OR ${nullElementArm(field, ctx)})`;
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
	ctx: PredicateContext,
): string {
	if (value === null) return nullEqualityPredicate(field, ctx);

	const p = ctx.bind(value);
	if (isIdentityField(field)) return `${field} = $${p}`;

	return `(${field} = $${p} OR (${arrayTypeCheckFn(ctx)}(${field}) AND ${field} CONTAINS $${p}))`;
}

/**
 * Predicate for `$ne`, the exact negation of `equalityPredicate`.
 *
 * The array arm has to be negated too: `{tags: {$ne: "a"}}` does *not* match
 * `{tags: ["a", "b"]}` in MongoDB. `{f: {$ne: null}}` matches neither an
 * explicit null nor an absent field, nor an array with a null element.
 */
export function inequalityPredicate(
	field: string,
	value: unknown,
	ctx: PredicateContext,
): string {
	if (value === null) {
		if (isWholeValue(field)) {
			return `(${field} IS NOT NULL AND ${field} IS NOT NONE)`;
		}
		return `!${nullEqualityPredicate(field, ctx)}`;
	}

	const p = ctx.bind(value);
	if (isIdentityField(field)) return `${field} != $${p}`;

	return `!(${field} = $${p} OR (${arrayTypeCheckFn(ctx)}(${field}) AND ${field} CONTAINS $${p}))`;
}

/** `$eq` and `$ne`. The ordering operators are `rangeOperators`. */
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
];
