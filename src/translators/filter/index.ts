/**
 * Translates a MongoDB query filter document into a SurrealQL WHERE clause
 * with parameterised bindings.
 *
 * Example:
 *   { name: "John", age: { $gt: 25 } }
 *   →  { clause: "name = $p0 AND age > $p1", bindings: { p0: "John", p1: 25 } }
 *
 * The walker dispatches every per-field operator through a registry of
 * `FilterOperator` strategies; SurrealDB-version differences live in the
 * `SurrealDialect` strategy attached to the context.
 */

import type { Document } from "../../types.ts";
import { resolveDialect, type SurrealDialect } from "../dialect/index.ts";
import { DEFAULT_FILTER_REGISTRY } from "./default-registry.ts";
import type { FilterOperatorRegistry } from "./operator-registry.ts";
import type { TranslateContext } from "./translate-context.ts";

export interface TranslatedFilter {
	/** SurrealQL expression to be used after WHERE (empty string when no filter). */
	clause: string;
	/** Parameterised bindings for the clause. */
	bindings: Record<string, unknown>;
	/**
	 * Optional ORDER BY clause implied by $near / $nearSphere.
	 * When set, results should be sorted by distance ascending
	 * (unless an explicit sort is provided).
	 */
	nearSort?: string;
}

/** Options for `translateFilter`. */
export interface TranslateFilterOptions {
	/** Fields that have a FULLTEXT index, used for $text queries. */
	textFields?: string[];
	/**
	 * Target SurrealDB server version (e.g. "3.0.4"). Controls SurrealQL
	 * dialect choices such as `type::is::*` (v2) vs `type::is_*` (v3) and
	 * `~` (v2) vs `string::matches()` (v3) for regex matches. Defaults to
	 * the latest known dialect when omitted.
	 */
	surrealVersion?: string;
	/**
	 * Pre-resolved dialect strategy. When supplied, takes precedence over
	 * `surrealVersion`; lets callers (e.g. `Collection`) resolve the
	 * dialect once at connect-time and pass it through every translation.
	 */
	dialect?: SurrealDialect;
	/**
	 * Override the operator registry (advanced – typically left to default).
	 */
	registry?: FilterOperatorRegistry;
	/**
	 * Collection (table) the filter runs against.
	 *
	 * Required to translate `_id`: SurrealDB identities are `RecordId`s, which
	 * are scoped to a table, so `{_id: "abc"}` can only become `id = users:abc`
	 * if the table is known. Without it an `_id` condition is left alone and
	 * cannot match, so every caller inside the driver supplies it.
	 */
	collection?: string;
}

/**
 * Translate a MongoDB filter document to a SurrealQL WHERE clause.
 * Returns an empty clause when the filter is empty or undefined.
 */
export function translateFilter(
	filter?: Document | null,
	options?: TranslateFilterOptions,
): TranslatedFilter {
	if (!filter || Object.keys(filter).length === 0) {
		return { clause: "", bindings: {} };
	}

	const registry = options?.registry ?? DEFAULT_FILTER_REGISTRY;
	const dialect = options?.dialect ?? resolveDialect(options?.surrealVersion);

	const bindings: Record<string, unknown> = {};
	let counter = 0;
	let nearSort: string | undefined;

	const ctx: TranslateContext = {
		dialect,
		textFields: options?.textFields,
		collection: options?.collection,
		bindings,
		nextParam: () => `p${counter++}`,
		bind(value) {
			const name = ctx.nextParam();
			bindings[name] = value;
			return name;
		},
		setNearSort(orderBy) {
			nearSort = orderBy;
		},
		translateOperators(field, ops) {
			return translateOperators(field, ops, ctx, registry);
		},
		translateFieldCondition(field, value) {
			return translateFieldCondition(field, value, ctx, registry);
		},
	};

	const clause = translateDocument(filter, ctx, registry);

	const result: TranslatedFilter = { clause, bindings };
	if (nearSort) result.nearSort = nearSort;
	return result;
}

// ---------------------------------------------------------------------------
// Internal walkers
// ---------------------------------------------------------------------------

/**
 * Translate a top-level filter document. Each key is either a field name
 * or a top-level logical operator ($and, $or, $nor, $text).
 */
function translateDocument(
	doc: Document,
	ctx: TranslateContext,
	registry: FilterOperatorRegistry,
): string {
	const parts: string[] = [];

	for (const [key, value] of Object.entries(doc)) {
		if (key === "$and") {
			parts.push(
				translateLogicalArray(value as Document[], "AND", ctx, registry),
			);
		} else if (key === "$or") {
			parts.push(
				translateLogicalArray(value as Document[], "OR", ctx, registry),
			);
		} else if (key === "$nor") {
			const inner = translateLogicalArray(
				value as Document[],
				"OR",
				ctx,
				registry,
			);
			parts.push(`NOT (${inner})`);
		} else if (key === "$text") {
			parts.push(translateTextSearch(value as Document, ctx));
		} else {
			parts.push(translateFieldCondition(key, value, ctx, registry));
		}
	}

	return parts.join(" AND ");
}

function translateLogicalArray(
	arr: Document[],
	operator: "AND" | "OR",
	ctx: TranslateContext,
	registry: FilterOperatorRegistry,
): string {
	const parts = arr.map((sub) => translateDocument(sub, ctx, registry));
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
	ctx: TranslateContext,
	registry: FilterOperatorRegistry,
): string {
	let f = escapeFieldPath(field);

	// `_id` lives in SurrealDB's `id` column as a RecordId; rewrite the field
	// and coerce the compared values so the comparison can actually be true.
	if (isIdField(field) && ctx.collection) {
		f = SURREAL_ID_FIELD;
		value = coerceIdCondition(ctx.collection, value);
	}

	if (value instanceof RegExp) {
		return registry.get("$regex").translate(f, value, ctx);
	}

	if (isOperatorObject(value)) {
		return translateOperators(f, value as Document, ctx, registry);
	}

	const p = ctx.bind(value);
	return `${f} = $${p}`;
}

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

/** Translate an operator object (`{ $gt: 5, $lt: 10 }`) for one field. */
function translateOperators(
	field: string,
	operators: Document,
	ctx: TranslateContext,
	registry: FilterOperatorRegistry,
): string {
	const parts: string[] = [];
	for (const [op, val] of Object.entries(operators)) {
		parts.push(registry.get(op).translate(field, val, ctx));
	}
	return parts.join(" AND ");
}

/**
 * `$text: { $search: ... }` – uses the field list registered via
 * `Collection.createIndex({ field: "text" })`.
 */
function translateTextSearch(textOp: Document, ctx: TranslateContext): string {
	const search = textOp.$search as string;
	if (typeof search !== "string") {
		throw new MongoInvalidArgumentError("$text requires a $search string");
	}

	const fields = ctx.textFields;
	if (!fields || fields.length === 0) {
		throw new MongoInvalidArgumentError(
			"$text query requires a text index. Call createIndex() with a 'text' field first.",
		);
	}

	const p = ctx.bind(search);

	if (fields.length === 1) return `${fields[0]} @@ $${p}`;
	const fieldClauses = fields.map((f) => `${f} @@ $${p}`);
	return `(${fieldClauses.join(" OR ")})`;
}

export { DEFAULT_FILTER_REGISTRY } from "./default-registry.ts";
// Re-export the registry/operator types so consumers can build custom registries.
export {
	type FilterOperator,
	FilterOperatorRegistry,
} from "./operator-registry.ts";

import { MongoInvalidArgumentError } from "../../errors.ts";
import { escapeFieldPath } from "../../surreal/sql/escape.ts";
import { coerceIdCondition, isIdField, SURREAL_ID_FIELD } from "./id-field.ts";

export type { TranslateContext } from "./translate-context.ts";
