/**
 * Per-collection index/text-field bookkeeping.
 *
 * Owning this state in a separate object (instead of inlining it on
 * `Collection`) means index operations can be unit-tested in isolation
 * and the collection class only carries one responsibility: orchestrating
 * MongoDB-shaped CRUD calls against the executor.
 */

import type { IndexDescription, IndexSpecification } from "../types.ts";

export class IndexRegistry {
	private readonly _indexes: IndexDescription[] = [];
	private _textFields: string[] = [];

	/** Field names that have a FULLTEXT index (used for `$text` queries). */
	get textFields(): readonly string[] {
		return this._textFields;
	}

	/** Snapshot of the tracked indexes in insertion order. */
	list(): IndexDescription[] {
		return [...this._indexes];
	}

	/** Track a freshly-defined index, marking text fields if any. */
	add(spec: IndexSpecification, name: string): void {
		this._indexes.push({ name, key: spec });
		const newTextFields = Object.entries(spec)
			.filter(([, v]) => v === "text")
			.map(([k]) => k);
		if (newTextFields.length > 0) {
			this._textFields.push(...newTextFields);
		}
	}

	/** Forget an index (and any text fields it contributed). */
	remove(name: string): void {
		const idx = this._indexes.findIndex((i) => i.name === name);
		if (idx === -1) return;
		const removed = this._indexes.splice(idx, 1)[0];
		const removedTextFields = Object.entries(removed.key)
			.filter(([, v]) => v === "text")
			.map(([k]) => k);
		if (removedTextFields.length > 0) {
			this._textFields = this._textFields.filter(
				(f) => !removedTextFields.includes(f),
			);
		}
	}
}
