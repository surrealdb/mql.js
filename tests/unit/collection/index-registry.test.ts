import { describe, expect, test } from "bun:test";
import { IndexRegistry } from "../../../src/collection/index-registry.ts";

describe("IndexRegistry", () => {
	test("starts empty and unloaded", () => {
		const r = new IndexRegistry();
		expect(r.textFields).toEqual([]);
		expect(r.loaded).toBe(false);
	});

	test("text-typed fields are tracked in key order", () => {
		const r = new IndexRegistry();
		r.add({ title: "text", body: "text" }, "title_text_body_text");
		expect(r.textFields).toEqual(["title", "body"]);
	});

	test("non-text indexes do not pollute textFields", () => {
		const r = new IndexRegistry();
		r.add({ a: 1, b: -1 }, "a_1_b_-1");
		expect(r.textFields).toEqual([]);
	});

	test("remove() drops the index and its text fields", () => {
		const r = new IndexRegistry();
		r.add({ title: "text" }, "title_text");
		r.add({ a: 1 }, "a_1");
		r.remove("title_text");
		expect(r.textFields).toEqual([]);
	});

	test("remove() of an unknown index is a no-op", () => {
		const r = new IndexRegistry();
		r.add({ title: "text" }, "title_text");
		r.remove("does-not-exist");
		expect(r.textFields).toEqual(["title"]);
	});

	test("re-adding the same name replaces its key rather than duplicating it", () => {
		const r = new IndexRegistry();
		r.add({ title: "text" }, "ix");
		r.add({ body: "text" }, "ix");
		expect(r.textFields).toEqual(["body"]);
	});

	test("sync() replaces the cache with the server's view and marks it loaded", () => {
		const r = new IndexRegistry();
		r.add({ stale: "text" }, "stale_text");

		r.sync([
			{ name: "_id_", key: { _id: 1 } },
			{ name: "bio_text", key: { bio: "text" } },
		]);

		expect(r.textFields).toEqual(["bio"]);
		expect(r.loaded).toBe(true);
	});

	test("sync() with no indexes still marks the cache loaded", () => {
		const r = new IndexRegistry();
		r.sync([]);
		expect(r.textFields).toEqual([]);
		expect(r.loaded).toBe(true);
	});
});
