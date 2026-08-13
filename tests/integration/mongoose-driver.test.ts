/**
 * `mongoose.connect()` against this driver, through `mongoose.setDriver()`.
 *
 * The other mongoose test hand-wires a connection, because until now that was the
 * only way. This one uses mongoose the way its documentation says to — `connect`,
 * models, queries, sessions — so what is asserted is that an ORM's own entry
 * point works, not that our objects satisfy an interface when placed by hand.
 *
 * It runs against a live server for the same reason: mongoose issues its own
 * queries through our `Collection`, and whether those come back in the shape it
 * expects is a claim about SurrealDB's answers, not about our types.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import mongoose from "mongoose";
import { MongoClient } from "../../src/index.ts";
import { mqlDriver } from "../../src/mongoose.ts";
import { waitForSurreal } from "./helpers.ts";

const PORT = 18146;
const URI = `mongodb://root:root@127.0.0.1:${PORT}/moosedb?namespace=moose`;

let proc: Subprocess;
let connection: mongoose.Mongoose;

interface AuthorDoc {
	name: string;
	born?: number;
}

beforeAll(async () => {
	proc = Bun.spawn(
		[
			"surreal",
			"start",
			"--bind",
			`127.0.0.1:${PORT}`,
			"--username",
			"root",
			"--password",
			"root",
			"memory",
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	await waitForSurreal(PORT);

	mongoose.setDriver(mqlDriver(mongoose));
	connection = await mongoose.connect(URI);
});

afterAll(async () => {
	await mongoose.disconnect().catch(() => {});
	proc.kill();
});

const Author = mongoose.model<AuthorDoc>(
	"Author",
	new mongoose.Schema<AuthorDoc>({ name: String, born: Number }),
);
const Book = mongoose.model(
	"Book",
	new mongoose.Schema({
		title: String,
		author: { type: mongoose.Schema.Types.ObjectId, ref: "Author" },
	}),
);

describe("mongoose.connect() through setDriver", () => {
	test("connects, and reports itself connected", () => {
		// 1 is mongoose's STATES.connected. Reaching it means `createClient` ran and
		// `onOpen()` fired — the connection is not merely constructed.
		expect(connection.connection.readyState).toBe(1);
		expect(mongoose.connection.name).toBe("moosedb");
	});

	test("the client behind it is this driver's, not mongodb's", () => {
		// `client` is set by our `createClient`; mongoose's typings describe the
		// bundled driver's, which is exactly the class this replaces.
		expect(
			(mongoose.connection as unknown as { client: unknown }).client,
		).toBeInstanceOf(MongoClient);
	});

	test("save and read a document back through a model", async () => {
		const saved = await Author.create({ name: "Ursula", born: 1929 });
		expect(saved._id).toBeDefined();

		const found = await Author.findById(saved._id);
		expect(found?.name).toBe("Ursula");
		expect(found?.born).toBe(1929);
	});

	test("query helpers reach this driver's operations", async () => {
		await Author.create([{ name: "Octavia" }, { name: "Samuel" }]);

		expect(await Author.countDocuments({ name: "Octavia" })).toBe(1);
		expect((await Author.find({ name: /^O/ }).lean()).length).toBe(1);
		expect((await Author.distinct("name")).length).toBeGreaterThanOrEqual(3);
	});

	test("updates and deletes report mongoose's own result shapes", async () => {
		const author = await Author.create({ name: "Temporary" });

		const updated = await Author.updateOne(
			{ _id: author._id },
			{ $set: { name: "Renamed" } },
		);
		expect(updated.modifiedCount).toBe(1);

		const after = await Author.findById(author._id);
		expect(after?.name).toBe("Renamed");

		const deleted = await Author.deleteOne({ _id: author._id });
		expect(deleted.deletedCount).toBe(1);
	});

	test("populate() resolves a reference across two models", async () => {
		const author = await Author.create({ name: "Joanna" });
		await Book.create({ title: "The Female Man", author: author._id });

		const book = await Book.findOne({ title: "The Female Man" }).populate<{
			author: AuthorDoc;
		}>("author");
		expect(book?.author?.name).toBe("Joanna");
	});

	test("listCollections reaches the cursor mongoose expects", async () => {
		// The shape that used to fail: mongoose calls `db.listCollections()` and
		// consumes the cursor. A promise of an array has no `.toArray`.
		const names = (await mongoose.connection.listCollections()).map(
			(c: { name: string }) => c.name,
		);
		expect(names).toContain("authors");
	});

	test("a transaction commits through mongoose's own session API", async () => {
		const before = await Author.countDocuments({ name: "Committed" });
		await mongoose.connection.transaction(async (session) => {
			await Author.create([{ name: "Committed" }], { session });
		});
		expect(await Author.countDocuments({ name: "Committed" })).toBe(before + 1);
	});

	test("a transaction rolls back, leaving nothing behind", async () => {
		await mongoose.connection
			.transaction(async (session) => {
				await Author.create([{ name: "RolledBack" }], { session });
				throw new Error("abort this transaction");
			})
			.catch(() => {});

		expect(await Author.countDocuments({ name: "RolledBack" })).toBe(0);
	});
});
