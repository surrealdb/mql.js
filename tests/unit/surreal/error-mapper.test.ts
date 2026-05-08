import { describe, expect, test } from "bun:test";
import { AuthenticationError, ServerError } from "surrealdb";
import { MongoNetworkError, MongoServerError } from "../../../src/errors.ts";
import {
	mapConnectError,
	mapQueryError,
} from "../../../src/surreal/error-mapper.ts";

describe("mapQueryError", () => {
	test("Error instances become MongoServerError with the original message", () => {
		const e = mapQueryError(new Error("table not found"));
		expect(e).toBeInstanceOf(MongoServerError);
		expect(e.message).toBe("table not found");
	});

	test("non-Error throwables are stringified", () => {
		const e = mapQueryError("kaboom");
		expect(e).toBeInstanceOf(MongoServerError);
		expect(e.message).toBe("kaboom");
	});

	test("existing MongoServerError passes through unchanged", () => {
		const original = new MongoServerError("already mapped");
		expect(mapQueryError(original)).toBe(original);
	});
});

describe("mapConnectError", () => {
	test("MongoNetworkError passes through", () => {
		const e = new MongoNetworkError("network");
		expect(mapConnectError(e)).toBe(e);
	});

	test("MongoServerError passes through", () => {
		const e = new MongoServerError("server");
		expect(mapConnectError(e)).toBe(e);
	});

	test("SurrealDB AuthenticationError becomes MongoServerError carrying its message", () => {
		const auth = new AuthenticationError("bad creds");
		const mapped = mapConnectError(auth);
		expect(mapped).toBeInstanceOf(MongoServerError);
		// AuthenticationError synthesises its own canonical message;
		// the mapper must preserve it verbatim.
		expect(mapped.message).toBe(auth.message);
	});

	test("SurrealDB ServerError becomes MongoServerError", () => {
		const srv = new ServerError({ kind: "Internal", message: "boom" });
		const mapped = mapConnectError(srv);
		expect(mapped).toBeInstanceOf(MongoServerError);
		expect(mapped.message).toBe("boom");
	});

	test("plain Error becomes MongoNetworkError with prefixed message", () => {
		const mapped = mapConnectError(new Error("ECONNREFUSED"));
		expect(mapped).toBeInstanceOf(MongoNetworkError);
		expect(mapped.message).toBe("Failed to connect to SurrealDB: ECONNREFUSED");
	});

	test("non-Error thrown values are stringified into the network error", () => {
		const mapped = mapConnectError("kaboom");
		expect(mapped).toBeInstanceOf(MongoNetworkError);
		expect(mapped.message).toBe("Failed to connect to SurrealDB: kaboom");
	});
});
