/**
 * MongoDB positional array operators in field paths.
 *
 *   `grades.$[]`             every element of `grades`
 *   `grades.$[elem].score`   the `score` of each element `arrayFilters` selects
 *
 * ## Why an update through one is a rewrite of the array
 *
 * The obvious spelling is SurrealQL's own path syntax, `grades[*].score` and
 * `grades[WHERE …].score`, and it is right for an operator whose value does not
 * depend on what is there: `$set` assigns the same value to every element it
 * names. It is wrong for every operator that *reads* the field it writes —
 * `$inc`, `$mul`, `$min`, `$max`, `$push`, `$addToSet`, `$pop`, `$pull` and
 * `$pullAll` — because `grades[*].score` evaluates to the **list** of every
 * element's `score`, and `score += 1` on a list appends. `{$inc: {"v.$[].n": 1}}`
 * over `[{n: 0}, {n: 5}]` wrote `[{n: [0, 5, 1]}, {n: [0, 5, 1]}]`, and `$mul`
 * failed outright with "Cannot perform multiplication with 'array' and 'int'".
 *
 * What an element's new value depends on is that element's own old one, and a
 * path expression has no way to say so. So the array is rewritten instead, one
 * element at a time:
 *
 *     grades = IF type::is_array(grades) THEN array::map(grades, |$e|
 *       IF <the element is selected> THEN object::extend($e, {score: …$e.score…}) ELSE $e END
 *     ) ELSE grades END
 *
 * ## Why every positional update to one array is folded into one rewrite
 *
 * Every assignment in one `SET` is evaluated against the document **as it was
 * before the statement**, so two assignments that each rewrite `grades` do not
 * compose: the second reads the original array, and the first is lost. An update
 * naming two fields of the same elements — `{$inc: {"items.$[i].qty": 1},
 * $set: {"items.$[i].touched": true}}` is an everyday one — must therefore be
 * one assignment. This is also what makes a `$set` through a positional path
 * safe beside an `$inc` through it, so `$set`, `$unset` and `$currentDate` are
 * folded too, even though the path form would do for them alone.
 *
 * Within one rewrite every leaf is computed from the element as it was before
 * the update, as MongoDB computes it: `{$inc: {"v.$[e].n": 1, "v.$[e].m": 1}}`
 * with a filter on `e.n` selects the same elements for both. Different
 * identifiers on one array (`$[a]` and `$[b]`, or `$[]` and `$[e]`) are applied
 * one after the other, in the order they first appear, so a filter sees the
 * array as the identifier before it left it; they agree with MongoDB unless one
 * identifier's filter reads a field another identifier changes.
 *
 * ## Where it differs from MongoDB
 *
 * An array that does not exist is left alone, where MongoDB refuses ("The path
 * 'v' must exist in the document in order to apply array updates"). Two paths
 * that overlap (`v.$[].a` and `v.$[].a.b`) are refused as MongoDB refuses them.
 * An element that is not a document, selected by a path that goes inside it
 * (`v.$[].n` over `[1, 2]`), raises as MongoDB's does; the wording differs. An
 * array index after a marker (`v.$[].c.0`), `$rename` through a marker, and an
 * `arrayFilters` entry that names the element itself (`{"e": {$gte: 90}}`) are
 * refused.
 */

import {
	MongoCompatibilityError,
	MongoInvalidArgumentError,
} from "../../errors.ts";
import { escapeFieldPath, escapeIdentifier } from "../../surreal/sql/escape.ts";
import { arrayTypeCheckFn } from "../filter/operators/comparison.ts";
import { isRangeOperator, rangePredicate } from "../filter/operators/range.ts";
import type { UpdateContext } from "./update-context.ts";

/**
 * What an operator does to the value at a positional path: remove it, or
 * replace it with the SurrealQL `value(current)` builds, given the SurrealQL
 * that reads the value as it is now.
 */
export type PositionalUpdate =
	| { readonly remove: true }
	| { readonly value: (current: string) => string };

/** `$unset`: remove the field. */
export const REMOVE: PositionalUpdate = { remove: true };

// ---------------------------------------------------------------------------
// arrayFilters
// ---------------------------------------------------------------------------

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

function isOperatorObject(value: unknown): boolean {
	if (value === null || value === undefined || typeof value !== "object") {
		return false;
	}
	if (Array.isArray(value)) return false;
	const keys = Object.keys(value as Record<string, unknown>);
	return keys.length > 0 && keys.every((k) => k.startsWith("$"));
}

/**
 * One `arrayFilters` entry as conditions on `item`, the element being tested.
 *
 * The rewrite tests each element in a closure, and a bare field name in a
 * closure reads the *document*, so every condition addresses its field through
 * the element: `$__mql_item0.score`.
 */
function translateArrayFilterEntry(
	subField: string,
	value: unknown,
	item: string,
	ctx: UpdateContext,
	conditions: string[],
): void {
	// The sub-field comes from a caller-supplied arrayFilters key, so it is an
	// untrusted identifier and must be escaped like any other field path.
	const target = `${item}.${escapeFieldPath(subField)}`;

	if (isOperatorObject(value)) {
		for (const [op, opVal] of Object.entries(
			value as Record<string, unknown>,
		)) {
			// The ordering operators are the type-bracketed comparison the filter
			// translator builds for a field, array-valued ones included: an
			// arrayFilters entry is a query on each element, so `{"e.score":
			// {$gte: 90}}` matches an element whose `score` is `[95, 10]`, and not
			// one whose `score` is the string "90" or is missing. The leading range
			// is for a table scan's planner, which a closure over an array is not.
			if (isRangeOperator(op)) {
				conditions.push(
					rangePredicate(target, op, opVal, ctx, { leadingRange: false }),
				);
				continue;
			}

			const sqlOp = COMPARISON_OPS[op];
			if (!sqlOp)
				throw new MongoInvalidArgumentError(
					`Unsupported operator in arrayFilter: ${op}`,
				);
			const p = ctx.bind(opVal);
			conditions.push(`${target} ${sqlOp} $${p}`);
		}
	} else {
		const p = ctx.bind(value);
		conditions.push(`${target} = $${p}`);
	}
}

function resolveArrayFilter(
	identifier: string,
	item: string,
	ctx: UpdateContext,
): string {
	if (!ctx.arrayFilters || ctx.arrayFilters.length === 0) {
		throw new MongoInvalidArgumentError(
			`Positional operator $[${identifier}] requires arrayFilters`,
		);
	}

	const prefix = `${identifier}.`;
	const filter = ctx.arrayFilters.find((f) =>
		Object.keys(f).some((k) => k.startsWith(prefix)),
	);

	if (!filter) {
		throw new MongoInvalidArgumentError(
			`No arrayFilter found for identifier "${identifier}"`,
		);
	}

	const conditions: string[] = [];
	for (const [key, value] of Object.entries(filter)) {
		if (!key.startsWith(prefix)) continue;
		translateArrayFilterEntry(
			key.slice(prefix.length),
			value,
			item,
			ctx,
			conditions,
		);
	}

	return conditions.join(" AND ");
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Matches a positional marker segment: `.$[]` or `.$[identifier]`. */
const POSITIONAL_SEGMENT_RE = /(\.\$\[\w*\])/;

/** One whole marker segment, capturing its identifier. */
const MARKER_RE = /^\.\$\[(\w*)\]$/;

/** The single positional operator `$`, which this driver does not support. */
const SINGLE_POSITIONAL_RE = /(?:^|\.)\$(?:\.|$)/;

/** A path segment that is an array index. */
const ARRAY_INDEX_RE = /^\d+$/;

interface Level {
	/** The identifier inside `$[…]`, or `""` for `$[]`. */
	readonly identifier: string;
	/** The plain segments between this marker and the next, or the path's end. */
	readonly after: string[];
}

interface PositionalPath {
	/** The path of the outermost array, ahead of the first marker. */
	readonly base: string;
	readonly levels: Level[];
}

/** Add the plain segments of `path` below `level`, refusing an array index. */
function appendSegments(level: Level, path: string, field: string): void {
	for (const segment of path.split(".")) {
		if (ARRAY_INDEX_RE.test(segment)) {
			throw new MongoCompatibilityError(
				`An array index after a positional operator is not supported in "${field}": the element's own array cannot be addressed by position inside a rewrite of its parent.`,
			);
		}
		level.after.push(segment);
	}
}

/**
 * Split a field path at its positional markers, or `undefined` when it has none.
 *
 * `v.$[a].w.$[b].n` is the array `v`, then the elements `a` selects and, inside
 * each, the field `w`, which is an array whose elements `b` selects, and then
 * `n` in each of those.
 */
function parsePositional(field: string): PositionalPath | undefined {
	if (SINGLE_POSITIONAL_RE.test(field)) {
		throw new MongoInvalidArgumentError(
			`The positional operator '$' is not supported in "${field}". Use the all-positional '$[]' or a filtered '$[identifier]' with arrayFilters instead.`,
		);
	}

	if (!POSITIONAL_SEGMENT_RE.test(field)) return undefined;

	let base = "";
	const levels: Level[] = [];

	for (const chunk of field.split(POSITIONAL_SEGMENT_RE)) {
		if (chunk === "") continue;

		const marker = MARKER_RE.exec(chunk);
		if (marker) {
			levels.push({ identifier: marker[1] ?? "", after: [] });
			continue;
		}

		// A chunk following a marker keeps its leading dot from the original path;
		// the dot is structure, not part of the identifier.
		const path = chunk.startsWith(".") ? chunk.slice(1) : chunk;
		const level = levels[levels.length - 1];
		if (!level) {
			base = path;
			continue;
		}

		appendSegments(level, path, field);
	}

	return { base, levels };
}

/**
 * True when `field` contains a positional marker, `$[]` or `$[identifier]`.
 *
 * For an operator that has to refuse one, as `$rename` does.
 */
export function isPositionalPath(field: string): boolean {
	return POSITIONAL_SEGMENT_RE.test(field);
}

/**
 * Escape a path that has no positional marker.
 *
 * A positional path is not a path at all, as far as SurrealQL is concerned — see
 * the top of the file — so one arriving here belongs to an operator that does
 * not know what to do with it, and is refused rather than turned into a path
 * expression that would silently do something else.
 */
export function resolveField(field: string, _ctx: UpdateContext): string {
	if (parsePositional(field)) {
		throw new MongoInvalidArgumentError(
			`The positional path "${field}" cannot be used with this update operator`,
		);
	}
	return escapeFieldPath(field);
}

// ---------------------------------------------------------------------------
// What the updates to one array add up to
// ---------------------------------------------------------------------------

/** One node of the tree of paths below an array's elements. */
interface Node {
	/** What happens to the value at this path, when something does. */
	leaf?: PositionalUpdate;
	/** Set when this path is itself an array, some of whose elements are updated. */
	array?: ArrayLevel;
	readonly children: Map<string, Node>;
	/** The first field that reached this node, for a conflict message. */
	readonly via: string;
}

/** The identifiers that address one array, in the order they first appeared. */
interface ArrayLevel {
	readonly selectors: Selector[];
}

interface Selector {
	readonly identifier: string;
	/** The node standing for each selected element. */
	readonly element: Node;
}

function newNode(via: string): Node {
	return { children: new Map(), via };
}

function conflict(field: string, existing: string): Error {
	return new MongoInvalidArgumentError(
		`Updating the path '${field}' would create a conflict at '${existing}'`,
	);
}

function insert(
	level: ArrayLevel,
	levels: Level[],
	index: number,
	field: string,
	update: PositionalUpdate,
): void {
	const { identifier, after } = levels[index] as Level;

	let selector = level.selectors.find((s) => s.identifier === identifier);
	if (!selector) {
		selector = { identifier, element: newNode(field) };
		level.selectors.push(selector);
	}

	let node = selector.element;
	for (const segment of after) {
		if (node.leaf || node.array) throw conflict(field, node.via);
		let child = node.children.get(segment);
		if (!child) {
			child = newNode(field);
			node.children.set(segment, child);
		}
		node = child;
	}

	if (index + 1 < levels.length) {
		if (node.leaf || node.children.size > 0) throw conflict(field, node.via);
		node.array ??= { selectors: [] };
		insert(node.array, levels, index + 1, field, update);
		return;
	}

	if (node.leaf || node.array || node.children.size > 0) {
		throw conflict(field, node.via);
	}
	node.leaf = update;
}

/** True when everything below `node` only removes fields. */
function removesOnly(node: Node): boolean {
	if (node.array) return false;
	if (node.leaf) return "remove" in node.leaf;
	return [...node.children.values()].every(removesOnly);
}

// ---------------------------------------------------------------------------
// Compiling them
// ---------------------------------------------------------------------------

function compileLevel(
	level: ArrayLevel,
	array: string,
	depth: number,
	ctx: UpdateContext,
): string {
	let current = array;
	for (const selector of level.selectors) {
		const item = `$__mql_item${depth}`;
		current = `array::map(${current}, |${item}| ${compileSelector(selector, item, depth, ctx)})`;
	}
	return current;
}

function compileSelector(
	selector: Selector,
	item: string,
	depth: number,
	ctx: UpdateContext,
): string {
	const update = compileElement(selector.element, item, depth, ctx);
	if (selector.identifier === "") return update;

	const conditions = resolveArrayFilter(selector.identifier, item, ctx);
	return `IF ${conditions} THEN ${update} ELSE ${item} END`;
}

/** The new value of one selected element. */
function compileElement(
	node: Node,
	item: string,
	depth: number,
	ctx: UpdateContext,
): string {
	// The update is to the element itself, as in `v.$[]`: a removed element is
	// null, which is what MongoDB leaves in its place.
	if (node.leaf) {
		return "remove" in node.leaf ? "NULL" : node.leaf.value(item);
	}

	// A path that goes inside the element needs it to be a document. MongoDB
	// raises for one that is not, and so does this, rather than leaving it be.
	const message = ctx.bind(
		`Cannot create a field in an array element that is not a document, for the path '${node.via}'`,
	);
	const isObject = ctx.dialect.typeCheckFn("object") ?? "type::is_object";
	return `IF ${isObject}(${item}) THEN ${compileObject(node, item, item, depth, ctx)} ELSE { THROW $${message} } END`;
}

/**
 * The document `node` makes of `base`, reading its fields from `read`.
 *
 * `read` is the value as it was before the update, and `base` is what the
 * update's fields are laid over: the same thing for an element, and the field
 * or an empty document for one inside it that may not exist. Every value is
 * computed from `read`, so an update to one field never sees another's.
 *
 * A field that might be absent — an array, or a branch that only removes —
 * cannot go into the object being built, where an absent value would become a
 * null; it is added only when it is there.
 */
function compileObject(
	node: Node,
	read: string,
	base: string,
	depth: number,
	ctx: UpdateContext,
): string {
	const isArray = arrayTypeCheckFn(ctx);
	const isObject = ctx.dialect.typeCheckFn("object") ?? "type::is_object";

	const sets: string[] = [];
	const removals: string[] = [];
	const conditional: {
		key: string;
		read: string;
		value: string;
		guard: string;
	}[] = [];

	for (const [segment, child] of node.children) {
		const key = escapeIdentifier(segment);
		const childRead = `${read}.${key}`;

		if (child.leaf) {
			if ("remove" in child.leaf) removals.push(`$${ctx.bind(segment)}`);
			else sets.push(`${key}: ${child.leaf.value(childRead)}`);
		} else if (child.array) {
			conditional.push({
				key,
				read: childRead,
				guard: `${isArray}(${childRead})`,
				value: compileLevel(child.array, childRead, depth + 1, ctx),
			});
		} else if (removesOnly(child)) {
			conditional.push({
				key,
				read: childRead,
				guard: `${isObject}(${childRead})`,
				value: compileObject(child, childRead, childRead, depth, ctx),
			});
		} else {
			const nested = `IF ${childRead} IS NONE THEN {} ELSE ${childRead} END`;
			sets.push(
				`${key}: ${compileObject(child, childRead, nested, depth, ctx)}`,
			);
		}
	}

	let expression = base;
	if (sets.length > 0) {
		expression = `object::extend(${expression}, {${sets.join(", ")}})`;
	}
	for (const { key, guard, value } of conditional) {
		expression = `IF ${guard} THEN object::extend(${expression}, {${key}: ${value}}) ELSE ${expression} END`;
	}
	if (removals.length > 0) {
		expression = `object::remove(${expression}, [${removals.join(", ")}])`;
	}
	return expression;
}

/**
 * The positional updates an `UpdateContext` has been asked for, which become
 * one `SET` fragment per array they name once every operator has had its say.
 */
export class PositionalUpdates {
	private readonly arrays = new Map<string, ArrayLevel>();

	/**
	 * Record `update` for `field`. Returns `false`, recording nothing, when
	 * `field` has no positional marker, so the caller can treat it as a plain path.
	 */
	add(field: string, update: PositionalUpdate): boolean {
		const path = parsePositional(field);
		if (!path) return false;

		let level = this.arrays.get(path.base);
		if (!level) {
			level = { selectors: [] };
			this.arrays.set(path.base, level);
		}
		insert(level, path.levels, 0, field, update);
		return true;
	}

	/**
	 * Push the `SET` fragments the recorded updates add up to.
	 *
	 * The assignment guards on the array being one: an absent array is assigned
	 * to itself, which leaves it absent, where a rewrite of it would fail.
	 */
	emit(ctx: UpdateContext): void {
		const isArray = arrayTypeCheckFn(ctx);
		for (const [base, level] of this.arrays) {
			const array = escapeFieldPath(base);
			ctx.parts.push(
				`${array} = IF ${isArray}(${array}) THEN ${compileLevel(level, array, 0, ctx)} ELSE ${array} END`,
			);
		}
	}
}
