/**
 * Translating a MongoDB aggregation pipeline into SurrealQL.
 *
 * The pipeline is folded into as few `SELECT`s as its stages allow — see
 * `builder.ts` for which stage orders can share a statement and why. Everything
 * this driver cannot serve raises `MongoCompatibilityError` naming the stage or
 * operator, rather than being skipped: a pipeline whose later stages were
 * dropped still returns documents, and the caller would get a plausible wrong
 * answer instead of an error. That is the same reason the whole feature refused
 * until now, and it does not stop applying because part of it works.
 *
 * The stages that are served:
 *
 *   `$match` `$sort` `$limit` `$skip` `$count` `$project` `$group` `$unwind`
 *
 * `$lookup`, `$facet`, `$bucket`, `$graphLookup`, `$unionWith`, `$out`,
 * `$merge`, `$setWindowFields` and the rest are refused.
 */

import { MongoCompatibilityError } from "../../errors.ts";
import type { Document, Sort } from "../../types.ts";
import type { SurrealDialect } from "../dialect/index.ts";
import { translateFilter } from "../filter/index.ts";
import { translateSort } from "../sort.ts";
import { compileAccumulator } from "./accumulators.ts";
import { SelectBuilder, Slot } from "./builder.ts";
import { compileExpression, fieldPath } from "./expression.ts";

/** What the pipeline translator needs from the collection it runs against. */
export interface TranslatePipelineOptions {
	/** The escaped table name the pipeline reads from. */
	readonly table: string;
	/** The unescaped collection name, for `_id` record ids in a `$match`. */
	readonly collection: string;
	/** Resolved SurrealQL dialect. */
	readonly dialect?: SurrealDialect;
	/** Fields carrying a full-text index, for `$text` inside a `$match`. */
	readonly textFields?: string[];
}

/** A translated pipeline: one statement and everything it binds. */
export interface TranslatedPipeline {
	readonly sql: string;
	readonly bindings: Record<string, unknown>;
}

/**
 * The alias a `$group` key is projected under.
 *
 * MongoDB names it `_id`, and so does the output, so this is not a rename —
 * it is the column the `GROUP BY` names. Grouping by the alias rather than by
 * the key expression is what makes one idiom cover all three shapes MongoDB
 * allows: a scalar key, a compound object key, and `null`.
 */
const GROUP_KEY = "_id";

export function translatePipeline(
	pipeline: readonly Document[],
	options: TranslatePipelineOptions,
): TranslatedPipeline {
	if (!Array.isArray(pipeline)) {
		throw new MongoCompatibilityError(
			"An aggregation pipeline must be an array of stages.",
		);
	}

	const bindings: Record<string, unknown> = {};
	let counter = 0;
	const bind = (value: unknown): string => {
		const name = `a${counter++}`;
		bindings[name] = value;
		return name;
	};

	const builder = new SelectBuilder(options.table);

	for (const [index, stage] of pipeline.entries()) {
		applyStage(stage, index, builder, bind, options, bindings);
	}

	return { sql: builder.render(), bindings };
}

function applyStage(
	stage: Document,
	index: number,
	builder: SelectBuilder,
	bind: (value: unknown) => string,
	options: TranslatePipelineOptions,
	bindings: Record<string, unknown>,
): void {
	if (typeof stage !== "object" || stage === null || Array.isArray(stage)) {
		throw new MongoCompatibilityError(
			`Stage ${index} of the pipeline is not a stage document.`,
		);
	}

	const names = Object.keys(stage);
	if (names.length !== 1) {
		throw new MongoCompatibilityError(
			`Stage ${index} of the pipeline must have exactly one field naming the stage, and has ${names.length}.`,
		);
	}

	const name = names[0];
	const spec = stage[name];

	switch (name) {
		case "$match":
			applyMatch(spec, index, builder, options, bindings);
			return;
		case "$sort":
			applySort(spec, builder);
			return;
		case "$limit":
			applyLimit(spec, builder);
			return;
		case "$skip":
			applySkip(spec, builder);
			return;
		case "$count":
			applyCount(spec, builder);
			return;
		case "$project":
			applyProject(spec, builder, bind);
			return;
		case "$group":
			applyGroup(spec, builder, bind);
			return;
		case "$unwind":
			applyUnwind(spec, builder);
			return;
		default:
			throw new MongoCompatibilityError(
				`The aggregation stage ${name} is not implemented by @surrealdb/mql. Translating it partially would answer with documents that ignored it, so it is refused instead. $match, $sort, $limit, $skip, $count, $project, $group and $unwind are supported.`,
			);
	}
}

/**
 * `$match` — a `WHERE`, translated by the same code a `find()` filter is.
 *
 * The parameter prefix is per-stage: two `$match` stages in one pipeline would
 * otherwise both bind `$p0`, and the second would overwrite the first while both
 * clauses still read `$p0`.
 */
function applyMatch(
	spec: unknown,
	index: number,
	builder: SelectBuilder,
	options: TranslatePipelineOptions,
	bindings: Record<string, unknown>,
): void {
	const {
		clause,
		bindings: filterBindings,
		nearDistance,
	} = translateFilter(spec as Document, {
		// Omitted once a stage has reshaped the documents, which is the existing
		// switch for "`_id` is not the record identity here": the filter only
		// rewrites `_id` to `id` and coerces the compared value to a `RecordId`
		// when it knows the table. Grouped rows have a literal `_id` and no `id`,
		// so the rewrite would compare a column that is not there.
		collection: builder.identityIsPlainField ? undefined : options.collection,
		dialect: options.dialect,
		textFields: options.textFields,
		paramPrefix: `m${index}p`,
	});

	if (nearDistance) {
		throw new MongoCompatibilityError(
			"$near and $nearSphere are not supported inside an aggregation $match: they order the whole result set as well as filtering it, and that ordering cannot be expressed where a pipeline stage sits. Use find() with the same filter, or $geoWithin here.",
		);
	}

	if (!clause) return;

	Object.assign(bindings, filterBindings);
	builder.claim(Slot.Where);
	builder.setWhere(clause);
}

/** `$sort` — an `ORDER BY`, translated as a `find()` sort is. */
function applySort(spec: unknown, builder: SelectBuilder): void {
	const clause = translateSort(spec as Sort, {
		identityIsPlainField: builder.identityIsPlainField,
	});
	if (!clause) return;

	builder.claim(Slot.Order);
	builder.setOrderBy(clause);
}

function applyLimit(spec: unknown, builder: SelectBuilder): void {
	builder.claim(Slot.Limit);
	builder.setLimit(wholeNumber("$limit", spec));
}

function applySkip(spec: unknown, builder: SelectBuilder): void {
	builder.claim(Slot.Start);
	builder.setStart(wholeNumber("$skip", spec));
}

/**
 * `$count` — the document count under a caller-named field.
 *
 * `{$count: "n"}` is `{$group: {_id: null, n: {$sum: 1}}}` followed by
 * `{$project: {_id: 0}}`, and is emitted as the grouping directly. The `_id` the
 * grouping needs is not selected, so it never reaches the caller — which is what
 * `$count` promises: one document of one field.
 */
function applyCount(spec: unknown, builder: SelectBuilder): void {
	if (typeof spec !== "string" || spec.length === 0) {
		throw new MongoCompatibilityError(
			"$count takes a non-empty string naming the output field.",
		);
	}
	if (spec.startsWith("$") || spec.includes(".")) {
		throw new MongoCompatibilityError(
			`$count's output field cannot ${spec.startsWith("$") ? "start with $" : "contain a dot"}, as MongoDB requires.`,
		);
	}

	builder.claim(Slot.Group, { needsNoSplit: true });
	builder.setGroup(`GROUP BY ${escapeAlias(GROUP_KEY)}`);
	builder.setFields(
		`NULL AS ${escapeAlias(GROUP_KEY)}, count() AS ${escapeAlias(spec)}`,
	);
	// The grouping key has to be selected for `GROUP BY` to name it, and must not
	// be returned. An enclosing statement drops it.
	builder.claim(Slot.Fields);
	builder.setFields(`* OMIT ${escapeAlias(GROUP_KEY)}`);
}

/**
 * `$project` — the field list.
 *
 * Only the inclusion form and computed fields are served. An exclusion
 * projection (`{a: 0}`) is refused: SurrealDB's `OMIT` would express it, but
 * MongoDB forbids mixing inclusions and exclusions in one `$project` except for
 * `_id`, and serving half the form invites the other half to look supported.
 */
function applyProject(
	spec: unknown,
	builder: SelectBuilder,
	bind: (value: unknown) => string,
): void {
	if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
		throw new MongoCompatibilityError(
			"$project takes a specification document.",
		);
	}

	const entries = Object.entries(spec as Document);
	if (entries.length === 0) {
		throw new MongoCompatibilityError(
			"$project takes at least one field; an empty specification is rejected by MongoDB too.",
		);
	}

	const plainId = builder.identityIsPlainField;
	const fields: string[] = [];
	let includeId = true;
	let sawInclusion = false;

	for (const [key, value] of entries) {
		if (key === "_id" && isExcluded(value)) {
			includeId = false;
			continue;
		}

		if (isExcluded(value)) {
			throw new MongoCompatibilityError(
				`$project cannot exclude ${key}: only _id may be excluded, and mixing exclusions with inclusions is rejected by MongoDB. Use an inclusion projection listing the fields you want.`,
			);
		}

		sawInclusion = true;

		if (value === 1 || value === true) {
			fields.push(`${fieldPath(key, plainId)} AS ${escapeAlias(key)}`);
			continue;
		}

		fields.push(
			`${compileExpression(value, bind, plainId)} AS ${escapeAlias(key)}`,
		);
	}

	if (!sawInclusion) {
		// `{$project: {_id: 0}}` alone: everything but the identity.
		builder.claim(Slot.Fields);
		builder.setFields(`* OMIT ${escapeAlias("_id")}`);
		return;
	}

	// `_id` rides along unless suppressed, as it does in MongoDB.
	if (includeId) {
		fields.unshift(`${fieldPath("_id", plainId)} AS ${escapeAlias("_id")}`);
	}

	builder.claim(Slot.Fields);
	builder.setFields(fields.join(", "));
}

/**
 * `$group` — a `GROUP BY` over the key aliased to `_id`.
 *
 * Always `GROUP BY _id`, never `GROUP ALL` and never `GROUP BY <key expression>`.
 * One idiom then covers every shape MongoDB allows, and it is the shape that
 * measured correct: `SELECT NULL AS _id … GROUP ALL` returns `_id` as an array
 * of one null *per row* rather than a single collapsed group, which is a wrong
 * answer of exactly the kind that is hard to notice.
 */
function applyGroup(
	spec: unknown,
	builder: SelectBuilder,
	bind: (value: unknown) => string,
): void {
	if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
		throw new MongoCompatibilityError("$group takes a specification document.");
	}

	const { _id, ...accumulators } = spec as Document;
	if (_id === undefined) {
		throw new MongoCompatibilityError(
			"$group requires an _id field naming what to group by; use null to group everything into one document.",
		);
	}

	const plainId = builder.identityIsPlainField;
	const fields = [
		`${compileExpression(_id, bind, plainId)} AS ${escapeAlias(GROUP_KEY)}`,
	];
	for (const [field, accumulator] of Object.entries(accumulators)) {
		fields.push(
			`${compileAccumulator(field, accumulator, bind, plainId)} AS ${escapeAlias(field)}`,
		);
	}

	builder.claim(Slot.Group, { needsNoSplit: true });
	builder.setGroup(`GROUP BY ${escapeAlias(GROUP_KEY)}`);
	builder.setFields(fields.join(", "));
}

/**
 * `$unwind` — a `SPLIT`, with the rows MongoDB drops filtered out first.
 *
 * `SPLIT` alone is not `$unwind`. Measured against a live server, `SPLIT tags`
 * emits a row for a document whose `tags` is `[]` and a row for one that has no
 * `tags` at all, where MongoDB emits neither. A scalar it emits unchanged, which
 * MongoDB does too — a non-array is unwound as if it were an array of one.
 *
 * So the guard keeps exactly what MongoDB keeps: a non-empty array, or any
 * present non-array value. `preserveNullAndEmptyArrays` drops the guard, which
 * is what that option asks for.
 */
function applyUnwind(spec: unknown, builder: SelectBuilder): void {
	const { path, preserve } = unwindSpec(spec);

	const field = fieldPath(path, builder.identityIsPlainField);
	if (!preserve) {
		const kept = `((${field}.is_array() AND ${field}.len() > 0) OR (!${field}.is_array() AND ${field} != NONE AND ${field} != NULL))`;
		builder.claim(Slot.Where);
		builder.setWhere(kept);
	}

	builder.claim(Slot.Split, { needsNoGroup: true });
	builder.setSplit(field);
}

/** The two spellings of `$unwind`: a path string, or a specification document. */
function unwindSpec(spec: unknown): { path: string; preserve: boolean } {
	if (typeof spec === "string") {
		return { path: unwindPath(spec), preserve: false };
	}

	if (typeof spec === "object" && spec !== null && !Array.isArray(spec)) {
		const document = spec as Document;
		if (document.includeArrayIndex !== undefined) {
			throw new MongoCompatibilityError(
				"$unwind's includeArrayIndex is not supported: SurrealDB's SPLIT does not report the position a value came from, and there is nothing to derive it from once the rows are flattened.",
			);
		}
		return {
			path: unwindPath(document.path),
			preserve: document.preserveNullAndEmptyArrays === true,
		};
	}

	throw new MongoCompatibilityError(
		"$unwind takes a field path string, or a document with a `path`.",
	);
}

function unwindPath(path: unknown): string {
	if (typeof path !== "string" || !path.startsWith("$")) {
		throw new MongoCompatibilityError(
			'$unwind\'s path must be a field path beginning with $, as in "$tags".',
		);
	}
	return path.slice(1);
}

/** `1` and `true` include; `0` and `false` exclude. */
function isExcluded(value: unknown): boolean {
	return value === 0 || value === false;
}

function wholeNumber(stage: string, value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new MongoCompatibilityError(
			`${stage} takes a non-negative whole number, and was given ${JSON.stringify(value)}.`,
		);
	}
	return value;
}

/**
 * Quote an output field name.
 *
 * Aliases are quoted for the same reason every other identifier is: a name is
 * caller input, and an unquoted one is either a parse error or, worse, read as
 * an expression.
 */
function escapeAlias(name: string): string {
	return `\`${name.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;
}
