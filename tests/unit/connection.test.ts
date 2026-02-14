import { describe, expect, test } from "bun:test";
import { parseConnectionString } from "../../src/connection.ts";

describe("parseConnectionString", () => {
	test("mongodb:// becomes ws:// with /rpc", () => {
		const result = parseConnectionString("mongodb://localhost:8000/mydb");
		expect(result.surrealUrl).toBe("ws://localhost:8000/rpc");
		expect(result.database).toBe("mydb");
		expect(result.namespace).toBe("default");
	});

	test("mongodb+srv:// becomes wss://", () => {
		const result = parseConnectionString("mongodb+srv://host.example.com/mydb");
		expect(result.surrealUrl).toBe("wss://host.example.com/rpc");
		expect(result.database).toBe("mydb");
	});

	test("extracts username and password", () => {
		const result = parseConnectionString(
			"mongodb://admin:secret@localhost:8000/testdb",
		);
		expect(result.username).toBe("admin");
		expect(result.password).toBe("secret");
		expect(result.database).toBe("testdb");
		expect(result.surrealUrl).toBe("ws://localhost:8000/rpc");
	});

	test("extracts namespace from query string", () => {
		const result = parseConnectionString(
			"mongodb://localhost:8000/mydb?namespace=production",
		);
		expect(result.namespace).toBe("production");
		expect(result.database).toBe("mydb");
	});

	test("override namespace takes precedence", () => {
		const result = parseConnectionString(
			"mongodb://localhost:8000/mydb?namespace=production",
			{ namespace: "staging" },
		);
		expect(result.namespace).toBe("staging");
	});

	test("override database takes precedence", () => {
		const result = parseConnectionString("mongodb://localhost:8000/urldb", {
			database: "overridedb",
		});
		expect(result.database).toBe("overridedb");
	});

	test("no database in path results in undefined", () => {
		const result = parseConnectionString("mongodb://localhost:8000");
		expect(result.database).toBeUndefined();
	});

	test("ws:// URLs pass through", () => {
		const result = parseConnectionString("ws://localhost:8000/mydb");
		expect(result.surrealUrl).toBe("ws://localhost:8000/rpc");
		expect(result.database).toBe("mydb");
	});

	test("http:// URLs pass through", () => {
		const result = parseConnectionString("http://localhost:8000/mydb");
		expect(result.surrealUrl).toBe("http://localhost:8000/rpc");
		expect(result.database).toBe("mydb");
	});

	test("throws on invalid URL", () => {
		expect(() => parseConnectionString("not-a-url")).toThrow(
			"Invalid connection string",
		);
	});

	test("no username/password results in undefined", () => {
		const result = parseConnectionString("mongodb://localhost:8000/mydb");
		expect(result.username).toBeUndefined();
		expect(result.password).toBeUndefined();
	});
});
