/**
 * Credentials from a connection string → a SurrealDB signin payload.
 *
 * MongoDB names the database holding a user's account with `authSource`;
 * SurrealDB instead has three user *levels* — root, namespace and database — and
 * the payload's shape is what selects between them. The two line up at the point
 * that matters: `admin` is where MongoDB keeps server-wide accounts, and root is
 * where SurrealDB keeps them.
 *
 *   - no `authSource`, or `authSource=admin` → a root user;
 *   - any other value → a user defined `ON DATABASE` in the database it names,
 *     inside the connection's namespace.
 *
 * MongoDB defaults `authSource` to the database in the connection string, which
 * this driver deliberately does not: `mongodb://root:root@host:8000/mydb` means
 * the SurrealDB root user, and signing that in against the `mydb` database would
 * fail for every credential that works today.
 */

import type { DatabaseAuth, RootAuth } from "surrealdb";
import { MongoCompatibilityError } from "../errors.ts";

/** The `authSource` MongoDB reserves for server-wide accounts. */
const ADMIN_SOURCE = "admin";

/** The `authSource` MongoDB uses for certificate and Kerberos identities. */
const EXTERNAL_SOURCE = "$external";

/** What `resolveAuthentication` needs to decide the signin payload. */
export interface CredentialInput {
	readonly username?: string;
	readonly password?: string;
	readonly namespace: string;
	readonly authSource?: string;
}

/**
 * The SurrealDB authentication payload for a caller's credentials, or
 * `undefined` when none were given and the connection is anonymous.
 *
 * A username with no password still authenticates, with an empty one: the caller
 * asked to be somebody, and connecting anonymously instead would leave them
 * believing they were signed in.
 */
export function resolveAuthentication(
	input: CredentialInput,
): RootAuth | DatabaseAuth | undefined {
	const { username, password, namespace, authSource } = input;
	if (username === undefined) return undefined;

	if (authSource === EXTERNAL_SOURCE) {
		throw new MongoCompatibilityError(
			"Option 'authSource' is not supported: '$external' names an identity held outside the database — X.509 or Kerberos — and SurrealDB authenticates with a username and password",
		);
	}

	const credentials = { username, password: password ?? "" };

	if (authSource === undefined || authSource === ADMIN_SOURCE) {
		return credentials;
	}

	return { namespace, database: authSource, ...credentials };
}
