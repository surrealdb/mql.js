/**
 * `$group` accumulators, compiled to SurrealQL aggregate functions.
 *
 * Most are a function over the rows of a group, which is what SurrealDB's own
 * aggregates are, so the mapping is direct: `math::sum`, `math::mean`,
 * `math::min`, `math::max`, `math::stddev`, `array::distinct`.
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
 * **Collecting** is the other family: `$push`, `$first`, `$last`, `$firstN`,
 * `$lastN`, `$maxN` and `$minN` all begin from "every value this group saw, one
 * per row, duplicates kept", and differ in what they do with that list.
 *
 * The collector is the *bare projected expression*, `SELECT cat AS _id, price
 * AS collected … GROUP BY _id`, and not `array::group(price)`. They were the
 * same thing until SurrealDB 3.4: `array::group` then became "the unique values"
 * — agreeing with its scalar form, which always was — and a group holding
 * apple/banana/apple reports two names. A `$push` built on it silently lost
 * every repeated value, and `$last` answered with the last *distinct* value
 * rather than the last one. The bare projection is the form the server
 * documents for "one element per row, duplicates included", and answers
 * identically on 3.0 through 3.3 — measured on 3.2, and asserted of every
 * minor and `nightly` by the integration suite, which is how the change was
 * found.
 *
 * The one expression a bare projection does *not* collect is one the row cannot
 * influence — a literal, `$$NOW`, a constant arithmetic expression. 3.4 reports
 * those as their single value, where earlier servers reported one per row; so a
 * collector over such an operand is `array::repeat(value, count())`, which says
 * "once per row" the same way on every version.
 *
 * Scalar array functions wrapped around a bare projection run per row rather
 * than over the collected list (`array::last(sub)` is `[null, null]` per group,
 * verified live), so `$first`, `$last` and the N-accumulators cannot be applied
 * in the grouped statement itself. They return a `derive` function, and
 * `applyGroup` puts the collected list in the grouped statement and applies the
 * function in a statement around it.
 *
 * `$firstN`/`$lastN`/`$maxN`/`$minN` take `{input, n}` rather than a bare
 * expression, so they are compiled separately from the table below rather
 * than added to it.
 */

import { MongoCompatibilityError } from "../../errors.ts";
import type { Document } from "../../types.ts";
import { compileExpression } from "./expression.ts";

/**
 * One compiled `$group` accumulator.
 *
 * `sql` is what the grouped statement itself computes. When `derive` is present
 * `sql` is not the answer but the group's values collected into an array, and
 * `derive` turns that array (spelled as the SurrealQL the enclosing statement
 * reads it by) into the answer.
 */
export interface CompiledAccumulator {
	readonly sql: string;
	readonly derive?: (collected: string) => string;
}

/** How an accumulator becomes SurrealQL, given its compiled operand. */
type Build = (operand: string) => string;

const ACCUMULATORS: Readonly<Record<string, Build>> = {
	$sum: (value) => `math::sum(${value})`,
	$avg: (value) => `math::mean(${value})`,
	$min: (value) => `math::min(${value})`,
	$max: (value) => `math::max(${value})`,
	// `array::distinct` de-duplicates a group's values, which is `$addToSet`.
	$addToSet: (value) => `array::distinct(${value})`,
	$stdDevSamp: (value) => `math::stddev(${value})`,
	$stdDevPop: (value) =>
		`math::stddev(${value}) * math::sqrt(<float>(count() - 1) / <float>count())`,
};

/**
 * What each collecting accumulator makes of the collected list. `null` is the
 * list itself, which is `$push`.
 */
const COLLECTORS: Readonly<
	Record<string, ((collected: string) => string) | null>
> = {
	$push: null,
	$first: (collected) => `array::first(${collected})`,
	$last: (collected) => `array::last(${collected})`,
};

/**
 * `$firstN`/`$lastN`/`$maxN`/`$minN`, given the collected list and the
 * validated `n`. `$maxN` sorts descending and `$minN` ascending because that
 * is the order MongoDB documents for each — the largest/smallest value leads
 * either array, not just any two elements from the sorted ends.
 */
const N_COLLECTORS: Readonly<
	Record<string, (collected: string, n: number) => string>
> = {
	$firstN: (collected, n) => `array::slice(${collected}, 0, ${n})`,
	$lastN: (collected, n) => `array::slice(${collected}, -${n})`,
	$maxN: (collected, n) =>
		`array::slice(array::reverse(array::sort(${collected})), 0, ${n})`,
	$minN: (collected, n) => `array::slice(array::sort(${collected}), 0, ${n})`,
};

/**
 * Compile one `{field: {$acc: expression}}` entry of a `$group`.
 *
 * Throws when the accumulator is not one this driver implements — including the
 * window-function-only accumulators (`$accumulator`, `$mergeObjects`, `$top`,
 * `$bottom`, …), which have no counterpart to translate to.
 */
export function compileAccumulator(
	field: string,
	spec: unknown,
	bind: (value: unknown) => string,
	identityIsPlainField = false,
): CompiledAccumulator {
	if (!isAccumulatorSpec(spec)) {
		throw new MongoCompatibilityError(
			`The $group field ${field} must be an accumulator such as {$sum: …} or {$max: …}; ${describe(spec)} is not one. Only _id may be a plain expression.`,
		);
	}

	const [name] = Object.keys(spec);
	const operand = spec[name];

	// `{$count: {}}` counts documents and takes no operand, so it never reaches
	// the expression compiler.
	if (name === "$count") return { sql: "count()" };

	// The idiomatic document count. Checked before compiling so the literal `1`
	// is recognised rather than becoming a bound parameter first.
	if (name === "$sum" && operand === 1) return { sql: "count()" };

	if (name in COLLECTORS) {
		const derive = COLLECTORS[name];
		const sql = collect(operand, bind, identityIsPlainField);
		return derive ? { sql, derive } : { sql };
	}

	if (name in N_COLLECTORS) {
		return compileNAccumulator(name, operand, bind, identityIsPlainField);
	}

	const build = ACCUMULATORS[name];
	if (!build) {
		throw new MongoCompatibilityError(
			`The $group accumulator ${name} is not implemented by @surrealdb/mql. Supported accumulators are $sum, $avg, $min, $max, $push, $addToSet, $first, $last, $firstN, $lastN, $maxN, $minN, $stdDevSamp, $stdDevPop and $count.`,
		);
	}

	return {
		sql: build(compileExpression(operand, bind, identityIsPlainField)),
	};
}

function compileNAccumulator(
	name: string,
	operand: unknown,
	bind: (value: unknown) => string,
	identityIsPlainField: boolean,
): CompiledAccumulator {
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

	return {
		sql: collect(input, bind, identityIsPlainField),
		derive: (collected) => N_COLLECTORS[name](collected, n),
	};
}

/**
 * The group's values, one element per row, duplicates kept — as a projection
 * the grouped statement can carry.
 *
 * See the module comment for why this is a bare projection and not
 * `array::group`, and why an operand that reads no field is the exception.
 */
function collect(
	operand: unknown,
	bind: (value: unknown) => string,
	identityIsPlainField: boolean,
): string {
	const compiled = compileExpression(operand, bind, identityIsPlainField);
	return readsRow(operand) ? compiled : `array::repeat(${compiled}, count())`;
}

/**
 * Whether a MongoDB expression reads the document it is evaluated against.
 *
 * A field path does (`"$price"`, `"$a.b"`); a variable (`"$$this"`, `"$$NOW"`)
 * and a `$literal` do not, and an operator or array reads the row if anything
 * inside it does. This is the question SurrealDB 3.4 asks of a grouped
 * projection to decide whether it has one value per group or one per row, and
 * answering it the same way here is what lets `collect` choose a spelling that
 * means the same on either side of that change.
 */
function readsRow(expression: unknown): boolean {
	if (typeof expression === "string") {
		return expression.startsWith("$") && !expression.startsWith("$$");
	}
	if (Array.isArray(expression)) return expression.some(readsRow);
	if (typeof expression === "object" && expression !== null) {
		const keys = Object.keys(expression);
		if (keys.length === 1 && keys[0] === "$literal") return false;
		return Object.values(expression).some(readsRow);
	}
	return false;
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
