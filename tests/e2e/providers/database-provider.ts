/**
 * The single abstraction that decouples scenarios from any specific driver
 * or database engine. A `DatabaseProvider` knows how to bring up its
 * backing store (in our case, a Docker container), produce a connected
 * `MongoLikeClient`, and tear everything back down again.
 *
 * Adding a new backend (e.g. a hosted MongoDB Atlas instance, or a
 * different SurrealDB version) is purely additive — implement the
 * interface and register it in the composition root. Existing scenarios
 * stay untouched (Open/Closed).
 */

import type { MongoLikeClient } from "../contracts/mongo-like.ts";

export interface DatabaseProvider {
	/** Human-readable identifier used in test descriptions. */
	readonly name: string;

	/**
	 * Whether `$near` needs a geospatial index on this engine before it will run.
	 *
	 * MongoDB refuses the query outright without a `2dsphere` index; SurrealDB has
	 * no such index type, so the same query is a full scan there and
	 * `createIndex({field: '2dsphere'})` is refused. The asymmetry is a documented
	 * divergence rather than a shortcoming of a scenario, so the scenarios ask the
	 * provider instead of guessing.
	 */
	readonly requiresGeospatialIndex: boolean;

	/**
	 * Bring the backing store up (e.g. start a Docker container) and
	 * return a connected client. Implementations are responsible for
	 * waiting until the store is actually ready to accept queries.
	 */
	start(): Promise<MongoLikeClient>;

	/** Tear the backing store down and release every resource. */
	stop(): Promise<void>;
}
