import { describe, expect, test } from "bun:test";
import {
	AlreadyExistsError,
	AuthenticationError,
	ConnectionUnavailableError,
	Features,
	InternalError,
	NotAllowedError,
	NotFoundError,
	QueryError,
	ServerError,
	ThrownError,
	UnsupportedFeatureError,
	ValidationError,
} from "surrealdb";
import {
	MongoCompatibilityError,
	MongoErrorCode,
	MongoErrorLabel,
	MongoNetworkError,
	MongoServerError,
} from "../../../src/errors.ts";
import {
	mapConnectError,
	mapQueryError,
	parseDuplicateKeyError,
} from "../../../src/surreal/error-mapper.ts";

/**
 * Real messages captured from SurrealDB 3.x. A unique-index violation arrives
 * as a generic `InternalError`, so the message is the only discriminator —
 * these strings are the contract the parser is written against.
 */
const DUP_STRING =
	"Database index `email_1` already contains 'a@b.c', with record `users:yavlq4a6pezre1v9v1cg`";
const DUP_COMPOUND =
	"Database index `a_1_b_1` already contains [1, 'x'], with record `c:h4l181u33c025dv8wg5l`";
const DUP_NUMERIC =
	"Database index `v_1` already contains 42, with record `n:2idjefd151w056014f7c`";
const DUP_CUSTOM_NAME =
	"Database index `my_custom_idx` already contains 'v', with record `t:abc`";

describe("parseDuplicateKeyError", () => {
	test("returns undefined for unrelated messages", () => {
		expect(
			parseDuplicateKeyError("The table 'x' does not exist"),
		).toBeUndefined();
		expect(parseDuplicateKeyError("")).toBeUndefined();
	});

	test("extracts index, collection and value for a string key", () => {
		const info = parseDuplicateKeyError(DUP_STRING);
		expect(info?.indexName).toBe("email_1");
		expect(info?.collection).toBe("users");
		expect(info?.values).toEqual(["a@b.c"]);
		expect(info?.keyPattern).toEqual({ email: 1 });
		expect(info?.keyValue).toEqual({ email: "a@b.c" });
	});

	test("parses a numeric key as a number, not a string", () => {
		const info = parseDuplicateKeyError(DUP_NUMERIC);
		expect(info?.values).toEqual([42]);
		expect(info?.keyValue).toEqual({ v: 42 });
	});

	test("splits a compound key into its fields", () => {
		const info = parseDuplicateKeyError(DUP_COMPOUND);
		expect(info?.values).toEqual([1, "x"]);
		expect(info?.keyPattern).toEqual({ a: 1, b: 1 });
		expect(info?.keyValue).toEqual({ a: 1, b: "x" });
	});

	test("a comma inside a quoted value is not treated as a separator", () => {
		const info = parseDuplicateKeyError(
			"Database index `a_1_b_1` already contains ['x, y', 2], with record `t:abc`",
		);
		expect(info?.values).toEqual(["x, y", 2]);
	});

	test("keeps a descending direction, which MongoDB reports in keyPattern", () => {
		const info = parseDuplicateKeyError(
			"Database index `age_-1` already contains 7, with record `t:abc`",
		);
		expect(info?.keyPattern).toEqual({ age: -1 });
		expect(info?.keyValue).toEqual({ age: 7 });
	});

	test("keeps each direction of a mixed compound key", () => {
		const info = parseDuplicateKeyError(
			"Database index `a_1_b_-1` already contains [1, 2], with record `t:abc`",
		);
		expect(info?.keyPattern).toEqual({ a: 1, b: -1 });
	});

	test("omits keyPattern rather than guessing for a caller-named index", () => {
		const info = parseDuplicateKeyError(DUP_CUSTOM_NAME);
		expect(info?.indexName).toBe("my_custom_idx");
		expect(info?.values).toEqual(["v"]);
		expect(info?.keyPattern).toBeUndefined();
		expect(info?.keyValue).toBeUndefined();
	});
});

describe("mapQueryError – duplicate key", () => {
	test("produces code 11000 so `err.code === 11000` works", () => {
		const err = mapQueryError(
			new InternalError({ kind: "Internal", message: DUP_STRING }),
		);
		expect(err).toBeInstanceOf(MongoServerError);
		expect(err.code).toBe(MongoErrorCode.DuplicateKey);
		expect((err as MongoServerError).codeName).toBe("DuplicateKey");
	});

	test("reformats the message the way MongoDB reports it", () => {
		const err = mapQueryError(
			new InternalError({ kind: "Internal", message: DUP_STRING }),
		);
		expect(err.message).toBe(
			'E11000 duplicate key error collection: users index: email_1 dup key: { email: "a@b.c" }',
		);
	});

	test("populates keyPattern and keyValue", () => {
		const err = mapQueryError(
			new InternalError({ kind: "Internal", message: DUP_STRING }),
		) as MongoServerError;
		expect(err.keyPattern).toEqual({ email: 1 });
		expect(err.keyValue).toEqual({ email: "a@b.c" });
	});

	test("keeps the originating SurrealDB error as `cause`", () => {
		const surreal = new InternalError({
			kind: "Internal",
			message: DUP_STRING,
		});
		expect(mapQueryError(surreal).cause).toBe(surreal);
	});

	test("is detected even from a plain Error carrying the same message", () => {
		// Defensive: the SDK wraps query-result errors inconsistently across
		// versions, so detection must not depend on the concrete class.
		expect(mapQueryError(new Error(DUP_STRING)).code).toBe(11000);
	});
});

describe("mapQueryError – code mapping", () => {
	test("NotFound becomes NamespaceNotFound (26)", () => {
		const err = mapQueryError(
			new NotFoundError({
				kind: "NotFound",
				message: "The table 'x' does not exist",
			}),
		);
		expect(err.code).toBe(MongoErrorCode.NamespaceNotFound);
	});

	test("AlreadyExists becomes NamespaceExists (48)", () => {
		const err = mapQueryError(
			new AlreadyExistsError({
				kind: "AlreadyExists",
				message: "The table 'x' already exists",
			}),
		);
		expect(err.code).toBe(MongoErrorCode.NamespaceExists);
	});

	test("a parse failure becomes FailedToParse (9)", () => {
		const err = mapQueryError(
			new ValidationError({
				kind: "Validation",
				message: "Parse error: Unexpected token",
			}),
		);
		expect(err.code).toBe(MongoErrorCode.FailedToParse);
	});

	test("other validation failures become BadValue (2)", () => {
		const err = mapQueryError(
			new ValidationError({
				kind: "Validation",
				message: "Specify a namespace",
			}),
		);
		expect(err.code).toBe(MongoErrorCode.BadValue);
	});

	test("NotAllowed becomes Unauthorized (13)", () => {
		const err = mapQueryError(
			new NotAllowedError({ kind: "NotAllowed", message: "nope" }),
		);
		expect(err.code).toBe(MongoErrorCode.Unauthorized);
	});

	test("a coercion failure becomes DocumentValidationFailure (121)", () => {
		const err = mapQueryError(
			new InternalError({
				kind: "Internal",
				message:
					"Couldn't coerce value for field `n` of `u:abc`: Expected `int` but found `'x'`",
			}),
		);
		expect(err.code).toBe(MongoErrorCode.DocumentValidationFailure);
	});

	test("an ASSERT failure becomes DocumentValidationFailure (121)", () => {
		const err = mapQueryError(
			new InternalError({
				kind: "Internal",
				message:
					"Found 1 for field `a`, with record `u:abc`, but field must conform to: $value > 5",
			}),
		);
		expect(err.code).toBe(MongoErrorCode.DocumentValidationFailure);
	});

	test("an unclassified InternalError has no code rather than a wrong one", () => {
		const err = mapQueryError(
			new InternalError({ kind: "Internal", message: "something odd" }),
		);
		expect(err).toBeInstanceOf(MongoServerError);
		expect(err.code).toBeUndefined();
	});

	test("a lost connection becomes MongoNetworkError, not MongoServerError", () => {
		const err = mapQueryError(new ConnectionUnavailableError("gone"));
		expect(err).toBeInstanceOf(MongoNetworkError);
		expect(err).not.toBeInstanceOf(MongoServerError);
	});

	test("an unsupported feature becomes MongoCompatibilityError", () => {
		const err = mapQueryError(
			new UnsupportedFeatureError(Features.Transactions),
		);
		expect(err).toBeInstanceOf(MongoCompatibilityError);
	});

	test("a user THROW stays a server error", () => {
		const err = mapQueryError(
			new ThrownError({ kind: "Thrown", message: "An error occurred: boom" }),
		);
		expect(err).toBeInstanceOf(MongoServerError);
	});

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

describe("mapQueryError – index lifecycle", () => {
	// Captured verbatim from SurrealDB 3.x: `REMOVE INDEX` on a name that is not
	// defined, and `DEFINE INDEX` reusing one that is.
	test("a missing index becomes IndexNotFound (27) with MongoDB's wording", () => {
		const e = mapQueryError(
			new InternalError({
				kind: "Internal",
				message: "The index 'age_1' does not exist",
			}),
		);
		expect(e.code).toBe(MongoErrorCode.IndexNotFound);
		expect((e as MongoServerError).codeName).toBe("IndexNotFound");
		expect(e.message).toBe("index not found with name [age_1]");
	});

	test("a duplicate index name becomes IndexKeySpecsConflict (86)", () => {
		const e = mapQueryError(new Error("The index 'age_1' already exists"));
		expect(e.code).toBe(MongoErrorCode.IndexKeySpecsConflict);
		expect(e.message).toContain(
			"An existing index has the same name as the requested index",
		);
	});

	test("the original SurrealDB error is preserved as the cause", () => {
		const original = new Error("The index 'x' does not exist");
		expect(mapQueryError(original).cause).toBe(original);
	});

	test("a message merely mentioning an index is not misread", () => {
		const e = mapQueryError(new Error("Something about The index 'x' maybe"));
		expect(e.code).toBeUndefined();
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

	test("AuthenticationError becomes AuthenticationFailed (18)", () => {
		const auth = new AuthenticationError("bad creds");
		const mapped = mapConnectError(auth) as MongoServerError;
		expect(mapped).toBeInstanceOf(MongoServerError);
		// AuthenticationError synthesises its own canonical message;
		// the mapper must preserve it verbatim.
		expect(mapped.message).toBe(auth.message);
		expect(mapped.code).toBe(MongoErrorCode.AuthenticationFailed);
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

	test("the originating error is preserved as `cause`", () => {
		const root = new Error("ECONNREFUSED");
		expect(mapConnectError(root).cause).toBe(root);
	});
});

describe("mapQueryError – transaction conflict", () => {
	/**
	 * Both wordings, captured from live servers. 3.2 and later report the
	 * conflict as a `QueryError` carrying a structured detail; 3.0 and 3.1 report
	 * the same event as a bare `InternalError`, prefixed differently, whose message
	 * is the only evidence there is.
	 */
	const CONFLICT_3_2 =
		"There was a problem with the key-value store: Transaction conflict: Write conflict, retry the transaction. This transaction can be retried";
	const CONFLICT_3_0 =
		"Transaction conflict: Write conflict, retry the transaction. This transaction can be retried";

	test("the structured detail is recognised, with MongoDB's code and label", () => {
		const conflict = new QueryError({
			kind: "Query",
			message: CONFLICT_3_2,
			details: { kind: "TransactionConflict" },
		});

		const mapped = mapQueryError(conflict);

		expect(mapped).toBeInstanceOf(MongoServerError);
		expect(mapped.code).toBe(MongoErrorCode.WriteConflict);
		expect((mapped as MongoServerError).codeName).toBe("WriteConflict");
		expect(
			mapped.hasErrorLabel(MongoErrorLabel.TransientTransactionError),
		).toBe(true);
		expect(mapped.cause).toBe(conflict);
	});

	test("an older server's unstructured conflict is recognised by message", () => {
		const mapped = mapQueryError(
			new InternalError({ kind: "Internal", message: CONFLICT_3_0 }),
		);

		expect(mapped.code).toBe(MongoErrorCode.WriteConflict);
		expect(
			mapped.hasErrorLabel(MongoErrorLabel.TransientTransactionError),
		).toBe(true);
	});

	test("a query failure that is not a conflict carries no retry label", () => {
		const mapped = mapQueryError(
			new QueryError({ kind: "Query", message: "boom" }),
		);

		expect(
			mapped.hasErrorLabel(MongoErrorLabel.TransientTransactionError),
		).toBe(false);
	});

	test("a handle the server has released reports NoSuchTransaction", () => {
		const mapped = mapQueryError(
			new ValidationError({
				kind: "Validation",
				message: "Transaction not found",
			}),
		);

		expect(mapped.code).toBe(MongoErrorCode.NoSuchTransaction);
		expect(mapped.message).toBe("Transaction is not in progress");
	});
});
