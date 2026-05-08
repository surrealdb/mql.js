/**
 * Membership operators: $in, $nin.
 */

import type { FilterOperator } from "../operator-registry.ts";

export const membershipOperators: FilterOperator[] = [
	{
		name: "$in",
		translate(field, value, ctx) {
			const p = ctx.bind(value);
			return `${field} IN $${p}`;
		},
	},
	{
		name: "$nin",
		translate(field, value, ctx) {
			const p = ctx.bind(value);
			return `${field} NOT IN $${p}`;
		},
	},
];
