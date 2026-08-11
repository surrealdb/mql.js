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
import { escapeFieldPath } from "../../surreal/sql/escape.ts";
import type { UpdateContext } from "./update-context.ts";

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
	// The sub-field comes from a caller-supplied arrayFilters key, so it is an
	// untrusted identifier and must be escaped like any other field path.
	const escaped = escapeFieldPath(subField);

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
			conditions.push(`${escaped} ${sqlOp} $${p}`);
		}
	} else {
		const p = ctx.bind(value);
		conditions.push(`${escaped} = $${p}`);
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

/** Matches a positional marker segment: `.$[]` or `.$[identifier]`. */
const POSITIONAL_SEGMENT_RE = /(\.\$\[\w*\])/;

/** The single positional operator `$`, which this driver does not support. */
const SINGLE_POSITIONAL_RE = /(?:^|\.)\$(?:\.|$)/;

/**
 * Replace MongoDB positional markers in a field path with SurrealQL syntax and
 * escape everything around them.
 *
 * Splitting on the markers first means the plain path segments can be escaped
 * (so `grades.$[e].first name` works) without mangling the `[*]` and
 * `[WHERE …]` fragments, which are SurrealQL syntax rather than identifiers.
 */
export function resolveField(field: string, ctx: UpdateContext): string {
	if (SINGLE_POSITIONAL_RE.test(field)) {
		throw new MongoInvalidArgumentError(
			`The positional operator '$' is not supported in "${field}". Use the all-positional '$[]' or a filtered '$[identifier]' with arrayFilters instead.`,
		);
	}

	let resolved = "";

	for (const chunk of field.split(POSITIONAL_SEGMENT_RE)) {
		if (chunk === "") continue;

		const marker = /^\.\$\[(\w*)\]$/.exec(chunk);
		if (marker) {
			const identifier = marker[1] as string;
			resolved +=
				identifier === ""
					? "[*]"
					: `[WHERE ${resolveArrayFilter(identifier, ctx)}]`;
			continue;
		}

		// A chunk following a marker keeps its leading dot from the original
		// path; the dot is structure, not part of the identifier.
		const continues = chunk.startsWith(".");
		const path = escapeFieldPath(continues ? chunk.slice(1) : chunk);
		resolved += continues || resolved !== "" ? `.${path}` : path;
	}

	return resolved;
}
