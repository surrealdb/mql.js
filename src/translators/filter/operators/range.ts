/**
 * Range operators: $gt, $gte, $lt, $lte.
 *
 * ## Why this is not `field > $param`
 *
 * SurrealQL orders every value in one total order — NONE < NULL < bool < number
 * < string < datetime < … < array < object — and a bare `>` or `<` compares
 * across it. `{age: {$lt: 30}}` as `age < $p` therefore matched every document
 * whose `age` was missing, null or a boolean, and `{age: {$gt: 30}}` matched
 * every string, date, array and object. MongoDB does not rank values of
 * different types against each other at all: a range comparison is *bracketed*,
 * matching only values of the same BSON type as its operand — numbers with
 * numbers, strings with strings, dates with dates — and never a missing field.
 *
 * So each comparison is guarded by a type predicate chosen from the operand's
 * JavaScript type, and what is emitted for `{f: {$gt: 5}}` is
 *
 *     f > $p0 AND ((is_number(f) AND … AND f > $p0)
 *                  OR (is_array(f) AND array::any(f, |$e| is_number($e) AND … AND $e > $p0)))
 *
 * ## Arrays
 *
 * Like every MongoDB field comparison, a range operator matches an array field
 * when *any element* satisfies it — `{v: {$gt: 5}}` matches `v: [7, 8]` and not
 * `v: [1, 2]` — so there is an element arm beside the scalar arm, the same two
 * arms `$eq` has. The old `field > $p` only ever "matched arrays" because an
 * array sorts above a number, which also matched `[1, 2]`. The element arm is
 * not recursive, as in MongoDB: `[[7, 8]]` has no element that is a number.
 *
 * It is `array::any` with a closure over the field's value, and not a filtered
 * projection (`f[WHERE …]`) as `$elemMatch` uses, because the projection binds
 * to the wrong level when the path crosses an array of sub-documents: for
 * `{"items.price": {$gt: 5}}` the field is `items.price`, which evaluates to the
 * list of prices, and `items.price[WHERE …]` filters per item instead of over
 * that list — true for any document with an item at all. Evaluating the path
 * first is what keeps `items.price` working, and is how `$eq` (`CONTAINS`) and
 * the geospatial operators (`array::any`) already treat it.
 *
 * Inside `$elemMatch`, a condition with no field name is about the element
 * itself (`ELEMENT_FIELD`), and MongoDB does not descend into it, so there is
 * no element arm there.
 *
 * ## The redundant leading range
 *
 * The first conjunct looks redundant, and logically it is: it holds for
 * everything the rest of the predicate selects. It exists because a predicate
 * that is only an `OR` of guarded arms leaves the query planner no range to
 * scan, and the plain `f > $p` this replaces could use an index. SurrealQL ranks
 * arrays above every bracket that can reach this point, so `$gt`/`$gte` can
 * lead with the operator itself; `$lt`/`$lte` cannot, since the arrays an
 * element arm selects are above their operand, so they lead with a union of the
 * two ranges the predicate can match in — below the operand, or an array, `>= []`
 * being the lowest one. Either way only the *superset* is for the planner: the
 * guarded arms still decide every row. An ObjectId has no such leading range,
 * as it is stored as an object, which sorts above arrays; its range queries scan.
 *
 * ## What it refuses
 *
 * An array or embedded-document operand is refused rather than approximated.
 * MongoDB orders arrays element by element and embedded documents field by field
 * in the order they were written, each element or field compared in *its* BSON
 * type order, which differs from SurrealQL's (MongoDB ranks objects below
 * arrays and booleans above them, SurrealQL does the reverse) — and a SurrealDB
 * object has no field order to begin with. No predicate reproduces that, so the
 * result would be right for some data and silently wrong for the rest.
 *
 * `null` is not refused, since MongoDB's answer is simple and exact: `$gt` and
 * `$lt` match nothing, and `$gte` and `$lte` mean equality — a null or missing
 * field. `undefined` is `null`, which is what the official driver serialises it
 * as. `NaN` follows the same shape: it orders against nothing, so `$gt`/`$lt`
 * match nothing and `$gte`/`$lte` match another NaN; and a *stored* NaN, which
 * SurrealQL ranks above infinity, is kept out of every other number's range.
 *
 * The identity column is the exception to all of it: `id` holds exactly one
 * RecordId, never an array and never missing, so it keeps the bare comparison.
 * Only `id` is: `_id` reaches an operator unrewritten *because* the identity is
 * not the record id there — the translator rewrites it to `id` whenever it knows
 * the collection, and is not told once a stage such as `$group` has reshaped the
 * documents — so a `$match` on a grouped `_id` is a comparison against whatever
 * the group key was, and a mixed-type key needs the same bracketing as any field.
 */

import { MongoCompatibilityError } from "../../../errors.ts";
import { isObjectId } from "../../../object-id.ts";
import { OBJECT_ID_TAG } from "../../../surreal/bson-codec.ts";
import { escapeIdentifier } from "../../../surreal/sql/escape.ts";
import { SURREAL_ID_FIELD } from "../id-field.ts";
import type { FilterOperator } from "../operator-registry.ts";
import {
	arrayTypeCheckFn,
	ELEMENT_FIELD,
	equalityPredicate,
	nullEqualityPredicate,
	type PredicateContext,
} from "./comparison.ts";

export type RangeOperator = "$gt" | "$gte" | "$lt" | "$lte";

/** True for the four ordering operators this module translates. */
export function isRangeOperator(name: string): name is RangeOperator {
	return Object.hasOwn(SQL_OPERATORS, name);
}

/**
 * The closure parameter each array element is tested under: the convention, and
 * the reason for the name, of `geospatial.ts`.
 */
const ELEMENT = "$__mql_element";

const SQL_OPERATORS: Readonly<Record<RangeOperator, string>> = {
	$gt: ">",
	$gte: ">=",
	$lt: "<",
	$lte: "<=",
};

/** The `type::is_*` spellings, for a dialect with no entry of its own. */
const FALLBACK_TYPE_CHECKS = {
	number: "type::is_number",
	string: "type::is_string",
	bool: "type::is_bool",
	date: "type::is_datetime",
	object: "type::is_object",
} as const;

type CheckedType = keyof typeof FALLBACK_TYPE_CHECKS;

function typeCheckFn(type: CheckedType, ctx: PredicateContext): string {
	return ctx.dialect.typeCheckFn(type) ?? FALLBACK_TYPE_CHECKS[type];
}

/**
 * One BSON type bracket: the values a range operand can be compared with.
 */
interface Bracket {
	/**
	 * SurrealQL predicate: `expr` is a value of this bracket that can take part
	 * in a comparison. `above` is whether the comparison that follows it is
	 * `>`/`>=` rather than `<`/`<=`.
	 */
	holds(expr: string, above: boolean): string;
	/** Whether SurrealQL ranks every array above every value of this bracket. */
	readonly belowArrays: boolean;
}

function typeBracket(type: CheckedType, ctx: PredicateContext): Bracket {
	const check = typeCheckFn(type, ctx);
	return { holds: (expr) => `${check}(${expr})`, belowArrays: true };
}

/**
 * Every number except NaN.
 *
 * A NaN is a number to `type::is_number`, but MongoDB orders it against nothing
 * — `{v: {$gt: 5}}` and `{v: {$lt: 5}}` both skip it — while SurrealQL ranks it
 * above infinity. Bounding the comparison by an infinity on the side it cannot
 * be on removes it, and does not depend on where a SurrealDB version ranks NaN:
 * if it ranked below everything, the comparison against the operand would
 * already reject it for `$gt`, and the bound would for `$lt`.
 */
function numberBracket(ctx: PredicateContext): Bracket {
	const check = typeCheckFn("number", ctx);
	return {
		holds: (expr, above) =>
			`${check}(${expr}) AND ${expr} ${above ? "<= math::inf" : ">= math::neg_inf"}`,
		belowArrays: true,
	};
}

/**
 * An ObjectId, which is stored as the one-field object `{"$oid": "<hex>"}` (see
 * `bson-codec.ts`). Comparing two of those compares their hex, which orders the
 * way the twelve bytes do. The check is the codec's own recognition rule, minus
 * the hex pattern: exactly one field, named for the tag, holding a string.
 */
function objectIdBracket(ctx: PredicateContext): Bracket {
	const isObject = typeCheckFn("object", ctx);
	const isString = typeCheckFn("string", ctx);
	const tag = escapeIdentifier(OBJECT_ID_TAG);
	return {
		holds: (expr) =>
			`${isObject}(${expr}) AND object::len(${expr}) = 1 AND ${isString}(${expr}.${tag})`,
		belowArrays: false,
	};
}

/** The bracket `value` belongs to, or a refusal for one that has no exact one. */
function bracketFor(
	operator: RangeOperator,
	value: unknown,
	ctx: PredicateContext,
): Bracket {
	if (typeof value === "number" || typeof value === "bigint") {
		return numberBracket(ctx);
	}
	if (typeof value === "string") return typeBracket("string", ctx);
	if (typeof value === "boolean") return typeBracket("bool", ctx);
	if (value instanceof Date) return typeBracket("date", ctx);
	if (isObjectId(value)) return objectIdBracket(ctx);

	throw refusal(operator, value);
}

function refusal(operator: RangeOperator, value: unknown): Error {
	if (Array.isArray(value)) {
		return new MongoCompatibilityError(
			`${operator} with an array operand is not supported: MongoDB orders arrays element by element, each in its own BSON type order, and SurrealDB ranks booleans, dates, arrays and objects differently, so some comparisons would silently give another answer. To match on elements use $elemMatch, and to match a whole array use $eq.`,
		);
	}

	if (isPlainObject(value)) {
		return new MongoCompatibilityError(
			`${operator} with an embedded document operand is not supported: MongoDB compares embedded documents field by field in the order the fields were written, and a SurrealDB object has no field order, so the comparison would silently give another answer. Compare the individual fields instead, for example { "a.b": { ${operator}: 1 } }.`,
		);
	}

	return new MongoCompatibilityError(
		`${operator} does not support ${describe(value)} as an operand: SurrealDB has no ordering for it that matches MongoDB's.`,
	);
}

function isPlainObject(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function describe(value: unknown): string {
	if (value instanceof RegExp) return "a regular expression";
	const bsontype = (value as { _bsontype?: unknown } | null)?._bsontype;
	if (typeof bsontype === "string") return `a BSON ${bsontype}`;
	if (typeof value === "object" && value !== null) {
		return `a ${value.constructor?.name ?? "non-plain object"}`;
	}
	return `a value of type ${typeof value}`;
}

/**
 * The leading range described at the top of the file: a superset of what the
 * predicate selects, in a form the planner can scan.
 */
function leadingRange(
	field: string,
	sqlOp: string,
	param: string,
	above: boolean,
): string {
	const own = `${field} ${sqlOp} $${param}`;
	return above ? own : `(${own} OR ${field} >= [])`;
}

/** What `rangePredicate` can be asked to leave out. */
export interface RangePredicateOptions {
	/**
	 * Whether to lead with the range the query planner can scan (see "The
	 * redundant leading range"). On by default; a caller whose predicate is not
	 * a `WHERE` over a table, such as the condition of a filtered array path, has
	 * no planner to serve and leaves it out.
	 */
	readonly leadingRange?: boolean;
}

/**
 * The predicate for an operand that orders against nothing, or `undefined` when
 * `value` is an ordinary operand.
 *
 * Nothing is greater or less than null, and NaN orders against nothing; the
 * inclusive operators are equality, which each of them does have.
 */
function unorderedOperand(
	field: string,
	operator: RangeOperator,
	value: unknown,
	ctx: PredicateContext,
): string | undefined {
	const inclusive = operator === "$gte" || operator === "$lte";

	if (value === null || value === undefined) {
		return inclusive ? nullEqualityPredicate(field, ctx) : "false";
	}

	if (typeof value === "number" && Number.isNaN(value)) {
		if (!inclusive) return "false";
		if (field === ELEMENT_FIELD) return `${field} = $${ctx.bind(value)}`;
		return equalityPredicate(field, value, ctx);
	}

	return undefined;
}

/**
 * The predicate for `field <operator> value`, in MongoDB's terms: see the top of
 * the file. Exported for the update translator, whose `$pull` and `arrayFilters`
 * conditions are this same comparison applied to an element of an array.
 */
export function rangePredicate(
	field: string,
	operator: RangeOperator,
	value: unknown,
	ctx: PredicateContext,
	options: RangePredicateOptions = {},
): string {
	const sqlOp = SQL_OPERATORS[operator];

	if (field === SURREAL_ID_FIELD) {
		const p = ctx.bind(value);
		return `${field} ${sqlOp} $${p}`;
	}

	const unordered = unorderedOperand(field, operator, value, ctx);
	if (unordered !== undefined) return unordered;

	const above = operator === "$gt" || operator === "$gte";
	const bracket = bracketFor(operator, value, ctx);
	const p = ctx.bind(value);

	const compare = (expr: string) =>
		`${bracket.holds(expr, above)} AND ${expr} ${sqlOp} $${p}`;

	// An element of an array is itself the value: it has no elements to look at.
	if (field === ELEMENT_FIELD) return compare(field);

	const scalar = `(${compare(field)})`;
	const elements = `(${arrayTypeCheckFn(ctx)}(${field}) AND array::any(${field}, |${ELEMENT}| (${compare(ELEMENT)})))`;
	const exact = `(${scalar} OR ${elements})`;

	if (!bracket.belowArrays || options.leadingRange === false) return exact;
	return `(${leadingRange(field, sqlOp, p, above)} AND ${exact})`;
}

function makeRange(operator: RangeOperator): FilterOperator {
	return {
		name: operator,
		translate(field, value, ctx) {
			return rangePredicate(field, operator, value, ctx);
		},
	};
}

export const rangeOperators: FilterOperator[] = [
	makeRange("$gt"),
	makeRange("$gte"),
	makeRange("$lt"),
	makeRange("$lte"),
];
