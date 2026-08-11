/**
 * Translates a MongoDB update document (with $set, $inc, etc.) into
 * a SurrealQL SET clause with parameterised bindings.
 *
 * Example:
 *   { $set: { name: "Jane" }, $inc: { age: 1 } }
 *   →  { clause: "SET name = $p0, age += $p1", bindings: { p0: "Jane", p1: 1 } }
 */

import type { Document } from "../../types.ts";
import { DEFAULT_UPDATE_REGISTRY } from "./default-registry.ts";
import type { UpdateOperatorRegistry } from "./operator-registry.ts";
import { resolveField } from "./positional.ts";
import type { UpdateContext } from "./update-context.ts";

export interface TranslatedUpdate {
	/** SurrealQL clause starting with SET (or CONTENT for full replacement). */
	clause: string;
	/** Parameterised bindings. */
	bindings: Record<string, unknown>;
}

/** Options for `translateUpdate`. */
export interface TranslateUpdateOptions {
	/** Starting index for parameter names (avoids collisions). */
	startIndex?: number;
	/** Array filters for positional filtered operators ($[identifier]). */
	arrayFilters?: Document[];
	/**
	 * True when the caller will run the resulting clause as an upsert, so the
	 * statement may insert. Only `$setOnInsert` depends on it, and MongoDB
	 * applies that operator solely on the inserting path.
	 */
	upsert?: boolean;
	/** Override the operator registry (advanced). */
	registry?: UpdateOperatorRegistry;
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
	const registry = options?.registry ?? DEFAULT_UPDATE_REGISTRY;
	const bindings: Record<string, unknown> = {};
	const parts: string[] = [];
	let counter = startIndex ?? options?.startIndex ?? 0;

	const ctx: UpdateContext = {
		bindings,
		parts,
		arrayFilters: options?.arrayFilters,
		upsert: options?.upsert === true,
		nextParam: () => `p${counter++}`,
		bind(value) {
			const name = ctx.nextParam();
			bindings[name] = value;
			return name;
		},
		resolveField(field) {
			return resolveField(field, ctx);
		},
	};

	for (const [op, fields] of Object.entries(update)) {
		if (typeof fields !== "object" || fields === null) {
			throw new MongoInvalidArgumentError(
				`Update operator ${op} requires an object value`,
			);
		}
		const handler = registry.get(op);
		const entries = Object.entries(fields as Record<string, unknown>);
		rejectIdMutation(entries);
		handler.apply(entries, ctx);
	}

	if (parts.length === 0) {
		return { clause: "", bindings: {} };
	}

	return { clause: `SET ${parts.join(", ")}`, bindings };
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

export { DEFAULT_UPDATE_REGISTRY } from "./default-registry.ts";
export {
	type UpdateOperator,
	UpdateOperatorRegistry,
} from "./operator-registry.ts";

import { MongoInvalidArgumentError } from "../../errors.ts";
import { MONGO_ID_FIELD } from "../filter/id-field.ts";

export type { UpdateContext } from "./update-context.ts";

/**
 * Reject an update that targets `_id`, matching MongoDB's immutable-id rule.
 *
 * Without this the field would be written literally: SurrealDB stores identity
 * in `id`, so `{$set: {_id: x}}` emitted `SET _id = x` and created a *second*,
 * phantom `_id` column that shadowed the real identity on read — leaving the
 * document with an `_id` that no query could match.
 */
function rejectIdMutation(entries: [string, unknown][]): void {
	for (const [field] of entries) {
		if (field === MONGO_ID_FIELD || field.startsWith(`${MONGO_ID_FIELD}.`)) {
			throw new MongoInvalidArgumentError(
				`Performing an update on the path '${field}' would modify the immutable field '_id'`,
			);
		}
	}
}
