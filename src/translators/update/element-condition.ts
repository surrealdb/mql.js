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
 *
 * ## Which operators
 *
 * MongoDB takes a query operator in a `$pull` condition when it is one a field
 * can have: the comparisons above, and `$regex` (with `$options`), `$exists`,
 * `$type`, `$mod`, `$size`, `$all` and `$elemMatch`. It refuses the rest — `$not`
 * ("unknown top level operator"), `$and`/`$or`/`$nor` and `$comment` (whose
 * sub-conditions would need field names), `$expr`, `$where`, `$text`,
 * `$jsonSchema` and `$near` ("not allowed in this context") — and so does this
 * module, by naming what it takes and nothing else. The seven are built by the
 * filter translator's operators, through `translateFieldOperators`, and each was
 * measured against a real `mongod` as the value of a field before being let
 * through. `$bitsAllSet` and its kin and `$geoWithin` are taken by MongoDB too
 * and not by this driver's filters, so there is nothing to build them from.
 */

import { MongoInvalidArgumentError } from "../../errors.ts";
import { translateFieldOperators } from "../filter/index.ts";
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
import type { UpdateContext } from "./update-context.ts";

/**
 * The operators the filter translator builds for an element condition, with
 * `$options`, which is not an operator but qualifies `$regex`.
 */
const FILTER_OPERATORS = new Set([
	"$regex",
	"$options",
	"$exists",
	"$type",
	"$mod",
	"$size",
	"$all",
	"$elemMatch",
]);

/**
 * The condition `operator` with `operand` puts on `field`, or `undefined` when
 * the operator is not one of the comparisons built directly here.
 *
 * `field` is SurrealQL reading the value being tested, and has to be one a
 * *field* is read through: for the element itself that is not the `$this` the
 * filter translator reads as an `$elemMatch` element, a plain value — see
 * `PULLED_ELEMENT` in `operators/array.ts`.
 */
function comparisonCondition(
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
 * The conditions an operator object puts on `field`, ANDed by the caller.
 *
 * `refusedIn` names the caller in the refusal of an operator MongoDB does not
 * take there, as `Unsupported operator in $pull condition: $not`.
 */
export function elementConditions(
	field: string,
	spec: Record<string, unknown>,
	ctx: UpdateContext,
	refusedIn: string,
): string[] {
	const conditions: string[] = [];
	const fromFilter: Record<string, unknown> = {};

	for (const [operator, operand] of Object.entries(spec)) {
		const condition = comparisonCondition(operator, field, operand, ctx);
		if (condition !== undefined) {
			conditions.push(condition);
		} else if (FILTER_OPERATORS.has(operator)) {
			fromFilter[operator] = operand;
		} else {
			throw new MongoInvalidArgumentError(
				`Unsupported operator in ${refusedIn}: ${operator}`,
			);
		}
	}

	if (Object.keys(fromFilter).length > 0) {
		conditions.push(translateFieldOperators(field, fromFilter, ctx));
	}
	return conditions;
}

/**
 * The condition a bare value puts on `field`: MongoDB equality, read as a
 * filter's `{field: value}` is — see the top of the file.
 *
 * A regular expression is a `$regex`, as it is in a filter.
 */
export function bareCondition(
	field: string,
	value: unknown,
	ctx: UpdateContext,
): string {
	if (value instanceof RegExp) {
		return translateFieldOperators(field, { $regex: value }, ctx);
	}
	return equalityPredicate(field, value, ctx);
}
