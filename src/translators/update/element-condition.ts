/**
 * The conditions an update can put on an element of an array: a `$pull`
 * condition (`{$pull: {v: {$gt: 5}}}`) and an `arrayFilters` entry
 * (`{"e.score": {$gte: 90}}`).
 *
 * Both are MongoDB *query* predicates, applied to a value the update finds in an
 * array — "as if it were a document in a collection", in the words of the
 * `$pull` documentation — so they mean what the same operator means in a
 * `find()` filter, and this module builds them with the filter translator's own
 * predicates rather than a second set. What that buys is everything a filter's
 * reading of a field has and a bare SurrealQL comparison lacks:
 *
 *   - an ordering operator brackets by BSON type, so `{$gt: 5}` does not match a
 *     string;
 *   - equality sees into an array: `{$eq: 7}` matches `[7, 8]` as well as `7`,
 *     `{$in: [7]}` the same, and `{$ne: 7}` and `{$nin: [7]}` are their exact
 *     negations, so neither matches `[7, 8]`;
 *   - `null` is a null, a missing field, or an array holding a null.
 *
 * The two operator tables this replaces — one for `$pull`, one for `arrayFilters`
 * — each mapped `$eq` to `=`, `$ne` to `!=`, `$in` to `IN` and `$nin` to `NOT IN`,
 * and so compared an element as a plain value. `{$pull: {v: {$eq: 7}}}` over
 * `[[7, 8], 7]` left `[[7, 8]]` where MongoDB leaves `[]`; `{$pull: {v: {$ne: 7}}}`
 * removed an element that is an array holding a 7, which MongoDB keeps; and an
 * `arrayFilters` entry of `{"e.p": null}` missed an element with no `p`.
 *
 * What a *bare* value means is not this module's: `{$pull: {v: 7}}` is whole-value
 * equality in MongoDB, and does not remove `[7, 8]`.
 */

import { MongoCompatibilityError } from "../../errors.ts";
import {
	equalityPredicate,
	inequalityPredicate,
	type PredicateContext,
} from "../filter/operators/comparison.ts";
import {
	membershipPredicate,
	nonMembershipPredicate,
} from "../filter/operators/membership.ts";
import { isRangeOperator, rangePredicate } from "../filter/operators/range.ts";

/**
 * The condition `operator` with `operand` puts on `field`, or `undefined` when
 * the operator is not one an element condition takes, so the caller can refuse
 * it in its own words.
 *
 * `field` is SurrealQL reading the value being tested, and has to be one a
 * *field* is read through: for the element itself that is not the `$this` the
 * filter translator reads as an `$elemMatch` element, a plain value — see
 * `PULLED_ELEMENT` in `operators/array.ts`.
 */
export function elementCondition(
	operator: string,
	field: string,
	operand: unknown,
	ctx: PredicateContext,
): string | undefined {
	if (isRangeOperator(operator)) {
		// A filtered array path or a closure over an array is not a table scan, so
		// there is no planner for the leading range to serve.
		return rangePredicate(field, operator, operand, ctx, {
			leadingRange: false,
		});
	}

	switch (operator) {
		case "$eq":
			return equalityPredicate(field, operand, ctx);
		case "$ne":
			return inequalityPredicate(field, operand, ctx);
		case "$in":
			return membershipPredicate(field, operand, ctx);
		case "$nin":
			return nonMembershipPredicate(field, operand, ctx);
		default:
			return undefined;
	}
}

/**
 * The condition a bare value puts on `field`: MongoDB equality, read as a
 * filter's `{field: value}` is — see the top of the file.
 *
 * A regular expression is refused. In MongoDB it is `{$regex: …}`, and `$regex`
 * is not an operator an element condition takes here; compared as a *value*, as
 * equality would have it, it matches nothing, so `{$pull: {tags: /^a/}}` removed
 * no tag and said nothing.
 */
export function bareCondition(
	field: string,
	value: unknown,
	ctx: PredicateContext,
): string {
	refuseRegExp(value);
	return equalityPredicate(field, value, ctx);
}

/** Refuse a regular expression as the condition on an element: see `bareCondition`. */
export function refuseRegExp(value: unknown): void {
	if (!(value instanceof RegExp)) return;
	throw new MongoCompatibilityError(
		"A regular expression is not supported as a condition on an array element in $pull or arrayFilters: it is a $regex, which these conditions do not take, and compared as a value it would match nothing.",
	);
}
