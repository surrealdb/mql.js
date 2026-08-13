/**
 * `reserveHighPort` picks the host port the e2e providers publish on.
 *
 * The property under test is the range. Its predecessor drew from 30000–39999,
 * which overlaps Linux's default ephemeral range (32768–60999) — so the kernel
 * could hand the same port to any outbound connection the machine made, and on a
 * CI runner mid-image-pull it did: `docker run` failed with "address already in
 * use" on a port nothing in the suite had asked for. Staying below the ephemeral
 * range is what makes that impossible rather than unlikely, and it is a one-line
 * constant that a tidy-up could silently undo.
 */

import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { reserveHighPort } from "../e2e/providers/docker-container.ts";

/** The bottom of Linux's default `net.ipv4.ip_local_port_range`. */
const EPHEMERAL_RANGE_START = 32_768;

function listenOn(port: number): Promise<() => Promise<void>> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.once("listening", () =>
			resolve(() => new Promise((done) => server.close(() => done()))),
		);
		server.listen(port, "0.0.0.0");
	});
}

describe("reserveHighPort", () => {
	test("stays clear of the ephemeral port range", async () => {
		for (let i = 0; i < 25; i++) {
			expect(await reserveHighPort()).toBeLessThan(EPHEMERAL_RANGE_START);
		}
	});

	test("returns a port that can actually be bound", async () => {
		const close = await listenOn(await reserveHighPort());
		await close();
	});

	test("does not return a port that is already bound", async () => {
		// Held open across the reservations, so any of them returning it would mean
		// the check is not really binding.
		const port = await reserveHighPort();
		const close = await listenOn(port);
		try {
			for (let i = 0; i < 25; i++) {
				expect(await reserveHighPort()).not.toBe(port);
			}
		} finally {
			await close();
		}
	});

	test("gives up rather than returning a port it could not check", async () => {
		await expect(reserveHighPort(0)).rejects.toThrow(/no free port found/);
	});
});
