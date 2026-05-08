/**
 * Array operators: $all, $size, $elemMatch.
 */

import type { Document } from "../../../types.ts";
import type { FilterOperator } from "../operator-registry.ts";
import type { TranslateContext } from "../translate-context.ts";

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

function translateElemMatch(
	field: string,
	conditions: Document,
	ctx: TranslateContext,
): string {
	const isAllEquality = Object.keys(conditions).every(
		(k) => !k.startsWith("$") && !isOperatorObject(conditions[k]),
	);

	if (isAllEquality) {
		const p = ctx.bind(conditions);
		return `${field} CONTAINS $${p}`;
	}

	const isAllOperators = Object.keys(conditions).every((k) =>
		k.startsWith("$"),
	);

	if (isAllOperators) {
		const subParts: string[] = [];
		for (const [op, val] of Object.entries(conditions)) {
			subParts.push(
				...ctx
					.translateOperators("$this", { [op]: val } as Document)
					.split(" AND "),
			);
		}
		return `array::len(${field}[WHERE ${subParts.join(" AND ")}]) > 0`;
	}

	const subParts: string[] = [];
	for (const [key, value] of Object.entries(conditions)) {
		if (isOperatorObject(value)) {
			subParts.push(ctx.translateOperators(key, value as Document));
		} else {
			const p = ctx.bind(value);
			subParts.push(`${key} = $${p}`);
		}
	}

	return `array::len(${field}[WHERE ${subParts.join(" AND ")}]) > 0`;
}

export const arrayOperators: FilterOperator[] = [
	{
		name: "$all",
		translate(field, value, ctx) {
			const p = ctx.bind(value);
			return `${field} CONTAINSALL $${p}`;
		},
	},
	{
		name: "$size",
		translate(field, value, ctx) {
			const p = ctx.bind(value);
			return `array::len(${field}) = $${p}`;
		},
	},
	{
		name: "$elemMatch",
		translate(field, value, ctx) {
			return translateElemMatch(field, value as Document, ctx);
		},
	},
];
