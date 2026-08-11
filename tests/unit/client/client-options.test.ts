import { describe, expect, test } from "bun:test";
import {
	parseUriOptions,
	resolveClientSettings,
} from "../../../src/client/client-options.ts";
import {
	MongoCompatibilityError,
	MongoErrorCode,
	MongoInvalidArgumentError,
	MongoParseError,
	MongoServerError,
} from "../../../src/errors.ts";
import type { MongoClientOptions } from "../../../src/types.ts";

/** Resolve options as they arrive from a connection string. */
function fromUri(query: string) {
	return resolveClientSettings(parseUriOptions(query), undefined);
}

/** Resolve options as they arrive from the constructor. */
function fromObject(options: MongoClientOptions) {
	return resolveClientSettings({}, options);
}

describe("parseUriOptions: coercion", () => {
	test("reads booleans, integers, lists and key-value pairs", () => {
		const options = parseUriOptions(
			"retryWrites=true&maxPoolSize=25&compressors=zlib,snappy&authMechanismProperties=SERVICE_NAME:other",
		);
		expect(options.retryWrites).toBe(true);
		expect(options.maxPoolSize).toBe(25);
		expect(options.compressors).toEqual(["zlib", "snappy"]);
		expect(options.authMechanismProperties).toEqual({
			SERVICE_NAME: "other",
		});
	});

	test("reads `w` as a number or a name, matching MongoDB's own type", () => {
		expect(parseUriOptions("w=1").w).toBe(1);
		expect(parseUriOptions("w=majority").w).toBe("majority");
	});

	test("accumulates repeated readPreferenceTags", () => {
		const options = parseUriOptions(
			"readPreferenceTags=dc:ny,rack:1&readPreferenceTags=dc:sf",
		);
		expect(options.readPreferenceTags).toEqual([
			{ dc: "ny", rack: "1" },
			{ dc: "sf" },
		]);
	});

	test("matches parameter names case-insensitively", () => {
		expect(parseUriOptions("RETRYWRITES=false").retryWrites).toBe(false);
	});

	test("rejects a non-boolean boolean the way MongoDB does", () => {
		expect(() => parseUriOptions("retryWrites=yes")).toThrow(
			'retryWrites must be either "true" or "false"',
		);
	});

	test("rejects a non-integer integer", () => {
		expect(() => parseUriOptions("maxPoolSize=abc")).toThrow(
			"Expected maxPoolSize to be stringified int value, got: abc",
		);
	});

	test("rejects a negative duration", () => {
		expect(() => parseUriOptions("connectTimeoutMS=-1")).toThrow(
			"connectTimeoutMS can only be a positive int value, got: -1",
		);
	});

	test("rejects a malformed key-value list", () => {
		expect(() => parseUriOptions("readPreferenceTags=nonsense")).toThrow(
			MongoParseError,
		);
	});

	test("rejects an unknown parameter, because a URI has no type checker", () => {
		expect(() => parseUriOptions("wibble=1")).toThrow(
			"option wibble is not supported",
		);
	});

	test("rejects a repeated parameter", () => {
		expect(() => parseUriOptions("w=1&w=2")).toThrow(
			'URI option "w" cannot appear more than once in the connection string',
		);
	});

	test("rejects serverApi in the string, as MongoDB does", () => {
		expect(() => parseUriOptions("serverApi=1")).toThrow(
			"URI cannot contain `serverApi`, it can only be passed to the client",
		);
	});
});

describe("client options: honoured", () => {
	test("timeouts default to MongoDB's values and can be overridden", () => {
		expect(fromUri("").connectTimeoutMS).toBe(30_000);
		expect(fromUri("connectTimeoutMS=1500").connectTimeoutMS).toBe(1500);
		expect(
			fromUri("serverSelectionTimeoutMS=250").serverSelectionTimeoutMS,
		).toBe(250);
	});

	test("`0` is kept as MongoDB's `no limit` rather than replaced by a default", () => {
		expect(fromUri("connectTimeoutMS=0").connectTimeoutMS).toBe(0);
	});

	test("timeoutMS and ignoreUndefined become per-operation defaults", () => {
		const settings = fromUri("timeoutMS=750");
		expect(settings.timeoutMS).toBe(750);
		expect(settings.ignoreUndefined).toBe(false);
		expect(fromObject({ ignoreUndefined: true }).ignoreUndefined).toBe(true);
	});

	test("reconnect is off unless asked for", () => {
		expect(fromUri("").reconnect).toBe(false);
		expect(fromUri("reconnect=true").reconnect).toBe(true);
		expect(fromObject({ reconnect: { attempts: 3 } }).reconnect).toEqual({
			attempts: 3,
		});
	});

	test("the constructor's options win over the connection string", () => {
		const settings = resolveClientSettings(parseUriOptions("timeoutMS=100"), {
			timeoutMS: 900,
		});
		expect(settings.timeoutMS).toBe(900);
	});

	test("an undefined constructor option does not shadow the string", () => {
		const settings = resolveClientSettings(parseUriOptions("tls=true"), {
			tls: undefined,
		});
		expect(settings.tls).toBe(true);
	});
});

describe("client options: accepted with no effect", () => {
	const inert: MongoClientOptions = {
		replicaSet: "rs0",
		directConnection: true,
		loadBalanced: true,
		heartbeatFrequencyMS: 500,
		minHeartbeatFrequencyMS: 100,
		serverMonitoringMode: "poll",
		localThresholdMS: 15,
		maxPoolSize: 100,
		minPoolSize: 1,
		maxConnecting: 2,
		maxIdleTimeMS: 1000,
		waitQueueTimeoutMS: 1000,
		readPreference: "secondaryPreferred",
		maxStalenessSeconds: 90,
		readPreferenceTags: [{ dc: "ny" }],
		readConcern: "majority",
		readConcernLevel: "local",
		writeConcern: { w: "majority", journal: true, wtimeoutMS: 100 },
		w: 1,
		journal: true,
		wtimeoutMS: 100,
		retryWrites: true,
		retryReads: false,
		maxAdaptiveRetries: 2,
		enableOverloadRetargeting: true,
		compressors: ["zlib", "none"],
		zlibCompressionLevel: 6,
		noDelay: true,
		appName: "svc",
		driverInfo: { name: "mongoose", version: "9.0.0" },
		monitorCommands: false,
		mongodbLogPath: "stderr",
		mongodbLogMaxDocumentLength: 100,
		serverApi: { version: "1", strict: true },
		authMechanism: "SCRAM-SHA-256",
		authMechanismProperties: { CANONICALIZE_HOST_NAME: "true" },
		socketTimeoutMS: 0,
	};

	test("every inert option is accepted together", () => {
		expect(() => fromObject(inert)).not.toThrow();
	});

	test("each inert option is accepted on its own", () => {
		for (const [key, value] of Object.entries(inert)) {
			expect(() => fromObject({ [key]: value })).not.toThrow();
		}
	});

	test("an unrecognised option object key is tolerated, unlike a URI parameter", () => {
		// Wrapper layers attach their own bookkeeping, and a computed options object
		// gets no excess-property check from TypeScript.
		expect(() =>
			fromObject({ someFutureOption: true } as MongoClientOptions),
		).not.toThrow();
	});

	test("the whole merged view is reported by `options`", () => {
		const settings = fromUri("retryWrites=true&maxPoolSize=7");
		expect(settings.options.retryWrites).toBe(true);
		expect(settings.options.maxPoolSize).toBe(7);
	});

	test("`options` invents no defaults for the options it ignores", () => {
		const settings = fromUri("");
		expect(settings.options.maxPoolSize).toBeUndefined();
		expect(settings.options.retryWrites).toBeUndefined();
	});
});

describe("client options: rejected", () => {
	const cases: [string, MongoClientOptions, RegExp][] = [
		[
			"socketTimeoutMS",
			{ socketTimeoutMS: 5000 },
			/no per-socket inactivity limit/,
		],
		["tlsCAFile", { tlsCAFile: "/ca.pem" }, /platform's WebSocket/],
		[
			"tlsCertificateKeyFile",
			{ tlsCertificateKeyFile: "/key.pem" },
			/platform's WebSocket/,
		],
		["tlsInsecure", { tlsInsecure: true }, /cannot be relaxed/],
		[
			"tlsAllowInvalidCertificates",
			{ tlsAllowInvalidCertificates: true },
			/cannot be relaxed/,
		],
		["proxyHost", { proxyHost: "127.0.0.1" }, /SOCKS5 proxy/],
		["srvMaxHosts", { srvMaxHosts: 2 }, /no SRV seedlist/],
		["srvServiceName", { srvServiceName: "mongodb" }, /no SRV record/],
		["monitorCommands", { monitorCommands: true }, /no command-monitoring/],
		["pkFactory", { pkFactory: { createPk: () => 1 } }, /ObjectIds/],
		["forceServerObjectId", { forceServerObjectId: true }, /insertedId/],
		["autoEncryption", { autoEncryption: {} }, /written in the clear/],
		["authMechanism", { authMechanism: "MONGODB-X509" }, /MONGODB-X509/],
		["raw", { raw: true }, /no BSON layer/],
		["promoteLongs", { promoteLongs: false }, /no BSON layer/],
	];

	for (const [name, options, reason] of cases) {
		test(`${name} is refused, with a reason`, () => {
			expect(() => fromObject(options)).toThrow(MongoCompatibilityError);
			expect(() => fromObject(options)).toThrow(reason);
		});
	}

	test("`tlsInsecure: false` asks for what this driver already does", () => {
		expect(() => fromObject({ tlsInsecure: false })).not.toThrow();
	});

	test("an unacknowledged write is refused", () => {
		expect(() => fromObject({ writeConcern: { w: 0 } })).toThrow(
			MongoCompatibilityError,
		);
		expect(() => fromUri("w=0")).toThrow(MongoCompatibilityError);
	});

	test("`w > 1` is refused with MongoDB's own message and code", () => {
		let error: unknown;
		try {
			fromUri("w=2");
		} catch (err) {
			error = err;
		}
		expect(error).toBeInstanceOf(MongoServerError);
		expect((error as MongoServerError).code).toBe(MongoErrorCode.BadValue);
		expect((error as MongoServerError).message).toBe(
			"cannot use 'w' > 1 when a host is not replicated",
		);
	});

	test("a read concern needing a replica set is refused with code 123", () => {
		for (const query of [
			"readConcernLevel=snapshot",
			"readConcernLevel=linearizable",
		]) {
			let error: unknown;
			try {
				fromUri(query);
			} catch (err) {
				error = err;
			}
			expect(error).toBeInstanceOf(MongoServerError);
			expect((error as MongoServerError).code).toBe(
				MongoErrorCode.NotAReplicaSet,
			);
		}
		expect(() => fromObject({ readConcern: { level: "snapshot" } })).toThrow(
			MongoServerError,
		);
	});

	test("the same rule applies whichever spelling the caller used", () => {
		expect(() => fromUri("journal=true&w=0")).toThrow(MongoCompatibilityError);
		expect(() => fromObject({ w: 0 })).toThrow(MongoCompatibilityError);
	});
});

describe("client options: invalid values", () => {
	test("an unknown read-preference mode is refused", () => {
		expect(() => fromUri("readPreference=nowhere")).toThrow(
			MongoInvalidArgumentError,
		);
		expect(() => fromUri("readPreference=nowhere")).toThrow(
			'Invalid read preference mode "nowhere"',
		);
	});

	test("an unknown compressor is refused", () => {
		expect(() => fromUri("compressors=lzma")).toThrow(
			MongoInvalidArgumentError,
		);
	});
});
