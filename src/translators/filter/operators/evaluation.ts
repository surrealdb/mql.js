/**
 * Evaluation operators: $regex, $type, $mod.
 *
 * The dialect strategy decides which SurrealQL form `$regex` and `$type`
 * compile to (e.g. `~` vs `string::matches()`).
 */

import type { FilterOperator } from "../operator-registry.ts";

export const evaluationOperators: FilterOperator[] = [
	{
		name: "$regex",
		translate(field, value, ctx) {
			const pattern = value instanceof RegExp ? value.source : String(value);
			const p = ctx.bind(pattern);
			return ctx.dialect.regexMatch(field, `$${p}`);
		},
	},
	{
		name: "$type",
		translate(field, value, ctx) {
			const fn = ctx.dialect.typeCheckFn(value as string | number);
			if (!fn) throw new Error(`Unsupported $type value: ${value}`);
			return `${fn}(${field})`;
		},
	},
	{
		name: "$mod",
		translate(field, value, ctx) {
			const [divisor, remainder] = value as [number, number];
			const pDiv = ctx.bind(divisor);
			const pRem = ctx.bind(remainder);
			return `${field} % $${pDiv} = $${pRem}`;
		},
	},
];
