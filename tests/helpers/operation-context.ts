/**
 * Build an `OperationContext` for unit tests with sensible defaults and
 * an injectable `FakeQueryExecutor`.
 */

import { IndexRegistry } from "../../src/collection/index-registry.ts";
import type { OperationContext } from "../../src/collection/operation-context.ts";
import { escapeIdentifier } from "../../src/surreal/sql/escape.ts";
import {
	resolveDialect,
	type SurrealDialect,
} from "../../src/translators/dialect/index.ts";
import { FakeQueryExecutor } from "./fake-executor.ts";

export interface FakeContextOptions {
	collectionName?: string;
	dialect?: SurrealDialect;
	indexes?: IndexRegistry;
	executor?: FakeQueryExecutor;
}

export interface FakeContextResult {
	ctx: OperationContext;
	executor: FakeQueryExecutor;
	indexes: IndexRegistry;
}

export function makeContext(
	options: FakeContextOptions = {},
): FakeContextResult {
	const executor = options.executor ?? new FakeQueryExecutor();
	const indexes = options.indexes ?? new IndexRegistry();
	const collectionName = options.collectionName ?? "users";
	const dialect = options.dialect ?? resolveDialect(undefined);

	const ctx: OperationContext = {
		executor,
		collectionName,
		escapedTable: escapeIdentifier(collectionName),
		dialect,
		indexes,
	};
	return { ctx, executor, indexes };
}
