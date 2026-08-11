/**
 * `createIndex` / `dropIndex` / `listIndexes` operations.
 */

import { escapeFieldList, escapeIdentifier } from "../../surreal/sql/escape.ts";
import type {
	CreateIndexOptions,
	IndexDescription,
	IndexSpecification,
} from "../../types.ts";
import type { OperationContext } from "../operation-context.ts";

/**
 * Auto-generate an index name from its spec, mirroring MongoDB's
 * `field_1_other_-1` convention. SurrealQL identifiers can't contain
 * `-`, so descending markers become `neg`.
 */
function generateIndexName(spec: IndexSpecification): string {
	return Object.entries(spec)
		.map(([k, v]) => `${k}_${String(v).replace("-", "neg")}`)
		.join("_");
}

export async function createIndex(
	ctx: OperationContext,
	spec: IndexSpecification,
	options?: CreateIndexOptions,
): Promise<string> {
	const entries = Object.entries(spec);
	const isTextIndex = entries.some(([, v]) => v === "text");

	const name = options?.name ?? generateIndexName(spec);
	const escapedName = escapeIdentifier(name);
	const fields = escapeFieldList(entries.map(([k]) => k));

	if (isTextIndex) {
		const ensureAnalyzer = ctx.dialect.ensureBlankAnalyzerSql();
		if (ensureAnalyzer) {
			await ctx.executor.query(ensureAnalyzer);
		}
		await ctx.executor.query(
			`DEFINE INDEX ${escapedName} ON ${ctx.escapedTable} FIELDS ${fields} ${ctx.dialect.fullTextKeyword} ANALYZER blank BM25 HIGHLIGHTS`,
		);
	} else {
		await ctx.executor.query(
			`DEFINE INDEX ${escapedName} ON ${ctx.escapedTable} FIELDS ${fields}`,
		);
	}

	ctx.indexes.add(spec, name);
	return name;
}

export async function dropIndex(
	ctx: OperationContext,
	name: string,
): Promise<void> {
	await ctx.executor.query(`REMOVE INDEX ${name} ON ${ctx.escapedTable}`);
	ctx.indexes.remove(name);
}

export function listIndexes(ctx: OperationContext): IndexDescription[] {
	return ctx.indexes.list();
}
