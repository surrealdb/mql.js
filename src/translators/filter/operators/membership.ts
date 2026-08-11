/**
 * Membership operators: $in, $nin.
 */

import type { FilterOperator } from "../operator-registry.ts";
import type { TranslateContext } from "../translate-context.ts";
import { arrayTypeCheckFn, isIdentityField } from "./comparison.ts";

/**
 * Predicate for `$in`: match when the field equals any listed value, or — when
 * the field holds an array — when any listed value is one of its elements.
 *
 * Defect fixed: `field IN $p` alone is whole-value membership, so
 * `{tags: {$in: ["a"]}}` returned nothing for `{tags: ["a", "b"]}` even though
 * that is the everyday MongoDB idiom. The `ANYINSIDE` arm adds the
 * array-intersection reading while `IN` keeps both the scalar case and whole-
 * array equality (`{tags: {$in: [["a", "b"]]}}`) working.
 *
 * `ANYINSIDE` is guarded by `type::is_array` for the same reason
 * `equalityPredicate`'s `CONTAINS` arm is: SurrealQL's set operators are
 * overloaded over strings and objects, and `AND` short-circuits so an absent
 * field never reaches it.
 */
function membershipPredicate(
	field: string,
	value: unknown,
	ctx: TranslateContext,
): string {
	const p = ctx.bind(value);

	const arms = [
		`${field} IN $${p}`,
		`(${arrayTypeCheckFn(ctx)}(${field}) AND ${field} ANYINSIDE $${p})`,
	];

	// `{a: {$in: [null]}}` matches an absent `a` in MongoDB, exactly as
	// `{a: null}` does. `IN` already covers the *explicit* null (verified live
	// on 3.x: `NULL IN [NULL]` is true), so only `NONE` needs naming.
	if (Array.isArray(value) && value.includes(null)) {
		arms.push(`${field} IS NONE`);
	}

	return `(${arms.join(" OR ")})`;
}

export const membershipOperators: FilterOperator[] = [
	{
		name: "$in",
		translate(field, value, ctx) {
			// An identity is a single RecordId, never an array or absent, so
			// whole-value membership is the whole story.
			if (isIdentityField(field)) return `${field} IN $${ctx.bind(value)}`;
			return membershipPredicate(field, value, ctx);
		},
	},
	{
		name: "$nin",
		translate(field, value, ctx) {
			if (isIdentityField(field)) return `${field} NOT IN $${ctx.bind(value)}`;
			// `$nin` is the negation of `$in`, which is why it also matches a
			// document that has no such field at all.
			return `!${membershipPredicate(field, value, ctx)}`;
		},
	},
];
