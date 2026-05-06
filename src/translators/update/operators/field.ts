/**
 * Field-level update operators: $set, $unset, $inc, $mul, $min, $max,
 * $rename, $currentDate, $setOnInsert.
 */

import type { UpdateOperator } from "../operator-registry.ts";

export const setOperator: UpdateOperator = {
	name: "$set",
	apply(entries, ctx) {
		for (const [field, value] of entries) {
			const f = ctx.resolveField(field);
			const p = ctx.bind(value);
			ctx.parts.push(`${f} = $${p}`);
		}
	},
};

export const setOnInsertOperator: UpdateOperator = {
	name: "$setOnInsert",
	apply(entries, ctx) {
		for (const [field, value] of entries) {
			const f = ctx.resolveField(field);
			const p = ctx.bind(value);
			ctx.parts.push(`${f} = ${f} ?? $${p}`);
		}
	},
};

export const unsetOperator: UpdateOperator = {
	name: "$unset",
	apply(entries, ctx) {
		for (const [field] of entries) {
			ctx.parts.push(`${ctx.resolveField(field)} = NONE`);
		}
	},
};

export const incOperator: UpdateOperator = {
	name: "$inc",
	apply(entries, ctx) {
		for (const [field, value] of entries) {
			const f = ctx.resolveField(field);
			const p = ctx.bind(value);
			ctx.parts.push(`${f} += $${p}`);
		}
	},
};

export const mulOperator: UpdateOperator = {
	name: "$mul",
	apply(entries, ctx) {
		for (const [field, value] of entries) {
			const f = ctx.resolveField(field);
			const p = ctx.bind(value);
			ctx.parts.push(`${f} = ${f} * $${p}`);
		}
	},
};

function makeFunctionOp(name: string, fn: string): UpdateOperator {
	return {
		name,
		apply(entries, ctx) {
			for (const [field, value] of entries) {
				const f = ctx.resolveField(field);
				const p = ctx.bind(value);
				ctx.parts.push(`${f} = ${fn}([${f}, $${p}])`);
			}
		},
	};
}

export const minOperator: UpdateOperator = makeFunctionOp("$min", "math::min");
export const maxOperator: UpdateOperator = makeFunctionOp("$max", "math::max");

export const renameOperator: UpdateOperator = {
	name: "$rename",
	apply(entries, ctx) {
		for (const [oldField, newField] of entries) {
			ctx.parts.push(
				`${ctx.resolveField(newField as string)} = ${ctx.resolveField(oldField)}`,
			);
			ctx.parts.push(`${ctx.resolveField(oldField)} = NONE`);
		}
	},
};

export const currentDateOperator: UpdateOperator = {
	name: "$currentDate",
	apply(entries, ctx) {
		for (const [field] of entries) {
			ctx.parts.push(`${ctx.resolveField(field)} = time::now()`);
		}
	},
};

export const fieldOperators: UpdateOperator[] = [
	setOperator,
	setOnInsertOperator,
	unsetOperator,
	incOperator,
	mulOperator,
	minOperator,
	maxOperator,
	renameOperator,
	currentDateOperator,
];
