/**
 * A collection that does not exist reads as an empty one.
 *
 * MongoDB has no concept of "you have not created that collection yet" on a
 * read: `find` answers `[]`, `countDocuments` `0`, `deleteMany`
 * `{deletedCount: 0}`. SurrealDB refuses to read a table it holds no definition
 * for, and the whole point of the tests below is that the refusal is read as
 * emptiness *only* when it is genuinely about this collection — a mistyped
 * database name must still fail loudly rather than look like no data.
 */

import { describe, expect, test } from "bun:test";
import { NotFoundError } from "surrealdb";
import {
	countDocuments,
	estimatedDocumentCount,
} from "../../../../src/collection/operations/count.ts";
import {
	deleteMany,
	deleteOne,
} from "../../../../src/collection/operations/delete.ts";
import { distinct } from "../../../../src/collection/operations/distinct.ts";
import {
	executeFind,
	findOne,
} from "../../../../src/collection/operations/find.ts";
import {
	findOneAndDelete,
	findOneAndReplace,
	findOneAndUpdate,
} from "../../../../src/collection/operations/find-and-modify.ts";
import { insertOne } from "../../../../src/collection/operations/insert.ts";
import { replaceOne } from "../../../../src/collection/operations/replace.ts";
import {
	updateMany,
	updateOne,
} from "../../../../src/collection/operations/update.ts";
import { MongoErrorCode, MongoServerError } from "../../../../src/errors.ts";
import { mapQueryError } from "../../../../src/surreal/error-mapper.ts";
import { FakeQueryExecutor } from "../../../helpers/fake-executor.ts";
import { makeContext } from "../../../helpers/operation-context.ts";

/**
 * A `NotFound` as the SDK delivers it, already translated — which is the form an
 * operation sees, since the executor maps every SurrealDB error on the way out.
 *
 * `kind` on the wire is the *category* (`"NotFound"`); what was not found lives
 * in `details.kind`, which is the discriminator the tolerance turns on.
 */
function notFound(
	kind: "Table" | "Namespace" | "Database",
	name: string,
): MongoServerError {
	return mapQueryError(
		new NotFoundError({
			kind: "NotFound",
			message: `The ${kind.toLowerCase()} '${name}' does not exist`,
			details: { kind, details: { name } },
		}),
	) as MongoServerError;
}

/** An executor whose every statement fails the way `err` describes. */
function failingWith(err: unknown): FakeQueryExecutor {
	const executor = new FakeQueryExecutor();
	executor.onQuery(() => {
		throw err;
	});
	return executor;
}

/** A context whose collection has never been written to. */
function undefinedCollection() {
	return makeContext({
		collectionName: "ghosts",
		executor: failingWith(notFound("Table", "ghosts")),
	});
}

describe("reads against a collection that does not exist", () => {
	test("find answers with no documents", async () => {
		const { ctx } = undefinedCollection();
		expect(await executeFind(ctx, {}, {})).toEqual([]);
	});

	test("findOne answers null", async () => {
		const { ctx } = undefinedCollection();
		expect(await findOne(ctx, {})).toBeNull();
	});

	test("countDocuments and estimatedDocumentCount answer zero", async () => {
		expect(await countDocuments(undefinedCollection().ctx, {})).toBe(0);
		expect(await estimatedDocumentCount(undefinedCollection().ctx)).toBe(0);
	});

	test("a bounded count answers zero too", async () => {
		// Bounding counts a subquery rather than the table, so it is a second
		// statement shape that has to tolerate the same failure.
		const { ctx } = undefinedCollection();
		expect(await countDocuments(ctx, {}, { skip: 1, limit: 2 })).toBe(0);
	});

	test("distinct answers with no values", async () => {
		const { ctx } = undefinedCollection();
		expect(await distinct(ctx, "name")).toEqual([]);
	});
});

describe("writes that match nothing in a collection that does not exist", () => {
	test("deleteOne and deleteMany report nothing deleted", async () => {
		expect(
			(await deleteOne(undefinedCollection().ctx, { a: 1 })).deletedCount,
		).toBe(0);
		expect((await deleteMany(undefinedCollection().ctx, {})).deletedCount).toBe(
			0,
		);
	});

	test("updateOne and updateMany report nothing matched", async () => {
		const one = await updateOne(undefinedCollection().ctx, { a: 1 }, {
			$set: { b: 2 },
		} as never);
		expect(one.matchedCount).toBe(0);
		expect(one.upsertedId).toBeNull();

		const many = await updateMany(undefinedCollection().ctx, {}, {
			$set: { b: 2 },
		} as never);
		expect(many.matchedCount).toBe(0);
	});

	test("replaceOne reports nothing matched", async () => {
		const result = await replaceOne(undefinedCollection().ctx, { a: 1 }, {
			b: 2,
		} as never);
		expect(result.matchedCount).toBe(0);
	});

	test("all three findOneAnd* answer null", async () => {
		expect(
			await findOneAndUpdate(undefinedCollection().ctx, { a: 1 }, {
				$set: { b: 2 },
			} as never),
		).toBeNull();
		expect(
			await findOneAndDelete(undefinedCollection().ctx, { a: 1 }),
		).toBeNull();
		expect(
			await findOneAndReplace(undefinedCollection().ctx, { a: 1 }, {
				b: 2,
			} as never),
		).toBeNull();
	});
});

describe("failures that are not this collection being empty", () => {
	test("a missing namespace still throws", async () => {
		// The one failure this tolerance must never absorb. Code 26 covers a missing
		// namespace as well as a missing table, so a driver keying off the code alone
		// would answer `[]` for a connection pointed at a namespace that is not
		// there — a typo in a connection string looking exactly like an empty
		// dataset.
		const { ctx } = makeContext({
			collectionName: "ghosts",
			executor: failingWith(notFound("Namespace", "nope")),
		});

		await expect(executeFind(ctx, {}, {})).rejects.toThrow(MongoServerError);
		await expect(countDocuments(ctx, {})).rejects.toMatchObject({
			code: MongoErrorCode.NamespaceNotFound,
		});
		await expect(deleteMany(ctx, {})).rejects.toThrow(MongoServerError);
		await expect(findOneAndDelete(ctx, {})).rejects.toThrow(MongoServerError);
	});

	test("a missing database still throws", async () => {
		const { ctx } = makeContext({
			collectionName: "ghosts",
			executor: failingWith(notFound("Database", "nope")),
		});

		await expect(executeFind(ctx, {}, {})).rejects.toThrow(MongoServerError);
		await expect(findOne(ctx, {})).rejects.toThrow(MongoServerError);
	});

	test("a missing table that is some other table still throws", async () => {
		// The name is checked, not just the kind: a statement that fails over a
		// different table is reporting something this collection cannot explain.
		const { ctx } = makeContext({
			collectionName: "ghosts",
			executor: failingWith(notFound("Table", "somewhere_else")),
		});

		await expect(executeFind(ctx, {}, {})).rejects.toThrow(MongoServerError);
		await expect(distinct(ctx, "name")).rejects.toThrow(MongoServerError);
	});

	test("an insert is never told the collection is empty", async () => {
		// Its whole purpose is to bring the table into existence, so a missing table
		// reported to it is a real failure rather than an answer.
		const { ctx } = undefinedCollection();
		await expect(insertOne(ctx, { a: 1 })).rejects.toThrow(MongoServerError);
	});
});
