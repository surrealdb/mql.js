/**
 * Applying a MongoDB projection to a document already in memory.
 *
 * `find` projects in SurrealQL — the field list goes into the `SELECT` — but the
 * find-and-modify statements cannot: `UPDATE … RETURN BEFORE` returns the whole
 * record, and there is no clause to narrow it. Their projection is therefore
 * applied to the document the write hands back, which is also how MongoDB
 * describes it: the projection shapes the returned document, not the write.
 */

import { translateProjection } from "../translators/projection.ts";
import type { Document, Projection } from "../types.ts";
import { applyProjection } from "./id.ts";

/**
 * Return `doc` reduced to what `projection` asks for.
 *
 * Both modes are handled, and the validation is `translateProjection`'s, so an
 * inclusion/exclusion mix is rejected here exactly as it is on the `find` path.
 * `_id` is kept unless the projection excludes it, as MongoDB keeps it.
 */
export function projectDocument(
	doc: Document,
	projection?: Projection,
): Document {
	const translated = translateProjection(projection);

	if (translated.isExclusion) {
		return applyProjection(doc, translated.excludeFields, translated.includeId);
	}

	// No included fields means the projection named nothing but `_id`, so the whole
	// document stands and only `_id` suppression can apply.
	const included = includedPaths(projection);
	if (included.length === 0) {
		return applyProjection(doc, [], translated.includeId);
	}

	const result: Document = {};
	if (translated.includeId && "_id" in doc) result._id = doc._id;
	for (const path of included) {
		copyPath(doc, result, path.split("."));
	}
	return result;
}

/** The non-`_id` paths an inclusion projection asks for. */
function includedPaths(projection?: Projection): string[] {
	if (!projection) return [];
	return Object.entries(projection)
		.filter(([key, value]) => key !== "_id" && Boolean(value))
		.map(([key]) => key);
}

/** True for a value whose properties a projection path may descend into. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Copy the value `segments` addresses from `source` into `target`, creating the
 * intermediate objects the path needs.
 *
 * A path that does not resolve copies nothing, which is what MongoDB does for a
 * field a document does not have. An array on the path is descended into
 * element-wise, so `{"users.name": 1}` yields the name of each entry — again
 * matching MongoDB, where a projection distributes over arrays.
 */
function copyPath(
	source: Record<string, unknown>,
	target: Record<string, unknown>,
	segments: string[],
): void {
	const [head, ...rest] = segments;
	if (!(head in source)) return;

	const value = source[head];

	if (rest.length === 0) {
		target[head] = value;
		return;
	}

	if (Array.isArray(value)) {
		const projected = value
			.filter(isPlainObject)
			.map((element) => {
				const elementTarget: Record<string, unknown> = {};
				copyPath(element, elementTarget, rest);
				return elementTarget;
			})
			.filter((element) => Object.keys(element).length > 0);
		if (projected.length > 0) target[head] = projected;
		return;
	}

	if (!isPlainObject(value)) return;

	const nested = (target[head] as Record<string, unknown>) ?? {};
	copyPath(value, nested, rest);
	if (Object.keys(nested).length > 0) target[head] = nested;
}
