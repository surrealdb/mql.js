/**
 * MongoDB aggregation expressions, compiled to SurrealQL.
 *
 * An expression is what `$project` assigns and what an accumulator accumulates.
 * MongoDB has four kinds and they are told apart by shape alone, which is why
 * this is a compiler rather than a lookup:
 *
 *   - `"$field"` — a **field path**, becoming an idiom. `"$a.b"` is `` `a`.`b` ``.
 *   - `"$$NOW"` — a **system variable**. Only the ones with an exact SurrealQL
 *     counterpart are served; `$$ROOT` and `$$CURRENT` are not, because the
 *     places that would consume a whole-document value here cannot take one.
 *   - `{$op: …}` — an **operator**, dispatched through the registry below.
 *   - anything else — a **literal**, bound as a parameter rather than
 *     interpolated. `{$literal: "$notAField"}` forces this reading for a string
 *     that would otherwise be a field path.
 *
 * Operators that are not implemented raise `MongoCompatibilityError` naming the
 * operator. That is the whole point of compiling rather than approximating: a
 * pipeline that silently dropped `$dateToString` would still return documents,
 * and the caller would get plausible wrong values instead of an error. The same
 * reasoning the aggregation refusal itself rests on.
 */

import { MongoCompatibilityError } from "../../errors.ts";
import { escapeFieldPath } from "../../surreal/sql/escape.ts";
import type { Document } from "../../types.ts";
import { isIdField, SURREAL_ID_FIELD } from "../filter/id-field.ts";

/** What an expression needs in order to bind values and recurse. */
export interface ExpressionContext {
	/** Bind a value and return its `$name` reference. */
	bind(value: unknown): string;
	/** Compile a nested expression. */
	compile(expression: unknown): string;
	/** True once a stage has reshaped the documents, making `_id` an ordinary field. */
	readonly identityIsPlainField: boolean;
	/**
	 * The variables in scope, from the name the caller bound to the SurrealQL
	 * parameter it became.
	 *
	 * `$map` and `$filter` name a variable for the current element — `as: "item"`,
	 * read back as `$$item` — which is the only way an expression reaches it. The
	 * parameter is generated rather than reusing the caller's name, so a variable
	 * called `parent` or `a` cannot shadow something this driver relies on.
	 *
	 * The value is the SurrealQL the name compiles to: a closure parameter for
	 * `$map` and `$filter`, and the variable's own compiled expression for `$let`.
	 */
	readonly variables: ReadonlyMap<string, string>;
	/**
	 * Compile a closure body with `name` bound to a fresh SurrealQL parameter.
	 *
	 * `body` is handed the parameter to write into the closure header, and a
	 * `compile` that knows about the binding — so the body sees the new variable
	 * and everything outside it does not.
	 */
	withVariable(
		name: string,
		body: (
			parameter: string,
			compile: (expression: unknown) => string,
		) => string,
	): string;
	/**
	 * Compile `body` with every entry of `bindings` in scope.
	 *
	 * For `$let`, whose variables are expressions rather than closure parameters.
	 */
	withVariables(
		bindings: ReadonlyMap<string, string>,
		body: (compile: (expression: unknown) => string) => string,
	): string;
	/**
	 * Compile a closure header binding several fresh parameters at once.
	 *
	 * `withVariable` only ever introduces one, but `$reduce`'s
	 * `array::reduce(…, |$value, $this| …)` needs both `$$value` and `$$this`
	 * in the same header — two separate `withVariable` calls would produce two
	 * nested closures instead of one two-parameter one.
	 */
	withClosureVariables(
		names: readonly string[],
		body: (
			parameters: readonly string[],
			compile: (expression: unknown) => string,
		) => string,
	): string;
}

/** One aggregation expression operator. */
export interface ExpressionOperator {
	/** Operator name including the `$`, e.g. `$add`. */
	readonly name: string;
	/** Compile `{[name]: operand}` to a SurrealQL expression. */
	compile(operand: unknown, ctx: ExpressionContext): string;
}

/**
 * A field path, as an idiom.
 *
 * `_id` maps onto SurrealDB's `id` exactly as it does in a filter or a sort,
 * because over stored rows it is the same column. It stops being the same column
 * once a `$group` or `$project` has run: those rows carry a literal `_id` and no
 * `id`, so `identityIsPlainField` turns the rewrite off for every stage after
 * one.
 */
export function fieldPath(path: string, identityIsPlainField = false): string {
	if (isIdField(path) && !identityIsPlainField) return SURREAL_ID_FIELD;
	return escapeFieldPath(path);
}

/** The operand of an n-ary operator, which MongoDB writes as an array. */
function operands(operand: unknown, ctx: ExpressionContext): string[] {
	// MongoDB accepts a bare operand where an array of one is meant, for the
	// operators that take a single argument — `{$toUpper: "$name"}`.
	const list = Array.isArray(operand) ? operand : [operand];
	return list.map((each) => ctx.compile(each));
}

/** An operator taking exactly `arity` operands, rejected loudly otherwise. */
function fixedArity(
	name: string,
	arity: number,
	build: (args: string[]) => string,
): ExpressionOperator {
	return {
		name,
		compile(operand, ctx) {
			const args = operands(operand, ctx);
			if (args.length !== arity) {
				throw new MongoCompatibilityError(
					`${name} takes exactly ${arity} argument${arity === 1 ? "" : "s"}, and was given ${args.length}.`,
				);
			}
			return build(args);
		},
	};
}

/** An operator folding two or more operands with an infix SurrealQL operator. */
function variadicInfix(name: string, infix: string): ExpressionOperator {
	return {
		name,
		compile(operand, ctx) {
			const args = operands(operand, ctx);
			if (args.length === 0) {
				throw new MongoCompatibilityError(
					`${name} takes at least one argument.`,
				);
			}
			return `(${args.join(` ${infix} `)})`;
		},
	};
}

/** An operator that is one SurrealQL function call over its operands. */
function call(name: string, fn: string, arity?: number): ExpressionOperator {
	return {
		name,
		compile(operand, ctx) {
			const args = operands(operand, ctx);
			if (arity !== undefined && args.length !== arity) {
				throw new MongoCompatibilityError(
					`${name} takes exactly ${arity} argument${arity === 1 ? "" : "s"}, and was given ${args.length}.`,
				);
			}
			return `${fn}(${args.join(", ")})`;
		},
	};
}

/** `$convert`'s `to` → the cast this driver already uses for the same type elsewhere. */
const CONVERT_TARGETS: Readonly<Record<string, string>> = {
	string: "<string>",
	bool: "<bool>",
	int: "<int>",
	double: "<float>",
};

/** Fixed-length unit → SurrealQL duration suffix, for `$dateAdd`. */
const DATE_ADD_UNITS: Readonly<Record<string, string>> = {
	millisecond: "ms",
	second: "s",
	minute: "m",
	hour: "h",
	day: "d",
	week: "w",
};

/** Fixed-length unit → SurrealQL duration suffix, for `$dateTrunc`'s bin size. */
const DATE_TRUNC_UNITS: Readonly<Record<string, string>> = {
	millisecond: "ms",
	second: "s",
	minute: "m",
	hour: "h",
	day: "d",
};

/** Fixed-length unit → `duration::` extraction function, for `$dateDiff`. */
const DATE_DIFF_UNITS: Readonly<Record<string, string>> = {
	millisecond: "millis",
	second: "secs",
	minute: "mins",
	hour: "hours",
	day: "days",
};

/**
 * `a` minus `b`, treated as sets. `array::complement` alone does not
 * de-duplicate its result — verified live: complementing `[1,1,2,5]` against
 * `[2,3]` keeps both 1s — so it is wrapped in `array::distinct`.
 */
function setDifference(a: string, b: string): string {
	return `array::distinct(array::complement(${a}, ${b}))`;
}

const CALENDAR_UNITS_NOTE =
	"month, quarter and year have no fixed duration to translate to SurrealQL, since their length in days varies";
const CALENDAR_UNITS_NOTE_WITH_WEEK = `week, ${CALENDAR_UNITS_NOTE}. A week additionally needs startOfWeek to say where its boundary falls, which this driver has no equivalent for`;

/** Validate a `$dateAdd`/`$dateDiff`/`$dateTrunc` `unit`, naming what is refused and why. */
function dateUnit(
	name: string,
	unit: unknown,
	allowed: Readonly<Record<string, string>>,
	refusedNote: string,
): string {
	if (typeof unit !== "string" || !(unit in allowed)) {
		throw new MongoCompatibilityError(
			`${name}'s \`unit\` must be one of ${Object.keys(allowed).join(", ")}: ${refusedNote}. Given: ${JSON.stringify(unit)}.`,
		);
	}
	return allowed[unit];
}

const OPERATORS: readonly ExpressionOperator[] = [
	// -- Literal ------------------------------------------------------------
	{
		name: "$literal",
		// The one operator that does not compile its operand: `$literal` exists
		// precisely to stop `"$x"` being read as a field path.
		compile: (operand, ctx) => ctx.bind(operand),
	},

	// -- Arithmetic ---------------------------------------------------------
	variadicInfix("$add", "+"),
	variadicInfix("$multiply", "*"),
	fixedArity("$subtract", 2, ([a, b]) => `(${a} - ${b})`),
	// The left operand is cast because SurrealQL's `/` on two integers is integer
	// division — `7 / 2` is `3` — while MongoDB's `$divide` always produces a
	// double. Caught by the e2e parity suite rather than by reading: `3` is a
	// number, not an error, so nothing else would have noticed. Casting one side
	// is enough to make the whole expression floating point.
	fixedArity("$divide", 2, ([a, b]) => `(<float>(${a}) / ${b})`),
	fixedArity("$mod", 2, ([a, b]) => `(${a} % ${b})`),
	call("$abs", "math::abs", 1),
	call("$ceil", "math::ceil", 1),
	call("$floor", "math::floor", 1),
	call("$sqrt", "math::sqrt", 1),
	call("$pow", "math::pow", 2),
	{
		name: "$round",
		// MongoDB's second argument is a decimal place count; SurrealDB's
		// `math::round` takes none, so only the one-argument form is served rather
		// than rounding to the wrong precision silently.
		compile(operand, ctx) {
			const args = operands(operand, ctx);
			if (args.length === 1) return `math::round(${args[0]})`;
			throw new MongoCompatibilityError(
				"$round with a decimal-place argument is not supported: SurrealDB's math::round takes no precision, so the result would be rounded to a different place than asked for. Use the single-argument form.",
			);
		},
	},

	// -- String -------------------------------------------------------------
	call("$concat", "string::concat"),
	call("$toUpper", "string::uppercase", 1),
	call("$toLower", "string::lowercase", 1),
	call("$strLenCP", "string::len", 1),
	call("$split", "string::split", 2),
	call("$trim", "string::trim", 1),
	{
		name: "$replaceAll",
		// `{$replaceAll: {input, find, replacement}}`. `string::replace` already
		// replaces every occurrence rather than the first (verified live), which
		// is `$replaceAll`'s own contract — there is no `$replaceOne` here,
		// because that one needs a first-match-only replace this maps to nothing.
		compile(operand, ctx) {
			if (
				typeof operand !== "object" ||
				operand === null ||
				Array.isArray(operand)
			) {
				throw new MongoCompatibilityError(
					"$replaceAll takes a document with `input`, `find` and `replacement`.",
				);
			}
			const { input, find, replacement } = operand as Document;
			if (
				input === undefined ||
				find === undefined ||
				replacement === undefined
			) {
				throw new MongoCompatibilityError(
					"$replaceAll requires `input`, `find` and `replacement`.",
				);
			}
			return `string::replace(${ctx.compile(input)}, ${ctx.compile(find)}, ${ctx.compile(replacement)})`;
		},
	},

	// -- Comparison ---------------------------------------------------------
	fixedArity("$eq", 2, ([a, b]) => `(${a} = ${b})`),
	fixedArity("$ne", 2, ([a, b]) => `(${a} != ${b})`),
	fixedArity("$gt", 2, ([a, b]) => `(${a} > ${b})`),
	fixedArity("$gte", 2, ([a, b]) => `(${a} >= ${b})`),
	fixedArity("$lt", 2, ([a, b]) => `(${a} < ${b})`),
	fixedArity("$lte", 2, ([a, b]) => `(${a} <= ${b})`),

	// -- Boolean ------------------------------------------------------------
	variadicInfix("$and", "AND"),
	variadicInfix("$or", "OR"),
	fixedArity("$not", 1, ([a]) => `(!${a})`),

	// -- Conditional --------------------------------------------------------
	{
		name: "$cond",
		// Both spellings MongoDB accepts: the three-element array and the
		// `{if, then, else}` object.
		compile(operand, ctx) {
			const [test, whenTrue, whenFalse] = Array.isArray(operand)
				? operand
				: [
						(operand as Document)?.if,
						(operand as Document)?.then,
						(operand as Document)?.else,
					];
			if (test === undefined) {
				throw new MongoCompatibilityError(
					"$cond takes [if, then, else] or {if, then, else}.",
				);
			}
			return `(IF ${ctx.compile(test)} THEN ${ctx.compile(whenTrue)} ELSE ${ctx.compile(whenFalse)} END)`;
		},
	},
	{
		name: "$ifNull",
		compile(operand, ctx) {
			const args = operands(operand, ctx);
			if (args.length < 2) {
				throw new MongoCompatibilityError(
					"$ifNull takes at least two arguments.",
				);
			}
			// Right-folded so the last argument is the final fallback, which is how
			// MongoDB reads a chain of more than two.
			return args.reduceRight(
				(fallback, value) =>
					// `??` is SurrealQL's nullish coalesce: NONE and NULL fall through,
					// and `false`/`0`/`""` do not — matching what `$ifNull` treats as null.
					`(${value} ?? ${fallback})`,
			);
		},
	},
	{
		name: "$switch",
		compile(operand, ctx) {
			const spec = operand as { branches?: unknown; default?: unknown };
			const branches = Array.isArray(spec?.branches) ? spec.branches : [];
			if (branches.length === 0) {
				throw new MongoCompatibilityError(
					"$switch takes a non-empty `branches` array.",
				);
			}
			const otherwise =
				spec.default === undefined ? "NONE" : ctx.compile(spec.default);
			return branches.reduceRight<string>((fallback, branch) => {
				const { case: test, then } = branch as Document;
				return `(IF ${ctx.compile(test)} THEN ${ctx.compile(then)} ELSE ${fallback} END)`;
			}, otherwise);
		},
	},

	// -- Array --------------------------------------------------------------
	{
		name: "$map",
		// `{$map: {input, as, in}}`. `as` names the current element and defaults to
		// `this`, which is why `$$this` works inside one without being declared.
		compile(operand, ctx) {
			const {
				input,
				as: alias,
				in: body,
			} = closureSpec("$map", operand, ["in"]);
			return ctx.withVariable(
				alias,
				(parameter, compile) =>
					`array::map(${ctx.compile(input)}, |$${parameter}| ${compile(body)})`,
			);
		},
	},
	{
		name: "$filter",
		// `{$filter: {input, as, cond, limit}}`. `limit` keeps the first n that
		// match, which is a slice of the filtered array rather than a different
		// filter.
		compile(operand, ctx) {
			const spec = closureSpec("$filter", operand, ["cond"]);
			const { input, as: alias, cond } = spec;
			const filtered = ctx.withVariable(
				alias,
				(parameter, compile) =>
					`array::filter(${ctx.compile(input)}, |$${parameter}| ${compile(cond)})`,
			);
			const limit = (operand as Document).limit;
			if (limit === undefined) return filtered;
			return `array::slice(${filtered}, 0, ${ctx.compile(limit)})`;
		},
	},
	call("$size", "array::len", 1),
	call("$arrayElemAt", "array::at", 2),
	call("$reverseArray", "array::reverse", 1),
	call("$concatArrays", "array::concat"),
	fixedArity("$in", 2, ([needle, haystack]) => `(${needle} IN ${haystack})`),
	{
		name: "$reduce",
		// `{$reduce: {input, initialValue, in}}`. `array::reduce`'s closure takes
		// its array's first element as the seed rather than a separate initial
		// value, so `initialValue` is prepended to `input` first —
		// `array::reduce(array::concat([initialValue], input), …)` — which folds
		// to the same answer. Verified live, including the empty-`input` case:
		// concat leaves a one-element array, the closure never runs, and the
		// prepended `initialValue` comes back untouched.
		compile(operand, ctx) {
			if (
				typeof operand !== "object" ||
				operand === null ||
				Array.isArray(operand)
			) {
				throw new MongoCompatibilityError(
					"$reduce takes a document with `input`, `initialValue` and `in`.",
				);
			}
			const { input, initialValue, in: body } = operand as Document;
			if (
				input === undefined ||
				initialValue === undefined ||
				body === undefined
			) {
				throw new MongoCompatibilityError(
					"$reduce requires `input`, `initialValue` and `in`.",
				);
			}
			const seeded = `array::concat([${ctx.compile(initialValue)}], ${ctx.compile(input)})`;
			return ctx.withClosureVariables(
				["value", "this"],
				([value, current], compile) =>
					`array::reduce(${seeded}, |$${value}, $${current}| ${compile(body)})`,
			);
		},
	},

	// -- Set ------------------------------------------------------------------
	// MongoDB's set operators treat arrays as sets: order and duplicates don't
	// matter. `array::union`/`array::intersect` already de-duplicate their
	// result (verified live); `array::complement` — SurrealDB's one-directional
	// difference, `a` minus `b` — does not (verified live: complement of
	// `[1,1,2,5]` and `[2,3]` keeps both 1s), so it is wrapped in
	// `array::distinct`.
	{
		name: "$setUnion",
		compile(operand, ctx) {
			const args = operands(operand, ctx);
			if (args.length === 0) {
				throw new MongoCompatibilityError(
					"$setUnion takes at least one array.",
				);
			}
			if (args.length === 1) return `array::distinct(${args[0]})`;
			return args.reduce((acc, next) => `array::union(${acc}, ${next})`);
		},
	},
	{
		name: "$setIntersection",
		compile(operand, ctx) {
			const args = operands(operand, ctx);
			if (args.length === 0) {
				throw new MongoCompatibilityError(
					"$setIntersection takes at least one array.",
				);
			}
			if (args.length === 1) return `array::distinct(${args[0]})`;
			return args.reduce((acc, next) => `array::intersect(${acc}, ${next})`);
		},
	},
	fixedArity("$setDifference", 2, ([a, b]) => setDifference(a, b)),
	{
		name: "$setEquals",
		// Same distinct elements regardless of order or duplicate count: sort
		// each array's distinct elements and compare those, not the arrays
		// themselves.
		compile(operand, ctx) {
			const args = operands(operand, ctx);
			if (args.length < 2) {
				throw new MongoCompatibilityError(
					"$setEquals takes at least two arrays.",
				);
			}
			const sets = args.map((a) => `array::sort(array::distinct(${a}))`);
			const pairs = sets.slice(1).map((set, i) => `(${sets[i]} = ${set})`);
			return `(${pairs.join(" AND ")})`;
		},
	},
	// `b CONTAINSALL a` reads as "b has every element a has", which is exactly
	// "a is a subset of b" — verified live against both a true and false case.
	fixedArity("$setIsSubset", 2, ([a, b]) => `(${b} CONTAINSALL ${a})`),

	// -- Object -------------------------------------------------------------
	{
		name: "$mergeObjects",
		// Later objects win, which is what `object::extend` does and what MongoDB
		// documents. Folded because MongoDB takes any number and `object::extend`
		// takes two.
		compile(operand, ctx) {
			const args = operands(operand, ctx);
			if (args.length === 0) {
				throw new MongoCompatibilityError(
					"$mergeObjects takes at least one object.",
				);
			}
			return args.reduce(
				(merged, next) => `object::extend(${merged}, ${next})`,
			);
		},
	},
	{
		name: "$objectToArray",
		// `object::entries` returns `[k, v]` pairs; MongoDB's shape is `{k, v}`
		// documents, so each pair is remapped after. The closure parameter is
		// purely internal — nothing outside this one call ever needs to name it
		// — so it only needs to be fresh, which `withVariable` already guarantees.
		compile(operand, ctx) {
			const input = ctx.compile(operand);
			return ctx.withVariable(
				"__entry",
				(parameter) =>
					`array::map(object::entries(${input}), |$${parameter}| { k: $${parameter}[0], v: $${parameter}[1] })`,
			);
		},
	},
	{
		name: "$arrayToObject",
		// MongoDB accepts either `[[k, v], …]` or `[{k, v}, …]`. Which shape a
		// caller used is not known when this compiles, so `type::is_array` tells
		// the two apart per element at runtime instead — verified live for both
		// shapes against the same target document.
		compile(operand, ctx) {
			const input = ctx.compile(operand);
			return ctx.withVariable(
				"__entry",
				(parameter) =>
					`object::from_entries(array::map(${input}, |$${parameter}| IF type::is_array($${parameter}) THEN $${parameter} ELSE [$${parameter}.k, $${parameter}.v] END))`,
			);
		},
	},

	// -- Type ---------------------------------------------------------------
	// SurrealQL's cast syntax, which takes a parenthesised expression.
	// `$type` is deliberately absent: it answers with a BSON type name, and
	// SurrealDB's type names are its own — `float` where BSON says `double`, no
	// `objectId` at all — so any mapping would be invented rather than
	// translated, and would read as authoritative.
	call("$toString", "<string>", 1),
	call("$toBool", "<bool>", 1),
	call("$toInt", "<int>", 1),
	call("$toDouble", "<float>", 1),
	{
		name: "$convert",
		// `{$convert: {input, to, onError, onNull}}`, scoped to the four targets
		// this driver already casts elsewhere under their own names (string,
		// bool, int, double) — `to: "date"`/`"objectId"`/`"decimal"`/`"long"` have
		// no cast this driver implements. `onError` and `onNull` are refused
		// outright: SurrealQL has no try/catch, so a failing cast cannot be caught
		// and substituted, only allowed to raise.
		compile(operand, ctx) {
			if (
				typeof operand !== "object" ||
				operand === null ||
				Array.isArray(operand)
			) {
				throw new MongoCompatibilityError(
					"$convert takes a document with `input` and `to`.",
				);
			}
			const { input, to, onError, onNull } = operand as Document;
			if (input === undefined || to === undefined) {
				throw new MongoCompatibilityError(
					"$convert requires `input` and `to`.",
				);
			}
			if (onError !== undefined) {
				throw new MongoCompatibilityError(
					"$convert's `onError` is not supported: SurrealQL has no try/catch, so a failing cast cannot be caught and substituted here — it can only raise.",
				);
			}
			if (onNull !== undefined) {
				throw new MongoCompatibilityError(
					"$convert's `onNull` is not supported, for the same reason as `onError`: there is nothing this driver can intercept a null input with.",
				);
			}
			const cast = typeof to === "string" ? CONVERT_TARGETS[to] : undefined;
			if (!cast) {
				throw new MongoCompatibilityError(
					`$convert's \`to\` must be one of ${Object.keys(CONVERT_TARGETS).join(", ")}; ${JSON.stringify(to)} has no SurrealQL cast this driver implements.`,
				);
			}
			return `${cast}(${ctx.compile(input)})`;
		},
	},

	{
		name: "$regexMatch",
		// `{$regexMatch: {input, regex, options}}`. MongoDB's options are flag
		// letters; SurrealDB's `string::matches` takes none, so they are moved into
		// the pattern as an inline group, which is the same regex engine's own way
		// of spelling them.
		compile(operand, ctx) {
			if (
				typeof operand !== "object" ||
				operand === null ||
				Array.isArray(operand)
			) {
				throw new MongoCompatibilityError(
					"$regexMatch takes a document with `input` and `regex`.",
				);
			}
			const { input, regex, options } = operand as Document;
			if (typeof regex !== "string") {
				throw new MongoCompatibilityError(
					"$regexMatch's `regex` must be a string here: a BSON regular expression carries its own flags, and this driver does not unpack them. Pass the pattern and `options` instead.",
				);
			}
			if (options !== undefined && typeof options !== "string") {
				throw new MongoCompatibilityError(
					"$regexMatch's `options` must be a string of flag letters.",
				);
			}
			for (const flag of options ?? "") {
				if (!"imsx".includes(flag)) {
					throw new MongoCompatibilityError(
						`$regexMatch does not support the ${flag} flag; i, m, s and x are available.`,
					);
				}
			}
			const pattern = options ? `(?${options})${regex}` : regex;
			return `string::matches(${ctx.compile(input)}, ${ctx.bind(pattern)})`;
		},
	},

	{
		name: "$let",
		// `{$let: {vars, in}}`. The variables are substituted into the body rather
		// than bound, because SurrealQL has no `let` *expression* — only a
		// statement, which cannot appear here.
		//
		// Substitution is sound because every operator in this registry is pure: a
		// variable referenced twice is evaluated twice rather than once, which costs
		// more work and cannot change the answer. If an impure operator is ever
		// added, this is the thing to revisit.
		compile(operand, ctx) {
			if (
				typeof operand !== "object" ||
				operand === null ||
				Array.isArray(operand)
			) {
				throw new MongoCompatibilityError(
					"$let takes a document with `vars` and `in`.",
				);
			}
			const { vars, in: body } = operand as Document;
			if (typeof vars !== "object" || vars === null || Array.isArray(vars)) {
				throw new MongoCompatibilityError("$let's `vars` must be a document.");
			}
			if (body === undefined) {
				throw new MongoCompatibilityError("$let requires `in`.");
			}

			// Each variable is compiled in the scope *outside* the `$let`, which is
			// MongoDB's rule: one `vars` entry cannot refer to another.
			const bindings = new Map<string, string>();
			for (const [name, value] of Object.entries(vars as Document)) {
				bindings.set(name, `(${ctx.compile(value)})`);
			}
			return ctx.withVariables(bindings, (compile) => compile(body));
		},
	},

	// -- Date ---------------------------------------------------------------
	call("$year", "time::year", 1),
	call("$month", "time::month", 1),
	call("$dayOfMonth", "time::day", 1),
	call("$hour", "time::hour", 1),
	call("$minute", "time::minute", 1),
	call("$second", "time::second", 1),
	call("$dayOfYear", "time::yday", 1),
	{
		name: "$dateToString",
		// `{$dateToString: {date, format, timezone, onNull}}`.
		//
		// The format string is translated rather than passed through. MongoDB's
		// specifiers and the ones SurrealDB's `time::format` takes overlap but are
		// not the same set, and the differences are silent where they are not fatal:
		// `%L` is rejected outright, but `%w` would *work* and be wrong, because
		// MongoDB numbers the week from Sunday as 1 and this numbers it from 0. So
		// every specifier is either mapped to one that means the same thing or
		// refused by name.
		compile(operand, ctx) {
			if (
				typeof operand !== "object" ||
				operand === null ||
				Array.isArray(operand)
			) {
				throw new MongoCompatibilityError(
					"$dateToString takes a document with `date` and `format`.",
				);
			}
			const { date, format, timezone, onNull } = operand as Document;
			if (date === undefined) {
				throw new MongoCompatibilityError("$dateToString requires `date`.");
			}
			if (typeof format !== "string") {
				throw new MongoCompatibilityError(
					"$dateToString requires `format` as a string. MongoDB defaults it to an ISO-8601 string when omitted; this driver asks for it rather than assuming, because the default is a format like any other.",
				);
			}
			if (timezone !== undefined) {
				throw new MongoCompatibilityError(
					"$dateToString's `timezone` is not supported: SurrealDB's time::format renders in UTC and takes no zone, so a zoned format would silently be UTC. Convert before formatting, or format in UTC.",
				);
			}
			if (onNull !== undefined) {
				throw new MongoCompatibilityError(
					"$dateToString's `onNull` is not supported. Wrap the whole expression in $ifNull instead, which is the same thing and is implemented.",
				);
			}

			return `time::format(${ctx.compile(date)}, ${ctx.bind(translateDateFormat(format))})`;
		},
	},
	{
		name: "$dayOfWeek",
		// `time::wday` is ISO — Monday is 1 and Sunday is 7. MongoDB's
		// `$dayOfWeek` is Sunday 1 through Saturday 7. `(iso % 7) + 1` maps one
		// onto the other: Sunday 7 → 1, Monday 1 → 2, Saturday 6 → 7. Measured
		// against a live server rather than reasoned about, because getting this
		// wrong shifts every day by one and still returns a plausible number.
		compile: (operand, ctx) =>
			`((time::wday(${ctx.compile(Array.isArray(operand) ? operand[0] : operand)}) % 7) + 1)`,
	},
	{
		name: "$dateAdd",
		// `{$dateAdd: {startDate, unit, amount, timezone}}`. SurrealQL durations
		// are unsigned — `1h * -5` is a runtime error, verified live — so a
		// negative `amount` is handled by subtracting the magnitude instead of
		// adding a negative duration, which SurrealQL has no way to construct.
		compile(operand, ctx) {
			if (
				typeof operand !== "object" ||
				operand === null ||
				Array.isArray(operand)
			) {
				throw new MongoCompatibilityError(
					"$dateAdd takes a document with `startDate`, `unit` and `amount`.",
				);
			}
			const { startDate, unit, amount, timezone } = operand as Document;
			if (startDate === undefined || amount === undefined) {
				throw new MongoCompatibilityError(
					"$dateAdd requires `startDate` and `amount`.",
				);
			}
			if (timezone !== undefined) {
				throw new MongoCompatibilityError(
					"$dateAdd's `timezone` is not supported: SurrealDB's date arithmetic has no zone, every value here is UTC.",
				);
			}
			const suffix = dateUnit(
				"$dateAdd",
				unit,
				DATE_ADD_UNITS,
				CALENDAR_UNITS_NOTE,
			);
			const start = ctx.compile(startDate);
			const value = ctx.compile(amount);
			const boundSuffix = ctx.bind(suffix);
			const magnitude = (expr: string) =>
				`(<duration>(<string>(${expr}) + ${boundSuffix}))`;
			return `(IF ${value} >= 0 THEN ${start} + ${magnitude(value)} ELSE ${start} - ${magnitude(`math::abs(${value})`)} END)`;
		},
	},
	{
		name: "$dateDiff",
		// `{$dateDiff: {startDate, endDate, unit, timezone, startOfWeek}}`. Only
		// millisecond/second/minute/hour/day: `endDate - startDate` throws at
		// runtime if the result would be negative — durations are unsigned,
		// verified live — so the sign is branched on rather than computed
		// directly either way, same as `$dateAdd`.
		compile(operand, ctx) {
			if (
				typeof operand !== "object" ||
				operand === null ||
				Array.isArray(operand)
			) {
				throw new MongoCompatibilityError(
					"$dateDiff takes a document with `startDate`, `endDate` and `unit`.",
				);
			}
			const { startDate, endDate, unit, timezone, startOfWeek } =
				operand as Document;
			if (startDate === undefined || endDate === undefined) {
				throw new MongoCompatibilityError(
					"$dateDiff requires `startDate` and `endDate`.",
				);
			}
			if (timezone !== undefined) {
				throw new MongoCompatibilityError(
					"$dateDiff's `timezone` is not supported: SurrealDB's date arithmetic has no zone, every value here is UTC.",
				);
			}
			if (startOfWeek !== undefined) {
				throw new MongoCompatibilityError(
					'$dateDiff\'s `startOfWeek` is not supported: this driver refuses `unit: "week"` outright, and startOfWeek has no other purpose.',
				);
			}
			const fn = dateUnit(
				"$dateDiff",
				unit,
				DATE_DIFF_UNITS,
				CALENDAR_UNITS_NOTE_WITH_WEEK,
			);
			const start = ctx.compile(startDate);
			const end = ctx.compile(endDate);
			return `(IF ${end} >= ${start} THEN duration::${fn}(${end} - ${start}) ELSE -duration::${fn}(${start} - ${end}) END)`;
		},
	},
	{
		name: "$dateTrunc",
		// `{$dateTrunc: {date, unit, binSize, timezone, startOfWeek}}`.
		// `time::round` rounds to the *nearest* boundary — verified live:
		// 13:47:32 at a 1-hour bin rounds up to 14:00 — while `$dateTrunc` truncates
		// down, which is `time::floor`, not `time::round`.
		compile(operand, ctx) {
			if (
				typeof operand !== "object" ||
				operand === null ||
				Array.isArray(operand)
			) {
				throw new MongoCompatibilityError(
					"$dateTrunc takes a document with `date` and `unit`.",
				);
			}
			const { date, unit, binSize, timezone, startOfWeek } =
				operand as Document;
			if (date === undefined) {
				throw new MongoCompatibilityError("$dateTrunc requires `date`.");
			}
			if (timezone !== undefined) {
				throw new MongoCompatibilityError(
					"$dateTrunc's `timezone` is not supported: SurrealDB's date arithmetic has no zone, every value here is UTC.",
				);
			}
			if (startOfWeek !== undefined) {
				throw new MongoCompatibilityError(
					'$dateTrunc\'s `startOfWeek` is not supported: this driver refuses `unit: "week"` outright, and startOfWeek has no other purpose.',
				);
			}
			const suffix = dateUnit(
				"$dateTrunc",
				unit,
				DATE_TRUNC_UNITS,
				CALENDAR_UNITS_NOTE_WITH_WEEK,
			);
			const bin = binSize === undefined ? "1" : ctx.compile(binSize);
			return `time::floor(${ctx.compile(date)}, <duration>(<string>(${bin}) + ${ctx.bind(suffix)}))`;
		},
	},
];

const REGISTRY = new Map(OPERATORS.map((op) => [op.name, op]));

/**
 * Read the `{input, as, …}` shape `$map` and `$filter` share.
 *
 * `as` defaults to `this`, which is what makes `$$this` mean the current element
 * without the caller declaring it.
 */
function closureSpec(
	name: string,
	operand: unknown,
	required: readonly string[],
): { input: unknown; as: string; [key: string]: unknown } {
	if (
		typeof operand !== "object" ||
		operand === null ||
		Array.isArray(operand)
	) {
		throw new MongoCompatibilityError(
			`${name} takes a specification document.`,
		);
	}
	const spec = operand as Document;
	if (spec.input === undefined) {
		throw new MongoCompatibilityError(`${name} requires \`input\`.`);
	}
	for (const field of required) {
		if (spec[field] === undefined) {
			throw new MongoCompatibilityError(`${name} requires \`${field}\`.`);
		}
	}
	if (spec.as !== undefined && typeof spec.as !== "string") {
		throw new MongoCompatibilityError(`${name}'s \`as\` must be a string.`);
	}
	return { ...spec, input: spec.input, as: (spec.as as string) ?? "this" };
}

/** System variables with an exact SurrealQL counterpart. */
const SYSTEM_VARIABLES: Readonly<Record<string, string>> = {
	NOW: "time::now()",
};

/**
 * Compile one MongoDB aggregation expression.
 *
 * `bind` is supplied by the pipeline so every literal in the statement gets a
 * parameter of its own, and nothing a caller wrote is ever interpolated into
 * SurrealQL.
 */
export function compileExpression(
	expression: unknown,
	bind: (value: unknown) => string,
	identityIsPlainField = false,
	variables: ReadonlyMap<string, string> = new Map(),
): string {
	const ctx: ExpressionContext = {
		bind: (value) => `$${bind(value)}`,
		compile: (nested) =>
			compileExpression(nested, bind, identityIsPlainField, variables),
		identityIsPlainField,
		variables,
		withVariable(name, body) {
			// Numbered by how many are already bound, so a `$map` inside a `$map`
			// binds two different parameters and the inner cannot hide the outer.
			const parameter = `mql_v${variables.size}`;
			const inner = new Map(variables).set(name, `$${parameter}`);
			return body(parameter, (nested) =>
				compileExpression(nested, bind, identityIsPlainField, inner),
			);
		},
		withVariables(bindings, body) {
			const inner = new Map(variables);
			for (const [name, sql] of bindings) inner.set(name, sql);
			return body((nested) =>
				compileExpression(nested, bind, identityIsPlainField, inner),
			);
		},
		withClosureVariables(names, body) {
			const parameters = names.map((_, i) => `mql_v${variables.size + i}`);
			const inner = new Map(variables);
			for (const [i, name] of names.entries()) {
				inner.set(name, `$${parameters[i]}`);
			}
			return body(parameters, (nested) =>
				compileExpression(nested, bind, identityIsPlainField, inner),
			);
		},
	};
	return compile(expression, ctx);
}

function compile(expression: unknown, ctx: ExpressionContext): string {
	if (typeof expression === "string" && expression.startsWith("$")) {
		return compileReference(expression, ctx);
	}

	if (isOperatorObject(expression)) {
		const [name] = Object.keys(expression);
		const operator = REGISTRY.get(name);
		if (!operator) {
			throw new MongoCompatibilityError(
				`The aggregation expression operator ${name} is not implemented by @surrealdb/mql. Compiling it partially would answer with values that ignored it, so it is refused instead. Supported operators are listed in the README.`,
			);
		}
		return operator.compile(expression[name], ctx);
	}

	// An object that is not an operator is a literal document — `{a: "$x"}` in a
	// `$project` builds a nested document, with each leaf an expression.
	if (isPlainObject(expression)) {
		const fields = Object.entries(expression).map(
			([key, value]) => `${JSON.stringify(key)}: ${compile(value, ctx)}`,
		);
		return `{ ${fields.join(", ")} }`;
	}

	if (Array.isArray(expression)) {
		return `[${expression.map((each) => compile(each, ctx)).join(", ")}]`;
	}

	return ctx.bind(expression);
}

/** `"$field"` or `"$$VAR"`. */
function compileReference(reference: string, ctx: ExpressionContext): string {
	if (reference.startsWith("$$")) {
		const name = reference.slice(2);
		// A variable a `$map` or `$filter` bound wins over the system table, which
		// is also MongoDB's rule: `$$this` means the current element inside one.
		const bound = ctx.variables.get(name);
		if (bound) return bound;
		const variable = SYSTEM_VARIABLES[name];
		if (variable) return variable;
		throw new MongoCompatibilityError(
			`The aggregation system variable $$${name} is not implemented by @surrealdb/mql. $$NOW is available; $$ROOT and $$CURRENT are not, because a whole-document value has nowhere to go in the statements this driver emits.`,
		);
	}
	return fieldPath(reference.slice(1), ctx.identityIsPlainField);
}

/** True for `{$op: …}` — exactly one key, and it starts with `$`. */
function isOperatorObject(value: unknown): value is Document {
	if (!isPlainObject(value)) return false;
	const keys = Object.keys(value);
	return keys.length === 1 && keys[0].startsWith("$");
}

function isPlainObject(value: unknown): value is Document {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

/** True when `name` is an expression operator this driver implements. */
export function isExpressionOperator(name: string): boolean {
	return REGISTRY.has(name);
}

/**
 * MongoDB's `$dateToString` specifiers, mapped onto the ones `time::format` takes.
 *
 * Identical spellings are listed anyway, so the table is the whole of what is
 * accepted and anything absent is refused rather than passed through by accident.
 */
const DATE_SPECIFIERS: Readonly<Record<string, string>> = {
	Y: "%Y",
	m: "%m",
	d: "%d",
	H: "%H",
	M: "%M",
	S: "%S",
	j: "%j",
	U: "%U",
	G: "%G",
	V: "%V",
	z: "%z",
	Z: "%Z",
	// MongoDB's milliseconds; chrono spells three fractional digits this way.
	L: "%3f",
	"%": "%%",
};

/**
 * Specifiers deliberately refused, with what makes each one wrong to translate.
 *
 * `%w` and `%u` are the dangerous pair: both would render a number, and both
 * would be off by one against MongoDB, which numbers Sunday as 1. `%L` is not
 * here because SurrealDB rejects it outright — a specifier that fails loudly
 * needs no guard, only a mapping.
 */
const REFUSED_SPECIFIERS: Readonly<Record<string, string>> = {
	w: "MongoDB numbers the day of week from Sunday as 1 and SurrealDB from Sunday as 0, so this would render a number wrong by one. Use $dayOfWeek, which applies the offset",
	u: "MongoDB and SurrealDB disagree on where the ISO week starts counting, so this would render a number wrong by one",
};

/** Translate a MongoDB date format string, refusing what cannot be translated. */
function translateDateFormat(format: string): string {
	let out = "";
	for (let i = 0; i < format.length; i++) {
		if (format[i] !== "%") {
			out += format[i];
			continue;
		}
		const specifier = format[i + 1];
		if (specifier === undefined) {
			throw new MongoCompatibilityError(
				"$dateToString's format ends with a lone %, which names no specifier.",
			);
		}
		const refused = REFUSED_SPECIFIERS[specifier];
		if (refused) {
			throw new MongoCompatibilityError(
				`$dateToString does not support %${specifier}: ${refused}.`,
			);
		}
		const mapped = DATE_SPECIFIERS[specifier];
		if (!mapped) {
			throw new MongoCompatibilityError(
				`$dateToString does not support %${specifier}. Supported: ${Object.keys(
					DATE_SPECIFIERS,
				)
					.map((key) => `%${key}`)
					.join(" ")}.`,
			);
		}
		out += mapped;
		i++;
	}
	return out;
}
