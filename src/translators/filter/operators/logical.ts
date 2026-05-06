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
			const inner = ctx.translateOperators(field, value as Document);
			return `!(${inner})`;
		},
	},
];
