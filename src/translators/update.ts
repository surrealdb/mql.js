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
}

function nextParam(ctx: Context): string {
	return `p${ctx.counter++}`;
}

function escapeField(field: string): string {
	return field;
}

// ---------------------------------------------------------------------------
// Operator handlers – each one processes all field entries for its operator
// ---------------------------------------------------------------------------

type OperatorHandler = (entries: [string, unknown][], ctx: Context) => void;

/** $set: { k: v } → SET k = $p */
function handleSet(entries: [string, unknown][], ctx: Context): void {
	for (const [field, value] of entries) {
		const p = nextParam(ctx);
		ctx.bindings[p] = value;
		ctx.parts.push(`${escapeField(field)} = $${p}`);
	}
}

/** $unset: { k: "" } → SET k = NONE */
function handleUnset(entries: [string, unknown][], ctx: Context): void {
	for (const [field] of entries) {
		ctx.parts.push(`${escapeField(field)} = NONE`);
	}
}

/** Simple binary operator: $inc (+=), $mul (*=) */
function handleBinaryOp(op: string): OperatorHandler {
	return (entries, ctx) => {
		for (const [field, value] of entries) {
			const p = nextParam(ctx);
			ctx.bindings[p] = value;
			ctx.parts.push(`${escapeField(field)} ${op} $${p}`);
		}
	};
}

/** Function-based operator: $min → math::min, $max → math::max */
function handleFunctionOp(fn: string): OperatorHandler {
	return (entries, ctx) => {
		for (const [field, value] of entries) {
			const p = nextParam(ctx);
			ctx.bindings[p] = value;
			ctx.parts.push(
				`${escapeField(field)} = ${fn}(${escapeField(field)}, $${p})`,
			);
		}
	};
}

/** $push: { k: v } → SET k += [$p] */
function handlePush(entries: [string, unknown][], ctx: Context): void {
	for (const [field, value] of entries) {
		const p = nextParam(ctx);
		ctx.bindings[p] = value;
		ctx.parts.push(`${escapeField(field)} += [$${p}]`);
	}
}

/** $pull: { k: v } → SET k -= [$p] */
function handlePull(entries: [string, unknown][], ctx: Context): void {
	for (const [field, value] of entries) {
		const p = nextParam(ctx);
		ctx.bindings[p] = value;
		ctx.parts.push(`${escapeField(field)} -= [$${p}]`);
	}
}

/** $addToSet: { k: v } → SET k = array::union(k, [$p]) */
function handleAddToSet(entries: [string, unknown][], ctx: Context): void {
	for (const [field, value] of entries) {
		const p = nextParam(ctx);
		ctx.bindings[p] = value;
		ctx.parts.push(
			`${escapeField(field)} = array::union(${escapeField(field)}, [$${p}])`,
		);
	}
}

/** $rename: { old: "new" } → SET new = old, old = NONE */
function handleRename(entries: [string, unknown][], ctx: Context): void {
	for (const [oldField, newField] of entries) {
		ctx.parts.push(
			`${escapeField(newField as string)} = ${escapeField(oldField)}`,
		);
		ctx.parts.push(`${escapeField(oldField)} = NONE`);
	}
}

/** $currentDate: { k: true } → SET k = time::now() */
function handleCurrentDate(entries: [string, unknown][], ctx: Context): void {
	for (const [field] of entries) {
		ctx.parts.push(`${escapeField(field)} = time::now()`);
	}
}

/** Map of operator names to their handler functions. */
const OPERATOR_HANDLERS: Record<string, OperatorHandler> = {
	$set: handleSet,
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
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Translate a MongoDB update document into a SurrealQL SET clause.
 *
 * @param startIndex – starting index for parameter names, so bindings
 *   don't collide with those from the filter translator.
 */
export function translateUpdate(
	update: Document,
	startIndex = 0,
): TranslatedUpdate {
	const ctx: Context = {
		counter: startIndex,
		bindings: {},
		parts: [],
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
