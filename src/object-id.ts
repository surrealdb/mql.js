/**
 * MongoDB-compatible ObjectId implementation.
 *
 * 12 bytes encoded as a 24-character lowercase hex string:
 *   - 4 bytes: Unix timestamp (seconds)
 *   - 5 bytes: random value (per process)
 *   - 3 bytes: incrementing counter
 */

import { MongoInvalidArgumentError } from "./errors.ts";

let randomBytes: Uint8Array;
let counter: number;

function initRandom(): void {
	// Back the view with an explicit ArrayBuffer so its type is
	// `Uint8Array<ArrayBuffer>`, which `crypto.getRandomValues` requires under
	// TypeScript's newer lib typings (the `Uint8Array` generic added in 5.7+).
	randomBytes = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(5)));
	counter = Math.floor(Math.random() * 0xffffff);
}

initRandom();

function nextCounter(): number {
	counter = (counter + 1) & 0xffffff;
	return counter;
}

function toHex(byte: number): string {
	return byte.toString(16).padStart(2, "0");
}

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = Number.parseInt(hex.substring(i, i + 2), 16);
	}
	return bytes;
}

export class ObjectId {
	private readonly _id: string;

	/**
	 * Create a new ObjectId.
	 *
	 * @param id - A 24-character hex string, an existing ObjectId to copy,
	 *             or omit to auto-generate a new unique identifier.
	 */
	constructor(id?: string | ObjectId) {
		if (id instanceof ObjectId) {
			this._id = id._id;
		} else if (typeof id === "string") {
			if (!ObjectId.isValid(id)) {
				throw new MongoInvalidArgumentError(`Invalid ObjectId string: ${id}`);
			}
			this._id = id.toLowerCase();
		} else if (id === undefined || id === null) {
			this._id = ObjectId.generate();
		} else {
			throw new MongoInvalidArgumentError(
				"ObjectId requires a 24-character hex string or no argument",
			);
		}
	}

	/** Generate a new 24-char hex ObjectId. */
	private static generate(): string {
		const now = Math.floor(Date.now() / 1000);
		const c = nextCounter();

		// 4 bytes timestamp (big-endian)
		const t0 = toHex((now >>> 24) & 0xff);
		const t1 = toHex((now >>> 16) & 0xff);
		const t2 = toHex((now >>> 8) & 0xff);
		const t3 = toHex(now & 0xff);

		// 5 bytes random
		const r0 = toHex(randomBytes[0]);
		const r1 = toHex(randomBytes[1]);
		const r2 = toHex(randomBytes[2]);
		const r3 = toHex(randomBytes[3]);
		const r4 = toHex(randomBytes[4]);

		// 3 bytes counter (big-endian)
		const c0 = toHex((c >>> 16) & 0xff);
		const c1 = toHex((c >>> 8) & 0xff);
		const c2 = toHex(c & 0xff);

		return `${t0}${t1}${t2}${t3}${r0}${r1}${r2}${r3}${r4}${c0}${c1}${c2}`;
	}

	/** Check whether a string is a valid ObjectId hex representation. */
	static isValid(id: unknown): boolean {
		if (typeof id === "string") {
			return /^[0-9a-f]{24}$/i.test(id);
		}
		if (id instanceof ObjectId) {
			return true;
		}
		return false;
	}

	/** Create an ObjectId from a Unix timestamp (seconds). */
	static createFromTime(time: number): ObjectId {
		const hex = Math.floor(time).toString(16).padStart(8, "0");
		return new ObjectId(`${hex}0000000000000000`);
	}

	/** Return the 24-char lowercase hex string. */
	toHexString(): string {
		return this._id;
	}

	/** Extract the embedded timestamp as a Date. */
	getTimestamp(): Date {
		const bytes = hexToBytes(this._id.substring(0, 8));
		const seconds =
			(bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
		return new Date(seconds * 1000);
	}

	/** Equality check. */
	equals(other: unknown): boolean {
		if (other instanceof ObjectId) {
			return this._id === other._id;
		}
		if (typeof other === "string") {
			return this._id === other.toLowerCase();
		}
		return false;
	}

	/** Return the 24-char hex string representation. */
	toString(): string {
		return this._id;
	}

	/** Serialize to JSON as a hex string. */
	toJSON(): string {
		return this._id;
	}

	/** Allow valueOf so that `==` with a string works in some contexts. */
	valueOf(): string {
		return this._id;
	}

	/** Custom Node.js inspect output. */
	inspect(): string {
		return `ObjectId("${this._id}")`;
	}
}
