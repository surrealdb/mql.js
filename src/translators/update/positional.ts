/**
 * MongoDB positional array operators in field paths.
 *
 *   `grades.$[]`             → `grades[*]`        (all elements)
 *   `grades.$[elem].score`   → `grades[WHERE …].score`
 *
 * The filtered form uses an arrayFilters entry (passed through
 * `UpdateOptions`) to build the WHERE clause inside the brackets.
 */

import { MongoInvalidArgumentError } from "../../errors.ts";
import type { UpdateContext } from "./update-context.ts";

const ALL_POSITIONAL_RE = /\.\$\[\]/g;
const FILTERED_POSITIONAL_RE = /\.\$\[(\w+)\]/g;

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

function translateArrayFilterEntry(
	subField: string,
	value: unknown,
	ctx: UpdateContext,
	conditions: string[],
): void {
	if (isOperatorObject(value)) {
		for (const [op, opVal] of Object.entries(
			value as Record<string, unknown>,
		)) {
			const sqlOp = COMPARISON_OPS[op];
			if (!sqlOp)
				throw new MongoInvalidArgumentError(
					`Unsupported operator in arrayFilter: ${op}`,
				);
			const p = ctx.bind(opVal);
			conditions.push(`${subField} ${sqlOp} $${p}`);
		}
	} else {
		const p = ctx.bind(value);
		conditions.push(`${subField} = $${p}`);
	}
}

function resolveArrayFilter(identifier: string, ctx: UpdateContext): string {
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
		translateArrayFilterEntry(key.slice(prefix.length), value, ctx, conditions);
	}

	return conditions.join(" AND ");
}

/** Replace MongoDB positional markers in a field path with SurrealQL syntax. */
export function resolveField(field: string, ctx: UpdateContext): string {
	let resolved = field.replace(ALL_POSITIONAL_RE, "[*]");

	if (FILTERED_POSITIONAL_RE.test(resolved)) {
		FILTERED_POSITIONAL_RE.lastIndex = 0;
		resolved = resolved.replace(
			FILTERED_POSITIONAL_RE,
			(_match, identifier: string) =>
				`[WHERE ${resolveArrayFilter(identifier, ctx)}]`,
		);
	}

	return resolved;
}
