/**
 * Evaluation operators: $regex, $type, $mod.
 *
 * The dialect strategy decides which SurrealQL form `$regex` and `$type`
 * compile to (e.g. `~` vs `string::matches()`).
 */

import { MongoInvalidArgumentError } from "../../../errors.ts";
import type { FilterOperator } from "../operator-registry.ts";
import { fieldOrAnyElement } from "./comparison.ts";

/**
 * MongoDB regex flags that change whether a value matches, in the order they
 * are emitted so the generated SurrealQL is deterministic.
 *
 * SurrealDB 3.x compiles `string::matches()` patterns with the Rust `regex`
 * crate, which takes flags as an inline group at the head of the pattern —
 * `(?i)hello`. Verified live against SurrealDB 3.x: `(?i)`, `(?m)`, `(?s)` and
 * `(?x)` all parse and behave as MongoDB documents them, and they combine
 * (`(?is)`).
 */
const INLINE_REGEX_FLAGS = "imsx";

/**
 * Flags carrying no meaning for a "does this value match?" test, which are
 * therefore accepted and dropped rather than rejected:
 *   - `g` and `y` (JavaScript only) select iteration/stickiness behaviour that
 *     a boolean match never observes;
 *   - `d` only asks for capture-group indices;
 *   - `u` and `v` request Unicode mode, which the Rust engine is always in.
 */
const IGNORED_REGEX_FLAGS = new Set(["d", "g", "u", "v", "y"]);

/**
 * A `$regex` operand paired with the flags of its sibling `$options` key.
 *
 * An operator strategy only ever sees its own value, so the document walker
 * pairs `{$regex: "x", $options: "i"}` into one operand before dispatching.
 */
export interface RegexOperand {
	/** The pattern, either a `RegExp` or a bare pattern string. */
	readonly pattern: string | RegExp;
	/** MongoDB `$options` flag string, when one was supplied. */
	readonly options?: string | undefined;
}

function isRegexOperand(value: unknown): value is RegexOperand {
	return (
		typeof value === "object" &&
		value !== null &&
		!(value instanceof RegExp) &&
		"pattern" in value
	);
}

/**
 * Prefix `pattern` with the inline flag group implied by `flags`.
 *
 * Defect fixed: flags were dropped on the floor, so `{s: /hello/i}` compiled to
 * a case-sensitive match and returned the wrong documents with no error at all.
 * A flag that is neither supported nor semantically irrelevant now raises
 * rather than being ignored, because silently wrong results are worse.
 */
function applyRegexFlags(pattern: string, flags: string): string {
	for (const flag of flags) {
		if (INLINE_REGEX_FLAGS.includes(flag)) continue;
		if (IGNORED_REGEX_FLAGS.has(flag)) continue;
		throw new MongoInvalidArgumentError(`Unsupported $regex flag: ${flag}`);
	}

	const inline = [...INLINE_REGEX_FLAGS]
		.filter((flag) => flags.includes(flag))
		.join("");

	return inline.length > 0 ? `(?${inline})${pattern}` : pattern;
}

/**
 * The divisor and remainder of a `$mod`, whole numbers, in MongoDB's words when
 * they are not right.
 *
 * MongoDB truncates both — `{$mod: [2.5, 1]}` is `{$mod: [2, 1]}` — and refuses a
 * divisor that truncates to zero, which `%` would otherwise raise partway through
 * a query.
 */
function modOperands(value: unknown): [number, number] {
	if (!Array.isArray(value)) {
		throw new MongoInvalidArgumentError("malformed mod, needs to be an array");
	}
	if (value.length < 2) {
		throw new MongoInvalidArgumentError("malformed mod, not enough elements");
	}
	if (value.length > 2) {
		throw new MongoInvalidArgumentError("malformed mod, too many elements");
	}

	const [divisor, remainder] = value;
	if (typeof divisor !== "number") {
		throw new MongoInvalidArgumentError("malformed mod, divisor not a number");
	}
	if (typeof remainder !== "number") {
		throw new MongoInvalidArgumentError(
			"malformed mod, remainder not a number",
		);
	}

	const whole = Math.trunc(divisor);
	if (whole === 0) {
		throw new MongoInvalidArgumentError("divisor cannot be 0");
	}
	return [whole, Math.trunc(remainder)];
}

export const evaluationOperators: FilterOperator[] = [
	{
		name: "$regex",
		translate(field, value, ctx) {
			const operand: RegexOperand = isRegexOperand(value)
				? value
				: { pattern: value as string | RegExp };

			const source =
				operand.pattern instanceof RegExp
					? operand.pattern.source
					: String(operand.pattern);
			// A RegExp shorthand carries its own flags; `$options` adds to them.
			const flags =
				(operand.pattern instanceof RegExp ? operand.pattern.flags : "") +
				(operand.options ?? "");

			const p = ctx.bind(applyRegexFlags(source, flags));

			// `string::matches()` is typed on strings and *errors* when handed a
			// NONE — which every document missing the field produces, aborting the
			// whole query. MongoDB simply does not match a non-string, so guard the
			// call; `AND` short-circuits, so the guard is enough. An array of strings
			// matches when any element does, as `{tags: /^a/}` does in MongoDB.
			const isString = ctx.dialect.typeCheckFn("string") ?? "type::is_string";
			return fieldOrAnyElement(
				field,
				(target) =>
					`${isString}(${target}) AND ${ctx.dialect.regexMatch(target, `$${p}`)}`,
				ctx,
			);
		},
	},
	{
		name: "$type",
		translate(field, value, ctx) {
			const fn = ctx.dialect.typeCheckFn(value as string | number);
			if (!fn)
				throw new MongoInvalidArgumentError(
					`Unsupported $type value: ${value}`,
				);

			// A GeoJSON geometry is stored as SurrealDB's own geometry type, which
			// is not an object to `type::is_object` — but it is a BSON object to
			// MongoDB, and a JSON object to the caller who wrote it and reads it
			// back. Asking for one has to find the other.
			const isType =
				value === "object" || value === 3
					? (target: string) =>
							`(${fn}(${target}) OR ${ctx.dialect.geometryCheck(target)})`
					: (target: string) => `${fn}(${target})`;

			// `$type: "array"` asks whether the field *is* an array, and is the one
			// type that does not look at the elements: for any other type MongoDB
			// matches an array holding a value of it, so `{$type: "string"}` matches
			// `["a"]`. An array inside an array is not searched.
			if (value === "array" || value === 4) return isType(field);
			return fieldOrAnyElement(field, isType, ctx);
		},
	},
	{
		name: "$mod",
		translate(field, value, ctx) {
			const [divisor, remainder] = modOperands(value);
			const pDiv = ctx.bind(divisor);
			const pRem = ctx.bind(remainder);
			const isNumber = ctx.dialect.typeCheckFn("number") ?? "type::is_number";

			// MongoDB takes the value as a whole number: `5.7` is `5` and `-3.7` is
			// `-3`, the remainder keeps the dividend's sign (`-3 % 2` is `-1`), and a
			// value that is not a number matches nothing. `%` is typed on numbers and
			// *errors* on a string, so the guard is what keeps one stray value from
			// aborting the whole query. An array matches when any element does.
			return fieldOrAnyElement(
				field,
				(target) =>
					`${isNumber}(${target}) AND (IF ${target} >= 0 THEN math::floor(${target}) ELSE math::ceil(${target}) END) % $${pDiv} = $${pRem}`,
				ctx,
			);
		},
	},
];
