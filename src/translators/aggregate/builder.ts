/**
 * Folding a pipeline of stages into as few `SELECT`s as it needs.
 *
 * A MongoDB pipeline is a sequence: each stage sees what the one before it
 * produced. A SurrealQL `SELECT` is not a sequence — it is a set of clause slots
 * evaluated in a fixed order. So the translation is a fold: keep packing stages
 * into the current statement while each one lands in a slot the statement has
 * not evaluated past, and wrap what you have in a subquery the moment one does
 * not. `SELECT * FROM (SELECT …) WHERE …` is a `$match` after a `$group`.
 *
 * The order below is SurrealDB's **evaluation** order, which is not the same as
 * the order the clauses are written, and every entry was measured rather than
 * read off the grammar:
 *
 *   - `WHERE` runs **before** `SPLIT`. `SELECT cat, tags FROM sales
 *     WHERE tags = 'p' SPLIT tags` returns nothing on a row whose `tags` is
 *     `['p','q']`, because the comparison saw the array. So `$match` after
 *     `$unwind` must nest.
 *   - `WHERE` does **not** see projection aliases.
 *     `SELECT price * 2 AS dbl FROM sales WHERE dbl > 20` returns nothing. So
 *     `$match` after `$project` must nest.
 *   - `ORDER BY` **does** see them, both a projected alias and an aggregate one.
 *     So `$sort` after `$project` or `$group` folds, and this is what lets the
 *     common `$group` → `$sort` → `$limit` tail be one statement.
 *
 * And one rule that is not an ordering at all: **`SPLIT` and `GROUP` are
 * mutually exclusive** in a single statement — `SPLIT and GROUP are mutually
 * exclusive` is a parse error, not a slow path — so `$unwind` followed by
 * `$group` nests regardless of slot order.
 */

import { statement } from "../../surreal/sql/statement.ts";

/**
 * The clause slots of one `SELECT`, in evaluation order.
 *
 * A stage may be folded into the current statement only if every slot it needs
 * is still free *and* sits at or after the last slot already filled. The numbers
 * are compared, so they have to be ordered; the names are what the code reads.
 */
export enum Slot {
	/** `FROM` — set once, when the level opens. */
	Source = 0,
	/** `WHERE` — `$match`. */
	Where = 1,
	/** `SPLIT` — `$unwind`. */
	Split = 2,
	/** `GROUP BY` and the aggregate field list — `$group`, `$count`. */
	Group = 3,
	/** The field list — `$project`. */
	Fields = 4,
	/** `ORDER BY` — `$sort`. */
	Order = 5,
	/** `START` — `$skip`. */
	Start = 6,
	/** `LIMIT` — `$limit`. */
	Limit = 7,
}

/** One `SELECT` under construction. */
interface Level {
	/** What this statement reads from: a table, or a parenthesised subquery. */
	from: string;
	/** The field list, `*` until a stage sets one. */
	fields: string;
	where: string;
	split: string;
	groupBy: string;
	orderBy: string;
	start: string;
	limit: string;
	/** The highest slot filled so far, so the next stage knows if it fits. */
	highest: Slot;
	/** True once a `$group` has run here, since `SPLIT` cannot join it. */
	grouped: boolean;
	/** True once a `$unwind` has run here, since `GROUP` cannot join it. */
	splitUsed: boolean;
}

const emptyLevel = (from: string): Level => ({
	from,
	fields: "*",
	where: "",
	split: "",
	groupBy: "",
	orderBy: "",
	start: "",
	limit: "",
	highest: Slot.Source,
	grouped: false,
	splitUsed: false,
});

/**
 * Assembles the statement a pipeline compiles to.
 *
 * Stages call `claim(slot)` before writing to it. `claim` either keeps the
 * current level — returning without doing anything — or closes it into a
 * subquery and opens a fresh one, and either way the caller then writes its
 * clause. Nesting is therefore invisible to the stages: they describe what they
 * need, and the shape follows.
 */
export class SelectBuilder {
	private level: Level;

	/**
	 * True once any stage has rewritten the document shape.
	 *
	 * Monotonic, and deliberately not per-level: a subquery over reshaped rows
	 * still yields reshaped rows. What it decides is how `_id` reads. Stored rows
	 * keep their identity in SurrealDB's `id` column, so a filter or sort naming
	 * `_id` means `id`. The output of a `$group` or `$project` has a literal `_id`
	 * field and no `id` at all, so from there on the rewrite would name a column
	 * that does not exist — matching nothing, quietly.
	 */
	private reshaped = false;

	/** `LET` statements that run before the final one, in order. */
	private readonly preamble: string[] = [];

	constructor(source: string) {
		this.level = emptyLevel(source);
	}

	/** Whether `_id` is now an ordinary field rather than the record identity. */
	get identityIsPlainField(): boolean {
		return this.reshaped;
	}

	/**
	 * Reserve a slot, nesting first if this statement has already passed it.
	 *
	 * `exclusiveOfSplit` and `exclusiveOfGroup` carry the one constraint that is
	 * not about ordering: a statement may have a `SPLIT` or a `GROUP BY`, never
	 * both.
	 */
	claim(
		slot: Slot,
		options: { needsNoSplit?: boolean; needsNoGroup?: boolean } = {},
	): void {
		const alreadyPassed = slot <= this.level.highest;
		const clashes =
			(options.needsNoSplit === true && this.level.splitUsed) ||
			(options.needsNoGroup === true && this.level.grouped);

		if (alreadyPassed || clashes) this.nest();
		this.level.highest = slot;
	}

	/** Close the current statement and continue against it as a subquery. */
	private nest(): void {
		this.level = emptyLevel(`(${this.render()})`);
	}

	/**
	 * Bind the statement so far to a variable and continue reading from it.
	 *
	 * A subquery would do for continuing, and is what `nest` uses. This exists for
	 * `$lookup`, which needs the outer rows *twice* — once to collect the join
	 * keys and once to read — and a subquery repeated in two places is the outer
	 * pipeline evaluated twice. Binding it evaluates once.
	 */
	materialise(name: string): void {
		this.preamble.push(`LET $${name} = (${this.render()})`);
		this.level = emptyLevel(`$${name}`);
	}

	/** Add a `LET` that runs before the final statement. */
	bind(statement: string): void {
		this.preamble.push(statement);
	}

	/** True once anything has been bound, so the answer is the last frame. */
	get isBatch(): boolean {
		return this.preamble.length > 0;
	}

	/**
	 * Set the field list, and record that this statement's is now spoken for.
	 *
	 * Marking the slot matters beyond bookkeeping. `$group` writes a field list of
	 * aggregate aliases, and a `$project` folded into the same statement would
	 * overwrite it — dropping the aggregates while still returning rows. The
	 * `$project` nests instead, which is also the only thing that *could* work:
	 * its expressions name `_id` and the accumulator aliases, which do not exist
	 * until the grouping has run.
	 */
	setFields(fields: string, reshapes = true): void {
		this.level.fields = fields;
		this.level.highest = Math.max(this.level.highest, Slot.Fields);
		// `$lookup` sets a field list of `*` plus its joined array, so the rows keep
		// their `id` column and `_id` still means the record identity. Every other
		// caller replaces the shape.
		if (reshapes) this.reshaped = true;
	}

	setWhere(clause: string): void {
		this.level.where = clause;
	}

	/**
	 * Set the `SPLIT` field.
	 *
	 * This claims the field list too, for the same reason `ORDER BY` needs its
	 * columns selected: SurrealDB rejects `SPLIT` on an idiom the statement does
	 * not select (`Missing split idiom`). Leaving the list at `*` carries it; a
	 * later `$project` narrowing the list in the same statement would not, so it
	 * is made to nest.
	 */
	setSplit(field: string): void {
		this.level.split = field;
		this.level.splitUsed = true;
		this.level.highest = Math.max(this.level.highest, Slot.Fields);
	}

	setGroup(groupBy: string): void {
		this.level.groupBy = groupBy;
		this.level.grouped = true;
	}

	setOrderBy(clause: string): void {
		this.level.orderBy = clause;
	}

	setStart(rows: number): void {
		this.level.start = `START ${rows}`;
	}

	setLimit(rows: number): void {
		this.level.limit = `LIMIT ${rows}`;
	}

	/** The field list as it currently stands, for stages that extend it. */
	get fields(): string {
		return this.level.fields;
	}

	/**
	 * Everything to send: the bound variables, then the statement.
	 *
	 * The caller reads the **last** frame, which is this statement's, whatever the
	 * preamble bound ahead of it.
	 */
	renderBatch(): string {
		return [...this.preamble, this.render()].join("; ");
	}

	/** The finished statement, without a trailing `TIMEOUT`. */
	render(): string {
		const { fields, from, where, split, groupBy, orderBy, start, limit } =
			this.level;
		return statement(
			`SELECT ${fields} FROM ${from}`,
			where && `WHERE ${where}`,
			split && `SPLIT ${split}`,
			groupBy,
			orderBy,
			// `START` is written before `LIMIT` in SurrealQL, and means the same as
			// MongoDB's `$skip` before `$limit`: skip, then take.
			start,
			limit,
		);
	}
}
