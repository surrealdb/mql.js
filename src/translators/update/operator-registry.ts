/**
 * Strategy registry for MongoDB update operators ($set, $inc, $push, …).
 *
 * Mirrors the filter-side registry: each operator is a separate module,
 * the dispatcher just looks them up by name.
 */

import type { UpdateContext } from "./update-context.ts";

/** A single update operator, e.g. `$set` or `$inc`. */
export interface UpdateOperator {
	/** Operator name including the `$` prefix. */
	readonly name: string;
	/** Apply the operator to all `[field, value]` entries it received. */
	apply(entries: [string, unknown][], ctx: UpdateContext): void;
}

export class UpdateOperatorRegistry {
	private readonly ops = new Map<string, UpdateOperator>();

	register(op: UpdateOperator): this {
		this.ops.set(op.name, op);
		return this;
	}

	registerAll(ops: UpdateOperator[]): this {
		for (const op of ops) this.register(op);
		return this;
	}

	get(name: string): UpdateOperator {
		const op = this.ops.get(name);
		if (!op) throw new Error(`Unsupported update operator: ${name}`);
		return op;
	}

	has(name: string): boolean {
		return this.ops.has(name);
	}
}
