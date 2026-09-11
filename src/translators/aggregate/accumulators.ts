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
 *
 * `$stdDevPop` has no SurrealDB counterpart — `math::stddev`/`math::variance`
 * are both the sample statistic (verified live: they agree with the n-1
 * formula, not n) — so it is derived from the sample one by the standard
 * scaling factor, `sqrt((n-1)/n)`. `count()` is always at least 1 inside a
 * non-empty group, so `(count() - 1) / count()` never divides by zero; the
 * `<float>` casts matter because SurrealQL's `/` on two integers truncates
 * (verified live: `7 / 8` is `0`, not `0.875`, and silently makes every
 * `$stdDevPop` come out `0`).
 *
 * `$firstN`/`$lastN`/`$maxN`/`$minN` take `{input, n}` rather than a bare
 * expression, so they are compiled separately from the table below rather
 * than added to it.
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
	$stdDevSamp: (value) => `math::stddev(${value})`,
	$stdDevPop: (value) =>
		`math::stddev(${value}) * math::sqrt(<float>(count() - 1) / <float>count())`,
};

/**
 * `$firstN`/`$lastN`/`$maxN`/`$minN`, given the compiled `input` and the
 * validated `n`. `$maxN` sorts descending and `$minN` ascending because that
 * is the order MongoDB documents for each — the largest/smallest value leads
 * either array, not just any two elements from the sorted ends.
 */
const N_ACCUMULATORS: Readonly<
	Record<string, (value: string, n: number) => string>
> = {
	$firstN: (value, n) => `array::slice(array::group(${value}), 0, ${n})`,
	$lastN: (value, n) => `array::slice(array::group(${value}), -${n})`,
	$maxN: (value, n) =>
		`array::slice(array::reverse(array::sort(array::group(${value}))), 0, ${n})`,
	$minN: (value, n) =>
		`array::slice(array::sort(array::group(${value})), 0, ${n})`,
};

/**
 * Compile one `{field: {$acc: expression}}` entry of a `$group`.
 *
 * Returns the SurrealQL expression the field is aliased to. Throws when the
 * accumulator is not one this driver implements — including the
 * window-function-only accumulators (`$accumulator`, `$mergeObjects`, `$top`,
 * `$bottom`, …), which have no counterpart to translate to.
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

	if (name in N_ACCUMULATORS) {
		return compileNAccumulator(name, operand, bind, identityIsPlainField);
	}

	const build = ACCUMULATORS[name];
	if (!build) {
		throw new MongoCompatibilityError(
			`The $group accumulator ${name} is not implemented by @surrealdb/mql. Supported accumulators are $sum, $avg, $min, $max, $push, $addToSet, $first, $last, $firstN, $lastN, $maxN, $minN, $stdDevSamp, $stdDevPop and $count.`,
		);
	}

	return build(compileExpression(operand, bind, identityIsPlainField));
}

function compileNAccumulator(
	name: string,
	operand: unknown,
	bind: (value: unknown) => string,
	identityIsPlainField: boolean,
): string {
	if (
		typeof operand !== "object" ||
		operand === null ||
		Array.isArray(operand) ||
		!("input" in operand) ||
		!("n" in operand)
	) {
		throw new MongoCompatibilityError(
			`The $group accumulator ${name} takes a document of {input, n}; ${describe(operand)} is not one.`,
		);
	}

	const { input, n } = operand as { input: unknown; n: unknown };
	if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
		throw new MongoCompatibilityError(
			`${name}'s n must be a positive whole number, and was given ${JSON.stringify(n)}.`,
		);
	}

	return N_ACCUMULATORS[name](
		compileExpression(input, bind, identityIsPlainField),
		n,
	);
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
