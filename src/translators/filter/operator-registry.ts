/**
 * Strategy registry for MongoDB filter operators ($gt, $in, $regex, …).
 *
 * Each operator is implemented as a separate `FilterOperator` and
 * registered here. The translator never `switch`es on the operator name;
 * it just looks it up. Adding a new operator means writing a new file
 * and calling `.register()` once — Open/Closed in practice.
 */

import type { TranslateContext } from "./translate-context.ts";

export interface FilterOperator {
	/** Operator name including the `$` prefix, e.g. `$gt`. */
	readonly name: string;
	/**
	 * Produce a SurrealQL boolean expression for `field <op> value` using
	 * the supplied translation context to allocate parameters and
	 * recurse into nested operators.
	 */
	translate(field: string, value: unknown, ctx: TranslateContext): string;
}

export class FilterOperatorRegistry {
	private readonly ops = new Map<string, FilterOperator>();

	register(op: FilterOperator): this {
		this.ops.set(op.name, op);
		return this;
	}

	registerAll(ops: FilterOperator[]): this {
		for (const op of ops) this.register(op);
		return this;
	}

	get(name: string): FilterOperator {
		const op = this.ops.get(name);
		if (!op) throw new Error(`Unsupported filter operator: ${name}`);
		return op;
	}

	has(name: string): boolean {
		return this.ops.has(name);
	}
}
