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

	// -- Date ---------------------------------------------------------------
	call("$year", "time::year", 1),
	call("$month", "time::month", 1),
	call("$dayOfMonth", "time::day", 1),
	call("$hour", "time::hour", 1),
	call("$minute", "time::minute", 1),
	call("$second", "time::second", 1),
	call("$dayOfYear", "time::yday", 1),
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
			const inner = new Map(variables).set(name, parameter);
			return body(parameter, (nested) =>
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
		if (bound) return `$${bound}`;
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
