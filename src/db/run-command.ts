/**
 * The command surface behind `Db.command()` and `Admin.command()`.
 *
 * ORMs and tooling reach for `db.command()` constantly — to check liveness, to
 * read the server version, to list what is there — so this is a real router
 * rather than a refusal. It answers the handful of commands that can be answered
 * from SurrealDB truthfully and delegates the ones that already have an
 * implementation to it, so a command and its equivalent method cannot drift
 * apart.
 *
 * Two rules decide everything here.
 *
 * **A reply omits what it cannot derive.** Every shape below was measured
 * against a real `mongod` (8.2), and the fields SurrealDB has no counterpart for
 * — `storageSize`, `avgObjSize`, `totalIndexSize`, `fsUsedSize`, `gitVersion` —
 * are left out rather than filled with zeros. A caller reading `storageSize: 0`
 * would conclude the collection is empty; a caller finding the field absent
 * knows the number was not available. MongoDB itself omits the size fields from
 * `listDatabases({nameOnly: true})`, so an absent field is a shape callers
 * already handle.
 *
 * **An unrouted command is a server-level failure, not a driver one.** A caller
 * reaching `db.command()` is addressing a command surface, and the error that
 * surface gives for a name it does not have is `59` / `CommandNotFound` with
 * `no such command: '<name>'` — measured, and the error every command caller
 * already handles. This is the opposite choice from the unimplemented *methods*
 * in `src/unsupported.ts`, which raise a driver-level
 * `MongoCompatibilityError`: a method belongs to this driver, a command name
 * belongs to the server it stands in for.
 *
 * That single rule is deliberately not softened for commands MongoDB really has
 * but this driver does not route — `aggregate`, `collMod`, `count`, `distinct`,
 * `findAndModify`, `getMore`. Saying `no such command: 'aggregate'` is not
 * literally true of MongoDB, and the alternative was considered: keep a list of
 * every genuine mongod command and answer those with a driver-level refusal
 * instead. That list would be long, would go stale with every MongoDB release,
 * and would introduce a second boundary for callers to learn. One rule that
 * every caller's error handling already covers is worth more than a more precise
 * message behind a list that rots. The commands it affects are named in the
 * README.
 */

import {
	MONGODB_COMPATIBILITY_VERSION,
	MONGODB_COMPATIBILITY_VERSION_ARRAY,
} from "../constants.ts";
import {
	MongoCompatibilityError,
	MongoErrorCode,
	MongoInvalidArgumentError,
	MongoServerError,
} from "../errors.ts";
import type { QueryExecutor } from "../surreal/query-executor.ts";
import type {
	CreateCollectionOptions,
	Document,
	IndexDescription,
	ListDatabasesResult,
	RunCommandOptions,
} from "../types.ts";
import {
	countDocumentsIn,
	listDatabaseNames,
	listTableNames,
} from "./database-operations.ts";
import type { Db } from "./db.ts";

/**
 * Which surface the command arrived on.
 *
 * MongoDB routes a few commands only through the `admin` database and refuses
 * them elsewhere, so the router has to know which of the two entry points it was
 * called from. There is no separate `admin` database here — SurrealDB has no such
 * convention — so `Db.admin()` answers the deployment-level commands and routes
 * the database-scoped ones to the database it came from.
 */
export type CommandScope = "database" | "admin";

/** Commands a real mongod accepts only against the `admin` database. */
const ADMIN_ONLY_COMMANDS = new Set(["listDatabases", "replSetGetStatus"]);

/** The name a command document is asking for: MongoDB reads its first field. */
function commandName(command: Document): string {
	const [name] = Object.keys(command);
	if (name === undefined) {
		throw new MongoInvalidArgumentError(
			"Command document must contain at least one field naming the command to run",
		);
	}
	return name;
}

/** `no such command`, as a real mongod reports an unrecognised one. */
function commandNotFound(name: string): MongoServerError {
	return new MongoServerError(`no such command: '${name}'`, {
		code: MongoErrorCode.CommandNotFound,
	});
}

/** The BSON type name mongod prints for a value in a namespace position. */
function bsonTypeName(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	switch (typeof value) {
		case "number":
			return Number.isInteger(value) ? "int" : "double";
		case "boolean":
			return "bool";
		case "object":
			return "object";
		case "undefined":
			return "missing";
		default:
			return typeof value;
	}
}

/**
 * The collection name a command's own field carries, validated as mongod
 * validates it: the wrong type and an empty name are two different refusals,
 * both `73` / `InvalidNamespace`.
 */
function collectionArgument(
	databaseName: string,
	command: Document,
	name: string,
): string {
	const value = command[name];

	if (typeof value !== "string") {
		throw new MongoServerError(
			`Collection name has invalid type ${bsonTypeName(value)}`,
			{ code: MongoErrorCode.InvalidNamespace },
		);
	}
	if (value.length === 0) {
		throw new MongoServerError(`Invalid namespace specified: ${databaseName}`, {
			code: MongoErrorCode.InvalidNamespace,
		});
	}
	return value;
}

/**
 * The command document's fields other than the one naming the command.
 *
 * mongod takes a command's arguments in the command document rather than in the
 * driver's options object, so a command that stands for a method has to hand
 * them on — otherwise the method's option gate never sees the request and the
 * caller's argument is acknowledged and then dropped.
 */
function commandArguments(command: Document, name: string): Document {
	const rest: Document = {};
	for (const [field, value] of Object.entries(command)) {
		if (field !== name) rest[field] = value;
	}
	return rest;
}

/**
 * Reach the server, so a command that reports on one cannot answer for a
 * deployment that is not there.
 *
 * `RETURN 1` is the cheapest statement SurrealDB answers, and it is safe inside
 * a transaction, so a command given a session does not disturb the transaction
 * it runs in.
 *
 * Sent without a database, because it asks about the deployment: `ping` on a
 * `Db` whose database does not exist must not be what brings it into existence.
 */
async function reachServer(db: Db, options: DelegateOptions): Promise<void> {
	await (await db._namespaceExecutor(options)).query("RETURN 1");
}

/** A field the command's definition requires and the caller did not send. */
function missingField(command: string, field: string): MongoServerError {
	return new MongoServerError(
		`BSON field '${command}.${field}' is missing but a required field`,
		{ code: MongoErrorCode.IDLFailedToParse },
	);
}

/**
 * The `buildInfo` reply.
 *
 * `version` is the MongoDB release this driver reports compatibility with, and
 * `surrealdbVersion` is what is actually answering — see
 * `MONGODB_COMPATIBILITY_VERSION` for why both are reported and why neither
 * alone would do. The build fields a real mongod adds (`gitVersion`,
 * `buildEnvironment`, `storageEngines`, `maxBsonObjectSize`) describe a binary
 * that is not running, so they are omitted.
 */
function buildInfoReply(surrealdbVersion: string | undefined): Document {
	return {
		version: MONGODB_COMPATIBILITY_VERSION,
		versionArray: [...MONGODB_COMPATIBILITY_VERSION_ARRAY],
		// Absent rather than `null` when version detection failed, so a caller can
		// tell "not reported" from "reported as nothing".
		...(surrealdbVersion === undefined ? {} : { surrealdbVersion }),
		ok: 1,
	};
}

/** The `listDatabases` reply. `Admin.listDatabases` routes through the command. */
async function listDatabasesReply(
	exec: QueryExecutor,
	filter?: Document,
): Promise<ListDatabasesResult> {
	const names = await listDatabaseNames(exec, filter);
	return {
		databases: names.map((name) => ({ name })),
		ok: 1,
	};
}

/**
 * The `dbStats` reply.
 *
 * Counts only. `collections` and `views` come from the table list — SurrealDB
 * has no views, so `0` is derived rather than assumed — `objects` counts every
 * table in one statement, and `indexes` sums each table's index count, which
 * costs one `INFO FOR TABLE` per collection. That cost is why the byte-size
 * fields are not merely omitted for lack of data but would be wrong to
 * approximate: there is no storage-level number to read at any price.
 */
async function dbStatsReply(
	db: Db,
	options: DelegateOptions,
): Promise<Document> {
	const exec = await db._commandExecutor(options);
	const tables = await listTableNames(exec);
	const indexCounts = await Promise.all(
		tables.map((table) => countIndexes(db, table, options)),
	);

	return {
		db: db.databaseName,
		collections: tables.length,
		views: 0,
		objects: await countDocumentsIn(exec, tables),
		indexes: indexCounts.reduce((total, count) => total + count, 0),
		ok: 1,
	};
}

/**
 * The `collStats` reply.
 *
 * A collection SurrealDB holds no definition for reports zeros rather than
 * failing, which is what mongod does for a namespace that does not exist — and
 * checking the table list first also keeps this off the read path that would
 * otherwise raise `NamespaceNotFound` for a missing table.
 */
async function collStatsReply(
	db: Db,
	collectionName: string,
	options: DelegateOptions,
): Promise<Document> {
	const exec = await db._commandExecutor(options);
	const exists = (await listTableNames(exec)).includes(collectionName);

	return {
		ns: `${db.databaseName}.${collectionName}`,
		count: exists ? await countDocumentsIn(exec, [collectionName]) : 0,
		nindexes: exists ? await countIndexes(db, collectionName, options) : 0,
		// SurrealDB has no fixed-size tables, and `createCollection({capped: true})`
		// is refused, so no collection reachable through this driver can be capped.
		capped: false,
		ok: 1,
	};
}

/** Options the router forwards to the methods it delegates to. */
interface DelegateOptions {
	readonly session?: RunCommandOptions["session"];
}

/**
 * How many indexes a collection has, counted as MongoDB counts them.
 *
 * `indexes()` reports the implicit `_id_` entry alongside the defined ones, which
 * is exactly what mongod's `nindexes` includes.
 */
async function countIndexes(
	db: Db,
	collectionName: string,
	options: DelegateOptions,
): Promise<number> {
	const indexes = await db.collection(collectionName).indexes(options);
	return indexes.length;
}

/**
 * Run `command` against this database.
 *
 * The delegating branches go through the public methods rather than reaching
 * past them, so a command inherits the option gate, the session routing and the
 * divergences those methods already document instead of acquiring its own.
 */
export async function runCommand(
	db: Db,
	command: Document,
	options: RunCommandOptions | undefined,
	scope: CommandScope,
): Promise<Document> {
	if (command === null || typeof command !== "object") {
		throw new MongoInvalidArgumentError("Command must be a document");
	}

	const name = commandName(command);
	const delegate: DelegateOptions = { session: options?.session };

	if (ADMIN_ONLY_COMMANDS.has(name) && scope !== "admin") {
		throw new MongoServerError(
			`${name} may only be run against the admin database.`,
			{ code: MongoErrorCode.Unauthorized },
		);
	}

	switch (name) {
		case "ping":
			// A round trip, as mongod's `ping` is. A probe that cannot fail is not a
			// probe: callers use `ping` to decide whether the deployment is there, so
			// answering `ok: 1` without asking would report a server that is down as
			// healthy.
			await reachServer(db, delegate);
			return { ok: 1 };

		case "buildInfo":
			return buildInfoReply(db._client.serverVersion);

		case "listDatabases":
			// Spread rather than returned directly: `ListDatabasesResult` names its
			// fields, and a command reply is an open `Document`.
			return {
				// Read through the namespace rather than through this `Db`: the reply
				// enumerates the deployment, and addressing a database to ask would add
				// it to the very list being reported.
				...(await listDatabasesReply(
					await db._namespaceExecutor(delegate),
					command.filter as Document | undefined,
				)),
			};

		case "replSetGetStatus":
			// A standalone mongod's own refusal, verbatim and with its code. There is
			// one SurrealDB node and no replica set to report the status of, so this
			// is the same answer for the same reason rather than an approximation.
			throw new MongoServerError("not running with --replSet", {
				code: MongoErrorCode.NoReplicationEnabled,
			});

		case "dbStats":
			return dbStatsReply(db, delegate);

		case "collStats":
			return collStatsReply(
				db,
				collectionArgument(db.databaseName, command, "collStats"),
				delegate,
			);

		case "create":
			await db.createCollection(
				collectionArgument(db.databaseName, command, "create"),
				// mongod's `create` carries the collection's shape in the command
				// document itself — `capped`, `size`, `validator`, `viewOn`,
				// `timeseries` — and honours every one of them. Handing them to
				// `createCollection` puts them through the same gate the method
				// applies, so a shape SurrealDB cannot give a table is refused. Dropping
				// them here instead would answer `ok: 1` and leave the caller with a
				// plain table they believe is capped, which `isCapped()` would then
				// report as `false`.
				{
					...commandArguments(command, "create"),
					...delegate,
				} as CreateCollectionOptions,
			);
			return { ok: 1 };

		case "drop":
			return dropReply(db, command, delegate);

		case "listCollections":
			return listCollectionsReply(db, command, delegate);

		case "createIndexes":
			return createIndexesReply(db, command, delegate);

		case "dropIndexes":
			return dropIndexesReply(db, command, delegate);

		default:
			throw commandNotFound(name);
	}
}

/**
 * The `drop` reply.
 *
 * Answers `ok: 1` whether or not the collection was there, which is what mongod
 * does: dropping something already absent is the state the caller asked for.
 * `nIndexesWas` is omitted rather than derived — reading the index list to report
 * it would cost a round trip on the way to removing the table it describes.
 */
async function dropReply(
	db: Db,
	command: Document,
	options: DelegateOptions,
): Promise<Document> {
	const name = collectionArgument(db.databaseName, command, "drop");
	await db.dropCollection(name, options);
	return { ns: `${db.databaseName}.${name}`, ok: 1 };
}

/**
 * The `listCollections` reply.
 *
 * MongoDB returns a cursor document, and the whole result is in `firstBatch` with
 * `id: 0` — a cursor already exhausted — because this driver materialises the
 * list in one round trip. The per-collection `options`, `info` and `idIndex`
 * fields mongod adds are omitted; `Db.listCollections` reports `{name, type}`.
 */
async function listCollectionsReply(
	db: Db,
	command: Document,
	options: DelegateOptions,
): Promise<Document> {
	const firstBatch = await db.listCollections(
		command.filter as Document | undefined,
		options,
	);
	return {
		cursor: {
			id: 0,
			ns: `${db.databaseName}.$cmd.listCollections`,
			firstBatch,
		},
		ok: 1,
	};
}

/**
 * The `createIndexes` reply.
 *
 * `numIndexesBefore` and `numIndexesAfter` are read around the delegation rather
 * than inferred from the number of specifications, because `createIndex` is
 * idempotent: re-creating an index that already exists leaves the count
 * unchanged, and reporting `before + specs.length` would claim work that did not
 * happen. `createdCollectionAutomatically` is omitted — SurrealDB defines a table
 * on first use and does not report whether this call was the first.
 */
async function createIndexesReply(
	db: Db,
	command: Document,
	options: DelegateOptions,
): Promise<Document> {
	const collectionName = collectionArgument(
		db.databaseName,
		command,
		"createIndexes",
	);
	const specs = command.indexes;
	if (!Array.isArray(specs)) {
		throw missingField("createIndexes", "indexes");
	}

	const collection = db.collection(collectionName);
	const numIndexesBefore = await countIndexes(db, collectionName, options);
	await collection.createIndexes(specs as IndexDescription[], options);

	return {
		numIndexesBefore,
		numIndexesAfter: await countIndexes(db, collectionName, options),
		ok: 1,
	};
}

/**
 * The `dropIndexes` reply.
 *
 * `index: "*"` drops every index except `_id_`, and mongod says so in a `msg`
 * field. A named index goes straight through `dropIndex`, whose own reply is
 * already `{nIndexesWas, ok}` — so the refusal to drop `_id_` and the
 * `IndexNotFound` for a name that does not exist are that method's, not a second
 * copy of them here.
 *
 * mongod also accepts `index` as a key pattern. Resolving one to a name is a
 * lookup this driver's `dropIndex(name)` does not offer, so the form is refused
 * rather than guessed at.
 */
async function dropIndexesReply(
	db: Db,
	command: Document,
	options: DelegateOptions,
): Promise<Document> {
	const collectionName = collectionArgument(
		db.databaseName,
		command,
		"dropIndexes",
	);
	const index = command.index;
	if (index === undefined) throw missingField("dropIndexes", "index");

	const collection = db.collection(collectionName);

	if (index === "*") {
		const nIndexesWas = await countIndexes(db, collectionName, options);
		await collection.dropIndexes(options);
		return {
			nIndexesWas,
			msg: "non-_id indexes dropped for collection",
			ok: 1,
		};
	}

	if (typeof index !== "string") {
		throw new MongoCompatibilityError(
			`The 'index' field of dropIndexes must be an index name or '*' here, not ${bsonTypeName(index)}: naming an index by its key pattern is not supported. Read the name from listIndexes() and pass that.`,
		);
	}

	return collection.dropIndex(index, options);
}
