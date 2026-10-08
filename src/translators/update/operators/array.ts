/**
 * Array update operators: $push, $pull, $pullAll, $addToSet, $pop.
 */

import { MongoInvalidArgumentError } from "../../../errors.ts";
import { escapeFieldPath } from "../../../surreal/sql/escape.ts";
import { ELEMENT_FIELD } from "../../filter/operators/comparison.ts";
import {
	isRangeOperator,
	rangePredicate,
} from "../../filter/operators/range.ts";
import type { UpdateOperator } from "../operator-registry.ts";
import type { UpdateContext } from "../update-context.ts";

/**
 * Is this a plain data object, i.e. one whose keys may be read as MongoDB
 * modifiers or query conditions?
 *
 * Class instances (`Date`, `ObjectId`, `RecordId`, …) are values to be matched
 * or appended verbatim, never condition documents, so they are excluded.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function isPushModifier(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		"$each" in (value as Record<string, unknown>)
	);
}

function applyPushWithModifiers(
	field: string,
	mods: Record<string, unknown>,
	ctx: UpdateContext,
): void {
	const f = ctx.resolveField(field);
	const eachParam = ctx.bind(mods.$each);

	let expr: string;
	if (mods.$position !== undefined) {
		const posParam = ctx.bind(mods.$position);
		expr = `array::concat(array::concat(array::slice(${f}, 0, $${posParam}), $${eachParam}), array::slice(${f}, $${posParam}))`;
	} else {
		expr = `array::concat(${f}, $${eachParam})`;
	}

	if (mods.$sort !== undefined) {
		const sortVal = mods.$sort;
		if (typeof sortVal === "number") {
			expr =
				sortVal === -1
					? `array::sort::desc(${expr})`
					: `array::sort::asc(${expr})`;
		} else {
			expr = `array::sort::asc(${expr})`;
		}
	}

	if (mods.$slice !== undefined) {
		const sliceVal = mods.$slice as number;
		const sliceParam = ctx.bind(sliceVal);
		expr =
			sliceVal < 0
				? `array::slice(${expr}, $${sliceParam})`
				: `array::slice(${expr}, 0, $${sliceParam})`;
	}

	ctx.parts.push(`${f} = ${expr}`);
}

export const pushOperator: UpdateOperator = {
	name: "$push",
	apply(entries, ctx) {
		for (const [field, value] of entries) {
			if (isPushModifier(value)) {
				applyPushWithModifiers(field, value as Record<string, unknown>, ctx);
			} else {
				const f = ctx.resolveField(field);
				const p = ctx.bind(value);
				ctx.parts.push(`${f} += [$${p}]`);
			}
		}
	},
};

/**
 * Comparison operators accepted inside a `$pull` condition, mapped to their
 * SurrealQL equivalents. Deliberately the same set the arrayFilters translator
 * supports, so `$pull` and `$[identifier]` accept the same vocabulary. The four
 * ordering operators are listed for that reason alone: they are not translated
 * from this table but by `rangePredicate`, which brackets them by type.
 */
const PULL_COMPARISON_OPS: Record<string, string> = {
	$eq: "=",
	$ne: "!=",
	$gt: ">",
	$gte: ">=",
	$lt: "<",
	$lte: "<=",
	$in: "IN",
	$nin: "NOT IN",
};

/**
 * How a `$pull` condition names the element it is testing, when the condition
 * is about the element itself (`{$pull: {n: {$gt: 3}}}`).
 *
 * MongoDB applies a `$pull` condition to each element "as if it were a document
 * in a collection": the element is the *value of a field*, so an element that is
 * itself an array matches when any of its elements does — `{$pull: {v: {$gt: 5}}}`
 * over `[[7, 8], [1], 6]` leaves `[[1]]`. That is a field's reading, and not an
 * `$elemMatch`'s, where `{$elemMatch: {$gt: 5}}` compares each element as a plain
 * value. The filter translator keys the second reading on the field being
 * `ELEMENT_FIELD` (`$this`), so the element is named here by the same variable
 * under a spelling that is not that string: a parenthesised expression, which
 * SurrealQL treats as the value it wraps.
 */
const PULLED_ELEMENT = `(${ELEMENT_FIELD})`;

/** True for `{$gte: 3}` — an object whose every key is an operator. */
function isOperatorSpec(value: unknown): value is Record<string, unknown> {
	if (!isPlainObject(value)) return false;
	const keys = Object.keys(value);
	return keys.length > 0 && keys.every((k) => k.startsWith("$"));
}

/**
 * Translate one operator object (`{$gte: 3, $lt: 10}`) into conditions on
 * `target`, which is either `$this` (the array element itself) or a path
 * inside it.
 */
function pullOperatorConditions(
	target: string,
	spec: Record<string, unknown>,
	ctx: UpdateContext,
): string[] {
	const conditions: string[] = [];
	for (const [op, operand] of Object.entries(spec)) {
		// The ordering operators are MongoDB's type-bracketed comparison, which is
		// what the filter translator builds for a field: a bare `>` here would match
		// across types, and remove a string for `{$gt: 5}`.
		if (isRangeOperator(op)) {
			conditions.push(
				rangePredicate(
					target === ELEMENT_FIELD ? PULLED_ELEMENT : target,
					op,
					operand,
					ctx,
					// A filtered array path is not a table scan, so there is no
					// planner for the leading range to serve.
					{ leadingRange: false },
				),
			);
			continue;
		}

		const sqlOp = PULL_COMPARISON_OPS[op];
		if (!sqlOp) {
			throw new MongoInvalidArgumentError(
				`Unsupported operator in $pull condition: ${op}`,
			);
		}
		conditions.push(`${target} ${sqlOp} $${ctx.bind(operand)}`);
	}
	return conditions;
}

/**
 * Work out the conditions selecting the elements a `$pull` should remove, or
 * `null` when the value is a plain equality operand.
 *
 * MongoDB has three forms:
 *   - `{$pull: {n: 3}}`            – remove every element equal to 3
 *   - `{$pull: {n: {$gte: 3}}}`    – remove every element matching the predicate
 *   - `{$pull: {o: {s: "x"}}}`     – remove every element (a sub-document)
 *                                    matching the condition document, applied
 *                                    as if each element were a document in a
 *                                    collection, so it is a *partial* match
 *
 * Only the first was implemented: the other two bound the whole condition
 * object as an equality operand, which never matched anything, making `$pull`
 * with a predicate a silent no-op.
 */
function pullConditions(value: unknown, ctx: UpdateContext): string[] | null {
	if (!isPlainObject(value)) return null;

	const keys = Object.keys(value);
	// `{}` is ambiguous — it reads either as "match everything" or as the empty
	// document as a value. Rather than guess, keep the equality behaviour.
	if (keys.length === 0) return null;

	const operators = keys.filter((k) => k.startsWith("$"));
	if (operators.length === keys.length) {
		return pullOperatorConditions(ELEMENT_FIELD, value, ctx);
	}
	if (operators.length > 0) {
		throw new MongoInvalidArgumentError(
			`Cannot mix operators and field names in a $pull condition: ${operators[0]}`,
		);
	}

	const conditions: string[] = [];
	for (const [key, sub] of Object.entries(value)) {
		// The key is a path *within* each element, so it needs escaping like any
		// other caller-supplied field path.
		const target = `${ELEMENT_FIELD}.${escapeFieldPath(key)}`;
		if (isOperatorSpec(sub)) {
			conditions.push(...pullOperatorConditions(target, sub, ctx));
		} else {
			conditions.push(`${target} = $${ctx.bind(sub)}`);
		}
	}
	return conditions;
}

export const pullOperator: UpdateOperator = {
	name: "$pull",
	apply(entries, ctx) {
		for (const [field, value] of entries) {
			const f = ctx.resolveField(field);
			const conditions = pullConditions(value, ctx);

			if (conditions) {
				// Keep the elements that do *not* match. A `[WHERE …]` filter over
				// the array evaluates each element as `$this`, and — verified on
				// SurrealDB 3.2.3 — assigning it back is a no-op when the field is
				// absent, so an absent array is left absent rather than created as
				// `[]`, which is what MongoDB does too.
				ctx.parts.push(`${f} = ${f}[WHERE !(${conditions.join(" AND ")})]`);
				continue;
			}

			const p = ctx.bind(value);
			ctx.parts.push(`${f} -= [$${p}]`);
		}
	},
};

export const pullAllOperator: UpdateOperator = {
	name: "$pullAll",
	apply(entries, ctx) {
		for (const [field, value] of entries) {
			const f = ctx.resolveField(field);
			const p = ctx.bind(value);
			ctx.parts.push(`${f} = array::complement(${f}, $${p})`);
		}
	},
};

/**
 * Unwrap `{$each: [...]}` for `$addToSet`, returning the list of values to add
 * or `null` when the operand is a single value.
 *
 * The `$each` modifier used to be ignored, so the modifier *object* itself was
 * added to the array — `{$addToSet: {t: {$each: ["b","c"]}}}` stored
 * `["a", {"$each": ["b","c"]}]`, corrupting the document.
 */
function addToSetEach(value: unknown): unknown[] | null {
	if (!isPlainObject(value) || !("$each" in value)) return null;

	const each = value.$each;
	if (!Array.isArray(each)) {
		throw new MongoInvalidArgumentError(
			"The argument to $each in $addToSet must be an array",
		);
	}

	const extra = Object.keys(value).filter((k) => k !== "$each");
	if (extra.length > 0) {
		throw new MongoInvalidArgumentError(
			`Unrecognized clause in $addToSet: ${extra[0]}`,
		);
	}

	return each;
}

export const addToSetOperator: UpdateOperator = {
	name: "$addToSet",
	apply(entries, ctx) {
		for (const [field, value] of entries) {
			const f = ctx.resolveField(field);
			const each = addToSetEach(value);
			const p = ctx.bind(each ?? value);
			// With `$each` every element of the list is a candidate; without it the
			// operand is added as a *single* element, so it stays wrapped — that is
			// what makes `$addToSet: {t: [1,2]}` append the array itself.
			const additions = each ? `$${p}` : `[$${p}]`;
			// `?? []` because `array::union` rejects NONE: MongoDB creates the array
			// when the field is absent.
			ctx.parts.push(`${f} = array::union(${f} ?? [], ${additions})`);
		}
	},
};

export const popOperator: UpdateOperator = {
	name: "$pop",
	apply(entries, ctx) {
		for (const [field, value] of entries) {
			const f = ctx.resolveField(field);
			if (value === -1) {
				ctx.parts.push(`${f} = array::slice(${f}, 1)`);
			} else {
				ctx.parts.push(`${f} = array::slice(${f}, 0, array::len(${f}) - 1)`);
			}
		}
	},
};

export const arrayUpdateOperators: UpdateOperator[] = [
	pushOperator,
	pullOperator,
	pullAllOperator,
	addToSetOperator,
	popOperator,
];
