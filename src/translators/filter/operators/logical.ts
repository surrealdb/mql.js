/**
 * Per-field logical operator: $not.
 *
 * Top-level $and / $or / $nor are handled by the document walker (they
 * combine sub-documents, not single fields) and live in `index.ts`.
 */

import type { Document } from "../../../types.ts";
import type { FilterOperator } from "../operator-registry.ts";

export const logicalOperators: FilterOperator[] = [
	{
		name: "$not",
		translate(field, value, ctx) {
			// Negated, so a `$near` inside it would keep its ordering while inverting
			// the predicate it orders — see `withoutNearOrder`.
			const inner = ctx.withoutNearOrder(() =>
				ctx.translateOperators(field, value as Document),
			);
			return `!(${inner})`;
		},
	},
];
