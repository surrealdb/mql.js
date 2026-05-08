/**
 * Comparison operators: $eq, $ne, $gt, $gte, $lt, $lte.
 *
 * All of them follow the same `field <sql-op> $param` shape so they're
 * generated from one factory.
 */

import type { FilterOperator } from "../operator-registry.ts";

function makeBinary(name: string, sqlOp: string): FilterOperator {
	return {
		name,
		translate(field, value, ctx) {
			const p = ctx.bind(value);
			return `${field} ${sqlOp} $${p}`;
		},
	};
}

export const comparisonOperators: FilterOperator[] = [
	makeBinary("$eq", "="),
	makeBinary("$ne", "!="),
	makeBinary("$gt", ">"),
	makeBinary("$gte", ">="),
	makeBinary("$lt", "<"),
	makeBinary("$lte", "<="),
];
