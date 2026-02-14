/**
 * Translates a MongoDB query filter document into a SurrealQL WHERE clause
 * with parameterised bindings.
 *
 * Example:
 *   { name: "John", age: { $gt: 25 } }
 *   →  { clause: "name = $p0 AND age > $p1", bindings: { p0: "John", p1: 25 } }
 */

import type { Document } from "../types.ts";

export interface TranslatedFilter {
	/** SurrealQL expression to be used after WHERE (empty string when no filter). */
	clause: string;
	/** Parameterised bindings for the clause. */
	bindings: Record<string, unknown>;
}

/** Binding counter – scoped per `translateFilter` call via the context. */
interface Context {
	counter: number;
}

function nextParam(ctx: Context): string {
	return `p${ctx.counter++}`;
}

/** Escape a field path for use in SurrealQL. Dot-notation passes through as-is. */
function escapeField(field: string): string {
	// SurrealQL supports dot notation natively for nested access.
	// Simple identifier characters + dots are safe as-is.
	return field;
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

/**
 * Translate a MongoDB filter document to a SurrealQL WHERE clause.
 * Returns an empty clause when the filter is empty or undefined.
 */
export function translateFilter(filter?: Document | null): TranslatedFilter {
	if (!filter || Object.keys(filter).length === 0) {
		return { clause: "", bindings: {} };
	}

	const ctx: Context = { counter: 0 };
	const bindings: Record<string, unknown> = {};
	const clause = translateDocument(filter, ctx, bindings);

	return { clause, bindings };
}

// ---------------------------------------------------------------------------
// Internal recursive translation
// ---------------------------------------------------------------------------

/**
 * Translate a top-level filter document. Each key is either a field name
 * or a top-level logical operator ($and, $or, $nor).
 */
function translateDocument(
	doc: Document,
	ctx: Context,
	bindings: Record<string, unknown>,
): string {
	const parts: string[] = [];

	for (const [key, value] of Object.entries(doc)) {
		if (key === "$and") {
			parts.push(
				translateLogicalArray(value as Document[], "AND", ctx, bindings),
			);
		} else if (key === "$or") {
			parts.push(
				translateLogicalArray(value as Document[], "OR", ctx, bindings),
			);
		} else if (key === "$nor") {
			const inner = translateLogicalArray(
				value as Document[],
				"OR",
				ctx,
				bindings,
			);
			parts.push(`NOT (${inner})`);
		} else {
			// Field-level condition
			parts.push(translateFieldCondition(key, value, ctx, bindings));
		}
	}

	return parts.join(" AND ");
}

/**
 * Translate $and / $or / $nor arrays.
 */
function translateLogicalArray(
	arr: Document[],
	operator: "AND" | "OR",
	ctx: Context,
	bindings: Record<string, unknown>,
): string {
	const parts = arr.map((sub) => translateDocument(sub, ctx, bindings));
	if (parts.length === 1) return parts[0];
	return `(${parts.join(` ${operator} `)})`;
}

/**
 * Translate a single field condition. The value can be:
 *   - a plain value (implicit $eq)
 *   - an object with operator keys ($gt, $in, $exists, etc.)
 *   - a RegExp (shorthand for $regex)
 */
function translateFieldCondition(
	field: string,
	value: unknown,
	ctx: Context,
	bindings: Record<string, unknown>,
): string {
	const f = escapeField(field);

	// RegExp shorthand: { field: /pattern/ }
	if (value instanceof RegExp) {
		const param = nextParam(ctx);
		bindings[param] = value.source;
		return `${f} ~ $${param}`;
	}

	// Operator object: { field: { $gt: 5, $lt: 10 } }
	if (isOperatorObject(value)) {
		return translateOperators(f, value as Document, ctx, bindings);
	}

	// Implicit equality: { field: value }
	const param = nextParam(ctx);
	bindings[param] = value;
	return `${f} = $${param}`;
}

/**
 * Check whether a value is an operator object (has keys starting with $).
 */
function isOperatorObject(value: unknown): boolean {
	if (value === null || value === undefined || typeof value !== "object") {
		return false;
	}
	if (Array.isArray(value)) return false;
	if (value instanceof RegExp) return false;
	if (value instanceof Date) return false;

	const keys = Object.keys(value as Record<string, unknown>);
	return keys.length > 0 && keys.every((k) => k.startsWith("$"));
}

/**
 * Translate an operator object for a specific field.
 */
function translateOperators(
	field: string,
	operators: Document,
	ctx: Context,
	bindings: Record<string, unknown>,
): string {
	const parts: string[] = [];

	for (const [op, val] of Object.entries(operators)) {
		switch (op) {
			// Comparison
			case "$eq": {
				const p = nextParam(ctx);
				bindings[p] = val;
				parts.push(`${field} = $${p}`);
				break;
			}
			case "$ne": {
				const p = nextParam(ctx);
				bindings[p] = val;
				parts.push(`${field} != $${p}`);
				break;
			}
			case "$gt": {
				const p = nextParam(ctx);
				bindings[p] = val;
				parts.push(`${field} > $${p}`);
				break;
			}
			case "$gte": {
				const p = nextParam(ctx);
				bindings[p] = val;
				parts.push(`${field} >= $${p}`);
				break;
			}
			case "$lt": {
				const p = nextParam(ctx);
				bindings[p] = val;
				parts.push(`${field} < $${p}`);
				break;
			}
			case "$lte": {
				const p = nextParam(ctx);
				bindings[p] = val;
				parts.push(`${field} <= $${p}`);
				break;
			}

			// Array membership
			case "$in": {
				const p = nextParam(ctx);
				bindings[p] = val;
				parts.push(`${field} IN $${p}`);
				break;
			}
			case "$nin": {
				const p = nextParam(ctx);
				bindings[p] = val;
				parts.push(`${field} NOT IN $${p}`);
				break;
			}

			// Element
			case "$exists": {
				if (val) {
					parts.push(`${field} IS NOT NONE`);
				} else {
					parts.push(`${field} IS NONE`);
				}
				break;
			}

			// Evaluation
			case "$regex": {
				const p = nextParam(ctx);
				bindings[p] = val instanceof RegExp ? val.source : String(val);
				parts.push(`${field} ~ $${p}`);
				break;
			}

			// Negation wrapper
			case "$not": {
				const inner = translateOperators(field, val as Document, ctx, bindings);
				parts.push(`!(${inner})`);
				break;
			}

			default:
				throw new Error(`Unsupported filter operator: ${op}`);
		}
	}

	return parts.join(" AND ");
}
