/**
 * Runtime parity between this driver's `ObjectId` and the real one.
 *
 * `tests/unit/types-parity.test.ts` pins the *types* against the official
 * MongoDB driver; this file pins the *behaviour* of the one value class both
 * drivers hand to applications, member by member, against the `bson` copy that
 * `mongodb` itself ships. Anything an application can observe — the hex, the
 * base64, the timestamp, what is thrown and what is said when it is thrown —
 * is compared against the reference implementation rather than against an
 * expectation written from memory.
 *
 * Three differences are deliberate, and are asserted here as differences so they
 * cannot become accidental:
 *
 *  1. `bson` keeps the twelve bytes in an own enumerable property (`buffer`), so
 *     `Object.keys(id)` is `["buffer"]` and `{...id}` copies the byte array. This
 *     driver hides them: an id is one opaque value, and a document assembled by
 *     spreading one must not sprout a field of driver internals.
 *  2. `bson` aliases a `Uint8Array` handed to its constructor, so mutating that
 *     array afterwards changes the id. This driver copies it.
 *  3. The rejections are this driver's `MongoInvalidArgumentError` rather than
 *     `BSONError` — with `bson`'s wording, so message matching still works.
 *
 * A fourth, deliberately not replicated: with `cacheHexString` enabled, `bson`
 * caches the *input* string, so an id built from uppercase hex renders as
 * uppercase. This driver caches the canonical lowercase form.
 */

import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { ObjectId as RealObjectId } from "mongodb";
import { ObjectId } from "../../src/object-id.ts";

const HEX = "507f1f77bcf86cd799439011";
const BYTES = new Uint8Array([
	0x50, 0x7f, 0x1f, 0x77, 0xbc, 0xf8, 0x6c, 0xd7, 0x99, 0x43, 0x90, 0x11,
]);

/** Every member of the reference class an application may use. */
const INSTANCE_MEMBERS = [
	"toHexString",
	"toString",
	"toJSON",
	"equals",
	"getTimestamp",
	"inspect",
] as const;

const STATIC_MEMBERS = [
	"createFromHexString",
	"createFromBase64",
	"createFromTime",
	"generate",
	"isValid",
] as const;

describe("surface", () => {
	test("every documented method exists, with the same arity", () => {
		for (const member of INSTANCE_MEMBERS) {
			const ours = ObjectId.prototype[member];
			const theirs = RealObjectId.prototype[member];
			expect(typeof ours).toBe("function");
			expect(ours.length).toBe(theirs.length);
		}
	});

	test("every documented static exists, with the same arity", () => {
		for (const member of STATIC_MEMBERS) {
			const ours = ObjectId[member];
			const theirs = RealObjectId[member];
			expect(typeof ours).toBe("function");
			expect(ours.length).toBe(theirs.length);
		}
	});

	test("the `id` accessor and `cacheHexString` switch are both present", () => {
		const ours = Object.getOwnPropertyDescriptor(ObjectId.prototype, "id");
		const theirs = Object.getOwnPropertyDescriptor(
			RealObjectId.prototype,
			"id",
		);
		expect(typeof ours?.get).toBe(typeof theirs?.get);
		expect(typeof ours?.set).toBe(typeof theirs?.set);
		expect("cacheHexString" in ObjectId).toBe(true);
		expect(ObjectId.cacheHexString).toBe(RealObjectId.cacheHexString);
	});

	test("`_bsontype` is a non-enumerable prototype getter on both", () => {
		for (const proto of [ObjectId.prototype, RealObjectId.prototype]) {
			const descriptor = Object.getOwnPropertyDescriptor(proto, "_bsontype");
			expect(typeof descriptor?.get).toBe("function");
			expect(descriptor?.enumerable).toBe(false);
		}
		expect(new ObjectId()._bsontype).toBe(new RealObjectId()._bsontype);
	});

	test("both answer to the inspect symbol Node looks for", () => {
		const key = Symbol.for("nodejs.util.inspect.custom");
		expect(typeof (new ObjectId() as never)[key]).toBe("function");
		expect(typeof (new RealObjectId() as never)[key]).toBe("function");
	});
});

describe("construction", () => {
	const accepted: [string, unknown][] = [
		["24 lowercase hex", HEX],
		["24 uppercase hex", HEX.toUpperCase()],
		["twelve bytes", BYTES],
		["twelve zero bytes", new Uint8Array(12)],
		["an id-alike", { id: HEX, toHexString: () => HEX }],
		["an object holding only bytes", { id: new Uint8Array(12) }],
	];

	for (const [name, input] of accepted) {
		test(`${name} builds the same id`, () => {
			expect(new ObjectId(input as never).toHexString()).toBe(
				new RealObjectId(input as never).toHexString(),
			);
		});
	}

	test("an id of the other implementation is accepted by both", () => {
		const ours = new ObjectId(HEX);
		const theirs = new RealObjectId(HEX);
		expect(new RealObjectId(ours).toHexString()).toBe(HEX);
		expect(new ObjectId(theirs).toHexString()).toBe(HEX);
	});

	const rejected: [string, unknown][] = [
		["a number", 1_700_000_000],
		["a negative number", -1],
		["23 hex characters", HEX.slice(0, 23)],
		["25 hex characters", `${HEX}0`],
		["non-hex characters", "zzzzzzzzzzzzzzzzzzzzzzzz"],
		["an empty string", ""],
		["eleven bytes", new Uint8Array(11)],
		["thirteen bytes", new Uint8Array(13)],
		["a bare object", {}],
		["a boolean", true],
		["an id whose id is a number", { id: 7 }],
	];

	for (const [name, input] of rejected) {
		test(`${name} is rejected by both, with the same message`, () => {
			let ourError: Error | undefined;
			let theirError: Error | undefined;
			try {
				new ObjectId(input as never);
			} catch (err) {
				ourError = err as Error;
			}
			try {
				new RealObjectId(input as never);
			} catch (err) {
				theirError = err as Error;
			}

			expect(ourError).toBeDefined();
			expect(theirError).toBeDefined();
			expect(ourError?.message).toBe(theirError?.message);
		});
	}

	test("no argument generates a well-formed id in both", () => {
		expect(new ObjectId().toHexString()).toMatch(/^[0-9a-f]{24}$/);
		expect(new RealObjectId().toHexString()).toMatch(/^[0-9a-f]{24}$/);
	});
});

describe("isValid", () => {
	const candidates: [string, unknown][] = [
		["24 lowercase hex", HEX],
		["24 uppercase hex", HEX.toUpperCase()],
		["twelve characters of ascii", "aaaaaaaaaaaa"],
		["23 hex characters", HEX.slice(0, 23)],
		["an empty string", ""],
		["null", null],
		["undefined", undefined],
		["a number", 42],
		["twelve bytes", new Uint8Array(12)],
		["eleven bytes", new Uint8Array(11)],
		["an id-alike", { id: HEX, toHexString: () => HEX }],
		["an object holding only bytes", { id: new Uint8Array(12) }],
		["a bare object", {}],
		["a boolean", true],
	];

	for (const [name, candidate] of candidates) {
		test(`agrees on ${name}`, () => {
			expect(ObjectId.isValid(candidate)).toBe(
				RealObjectId.isValid(candidate as never),
			);
		});
	}
});

describe("rendering", () => {
	test("hex, base64, string and JSON all match", () => {
		const ours = new ObjectId(HEX);
		const theirs = new RealObjectId(HEX);

		expect(ours.toHexString()).toBe(theirs.toHexString());
		expect(ours.toString()).toBe(theirs.toString());
		expect(ours.toString("hex")).toBe(theirs.toString("hex"));
		expect(ours.toString("base64")).toBe(theirs.toString("base64"));
		expect(ours.toJSON()).toBe(theirs.toJSON());
		expect(JSON.stringify({ _id: ours })).toBe(JSON.stringify({ _id: theirs }));
		expect(String(ours)).toBe(String(theirs));
		expect(`${ours}`).toBe(`${theirs}`);
	});

	test("base64 round-trips through both implementations", () => {
		const ours = new ObjectId(HEX);
		expect(
			RealObjectId.createFromBase64(ours.toString("base64")).toHexString(),
		).toBe(HEX);
		expect(
			ObjectId.createFromBase64(
				new RealObjectId(HEX).toString("base64"),
			).toHexString(),
		).toBe(HEX);
	});

	test("Node prints them identically, nested and alone", () => {
		const ours = new ObjectId(HEX);
		const theirs = new RealObjectId(HEX);

		expect(inspect(ours)).toBe(inspect(theirs));
		expect(inspect({ list: [ours] })).toBe(inspect({ list: [theirs] }));
	});

	test("both render through an inspect function handed to them", () => {
		const quote = (value: unknown): string => `«${String(value)}»`;
		expect(new ObjectId(HEX).inspect(0, undefined, quote)).toBe(
			new RealObjectId(HEX).inspect(0, undefined, quote),
		);
	});

	test("the twelve bytes read back the same", () => {
		expect([...new ObjectId(HEX).id]).toEqual([...new RealObjectId(HEX).id]);
	});
});

describe("equality", () => {
	// `bson`'s `equals` recognises a foreign id by `_bsontype` and then reads
	// `.buffer` directly, so an id from this driver has to answer to that name or
	// `mongooseId.equals(id)` throws instead of comparing.
	test("bson reads this driver's bytes by the name it expects", () => {
		const id = new ObjectId(HEX);
		expect([...(id as unknown as { buffer: Uint8Array }).buffer]).toEqual([
			...BYTES,
		]);
		expect(Object.keys(id)).toEqual([]);
	});

	test("each accepts the other's id, its hex and its uppercase hex", () => {
		const ours = new ObjectId(HEX);
		const theirs = new RealObjectId(HEX);

		expect(ours.equals(theirs)).toBe(true);
		expect(theirs.equals(ours)).toBe(true);
		expect(ours.equals(HEX)).toBe(theirs.equals(HEX));
		expect(ours.equals(HEX.toUpperCase())).toBe(
			theirs.equals(HEX.toUpperCase()),
		);
	});

	const others: [string, unknown][] = [
		["a different id", "000000000000000000000000"],
		["undefined", undefined],
		["null", null],
		["an id-alike", { toHexString: () => HEX }],
		["an unrelated object", { a: 1 }],
		["a number", 1],
	];

	for (const [name, other] of others) {
		test(`agrees when compared with ${name}`, () => {
			expect(new ObjectId(HEX).equals(other as never)).toBe(
				new RealObjectId(HEX).equals(other as never),
			);
		});
	}
});

describe("timestamps", () => {
	// Unsigned seconds: the 2038 rollover belongs to signed 32-bit arithmetic, and
	// neither implementation may fall into it.
	const hexes = [
		"000000000000000000000000",
		"00000001aaaaaaaaaaaaaaaa",
		"5fffffffaaaaaaaaaaaaaaaa",
		"7fffffffaaaaaaaaaaaaaaaa",
		"80000000aaaaaaaaaaaaaaaa",
		"ffffffffaaaaaaaaaaaaaaaa",
	];

	for (const hex of hexes) {
		test(`getTimestamp agrees for ${hex.slice(0, 8)}`, () => {
			expect(new ObjectId(hex).getTimestamp().getTime()).toBe(
				new RealObjectId(hex).getTimestamp().getTime(),
			);
		});
	}

	const times = [
		0, 1, 1_609_459_200, 2_147_483_647, 2_147_483_648, 4_294_967_295,
		4_294_967_296, -1, 1.5,
	];

	for (const time of times) {
		test(`createFromTime agrees for ${time}`, () => {
			expect(ObjectId.createFromTime(time).toHexString()).toBe(
				RealObjectId.createFromTime(time).toHexString(),
			);
		});
	}

	test("generate agrees on the timestamp bytes it writes", () => {
		const ours = ObjectId.generate(2_147_483_648);
		const theirs = RealObjectId.generate(2_147_483_648);
		expect([...ours.slice(0, 4)]).toEqual([...theirs.slice(0, 4)]);
		expect(ours.length).toBe(theirs.length);
	});
});

describe("factories", () => {
	test("createFromHexString agrees, including on its rejection", () => {
		expect(ObjectId.createFromHexString(HEX.toUpperCase()).toHexString()).toBe(
			RealObjectId.createFromHexString(HEX.toUpperCase()).toHexString(),
		);

		const ours = (() => {
			try {
				ObjectId.createFromHexString("abc");
			} catch (err) {
				return (err as Error).message;
			}
		})();
		const theirs = (() => {
			try {
				RealObjectId.createFromHexString("abc");
			} catch (err) {
				return (err as Error).message;
			}
		})();
		expect(ours).toBe(theirs);
	});

	test("createFromBase64 agrees, including on its rejection", () => {
		const base64 = new RealObjectId(HEX).toString("base64");
		expect(ObjectId.createFromBase64(base64).toHexString()).toBe(
			RealObjectId.createFromBase64(base64).toHexString(),
		);

		const ours = (() => {
			try {
				ObjectId.createFromBase64("abc");
			} catch (err) {
				return (err as Error).message;
			}
		})();
		const theirs = (() => {
			try {
				RealObjectId.createFromBase64("abc");
			} catch (err) {
				return (err as Error).message;
			}
		})();
		expect(ours).toBe(theirs);
	});
});

describe("deliberate differences", () => {
	test("this driver's internals are hidden where bson's are enumerable", () => {
		expect(Object.keys(new ObjectId(HEX))).toEqual([]);
		expect({ ...new ObjectId(HEX) }).toEqual({});

		// The reference implementation, for contrast: an own `buffer` property that
		// a spread copies in place of the id.
		expect(Object.keys(new RealObjectId(HEX))).toEqual(["buffer"]);
	});

	test("this driver copies the bytes bson aliases", () => {
		const bytes = new Uint8Array(BYTES);
		const ours = new ObjectId(bytes);
		const theirs = new RealObjectId(bytes);

		bytes[0] = 0x00;

		expect(ours.toHexString()).toBe(HEX);
		expect(theirs.toHexString()).not.toBe(HEX);
	});
});
