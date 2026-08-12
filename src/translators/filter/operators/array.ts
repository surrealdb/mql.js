/**
 * Array operators: $all, $size, $elemMatch.
 */

import { escapeFieldPath } from "../../../surreal/sql/escape.ts";
import type { Document } from "../../../types.ts";
import type { FilterOperator } from "../operator-registry.ts";
import type { TranslateContext } from "../translate-context.ts";
import { arrayTypeCheckFn, equalityPredicate } from "./comparison.ts";

function isOperatorObject(value: unknown): boolean {
	if (value === null || value === undefined || typeof value !== "object") {
		return false;
	}
	if (Array.isArray(value)) return false;
	if (value instanceof RegExp) return false;
	if (value instanceof Date) return false;
	const keys = Object.keys(value as Record<string, unknown>);
	return keys.length > 0 && keys.every((k) => k.startsWith("$"));
}

/**
 * `$elemMatch` matches a document when at least one element of `field`
 * satisfies *every* condition. SurrealQL expresses that as a filtered
 * projection whose length is non-zero: `array::len(field[WHERE …]) > 0`.
 *
 * Defect fixed: a condition made only of field/value pairs took a whole-object
 * equality shortcut (`field CONTAINS $p`), so `{items: {$elemMatch: {x: 1}}}`
 * matched only an element that was *exactly* `{x: 1}` and missed
 * `{x: 1, y: 2}` — the ordinary case. MongoDB's condition is a partial match
 * (extra fields on the element are irrelevant), so every branch now compiles to
 * a predicate evaluated per element.
 *
 * The `type::is_array` guard is required, not cosmetic: verified live on
 * SurrealDB 3.x, projecting out of a NONE (absent field) yields a one-element
 * result rather than an empty one, so an unguarded
 * `array::len(missing[WHERE …]) > 0` matches every document whose condition is
 * vacuously true for NONE (e.g. `{$elemMatch: {x: null}}`).
 */
function translateElemMatch(
	field: string,
	conditions: Document,
	ctx: TranslateContext,
): string {
	const guard = `${arrayTypeCheckFn(ctx)}(${field})`;

	// Operator keys with no field name apply to the element itself, addressed as
	// `$this`. They are collected and translated together so a `$regex` can see
	// its sibling `$options`.
	const elementOps: Document = {};
	const parts: string[] = [];

	// Every condition below describes one *element*, so a `$near` inside it would
	// have no whole-document distance to order by — see `withoutNearOrder`.
	ctx.withoutNearOrder(() => {
		collectConditions(conditions, elementOps, parts, ctx);
	});

	if (Object.keys(elementOps).length > 0) {
		parts.unshift(
			ctx.withoutNearOrder(() => ctx.translateOperators("$this", elementOps)),
		);
	}

	// `$elemMatch: {}` constrains nothing beyond the field being a non-empty
	// array. `array::len()` is typed on arrays and errors on a NONE, which the
	// guard's short-circuit prevents.
	if (parts.length === 0) return `(${guard} AND array::len(${field}) > 0)`;

	return `(${guard} AND array::len(${field}[WHERE ${parts.join(" AND ")}]) > 0)`;
}

/** Split an `$elemMatch` operand into per-element predicates and element ops. */
function collectConditions(
	conditions: Document,
	elementOps: Document,
	parts: string[],
	ctx: TranslateContext,
): void {
	for (const [key, value] of Object.entries(conditions)) {
		if (key.startsWith("$")) {
			elementOps[key] = value;
			continue;
		}

		const path = escapeFieldPath(key);
		if (isOperatorObject(value)) {
			parts.push(ctx.translateOperators(path, value as Document));
		} else if (value instanceof RegExp) {
			parts.push(ctx.translateOperators(path, { $regex: value }));
		} else {
			// Sub-field equality is MongoDB equality, so an element whose `t` is
			// an array still matches `{$elemMatch: {t: "a"}}`.
			parts.push(equalityPredicate(path, value, ctx));
		}
	}
}

export const arrayOperators: FilterOperator[] = [
	{
		name: "$all",
		translate(field, value, ctx) {
			const p = ctx.bind(value);
			return `${field} CONTAINSALL $${p}`;
		},
	},
	{
		name: "$size",
		translate(field, value, ctx) {
			const p = ctx.bind(value);
			return `array::len(${field}) = $${p}`;
		},
	},
	{
		name: "$elemMatch",
		translate(field, value, ctx) {
			return translateElemMatch(field, value as Document, ctx);
		},
	},
];
