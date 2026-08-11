/**
 * Field-level update operators: $set, $unset, $inc, $mul, $min, $max,
 * $rename, $currentDate, $setOnInsert.
 */

import { MongoInvalidArgumentError } from "../../../errors.ts";
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
		// MongoDB applies $setOnInsert *only* when the operation ends up inserting,
		// which can only happen on an upsert. Emitting `f = f ?? $p` unconditionally
		// meant a plain update wrote the value onto an existing document whenever
		// the field happened to be absent — so `{$setOnInsert: {z: 9}}` set z on a
		// document it should not have touched at all. On a non-upsert the operator
		// is a guaranteed no-op, so emit nothing.
		if (!ctx.upsert) return;

		for (const [field, value] of entries) {
			const f = ctx.resolveField(field);
			const p = ctx.bind(value);
			// `id IS NONE` is the insert marker. An UPSERT evaluates its SET clause
			// against the document as it was *before* the statement, so on the
			// creating path there is no record yet and `id` reads as NONE, while an
			// existing record — whether addressed by id or matched by WHERE — has it
			// bound. Verified on SurrealDB 3.2.3 for all four combinations
			// (`UPSERT rec:id` / `UPSERT table … WHERE`, matching / not matching).
			//
			// The previous `f ?? $p` could not distinguish the two, so it also wrote
			// the value onto an existing document that merely lacked the field.
			ctx.parts.push(`${f} = IF id IS NONE THEN $${p} ELSE ${f} END`);
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

/**
 * Build `$min`/`$max` as a conditional assignment.
 *
 * These used to emit `math::min([f, $p])`, which only accepts numbers: `$min`
 * on a string threw "Incorrect arguments for function math::min()". MongoDB
 * compares with BSON ordering and so supports strings, dates and every other
 * type, writing only when the candidate is lower (`$min`) or higher (`$max`)
 * than the stored value.
 *
 * A comparison-driven `IF … THEN … ELSE … END` has no such type restriction.
 * The `IS NONE` arm covers the absent field, which MongoDB simply sets. Note
 * that mixed-type comparisons follow SurrealDB's value ordering rather than
 * BSON's, so a cross-type `$min` may pick a different winner than MongoDB —
 * comparing unlike types is undefined-ish in practice and not worth emulating.
 */
function makeComparisonOp(name: string, cmp: "<" | ">"): UpdateOperator {
	return {
		name,
		apply(entries, ctx) {
			for (const [field, value] of entries) {
				const f = ctx.resolveField(field);
				const p = ctx.bind(value);
				ctx.parts.push(
					`${f} = IF ${f} IS NONE OR $${p} ${cmp} ${f} THEN $${p} ELSE ${f} END`,
				);
			}
		},
	};
}

export const minOperator: UpdateOperator = makeComparisonOp("$min", "<");
export const maxOperator: UpdateOperator = makeComparisonOp("$max", ">");

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

/**
 * Validate a `$currentDate` specification.
 *
 * MongoDB accepts `true`, `{$type: "date"}` and `{$type: "timestamp"}`, where
 * "timestamp" means a BSON Timestamp — an internal replication type, not a
 * datetime. The `$type` discriminator was previously destructured away, so
 * "timestamp" silently produced a `time::now()` datetime: a value of the wrong
 * type that no BSON Timestamp consumer could use. This driver has no BSON
 * Timestamp representation, so the honest answer is to reject it.
 */
function assertCurrentDateSpec(field: string, value: unknown): void {
	if (value === true) return;

	if (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length === 1 &&
		"$type" in value
	) {
		const type = (value as { $type: unknown }).$type;
		if (type === "date") return;
		if (type === "timestamp") {
			throw new MongoInvalidArgumentError(
				`$currentDate with {$type: "timestamp"} is not supported on the path '${field}': SurrealDB has no BSON Timestamp equivalent. Use true or {$type: "date"} for a datetime.`,
			);
		}
	}

	throw new MongoInvalidArgumentError(
		`The '$currentDate' specification for the path '${field}' must be true or {$type: "date"}`,
	);
}

export const currentDateOperator: UpdateOperator = {
	name: "$currentDate",
	apply(entries, ctx) {
		for (const [field, value] of entries) {
			assertCurrentDateSpec(field, value);
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
