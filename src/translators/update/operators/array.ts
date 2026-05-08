/**
 * Array update operators: $push, $pull, $pullAll, $addToSet, $pop.
 */

import type { UpdateOperator } from "../operator-registry.ts";
import type { UpdateContext } from "../update-context.ts";

function isPushModifier(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		"$each" in (value as Record<string, unknown>)
	);
}

function applyPushWithModifiers(
	field: string,
	mods: Record<string, unknown>,
	ctx: UpdateContext,
): void {
	const f = ctx.resolveField(field);
	const eachParam = ctx.bind(mods.$each);

	let expr: string;
	if (mods.$position !== undefined) {
		const posParam = ctx.bind(mods.$position);
		expr = `array::concat(array::concat(array::slice(${f}, 0, $${posParam}), $${eachParam}), array::slice(${f}, $${posParam}))`;
	} else {
		expr = `array::concat(${f}, $${eachParam})`;
	}

	if (mods.$sort !== undefined) {
		const sortVal = mods.$sort;
		if (typeof sortVal === "number") {
			expr =
				sortVal === -1
					? `array::sort::desc(${expr})`
					: `array::sort::asc(${expr})`;
		} else {
			expr = `array::sort::asc(${expr})`;
		}
	}

	if (mods.$slice !== undefined) {
		const sliceVal = mods.$slice as number;
		const sliceParam = ctx.bind(sliceVal);
		expr =
			sliceVal < 0
				? `array::slice(${expr}, $${sliceParam})`
				: `array::slice(${expr}, 0, $${sliceParam})`;
	}

	ctx.parts.push(`${f} = ${expr}`);
}

export const pushOperator: UpdateOperator = {
	name: "$push",
	apply(entries, ctx) {
		for (const [field, value] of entries) {
			if (isPushModifier(value)) {
				applyPushWithModifiers(field, value as Record<string, unknown>, ctx);
			} else {
				const f = ctx.resolveField(field);
				const p = ctx.bind(value);
				ctx.parts.push(`${f} += [$${p}]`);
			}
		}
	},
};

export const pullOperator: UpdateOperator = {
	name: "$pull",
	apply(entries, ctx) {
		for (const [field, value] of entries) {
			const f = ctx.resolveField(field);
			const p = ctx.bind(value);
			ctx.parts.push(`${f} -= [$${p}]`);
		}
	},
};

export const pullAllOperator: UpdateOperator = {
	name: "$pullAll",
	apply(entries, ctx) {
		for (const [field, value] of entries) {
			const f = ctx.resolveField(field);
			const p = ctx.bind(value);
			ctx.parts.push(`${f} = array::complement(${f}, $${p})`);
		}
	},
};

export const addToSetOperator: UpdateOperator = {
	name: "$addToSet",
	apply(entries, ctx) {
		for (const [field, value] of entries) {
			const f = ctx.resolveField(field);
			const p = ctx.bind(value);
			ctx.parts.push(`${f} = array::union(${f}, [$${p}])`);
		}
	},
};

export const popOperator: UpdateOperator = {
	name: "$pop",
	apply(entries, ctx) {
		for (const [field, value] of entries) {
			const f = ctx.resolveField(field);
			if (value === -1) {
				ctx.parts.push(`${f} = array::slice(${f}, 1)`);
			} else {
				ctx.parts.push(`${f} = array::slice(${f}, 0, array::len(${f}) - 1)`);
			}
		}
	},
};

export const arrayUpdateOperators: UpdateOperator[] = [
	pushOperator,
	pullOperator,
	pullAllOperator,
	addToSetOperator,
	popOperator,
];
