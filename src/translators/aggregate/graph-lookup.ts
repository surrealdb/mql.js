/**
 * `$graphLookup` — recursive traversal, server-side, in one statement.
 *
 * MongoDB walks a collection by repeatedly matching `connectFromField` values
 * from what it has found against `connectToField`, until nothing new turns up or
 * `maxDepth` is reached, and hands each *input* document its own reachable set.
 *
 * That needs two things SurrealQL does not obviously have: accumulation across
 * iterations, and a per-row recursion. `array::reduce` supplies both. Its closure
 * may run a subquery, and the accumulator it threads carries whatever shape the
 * closure returns — so the fold is a breadth-first search and the accumulator is
 * its state:
 *
 *     array::reduce([{d: 0, seen: [], front: <seeds>}, 1, 2, …], |$a, $v| {
 *       LET $next = (SELECT … FROM <table>
 *                     WHERE <connectTo> IN $a.front AND <not already seen>);
 *       RETURN { d: $a.d + 1,
 *                seen: array::concat($a.seen, $next),
 *                front: $next.<connectFrom> };
 *     }).seen
 *
 * Three things had to be measured before this was worth writing, because the
 * obvious reasoning about each was wrong:
 *
 *   - **`FOR` cannot do this.** `FOR $i IN … { LET $acc = … }` scopes its binding
 *     to the block, so the accumulator never survives an iteration. That is what
 *     made this look impossible; `array::reduce` is the thing that makes it
 *     possible.
 *   - **The index survives.** `WHERE mgr IN $f` where `$f` is a runtime variable
 *     plans identically to a literal array — `IndexScan`, not the `TableScan` a
 *     correlated predicate degrades to in `$lookup`. The correlation here is only
 *     in the *seed*, never in the predicate, which is why.
 *   - **Over-capping is harmless.** Running more iterations than the data has
 *     depth re-finds nothing, because the frontier empties and the guard excludes
 *     what is already seen. So an unbounded traversal can be a generous fixed cap
 *     rather than an error.
 *
 * SurrealDB's own recursive traversal — `field.{..}` — is not used, and cannot
 * be: it requires the reference to *be* a record id, and MongoDB references are
 * the plain strings and object ids this driver stores them as.
 */

import { MongoCompatibilityError } from "../../errors.ts";
import { escapeIdentifier } from "../../surreal/sql/escape.ts";
import type { Document } from "../../types.ts";
import { fieldPath } from "./expression.ts";

/**
 * How deep an unbounded traversal is allowed to go.
 *
 * MongoDB's default is "until nothing new is found", which cannot be written as
 * a fold over a fixed-length array. The cap stands in for it, and is documented
 * as a divergence rather than hidden: a hierarchy deeper than this returns the
 * first `MAX_DEPTH` levels rather than an error, which is the one place this
 * stage can answer differently from MongoDB.
 */
const MAX_DEPTH = 64;

/** A validated `$graphLookup` specification. */
export interface GraphLookupSpec {
	readonly from: string;
	readonly startWith: unknown;
	readonly connectFromField: string;
	readonly connectToField: string;
	readonly as: string;
	readonly maxDepth: number | undefined;
	readonly depthField: string | undefined;
	readonly restrictSearchWithMatch: Document | undefined;
}

export function readGraphLookupSpec(spec: unknown): GraphLookupSpec {
	if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
		throw new MongoCompatibilityError(
			"$graphLookup takes a specification document.",
		);
	}

	const document = spec as Document;

	for (const name of ["from", "connectFromField", "connectToField", "as"]) {
		const value = document[name];
		if (typeof value !== "string" || value.length === 0) {
			throw new MongoCompatibilityError(
				`$graphLookup requires a non-empty string \`${name}\`.`,
			);
		}
	}

	if (document.startWith === undefined) {
		throw new MongoCompatibilityError(
			"$graphLookup requires `startWith`, the expression its traversal begins from.",
		);
	}

	const maxDepth = document.maxDepth;
	if (maxDepth !== undefined) {
		if (
			typeof maxDepth !== "number" ||
			!Number.isInteger(maxDepth) ||
			maxDepth < 0
		) {
			throw new MongoCompatibilityError(
				"$graphLookup's maxDepth must be a non-negative whole number.",
			);
		}
		if (maxDepth >= MAX_DEPTH) {
			throw new MongoCompatibilityError(
				`$graphLookup's maxDepth must be below ${MAX_DEPTH}: the traversal is a fold over a fixed number of steps, and this driver does not emit more than that. See the README's aggregation section.`,
			);
		}
	}

	const depthField = document.depthField;
	if (depthField !== undefined && typeof depthField !== "string") {
		throw new MongoCompatibilityError(
			"$graphLookup's depthField must be a string naming the field to record the depth in.",
		);
	}

	return {
		from: document.from as string,
		startWith: document.startWith,
		connectFromField: document.connectFromField as string,
		connectToField: document.connectToField as string,
		as: document.as as string,
		maxDepth: maxDepth as number | undefined,
		depthField: depthField as string | undefined,
		restrictSearchWithMatch: document.restrictSearchWithMatch as
			| Document
			| undefined,
	};
}

/**
 * The traversal expression for one `$graphLookup`.
 *
 * `seeds` is the compiled `startWith`, and `restrict` the compiled
 * `restrictSearchWithMatch` clause or an empty string. Both are produced by the
 * caller, which owns the expression compiler and the filter translator.
 */
export function compileGraphLookup(
	spec: GraphLookupSpec,
	seeds: string,
	restrict: string,
): string {
	const table = escapeIdentifier(spec.from);
	// The traversal reads stored rows, where the identity is `id`; `_id` on the
	// documents it returns is the plain key, exactly as `$lookup` selects it.
	const connectTo = fieldPath(spec.connectToField, false);
	const connectFrom = fieldPath(spec.connectFromField, true);

	const depth = spec.depthField
		? `, $a.d AS ${escapeIdentifier(spec.depthField)}`
		: "";

	// The step count. MongoDB counts the first level as depth 0, so `maxDepth: 0`
	// is one step; an unbounded traversal takes the cap.
	const steps = (spec.maxDepth ?? MAX_DEPTH - 1) + 1;
	const counters = Array.from({ length: steps }, (_, i) => i).join(", ");

	// `array::flatten` because `startWith` and `connectFromField` may each hold an
	// array, and MongoDB follows every element of one. `array::distinct` keeps the
	// frontier from growing with duplicates.
	const frontier = `array::distinct(array::flatten($next.${connectFrom}))`;

	// The cycle guard, and the reason a loop terminates rather than revisiting for
	// the whole cap: a document already found is never matched again.
	const unseen = `record::id(id) NOT IN $a.seen.${escapeIdentifier("_id")}`;

	const where = [`${connectTo} IN $a.front`, unseen, restrict]
		.filter(Boolean)
		.join(" AND ");

	return `array::reduce([{ d: 0, seen: [], front: array::distinct(array::flatten([${seeds}])) }, ${counters}], |$a, $v| { LET $next = (SELECT *, record::id(id) AS ${escapeIdentifier("_id")}${depth} OMIT id FROM ${table} WHERE ${where}); RETURN { d: $a.d + 1, seen: array::concat($a.seen, $next), front: ${frontier} }; }).seen`;
}
