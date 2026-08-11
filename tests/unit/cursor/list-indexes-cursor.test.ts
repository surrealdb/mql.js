import { describe, expect, test } from "bun:test";
import { ListIndexesCursor } from "../../../src/cursor/list-indexes-cursor.ts";
import { MongoCursorExhaustedError } from "../../../src/errors.ts";
import type { IndexDescriptionInfo } from "../../../src/types.ts";

const INDEXES: IndexDescriptionInfo[] = [
	{ name: "_id_", key: { _id: 1 } },
	{ name: "age_1", key: { age: 1 } },
];

/** A cursor plus a count of how many times it fetched its listing. */
function makeCursor(): { cursor: ListIndexesCursor; runs: () => number } {
	let runs = 0;
	const cursor = new ListIndexesCursor(async () => {
		runs += 1;
		return INDEXES.map((index) => ({ ...index }));
	});
	return { cursor, runs: () => runs };
}

describe("ListIndexesCursor", () => {
	test("toArray returns the whole listing", async () => {
		const { cursor } = makeCursor();
		expect(await cursor.toArray()).toEqual(INDEXES);
	});

	test("toArray hands back a copy, so mutation cannot corrupt the cursor", async () => {
		const { cursor } = makeCursor();
		(await cursor.toArray()).pop();
		expect(await cursor.toArray()).toHaveLength(2);
	});

	test("the listing is fetched once, however it is consumed", async () => {
		const { cursor, runs } = makeCursor();
		await cursor.hasNext();
		await cursor.next();
		await cursor.toArray();
		expect(runs()).toBe(1);
	});

	test("next walks the listing then returns null", async () => {
		const { cursor } = makeCursor();
		expect((await cursor.next())?.name).toBe("_id_");
		expect((await cursor.next())?.name).toBe("age_1");
		expect(await cursor.next()).toBeNull();
	});

	test("hasNext reflects the remaining entries", async () => {
		const { cursor } = makeCursor();
		expect(await cursor.hasNext()).toBe(true);
		await cursor.next();
		await cursor.next();
		expect(await cursor.hasNext()).toBe(false);
	});

	test("async iteration yields every entry", async () => {
		const { cursor } = makeCursor();
		const names: string[] = [];
		for await (const index of cursor) names.push(index.name);
		expect(names).toEqual(["_id_", "age_1"]);
	});

	test("forEach stops early when the callback returns false", async () => {
		const { cursor } = makeCursor();
		const names: string[] = [];
		// biome-ignore lint/suspicious/useIterableCallbackReturn: forEach() short-circuits on `false` per the MongoDB driver contract.
		await cursor.forEach((index) => {
			names.push(index.name);
			return false;
		});
		expect(names).toEqual(["_id_"]);
	});

	test("a closed cursor cannot be consumed again", async () => {
		const { cursor } = makeCursor();
		await cursor.close();
		expect(cursor.closed).toBe(true);
		await expect(cursor.toArray()).rejects.toThrow(MongoCursorExhaustedError);
		await expect(cursor.next()).rejects.toThrow(MongoCursorExhaustedError);
	});

	test("rewind re-reads the listing from the start", async () => {
		const { cursor, runs } = makeCursor();
		await cursor.next();
		cursor.rewind();
		expect((await cursor.next())?.name).toBe("_id_");
		expect(runs()).toBe(2);
	});

	test("clone is an independent cursor over the same listing", async () => {
		const { cursor } = makeCursor();
		await cursor.next();
		const clone = cursor.clone();
		expect((await clone.next())?.name).toBe("_id_");
	});
});
