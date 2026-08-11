import { describe, expect, test } from "bun:test";
import { parseConnectionString } from "../../../src/client/connection-string.ts";
import {
	MongoCompatibilityError,
	MongoInvalidArgumentError,
	MongoParseError,
} from "../../../src/errors.ts";

describe("parseConnectionString: scheme and host", () => {
	test("mongodb:// becomes ws:// with /rpc", () => {
		const result = parseConnectionString("mongodb://localhost:8000/mydb");
		expect(result.surrealUrl).toBe("ws://localhost:8000/rpc");
		expect(result.database).toBe("mydb");
		expect(result.namespace).toBe("default");
	});

	test("ws:// and http:// pass through", () => {
		expect(parseConnectionString("ws://localhost:8000/mydb").surrealUrl).toBe(
			"ws://localhost:8000/rpc",
		);
		expect(parseConnectionString("http://localhost:8000/mydb").surrealUrl).toBe(
			"http://localhost:8000/rpc",
		);
	});

	test("a missing port becomes SurrealDB's 8000, not the URL default of 80", () => {
		expect(parseConnectionString("mongodb://localhost/mydb").surrealUrl).toBe(
			"ws://localhost:8000/rpc",
		);
		expect(parseConnectionString("http://localhost/mydb").surrealUrl).toBe(
			"http://localhost:8000/rpc",
		);
	});

	test("a missing port on an encrypted scheme becomes 443", () => {
		expect(parseConnectionString("wss://db.example.com/mydb").surrealUrl).toBe(
			"wss://db.example.com:443/rpc",
		);
		expect(
			parseConnectionString("https://db.example.com/mydb").surrealUrl,
		).toBe("https://db.example.com:443/rpc");
	});

	test("an explicit port always wins", () => {
		expect(
			parseConnectionString("wss://db.example.com:9000/mydb").surrealUrl,
		).toBe("wss://db.example.com:9000/rpc");
	});

	test("an IPv6 host keeps its brackets and gets the default port", () => {
		expect(parseConnectionString("mongodb://[::1]/mydb").surrealUrl).toBe(
			"ws://[::1]:8000/rpc",
		);
		expect(parseConnectionString("mongodb://[::1]:8000/mydb").surrealUrl).toBe(
			"ws://[::1]:8000/rpc",
		);
	});

	test("the scheme is matched case-insensitively", () => {
		expect(
			parseConnectionString("MongoDB://localhost:8000/db").surrealUrl,
		).toBe("ws://localhost:8000/rpc");
	});

	test("mongodb+srv:// is rejected rather than mapped to wss://", () => {
		expect(() =>
			parseConnectionString("mongodb+srv://cluster0.example.com/mydb"),
		).toThrow(MongoCompatibilityError);
		expect(() =>
			parseConnectionString("mongodb+srv://cluster0.example.com/mydb"),
		).toThrow(/SRV record/);
	});

	test("an unknown scheme is rejected", () => {
		expect(() => parseConnectionString("postgres://localhost/db")).toThrow(
			MongoParseError,
		);
		expect(() => parseConnectionString("postgres://localhost/db")).toThrow(
			/Invalid scheme "postgres"/,
		);
	});

	test("a string with no scheme is rejected", () => {
		expect(() => parseConnectionString("not-a-url")).toThrow(
			/expected it to start with/,
		);
	});

	test("a missing host list is rejected", () => {
		expect(() => parseConnectionString("mongodb:///mydb")).toThrow(
			"Protocol and host list are required in the uri",
		);
	});

	test("a non-numeric port is rejected", () => {
		expect(() => parseConnectionString("mongodb://localhost:eight/db")).toThrow(
			/port "eight" is not a number/,
		);
	});

	test("several hosts are refused, naming the reason", () => {
		expect(() =>
			parseConnectionString("mongodb://h1:27017,h2:27017/db?replicaSet=rs0"),
		).toThrow(MongoParseError);
		expect(() =>
			parseConnectionString("mongodb://h1:27017,h2:27017/db?replicaSet=rs0"),
		).toThrow(/2 hosts were given/);
	});
});

describe("parseConnectionString: credentials", () => {
	test("extracts username and password", () => {
		const result = parseConnectionString(
			"mongodb://admin:secret@localhost:8000/testdb",
		);
		expect(result.username).toBe("admin");
		expect(result.password).toBe("secret");
	});

	test("percent-decodes the userinfo, as the URI specification requires", () => {
		const result = parseConnectionString(
			"mongodb://us%65r:p%40ssw%2Frd%3A%25@localhost:8000/db",
		);
		expect(result.username).toBe("user");
		expect(result.password).toBe("p@ssw/rd:%");
	});

	test("a `+` in a password stays a plus rather than becoming a space", () => {
		// Query-string decoding turns `+` into a space; userinfo decoding does not.
		const result = parseConnectionString(
			"mongodb://user:pa+ss@localhost:8000/db",
		);
		expect(result.password).toBe("pa+ss");
	});

	test("a username with no password authenticates with an empty one", () => {
		const result = parseConnectionString("mongodb://user@localhost:8000/db");
		expect(result.username).toBe("user");
		expect(result.password).toBeUndefined();
	});

	test("no userinfo means no credentials", () => {
		const result = parseConnectionString("mongodb://localhost:8000/mydb");
		expect(result.username).toBeUndefined();
		expect(result.password).toBeUndefined();
	});

	test("the last @ delimits, so an encoded one survives in the password", () => {
		const result = parseConnectionString(
			"mongodb://user:p%40ss@localhost:8000/db",
		);
		expect(result.password).toBe("p@ss");
	});

	test("an unescaped delimiter in the password is rejected", () => {
		expect(() =>
			parseConnectionString("mongodb://us:er:pw@localhost:8000/db"),
		).toThrow("Password contains unescaped characters");
	});

	test("an unescaped @ in the password is rejected", () => {
		expect(() =>
			parseConnectionString("mongodb://user:p@ss@localhost:8000/db"),
		).toThrow("Password contains unescaped characters");
	});

	test("an empty userinfo section is rejected", () => {
		expect(() =>
			parseConnectionString("mongodb://:pw@localhost:8000/db"),
		).toThrow("URI contained empty userinfo section");
		expect(() => parseConnectionString("mongodb://@localhost:8000/db")).toThrow(
			"URI contained empty userinfo section",
		);
	});

	test("a malformed percent escape is rejected", () => {
		expect(() =>
			parseConnectionString("mongodb://user:p%zz@localhost:8000/db"),
		).toThrow("URI malformed");
	});
});

describe("parseConnectionString: database and namespace", () => {
	test("takes the database from the path", () => {
		expect(parseConnectionString("mongodb://h:8000/mydb").database).toBe(
			"mydb",
		);
		expect(parseConnectionString("mongodb://h:8000/mydb/").database).toBe(
			"mydb",
		);
	});

	test("percent-decodes the database", () => {
		expect(parseConnectionString("mongodb://h:8000/my%20db").database).toBe(
			"my db",
		);
	});

	test("falls back to MongoDB's default database when the path is empty", () => {
		expect(parseConnectionString("mongodb://h:8000").database).toBe("test");
		expect(parseConnectionString("mongodb://h:8000/").database).toBe("test");
	});

	test("takes the namespace from ?namespace=, defaulting to `default`", () => {
		expect(
			parseConnectionString("mongodb://h:8000/db?namespace=production")
				.namespace,
		).toBe("production");
		expect(parseConnectionString("mongodb://h:8000/db").namespace).toBe(
			"default",
		);
	});

	test("the constructor's overrides win over the string", () => {
		const result = parseConnectionString(
			"mongodb://h:8000/urldb?namespace=production",
			{ namespace: "staging", database: "overridedb" },
		);
		expect(result.namespace).toBe("staging");
		expect(result.database).toBe("overridedb");
	});

	test("an override left undefined does not shadow the string", () => {
		const result = parseConnectionString(
			"mongodb://h:8000/urldb?namespace=production",
			{ namespace: undefined, database: undefined },
		);
		expect(result.namespace).toBe("production");
		expect(result.database).toBe("urldb");
	});
});

describe("parseConnectionString: tls", () => {
	test("?tls=true upgrades the transport", () => {
		expect(
			parseConnectionString("mongodb://h:8000/db?tls=true").surrealUrl,
		).toBe("wss://h:8000/rpc");
		expect(parseConnectionString("http://h:8000/db?ssl=true").surrealUrl).toBe(
			"https://h:8000/rpc",
		);
	});

	test("?tls=true with no port uses the encrypted default port", () => {
		expect(parseConnectionString("mongodb://h/db?tls=true").surrealUrl).toBe(
			"wss://h:443/rpc",
		);
	});

	test("the constructor's tls option is honoured too", () => {
		expect(
			parseConnectionString("mongodb://h:8000/db", { tls: true }).surrealUrl,
		).toBe("wss://h:8000/rpc");
	});

	test("?tls=false leaves an unencrypted scheme alone", () => {
		expect(
			parseConnectionString("mongodb://h:8000/db?tls=false").surrealUrl,
		).toBe("ws://h:8000/rpc");
	});

	test("tls and ssl must agree", () => {
		expect(() =>
			parseConnectionString("mongodb://h:8000/db?tls=true&ssl=false"),
		).toThrow("All values of tls/ssl must be the same.");
		expect(() =>
			parseConnectionString("mongodb://h:8000/db?tls=true", { ssl: false }),
		).toThrow("All values of tls/ssl must be the same.");
	});

	test("tls=false contradicts an encrypted scheme", () => {
		expect(() => parseConnectionString("wss://h:8000/db?tls=false")).toThrow(
			/always encrypted/,
		);
	});
});

describe("parseConnectionString: options reach the settings", () => {
	test("Atlas's usual parameters survive instead of being discarded", () => {
		const { settings } = parseConnectionString(
			"mongodb://h:8000/db?retryWrites=true&w=majority&appName=svc",
		);
		expect(settings.options.retryWrites).toBe(true);
		expect(settings.options.w).toBe("majority");
		expect(settings.options.appName).toBe("svc");
	});

	test("honoured timeouts default to MongoDB's 30 seconds", () => {
		const { settings } = parseConnectionString("mongodb://h:8000/db");
		expect(settings.connectTimeoutMS).toBe(30_000);
		expect(settings.serverSelectionTimeoutMS).toBe(30_000);
	});

	test("a parameter typo is rejected rather than ignored", () => {
		expect(() =>
			parseConnectionString("mongodb://h:8000/db?retryWrite=true"),
		).toThrow("option retrywrite is not supported");
	});

	test("a repeated parameter is rejected", () => {
		expect(() =>
			parseConnectionString("mongodb://h:8000/db?maxPoolSize=5&maxPoolSize=9"),
		).toThrow(MongoInvalidArgumentError);
	});
});
