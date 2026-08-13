/**
 * The emitter's semantics, pinned against node's.
 *
 * It is written out rather than inherited from `node:events` — importing that
 * fails the browser bundle — so every behaviour a caller could tell apart from
 * node's is asserted here rather than assumed from the base class.
 */

import { describe, expect, test } from "bun:test";
import { MqlEventEmitter } from "../../../src/client/event-emitter.ts";

describe("MqlEventEmitter", () => {
	test("a listener receives every argument, and emit reports it ran", () => {
		const emitter = new MqlEventEmitter();
		const seen: unknown[][] = [];
		emitter.on("thing", (...args) => seen.push(args));

		expect(emitter.emit("thing", 1, "two", { three: true })).toBe(true);
		expect(seen).toEqual([[1, "two", { three: true }]]);
	});

	test("emit reports false when nothing is listening", () => {
		expect(new MqlEventEmitter().emit("thing")).toBe(false);
	});

	test("listeners run in the order they were added", () => {
		const emitter = new MqlEventEmitter();
		const order: string[] = [];
		emitter.on("thing", () => order.push("first"));
		emitter.on("thing", () => order.push("second"));
		emitter.on("thing", () => order.push("third"));

		emitter.emit("thing");
		expect(order).toEqual(["first", "second", "third"]);
	});

	test("the same function added twice is called twice", () => {
		// Node counts registrations, not functions.
		const emitter = new MqlEventEmitter();
		let calls = 0;
		const listener = () => {
			calls += 1;
		};
		emitter.on("thing", listener).on("thing", listener);

		emitter.emit("thing");
		expect(calls).toBe(2);
		expect(emitter.listenerCount("thing")).toBe(2);
	});

	test("removeListener removes one registration, not both", () => {
		const emitter = new MqlEventEmitter();
		const listener = () => {};
		emitter.on("thing", listener).on("thing", listener);

		emitter.removeListener("thing", listener);
		expect(emitter.listenerCount("thing")).toBe(1);
	});

	test("once fires exactly once and then detaches", () => {
		const emitter = new MqlEventEmitter();
		let calls = 0;
		emitter.once("thing", () => {
			calls += 1;
		});

		emitter.emit("thing");
		emitter.emit("thing");
		expect(calls).toBe(1);
		expect(emitter.listenerCount("thing")).toBe(0);
	});

	test("a once listener that re-emits its own event is not called again", () => {
		// Detached *before* the call, which is what makes the re-entrant emit safe
		// rather than infinitely recursive.
		const emitter = new MqlEventEmitter();
		let calls = 0;
		emitter.once("thing", () => {
			calls += 1;
			if (calls < 5) emitter.emit("thing");
		});

		emitter.emit("thing");
		expect(calls).toBe(1);
	});

	test("a listener removed during an emit is still not skipped over", () => {
		// The list is snapshotted per emit: removing the *first* listener from
		// inside it must not shift the second out of that emit's turn, which is the
		// classic index-walking bug.
		const emitter = new MqlEventEmitter();
		const order: string[] = [];
		const first = () => {
			order.push("first");
			emitter.off("thing", first);
		};
		emitter.on("thing", first);
		emitter.on("thing", () => order.push("second"));

		emitter.emit("thing");
		expect(order).toEqual(["first", "second"]);
		expect(emitter.listenerCount("thing")).toBe(1);
	});

	test("a listener added during an emit is not called by that emit", () => {
		const emitter = new MqlEventEmitter();
		const order: string[] = [];
		emitter.on("thing", () => {
			order.push("first");
			emitter.on("thing", () => order.push("late"));
		});

		emitter.emit("thing");
		expect(order).toEqual(["first"]);

		emitter.emit("thing");
		expect(order).toEqual(["first", "first", "late"]);
	});

	test("removeAllListeners clears one event or all of them", () => {
		const emitter = new MqlEventEmitter();
		emitter.on("a", () => {}).on("b", () => {});

		emitter.removeAllListeners("a");
		expect(emitter.eventNames()).toEqual(["b"]);

		emitter.removeAllListeners();
		expect(emitter.eventNames()).toEqual([]);
	});

	test("listeners and eventNames report what is registered", () => {
		const emitter = new MqlEventEmitter();
		const listener = () => {};
		emitter.on("a", listener).once("b", () => {});

		expect(emitter.listeners("a")).toEqual([listener]);
		expect(emitter.listeners("nothing")).toEqual([]);
		expect(emitter.eventNames().sort()).toEqual(["a", "b"]);
	});

	test("addListener and off are the names node also gives them", () => {
		const emitter = new MqlEventEmitter();
		const listener = () => {};
		emitter.addListener("thing", listener);
		expect(emitter.listenerCount("thing")).toBe(1);

		emitter.off("thing", listener);
		expect(emitter.listenerCount("thing")).toBe(0);
	});

	test("removing a listener that was never added is not an error", () => {
		const emitter = new MqlEventEmitter();
		expect(() => emitter.off("thing", () => {})).not.toThrow();
		emitter.on("thing", () => {});
		expect(() => emitter.off("thing", () => {})).not.toThrow();
		expect(emitter.listenerCount("thing")).toBe(1);
	});

	test("setMaxListeners is accepted and changes nothing", () => {
		// Present because callers written against the real driver call it —
		// mongoose's connect path does, as `setMaxListeners(0)`.
		const emitter = new MqlEventEmitter();
		expect(emitter.setMaxListeners(0)).toBe(emitter);
		expect(emitter.getMaxListeners()).toBe(Number.POSITIVE_INFINITY);
	});

	/**
	 * The one deliberate divergence from node, which throws an unhandled `'error'`
	 * and turns it into an uncaught exception. Every error this driver emits has
	 * already reached the caller through the operation that produced it, so
	 * re-raising it would crash exactly the callers who never asked for events.
	 */
	test("an unhandled error event does not throw", () => {
		const emitter = new MqlEventEmitter();
		expect(() =>
			emitter.emit("error", new Error("nobody is listening")),
		).not.toThrow();
		expect(emitter.emit("error", new Error("still nobody"))).toBe(false);
	});

	test("on, once and the removers all return the emitter, for chaining", () => {
		const emitter = new MqlEventEmitter();
		const listener = () => {};
		expect(emitter.on("a", listener)).toBe(emitter);
		expect(emitter.once("b", listener)).toBe(emitter);
		expect(emitter.addListener("c", listener)).toBe(emitter);
		expect(emitter.removeListener("a", listener)).toBe(emitter);
		expect(emitter.off("b", listener)).toBe(emitter);
		expect(emitter.removeAllListeners()).toBe(emitter);
	});
});
