/**
 * Element operators: $exists.
 */

import type { FilterOperator } from "../operator-registry.ts";

export const elementOperators: FilterOperator[] = [
	{
		name: "$exists",
		translate(field, value) {
			return value ? `${field} IS NOT NONE` : `${field} IS NONE`;
		},
	},
];
