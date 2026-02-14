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
}

function nextParam(ctx: Context): string {
	return `p${ctx.counter++}`;
}

function escapeField(field: string): string {
	return field;
}

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
	const ctx: Context = { counter: startIndex };
	const bindings: Record<string, unknown> = {};
	const setParts: string[] = [];

	for (const [op, fields] of Object.entries(update)) {
		if (typeof fields !== "object" || fields === null) {
			throw new Error(`Update operator ${op} requires an object value`);
		}

		const entries = Object.entries(fields as Record<string, unknown>);

		switch (op) {
			case "$set": {
				for (const [field, value] of entries) {
					const p = nextParam(ctx);
					bindings[p] = value;
					setParts.push(`${escapeField(field)} = $${p}`);
				}
				break;
			}

			case "$unset": {
				for (const [field] of entries) {
					setParts.push(`${escapeField(field)} = NONE`);
				}
				break;
			}

			case "$inc": {
				for (const [field, value] of entries) {
					const p = nextParam(ctx);
					bindings[p] = value;
					setParts.push(`${escapeField(field)} += $${p}`);
				}
				break;
			}

			case "$mul": {
				for (const [field, value] of entries) {
					const p = nextParam(ctx);
					bindings[p] = value;
					setParts.push(`${escapeField(field)} *= $${p}`);
				}
				break;
			}

			case "$min": {
				for (const [field, value] of entries) {
					const p = nextParam(ctx);
					bindings[p] = value;
					setParts.push(
						`${escapeField(field)} = math::min(${escapeField(field)}, $${p})`,
					);
				}
				break;
			}

			case "$max": {
				for (const [field, value] of entries) {
					const p = nextParam(ctx);
					bindings[p] = value;
					setParts.push(
						`${escapeField(field)} = math::max(${escapeField(field)}, $${p})`,
					);
				}
				break;
			}

			case "$push": {
				for (const [field, value] of entries) {
					const p = nextParam(ctx);
					bindings[p] = value;
					setParts.push(`${escapeField(field)} += [$${p}]`);
				}
				break;
			}

			case "$pull": {
				for (const [field, value] of entries) {
					const p = nextParam(ctx);
					bindings[p] = value;
					setParts.push(`${escapeField(field)} -= [$${p}]`);
				}
				break;
			}

			case "$addToSet": {
				for (const [field, value] of entries) {
					const p = nextParam(ctx);
					bindings[p] = value;
					setParts.push(
						`${escapeField(field)} = array::union(${escapeField(field)}, [$${p}])`,
					);
				}
				break;
			}

			case "$rename": {
				for (const [oldField, newField] of entries) {
					setParts.push(
						`${escapeField(newField as string)} = ${escapeField(oldField)}`,
					);
					setParts.push(`${escapeField(oldField)} = NONE`);
				}
				break;
			}

			case "$currentDate": {
				for (const [field] of entries) {
					setParts.push(`${escapeField(field)} = time::now()`);
				}
				break;
			}

			default:
				throw new Error(`Unsupported update operator: ${op}`);
		}
	}

	if (setParts.length === 0) {
		return { clause: "", bindings: {} };
	}

	return { clause: `SET ${setParts.join(", ")}`, bindings };
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
