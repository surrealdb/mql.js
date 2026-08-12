/**
 * Addressing a database other than the connected one.
 *
 * The mechanism is a `USE DB` prefix, and the prefix costs a result frame. The
 * two therefore have to be produced together, because a statement that is
 * prefixed and then read at frame 0 answers with the reply to the `USE` — a
 * plausible-looking object — instead of with the caller's own rows. These tests
 * pin that arithmetic, and pin that an unprefixed statement is still read at
 * frame 0, which is what keeps the connected database free of the whole thing.
 */

import { describe, expect, test } from "bun:test";
import {
	ScopedExecutor,
	scopeStatement,
} from "../../../src/surreal/database-scope.ts";
import type { QueryExecutor } from "../../../src/surreal/query-executor.ts";

/** An executor whose dispatch records what it was sent and replies per frame. */
class RecordingExecutor extends ScopedExecutor {
	readonly sent: string[] = [];
	/** One reply per statement in the last dispatch, keyed by frame index. */
	frames: readonly unknown[] = [];
	version: string | undefined = "3.2.4";
	closed = 0;

	get serverVersion(): string | undefined {
		return this.version;
	}

	protected async dispatch(sql: string): Promise<readonly unknown[]> {
		this.sent.push(sql);
		return this.frames;
	}

	async close(): Promise<void> {
		this.closed += 1;
	}
}

describe("scopeStatement", () => {
	test("leaves the connected database's statement exactly as it was", () => {
		expect(scopeStatement("SELECT * FROM users", undefined)).toEqual({
			sql: "SELECT * FROM users",
			frame: 0,
		});
	});

	test("prefixes a named database, and moves the frame with it", () => {
		expect(scopeStatement("SELECT * FROM users", "other")).toEqual({
			sql: "USE DB `other`; SELECT * FROM users",
			frame: 1,
		});
	});

	test("escapes a database name that cannot be emitted bare", () => {
		expect(scopeStatement("SELECT 1", "my-db").sql).toBe(
			"USE DB `my-db`; SELECT 1",
		);
		// A name that could otherwise close the quoted region and add statements of
		// its own.
		expect(scopeStatement("SELECT 1", "a`; REMOVE DATABASE x; --").sql).toBe(
			"USE DB `a\\`; REMOVE DATABASE x; --`; SELECT 1",
		);
	});

	test("quotes a name that opens a statement of its own after USE DB", () => {
		// Bare, each of these is a parse error on 3.x: the parser reads the word as
		// the start of a statement or a literal and then wants the rest of it. They
		// are ordinary MongoDB database names, so the prefix quotes every name rather
		// than only the ones a table position would need quoted.
		for (const name of ["function", "alter", "sleep", "select", "and"]) {
			expect(scopeStatement("SELECT 1", name).sql).toBe(
				`USE DB \`${name}\`; SELECT 1`,
			);
		}
	});
});

describe("reading the caller's own result", () => {
	test("an unprefixed statement answers from the first frame", async () => {
		const executor = new RecordingExecutor(undefined);
		executor.frames = ["mine", "later"];

		expect(await executor.query<string>("SELECT 1")).toBe("mine");
		expect(executor.sent).toEqual(["SELECT 1"]);
	});

	test("a prefixed statement skips the frame the prefix answered in", async () => {
		const executor = new RecordingExecutor("other");
		executor.frames = [{ database: "other", namespace: "ns" }, "mine"];

		expect(await executor.query<string>("SELECT 1")).toBe("mine");
		expect(executor.sent).toEqual(["USE DB `other`; SELECT 1"]);
	});

	test("a batch still answers with its first statement", async () => {
		// Several statements in one query are read as the first one's result, and the
		// prefix must not change which one that is.
		const executor = new RecordingExecutor("other");
		executor.frames = [{ database: "other" }, "first", "second"];

		expect(await executor.query<string>("DEFINE TABLE t; SELECT 1")).toBe(
			"first",
		);
	});
});

describe("forDatabase", () => {
	test("the connected database is the executor itself, not a wrapper", () => {
		const executor = new RecordingExecutor(undefined);
		expect(executor.forDatabase(undefined)).toBe(executor);
	});

	test("a view sends through the executor it came from", async () => {
		const executor = new RecordingExecutor(undefined);
		executor.frames = [{ database: "other" }, "mine"];
		const view = executor.forDatabase("other");

		expect(await view.query<string>("SELECT 1")).toBe("mine");
		expect(executor.sent).toEqual(["USE DB `other`; SELECT 1"]);
	});

	test("a view addressing the same database is that same view", () => {
		const executor = new RecordingExecutor(undefined);
		const view = executor.forDatabase("other") as ScopedExecutor;
		expect(view.forDatabase("other")).toBe(view);
	});

	test("a view of a view prefixes once, for the database last named", async () => {
		const executor = new RecordingExecutor(undefined);
		executor.frames = [{ database: "third" }, "mine"];
		const view = (executor.forDatabase("other") as ScopedExecutor).forDatabase(
			"third",
		);

		expect(await view.query<string>("SELECT 1")).toBe("mine");
		expect(executor.sent).toEqual(["USE DB `third`; SELECT 1"]);
	});

	test("a view reads the server version through, rather than copying it", () => {
		const executor = new RecordingExecutor(undefined);
		executor.version = undefined;
		const view: QueryExecutor = executor.forDatabase("other");

		// A `db(name)` obtained before `connect()` builds its view before the version
		// is known, and must still resolve the dialect once it is.
		executor.version = "3.1.5";
		expect(view.serverVersion).toBe("3.1.5");
	});

	test("closing a view closes what it is a view of", async () => {
		const executor = new RecordingExecutor(undefined);
		await executor.forDatabase("other").close();
		expect(executor.closed).toBe(1);
	});
});
