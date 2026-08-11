/**
 * MongoDB-compatible `ObjectId`.
 *
 * Twelve bytes, rendered as a 24-character lowercase hex string:
 *   - 4 bytes: Unix timestamp (seconds, **unsigned**)
 *   - 5 bytes: a value unique to this process
 *   - 3 bytes: an incrementing counter
 *
 * The bytes live in a private field rather than an own property, so they never
 * surface through `Object.keys`, a spread or `JSON.stringify`'s walk. An
 * ObjectId is a single opaque identity: `{...id}` must not hand back the
 * driver's internals in place of the value, and a document assembled from a
 * spread must not grow a field that looks like a nested id.
 *
 * `_bsontype` is the property `bson`, mongoose and the official driver use to
 * recognise an ObjectId, so it is present and answers `'ObjectId'` — that is
 * what makes an instance of this class usable as one everywhere those libraries
 * ask the question.
 *
 * Parity with `bson`'s own class (the version the official driver ships) is
 * deliberate and pinned by `tests/unit/object-id-parity.test.ts`, member by
 * member. Three differences are intentional and documented there: the bytes are
 * hidden rather than exposed as an own `buffer` property, the constructor copies
 * the bytes it is given instead of aliasing them, and the errors are this
 * driver's `MongoInvalidArgumentError` (carrying `bson`'s wording) rather than
 * `BSONError`.
 */

import { MongoInvalidArgumentError } from "./errors.ts";

/** Anything shaped like an ObjectId: `bson`'s `ObjectIdLike`. */
export interface ObjectIdLike {
	id: string | Uint8Array;
	__id?: string;
	toHexString(): string;
}

/** The `util.inspect` hook Node looks for on a value it is printing. */
type InspectFn = (value: unknown, options?: unknown) => string;

/** Bytes in an ObjectId. */
const BYTE_LENGTH = 12;

/** A 24-character hex string, in either case — what `bson` accepts. */
const HEX_24 = /^[0-9a-fA-F]{24}$/;

const HEX_DIGITS = "0123456789abcdef";
const BASE64_DIGITS =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * `bson`'s own rejection wording, reused so code that matches on the message
 * behaves the same against either driver.
 */
const BAD_INPUT =
	"input must be a 24 character hex string, 12 byte Uint8Array, or an integer";
const BAD_TYPE = "Argument passed in does not match the accepted types";
const BAD_LIKE =
	"Argument passed in must have an id that is of type string or Buffer";

/** Per-process random value and counter, as the BSON spec prescribes. */
let processUnique: Uint8Array;
let counter: number;

function resetState(): void {
	// The view is backed by an explicit ArrayBuffer so its type is
	// `Uint8Array<ArrayBuffer>`, which `crypto.getRandomValues` requires under
	// TypeScript's newer lib typings (the `Uint8Array` generic added in 5.7+).
	processUnique = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(5)));
	counter = Math.floor(Math.random() * 0x1000000);
}

resetState();

function nextCounter(): number {
	counter = (counter + 1) & 0xffffff;
	return counter;
}

function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (const byte of bytes) {
		hex += HEX_DIGITS[(byte >>> 4) & 0xf] + HEX_DIGITS[byte & 0xf];
	}
	return hex;
}

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i += 1) {
		bytes[i] = Number.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

/**
 * Base64 of exactly twelve bytes, which is sixteen characters with no padding.
 *
 * Encoded here rather than through `btoa`/`Buffer` so the browser bundle, Node
 * and Bun all produce the same string with no platform branch.
 */
function bytesToBase64(bytes: Uint8Array): string {
	let text = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const triple = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
		text +=
			BASE64_DIGITS[(triple >>> 18) & 0x3f] +
			BASE64_DIGITS[(triple >>> 12) & 0x3f] +
			BASE64_DIGITS[(triple >>> 6) & 0x3f] +
			BASE64_DIGITS[triple & 0x3f];
	}
	return text;
}

function base64ToBytes(text: string): Uint8Array {
	const bytes = new Uint8Array((text.length / 4) * 3);
	for (let i = 0, out = 0; i < text.length; i += 4, out += 3) {
		let quad = 0;
		for (let digit = 0; digit < 4; digit += 1) {
			const value = BASE64_DIGITS.indexOf(text[i + digit]);
			if (value < 0) throw new MongoInvalidArgumentError(BAD_TYPE);
			quad = (quad << 6) | value;
		}
		bytes[out] = (quad >>> 16) & 0xff;
		bytes[out + 1] = (quad >>> 8) & 0xff;
		bytes[out + 2] = quad & 0xff;
	}
	return bytes;
}

/** Copy a 12-byte view into a buffer this instance owns. */
function copyBytes(view: ArrayBufferView): Uint8Array {
	return new Uint8Array(
		view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
	);
}

/**
 * Write four bytes of unsigned seconds, big-endian.
 *
 * `>>>` rather than `>>`: a timestamp past 2038-01-19 sets the top bit, and a
 * signed shift would read it as negative and write the wrong bytes. The four
 * bytes are unsigned seconds, so the format runs to 2106 — and a value beyond
 * that wraps modulo 2^32, which is what `bson` does too.
 */
function writeTimestamp(bytes: Uint8Array, seconds: number): void {
	const unsigned = Math.floor(seconds) >>> 0;
	bytes[0] = (unsigned >>> 24) & 0xff;
	bytes[1] = (unsigned >>> 16) & 0xff;
	bytes[2] = (unsigned >>> 8) & 0xff;
	bytes[3] = unsigned & 0xff;
}

/**
 * Read the four timestamp bytes as unsigned seconds.
 *
 * The top byte is multiplied in rather than shifted: `bytes[0] << 24` is a
 * signed 32-bit operation, so every id generated after 2038-01-19 would come
 * back as a negative number and `getTimestamp()` would report a date in 1901.
 */
function readTimestamp(bytes: Uint8Array): number {
	return bytes[0] * 0x1000000 + ((bytes[1] << 16) | (bytes[2] << 8) | bytes[3]);
}

/**
 * Reduce a constructor argument to the hex string or bytes it stands for.
 *
 * An object carrying `id` is an ObjectId from another BSON implementation
 * (`bson`'s own, or mongoose's). It is read through `toHexString()` when it has
 * one, since that is the only member whose meaning is guaranteed; `viaHexString`
 * records that, because a `toHexString()` answering with something other than 24
 * hex characters is a broken ObjectId rather than a bad hex string, and `bson`
 * distinguishes the two in its wording.
 */
function unwrapInput(inputId: unknown): {
	source: unknown;
	viaHexString: boolean;
} {
	if (typeof inputId !== "object" || inputId === null || !("id" in inputId)) {
		return { source: inputId, viaHexString: false };
	}

	const like = inputId as ObjectIdLike;
	if (typeof like.id !== "string" && !ArrayBuffer.isView(like.id)) {
		throw new MongoInvalidArgumentError(BAD_LIKE);
	}

	return typeof like.toHexString === "function"
		? { source: like.toHexString(), viaHexString: true }
		: { source: like.id, viaHexString: false };
}

export class ObjectId {
	/**
	 * Cache each instance's hex string on first use.
	 *
	 * Off by default, as in `bson`, where it trades memory for repeated
	 * `toHexString()` calls. `bson` caches the exact string the constructor was
	 * given, so an uppercase input keeps its case; this caches the canonical
	 * lowercase form, because a value's rendering should not depend on how it was
	 * built.
	 */
	static cacheHexString: boolean | undefined;

	#bytes: Uint8Array;
	#hex: string | undefined;

	/** The BSON type name, which is how every BSON library recognises an id. */
	get _bsontype(): "ObjectId" {
		return "ObjectId";
	}

	/** Generate a new ObjectId. */
	constructor();
	/** Create an ObjectId from a 24-character hex string. */
	constructor(inputId: string);
	/** Create an ObjectId from another ObjectId. */
	constructor(inputId: ObjectId);
	/** Create an ObjectId from anything carrying `id` and `toHexString`. */
	constructor(inputId: ObjectIdLike);
	/** Create an ObjectId from twelve bytes. */
	constructor(inputId: Uint8Array);
	/** Implementation overload. */
	constructor(inputId?: string | ObjectId | ObjectIdLike | Uint8Array);
	constructor(inputId?: string | ObjectId | ObjectIdLike | Uint8Array) {
		const { source, viaHexString } = unwrapInput(inputId);

		if (source === undefined || source === null) {
			this.#bytes = ObjectId.generate();
			return;
		}

		if (ArrayBuffer.isView(source) && source.byteLength === BYTE_LENGTH) {
			this.#bytes = copyBytes(source);
			return;
		}

		if (typeof source === "string") {
			if (!HEX_24.test(source)) {
				// A `toHexString()` that answered with something other than 24 hex
				// characters is a broken ObjectId rather than a bad hex string, and
				// `bson` distinguishes the two in its wording.
				throw new MongoInvalidArgumentError(
					viaHexString ? BAD_TYPE : BAD_INPUT,
				);
			}
			this.#bytes = hexToBytes(source);
			if (ObjectId.cacheHexString) this.#hex = source.toLowerCase();
			return;
		}

		// A number reaches here, and is rejected: `bson` removed the
		// timestamp-from-number constructor, so accepting one would let code work
		// against this driver and throw against the official one.
		// `ObjectId.createFromTime(seconds)` is the supported spelling.
		throw new MongoInvalidArgumentError(BAD_TYPE);
	}

	/** The twelve bytes of this id. */
	get id(): Uint8Array {
		return this.#bytes;
	}

	set id(value: Uint8Array) {
		this.#bytes = copyBytes(value);
		this.#hex = ObjectId.cacheHexString ? bytesToHex(this.#bytes) : undefined;
	}

	/**
	 * The twelve bytes again, under the name `bson` reads them by.
	 *
	 * `bson`'s own `equals` recognises a foreign id by `_bsontype` and then goes
	 * straight to `.buffer`, so without this an id from this driver compared by an
	 * id from `bson` or mongoose — `mongooseId.equals(id)` — would throw rather
	 * than answer. Non-enumerable, so it stays out of spreads and `Object.keys`.
	 */
	get buffer(): Uint8Array {
		return this.#bytes;
	}

	/** The 24-character lowercase hex representation. */
	toHexString(): string {
		if (this.#hex !== undefined) return this.#hex;
		const hex = bytesToHex(this.#bytes);
		if (ObjectId.cacheHexString) this.#hex = hex;
		return hex;
	}

	/**
	 * Generate the twelve bytes of a new id.
	 *
	 * @param time - Unix timestamp in seconds; defaults to now.
	 */
	static generate(time?: number): Uint8Array {
		const bytes = new Uint8Array(BYTE_LENGTH);
		writeTimestamp(
			bytes,
			typeof time === "number" ? time : Math.floor(Date.now() / 1000),
		);

		bytes[4] = processUnique[0];
		bytes[5] = processUnique[1];
		bytes[6] = processUnique[2];
		bytes[7] = processUnique[3];
		bytes[8] = processUnique[4];

		const inc = nextCounter();
		bytes[9] = (inc >>> 16) & 0xff;
		bytes[10] = (inc >>> 8) & 0xff;
		bytes[11] = inc & 0xff;

		return bytes;
	}

	/** The id as hex, or as base64 when asked for it. */
	toString(encoding?: "hex" | "base64"): string {
		return encoding === "base64"
			? bytesToBase64(this.#bytes)
			: this.toHexString();
	}

	/** The hex string, so `JSON.stringify` renders an id as its hex. */
	toJSON(): string {
		return this.toHexString();
	}

	/**
	 * Compare with another id, its hex string, or anything carrying
	 * `_bsontype: 'ObjectId'` — an id from `bson` or mongoose compares equal to
	 * one from here.
	 */
	equals(
		otherId: string | ObjectId | ObjectIdLike | undefined | null,
	): boolean {
		if (otherId === undefined || otherId === null) return false;

		if (typeof otherId === "string") {
			return otherId.toLowerCase() === this.toHexString();
		}

		if (isObjectId(otherId)) {
			return otherId.toHexString().toLowerCase() === this.toHexString();
		}

		if (
			typeof otherId === "object" &&
			typeof otherId.toHexString === "function"
		) {
			const other = otherId.toHexString();
			return (
				typeof other === "string" && other.toLowerCase() === this.toHexString()
			);
		}

		return false;
	}

	/** The generation time embedded in the id, accurate to the second. */
	getTimestamp(): Date {
		return new Date(readTimestamp(this.#bytes) * 1000);
	}

	/** An id from a second-based timestamp, with every other byte zeroed. */
	static createFromTime(time: number): ObjectId {
		const bytes = new Uint8Array(BYTE_LENGTH);
		writeTimestamp(bytes, time);
		return new ObjectId(bytes);
	}

	/** An id from its 24-character hex representation. */
	static createFromHexString(hexString: string): ObjectId {
		if (hexString?.length !== 24) {
			throw new MongoInvalidArgumentError("hex string must be 24 characters");
		}
		return new ObjectId(hexString);
	}

	/** An id from its 16-character base64 representation. */
	static createFromBase64(base64: string): ObjectId {
		if (base64?.length !== 16) {
			throw new MongoInvalidArgumentError(
				"base64 string must be 16 characters",
			);
		}
		return new ObjectId(base64ToBytes(base64));
	}

	/**
	 * Whether `id` can be used to build an ObjectId.
	 *
	 * Looser than it looks, matching `bson`: a hex string in either case, twelve
	 * bytes, another ObjectId, or any object carrying an `id` of the right shape.
	 * It is *not* a test of "would MongoDB have stored this as an ObjectId" — a
	 * string the caller supplied as an `_id` stays a string, however hex it looks.
	 */
	static isValid(id: unknown): boolean {
		if (id === undefined || id === null) return false;
		if (typeof id === "string") return HEX_24.test(id);

		try {
			new ObjectId(id as ObjectIdLike);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * How Node prints an id. Without it the hidden bytes would make an ObjectId
	 * print as `ObjectId {}`, which says nothing about which id it is.
	 */
	inspect(_depth?: number, options?: unknown, inspect?: InspectFn): string {
		const hex = this.toHexString();
		return `new ObjectId(${inspect ? inspect(hex, options) : `'${hex}'`})`;
	}
}

// Node looks the printer up by symbol; `inspect()` is the method `bson` exposes
// for the same purpose, and both are present so either route works.
Object.defineProperty(
	ObjectId.prototype,
	Symbol.for("nodejs.util.inspect.custom"),
	{
		value: function inspectCustom(
			this: ObjectId,
			depth?: number,
			options?: unknown,
			inspect?: InspectFn,
		): string {
			return this.inspect(depth, options, inspect);
		},
		writable: true,
		enumerable: false,
		configurable: true,
	},
);

/**
 * True for an ObjectId from any BSON implementation.
 *
 * `instanceof` is not enough: mongoose and anything else built on the `bson`
 * package hand over *their* ObjectId class, and a document written with one has
 * to be stored as an id rather than as a stray object. `_bsontype` is the
 * agreed-upon marker for exactly this question, and this driver's own class
 * carries it too — so this recognises both sides.
 */
export function isObjectId(value: unknown): value is ObjectIdLike {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { _bsontype?: unknown; toHexString?: unknown };
	return (
		candidate._bsontype === "ObjectId" &&
		typeof candidate.toHexString === "function"
	);
}

/**
 * This driver's ObjectId for any BSON ObjectId, so a value read back is always
 * an instance of the class this package exports.
 */
export function toObjectId(value: ObjectIdLike | ObjectId): ObjectId {
	return value instanceof ObjectId ? value : new ObjectId(value.toHexString());
}
