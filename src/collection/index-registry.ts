/**
 * Per-collection cache of the full-text fields `$text` expands to.
 *
 * `$text: {$search: …}` compiles to `field @@ $term` over every field carrying a
 * SurrealDB `FULLTEXT` index, and the filter translator is synchronous, so the
 * field list has to be resolved before translation starts. This holds that
 * resolved list.
 *
 * It is a cache, not a record: the server is the source of truth, and
 * `sync()` replaces the contents wholesale from a `listIndexes` reading.
 * `add()`/`remove()` keep it current across a create or drop without a second
 * round trip.
 */

import type { IndexDescriptionInfo, IndexKey } from "../types.ts";

/** Field paths of the `"text"` entries in an index key. */
function textFieldsOfKey(key: IndexKey): string[] {
	return Object.entries(key)
		.filter(([, direction]) => direction === "text")
		.map(([field]) => field);
}

export class IndexRegistry {
	private readonly _keys = new Map<string, IndexKey>();

	/** True once the field list has been read from the server at least once. */
	private _loaded = false;

	/** Field names that have a FULLTEXT index (used for `$text` queries). */
	get textFields(): readonly string[] {
		const fields: string[] = [];
		for (const key of this._keys.values()) fields.push(...textFieldsOfKey(key));
		return fields;
	}

	/** True when the cache reflects a reading from the server. */
	get loaded(): boolean {
		return this._loaded;
	}

	/** Replace the cache with the indexes the server reports. */
	sync(descriptions: readonly IndexDescriptionInfo[]): void {
		this._keys.clear();
		for (const description of descriptions) {
			this._keys.set(description.name, description.key);
		}
		this._loaded = true;
	}

	/** Track a freshly-defined index. */
	add(key: IndexKey, name: string): void {
		this._keys.set(name, key);
	}

	/** Forget an index (and any text fields it contributed). */
	remove(name: string): void {
		this._keys.delete(name);
	}
}
