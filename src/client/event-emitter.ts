/**
 * The event emitter `MongoClient` is.
 *
 * Written out rather than inherited from `node:events`, because this package is
 * built for the browser as well: `dist/index.bundled.mjs` is produced by esbuild
 * with no `platform` and nothing externalised, and importing `node:events` there
 * fails the build outright — `Could not resolve "node:events" … is built into
 * node`. Measured, not assumed.
 *
 * The surface is the part of node's `EventEmitter` that consumers of a MongoDB
 * driver actually reach for, and it keeps node's semantics wherever a caller could
 * tell the difference:
 *
 *   - listeners run in the order they were added;
 *   - a `once` listener is removed before it runs, so a re-entrant `emit` does not
 *     call it twice;
 *   - the listener list is snapshotted per `emit`, so a handler that adds or
 *     removes listeners does not change who else is called for *that* event —
 *     otherwise `off` inside a handler would skip the next listener along;
 *   - `emit` reports whether anything was listening.
 *
 * One deliberate divergence, and it is the interesting one. Node throws an
 * unhandled `'error'` event, turning it into an uncaught exception. This does not:
 * every error this driver emits has already been delivered to the caller by the
 * operation that produced it, or handled internally, so re-raising it as a process
 * crash would punish exactly the callers who never asked for events. `emit`
 * returning `false` is how a caller learns nobody was listening.
 */

/** A listener for one event. */
// biome-ignore lint/suspicious/noExplicitAny: an emitter is variadic by nature
export type Listener = (...args: any[]) => void;

/** A listener plus whether it detaches after one call. */
interface Registration {
	readonly listener: Listener;
	readonly once: boolean;
}

export class MqlEventEmitter {
	/** Registrations per event name, in the order they were added. */
	private readonly registry = new Map<string, Registration[]>();

	/**
	 * Add `listener` for `event`.
	 *
	 * The same function may be added more than once, as node allows, and is then
	 * called once per registration.
	 */
	on(event: string, listener: Listener): this {
		return this.register(event, listener, false);
	}

	/** Add `listener` for the next `event` only. */
	once(event: string, listener: Listener): this {
		return this.register(event, listener, true);
	}

	/** `on`, under node's other name for it. */
	addListener(event: string, listener: Listener): this {
		return this.on(event, listener);
	}

	/**
	 * Remove one registration of `listener` for `event`.
	 *
	 * The *first* matching registration, as node does, so removing a
	 * doubly-registered listener once leaves it registered once.
	 */
	removeListener(event: string, listener: Listener): this {
		const registrations = this.registry.get(event);
		if (!registrations) return this;

		const at = registrations.findIndex(
			(registration) => registration.listener === listener,
		);
		if (at >= 0) registrations.splice(at, 1);
		if (registrations.length === 0) this.registry.delete(event);

		return this;
	}

	/** `removeListener`, under node's other name for it. */
	off(event: string, listener: Listener): this {
		return this.removeListener(event, listener);
	}

	/** Remove every listener for `event`, or for every event when given none. */
	removeAllListeners(event?: string): this {
		if (event === undefined) this.registry.clear();
		else this.registry.delete(event);
		return this;
	}

	/** The listeners registered for `event`, in call order. */
	listeners(event: string): Listener[] {
		return (this.registry.get(event) ?? []).map(
			(registration) => registration.listener,
		);
	}

	/** How many listeners are registered for `event`. */
	listenerCount(event: string): number {
		return this.registry.get(event)?.length ?? 0;
	}

	/** Every event name with at least one listener. */
	eventNames(): string[] {
		return [...this.registry.keys()];
	}

	/**
	 * Call every listener for `event`, and report whether there were any.
	 *
	 * Snapshotted first, so a listener that subscribes or unsubscribes changes only
	 * later emits.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: an emitter is variadic by nature
	emit(event: string, ...args: any[]): boolean {
		const registrations = this.registry.get(event);
		if (!registrations || registrations.length === 0) return false;

		for (const registration of [...registrations]) {
			// Detached before the call, so a listener that emits the same event again
			// does not see a `once` it has already consumed.
			if (registration.once) this.removeListener(event, registration.listener);
			registration.listener(...args);
		}

		return true;
	}

	/**
	 * Accepted and ignored.
	 *
	 * There is no listener ceiling to raise, because nothing here warns about one —
	 * the warning exists in node to catch leaks in long-lived emitters, and an
	 * emitter with this few event kinds has nothing to leak. It is present because
	 * callers written against the real driver call it: mongoose's own connect path
	 * does, as `client.setMaxListeners(0)`.
	 */
	setMaxListeners(_count: number): this {
		return this;
	}

	/** Unbounded, per `setMaxListeners`. */
	getMaxListeners(): number {
		return Number.POSITIVE_INFINITY;
	}

	private register(event: string, listener: Listener, once: boolean): this {
		const registrations = this.registry.get(event);
		if (registrations) registrations.push({ listener, once });
		else this.registry.set(event, [{ listener, once }]);
		return this;
	}
}
