/**
 * `$lookup` — a left outer join, in two indexed phases.
 *
 * The obvious translation is a correlated subquery in the field list, and it is
 * semantically exact: `(SELECT * FROM foreign WHERE fk = $parent.local)` returns
 * an array per row and an empty one where nothing matched, which is what
 * `$lookup` returns. It is not used, because it does not use an index.
 *
 * Measured on 3.2.x with `EXPLAIN`, against a table with an index on the foreign
 * field:
 *
 *     WHERE cid = 'c1'              → IndexScan cust_cid
 *     WHERE cid = $parent.customer  → TableScan, "no (unsupported predicate)"
 *
 * Correlating the predicate loses the index, so that shape is a full scan of the
 * foreign collection *per outer row* — a thousand orders against a hundred
 * thousand customers is a hundred million row reads for a join MongoDB answers
 * from an index in milliseconds. Shipping it would be the performance twin of
 * the wrong answers this driver refuses to give: correct, and quietly ruinous.
 *
 * So the join is done in two phases in one round trip:
 *
 *     LET $rows = (<the pipeline so far>);
 *     LET $keys = array::distinct(array::flatten($rows.<local>));
 *     LET $join = (SELECT * FROM foreign WHERE <fk> IN $keys);
 *     SELECT *, $join[WHERE <match>] AS <as> FROM $rows;
 *
 * `EXPLAIN` shows the third statement fanning out to one `IndexScan` per distinct
 * key, so the cost is the number of *distinct* keys rather than the number of
 * rows, and the join itself is an in-memory array filter. The outer set is
 * materialised once rather than evaluated twice, which is why `$rows` exists at
 * all.
 *
 * What this costs instead is memory: every matching foreign document is held in
 * a server-side variable, where MongoDB would stream. That is the trade, and it
 * is documented rather than discovered.
 */

import { MongoCompatibilityError } from "../../errors.ts";
import { escapeIdentifier } from "../../surreal/sql/escape.ts";
import type { Document } from "../../types.ts";
import { isIdField } from "../filter/id-field.ts";
import { fieldPath } from "./expression.ts";

/** The variables one `$lookup` binds. Suffixed so several can coexist. */
export interface LookupVariables {
	readonly rows: string;
	readonly keys: string;
	readonly join: string;
}

/** A validated `$lookup` specification. */
export interface LookupSpec {
	/** The foreign collection, unescaped. */
	readonly from: string;
	/** The field on the input documents, as the caller wrote it. */
	readonly localField: string;
	/** The field on the foreign documents, as the caller wrote it. */
	readonly foreignField: string;
	/** The output array field. */
	readonly as: string;
}

/**
 * Read and check a `$lookup` stage.
 *
 * The `let`/`pipeline` form is refused rather than approximated: it runs an
 * arbitrary sub-pipeline per join, which the two-phase plan cannot express — the
 * foreign rows would have to be gathered before the sub-pipeline that decides
 * which of them are wanted has run.
 */
export function readLookupSpec(spec: unknown): LookupSpec {
	if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
		throw new MongoCompatibilityError(
			"$lookup takes a specification document.",
		);
	}

	const document = spec as Document;

	if (document.pipeline !== undefined || document.let !== undefined) {
		throw new MongoCompatibilityError(
			"$lookup with a `pipeline` or `let` is not implemented by @surrealdb/mql: it runs a sub-pipeline for each joined document, and this driver joins by gathering the matching foreign rows in one indexed query before any per-row work could decide which of them are wanted. Use the localField/foreignField form, and filter the joined array with a later $match or $unwind.",
		);
	}

	const { from, localField, foreignField, as: alias } = document;

	for (const [name, value] of [
		["from", from],
		["localField", localField],
		["foreignField", foreignField],
		["as", alias],
	] as const) {
		if (typeof value !== "string" || value.length === 0) {
			throw new MongoCompatibilityError(
				`$lookup requires a non-empty string \`${name}\`.`,
			);
		}
	}

	return {
		from: from as string,
		localField: localField as string,
		foreignField: foreignField as string,
		as: alias as string,
	};
}

/**
 * The SurrealQL for one `$lookup`'s two setup statements and its join expression.
 *
 * The statement the pipeline has built so far is already bound to `vars.rows` by
 * the builder before this is called, so everything here reads from that variable.
 */
export function compileLookup(
	spec: LookupSpec,
	vars: LookupVariables,
	identityIsPlainField: boolean,
): { readonly lets: readonly string[]; readonly joined: string } {
	// The local field is read from the rows the pipeline has produced, so `_id`
	// means whatever it means there: SurrealDB's `id` over stored rows, a plain
	// field once a stage has reshaped them.
	const local = fieldPath(spec.localField, identityIsPlainField);
	const table = escapeIdentifier(spec.from);

	const joiningOnId = isIdField(spec.foreignField);

	/**
	 * The joined documents are selected MongoDB-shaped: `_id` holding the record
	 * *key*, and no `id`.
	 *
	 * Both halves earn their place. Renaming means a later stage can name
	 * `$joined._id` and get something — left as `id` the joined documents would
	 * carry a field no MongoDB pipeline knows to ask for. Extracting the key with
	 * `record::id` rather than handing back the whole `RecordId` is what makes the
	 * value survive being moved: the SDK does not return a `RecordId` instance
	 * from inside a `LET`-bound array, so nothing on this side could convert it,
	 * and `{$project: {x: "$joined._id"}}` would answer `authors:c1` where MongoDB
	 * answers `c1`.
	 */
	const project = "*, record::id(id) AS _id OMIT id";

	// Two places compare, and they compare different things. The `WHERE` inside
	// the `LET` runs against stored rows, where the identity is a `RecordId` in
	// `id` — so a local value has to be built into one, and that is also what
	// keeps the scan indexed. The array filter runs against the projection above,
	// where the identity is already the plain key the local field holds.
	const stored = joiningOnId ? "id" : fieldPath(spec.foreignField, true);
	const projected = joiningOnId
		? escapeIdentifier("_id")
		: fieldPath(spec.foreignField, true);
	const asRecord = (value: string) =>
		`type::record(${quoted(spec.from)}, ${value})`;

	const keys = joiningOnId
		? `$${vars.keys}.map(|$v| ${asRecord("$v")})`
		: `$${vars.keys}`;

	const lets = [
		`LET $${vars.keys} = array::distinct(array::flatten($${vars.rows}.${local}))`,
		`LET $${vars.join} = (SELECT ${project} FROM ${table} WHERE ${stored} IN ${keys})`,
	];

	// Two ways to match, because MongoDB has two: a scalar local field equals the
	// foreign one, and an array local field matches if *any* element does.
	const scalar = `${projected} = $parent.${local}`;
	const anyElement = `type::is_array($parent.${local}) AND ${projected} IN $parent.${local}`;

	// `?? []` for a foreign collection that does not exist. SurrealDB refuses to
	// read a table it holds no definition for, which leaves the variable unset;
	// MongoDB treats a collection it has never seen as an empty one and answers
	// with the outer rows and an empty join. This is the same rule `selectRows`
	// applies to a missing local collection, in the one place a `$lookup` can meet
	// it.
	return {
		lets,
		joined: `($${vars.join} ?? [])[WHERE ${scalar} OR (${anyElement})]`,
	};
}

/** A SurrealQL single-quoted string literal. */
function quoted(value: string): string {
	return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
