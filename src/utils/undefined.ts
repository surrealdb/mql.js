/**
 * MongoDB's `ignoreUndefined` policy, applied to caller input.
 *
 * A driver has to decide what `undefined` means, because the wire format has no
 * such value. MongoDB decides it in the serialiser: by default an `undefined`
 * property is written as `null`, and `ignoreUndefined: true` drops the property
 * instead. The distinction is visible in results — `{a: 1, b: undefined}`
 * inserts `{a: 1, b: null}` by default — and in filters, where `{p: undefined}`
 * becomes `{p: null}` and therefore stops matching a document whose `p` has a
 * value.
 *
 * Array elements are the exception, in both modes: an array has positions, so
 * dropping one would renumber the rest. MongoDB writes `null` there regardless,
 * and so does this.
 *
 * Applied to documents, filters and update specifications alike, since the
 * option describes the encoding of everything the caller sends.
 */

/** True for a value whose own properties should be walked and rebuilt. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Rewrite every `undefined` in `value` according to `ignoreUndefined`.
 *
 * Returns a copy; the caller's object is never mutated. Class instances
 * (`ObjectId`, `Date`, `RecordId`, …) are passed through untouched, because
 * spreading one would produce a lookalike that has lost its prototype.
 */
export function applyUndefinedPolicy<T>(value: T, ignoreUndefined: boolean): T {
	if (Array.isArray(value)) {
		return value.map((element) =>
			element === undefined
				? null
				: applyUndefinedPolicy(element, ignoreUndefined),
		) as unknown as T;
	}

	if (!isPlainObject(value)) return value;

	const result: Record<string, unknown> = {};
	for (const [key, property] of Object.entries(value)) {
		if (property === undefined) {
			if (!ignoreUndefined) result[key] = null;
			continue;
		}
		result[key] = applyUndefinedPolicy(property, ignoreUndefined);
	}
	return result as T;
}
