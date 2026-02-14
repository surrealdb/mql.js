/**
 * Translates a MongoDB update document (with $set, $inc, etc.) into
 * a SurrealQL SET clause with parameterised bindings.
 *
 * Example:
 *   { $set: { name: "Jane" }, $inc: { age: 1 } }
 *   →  { clause: "SET name = $p0, age += $p1", bindings: { p0: "Jane", p1: 1 } }
 */

import type { Document } from "../types.ts";

export interface TranslatedUpdate {
	/** SurrealQL clause starting with SET (or CONTENT for full replacement). */
	clause: string;
	/** Parameterised bindings. */
	bindings: Record<string, unknown>;
}

interface Context {
	counter: number;
	bindings: Record<string, unknown>;
	parts: string[];
	arrayFilters?: Document[];
}

function nextParam(ctx: Context): string {
	return `p${ctx.counter++}`;
}

function escapeField(field: string): string {
	return field;
}

// ---------------------------------------------------------------------------
// Positional array operator support
// ---------------------------------------------------------------------------

/** Regex matching $[] (all-positional) in a field path. */
const ALL_POSITIONAL_RE = /\.\$\[\]/g;

/** Regex matching $[identifier] (filtered-positional) in a field path. */
const FILTERED_POSITIONAL_RE = /\.\$\[(\w+)\]/g;

/**
 * Resolve a MongoDB field path, transforming positional array markers
 * into SurrealQL array access syntax.
 *
 * - `grades.$[].score`       → `grades[*].score`
 * - `grades.$[elem].score`   → `grades[WHERE grade = $p0].score`
 *
 * Falls back to `escapeField()` for paths without positional markers.
 */
function resolveField(field: string, ctx: Context): string {
	let resolved = field;

	// Replace .$[] with [*]
	resolved = resolved.replace(ALL_POSITIONAL_RE, "[*]");

	// Replace .$[identifier] with [WHERE condition]
	if (FILTERED_POSITIONAL_RE.test(resolved)) {
		// Reset lastIndex after test()
		FILTERED_POSITIONAL_RE.lastIndex = 0;

		resolved = resolved.replace(
			FILTERED_POSITIONAL_RE,
			(_match, identifier: string) => {
				const condition = resolveArrayFilter(identifier, ctx);
				return `[WHERE ${condition}]`;
			},
		);
	}

	return escapeField(resolved);
}

/**
 * Translate a single arrayFilter entry (field + value) into a SurrealQL condition.
 * Pushes results into the `conditions` array.
 */
function translateArrayFilterEntry(
	subField: string,
	value: unknown,
	ctx: Context,
	conditions: string[],
): void {
	if (isOperatorObject(value)) {
		for (const [op, opVal] of Object.entries(
			value as Record<string, unknown>,
		)) {
			const p = nextParam(ctx);
			ctx.bindings[p] = opVal;
			const sqlOp = COMPARISON_OPS[op];
			if (!sqlOp) {
				throw new Error(`Unsupported operator in arrayFilter: ${op}`);
			}
			conditions.push(`${subField} ${sqlOp} $${p}`);
		}
	} else {
		const p = nextParam(ctx);
		ctx.bindings[p] = value;
		conditions.push(`${subField} = $${p}`);
	}
}

/**
 * Look up an arrayFilter identifier and translate its conditions into
 * a SurrealQL WHERE clause fragment.
 *
 * Given arrayFilters: [{ "elem.grade": "A", "elem.score": { $gte: 90 } }]
 * and identifier "elem", returns: `grade = $p0 AND score >= $p1`
 */
function resolveArrayFilter(identifier: string, ctx: Context): string {
	if (!ctx.arrayFilters || ctx.arrayFilters.length === 0) {
		throw new Error(
			`Positional operator $[${identifier}] requires arrayFilters`,
		);
	}

	const prefix = `${identifier}.`;
	const filter = ctx.arrayFilters.find((f) =>
		Object.keys(f).some((k) => k.startsWith(prefix)),
	);

	if (!filter) {
		throw new Error(`No arrayFilter found for identifier "${identifier}"`);
	}

	const conditions: string[] = [];
	for (const [key, value] of Object.entries(filter)) {
		if (!key.startsWith(prefix)) continue;
		translateArrayFilterEntry(key.slice(prefix.length), value, ctx, conditions);
	}

	return conditions.join(" AND ");
}

/**
 * Check whether a value looks like a MongoDB operator object.
 */
function isOperatorObject(value: unknown): boolean {
	if (value === null || value === undefined || typeof value !== "object") {
		return false;
	}
	if (Array.isArray(value)) return false;
	const keys = Object.keys(value as Record<string, unknown>);
	return keys.length > 0 && keys.every((k) => k.startsWith("$"));
}

/** Maps common MongoDB comparison operators to SurrealQL operators. */
const COMPARISON_OPS: Record<string, string> = {
	$eq: "=",
	$ne: "!=",
	$gt: ">",
	$gte: ">=",
	$lt: "<",
	$lte: "<=",
	$in: "IN",
	$nin: "NOT IN",
};

// ---------------------------------------------------------------------------
// Operator handlers – each one processes all field entries for its operator
// ---------------------------------------------------------------------------

type OperatorHandler = (entries: [string, unknown][], ctx: Context) => void;

/** $set: { k: v } → SET k = $p */
function handleSet(entries: [string, unknown][], ctx: Context): void {
	for (const [field, value] of entries) {
		const f = resolveField(field, ctx);
		const p = nextParam(ctx);
		ctx.bindings[p] = value;
		ctx.parts.push(`${f} = $${p}`);
	}
}

/** $unset: { k: "" } → SET k = NONE */
function handleUnset(entries: [string, unknown][], ctx: Context): void {
	for (const [field] of entries) {
		ctx.parts.push(`${resolveField(field, ctx)} = NONE`);
	}
}

/** Simple binary operator: $inc (+=), $mul (*=) */
function handleBinaryOp(op: string): OperatorHandler {
	return (entries, ctx) => {
		for (const [field, value] of entries) {
			const f = resolveField(field, ctx);
			const p = nextParam(ctx);
			ctx.bindings[p] = value;
			ctx.parts.push(`${f} ${op} $${p}`);
		}
	};
}

/** Function-based operator: $min → math::min, $max → math::max */
function handleFunctionOp(fn: string): OperatorHandler {
	return (entries, ctx) => {
		for (const [field, value] of entries) {
			const f = resolveField(field, ctx);
			const p = nextParam(ctx);
			ctx.bindings[p] = value;
			ctx.parts.push(`${f} = ${fn}(${f}, $${p})`);
		}
	};
}

/**
 * Check if a $push value is a modifier object (has $each key).
 */
function isPushModifier(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		"$each" in (value as Record<string, unknown>)
	);
}

/**
 * $push handler – supports both simple values and modifier objects.
 *
 * Simple:    { $push: { tags: "new" } }     → SET tags += [$p]
 * Modifier:  { $push: { scores: { $each: [1,2], $sort: 1, $slice: 5 } } }
 *            → SET scores = array::slice(array::sort::asc(array::concat(scores, $p)), 0, 5)
 */
function handlePush(entries: [string, unknown][], ctx: Context): void {
	for (const [field, value] of entries) {
		if (isPushModifier(value)) {
			handlePushWithModifiers(field, value as Record<string, unknown>, ctx);
		} else {
			const f = resolveField(field, ctx);
			const p = nextParam(ctx);
			ctx.bindings[p] = value;
			ctx.parts.push(`${f} += [$${p}]`);
		}
	}
}

/**
 * Handle $push with $each and optional $sort, $slice, $position modifiers.
 */
function handlePushWithModifiers(
	field: string,
	mods: Record<string, unknown>,
	ctx: Context,
): void {
	const f = resolveField(field, ctx);
	const eachParam = nextParam(ctx);
	ctx.bindings[eachParam] = mods.$each;

	// Step 1: build the concat expression
	let expr: string;
	if (mods.$position !== undefined) {
		const pos = mods.$position as number;
		const posParam = nextParam(ctx);
		ctx.bindings[posParam] = pos;
		// Insert at position: concat(slice(0, pos), $each, slice(pos))
		expr = `array::concat(array::concat(array::slice(${f}, 0, $${posParam}), $${eachParam}), array::slice(${f}, $${posParam}))`;
	} else {
		expr = `array::concat(${f}, $${eachParam})`;
	}

	// Step 2: apply $sort if present
	if (mods.$sort !== undefined) {
		const sortVal = mods.$sort;
		if (typeof sortVal === "number") {
			expr =
				sortVal === -1
					? `array::sort::desc(${expr})`
					: `array::sort::asc(${expr})`;
		} else {
			// Sort by sub-field: use array::sort::asc/desc (limited support)
			expr = `array::sort::asc(${expr})`;
		}
	}

	// Step 3: apply $slice if present
	if (mods.$slice !== undefined) {
		const sliceVal = mods.$slice as number;
		const sliceParam = nextParam(ctx);
		if (sliceVal < 0) {
			// Keep last N elements
			ctx.bindings[sliceParam] = sliceVal;
			expr = `array::slice(${expr}, $${sliceParam})`;
		} else {
			// Keep first N elements
			ctx.bindings[sliceParam] = sliceVal;
			expr = `array::slice(${expr}, 0, $${sliceParam})`;
		}
	}

	ctx.parts.push(`${f} = ${expr}`);
}

/** $pull: { k: v } → SET k -= [$p] */
function handlePull(entries: [string, unknown][], ctx: Context): void {
	for (const [field, value] of entries) {
		const f = resolveField(field, ctx);
		const p = nextParam(ctx);
		ctx.bindings[p] = value;
		ctx.parts.push(`${f} -= [$${p}]`);
	}
}

/** $addToSet: { k: v } → SET k = array::union(k, [$p]) */
function handleAddToSet(entries: [string, unknown][], ctx: Context): void {
	for (const [field, value] of entries) {
		const f = resolveField(field, ctx);
		const p = nextParam(ctx);
		ctx.bindings[p] = value;
		ctx.parts.push(`${f} = array::union(${f}, [$${p}])`);
	}
}

/** $rename: { old: "new" } → SET new = old, old = NONE */
function handleRename(entries: [string, unknown][], ctx: Context): void {
	for (const [oldField, newField] of entries) {
		ctx.parts.push(
			`${resolveField(newField as string, ctx)} = ${resolveField(oldField, ctx)}`,
		);
		ctx.parts.push(`${resolveField(oldField, ctx)} = NONE`);
	}
}

/** $currentDate: { k: true } → SET k = time::now() */
function handleCurrentDate(entries: [string, unknown][], ctx: Context): void {
	for (const [field] of entries) {
		ctx.parts.push(`${resolveField(field, ctx)} = time::now()`);
	}
}

/** $pop: { k: 1 } (remove last) or { k: -1 } (remove first) */
function handlePop(entries: [string, unknown][], ctx: Context): void {
	for (const [field, value] of entries) {
		const f = resolveField(field, ctx);
		if (value === -1) {
			// Remove first element
			ctx.parts.push(`${f} = array::slice(${f}, 1)`);
		} else {
			// Remove last element
			ctx.parts.push(`${f} = array::slice(${f}, 0, array::len(${f}) - 1)`);
		}
	}
}

/** $setOnInsert: { k: v } → SET k = k ?? $p (only sets on insert during upsert) */
function handleSetOnInsert(entries: [string, unknown][], ctx: Context): void {
	for (const [field, value] of entries) {
		const f = resolveField(field, ctx);
		const p = nextParam(ctx);
		ctx.bindings[p] = value;
		ctx.parts.push(`${f} = ${f} ?? $${p}`);
	}
}

/** $pullAll: { k: [v1, v2] } → SET k = array::complement(k, $p) */
function handlePullAll(entries: [string, unknown][], ctx: Context): void {
	for (const [field, value] of entries) {
		const f = resolveField(field, ctx);
		const p = nextParam(ctx);
		ctx.bindings[p] = value;
		ctx.parts.push(`${f} = array::complement(${f}, $${p})`);
	}
}

/** Map of operator names to their handler functions. */
const OPERATOR_HANDLERS: Record<string, OperatorHandler> = {
	$set: handleSet,
	$setOnInsert: handleSetOnInsert,
	$unset: handleUnset,
	$inc: handleBinaryOp("+="),
	$mul: handleBinaryOp("*="),
	$min: handleFunctionOp("math::min"),
	$max: handleFunctionOp("math::max"),
	$push: handlePush,
	$pull: handlePull,
	$addToSet: handleAddToSet,
	$rename: handleRename,
	$currentDate: handleCurrentDate,
	$pop: handlePop,
	$pullAll: handlePullAll,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Options for `translateUpdate`. */
export interface TranslateUpdateOptions {
	/** Starting index for parameter names (avoids collisions). */
	startIndex?: number;
	/** Array filters for positional filtered operators ($[identifier]). */
	arrayFilters?: Document[];
}

/**
 * Translate a MongoDB update document into a SurrealQL SET clause.
 *
 * @param startIndex – starting index for parameter names, so bindings
 *   don't collide with those from the filter translator.
 */
export function translateUpdate(
	update: Document,
	startIndex?: number,
	options?: TranslateUpdateOptions,
): TranslatedUpdate {
	const ctx: Context = {
		counter: startIndex ?? options?.startIndex ?? 0,
		bindings: {},
		parts: [],
		arrayFilters: options?.arrayFilters,
	};

	for (const [op, fields] of Object.entries(update)) {
		if (typeof fields !== "object" || fields === null) {
			throw new Error(`Update operator ${op} requires an object value`);
		}

		const handler = OPERATOR_HANDLERS[op];
		if (!handler) {
			throw new Error(`Unsupported update operator: ${op}`);
		}

		const entries = Object.entries(fields as Record<string, unknown>);
		handler(entries, ctx);
	}

	if (ctx.parts.length === 0) {
		return { clause: "", bindings: {} };
	}

	return { clause: `SET ${ctx.parts.join(", ")}`, bindings: ctx.bindings };
}

/**
 * Translate a full-document replacement (no operators) into a SurrealQL
 * CONTENT clause. Used by `replaceOne`.
 */
export function translateReplacement(
	replacement: Document,
	startIndex = 0,
): TranslatedUpdate {
	const p = `p${startIndex}`;
	return {
		clause: `CONTENT $${p}`,
		bindings: { [p]: replacement },
	};
}
