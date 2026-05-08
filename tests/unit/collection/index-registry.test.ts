import { describe, expect, test } from "bun:test";
import { IndexRegistry } from "../../../src/collection/index-registry.ts";

describe("IndexRegistry", () => {
	test("starts empty", () => {
		const r = new IndexRegistry();
		expect(r.list()).toEqual([]);
		expect(r.textFields).toEqual([]);
	});

	test("add() records the index in insertion order", () => {
		const r = new IndexRegistry();
		r.add({ a: 1 }, "a_1");
		r.add({ b: -1 }, "b_neg1");
		expect(r.list()).toEqual([
			{ name: "a_1", key: { a: 1 } },
			{ name: "b_neg1", key: { b: -1 } },
		]);
	});

	test("list() returns a snapshot, not the live array", () => {
		const r = new IndexRegistry();
		r.add({ a: 1 }, "a_1");
		const snap = r.list();
		snap.pop();
		expect(r.list().length).toBe(1);
	});

	test("text-typed fields are tracked separately", () => {
		const r = new IndexRegistry();
		r.add({ title: "text", body: "text" }, "fulltext");
		expect(r.textFields).toEqual(["title", "body"]);
	});

	test("non-text indexes do not pollute textFields", () => {
		const r = new IndexRegistry();
		r.add({ a: 1, b: -1 }, "ab");
		expect(r.textFields).toEqual([]);
	});

	test("remove() drops the index and its text fields", () => {
		const r = new IndexRegistry();
		r.add({ title: "text" }, "title_text");
		r.add({ a: 1 }, "a_1");
		r.remove("title_text");
		expect(r.list()).toEqual([{ name: "a_1", key: { a: 1 } }]);
		expect(r.textFields).toEqual([]);
	});

	test("remove() of an unknown index is a no-op", () => {
		const r = new IndexRegistry();
		r.add({ a: 1 }, "a_1");
		r.remove("does-not-exist");
		expect(r.list().length).toBe(1);
	});

	test("textFields reflects only currently-defined indexes", () => {
		const r = new IndexRegistry();
		r.add({ title: "text" }, "title_text");
		r.add({ body: "text" }, "body_text");
		expect(r.textFields).toEqual(["title", "body"]);
		r.remove("title_text");
		expect(r.textFields).toEqual(["body"]);
	});

	test("textFields is a readonly view (compile-time) and reads back the live state", () => {
		const r = new IndexRegistry();
		r.add({ title: "text" }, "title_text");
		expect(r.textFields).toContain("title");
	});
});
