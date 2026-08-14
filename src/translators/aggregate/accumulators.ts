/**
 * `$group` accumulators, compiled to SurrealQL aggregate functions.
 *
 * Each is a function over the rows of a group, which is what SurrealDB's own
 * aggregates are, so the mapping is direct. Two need composing rather than
 * naming: `$first` and `$last` have no aggregate of their own and are the ends
 * of the grouped values, `array::first(array::group(x))`.
 *
 * `$sum: 1` is special-cased to `count()`. It is how MongoDB spells "count the
 * documents in this group", and `math::sum` over a constant would be evaluated
 * per row and summed — the same number, but computed the long way, and only for
 * a literal `1`. Any other constant is summed honestly.
 */

import { MongoCompatibilityError } from "../../errors.ts";
import type { Document } from "../../types.ts";
import { compileExpression } from "./expression.ts";

/** How an accumulator becomes SurrealQL, given its compiled operand. */
type Build = (operand: string) => string;

const ACCUMULATORS: Readonly<Record<string, Build>> = {
	$sum: (value) => `math::sum(${value})`,
	$avg: (value) => `math::mean(${value})`,
	$min: (value) => `math::min(${value})`,
	$max: (value) => `math::max(${value})`,
	// `array::group` keeps duplicates and flattens one level, which is `$push`;
	// `array::distinct` de-duplicates, which is `$addToSet`.
	$push: (value) => `array::group(${value})`,
	$addToSet: (value) => `array::distinct(${value})`,
	$first: (value) => `array::first(array::group(${value}))`,
	$last: (value) => `array::last(array::group(${value}))`,
};

/**
 * Compile one `{field: {$acc: expression}}` entry of a `$group`.
 *
 * Returns the SurrealQL expression the field is aliased to. Throws when the
 * accumulator is not one this driver implements — including the window-function
 * accumulators (`$stdDevPop`, `$accumulator`, `$mergeObjects`, …), which have no
 * counterpart to translate to.
 */
export function compileAccumulator(
	field: string,
	spec: unknown,
	bind: (value: unknown) => string,
	identityIsPlainField = false,
): string {
	if (!isAccumulatorSpec(spec)) {
		throw new MongoCompatibilityError(
			`The $group field ${field} must be an accumulator such as {$sum: …} or {$max: …}; ${describe(spec)} is not one. Only _id may be a plain expression.`,
		);
	}

	const [name] = Object.keys(spec);
	const operand = spec[name];

	// `{$count: {}}` counts documents and takes no operand, so it never reaches
	// the expression compiler.
	if (name === "$count") return "count()";

	// The idiomatic document count. Checked before compiling so the literal `1`
	// is recognised rather than becoming a bound parameter first.
	if (name === "$sum" && operand === 1) return "count()";

	const build = ACCUMULATORS[name];
	if (!build) {
		throw new MongoCompatibilityError(
			`The $group accumulator ${name} is not implemented by @surrealdb/mql. Supported accumulators are $sum, $avg, $min, $max, $push, $addToSet, $first, $last and $count.`,
		);
	}

	return build(compileExpression(operand, bind, identityIsPlainField));
}

function isAccumulatorSpec(spec: unknown): spec is Document {
	return (
		typeof spec === "object" &&
		spec !== null &&
		!Array.isArray(spec) &&
		Object.keys(spec).length === 1 &&
		Object.keys(spec)[0].startsWith("$")
	);
}

function describe(spec: unknown): string {
	if (spec === null) return "null";
	if (Array.isArray(spec)) return "an array";
	if (typeof spec === "object") {
		const keys = Object.keys(spec as Document);
		return keys.length === 1
			? `{${keys[0]}: …}`
			: `an object of ${keys.length} keys`;
	}
	return JSON.stringify(spec);
}
