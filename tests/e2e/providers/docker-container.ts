/**
 * Thin wrapper around `docker run`/`docker stop`/`docker rm`.
 *
 * Single responsibility: container process lifecycle. Knows nothing about
 * MongoDB or SurrealDB, so each backend-specific provider can compose this
 * helper without inheritance gymnastics.
 */

import { createServer } from "node:net";

export interface ContainerSpec {
	/** Docker image reference, e.g. `mongo:7.0`. */
	readonly image: string;
	/** Container name (must be unique on the host). */
	readonly containerName: string;
	/** Port mappings in `host:container` form (e.g. `["27017:27017"]`). */
	readonly publishPorts: readonly string[];
	/** Optional environment variables. */
	readonly env?: Readonly<Record<string, string>>;
	/** Optional command-line arguments appended after the image. */
	readonly args?: readonly string[];
}

export interface RunningContainer {
	/** Container ID returned by `docker run -d`. */
	readonly id: string;
	/** Stop the container and let `--rm` clean it up. */
	stop(): Promise<void>;
}

/** Returns true iff a docker daemon is reachable from this process. */
export async function isDockerAvailable(): Promise<boolean> {
	try {
		const proc = Bun.spawn(["docker", "info"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const exitCode = await proc.exited;
		return exitCode === 0;
	} catch {
		return false;
	}
}

/** Pull an image up-front so subsequent `docker run`s start quickly. */
export async function pullImage(image: string): Promise<void> {
	const proc = Bun.spawn(["docker", "pull", image], {
		stdout: "ignore",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`docker pull ${image} failed: ${stderr.trim()}`);
	}
}

/** Spawn `docker run --rm -d ...` and resolve with the container ID. */
export async function startContainer(
	spec: ContainerSpec,
): Promise<RunningContainer> {
	const args = ["docker", "run", "--rm", "-d", "--name", spec.containerName];
	for (const mapping of spec.publishPorts) {
		args.push("-p", mapping);
	}
	if (spec.env) {
		for (const [key, value] of Object.entries(spec.env)) {
			args.push("-e", `${key}=${value}`);
		}
	}
	args.push(spec.image);
	if (spec.args) args.push(...spec.args);

	const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = (await new Response(proc.stderr).text()).trim();
		throw new Error(
			`docker run failed (image=${spec.image}, name=${spec.containerName}): ${stderr}`,
		);
	}
	const id = (await new Response(proc.stdout).text()).trim();

	return {
		id,
		async stop(): Promise<void> {
			const stopProc = Bun.spawn(["docker", "stop", id], {
				stdout: "ignore",
				stderr: "ignore",
			});
			await stopProc.exited;
		},
	};
}

/**
 * The range to draw a host port from.
 *
 * Deliberately below Linux's default ephemeral range (32768–60999,
 * `net.ipv4.ip_local_port_range`). Drawing from inside it means competing with
 * every outbound connection the machine makes — on a CI runner, during an image
 * pull, that is not a rare event, and it surfaced as `docker run` failing with
 * "address already in use" on a port nothing in this suite had asked for.
 */
const PORT_RANGE_START = 20_000;
const PORT_RANGE_SIZE = 10_000;

/** True if a listener can be bound on the port docker would publish on. */
function isPortFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", () => resolve(false));
		server.once("listening", () => server.close(() => resolve(true)));
		// The address docker publishes on, which is the one that has to be free.
		server.listen(port, "0.0.0.0");
	});
}

/**
 * Pick a high port that is free right now.
 *
 * Being outside the ephemeral range is what makes the port unlikely to be taken;
 * the bind is what establishes that it isn't. Between the check and docker's own
 * bind there is still a window, which is why the providers retry rather than
 * treating one reservation as final.
 */
export async function reserveHighPort(attempts = 20): Promise<number> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const port = PORT_RANGE_START + Math.floor(Math.random() * PORT_RANGE_SIZE);
		if (await isPortFree(port)) return port;
	}
	throw new Error(
		`no free port found in ${PORT_RANGE_START}–${
			PORT_RANGE_START + PORT_RANGE_SIZE - 1
		} after ${attempts} attempts`,
	);
}

/** True if a `startContainer` failure was docker losing a race for the port. */
function isPortInUseError(error: unknown): boolean {
	return (
		error instanceof Error &&
		/address already in use|port is already allocated/i.test(error.message)
	);
}

/**
 * Start a container on a host port that is free, retrying if docker finds it
 * taken anyway. Closes the window `reserveHighPort` cannot: between the check
 * and docker's bind, anything on the machine may claim the port.
 *
 * A caller-supplied port is used as given and never retried — an explicit port
 * is a request for that port, and quietly substituting another would be worse
 * than failing.
 */
export async function startContainerOnFreePort(
	spec: (hostPort: number) => ContainerSpec,
	requestedPort?: number,
	attempts = 3,
): Promise<{ container: RunningContainer; hostPort: number }> {
	for (let attempt = 1; ; attempt++) {
		const hostPort = requestedPort ?? (await reserveHighPort());
		try {
			return { container: await startContainer(spec(hostPort)), hostPort };
		} catch (error) {
			const retryable =
				requestedPort === undefined &&
				attempt < attempts &&
				isPortInUseError(error);
			if (!retryable) throw error;
		}
	}
}

/**
 * Thrown from a readiness `check` that has established the server will never
 * become ready — its process is gone. `waitUntilReady` rethrows it rather than
 * retrying, because there is nothing left to wait for and the remaining timeout
 * is pure delay between the cause and the report of it.
 */
export class NotComingUpError extends Error {
	override readonly name = "NotComingUpError";
}

/**
 * Generic readiness poll. Calls `check` repeatedly; resolves on first
 * truthy result, rejects after `timeoutMs`.
 *
 * An ordinary throw from `check` is a transient failure — a refused connection
 * while the server is still binding — so it is recorded and retried, and only
 * reported if the timeout is reached. `NotComingUpError` is the exception.
 */
export async function waitUntilReady(
	check: () => Promise<boolean>,
	timeoutMs = 60_000,
	intervalMs = 250,
): Promise<void> {
	const start = Date.now();
	let lastError: unknown;
	while (Date.now() - start < timeoutMs) {
		try {
			if (await check()) return;
		} catch (err) {
			if (err instanceof NotComingUpError) throw err;
			lastError = err;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(
		`Container did not become ready within ${timeoutMs}ms${
			lastError ? ` (last error: ${String(lastError)})` : ""
		}`,
	);
}
