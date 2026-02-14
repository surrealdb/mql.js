/**
 * MongoDB-compatible Collection class.
 *
 * Wraps a SurrealDB table, translating MongoDB CRUD operations into
 * SurrealQL queries executed via the `surrealdb` SDK.
 */

import type { RecordId } from "surrealdb";
import type { FindCursor } from "./cursor.ts";
import { createFindCursor } from "./cursor.ts";
import type { Db } from "./db.ts";
import { MongoServerError } from "./errors.ts";
import type { ObjectId } from "./object-id.ts";
import { translateFilter } from "./translators/filter.ts";
import { translateProjection } from "./translators/projection.ts";
import { translateSort } from "./translators/sort.ts";
import { translateReplacement, translateUpdate } from "./translators/update.ts";
import type {
	CountDocumentsOptions,
	DeleteResult,
	Document,
	Filter,
	FindOneAndDeleteOptions,
	FindOneAndReplaceOptions,
	FindOneAndUpdateOptions,
	FindOptions,
	InsertManyResult,
	InsertOneResult,
	ModifyResult,
	OptionalId,
	ReplaceOptions,
	Sort,
	UpdateFilter,
	UpdateOptions,
	UpdateResult,
	WithoutId,
} from "./types.ts";
import {
	applyProjection,
	prepareInsert,
	recordToDocument,
} from "./utils/id.ts";
import {
	makeDeleteResult,
	makeInsertManyResult,
	makeInsertOneResult,
	makeUpdateResult,
} from "./utils/result.ts";

/** Escape a table name for use in SurrealQL. */
function escapeTable(name: string): string {
	// Use backtick escaping to handle special characters in table names
	if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
		return name;
	}
	return `\`${name.replace(/`/g, "\\`")}\``;
}

export class Collection<TSchema extends Document = Document> {
	/** The collection (table) name. */
	readonly collectionName: string;

	/** @internal */
	readonly _db: Db;

	/** @internal – use `createCollection` factory instead. */
	constructor(db: Db, name: string) {
		this._db = db;
		this.collectionName = name;
	}

	/** Shorthand to the underlying Surreal instance. */
	private get surreal() {
		return this._db._client._surreal;
	}

	/** Escaped table name for SurrealQL statements. */
	private get table(): string {
		return escapeTable(this.collectionName);
	}

	/**
	 * Execute a SurrealQL query and return the first statement's result.
	 * Wraps SurrealDB errors in MongoServerError.
	 */
	private async exec<T = unknown>(
		query: string,
		bindings?: Record<string, unknown>,
	): Promise<T> {
		try {
			const results = await this.surreal.query<[T]>(query, bindings);
			return results[0];
		} catch (err) {
			throw new MongoServerError(
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	// -----------------------------------------------------------------------
	// INSERT
	// -----------------------------------------------------------------------

	/**
	 * Inserts a single document into the collection.
	 */
	async insertOne(doc: OptionalId<TSchema>): Promise<InsertOneResult> {
		const prepared = prepareInsert(this.collectionName, doc as Document);

		try {
			await this.surreal.create(prepared.recordId as RecordId, prepared.data);
		} catch (err) {
			throw new MongoServerError(
				err instanceof Error ? err.message : String(err),
			);
		}

		return makeInsertOneResult(prepared.insertedId);
	}

	/**
	 * Inserts multiple documents into the collection.
	 */
	async insertMany(docs: OptionalId<TSchema>[]): Promise<InsertManyResult> {
		const insertedIds: (ObjectId | string | number)[] = [];
		const docsWithId: Document[] = [];

		for (const doc of docs) {
			const prepared = prepareInsert(this.collectionName, doc as Document);
			insertedIds.push(prepared.insertedId);
			docsWithId.push({
				...prepared.data,
				id: prepared.recordId,
			});
		}

		try {
			await this.surreal.insert(this.collectionName, docsWithId);
		} catch (err) {
			throw new MongoServerError(
				err instanceof Error ? err.message : String(err),
			);
		}

		return makeInsertManyResult(insertedIds);
	}

	// -----------------------------------------------------------------------
	// FIND
	// -----------------------------------------------------------------------

	/**
	 * Returns a cursor for documents matching the filter.
	 * The query is not executed until results are consumed.
	 */
	find(filter?: Filter<TSchema>, options?: FindOptions): FindCursor<TSchema> {
		return createFindCursor<TSchema>(
			this,
			executeFind,
			filter as Document,
			options,
		);
	}

	/**
	 * Finds a single document matching the filter.
	 */
	async findOne(
		filter?: Filter<TSchema>,
		options?: FindOptions,
	): Promise<TSchema | null> {
		const { clause, bindings } = translateFilter(filter as Document);
		const proj = translateProjection(options?.projection);
		const sortClause = translateSort(options?.sort);

		const fields = proj.fields || "*";
		let sql = `SELECT ${fields} FROM ${this.table}`;
		if (clause) sql += ` WHERE ${clause}`;
		if (sortClause) sql += ` ${sortClause}`;
		sql += " LIMIT 1";

		const rows = await this.exec<Record<string, unknown>[]>(sql, bindings);

		if (!rows || rows.length === 0) return null;

		let doc = recordToDocument<TSchema>(rows[0]);

		if (proj.isExclusion || !proj.includeId) {
			doc = applyProjection(doc, proj.excludeFields, proj.includeId) as TSchema;
		}

		return doc;
	}

	// -----------------------------------------------------------------------
	// UPDATE
	// -----------------------------------------------------------------------

	/**
	 * Updates the first document matching the filter.
	 */
	async updateOne(
		filter: Filter<TSchema>,
		update: UpdateFilter<TSchema>,
		options?: UpdateOptions,
	): Promise<UpdateResult> {
		return this._update(filter as Document, update as Document, {
			...options,
			limit: 1,
		});
	}

	/**
	 * Updates all documents matching the filter.
	 */
	async updateMany(
		filter: Filter<TSchema>,
		update: UpdateFilter<TSchema>,
		options?: UpdateOptions,
	): Promise<UpdateResult> {
		return this._update(filter as Document, update as Document, options);
	}

	private async _update(
		filter: Document,
		update: Document,
		options?: UpdateOptions & { limit?: number },
	): Promise<UpdateResult> {
		const { clause: whereClause, bindings: filterBindings } =
			translateFilter(filter);

		const paramOffset = Object.keys(filterBindings).length;
		const { clause: setClause, bindings: updateBindings } = translateUpdate(
			update,
			paramOffset,
		);
		const allBindings = { ...filterBindings, ...updateBindings };

		// SurrealQL does not support LIMIT on UPDATE/DELETE.
		// For updateOne (limit=1), we first SELECT the matching record's id,
		// then UPDATE that specific record.
		if (options?.limit === 1 && !options?.upsert) {
			// Step 1: find one matching record
			let findSql = `SELECT id FROM ${this.table}`;
			if (whereClause) findSql += ` WHERE ${whereClause}`;
			findSql += " LIMIT 1";
			const found = await this.exec<Record<string, unknown>[]>(
				findSql,
				filterBindings,
			);

			if (!found || found.length === 0) {
				return makeUpdateResult([]);
			}

			// Step 2: update that specific record by id
			const rid = found[0].id;
			const updateSql = `UPDATE $__rid ${setClause}`;
			allBindings.__rid = rid;
			const rows = await this.exec<Record<string, unknown>[]>(
				updateSql,
				allBindings,
			);
			return makeUpdateResult(rows || []);
		}

		// Upsert or updateMany
		let sql: string;
		if (options?.upsert) {
			sql = `UPSERT ${this.table} ${setClause}`;
			if (whereClause) sql += ` WHERE ${whereClause}`;
		} else {
			sql = `UPDATE ${this.table} ${setClause}`;
			if (whereClause) sql += ` WHERE ${whereClause}`;
		}

		const rows = await this.exec<Record<string, unknown>[]>(sql, allBindings);

		let upsertedId: ObjectId | string | number | null = null;
		if (options?.upsert && rows && rows.length > 0) {
			upsertedId = recordToDocument(rows[0])._id as ObjectId | string | number;
		}

		return makeUpdateResult(rows || [], upsertedId);
	}

	// -----------------------------------------------------------------------
	// REPLACE
	// -----------------------------------------------------------------------

	/**
	 * Replaces a single document matching the filter.
	 */
	async replaceOne(
		filter: Filter<TSchema>,
		replacement: WithoutId<TSchema>,
		options?: ReplaceOptions,
	): Promise<UpdateResult> {
		const { clause: whereClause, bindings: filterBindings } = translateFilter(
			filter as Document,
		);

		if (!whereClause) {
			throw new MongoServerError("replaceOne requires a non-empty filter");
		}

		// First find the matching record to get its id
		const findSql = `SELECT * FROM ${this.table} WHERE ${whereClause} LIMIT 1`;
		const existing = await this.exec<Record<string, unknown>[]>(
			findSql,
			filterBindings,
		);

		if (!existing || existing.length === 0) {
			if (options?.upsert) {
				// Insert the replacement as a new document
				const prepared = prepareInsert(
					this.collectionName,
					replacement as Document,
				);
				await this.surreal.create(prepared.recordId as RecordId, prepared.data);
				return makeUpdateResult([], prepared.insertedId);
			}
			return makeUpdateResult([]);
		}

		// Replace the content of the found record
		const record = existing[0];
		const rid = record.id as RecordId;
		const paramOffset = Object.keys(filterBindings).length;
		const { clause: contentClause, bindings: contentBindings } =
			translateReplacement(replacement as Document, paramOffset);
		const allBindings = { ...filterBindings, ...contentBindings };

		const updateSql = `UPDATE $rid ${contentClause}`;
		allBindings.rid = rid;
		const rows = await this.exec<Record<string, unknown>[]>(
			updateSql,
			allBindings,
		);

		return makeUpdateResult(rows || []);
	}

	// -----------------------------------------------------------------------
	// DELETE
	// -----------------------------------------------------------------------

	/**
	 * Deletes the first document matching the filter.
	 */
	async deleteOne(filter: Filter<TSchema>): Promise<DeleteResult> {
		const { clause, bindings } = translateFilter(filter as Document);

		// SurrealQL doesn't support LIMIT on DELETE, so find first, then delete by id.
		let findSql = `SELECT id FROM ${this.table}`;
		if (clause) findSql += ` WHERE ${clause}`;
		findSql += " LIMIT 1";

		const found = await this.exec<Record<string, unknown>[]>(findSql, bindings);

		if (!found || found.length === 0) {
			return makeDeleteResult(0);
		}

		const rid = found[0].id;
		const deleteSql = "DELETE $__rid RETURN BEFORE";
		const rows = await this.exec<Record<string, unknown>[]>(deleteSql, {
			__rid: rid,
		});
		return makeDeleteResult(rows ? rows.length : 0);
	}

	/**
	 * Deletes all documents matching the filter.
	 */
	async deleteMany(filter?: Filter<TSchema>): Promise<DeleteResult> {
		const { clause, bindings } = translateFilter(filter as Document);

		let sql = `DELETE FROM ${this.table}`;
		if (clause) sql += ` WHERE ${clause}`;
		sql += " RETURN BEFORE";

		const rows = await this.exec<Record<string, unknown>[]>(sql, bindings);
		return makeDeleteResult(rows ? rows.length : 0);
	}

	// -----------------------------------------------------------------------
	// COUNT
	// -----------------------------------------------------------------------

	/**
	 * Returns the count of documents matching the filter.
	 */
	async countDocuments(
		filter?: Filter<TSchema>,
		options?: CountDocumentsOptions,
	): Promise<number> {
		const { clause, bindings } = translateFilter(filter as Document);

		let sql = `SELECT count() AS count FROM ${this.table}`;
		if (clause) sql += ` WHERE ${clause}`;
		sql += " GROUP ALL";

		if (options?.skip) {
			sql += ` START ${options.skip}`;
		}
		if (options?.limit) {
			sql += ` LIMIT ${options.limit}`;
		}

		const rows = await this.exec<{ count: number }[]>(sql, bindings);

		if (!rows || rows.length === 0) return 0;
		return rows[0].count ?? 0;
	}

	/**
	 * Returns an estimated count of all documents in the collection.
	 * For SurrealDB this is the same as an unfiltered count.
	 */
	async estimatedDocumentCount(): Promise<number> {
		return this.countDocuments();
	}

	// -----------------------------------------------------------------------
	// DISTINCT
	// -----------------------------------------------------------------------

	/**
	 * Returns an array of distinct values for the given field.
	 */
	async distinct<T = unknown>(
		key: string,
		filter?: Filter<TSchema>,
	): Promise<T[]> {
		const { clause, bindings } = translateFilter(filter as Document);

		let sql = `SELECT array::distinct(${key}) AS vals FROM ${this.table}`;
		if (clause) sql += ` WHERE ${clause}`;
		sql += " GROUP ALL";

		const rows = await this.exec<{ vals: T[] }[]>(sql, bindings);

		if (!rows || rows.length === 0) return [];
		return rows[0].vals ?? [];
	}

	// -----------------------------------------------------------------------
	// FIND-AND-MODIFY
	// -----------------------------------------------------------------------

	/**
	 * Atomically finds a document, updates it, and returns it.
	 */
	async findOneAndUpdate(
		filter: Filter<TSchema>,
		update: UpdateFilter<TSchema>,
		options?: FindOneAndUpdateOptions,
	): Promise<TSchema | null>;
	async findOneAndUpdate(
		filter: Filter<TSchema>,
		update: UpdateFilter<TSchema>,
		options: FindOneAndUpdateOptions & { includeResultMetadata: true },
	): Promise<ModifyResult<TSchema>>;
	async findOneAndUpdate(
		filter: Filter<TSchema>,
		update: UpdateFilter<TSchema>,
		options?: FindOneAndUpdateOptions,
	): Promise<TSchema | ModifyResult<TSchema> | null> {
		const returnBefore =
			!options?.returnDocument || options.returnDocument === "before";

		const { clause: whereClause, bindings: filterBindings } = translateFilter(
			filter as Document,
		);

		const paramOffset = Object.keys(filterBindings).length;
		const { clause: setClause, bindings: updateBindings } = translateUpdate(
			update as Document,
			paramOffset,
		);
		const allBindings = { ...filterBindings, ...updateBindings };

		const returnClause = returnBefore ? "RETURN BEFORE" : "RETURN AFTER";

		// SurrealQL doesn't support LIMIT on UPDATE, so find first, then update by id.
		let findSql = `SELECT id FROM ${this.table}`;
		if (whereClause) findSql += ` WHERE ${whereClause}`;
		findSql += " LIMIT 1";

		const found = await this.exec<Record<string, unknown>[]>(
			findSql,
			filterBindings,
		);

		if (!found || found.length === 0) {
			if (options?.includeResultMetadata) {
				return { value: null, ok: 0 } as ModifyResult<TSchema>;
			}
			return null;
		}

		const rid = found[0].id;
		allBindings.__rid = rid;
		const updateSql = `UPDATE $__rid ${setClause} ${returnClause}`;
		const rows = await this.exec<Record<string, unknown>[]>(
			updateSql,
			allBindings,
		);

		const value =
			rows && rows.length > 0 ? recordToDocument<TSchema>(rows[0]) : null;

		if (options?.includeResultMetadata) {
			return { value, ok: value ? 1 : 0 } as ModifyResult<TSchema>;
		}
		return value;
	}

	/**
	 * Atomically finds a document and deletes it.
	 */
	async findOneAndDelete(
		filter: Filter<TSchema>,
		options?: FindOneAndDeleteOptions,
	): Promise<TSchema | null>;
	async findOneAndDelete(
		filter: Filter<TSchema>,
		options: FindOneAndDeleteOptions & { includeResultMetadata: true },
	): Promise<ModifyResult<TSchema>>;
	async findOneAndDelete(
		filter: Filter<TSchema>,
		options?: FindOneAndDeleteOptions,
	): Promise<TSchema | ModifyResult<TSchema> | null> {
		const { clause, bindings } = translateFilter(filter as Document);

		// SurrealQL doesn't support LIMIT on DELETE, so find first, then delete by id.
		let findSql = `SELECT id FROM ${this.table}`;
		if (clause) findSql += ` WHERE ${clause}`;
		findSql += " LIMIT 1";

		const found = await this.exec<Record<string, unknown>[]>(findSql, bindings);

		if (!found || found.length === 0) {
			if (options?.includeResultMetadata) {
				return { value: null, ok: 0 } as ModifyResult<TSchema>;
			}
			return null;
		}

		const rid = found[0].id;
		const deleteSql = "DELETE $__rid RETURN BEFORE";
		const rows = await this.exec<Record<string, unknown>[]>(deleteSql, {
			__rid: rid,
		});

		const value =
			rows && rows.length > 0 ? recordToDocument<TSchema>(rows[0]) : null;

		if (options?.includeResultMetadata) {
			return { value, ok: value ? 1 : 0 } as ModifyResult<TSchema>;
		}
		return value;
	}

	/**
	 * Atomically finds a document and replaces it.
	 */
	async findOneAndReplace(
		filter: Filter<TSchema>,
		replacement: WithoutId<TSchema>,
		options?: FindOneAndReplaceOptions,
	): Promise<TSchema | null>;
	async findOneAndReplace(
		filter: Filter<TSchema>,
		replacement: WithoutId<TSchema>,
		options: FindOneAndReplaceOptions & { includeResultMetadata: true },
	): Promise<ModifyResult<TSchema>>;
	async findOneAndReplace(
		filter: Filter<TSchema>,
		replacement: WithoutId<TSchema>,
		options?: FindOneAndReplaceOptions,
	): Promise<TSchema | ModifyResult<TSchema> | null> {
		const returnBefore =
			!options?.returnDocument || options.returnDocument === "before";

		const { clause: whereClause, bindings: filterBindings } = translateFilter(
			filter as Document,
		);

		if (!whereClause) {
			throw new MongoServerError(
				"findOneAndReplace requires a non-empty filter",
			);
		}

		// Find the matching record
		const findSql = `SELECT * FROM ${this.table} WHERE ${whereClause} LIMIT 1`;
		const existing = await this.exec<Record<string, unknown>[]>(
			findSql,
			filterBindings,
		);

		if (!existing || existing.length === 0) {
			if (options?.includeResultMetadata) {
				return { value: null, ok: 0 } as ModifyResult<TSchema>;
			}
			return null;
		}

		const before = recordToDocument<TSchema>(existing[0]);
		const rid = existing[0].id as RecordId;

		// Replace
		const paramOffset = Object.keys(filterBindings).length;
		const { clause: contentClause, bindings: contentBindings } =
			translateReplacement(replacement as Document, paramOffset);
		const allBindings = { ...filterBindings, ...contentBindings };
		allBindings.rid = rid;

		const updateSql = `UPDATE $rid ${contentClause} RETURN AFTER`;
		const rows = await this.exec<Record<string, unknown>[]>(
			updateSql,
			allBindings,
		);

		const after =
			rows && rows.length > 0 ? recordToDocument<TSchema>(rows[0]) : null;

		const value = returnBefore ? before : after;

		if (options?.includeResultMetadata) {
			return { value, ok: value ? 1 : 0 } as ModifyResult<TSchema>;
		}
		return value;
	}
}

// ---------------------------------------------------------------------------
// Internal helpers for executing queries from FindCursor
// ---------------------------------------------------------------------------

/**
 * Execute a find query and return mapped documents.
 * @internal – called by FindCursor.
 */
export async function executeFind<TSchema extends Document>(
	collection: Collection<TSchema>,
	filter: Document | undefined,
	options: {
		sort?: Sort;
		limit?: number;
		skip?: number;
		projectionFields?: string;
		projectionExcludeFields?: string[];
		projectionIncludeId?: boolean;
	},
): Promise<TSchema[]> {
	const { clause, bindings } = translateFilter(filter);
	const sortClause = translateSort(options.sort);

	const fields = options.projectionFields || "*";
	let sql = `SELECT ${fields} FROM ${escapeTable(collection.collectionName)}`;
	if (clause) sql += ` WHERE ${clause}`;
	if (sortClause) sql += ` ${sortClause}`;
	if (options.limit !== undefined) sql += ` LIMIT ${options.limit}`;
	if (options.skip !== undefined) sql += ` START ${options.skip}`;

	let rows: Record<string, unknown>[];
	try {
		const results = await collection._db._client._surreal.query<
			[Record<string, unknown>[]]
		>(sql, bindings);
		rows = results[0] ?? [];
	} catch (err) {
		throw new MongoServerError(
			err instanceof Error ? err.message : String(err),
		);
	}

	let docs = rows.map((r) => recordToDocument<TSchema>(r));

	// Apply exclusion projection / _id suppression if needed
	const needsPostProcess =
		(options.projectionExcludeFields &&
			options.projectionExcludeFields.length > 0) ||
		options.projectionIncludeId === false;

	if (needsPostProcess) {
		docs = docs.map(
			(d) =>
				applyProjection(
					d,
					options.projectionExcludeFields ?? [],
					options.projectionIncludeId ?? true,
				) as TSchema,
		);
	}

	return docs;
}

/**
 * @internal Factory that avoids circular-import issues.
 */
export function createCollection<TSchema extends Document>(
	db: Db,
	name: string,
): Collection<TSchema> {
	return new Collection<TSchema>(db, name);
}
