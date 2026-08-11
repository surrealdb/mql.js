/**
 * The error hierarchy is public API: applications narrow on it with
 * `instanceof` and branch on `err.code`. These tests pin the inheritance chain
 * against the official driver's (see `mongodb.d.ts`), because silently
 * re-parenting a class stops working `catch` blocks from matching.
 */

import { describe, expect, test } from "bun:test";
import {
	codeNameFor,
	MongoAPIError,
	MongoClientError,
	MongoCompatibilityError,
	MongoCursorExhaustedError,
	MongoCursorInUseError,
	MongoDriverError,
	MongoError,
	MongoErrorCode,
	MongoExpiredSessionError,
	MongoInvalidArgumentError,
	MongoNetworkError,
	MongoNetworkTimeoutError,
	MongoNotConnectedError,
	MongoOperationTimeoutError,
	MongoParseError,
	MongoRuntimeError,
	MongoServerError,
	MongoServerSelectionError,
	MongoSystemError,
	MongoTopologyClosedError,
	MongoTransactionError,
	MongoWriteConcernError,
} from "../../src/errors.ts";

describe("hierarchy matches the official driver", () => {
	/** [instance, ancestors it must satisfy `instanceof` for] */
	const cases: [MongoError, Array<new (...args: never[]) => Error>][] = [
		[new MongoDriverError("x"), [MongoError, Error]],
		[new MongoAPIError("x"), [MongoDriverError, MongoError]],
		[new MongoRuntimeError("x"), [MongoDriverError, MongoError]],
		[new MongoParseError("x"), [MongoDriverError, MongoError]],
		[new MongoOperationTimeoutError("x"), [MongoDriverError, MongoError]],
		[new MongoCompatibilityError("x"), [MongoAPIError, MongoDriverError]],
		[new MongoInvalidArgumentError("x"), [MongoAPIError, MongoDriverError]],
		[new MongoNotConnectedError(), [MongoAPIError, MongoDriverError]],
		[new MongoCursorExhaustedError(), [MongoAPIError, MongoDriverError]],
		[new MongoCursorInUseError(), [MongoAPIError, MongoDriverError]],
		[new MongoTopologyClosedError(), [MongoAPIError, MongoDriverError]],
		[new MongoExpiredSessionError(), [MongoAPIError, MongoDriverError]],
		[new MongoTransactionError("x"), [MongoAPIError, MongoDriverError]],
		[new MongoServerError("x"), [MongoError, Error]],
		[new MongoWriteConcernError("x"), [MongoServerError, MongoError]],
		[new MongoNetworkError("x"), [MongoError, Error]],
		[new MongoNetworkTimeoutError("x"), [MongoNetworkError, MongoError]],
		[new MongoSystemError("x"), [MongoError, Error]],
		[new MongoServerSelectionError("x"), [MongoSystemError, MongoError]],
	];

	for (const [instance, ancestors] of cases) {
		test(`${instance.name} extends ${ancestors.map((a) => a.name).join(" -> ")}`, () => {
			for (const ancestor of ancestors) {
				expect(instance).toBeInstanceOf(ancestor);
			}
		});
	}

	test("MongoServerError is NOT a MongoDriverError", () => {
		// A server rejection is not the driver's fault; conflating the two would
		// make `instanceof MongoDriverError` catch ordinary query failures.
		expect(new MongoServerError("x")).not.toBeInstanceOf(MongoDriverError);
	});

	test("MongoNetworkError is NOT a MongoServerError", () => {
		expect(new MongoNetworkError("x")).not.toBeInstanceOf(MongoServerError);
	});

	test("the deprecated MongoClientError still narrows as a MongoAPIError", () => {
		expect(new MongoClientError("x")).toBeInstanceOf(MongoAPIError);
	});

	test("every class reports its own name", () => {
		expect(new MongoInvalidArgumentError("x").name).toBe(
			"MongoInvalidArgumentError",
		);
		expect(new MongoParseError("x").name).toBe("MongoParseError");
		expect(new MongoWriteConcernError("x").name).toBe("MongoWriteConcernError");
	});
});

describe("MongoError", () => {
	test("preserves the originating error as `cause`", () => {
		const root = new Error("underlying SurrealDB failure");
		expect(new MongoServerError("wrapped", { cause: root }).cause).toBe(root);
	});

	test("error labels default to empty and are queryable", () => {
		const err = new MongoError("x");
		expect(err.errorLabels).toEqual([]);
		expect(err.hasErrorLabel("TransientTransactionError")).toBe(false);
		err.addErrorLabel("TransientTransactionError");
		expect(err.hasErrorLabel("TransientTransactionError")).toBe(true);
		expect(err.errorLabels).toEqual(["TransientTransactionError"]);
	});

	test("internal label bookkeeping is not enumerable", () => {
		// Errors get logged and JSON-serialised; driver internals must not leak.
		expect(Object.keys(new MongoError("x"))).not.toContain("_errorLabels");
	});
});

describe("MongoServerError", () => {
	test("derives codeName from code", () => {
		const err = new MongoServerError("dup", {
			code: MongoErrorCode.DuplicateKey,
		});
		expect(err.code).toBe(11000);
		expect(err.codeName).toBe("DuplicateKey");
	});

	test("an explicit codeName wins over the derived one", () => {
		const err = new MongoServerError("x", { code: 2, codeName: "Custom" });
		expect(err.codeName).toBe("Custom");
	});

	test("exposes errmsg alongside message, as the server does", () => {
		expect(new MongoServerError("boom").errmsg).toBe("boom");
	});

	test("still accepts a bare numeric code (previous signature)", () => {
		const err = new MongoServerError("legacy", 26);
		expect(err.code).toBe(26);
		expect(err.codeName).toBe("NamespaceNotFound");
	});

	test("carries duplicate-key detail when supplied", () => {
		const err = new MongoServerError("dup", {
			code: 11000,
			keyPattern: { email: 1 },
			keyValue: { email: "a@b.c" },
		});
		expect(err.keyPattern).toEqual({ email: 1 });
		expect(err.keyValue).toEqual({ email: "a@b.c" });
	});
});

describe("codeNameFor", () => {
	test("maps the codes this driver emits", () => {
		expect(codeNameFor(11000)).toBe("DuplicateKey");
		expect(codeNameFor(26)).toBe("NamespaceNotFound");
		expect(codeNameFor(48)).toBe("NamespaceExists");
		expect(codeNameFor(9)).toBe("FailedToParse");
		expect(codeNameFor(121)).toBe("DocumentValidationFailure");
	});

	test("returns undefined for unknown or absent codes", () => {
		expect(codeNameFor(undefined)).toBeUndefined();
		expect(codeNameFor(999_999)).toBeUndefined();
	});
});
