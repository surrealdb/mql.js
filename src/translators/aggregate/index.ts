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
 *   `$match` `$sort` `$limit` `$skip` `$count` `$sample` `$project` `$unset`
 *   `$group` `$unwind` `$lookup` `$facet` `$graphLookup` `$bucket` `$out`
 *   `$merge`
 *
 * `$bucketAuto`, `$unionWith`, `$setWindowFields` and the rest are refused.
 *
 * `$out` and `$merge` are not stages the *translator* folds into SQL — they
 * write, and this module never touches the executor. They are handled one
 * layer up, in `src/collection/operations/aggregate.ts`, which strips a
 * trailing `$out`/`$merge` before calling this module at all. Reaching the
 * switch below means one was found somewhere *other* than last, which is the
 * one thing this module can still usefully say about them: MongoDB requires
 * both to be the final stage, and so does this driver.
 */

import { MongoCompatibilityError } from "../../errors.ts";
import type { Document, Sort } from "../../types.ts";
import type { SurrealDialect } from "../dialect/index.ts";
import { translateFilter } from "../filter/index.ts";
import { translateSort } from "../sort.ts";
import { compileAccumulator } from "./accumulators.ts";
import { SelectBuilder, Slot } from "./builder.ts";
import { compileExpression, fieldPath } from "./expression.ts";
import { compileGraphLookup, readGraphLookupSpec } from "./graph-lookup.ts";
import { compileLookup, readLookupSpec } from "./lookup.ts";

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
	/**
	 * True when `sql` is more than one statement, so the answer is its last frame.
	 *
	 * Only `$lookup` produces one, by binding the outer rows and the joined rows
	 * ahead of the statement that reads them.
	 */
	readonly isBatch: boolean;
	/**
	 * True once a stage has replaced the document shape, so the rows the
	 * statement answers with carry a literal `_id` field rather than SurrealDB's
	 * `id` column.
	 *
	 * This is what decides how the executing operation decodes a row — through
	 * `recordToDocument` (the row is still a stored record) or by walking every
	 * `_id` key it finds (the row is a computed value). It used to be guessed
	 * from which stage *names* appeared in the pipeline, which was wrong for an
	 * exclusion `$project`: `{$project: {secret: 0}}` does not rename anything,
	 * so the guess treated a row-preserving pipeline as reshaped and left its
	 * identity undecoded. Reading the builder's own tracked state, which is
	 * already correct for every stage, replaces the guess rather than patching it.
	 */
	readonly identityIsPlainField: boolean;
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

/**
 * Every stage `applyStage` routes, for the refusal message to name.
 *
 * Derived rather than written out. The hand-written list this replaced fell two
 * stages behind what the switch actually handled — it told callers `$facet` and
 * `$graphLookup` were unavailable after both had shipped — and a list that
 * cannot drift is the only fix that stays fixed. `tests/unit` asserts the two
 * agree.
 */
export const SUPPORTED_STAGES: readonly string[] = [
	"$match",
	"$sort",
	"$limit",
	"$skip",
	"$count",
	"$sample",
	"$project",
	"$unset",
	"$addFields",
	"$set",
	"$replaceRoot",
	"$replaceWith",
	"$sortByCount",
	"$group",
	"$unwind",
	"$lookup",
	"$facet",
	"$graphLookup",
	"$bucket",
	"$out",
	"$merge",
];

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
	runStages(pipeline, builder, bind, options, bindings, "");

	return {
		sql: builder.renderBatch(),
		bindings,
		isBatch: builder.isBatch,
		identityIsPlainField: builder.identityIsPlainField,
	};
}

/**
 * Apply every stage of a pipeline to `builder`.
 *
 * `scope` distinguishes stages that share an index because they are in
 * different branches of a `$facet` — it is what keeps their bound parameters and
 * their variable names apart. Empty for the top-level pipeline, so the SQL that
 * pipeline emits is unchanged by this existing.
 */
function runStages(
	pipeline: readonly Document[],
	builder: SelectBuilder,
	bind: (value: unknown) => string,
	options: TranslatePipelineOptions,
	bindings: Record<string, unknown>,
	scope: string,
): void {
	for (const [index, stage] of pipeline.entries()) {
		applyStage(stage, `${scope}${index}`, builder, bind, options, bindings);
	}
}

function applyStage(
	stage: Document,
	index: string,
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
		case "$sample":
			applySample(spec, builder);
			return;
		case "$project":
			applyProject(spec, builder, bind);
			return;
		case "$unset":
			applyUnset(spec, builder);
			return;
		case "$group":
			applyGroup(spec, builder, bind);
			return;
		case "$unwind":
			applyUnwind(spec, builder);
			return;
		case "$lookup":
			applyLookup(spec, index, builder);
			return;
		case "$facet":
			applyFacet(spec, index, builder, bind, options, bindings);
			return;
		case "$graphLookup":
			applyGraphLookup(spec, index, builder, bind, options, bindings);
			return;
		case "$bucket":
			applyBucket(spec, builder, bind);
			return;
		case "$addFields":
		case "$set":
			applyAddFields(name, spec, builder, bind);
			return;
		case "$replaceRoot":
		case "$replaceWith":
			applyReplaceRoot(name, spec, builder, bind);
			return;
		case "$sortByCount":
			applySortByCount(spec, builder, bind);
			return;
		case "$out":
		case "$merge":
			throw new MongoCompatibilityError(
				`${name} must be the final stage of the pipeline, and here it is not. MongoDB requires the same thing for the same reason: everything after it would run against a collection this stage is still writing to.`,
			);
		default:
			throw new MongoCompatibilityError(
				`The aggregation stage ${name} is not implemented by @surrealdb/mql. Translating it partially would answer with documents that ignored it, so it is refused instead. These are supported: ${[...SUPPORTED_STAGES].join(", ")}.`,
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
	index: string,
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

/**
 * `$sample` — `size` random documents, `ORDER BY rand() LIMIT size`.
 *
 * MongoDB's own `$sample` promises nothing about which documents are chosen
 * beyond "at random" (and, below a size threshold relative to the collection,
 * that no document repeats) — an ordering by a fresh random value per row and
 * a limit is exactly that, and needs no special casing beyond going through the
 * same `Slot.Order`/`Slot.Limit` claims `$sort`/`$limit` already do.
 */
function applySample(spec: unknown, builder: SelectBuilder): void {
	if (
		typeof spec !== "object" ||
		spec === null ||
		Array.isArray(spec) ||
		typeof (spec as Document).size !== "number"
	) {
		throw new MongoCompatibilityError(
			"$sample takes a document with a numeric `size`.",
		);
	}

	builder.claim(Slot.Order);
	builder.setOrderBy("ORDER BY rand()");
	builder.claim(Slot.Limit);
	builder.setLimit(wholeNumber("$sample.size", (spec as Document).size));
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

	const idEntry = entries.find(([key]) => key === "_id");
	const otherEntries = entries.filter(([key]) => key !== "_id");
	const includeId = idEntry ? !isExcluded(idEntry[1]) : true;

	if (otherEntries.length === 0) {
		// `_id` is the only key, and its two values mean opposite things.
		// `{_id: 1}` is inclusion naming one field, so the answer carries `_id`
		// and nothing else — reading "no other field is excluded" as "nothing was
		// projected, keep everything" would answer every field the caller had
		// just declined to ask for. `{_id: 0}` names nothing to include, so
		// everything but `_id` survives, which the exclusion path below already
		// gives it.
		if (includeId) {
			const plainId = builder.identityIsPlainField;
			builder.claim(Slot.Fields);
			builder.setFields(
				`${fieldPath("_id", plainId)} AS ${escapeAlias("_id")}`,
			);
			return;
		}
		projectByExclusion([], false, builder);
		return;
	}

	const included = otherEntries.filter(([, v]) => !isExcluded(v));
	const excluded = otherEntries.filter(([, v]) => isExcluded(v));

	if (included.length > 0 && excluded.length > 0) {
		// MongoDB's own rule, `_id` exempted either way: a `$project` is either
		// wholly inclusion or wholly exclusion.
		throw new MongoCompatibilityError(
			`$project cannot exclude ${excluded[0][0]} in an inclusion projection: mixing inclusions and exclusions is rejected by MongoDB, and \`_id\` is the only field exempt from the rule. Use an exclusion projection listing every field to drop, or move ${excluded[0][0]} into a separate stage.`,
		);
	}

	if (included.length === 0) {
		// Pure exclusion — every named field is dropped, `_id` included unless it
		// was one of them.
		projectByExclusion(
			otherEntries.map(([key]) => key),
			includeId,
			builder,
		);
		return;
	}

	const plainId = builder.identityIsPlainField;
	const fields = included.map(([key, value]) => {
		if (value === 1 || value === true) {
			return `${fieldPath(key, plainId)} AS ${escapeAlias(key)}`;
		}
		return `${compileExpression(value, bind, plainId)} AS ${escapeAlias(key)}`;
	});

	// `_id` rides along unless suppressed, as it does in MongoDB.
	if (includeId) {
		fields.unshift(`${fieldPath("_id", plainId)} AS ${escapeAlias("_id")}`);
	}

	builder.claim(Slot.Fields);
	builder.setFields(fields.join(", "));
}

/**
 * `$unset` — the field-list form of a pure exclusion, and nothing else.
 *
 * MongoDB accepts a single field name or an array of them; there is no document
 * form, because `$unset` only ever excludes. `_id` is an ordinary name here —
 * `$unset` carries none of `$project`'s "only `_id` may be excluded on its own"
 * restriction, since there is no inclusion side for it to conflict with.
 */
function applyUnset(spec: unknown, builder: SelectBuilder): void {
	const fields = typeof spec === "string" ? [spec] : spec;
	if (
		!Array.isArray(fields) ||
		fields.length === 0 ||
		fields.some((field) => typeof field !== "string" || field.length === 0)
	) {
		throw new MongoCompatibilityError(
			"$unset takes a non-empty field name, or a non-empty array of them.",
		);
	}

	const includeId = !fields.includes("_id");
	projectByExclusion(
		fields.filter((field) => field !== "_id"),
		includeId,
		builder,
	);
}

/**
 * The shared shape behind an exclusion `$project` and `$unset`: keep every
 * column the rows already have, `OMIT`ting only what was named.
 *
 * Marked `reshapes: false` — the one thing that makes this correct rather than
 * a smaller version of the same bug `$lookup` and `$facet` avoid. Exclusion
 * does not rename anything: the identity column keeps whatever name it already
 * has, `id` for a still-stored row or a literal `_id` after an earlier `$group`
 * or inclusion `$project` — this stage does not care which, it just hides
 * fields from the one already there. Marking it reshaped regardless was the
 * actual bug this replaces: `{$project: {_id: 0}}` on a fresh pipeline OMITted
 * a column literally named `_id`, which does not exist on a stored row (the
 * column is `id`), so the identity was not excluded at all — it reached the
 * caller unconverted, under the wrong key, because the decoder was told the row
 * had been reshaped when it had not.
 */
function projectByExclusion(
	excludeFields: readonly string[],
	includeId: boolean,
	builder: SelectBuilder,
): void {
	const plainId = builder.identityIsPlainField;
	const omitted = excludeFields.map((field) => fieldPath(field, plainId));
	if (!includeId) omitted.push(fieldPath("_id", plainId));

	builder.claim(Slot.Fields);
	if (omitted.length === 0) {
		// `$unset` never reaches this — it requires at least one field — but a
		// `$project` naming only `_id: 1` inside an otherwise-empty exclusion does:
		// nothing is actually excluded, so the row passes through untouched.
		builder.setFields("*", false);
		return;
	}
	builder.setFields(`* OMIT ${omitted.join(", ")}`, false);
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

/**
 * `$bucket` — group by which of a set of ranges a value falls into.
 *
 * Not a new kind of statement. MongoDB's own definition is a `$group` whose `_id`
 * is the bucket a document belongs to, and that is exactly what this builds: the
 * boundaries become a `$switch`, and the whole thing is handed to `$group`. So
 * everything already true of grouping — that a following `$sort` folds into the
 * same statement, that `_id` becomes an ordinary field afterwards — stays true
 * without being restated or re-tested.
 *
 * MongoDB sorts the buckets by their lower bound, which a `$group` does not
 * promise, so the sort is applied rather than assumed.
 */
function applyBucket(
	spec: unknown,
	builder: SelectBuilder,
	bind: (value: unknown) => string,
): void {
	if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
		throw new MongoCompatibilityError(
			"$bucket takes a specification document.",
		);
	}

	const { groupBy, boundaries, default: fallback, output } = spec as Document;

	if (groupBy === undefined) {
		throw new MongoCompatibilityError("$bucket requires `groupBy`.");
	}
	if (!Array.isArray(boundaries) || boundaries.length < 2) {
		throw new MongoCompatibilityError(
			"$bucket requires `boundaries` as an array of at least two values, which is what makes at least one bucket.",
		);
	}
	if (fallback === undefined) {
		// MongoDB errors at run time on a document outside every bucket unless
		// `default` is given. Refusing here is the same rule enforced earlier: a
		// pipeline that would fail on the first out-of-range document is better
		// stopped before it runs.
		throw new MongoCompatibilityError(
			"$bucket requires `default` here: MongoDB fails at run time on a document that falls outside every boundary, and this driver cannot raise that error mid-statement, so the bucket for those documents has to be named up front.",
		);
	}

	// `boundaries[i] <= value < boundaries[i + 1]`, tried in order, so the first
	// branch that matches is the narrowest one that can.
	const branches = boundaries.slice(0, -1).map((lower, position) => ({
		case: {
			$and: [
				{ $gte: ["$$mql_bucket_value", lower] },
				{ $lt: ["$$mql_bucket_value", boundaries[position + 1]] },
			],
		},
		// `then` is MongoDB's own key in a `$switch` branch rather than a thenable:
		// this object is handed straight to the expression compiler and is never
		// awaited, returned to a caller, or resolved.
		// biome-ignore lint/suspicious/noThenProperty: MongoDB's $switch branch key
		then: lower,
	}));

	applyGroup(
		{
			_id: {
				$let: {
					vars: { mql_bucket_value: groupBy },
					in: { $switch: { branches, default: fallback } },
				},
			},
			// MongoDB's default output, and the only one it applies when `output` is
			// absent.
			...((output as Document) ?? { count: { $sum: 1 } }),
		},
		builder,
		bind,
	);

	applySort({ _id: 1 }, builder);
}

/**
 * `$graphLookup` — recursive traversal, attached per input document.
 *
 * The traversal itself is in `graph-lookup.ts`, and it is one expression rather
 * than a phase of its own — so this is a field added to the current statement,
 * the same shape `$lookup`'s joined array takes. The rows keep every column they
 * had, `id` among them, so the documents are not reshaped.
 */
function applyGraphLookup(
	spec: unknown,
	index: string,
	builder: SelectBuilder,
	bind: (value: unknown) => string,
	options: TranslatePipelineOptions,
	bindings: Record<string, unknown>,
): void {
	const graph = readGraphLookupSpec(spec);

	const seeds = compileExpression(
		graph.startWith,
		bind,
		builder.identityIsPlainField,
	);

	// `restrictSearchWithMatch` filters the documents the traversal will accept,
	// and is an ordinary filter over the foreign collection — so it goes through
	// the translator every other filter goes through.
	let restrict = "";
	if (graph.restrictSearchWithMatch !== undefined) {
		const translated = translateFilter(graph.restrictSearchWithMatch, {
			collection: graph.from,
			dialect: options.dialect,
			paramPrefix: `g${index}p`,
		});
		if (translated.nearDistance) {
			throw new MongoCompatibilityError(
				"$near and $nearSphere are not supported inside $graphLookup's restrictSearchWithMatch: they order a result set as well as filtering it, and a traversal has no ordering to carry that.",
			);
		}
		Object.assign(bindings, translated.bindings);
		restrict = translated.clause;
	}

	builder.claim(Slot.Fields);
	builder.setFields(
		`*, ${compileGraphLookup(graph, seeds, restrict)} AS ${escapeAlias(graph.as)}`,
		false,
	);
}

/**
 * `$facet` — several sub-pipelines over the same input, in one document.
 *
 * The input is bound once and each branch reads it, which is the only way to run
 * them over the *same* rows without evaluating the pipeline so far once per
 * branch:
 *
 *     LET $in    = (<the pipeline so far>);
 *     LET $fac_0 = (<branch one, reading $in>);
 *     LET $fac_1 = (<branch two, reading $in>);
 *     SELECT * FROM [{ "one": $fac_0, "two": $fac_1 }];
 *
 * The literal one-row source is what makes `$facet` a stage rather than a
 * terminus: MongoDB's `$facet` answers with a single document, and a statement
 * reading one row of that shape is something later stages can go on folding into.
 *
 * Each branch compiles with a builder of its own, and its `LET`s are emitted
 * ahead of it — a branch containing a `$lookup` binds variables that have to be
 * in place before the branch is read. The branches share the outer pipeline's
 * parameter counter, so nothing they bind can collide.
 */
function applyFacet(
	spec: unknown,
	index: string,
	builder: SelectBuilder,
	bind: (value: unknown) => string,
	options: TranslatePipelineOptions,
	bindings: Record<string, unknown>,
): void {
	if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
		throw new MongoCompatibilityError("$facet takes a specification document.");
	}

	const branches = Object.entries(spec as Document);
	if (branches.length === 0) {
		throw new MongoCompatibilityError("$facet takes at least one branch.");
	}

	const input = `mql_facet_in_${index}`;
	builder.materialise(input);

	const fields: string[] = [];

	for (const [position, [name, stages]] of branches.entries()) {
		if (!Array.isArray(stages)) {
			throw new MongoCompatibilityError(
				`The $facet branch ${name} must be an array of stages.`,
			);
		}
		assertFacetable(name, stages);

		const branch = new SelectBuilder(`$${input}`);
		runStages(
			stages as Document[],
			branch,
			bind,
			options,
			bindings,
			`${index}f${position}_`,
		);

		// The branch's own setup first, then the branch. Order matters: a `$lookup`
		// inside it binds variables the branch's statement reads.
		for (const statement of branch.letStatements) builder.bind(statement);

		const variable = `mql_facet_${index}_${position}`;
		builder.bind(`LET $${variable} = (${branch.render()})`);
		fields.push(`${JSON.stringify(name)}: $${variable}`);
	}

	builder.replaceSource(`[{ ${fields.join(", ")} }]`);
}

/**
 * Stages MongoDB forbids inside a `$facet`, refused here for its reasons.
 *
 * `$facet` inside `$facet` is forbidden outright; the others write, or name
 * their own source, and a branch has neither a collection to write to nor a
 * source of its own.
 */
const NOT_IN_FACET = new Set(["$facet", "$out", "$merge", "$geoNear"]);

function assertFacetable(name: string, stages: readonly unknown[]): void {
	for (const stage of stages) {
		if (typeof stage !== "object" || stage === null) continue;
		for (const stageName of Object.keys(stage as Document)) {
			if (NOT_IN_FACET.has(stageName)) {
				throw new MongoCompatibilityError(
					`${stageName} cannot appear inside a $facet, and MongoDB refuses it too. It is in the branch ${name}.`,
				);
			}
		}
	}
}

/**
 * `$lookup` — a left outer join in two indexed phases.
 *
 * The shape and the reason for it are in `lookup.ts`. What belongs here is the
 * order of operations: the pipeline so far is bound to a variable, the two join
 * statements are bound after it, and a fresh statement reads the variable with
 * the joined array added to `*`.
 *
 * The field list is set without marking the documents reshaped, because they are
 * not: `SELECT *, … AS joined` keeps every column the rows already had, `id`
 * among them, so `_id` still means the record identity for later stages.
 */
function applyLookup(
	spec: unknown,
	index: string,
	builder: SelectBuilder,
): void {
	const lookup = readLookupSpec(spec);

	// Suffixed by stage, so two `$lookup`s in one pipeline do not share variables.
	const vars = {
		rows: `mql_rows_${index}`,
		keys: `mql_keys_${index}`,
		join: `mql_join_${index}`,
	};

	builder.materialise(vars.rows);

	const { lets, joined } = compileLookup(
		lookup,
		vars,
		builder.identityIsPlainField,
	);
	for (const binding of lets) builder.bind(binding);

	builder.claim(Slot.Fields);
	builder.setFields(`*, ${joined} AS ${escapeAlias(lookup.as)}`, false);
}

/**
 * `$addFields`, and its alias `$set` — extra fields beside the existing ones.
 *
 * `SELECT *, <expr> AS name`, which carries MongoDB's rule that a field already
 * present is *replaced* rather than duplicated. Measured rather than assumed,
 * because nothing in the grammar promises which of two same-named entries wins:
 * `SELECT *, 99 AS a` answers `a: 99`.
 *
 * The documents are not marked reshaped, for the reason `$lookup`'s are not:
 * every column the rows already had survives, `id` among them, so `_id` still
 * means the record identity for the stages after this one.
 */
function applyAddFields(
	stage: string,
	spec: unknown,
	builder: SelectBuilder,
	bind: (value: unknown) => string,
): void {
	if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
		throw new MongoCompatibilityError(
			`${stage} takes a document of field names and expressions.`,
		);
	}

	const entries = Object.entries(spec as Document);
	if (entries.length === 0) {
		throw new MongoCompatibilityError(`${stage} takes at least one field.`);
	}

	const plainId = builder.identityIsPlainField;
	const added = entries.map(
		([key, value]) =>
			`${compileExpression(value, bind, plainId)} AS ${escapeAlias(key)}`,
	);

	// Claimed *before* the field list is read, not after. `claim` may open a new
	// statement — it does whenever a `$group` or `$project` already spoke for this
	// one's field list — and the list to extend is then the new statement's `*`,
	// not the aggregate list of the statement just closed. Reading it first
	// re-emitted that aggregate list over the subquery already computing it.
	builder.claim(Slot.Fields);
	builder.setFields(`${builder.fields}, ${added.join(", ")}`, false);
}

/**
 * `$replaceRoot`, and its shorthand `$replaceWith` — promote a value to the root.
 *
 * `SELECT VALUE <expr>` answers with the value itself rather than a document
 * wrapping it, which is the stage's whole contract.
 */
function applyReplaceRoot(
	stage: string,
	spec: unknown,
	builder: SelectBuilder,
	bind: (value: unknown) => string,
): void {
	// `$replaceRoot` wraps its expression in `newRoot`; `$replaceWith` is the same
	// stage written without the wrapper.
	const expression =
		stage === "$replaceWith" ? spec : (spec as Document | null)?.newRoot;

	if (expression === undefined) {
		throw new MongoCompatibilityError(
			`${stage} takes ${stage === "$replaceWith" ? "an expression" : "a document with a `newRoot` expression"}.`,
		);
	}

	builder.claim(Slot.Fields);
	builder.setFields(
		`VALUE ${compileExpression(expression, bind, builder.identityIsPlainField)}`,
	);
}

/**
 * `$sortByCount` — group by an expression, count, and order by the count.
 *
 * MongoDB defines it as exactly `$group` with a `$sum: 1` named `count` followed
 * by `$sort: {count: -1}`, so it is applied as those two rather than given a
 * translation of its own. Everything true of that pair stays true here for
 * free — that the sort folds into the grouping statement, above all.
 */
function applySortByCount(
	spec: unknown,
	builder: SelectBuilder,
	bind: (value: unknown) => string,
): void {
	if (spec === undefined) {
		throw new MongoCompatibilityError(
			"$sortByCount takes an expression to group by.",
		);
	}

	applyGroup({ _id: spec, count: { $sum: 1 } }, builder, bind);
	applySort({ count: -1 }, builder);
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
