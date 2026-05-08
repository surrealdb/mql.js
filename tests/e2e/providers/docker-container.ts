/**
 * Thin wrapper around `docker run`/`docker stop`/`docker rm`.
 *
 * Single responsibility: container process lifecycle. Knows nothing about
 * MongoDB or SurrealDB, so each backend-specific provider can compose this
 * helper without inheritance gymnastics.
 */

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
 * Pick a random unused-ish high port. Avoids the fixed-port collisions that
 * would otherwise plague parallel test runs / dev machines that already
 * have MongoDB or SurrealDB bound to the canonical port.
 */
export function randomHighPort(): number {
	return 30_000 + Math.floor(Math.random() * 10_000);
}

/**
 * Generic readiness poll. Calls `check` repeatedly; resolves on first
 * truthy result, rejects after `timeoutMs`.
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
