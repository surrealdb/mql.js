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
	 * The SurrealQL distance expression a `$near`/`$nearSphere` in the filter
	 * orders by, ascending — `geo::distance(field, $p0)`.
	 *
	 * Present only when the filter uses one of those operators. It is an
	 * expression and not an `ORDER BY` because SurrealDB's `ORDER BY` takes a
	 * field path: see `near-query.ts`, which turns it into the projected alias a
	 * statement can order by. An explicit `sort` takes precedence over it, as it
	 * does in MongoDB.
	 */
	nearDistance?: string;
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

/** Top-level operators whose operand is an array of sub-filters. */
const LOGICAL_OPERATORS = ["$and", "$or", "$nor"] as const;

/**
 * True when `filter` uses `$text` anywhere the translator would honour it.
 *
 * Callers use this to decide whether a query needs the collection's full-text
 * field list loaded, which costs a round trip — so an ordinary filter must not
 * pay for it.
 */
export function usesTextSearch(filter?: Document | null): boolean {
	if (!filter || typeof filter !== "object") return false;
	if ("$text" in filter) return true;

	for (const operator of LOGICAL_OPERATORS) {
		const branches = (filter as Document)[operator];
		if (!Array.isArray(branches)) continue;
		if (branches.some((branch) => usesTextSearch(branch as Document))) {
			return true;
		}
	}

	return false;
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
	let nearDistance: string | undefined;
	let nearDepthForbidden = 0;

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
		withoutNearOrder(translate) {
			nearDepthForbidden += 1;
			try {
				return translate();
			} finally {
				nearDepthForbidden -= 1;
			}
		},
		setNearOrder(distanceExpression) {
			if (nearDepthForbidden > 0) {
				throw new MongoInvalidArgumentError(
					"geo $near must be a top-level expression: it cannot appear inside $or, $nor, $not or $elemMatch.",
				);
			}
			// MongoDB allows one distance ordering per query and refuses a second
			// with "Too many geoNear expressions": two orderings cannot both hold,
			// and picking one silently would answer a different query.
			if (nearDistance !== undefined && nearDistance !== distanceExpression) {
				throw new MongoInvalidArgumentError(
					"Too many geoNear expressions: a query can order by distance from one point only.",
				);
			}
			nearDistance = distanceExpression;
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
	if (nearDistance) result.nearDistance = nearDistance;
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
			// Negated, so no branch of it holds for the rows returned — a `$near`
			// inside one could order by nothing.
			const inner = ctx.withoutNearOrder(() =>
				translateLogicalArray(value as Document[], "OR", ctx, registry),
			);
			parts.push(`NOT (${inner})`);
		} else if (key === "$text") {
			parts.push(translateTextSearch(value as Document, ctx));
		} else if (key.startsWith("$")) {
			// Defect fixed: an unrecognised top-level `$operator` used to fall
			// through to the field-condition path, where `{$where: "true"}` became a
			// predicate against a field literally named `$where` — a silently wrong
			// result set rather than an error. Wording mirrors the registry's
			// per-field message in `operator-registry.ts`.
			throw new MongoInvalidArgumentError(
				`Unsupported top-level filter operator: ${key}`,
			);
		} else {
			parts.push(translateFieldCondition(key, value, ctx, registry));
		}
	}

	return parts.join(" AND ");
}

/**
 * Translate `$and`/`$or`'s array of sub-filters.
 *
 * An `$or` of two or more branches is the one shape a `$near` cannot survive, so
 * its branches are translated with the ordering forbidden. A single branch is not
 * a disjunction at all — it flattens to the branch itself, which is why MongoDB
 * accepts `$or: [{loc: {$near: …}}]` and rejects `$or` with a second branch. An
 * `$and` holds for every row returned, so it needs no such restriction.
 */
function translateLogicalArray(
	arr: Document[],
	operator: "AND" | "OR",
	ctx: TranslateContext,
	registry: FilterOperatorRegistry,
): string {
	const disjunction = operator === "OR" && arr.length > 1;
	const translateBranches = () =>
		arr.map((sub) => translateDocument(sub, ctx, registry));

	const parts = disjunction
		? ctx.withoutNearOrder(translateBranches)
		: translateBranches();

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

	// Implicit equality is MongoDB equality, not whole-value equality: it also
	// matches an element of an array field and, for `null`, an absent field.
	return equalityPredicate(f, value, ctx);
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

/**
 * Operators whose value modifies a *sibling* rather than being a predicate of
 * its own, and the operators each one belongs to.
 *
 * MongoDB writes each of these beside the operator it qualifies instead of inside
 * it — `{$regex: "x", $options: "i"}`, `{$nearSphere: [x, y], $maxDistance: r}` —
 * where the qualified operator's own strategy cannot see it. Naming them here is
 * what lets the dispatcher hand both halves over together, and refuse a modifier
 * with nothing to modify, which MongoDB refuses in the same words.
 */
const COMPANION_OPERATORS: Readonly<Record<string, readonly string[]>> = {
	$options: ["$regex"],
	$minDistance: ["$near", "$nearSphere"],
	$maxDistance: ["$near", "$nearSphere"],
};

/** Translate an operator object (`{ $gt: 5, $lt: 10 }`) for one field. */
function translateOperators(
	field: string,
	operators: Document,
	ctx: TranslateContext,
	registry: FilterOperatorRegistry,
): string {
	const parts: string[] = [];

	for (const [op, val] of Object.entries(operators)) {
		const qualifies = COMPANION_OPERATORS[op];
		if (qualifies) {
			if (!qualifies.some((owner) => owner in operators)) {
				throw new MongoInvalidArgumentError(
					`${op} needs a ${qualifies.join(" or ")}`,
				);
			}
			continue;
		}

		parts.push(
			registry.get(op).translate(field, operandFor(op, val, operators), ctx),
		);
	}

	return parts.join(" AND ");
}

/** The operand an operator is translated with, its companions folded in. */
function operandFor(op: string, value: unknown, operators: Document): unknown {
	if (op === "$regex") {
		const operand: RegexOperand = {
			pattern: value as string | RegExp,
			options:
				typeof operators.$options === "string" ? operators.$options : undefined,
		};
		return operand;
	}

	if (op === "$near" || op === "$nearSphere") {
		const operand: NearOperand = {
			spec: value,
			siblingMinDistance: operators.$minDistance,
			siblingMaxDistance: operators.$maxDistance,
		};
		return operand;
	}

	return value;
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
	// The field list is read back from index definitions, so it carries whatever
	// paths the collection's indexes were defined on and needs escaping like any
	// other identifier reaching SQL.
	const clauses = fields.map((field) => `${escapeFieldPath(field)} @@ $${p}`);

	if (clauses.length === 1) return clauses[0];
	return `(${clauses.join(" OR ")})`;
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
import { equalityPredicate } from "./operators/comparison.ts";
import type { RegexOperand } from "./operators/evaluation.ts";
import type { NearOperand } from "./operators/geospatial.ts";

export type { TranslateContext } from "./translate-context.ts";
