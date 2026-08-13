<br>

<p align="center">
    <img width=120 src="https://raw.githubusercontent.com/surrealdb/icons/main/surreal.svg" />
    &nbsp;
    <img width=120 src="https://raw.githubusercontent.com/surrealdb/icons/main/javascript.svg" />
</p>

<h3 align="center">A MongoDB-compatible driver powered by SurrealDB.</h3>

<br>

<p align="center">
    <a href="https://github.com/surrealdb/mql.js"><img src="https://img.shields.io/badge/status-dev-ff00bb.svg?style=flat-square"></a>
    &nbsp;
    <a href="https://surrealdb.com/docs/sdk/javascript"><img src="https://img.shields.io/badge/docs-view-44cc11.svg?style=flat-square"></a>
    &nbsp;
    <a href="https://www.npmjs.com/package/@surrealdb/mql"><img src="https://img.shields.io/npm/v/@surrealdb/mql?style=flat-square"></a>
</p>

<p align="center">
    <a href="https://surrealdb.com/discord"><img src="https://img.shields.io/discord/902568124350599239?label=discord&style=flat-square&color=5a66f6"></a>
    &nbsp;
    <a href="https://twitter.com/surrealdb"><img src="https://img.shields.io/badge/twitter-follow_us-1d9bf0.svg?style=flat-square"></a>
    &nbsp;
    <a href="https://www.linkedin.com/company/surrealdb/"><img src="https://img.shields.io/badge/linkedin-connect_with_us-0a66c2.svg?style=flat-square"></a>
    &nbsp;
    <a href="https://www.youtube.com/@SurrealDB"><img src="https://img.shields.io/badge/youtube-subscribe-fc1c1c.svg?style=flat-square"></a>
</p>

# @surrealdb/mql

A drop-in MongoDB driver replacement powered by SurrealDB. Use the MongoDB API you already know while taking advantage of SurrealDB's multi-model capabilities under the hood.

## Features

- **MongoDB-compatible API** - MongoClient, Db, Collection, and FindCursor behave just like the official MongoDB driver
- **Standard CRUD operations** - insertOne, insertMany, find, findOne, updateOne, updateMany, deleteOne, deleteMany, and more
- **Query filter operators** - $eq, $gt, $lt, $in, $and, $or, $regex, $elemMatch, $type, $mod, and more
- **Update operators** - $set, $setOnInsert, $inc, $push, $pull, $addToSet, $min, $max, $rename, and more
- **Geospatial queries** - $geoWithin, $geoIntersects, $near, $nearSphere over real SurrealDB geometry, GeoJSON in and out, with the legacy $box/$center/$centerSphere/$polygon shapes
- **Full-text search** - $text queries with createIndex for text indexes
- **Positional array updates** - $[] and $[identifier] with arrayFilters
- **Sessions and transactions** - startSession, startTransaction, commit/abort and withTransaction, backed by real SurrealDB transactions
- **Every database from one client** - `client.db(name)` addresses the database it names, for every operation and command, and one transaction can span two of them — see [Addressing more than one database](#addressing-more-than-one-database)
- **Cursor chaining** - sort, limit, skip, project, plus `for await...of` async iteration
- **BSON identities that round-trip** - ObjectIds and Dates come back as ObjectIds and Dates, nested and in arrays, and ids from `bson`/mongoose interoperate with this driver's own
- **Admin commands** - db.command and db.admin() answer ping, buildInfo, listDatabases, dbStats, collStats and the create/drop/index commands, reporting only what SurrealDB can actually tell you
- **TypeScript generics** - Typed collections with full type inference
- **MongoDB connection strings** - Use `mongodb://` connection strings that map to SurrealDB
- **A documented edge** - every MongoDB method this driver does not implement is still there, and says what it cannot do and where to go instead — see [What is not implemented](#what-is-not-implemented)

## Installation

```bash
bun add @surrealdb/mql
# or
npm install @surrealdb/mql
```

### Requirements

**SurrealDB 3.0.0 or newer.** Every supported minor is tested in CI against its
latest patch release (currently 3.0.5, 3.1.5 and 3.2.4), plus SurrealDB
`nightly` as an early-warning signal.

**Node 20.19.0 or newer**, matching the MongoDB driver whose API this tracks. CI
packs the tarball and consumes it from Node 20.19.0, 22 and 24, in both an ESM
and a CommonJS project.

**TypeScript 5.3 or newer**, if you use the types. The public API includes
`await using session = client.startSession()`, so the declarations reference
`lib.esnext.disposable` (TypeScript 5.2), and the CommonJS declarations use a
`resolution-mode` import attribute (TypeScript 5.3) to reach `surrealdb`'s
ESM-only types. Measured: 5.0 and 5.2 reject the latter. TypeScript is not a peer
dependency — nothing in the shipped output needs it at runtime.

SurrealDB 2.x is not supported: it speaks a different SurrealQL grammar
(`type::is::*` rather than `type::is_*`, `~` rather than `string::matches()`,
`SEARCH` rather than `FULLTEXT`). `connect()` detects the server version and
fails with a `MongoCompatibilityError` rather than emitting queries the server
cannot run.

## Quick start

```typescript
import { MongoClient } from "@surrealdb/mql";

// Connect using a MongoDB-style connection string
const client = new MongoClient("mongodb://root:root@localhost:8000/mydb");
await client.connect();

// Get a database and collection
const db = client.db();
const users = db.collection("users");

// Insert documents
await users.insertOne({ name: "Alice", age: 30 });
await users.insertMany([
  { name: "Bob", age: 25 },
  { name: "Charlie", age: 35 },
]);

// Query documents
const user = await users.findOne({ name: "Alice" });
const adults = await users.find({ age: { $gte: 18 } }).toArray();

// Update documents
await users.updateOne({ name: "Alice" }, { $set: { age: 31 } });

// Delete documents
await users.deleteOne({ name: "Bob" });

// Clean up
await client.close();
```

## Connection

The driver accepts MongoDB-style connection strings and translates them to SurrealDB connections.

```
mongodb://[user:pass@]host[:port]/[database][?namespace=ns&options]
```

| Connection string | SurrealDB equivalent |
| --- | --- |
| `mongodb://root:root@localhost:8000/mydb` | `ws://localhost:8000/rpc` |
| `mongodb://localhost/mydb` | `ws://localhost:8000/rpc` (SurrealDB's default port) |
| `mongodb://db.example.com/mydb?tls=true` | `wss://db.example.com:443/rpc` |
| `ws://localhost:8000/mydb` | `ws://localhost:8000/rpc` |
| `wss://db.example.com/mydb` | `wss://db.example.com:443/rpc` |
| `http://localhost:8000/mydb` | `http://localhost:8000/rpc` |
| `mongodb+srv://cluster0.example.com/mydb` | throws — see below |
| `mongodb://h1:27017,h2:27017/mydb` | throws — see below |

- **Protocol**: `mongodb://` maps to `ws://`, and `?tls=true` (or `?ssl=true`)
  upgrades it to `wss://`. SurrealDB's own schemes are used as written.
- **Port**: a missing port becomes `8000` for a plaintext scheme and `443` for an
  encrypted one, rather than the URL standard's `80`/`443`.
- **Database**: taken from the URL path, percent-decoded. With no path, MongoDB's
  default of `test` is used.
- **Namespace**: set via the `?namespace=` query parameter (defaults to
  `"default"`). This is an extension: SurrealDB needs a namespace and a MongoDB
  URI has nowhere else to put one, so a string using it is not portable back to
  the official driver, which rejects unknown parameters.
- **Credentials**: taken from the userinfo section and **percent-decoded**, as
  the MongoDB URI specification requires — a password containing `@`, `/`, `:` or
  `%` must be encoded in the string (`p%40ssw%2Frd` is the password `p@ssw/rd`).

You can also pass options directly, and they win over the connection string:

```typescript
const client = new MongoClient("mongodb://localhost:8000/mydb", {
  namespace: "production",
  database: "override_db", // overrides the database in the URL
  connectTimeoutMS: 5_000,
});
```

`client.db()` may be called before `connect()`, as it may in the official driver:
the connection is established by the first operation. Calling `connect()`
explicitly is still the way to find out up front whether the server is reachable.

```typescript
const client = new MongoClient("mongodb://root:root@localhost:8000/mydb");
const users = client.db().collection("users"); // no connection yet
await users.insertOne({ name: "Alice" }); // connects, then inserts

// Or in one step
const connected = await MongoClient.connect("mongodb://localhost:8000/mydb");
```

After `close()`, operations fail with `MongoNotConnectedError` rather than
silently reopening the connection.

### Authentication

Credentials are signed in as a **SurrealDB root user** by default, which is the
level MongoDB's `admin` database corresponds to. `?authSource=<database>` signs in
as a user defined `ON DATABASE` in the database it names, inside the connection's
namespace:

```typescript
// A root user (SurrealDB `DEFINE USER … ON ROOT`)
new MongoClient("mongodb://root:root@localhost:8000/mydb?namespace=ns");

// A database user (SurrealDB `DEFINE USER … ON DATABASE`)
new MongoClient(
  "mongodb://app:secret@localhost:8000/mydb?namespace=ns&authSource=mydb",
);
```

This differs from MongoDB, which defaults `authSource` to the database in the
connection string. Defaulting to root instead keeps `mongodb://root:root@…/mydb`
meaning the root user, and SurrealDB rejects root credentials presented at
database level. Namespace-level SurrealDB users have no MongoDB analogue and
cannot be selected through a connection string.

### Connection-string and client options

Options are read from the connection string and the constructor together, then
classified exactly as the per-operation options are: honoured, accepted with no
effect, or rejected with a reason. Nothing is accepted and silently dropped.

| Option | Behaviour | Notes |
| --- | --- | --- |
| `tls`, `ssl` | honoured | selects `wss://` / `https://`; the two must agree |
| `connectTimeoutMS`, `serverSelectionTimeoutMS` | honoured | the tighter one bounds the connect; both default to 30 000 ms, `0` means no limit |
| `timeoutMS` | honoured | becomes a SurrealQL `TIMEOUT` on every operation, which a per-operation `maxTimeMS`/`timeoutMS` may tighten |
| `ignoreUndefined` | honoured | default for every operation |
| `auth`, `authSource` | honoured | see above |
| `namespace`, `database`, `reconnect` | honoured | SurrealDB-specific; `reconnect` is off by default, so a dropped connection surfaces as an error |
| `replicaSet`, `directConnection`, `loadBalanced`, `heartbeatFrequencyMS`, `minHeartbeatFrequencyMS`, `serverMonitoringMode`, `localThresholdMS` | accepted, no effect | there is one connection to one node |
| `maxPoolSize`, `minPoolSize`, `maxConnecting`, `maxIdleTimeMS`, `waitQueueTimeoutMS` | accepted, no effect | operations are multiplexed over a single connection |
| `readPreference`, `maxStalenessSeconds`, `readPreferenceTags` | accepted, no effect | reading the only node is stronger than any secondary read |
| `readConcern`/`readConcernLevel` of `local`, `majority`, `available` | accepted, no effect | identical on one node |
| `readConcern`/`readConcernLevel` of `snapshot` | accepted, no effect | asks that reads come from one consistent point in time, which every SurrealDB statement and transaction is — the same answer the per-operation gate gives |
| `writeConcern`, `w`, `journal`, `wtimeoutMS` | accepted, no effect | writes always wait for SurrealDB to acknowledge |
| `retryWrites`, `retryReads`, `maxAdaptiveRetries`, `enableOverloadRetargeting` | accepted, no effect | nothing is retried, so `false` is exact and `true` is a no-op |
| `compressors`, `zlibCompressionLevel`, `noDelay` | accepted, no effect | transport tuning, invisible in results |
| `appName`, `driverInfo`, `mongodbLog*` | accepted, no effect | no client-metadata channel and no logger |
| `serverApi` | accepted, no effect | there is no MongoDB command surface to version |
| `authMechanism` of `DEFAULT`, `SCRAM-SHA-*`, `PLAIN`, and `authMechanismProperties` | accepted, no effect | all describe a username/password exchange SurrealDB settles its own way |
| `readConcern`/`readConcernLevel` of `linearizable` | throws `123` | needs a replica set, as it does in MongoDB |
| `w: 0` | throws | asks for an unacknowledged write |
| `w > 1` | throws `2` | `cannot use 'w' > 1 when a host is not replicated` |
| `socketTimeoutMS` | throws | no per-socket inactivity limit exists; use `timeoutMS` |
| `tlsCAFile`, `tlsCertificateKeyFile*`, `tlsCRLFile` | throws | the platform's WebSocket and `fetch` use the runtime's trust store |
| `tlsInsecure: true`, `tlsAllowInvalidCertificates: true`, `tlsAllowInvalidHostnames: true` | throws | certificate validation cannot be relaxed |
| `proxyHost`, `proxyPort`, `proxyUsername`, `proxyPassword` | throws | the transport cannot be pointed at a SOCKS5 proxy |
| `srvMaxHosts`, `srvServiceName` | throws | no SRV lookup |
| `authMechanism` of `MONGODB-X509`, `GSSAPI`, `MONGODB-AWS`, `MONGODB-OIDC` | throws | replaces the password exchange |
| `monitorCommands: true` | throws | no command-monitoring events are emitted |
| `pkFactory`, `forceServerObjectId: true` | throws | generated `_id`s would not come from them |
| `autoEncryption` | throws | fields would be stored in the clear |
| `raw`, `promote*`, `useBigInt64`, `bsonRegExp`, `serializeFunctions`, `checkKeys`, `fieldsAsRaw`, `enableUtf8Validation` | throws | this driver encodes CBOR and has no BSON layer |

`client.options` reports the merged result. Only honoured options carry a
default there: reporting `maxPoolSize: 100` would suggest a pool that does not
exist.

### Connection events

`MongoClient` is an event emitter, with the part of node's `EventEmitter` surface
consumers reach for — `on`, `once`, `off`/`removeListener`, `addListener`,
`removeAllListeners`, `listeners`, `listenerCount`, `eventNames`, `emit`,
`setMaxListeners`:

```typescript
client.on("open", (c) => console.log("connected to", c.databaseName));
client.on("close", () => console.log("closed"));
client.on("error", (err) => console.error("connection error", err));
```

Three events, and they are the three this driver genuinely knows about: it
opened, it closed, and a connection error reached it. `open` marks the connection
being *established*, so it also fires when a caller never calls `connect()` and
the first operation connects for them, and it does not fire again for a
`connect()` on an already-open client.

**What is absent, and why.** The real driver's client emits some thirty events,
and most describe machinery that is not here: `serverHeartbeat*` reports a monitor
that polls, `server*` and `topology*` report discovery across a replica set or
sharded cluster, and `connectionPool*` reports a pool. There is one connection
here and nothing polling it, so emitting those would be inventing an event rather
than reporting one. Command monitoring (`commandStarted`, `commandSucceeded`,
`commandFailed`) is absent for a different reason: this driver sends SurrealQL, so
the `commandName` and `command` a listener would read do not exist to report.

Two divergences worth knowing:

- **An unhandled `error` event does not throw.** Node's `EventEmitter` re-raises
  it as an uncaught exception. Every error emitted here has already reached the
  caller through the operation that produced it, so crashing the process would
  punish exactly the callers who never asked for events. `emit` returns `false`
  when nothing was listening.
- **The emitter is this driver's own**, not `node:events`, because the browser
  bundle cannot resolve that module. Behaviour a caller could tell apart from
  node's — listener order, `once` detaching before it runs, a handler that
  subscribes or unsubscribes mid-emit — is asserted in the test suite rather than
  inherited.

`mongoose.connect()` works through `mongoose.setDriver()` — see
[Mongoose](#mongoose). What the emitter fixes there is that mongoose's wiring
calls `client.on(...)` unconditionally, which used to be a `TypeError`.

### Connection behaviour that differs from MongoDB

- **`mongodb+srv://` throws.** Resolving a seedlist needs a DNS `SRV` lookup,
  which this driver cannot perform in every runtime it targets (it ships a
  browser bundle), and the host in such a string names a discovery record rather
  than a server. Name the SurrealDB server directly.
- **A multi-host string throws.** Several hosts ask for replica-set or `mongos`
  discovery, elections and failover. This driver holds one connection to one
  node, so quietly using the first host would leave you believing you had
  failover you do not have.
- **An unknown query parameter throws**, as it does in MongoDB — a connection
  string has no type checker, so `?tls=ture` has to be caught. An unrecognised
  key in the *options object* is tolerated instead: wrapper layers such as
  mongoose compute those objects and attach bookkeeping of their own.
- **`?namespace=` is this driver's own parameter**, and MongoDB rejects it.
- **Value errors are MongoDB's**, in MongoDB's words: `?maxPoolSize=abc`,
  `?retryWrites=yes` and `?tls=true&ssl=false` all fail the way the official
  driver fails them, at construction rather than at `connect()`.

## CRUD operations

### Insert

```typescript
// Insert a single document
const result = await users.insertOne({
  name: "Alice",
  age: 30,
  tags: ["admin"],
});
console.log(result.insertedId); // ObjectId

// Insert multiple documents
const result = await users.insertMany([
  { name: "Bob", age: 25 },
  { name: "Charlie", age: 35 },
]);
console.log(result.insertedCount); // 2
console.log(result.insertedIds);   // { 0: ObjectId, 1: ObjectId }
```

#### A batch insert that partly fails

`insertMany` is not one write. When a document is refused — a duplicate `_id`, an
`ASSERT` — what happens to the rest depends on `ordered`, exactly as in MongoDB:

```typescript
// ordered (the default): stop at the refusal, keep what came before
try {
  await users.insertMany([{ _id: "a" }, { _id: "dup" }, { _id: "c" }]);
} catch (err) {
  err.code;          // 11000
  err.writeErrors;   // [{ index: 1, code: 11000, keyValue: { _id: "dup" } }]
  err.insertedCount; // 1  — "a" is in the collection, "c" was never attempted
  err.insertedIds;   // { 0: "a" }
}

// unordered: attempt all of them, keep every success
try {
  await users.insertMany([{ _id: "a" }, { _id: "dup" }, { _id: "c" }], {
    ordered: false,
  });
} catch (err) {
  err.writeErrors;   // [{ index: 1, ... }]
  err.insertedCount; // 2  — both "a" and "c" are in the collection
  err.insertedIds;   // { 0: "a", 2: "c" }
}
```

The error is a `MongoBulkWriteError`, and it throws in both cases — as MongoDB
does — even though documents were written, so a caller who never inspects it is
not left believing the whole batch landed.

Inside a session's transaction the batch is all-or-nothing instead, again as in
MongoDB: the refusal aborts the transaction, so nothing is kept.

### Find

```typescript
// Find a single document
const user = await users.findOne({ name: "Alice" });

// Find multiple documents (returns a cursor)
const cursor = users.find({ age: { $gte: 18 } });
const results = await cursor.toArray();

// Count documents
const count = await users.countDocuments({ age: { $gte: 18 } });

// Estimated total count
const total = await users.estimatedDocumentCount();

// Distinct values
const names = await users.distinct("name", { age: { $gte: 18 } });
```

### Update

```typescript
// Update the first matching document
const result = await users.updateOne(
  { name: "Alice" },
  { $set: { age: 31 }, $inc: { loginCount: 1 } },
);
console.log(result.matchedCount);  // 1
console.log(result.modifiedCount); // 1

// Update all matching documents
await users.updateMany(
  { age: { $lt: 18 } },
  { $set: { status: "minor" } },
);

// Replace a document entirely
await users.replaceOne(
  { name: "Alice" },
  { name: "Alice", age: 31, role: "admin" },
);

// An empty filter matches everything, and replaces the first of them.
// A `sort` decides which document that is.
await users.replaceOne({}, { name: "Alice", age: 31 });

// Upsert (insert if no match)
await users.updateOne(
  { name: "Dave" },
  { $set: { age: 28 } },
  { upsert: true },
);
```

#### Two clients writing to one document

`updateOne`, `replaceOne`, `deleteOne` and the three `findOneAnd*` each modify
one document, and each does so in a single SurrealQL statement — the record is
chosen in a subquery of the write rather than in an earlier round trip, so
choosing it and writing to it are one atomic act. Two clients racing to claim the
same document therefore behave as they do in MongoDB: one wins, and the other is
told `matchedCount: 0` rather than overwriting the winner.

There is a caveat below **SurrealDB 3.3.0**, and only on the **in-memory**
storage engine (`surreal start memory`), where two such writes could both commit
and one be dropped with both callers told they succeeded. Measured on 3.2.3 with
nothing changed but the engine: 1600 contests on `rocksdb` produced a single
winner every time, while the in-memory engine produced 10 double claims in 3000.
It is a storage-engine bug, fixed in 3.3.0, and no query shape or transaction
avoids it — so on 3.0.x–3.2.x, prefer a persistent engine for concurrent writes
to a hot document.

### Delete

```typescript
// Delete the first matching document
const result = await users.deleteOne({ name: "Alice" });
console.log(result.deletedCount); // 1

// Delete all matching documents
await users.deleteMany({ age: { $lt: 18 } });

// Delete all documents
await users.deleteMany({});
```

### Find and modify

```typescript
// Find, update, and return the document
const updated = await users.findOneAndUpdate(
  { name: "Alice" },
  { $inc: { age: 1 } },
  { returnDocument: "after" }, // return the updated document
);

// Find and delete
const deleted = await users.findOneAndDelete({ name: "Bob" });

// Find and replace
const replaced = await users.findOneAndReplace(
  { name: "Charlie" },
  { name: "Charlie", age: 36, role: "user" },
  { returnDocument: "after" },
);
```

### Per-operation options

Every CRUD and index method passes its options through one gate, which reads the
whole object rather than the fields that method happens to use — a computed
options bag is not checked by TypeScript. Each option is honoured, accepted with
no effect, or rejected with a reason. Nothing is accepted and silently dropped.

| Option | Behaviour | Notes |
| --- | --- | --- |
| `maxTimeMS`, `timeoutMS` | honoured | becomes a SurrealQL `TIMEOUT`; the tightest of the two and the client's `timeoutMS` binds. `0` means no limit, and a value above MongoDB's 32-bit ceiling is refused as MongoDB refuses it. Not available on index operations — SurrealDB's DDL takes no `TIMEOUT` clause |
| `hint` | honoured | becomes `WITH INDEX <name>`, or `WITH NOINDEX` for `{$natural: …}`. Validated against the collection's real indexes first: SurrealDB *silently ignores* a `WITH INDEX` naming an index that does not exist, so an unmatched hint raises `2` (`BadValue`) as MongoDB does rather than scanning unnoticed |
| `sort` | honoured | on a `find`/`findOne` it becomes the statement's `ORDER BY`; on a `findOneAnd*`/`replaceOne` it orders the subquery that names the record being written to, which is what decides *which* document is modified. An inclusion `projection` must name every field the sort orders by — see [Sorting by a field an inclusion projection omits](#sorting-by-a-field-an-inclusion-projection-omits) |
| `projection` | honoured | a field list in the `SELECT` for `find`/`findOne`, applied to the returned document for the `findOneAnd*` methods. `_id` is included unless the projection suppresses it. An inclusion projection combined with a `sort` on a field it does not name is refused — see [Sorting by a field an inclusion projection omits](#sorting-by-a-field-an-inclusion-projection-omits) |
| `upsert`, `returnDocument`, `includeResultMetadata`, `arrayFilters` | honoured | the created document is seeded from the filter's equalities, as MongoDB seeds it |
| `ignoreUndefined` | honoured | decides whether an `undefined` property is dropped or stored as `null`; overrides the client's setting, including with an explicit `false` |
| `comment` | accepted, no effect | SurrealDB has no query-level comment mechanism, and a comment cannot change the answer |
| `readPreference`, `readConcern` of `local`/`majority`/`available` | accepted, no effect | reading the only node is at least what they ask for |
| `writeConcern`, other than `w: 0` and `w > 1` | accepted, no effect | every write waits for SurrealDB to acknowledge |
| `batchSize`, `maxAwaitTimeMS`, `noCursorTimeout`, `allowDiskUse`, `allowPartialResults`, `oplogReplay` | accepted, no effect | server-cursor and sharding mechanics; results are materialised in one round trip |
| `ordered` | honoured | decides what an `insertMany` keeps when part of the batch is refused — see [A batch insert that partly fails](#a-batch-insert-that-partly-fails) |
| `session` | honoured | while the session has a transaction in progress, the operation's statements run inside it and are committed or rolled back with it — see [Sessions and transactions](#sessions-and-transactions) |
| `readConcern` of `snapshot` | accepted, no effect | asks that every read come from one consistent point in time, which is what a SurrealDB transaction is: a statement is a transaction, and a read inside an open one does not observe a commit another connection made after it began |
| `readConcern` of `linearizable` | throws `123` | needs a replica set, as it does in MongoDB: it asks the server to confirm no newer primary was elected before answering, and there is no election to confirm |
| `writeConcern: {w: 0}` | throws | asks for an unacknowledged write |
| `writeConcern: {w: >1}` | throws `2` | `cannot use 'w' > 1 when a host is not replicated` |
| `collation` | throws | SurrealDB compares strings by code point, so a locale-aware comparison would match and order differently |
| `let` | throws | `$$var` references need an expression compiler this driver does not have |
| `explain` | throws | SurrealDB's `EXPLAIN` describes a different planner |
| `bypassDocumentValidation: true` | throws | `ASSERT`s are enforced inside the storage engine |
| `forceServerObjectId: true` | throws | the reported `insertedId` would have nothing truthful to say |
| `min`, `max` | throws | no index-bound clause, so the scan would not be restricted (in `createIndex` these are a `2d` index's coordinate limits, and are accepted there) |
| `returnKey`, `showRecordId`, `singleBatch`, `tailable`, `awaitData` | throws | no index-key projection, no storage-level record id and no capped collections |
| `out` | throws | the results would not be written where the caller asked |
| `dbName` | throws | the official driver has three behaviours for it depending on the operation, so there is no one behaviour to honour (measured against 7.5.0: `db.command({dbStats: 1}, {dbName: other})` ignores it and reports the handle's own database, `db.stats` and `distinct` re-target to `other`, and `createCollection` forwards it to the server and fails with `IDLUnknownField`); the database a statement runs against here is the one its `Db` names — see [Addressing more than one database](#addressing-more-than-one-database) |
| `raw`, `promote*`, `useBigInt64`, `bsonRegExp`, `serializeFunctions`, `checkKeys`, `fieldsAsRaw`, `enableUtf8Validation` | throws | this driver encodes CBOR and has no BSON layer |

An option this driver does not recognise **at all** is tolerated, deliberately:
real MongoDB drivers ignore unknown keys, and wrapper layers such as mongoose
compute their options objects and attach bookkeeping of their own.

### A collection that has never been written to

MongoDB treats a collection it has never seen as an empty one, and so does this
driver. SurrealDB itself refuses to read a table it holds no definition for, and
that refusal is translated into the answer MongoDB gives:

| Operation | Answer |
| --- | --- |
| `find`, cursor iteration | `[]` |
| `findOne`, all three `findOneAnd*` | `null` |
| `countDocuments`, `estimatedDocumentCount` | `0` |
| `distinct` | `[]` |
| `deleteOne`, `deleteMany` | `{deletedCount: 0}` |
| `updateOne`, `updateMany`, `replaceOne` | `{matchedCount: 0, modifiedCount: 0}` |

An `insertOne`/`insertMany`, and the inserting half of an `upsert`, still
*create* the collection — their whole purpose is to bring it into existence, so a
missing table reported to one of them is a real failure rather than an answer.

The tolerance is deliberately narrow. SurrealDB reports a missing table, a
missing database and a missing namespace all as the same error, which this driver
maps onto MongoDB's single code `26` (`NamespaceNotFound`) — so the code alone
cannot tell "your collection is empty" from "the database you named is not
there", and answering `[]` for the second would make a typo in a connection
string look exactly like an empty dataset. The error the SDK carries says which
of the three it was, and only a missing **table**, naming **this** collection, is
read as emptiness. A namespace or database that is reported missing still raises
`26` from every operation, reads included.

What that protects is the connected database — the one a connection string names,
where "not there" means the store the application was pointed at is not there. A
`client.db("other")` naming a database that does not exist reads as empty
instead, because the statement selects that database as it goes out and SurrealDB
brings it into existence to run it, then reports the missing table. That is what
MongoDB answers for a database it has never seen, so the two cases differ in the
same direction as MongoDB's own answers do — see
[Addressing more than one database](#addressing-more-than-one-database).

One case escapes that guarantee, and it is SurrealDB's to give rather than this
driver's: a non-root user whose session names a database that does not exist is
told the *table* does not exist, not the database. Such a session reads as an
empty collection — which is what MongoDB answers for a database it has never seen
too, so it is parity rather than a silent wrong answer, but it does mean the loud
failure is guaranteed only where SurrealDB names the namespace or database
itself. A root connection is not affected: it creates the namespace and database
it is pointed at, and is told which one is missing if either is later removed.

On **SurrealDB 3.0**, a removed namespace or database is reported as an uncoded
key-value-store error rather than a named `26`. The guarantee that matters holds
— the read fails instead of answering `[]` — but the message does not say which
namespace is missing, and `err.code` is absent. 3.1 and later name it.

### Sorting by a field an inclusion projection omits

SurrealDB requires every `ORDER BY` idiom to appear in the statement's own field
list. `SELECT tag FROM t ORDER BY k` is a parse error — ``Missing order idiom `k`
in statement selection`` — not a slower query. MongoDB has no such rule, so this is
the one place where a projection and a sort cannot be chosen independently, and
this driver **refuses the read** rather than silently answering something else:

```ts
// MongoCompatibilityError: Sorting by k while projecting a different set of
// fields is not supported: SurrealDB requires every ORDER BY field to appear in
// the statement's own field list. Include that field in the projection, use an
// exclusion projection instead, or sort the results after reading them.
await users.find({}, { projection: { tag: 1 }, sort: { k: 1 } }).toArray();
```

The error names the columns the field list is missing, and is raised before
anything is sent to the server. It applies to `find`, `findOne` and a cursor
however it was chained (`.project().sort()` and `.sort().project()` alike), and to
a `sort` on several fields when any one of them is unprojected, on `_id` where the
projection sets `_id: 0`, and on a dotted path — `sort({'a.b': 1})` needs `a.b`
itself in the projection, since a projection of `a` names `a` rather than `a.b`.

There are three ways to get the documents, all of which behave exactly as MongoDB
does:

```ts
// 1. Name the sort's field in the projection. It comes back in the documents.
await users.find({}, { projection: { tag: 1, k: 1 }, sort: { k: 1 } }).toArray();

// 2. Use an exclusion projection. It selects everything and removes fields
//    afterwards, so it can order by a field it hides — `k` orders the read and
//    appears in none of the documents.
await users.find({}, { projection: { k: 0 }, sort: { k: 1 } }).toArray();

// 3. Read the documents whole and shape them in your own code, when the sort's
//    field must not appear in what you hand on. Sorting the array yourself,
//    rather than in the read, works the same way.
const docs = (await users.find({}, { sort: { k: 1 } }).toArray()).map(
  ({ _id, tag }) => ({ _id, tag }),
);
```

An inclusion projection always leads with the identity column, so a sort on `_id`
needs nothing added unless the projection suppresses `_id`.

The constraint is SurrealDB's rather than this driver's, and is filed upstream as
`surrealdb/surrealdb-private#900`. A subquery — ordering a `SELECT *` inside and
projecting outside it — would satisfy it, and is not used: measured on 3.2.x, a
sorted, projected, paged read in that shape costs 2.7 to 4.1 times what the same
read ordered in place costs, widening as the table grows. Paying that on every
projected read to serve one shape trades a loud, explainable refusal for a quiet
cliff under the reads that already work. When the constraint is relaxed upstream,
these reads order in place like any other.

One ordering is exempt, because no field list could ever carry it: the distance
[`$near`](#geospatial) orders by is an expression rather than a field, so that
read projects the distance under an alias in a subquery and orders by the alias
inside it. An explicit `sort` replaces the distance ordering, exactly as it does
in MongoDB — and is then subject to the rule above.

## BSON types

MongoDB documents carry BSON values; SurrealDB carries SurrealQL values. The two
types that matter for everyday use round-trip as themselves — write an `ObjectId`
or a `Date`, read the same class back:

| Value | Stored as | Read back as |
| --- | --- | --- |
| `ObjectId` | the object `{ "$oid": "<24 hex characters>" }` | `ObjectId` |
| `Date` | a SurrealDB `datetime` | `Date`, to the millisecond |
| string, number, boolean, `null`, array, sub-document | the SurrealQL equivalent | as written |

That holds everywhere a value can appear: as `_id`, as a field, nested in a
sub-document, as an array element, inside an array of sub-documents, in a filter
(including `$in`), in a `$set` or `$push` operand, in a replacement or an upsert,
in `distinct`, and in what `findOneAndUpdate` hands back.

```typescript
const authorId = new ObjectId();
await posts.insertOne({ authorId, tags: [authorId], publishedAt: new Date() });

const post = await posts.findOne({ authorId });
post.authorId instanceof ObjectId; // true
post.publishedAt instanceof Date; // true
```

### What an ObjectId is stored as

An ObjectId is stored as the single-field object `{ "$oid": "<hex>" }`, both as a
record id and as a value inside a document. `$oid` is MongoDB Extended JSON's own
spelling for an ObjectId, so the value says what it is to anyone reading it in
SurrealDB's tooling, and a `$`-prefixed field name is one MongoDB's own tooling
treats as reserved — which keeps the form from colliding with a document you
wrote yourself.

- A record whose `_id` is an ObjectId is addressed as
  ``users:{ "$oid": '6a7b933c2627a1d7fdb21827' }``. In hand-written SurrealQL the
  field name has to be quoted, since a bare `$oid` reads as a parameter — which is
  how SurrealDB prints it back to you, so a copied id pastes straight into a query.
- Equality, `INSIDE` (from `$in`), `ORDER BY` and unique indexes all work on it.
  Ordering stays chronological, because comparing the objects compares the hex
  inside them and the leading bytes of an ObjectId are its timestamp.
- Reconstruction is deliberately narrow: **exactly one field, named `$oid`,
  holding exactly 24 lowercase hex characters**. `{ "$oid": "…", note: "mine" }`
  and `{ "$oid": "not-an-id" }` are documents, and come back as documents.
- A **document** is never read as an id, however much it looks like one: a
  document of exactly that shape comes back as itself, with its field intact. The
  one ambiguity left is a *value* — a sub-document or array element — that is
  exactly that shape, which comes back as an `ObjectId`. That is the same trade
  Extended JSON itself makes.

### `_id` and record ids

MongoDB's `_id` is SurrealDB's `id` column, so it is stored as a `RecordId` whose
table is the collection and whose id part is the `_id` itself:

| `_id` | Record id | Read back as |
| --- | --- | --- |
| `ObjectId` | `users:{ "$oid": '6a7b…' }` | `ObjectId` |
| string | `users:⟨the string, verbatim⟩` | the same string |
| number | `users:42` | the same number |
| anything else | `users:⟨String(value)⟩` | that string |

The consequences worth knowing:

- **A string `_id` is stored exactly as given**, colons and all: `'urn:uuid:1234'`
  reads back as `'urn:uuid:1234'`. Nothing is split or stripped, because
  SurrealDB's `RecordId` carries the table separately from the id.
- **A string that looks like an ObjectId stays a string.** `_id: '6a7b933c…'` is
  read back as a string, and `_id: new ObjectId('6a7b933c…')` as an `ObjectId` —
  they are *different records*, and each is matched only by a filter of its own
  type. That is what the tagged form buys: MongoDB never promotes a string `_id`
  to an ObjectId, and neither does this.
- **A duplicate `_id` reports the value you supplied**, with its type intact, in
  `err.keyValue._id` (code `11000`).
- **An `_id` that is not a string, number or ObjectId is stringified**, since a
  record id has to be one of SurrealDB's own id types. MongoDB would store the
  document, array or boolean as itself.

### Dates

`Date` is stored as a SurrealDB `datetime` and read back as a `Date`, with
milliseconds preserved. Comparison operators (`$gt`, `$lt`, …), sorting and
`$type: "date"` all work against it.

SurrealDB's `datetime` is nanosecond-precise, and a `Date` is not: a datetime
written by SurrealDB itself — or by any other client — with sub-millisecond
digits arrives here **rounded to the millisecond**. That is the deliberate trade
for handing back a real `Date`, which is the only date type MongoDB has.

### The ObjectId class

`ObjectId` is this driver's own implementation rather than a re-export of `bson`:
this package has exactly one runtime dependency (`surrealdb`), speaks CBOR rather
than BSON, and `bson` cannot even be imported under Bun without patching
`v8.startupSnapshot`. Its behaviour is pinned against the real class member by
member — construction, `isValid`, `equals`, `getTimestamp`, `createFromTime`,
`toString`, `toJSON`, `inspect` and the messages of every rejection — in
`tests/unit/object-id-parity.test.ts`.

Two consequences for code that mixes drivers:

- **Ids from `bson` and mongoose are accepted anywhere an id is** — in a
  document, a filter, or as an `_id` — and are stored as ids. Ids compare equal
  across implementations in both directions, and `new ObjectId(otherId)` works
  either way round. Reads return this driver's class.
- **Handing this driver's `ObjectId` to the official driver's BSON serialiser is
  refused** by `bson`'s own version check (`bson types must be from bson 7.x.x`),
  because this class does not claim to be a `bson` value. Wrap it —
  `new bson.ObjectId(id)` — if a document has to cross over.

Where the class deliberately differs from `bson`'s:

- **The twelve bytes are hidden.** `Object.keys(id)` is empty and `{...id}` is
  `{}`, where `bson` exposes an own `buffer` property that a spread copies. An id
  is one opaque value, and spreading a document must not turn one into a
  sub-document of driver internals.
- **The bytes are copied, not aliased**, so mutating the `Uint8Array` you
  constructed an id from cannot change the id afterwards.
- **`new ObjectId(1700000000)` throws.** `bson` removed the
  timestamp-from-number constructor, so accepting a number would let code work
  here and fail against the official driver. Use
  `ObjectId.createFromTime(seconds)`.
- **Rejections are `MongoInvalidArgumentError`** (this driver's hierarchy)
  carrying `bson`'s wording, so message matching behaves the same.

### BSON types with no representation

Everything else in BSON has no SurrealDB counterpart. A value of one of these
types **throws a `MongoCompatibilityError` naming the type** rather than being
written: it is an object on the wire, so it would otherwise be stored as
whatever its internals happen to be — a `Decimal128` as `{bytes: …}` — and read
back as a plain object that is no longer a decimal.

This asks what a value *is*, not what its fields are called: a document of your
own with a `_bsontype` field in it is data, and is stored as written.

| BSON type | Use instead |
| --- | --- |
| `Decimal128` | a `number`, a decimal string, or SurrealDB's own `Decimal` from the `surrealdb` package |
| `Long`, `Int32`, `Double` | a `number`, or a `bigint` — which round-trips as a `bigint` and is queryable as one |
| `Binary` | a `Uint8Array`, which is stored as SurrealDB `bytes` and read back as an `ArrayBuffer` |
| `UUID` (a `Binary` subtype, and reported as one) | a string, or SurrealDB's own `Uuid` |
| `Timestamp` | a `Date`, or a number of milliseconds |
| `Code` | nothing: server-side JavaScript has no equivalent here |
| `MinKey`, `MaxKey` | nothing: there are no sentinel bounds to sort against |
| `DBRef` | the fields themselves — an `ObjectId` plus the collection name |

A value from the `surrealdb` package (`Decimal`, `Uuid`, `Duration`, `RecordId`)
passes through untouched in both directions, so a document can hold
SurrealDB-native values as long as your own code expects them back. A geometry is
the exception: it is written the same way a GeoJSON object is and reads back as
GeoJSON, because the two are the same stored value — see [Geospatial](#geospatial).

The BSON serialisation options — `raw`, `promoteValues`, `promoteLongs`,
`promoteBuffers`, `useBigInt64`, `bsonRegExp`, `serializeFunctions`, `checkKeys`,
`fieldsAsRaw`, `enableUtf8Validation` — throw for the same reason: there is no
BSON serialiser here whose behaviour they could select.

## Query filters

Filters use the MongoDB query language and are translated to SurrealQL at execution time.

### Comparison

```typescript
{ age: 30 }                // implicit $eq
{ age: { $eq: 30 } }       // explicit $eq
{ age: { $ne: 30 } }       // not equal
{ age: { $gt: 18 } }       // greater than
{ age: { $gte: 18 } }      // greater than or equal
{ age: { $lt: 65 } }       // less than
{ age: { $lte: 65 } }      // less than or equal
{ age: { $gt: 18, $lt: 65 } } // combined range
```

### Membership

```typescript
{ status: { $in: ["active", "pending"] } }   // in array
{ role: { $nin: ["admin", "root"] } }         // not in array
```

### Logical

```typescript
{ $and: [{ active: true }, { age: { $gte: 18 } }] }  // AND
{ $or: [{ name: "Alice" }, { name: "Bob" }] }         // OR
{ $nor: [{ status: "deleted" }, { status: "banned" }] } // NOR
{ age: { $not: { $gt: 65 } } }                         // NOT
```

### Element

```typescript
{ email: { $exists: true } }   // field exists
{ email: { $exists: false } }  // field does not exist
```

### Evaluation

```typescript
{ name: { $regex: "^Al" } }      // regex match
{ name: /^Al/i }                   // native RegExp
{ qty: { $mod: [4, 0] } }         // modulo (qty % 4 === 0)
{ age: { $type: "number" } }      // type check (BSON type string or code)
{ age: { $type: 16 } }            // type check by numeric BSON type code
```

Supported `$type` values: `"double"`, `"string"`, `"object"`, `"array"`, `"bool"`, `"date"`, `"null"`, `"int"`, `"long"`, `"decimal"`, `"number"` (any numeric), and their BSON numeric codes.

### Array

```typescript
{ tags: { $all: ["a", "b"] } }     // contains all elements
{ tags: { $size: 3 } }              // array has exactly 3 elements
{ results: { $elemMatch: { score: { $gt: 80 }, grade: "A" } } } // element matches
```

### Geospatial

A GeoJSON geometry a caller writes is stored as SurrealDB's own geometry type and
read back as GeoJSON, which is what MongoDB returns and what `JSON.stringify`
will produce. All seven geometry types are supported — `Point`, `LineString`,
`Polygon`, `MultiPoint`, `MultiLineString`, `MultiPolygon` and
`GeometryCollection` — in a top-level field, nested, inside an array, as an
`$set`/`$push` operand and as a filter operand.

```typescript
await places.insertOne({
  name: "Grand Central",
  location: { type: "Point", coordinates: [-73.9772, 40.7527] },
});

const found = await places.findOne({ name: "Grand Central" });
// { _id: ..., name: 'Grand Central',
//   location: { type: 'Point', coordinates: [ -73.9772, 40.7527 ] } }
```

#### What is recognised as a geometry

A GeoJSON object is a plain object with a `type` and some coordinates, which a
caller could legitimately have written as data. Recognition is therefore narrow.
A value is stored as a geometry only when it is a plain object with **exactly
two** keys, whose `type` is one of the seven above and whose other key is
`coordinates` (or `geometries`, for a `GeometryCollection`) holding an array.

- `{type: "Point", coordinates: [1, 2]}` → a geometry.
- `{type: "Point", coordinates: [1, 2], label: "home"}` → **data**, stored as
  written. SurrealDB's geometry holds coordinates and nothing else, so converting
  it would silently drop `label`. Being an ordinary object, it matches no
  geospatial query.
- `{type: "Polygon", coordinates: "see attachment"}` → **data**: the payload is
  not an array, so nothing about it says "geometry".
- `{type: "Circle", coordinates: [1, 2]}` → **data**: not a GeoJSON geometry type.

Once an object *is* recognised, coordinates SurrealDB's geometry cannot hold
**throw** rather than falling back to plain-object storage: an unclosed linear
ring, a `LineString` with one point, an empty `MultiPolygon`, a position that is
not a pair of finite numbers. Stored as an object it would match no geospatial
query ever again, and guessing — closing the ring, dropping an ordinate — would
hand back something other than what was written. MongoDB rejects a malformed
geometry too, once the collection has the `2dsphere` index that makes it
queryable.

One of those rules is stricter than MongoDB's, and not because the value is
wrong: a position with a **third ordinate** — GeoJSON's optional altitude,
`[lng, lat, alt]` — throws. MongoDB stores it, ignoring the altitude when it
indexes; SurrealDB's geometry has nowhere to put it, so storing it would mean
dropping what a caller wrote.

Coordinates out of range go the other way: a `lng` outside ±180 or a `lat`
outside ±90 is stored, and compared, as written. MongoDB rejects both. See the
divergence table.

#### $geoWithin

```typescript
// Inside a GeoJSON Polygon, MultiPolygon or GeometryCollection
{ location: { $geoWithin: { $geometry: {
  type: "Polygon",
  coordinates: [[[-74, 40.7], [-73.9, 40.7], [-73.9, 40.8], [-74, 40.8], [-74, 40.7]]]
} } } }

// Legacy shapes
{ location: { $geoWithin: { $box: [[-74.0, 40.7], [-73.9, 40.8]] } } }
{ location: { $geoWithin: { $polygon: [[-74, 40.7], [-73.9, 40.7], [-73.9, 40.8]] } } }
{ location: { $geoWithin: { $center: [[-73.93, 40.82], 0.05] } } }        // degrees
{ location: { $geoWithin: { $centerSphere: [[-73.93, 40.82], 5 / 6378.1] } } } // radians
```

`$geometry` must name a geometry that encloses an area; a `Point` or
`LineString` throws, as it does in MongoDB. The four legacy shapes match
point-valued fields only, again as in MongoDB, and are exact rather than
approximated: `$box` and `$polygon` become the ring they describe, `$center` the
flat circle its degrees describe, `$centerSphere` an angle compared against
`geo::distance`. A point sitting exactly **on** the boundary is within, as it is
in MongoDB, for every one of the five forms.

Only a GeoJSON geometry is a geometry here. MongoDB also reads a bare
`[longitude, latitude]` pair, and a two-field object such as `{lng, lat}`, as a
legacy point and matches it; those are ordinary data to this driver and match no
geospatial query. See the divergence table.

#### $geoIntersects

```typescript
{ area: { $geoIntersects: { $geometry: {
  type: "Polygon",
  coordinates: [[[0, 0], [3, 6], [6, 1], [0, 0]]]
} } } }
```

Any of the seven geometry types may be the query geometry. The legacy shapes are
rejected here, as MongoDB rejects them.

#### $near and $nearSphere

```typescript
// Nearest first, bounded in metres
{ location: { $near: {
  $geometry: { type: "Point", coordinates: [-73.9667, 40.78] },
  $minDistance: 100,    // metres, optional
  $maxDistance: 5000,   // metres, optional
} } }

// The same, spherical
{ location: { $nearSphere: {
  $geometry: { type: "Point", coordinates: [-73.9667, 40.78] },
  $maxDistance: 5000,
} } }

// Legacy coordinate pair: the bound is in radians
{ location: { $nearSphere: [-73.9667, 40.78], $maxDistance: 5000 / 6378100 } }
```

Both order results by distance ascending, and both compose with the rest of a
query: other filter conditions, `limit`, `skip`, a projection, a cursor, and a
transaction. An explicit `sort` replaces the distance ordering, which is what
MongoDB does — and that sort is then an ordinary one, so an inclusion projection
has to name its fields (see [Sorting by a field an inclusion projection
omits](#sorting-by-a-field-an-inclusion-projection-omits)). `findOne`,
`updateOne`, `deleteOne` and the `findOneAnd*` methods act on the nearest matching
document.

**Distances are metres, and the two engines measure them on different spheres.**
`geo::distance` measures on a sphere of radius 6 371 008.8 m; MongoDB measures a
metre distance on one of radius 6 378 100 m. A `$maxDistance` in metres is a
MongoDB metre, so the driver converts it — passing the number through unchanged
would move the boundary by 0.11 %, taking the documents nearest it with it. A
radian bound (`$centerSphere`, legacy-pair `$nearSphere`) needs no earth model at
all and is exact.

#### Geospatial behaviour that differs from MongoDB

| Behaviour | This driver | MongoDB |
| --- | --- | --- |
| Index | none: `2dsphere` and `2d` are rejected by `createIndex`, so every geospatial query is a **full collection scan** | `$near`/`$nearSphere` *require* a `2dsphere` index and refuse to run without one |
| A field holding a legacy `[longitude, latitude]` pair, or a `{lng, lat}`-style object, instead of GeoJSON | ordinary data: matches no geospatial query, in any operator | read as a point and matched |
| A stored **line or polygon** lying exactly along the query polygon's edge | not `$geoWithin` (`INSIDE` tests the interior); it *does* `$geoIntersects`. A stored **point** on the edge is within, as in MongoDB | within |
| A point on a **slanted** edge of a legacy `$polygon` | within, as for every other boundary point | not within — though MongoDB *does* count a vertex, an axis-aligned edge, and the same point under `$geometry` |
| A coordinate out of range (`lng` beyond ±180, `lat` beyond ±90), stored or in a query geometry | accepted and compared planar | rejected (`Longitude/latitude is out of bounds`) |
| A position with a third ordinate, `[lng, lat, alt]` | throws: SurrealDB's geometry holds two ordinates, and storing it would drop the altitude | stored, altitude ignored when indexing |
| `$minDistance`/`$maxDistance` written *beside* a `$near`/`$nearSphere` whose operand is a `$geometry` | accepted, and applied | rejected: the bound belongs inside the operand unless the operand is a legacy pair |
| Several documents at exactly the same distance under `$near` | ordered arbitrarily among themselves | ordered arbitrarily among themselves (neither engine promises a tie-break) |
| `$near` over a field holding an *array* of points | no match: there is no single distance to order by, so a point per document is required. `$geoWithin` and `$geoIntersects` do match element-wise | matches, ordering by the nearest element |
| `$near` over a non-`Point` geometry | no match: `geo::distance` is defined for points | matches, measuring to the nearest point of the geometry |
| `$near` with a legacy coordinate pair | throws, naming `$nearSphere` — the flat measurement needs a `2d` index | supported with a `2d` index |
| `$near` in `countDocuments` or `distinct` | works; the distance band applies and ordering is irrelevant to both | rejected, because both run as aggregations |
| `$near` inside `$not`, `$nor`, `$elemMatch`, or an `$or` with more than one branch | throws | throws (`geo $near must be top-level expr`) |
| A document whose *only* fields are `type` and `coordinates` | throws: that is how a geometry is stored, and SurrealDB cannot hold one where a document belongs. Nest it under a field of its own | stored as written |
| A `Polygon` spanning more than half the globe, or a `$geoWithin` polygon with very long edges | edges are straight lines in coordinate space | `$geometry` edges are geodesics, so a large polygon covers a different area |
| A geometry written as an SDK `GeometryPoint`/`GeometryPolygon`/… | reads back as GeoJSON | not applicable |

### Full-text search

Full-text search requires a text index to be created first.

```typescript
// Create a text index
await collection.createIndex({ title: "text" });

// Search
const results = await collection.find({ $text: { $search: "coffee shop" } }).toArray();
```

Multi-field text indexes search across all indexed fields:

```typescript
await collection.createIndex({ title: "text", description: "text" });
```

### Nested fields

```typescript
{ "address.city": "London" }          // dot notation
{ "scores.0": { $gt: 90 } }           // array index
```

### Names

Any name MongoDB accepts works: collections, fields, indexes and databases may
contain spaces, hyphens, dots, unicode, or collide with a SurrealQL keyword.

```typescript
db.collection("function");                     // a SurrealQL keyword
collection.find({ "first name": "Ada" });      // a space
collection.find({ "a-b": 7 });                 // a hyphen
collection.createIndex({ x: 1 }, { name: "only" });
client.db("alter");
```

Every name this driver puts into a statement is quoted, and every value is sent
as a bound parameter. So a name is only ever a name — which matters because a
filter key is usually built from request input, and because SurrealQL would
otherwise read some of these as something else entirely. Bare, `{'a-b': 1}` is
subtraction, `{'x` = 1 OR true OR `': 1}` is a predicate that matches every row,
and a collection called `none` reads as permanently empty rather than failing.

One exception, and it is SurrealDB's rather than this driver's: **you cannot
index a field whose name is a SurrealQL statement keyword.**

```typescript
await collection.createIndex({ select: 1 });      // MongoCompatibilityError
await collection.createIndex({ "doc.select": 1 }); // fine
```

SurrealDB accepts such an index and then cannot read its own stored definition
back, which leaves the collection unreadable and the database undroppable
(`surrealdb/surrealdb-private#906`). `createIndex` refuses these 26 names up
front — `alter`, `break`, `continue`, `create`, `define`, `delete`, `explain`,
`false`, `for`, `function`, `if`, `info`, `insert`, `let`, `none`, `null`,
`rebuild`, `relate`, `remove`, `return`, `select`, `sleep`, `throw`, `true`,
`update`, `upsert` — and only as the *leading* segment of a path, which is why
`doc.select` is fine. Everything else about such a field works: it can be
queried, sorted, projected and updated. Should a later SurrealDB version add a
keyword this list has not heard of, `createIndex` reads every definition back
inside the transaction that wrote it, so the attempt fails and leaves the
collection untouched rather than damaging it.

## Update operators

### Field operators

| Operator | Example | Description |
| --- | --- | --- |
| `$set` | `{ $set: { name: "Jane" } }` | Set field value |
| `$setOnInsert` | `{ $setOnInsert: { status: "new" } }` | Set only on insert during upsert |
| `$unset` | `{ $unset: { email: "" } }` | Remove field |
| `$inc` | `{ $inc: { score: 10 } }` | Increment (or decrement with negative) |
| `$mul` | `{ $mul: { price: 1.1 } }` | Multiply |
| `$min` | `{ $min: { low: 5 } }` | Set to value if less than current |
| `$max` | `{ $max: { high: 100 } }` | Set to value if greater than current |
| `$rename` | `{ $rename: { old: "new" } }` | Rename field |
| `$currentDate` | `{ $currentDate: { updatedAt: true } }` | Set to current timestamp |

### Array operators

| Operator | Example | Description |
| --- | --- | --- |
| `$push` | `{ $push: { tags: "new" } }` | Append to array |
| `$push` + `$each` | `{ $push: { tags: { $each: ["a", "b"] } } }` | Append multiple |
| `$push` + `$sort` | `{ $push: { scores: { $each: [85], $sort: 1 } } }` | Append and sort |
| `$push` + `$slice` | `{ $push: { tags: { $each: ["a"], $slice: 5 } } }` | Append and cap length |
| `$addToSet` | `{ $addToSet: { tags: "unique" } }` | Add if not present |
| `$pull` | `{ $pull: { tags: "old" } }` | Remove matching elements |
| `$pullAll` | `{ $pullAll: { tags: ["a", "b"] } }` | Remove all listed elements |
| `$pop` | `{ $pop: { tags: 1 } }` | Remove last (`1`) or first (`-1`) element |

### Positional array operators

Update specific elements within arrays using positional operators in field paths.

```typescript
// Update all array elements
await users.updateMany(
  {},
  { $set: { "scores.$[].passed": true } },
);

// Update elements matching a condition (arrayFilters)
await users.updateMany(
  {},
  { $set: { "grades.$[elem].adjusted": true } },
  { arrayFilters: [{ "elem.score": { $gte: 90 } }] },
);

// Increment a field on filtered elements
await users.updateMany(
  {},
  { $inc: { "items.$[item].qty": 1 } },
  { arrayFilters: [{ "item.status": "active" }] },
);
```

| Syntax | Description |
| --- | --- |
| `"field.$[]"` | All elements in the array |
| `"field.$[id]"` | Elements matching the `arrayFilters` condition for `id` |

## Cursors

The `find()` method returns a `FindCursor` that is lazy -- no query is executed until results are consumed.

### Chaining

```typescript
const results = await users
  .find({ active: true })
  .sort({ age: -1 })     // descending
  .skip(10)               // skip first 10
  .limit(5)               // return at most 5
  .project({ name: 1, age: 1, _id: 0 })
  .toArray();
```

### Consuming results

```typescript
// All results as an array
const all = await cursor.toArray();

// One at a time
const first = await cursor.next();
const second = await cursor.next(); // null when exhausted

// Check availability
if (await cursor.hasNext()) { /* ... */ }

// Iterate with a callback
await cursor.forEach((doc) => {
  console.log(doc.name);
});

// Async iteration
for await (const doc of cursor) {
  console.log(doc.name);
}

// Transform results
const names = await cursor
  .map((doc) => ({ fullName: doc.name }))
  .toArray();
```

### Lifecycle

```typescript
// Rewind to iterate again
cursor.rewind();

// Clone to create an independent copy
const copy = cursor.clone();

// Close to release resources
await cursor.close();
console.log(cursor.closed); // true
```

## Indexes

```typescript
// Create a standard index
await users.createIndex({ email: 1 });

// Enforce uniqueness — a duplicate write fails with code 11000
await users.createIndex({ email: 1 }, { unique: true });

// Compound and descending keys
await users.createIndex({ lastName: 1, age: -1 });

// A text index for full-text search
await users.createIndex({ bio: "text" });

// A named index
await users.createIndex({ age: 1 }, { name: "age_asc" });

// Several at once
await users.createIndexes([{ key: { a: 1 } }, { key: { b: -1 }, unique: true }]);

// Read them back — a cursor, as in the MongoDB driver
const indexes = await users.listIndexes().toArray();
const asArray = await users.indexes();
const compact = await users.indexInformation(); // { email_1: [["email", 1]] }
const exists = await users.indexExists("email_1");

// Drop one, or all but _id_
await users.dropIndex("age_asc");
await users.dropIndexes();
```

`createIndex` is idempotent: re-creating an identical index succeeds and returns
its name, while reusing a name for a different key raises code `86`
(`IndexKeySpecsConflict`), matching MongoDB. Indexes are read from the server on
every call, so a new `Collection` instance, a second process and a reconnected
client all see the same list.

### Index behaviour that differs from MongoDB

Unsupported options **throw** rather than being silently accepted, so a caller
never believes an index does something it does not:

| Option | Behaviour | Why |
| --- | --- | --- |
| `expireAfterSeconds` (TTL) | throws | SurrealDB `DEFINE INDEX` has no TTL clause |
| `partialFilterExpression` | throws | no partial-index equivalent |
| `collation` | throws | index-level collation is not expressible |
| `weights`, `default_language`, `language_override` | throws | full-text ranking is fixed to BM25 over the indexed fields |
| `hidden: true` | throws | indexes cannot be hidden from the planner |
| `wildcardProjection` | throws | no wildcard indexes |
| `sparse: false` | throws | see below |
| `2d`, `2dsphere`, `geoHaystack`, `hashed` keys | throws | no equivalent index type, and a plain index would not make `$near` index-backed. Geospatial queries still run — as full scans; see [Geospatial](#geospatial) |
| `background`, `storageEngine`, `commitQuorum`, version fields | accepted, no effect | no meaning here, and MongoDB itself ignores several of them |

Other differences worth knowing:

- **A field whose name is a SurrealQL statement keyword cannot be indexed.**
  `createIndex({ select: 1 })` throws. SurrealDB accepts the index and then
  cannot read its own definition back, leaving the collection unreadable and the
  database undroppable (`surrealdb/surrealdb-private#906`), so the driver refuses
  it up front and reads every definition it does send back inside the
  transaction that wrote it. Only the leading path segment is affected — see
  [Names](#names).
- **Unique indexes are always sparse.** Two documents that both omit a
  unique-indexed field are both accepted; MongoDB indexes the absent field as
  `null` and rejects the second. Because `sparse: false` is MongoDB's *default*,
  it is rejected only when passed explicitly.
- **A compound text index becomes one full-text index per field.** MongoDB
  creates a single index with per-field weights; SurrealDB rejects more than one
  column in a `FULLTEXT` definition. The parts are reported back as the single
  index you asked for, and `$text` searches all of its fields. Mixing a `"text"`
  field with a non-text field in one key throws.
- **A text index's key is reported as you supplied it** (`{ title: "text" }`),
  where MongoDB reports its internal `{ _fts: "text", _ftsx: 1 }` plus `weights`
  and `textIndexVersion`. Tooling that keys off `_fts` will not find it.
- **`v`** (the on-disk index format version MongoDB always reports as `2`) is
  omitted, as it has no SurrealDB counterpart.
- **Directions are recorded, not enforced.** SurrealDB indexes serve both
  directions, so `-1` is preserved in the reported key and in generated names
  (`age_-1`) but does not change the physical index.
- **A missing collection is not an error.** `listIndexes`, `indexes` and
  `indexInformation` report just `_id_`, and `dropIndexes()` returns `true`,
  where MongoDB raises `26` (`NamespaceNotFound`). `dropIndex` on an unknown
  name raises `27` (`IndexNotFound`) rather than `26`.
- **`keyPattern`/`keyValue`** on a duplicate-key error are populated only when
  the violated index follows the generated `field_1` naming convention. For a
  custom-named index the fields cannot be recovered from the server's message,
  and inventing them would be worse than omitting them. An `_id` collision is
  exempt: it is always attributed to the implicit `_id_` index, so both are
  always reported.

## Database operations

```typescript
const db = client.db("mydb");

// List all collections — a cursor, as in MongoDB, so it is not awaited itself
const collections = await db.listCollections().toArray();
// [{ name: "users", type: "collection" }, ...]

// Filter by the fields a collection reply carries
await db.listCollections({ name: "users" }).toArray();
await db.listCollections({ name: { $in: ["users", "logs"] } }).toArray();

// Create a collection explicitly
const logs = await db.createCollection("logs");

// Drop a collection
await db.dropCollection("logs");

// Drop the entire database
await db.dropDatabase();
```

Every `Db` method runs its options through the same gate as the collection
operations, so an unsupported option is refused here too rather than dropped a
layer above the code that would have applied it. `session` matters most: pass one
and the statement runs in that transaction, so a `createCollection` or a
`dropCollection` is rolled back with the rest of it.

`listCollections` returns a cursor rather than a promise, as MongoDB's does, with `toArray`, `next`, `hasNext`, `forEach` and `[Symbol.asyncIterator]` — the same shape as `listIndexes`. Nothing is sent until you consume it. It matters beyond tidiness: a wrapper that reads `.toArray` off the result — mongoose does exactly this — gets `undefined` from a promise.

It filters the *reply*, so its predicate applies to the `{name, type}` documents rather than to stored rows. `name` and `type` are matched with `$eq`, `$ne`, `$in`, `$nin` and `$regex`; a filter naming any other field is rejected, because a predicate over data the reply does not carry would otherwise silently match everything.

`createCollection` rejects the collection-shaping options `DEFINE TABLE` has no
counterpart for — `capped`, `size`, `max`, `validator`, `validationLevel`,
`validationAction`, `timeseries`, `expireAfterSeconds`, `viewOn`, `pipeline` and
`clusteredIndex`. Handing back an ordinary table for a request that asked for a
capped one, a view, or a time-series collection would misrepresent the storage
being written to, rather than merely omitting a refinement.

`Db.collections()` returns the same list as `listCollections()`, as `Collection`
handles rather than as `{name, type}` documents. `Collection.drop()` is
`Db.dropCollection(collectionName)` addressed from the collection.

### Addressing more than one database

```typescript
const client = new MongoClient("mongodb://127.0.0.1:8000/mydb?namespace=ns");

await client.db().collection("users").find({}).toArray();        // mydb
await client.db("mydb").collection("users").find({}).toArray();  // mydb
await client.db("reports").collection("daily").insertOne({});    // reports
```

One client addresses every database in its namespace. `client.db(name)` is
synchronous, cheap and repeatable — `client.db("x").collection("y")` inline in a
loop allocates two façades and asks nothing of the server — and the statements it
issues name the database they belong to, so `listCollections`, `collections`,
`stats`, `dropDatabase`, `db.command`, `db.admin()`, every index method and every
collection operation act on the database named rather than on the connected one.

A statement for the connected database is unchanged by any of this: it carries no
database prefix, costs no extra round trip, and holds nothing open server-side —
and neither does one for another database, which is a prefix on the statement
rather than a second connection.

A **transaction spans databases**, as MongoDB's does: hand one session to
operations on two databases and a commit applies to both, an abort rolls back
both, and a read in the transaction sees its own write to either.

```typescript
const session = client.startSession();
await session.withTransaction(async () => {
  await client.db("ledger").collection("entries").insertOne({ n: 1 }, { session });
  await client.db("audit").collection("log").insertOne({ n: 1 }, { session });
});
await session.endSession();
```

A database is created on first use, as MongoDB creates one on first write, and
reading one that does not exist answers emptily rather than failing. Two details
differ from MongoDB, both of them SurrealDB's `USE` semantics rather than this
driver's bookkeeping:

- **Addressing a database creates it, even to read.** MongoDB creates a database
  only on a write, so a `find` against one that does not exist leaves it absent
  from `listDatabases`; here it will be listed, empty. This is what `connect()`
  has always done for the connected database. The two commands that report on the
  *deployment* rather than on a database — `ping` and `listDatabases` — are
  exempt, because they name no database and a `listDatabases` that did would
  report one the question had just invented.
- **A missing database reads as empty only when it is not the connected one.** A
  `db("gone")` whose database has been dropped answers `[]`, `null` and `0`, as
  MongoDB does. The connected database going missing still throws — see
  [A collection that has never been written to](#a-collection-that-has-never-been-written-to)
  for why that distinction is kept: a mistyped connection string must not look
  like an empty dataset.

`client.db(name)` refuses a name containing `.`, which is the only name the
official driver refuses client-side (measured against 7.5.0), and an empty name
means the connection string's database, as it does there. Names a mongod would
then reject at the server — over 63 bytes, or containing `$` — are accepted here,
because SurrealDB has no such restriction to reject them with.

### Commands

```typescript
await db.command({ ping: 1 });                     // { ok: 1 }
await db.command({ dbStats: 1 });                  // counts for this database
await db.command({ collStats: "users" });          // counts for one collection
await db.stats();                                  // the dbStats reply

const admin = db.admin();
await admin.ping();
await admin.buildInfo();                           // version information
await admin.serverInfo();                          // buildInfo, under its other name
await admin.listDatabases();                       // { databases: [{ name }], ok: 1 }
```

`db.command()` is a real router rather than a refusal, because ORMs and tooling
reach for it constantly. It answers `ping`, `buildInfo`, `dbStats`, `collStats`,
`create`, `drop`, `listCollections`, `createIndexes` and `dropIndexes`;
`listDatabases` and `replSetGetStatus` are restricted to `db.admin()`, exactly as
a real mongod restricts them to the `admin` database — sent to `db.command()`
they raise `13` (`Unauthorized`) with mongod's own message. The delegating
commands go through the public methods, so a command inherits the option gate, the
session routing and the divergences those methods already document instead of
acquiring its own: `db.command({create}, {session})` is rolled back with the
transaction that ran it, and `db.command({create: "logs", capped: true})` is
refused exactly as `createCollection("logs", {capped: true})` is, rather than
answering `ok: 1` and leaving behind a table that is not what was asked for.

`ping` is a round trip, as mongod's is. A liveness probe that cannot fail is not
one, so `db.command({ping: 1})` and `admin().ping()` reach the server and report
an unreachable deployment as unreachable.

**Every reply omits what cannot be derived, rather than filling it with zeros.**
The shapes were measured against a real mongod (8.2); a caller reading
`storageSize: 0` would conclude the collection is empty, while a caller finding no
such field knows the number was unavailable. MongoDB itself omits the size fields
from `listDatabases({nameOnly: true})`, so an absent field is a shape callers
already handle.

| Command | Reported | Omitted |
| --- | --- | --- |
| `ping` | `ok` | — |
| `buildInfo` | `version`, `versionArray`, `surrealdbVersion`, `ok` | `gitVersion`, `buildEnvironment`, `storageEngines`, `maxBsonObjectSize`, `allocator`, `javascriptEngine`, `openssl` — all describe a mongod binary that is not running |
| `listDatabases` | `databases: [{name}]`, `ok` | `sizeOnDisk`, `empty`, `totalSize`, `totalSizeMb` — SurrealDB reports no per-database size |
| `dbStats` | `db`, `collections`, `views`, `objects`, `indexes`, `ok` | every byte-size field, and `scaleFactor` with them — with no sizes reported, `scale` has nothing to scale |
| `collStats` | `ns`, `count`, `nindexes`, `capped`, `ok` | every byte-size field, and `indexDetails`/`indexSizes` |
| `listCollections` | `cursor: {id: 0, ns, firstBatch: [{name, type}]}`, `ok` | per-collection `options`, `info`, `idIndex` |
| `create` | `ok` | — |
| `drop` | `ns`, `ok` | `nIndexesWas` — reading the index list to report it would cost a round trip on the way to removing the table it describes |
| `createIndexes` | `numIndexesBefore`, `numIndexesAfter`, `ok` | `createdCollectionAutomatically` — SurrealDB defines a table on first use and does not report whether this call was the first |
| `dropIndexes` | `nIndexesWas`, `msg` for `index: "*"`, `ok` | — |

`dbStats.views` is `0` and `collStats.capped` is `false` by derivation, not
assumption: SurrealDB has neither views nor fixed-size tables, and
`createCollection({capped: true})` is refused. `nindexes` and `dbStats.indexes`
count the implicit `_id_` entry, as mongod's do. `collStats` for a collection that
does not exist reports zeros rather than failing, which is what mongod does — and
is the one read path where this driver's usual `NamespaceNotFound` for a missing
table would be the wrong answer.

`db.admin()` is bound to the `Db` it came from. There is no separate `admin`
database — SurrealDB has no such convention — so a database-scoped command sent
through `admin().command()` reports on that `Db` rather than on a database called
`admin`.

#### What `buildInfo` reports as the version

```typescript
await db.admin().buildInfo();
// { version: "8.0.0", versionArray: [8, 0, 0, 0], surrealdbVersion: "3.2.4", ok: 1 }
```

Two numbers, because one field has a fixed meaning and the other does not exist in
MongoDB. `buildInfo.version` *is the MongoDB version*, and clients feature-gate on
it with a semantic-version comparison. Putting SurrealDB's `3.2.4` there would not
be a truthful answer to that question but an answer to a different one: read as
MongoDB 3.2 it is below the minimum server of every currently supported MongoDB
driver — the `mongodb` package this driver is validated against supports 4.2
upwards — so a client would conclude it is talking to an ancient MongoDB and
disable sessions, transactions and `$expr`, all of which work here. So `version`
carries a MongoDB release and `surrealdbVersion` carries the real one, detected on
connect. Nothing is hidden, and neither field has to lie.

`8.0.0` is the compatibility target: a current MongoDB major inside the window the
`mongodb` package supports. Over-claiming degrades safely here, because every
feature this driver does not implement raises a named, documented error at the
call that asked for it — see the boundary below — whereas under-claiming makes a
client quietly stop using features that do work. The *pair of fields* is the
frozen contract; the number is exported as `MONGODB_COMPATIBILITY_VERSION` and may
be raised as the parity suite is validated against newer MongoDB releases.
`surrealdbVersion` is absent, rather than `null`, when the server has not been
reached — so "not reported" stays distinguishable from "reported as nothing".
Unlike `ping`, `buildInfo` answers without a round trip: everything it reports
except `surrealdbVersion` is a compatibility statement about this driver, so
there is nothing to ask a server for, and its absence is what says no server
answered.

## What is not implemented

A compatibility driver's most valuable documentation is the edge of it. Every
method below **exists** and says what it cannot do and where to go instead: before
they were declared, each was `TypeError: col.aggregate is not a function`, which
tells a caller only that a property is missing — not whether the driver is broken,
out of date, or deliberately narrow. An ORM probing for a capability could not
tell those apart either, so it could not fall back.

Two error classes, chosen by **what the caller addressed**:

- a **method** on `Collection`, `Db` or `MongoClient` belongs to this driver, so
  an unimplemented one raises `MongoCompatibilityError` — the same class the
  option gate uses for a request that is valid MongoDB and that this driver
  cannot honour. It sits under `MongoAPIError` and `MongoDriverError`, so
  `catch (e) { if (e instanceof MongoDriverError) … }` narrows it, and it carries
  no `code`, because no server rejected anything.
- a **command name** passed to `db.command()` addresses a server command surface,
  so an unrouted one raises the `MongoServerError` a real mongod raises: `59`
  (`CommandNotFound`), `no such command: '<name>'`.

Each refusal also fails in the shape the real method returns: a promise-returning
method rejects, and a method that returns a value synchronously throws
synchronously.

| Method | Raises | Instead |
| --- | --- | --- |
| `Collection.aggregate()`, `Db.aggregate()` | `MongoCompatibilityError` | `find()` with a filter, sort, skip, limit and projection; `countDocuments()`; `distinct()`. For anything a pipeline is genuinely needed for, run SurrealQL through the SurrealDB client this driver wraps |
| `Collection.bulkWrite()`, `initializeOrderedBulkOp()`, `initializeUnorderedBulkOp()` | `MongoCompatibilityError` | The single-purpose methods, or `session.withTransaction()` so they commit or roll back as a unit |
| `Collection.watch()`, `Db.watch()`, `MongoClient.watch()` | `MongoCompatibilityError` | A SurrealDB live query through the SurrealDB client this driver wraps |
| `Collection.rename()`, `Db.renameCollection()` | `MongoCompatibilityError` | Create the new collection, copy the documents across, `dropCollection()` the old one |
| `Collection.createSearchIndex()`, `createSearchIndexes()`, `dropSearchIndex()`, `updateSearchIndex()`, `listSearchIndexes()` | `MongoCompatibilityError` | `createIndex()` with a text index, which becomes a SurrealDB full-text search index |
| `Admin.serverStatus()`, `removeUser()`, `validateCollection()` | `MongoServerError` `59` | Each is a thin wrapper over the command of the same name, so it inherits the command surface's `CommandNotFound`. For users, `REMOVE USER` through the SurrealDB client |
| `db.command({ <anything else> })` | `MongoServerError` `59` | See below |

Why each is refused rather than approximated:

- **Aggregation** — a partial translation is worse than none. A pipeline whose
  later stages were silently dropped still returns documents, so the caller gets a
  plausible wrong answer instead of an error.
- **Bulk writes** — the gap is the per-model result accounting across mixed
  insert, update and delete models. The ordered/unordered failure semantics
  themselves are implemented, for `insertMany` — see [A batch insert that partly
  fails](#a-batch-insert-that-partly-fails).
- **Change streams** — SurrealDB's live queries carry a different event shape and
  no resume token, so a `ChangeStream` built on them could not be resumed after a
  disconnect the way callers depend on. The client *is* an event emitter (see
  [Connection events](#connection-events)), so the remaining gap is the resume
  contract rather than somewhere to deliver events.
- **Atlas Search indexes** — an Atlas service, with no SurrealDB counterpart to
  define one against.
- **Renaming** — SurrealDB has no statement that renames a table, and copying
  every record under a new name is not something a rename should do behind the
  caller's back.

### Deliberate divergences

- **A cursor-returning method throws at the call.** MongoDB's `aggregate()`,
  `watch()` and `initialize*BulkOp()` hand back a cursor or a builder *without
  contacting the server*, so a caller who never iterates never sees a failure
  there. Here the call itself throws. Deferring the failure into iteration would
  move it away from the call that caused it — and for `watch()` it would have to
  arrive on the returned stream's `'error'` event, which a caller who never
  attaches a listener never sees at all.
- **A real MongoDB command this driver does not route still reports
  `no such command`.** `aggregate`, `collMod`, `count`, `distinct`,
  `findAndModify`, `getMore`, `killCursors` and `serverStatus` are all commands a
  real mongod has, so the message is not literally true of MongoDB. The
  alternative was a curated list of every genuine mongod command, answered with a
  driver-level refusal instead — a list that would be long, would go stale with
  each MongoDB release, and would introduce a second boundary for callers to
  learn. One rule that every command caller's error handling already covers is
  worth more than a more precise message behind a list that rots.
- **`serverInfo` is a method, not a command.** A real mongod answers
  `{serverInfo: 1}` with `no such command: 'serverInfo'`, and the official
  driver's `Admin.serverInfo()` sends `buildInfo`. Both halves are kept, so
  `admin().serverInfo()` works while `db.command({serverInfo: 1})` is refused —
  in both drivers alike.
- **An unrecognised field in a command document is ignored**, where mongod
  raises `40415` (`IDLUnknownField`) for it. This driver tolerates unknown
  *options* deliberately — wrapper layers attach bookkeeping of their own — and a
  command document is the same kind of object. The fields a routed command does
  understand are not ignored: they go to the method it delegates to, and its gate
  refuses the ones that cannot be honoured.
- **`dropIndexes` takes an index name or `"*"`, not a key pattern.** mongod
  accepts either; resolving a pattern to a name is a lookup `dropIndex(name)` does
  not offer, so the form is refused rather than guessed at.
- **`Collection.drop()` returns `false` for a collection that was not there**,
  where mongod returns `true`. It inherits `Db.dropCollection`, whose `false`
  means "no table was removed". `db.command({drop})` reports `ok: 1` either way,
  matching mongod.
- **A command naming a collection that does not exist answers rather than
  failing.** `dropIndexes` reports `nIndexesWas: 1` and `ok: 1` where mongod
  raises `26` (`NamespaceNotFound`), because it goes through `dropIndexes()`,
  which follows this driver's rule that a missing table reads as an empty one.
  `drop` echoes the `ns` it was given either way, where mongod omits `ns` for a
  namespace it did not find, and `collStats` reports `capped: false` alongside
  the zeros mongod answers with.

### `BulkWriteResult`

`BulkWriteResult` is exported and nothing produces one yet, because `bulkWrite` is
out of scope for 1.0.0. It is **kept** rather than removed: removing an export is
a breaking change, and it would have to be undone the day `bulkWrite` lands. What
was settled instead is its *shape*, against MongoDB's own class — the counts and
id maps it exposes, and no `acknowledged`, which a real `BulkWriteResult` has never
carried. Getting that wrong would mean changing the type on the day it becomes
producible, which is the breaking change worth avoiding. It is now the declared
return type of `Collection.bulkWrite()`, so it is reachable from a signature
rather than floating unreferenced.

The types that appear only in the signatures of unimplemented methods —
`AggregationCursor`, `ChangeStream`, `OrderedBulkOperation`,
`AnyBulkWriteOperation` and the rest — are deliberately **not** exported. A public
export is a name frozen at 1.0.0 that has to be kept afterwards, and a caller can
do nothing with an `AggregationCursor` this driver never returns. Each stub's
signature is nonetheless the final one — the same parameters and return type the
method will have once it is real, checked against `mongodb`'s own by the parity
probes in `tests/unit/types-parity.test.ts` — so filling one in is additive rather
than breaking.

## Mongoose

`mongoose.connect()` works against this driver, through mongoose's own
`setDriver()` extension point:

```typescript
import mongoose from "mongoose";
import { mqlDriver } from "@surrealdb/mql/mongoose";

mongoose.setDriver(mqlDriver(mongoose));
await mongoose.connect("mongodb://root:root@127.0.0.1:8000/app?namespace=app");

const Author = mongoose.model("Author", new mongoose.Schema({ name: String }));
await Author.create({ name: "Ursula" });
```

Models, queries, `populate()`, sessions and `connection.transaction()` — commit
and rollback — all work. `mongoose` is an **optional peer dependency** (`^9.0.0`)
and lives behind a separate entry point, so importing `@surrealdb/mql` never pulls
it in and the browser bundle is untouched.

`mqlDriver` takes your `mongoose` instance rather than resolving one, because the
base `Connection` and `Collection` it extends must be the ones belonging to the
instance whose `setDriver` you are about to call. It imports nothing from mongoose
itself, so there is no private path to break and nothing for a bundler to follow.

What does not work is what does not work anywhere else in this driver: mongoose
calls that need `aggregate()`, `bulkWrite()` or change streams reach the same
named errors as a direct call would — see [What is not
implemented](#what-is-not-implemented).

## Sessions and transactions

A session carries a real SurrealDB transaction. Operations given one run inside
it, see its uncommitted writes, and are committed or rolled back together.

```typescript
const session = client.startSession();

try {
  session.startTransaction();

  await accounts.updateOne({ _id: "a" }, { $inc: { balance: -100 } }, { session });
  await accounts.updateOne({ _id: "b" }, { $inc: { balance: 100 } }, { session });

  await session.commitTransaction();
} catch (error) {
  await session.abortTransaction();
  throw error;
} finally {
  await session.endSession();
}
```

`withTransaction` does the same thing and retries the callback when the failure
says it may be retried — which is what a write conflict says, and why it is the
recommended form:

```typescript
await session.withTransaction(async (s) => {
  const job = await jobs.findOneAndUpdate(
    { state: "pending" },
    { $set: { state: "claimed" } },
    { session: s, returnDocument: "after" },
  );
  if (job) await audit.insertOne({ job: job._id }, { session: s });
});
```

The callback may run more than once, so it must await everything it starts: an
error it swallows is an error `withTransaction` cannot see. `client.withSession`
and `await using session = client.startSession()` both end the session for you,
aborting an open transaction on the way out — a caller who ends a session without
committing has not committed.

Every method that issues a statement takes `session`, including the `Db` methods
and the index methods: SurrealDB's DDL is transactional, so a `createIndex` in a
transaction is rolled back with it.

A transaction may span **more than one database**, as MongoDB's may: one session
handed to operations on two databases commits or rolls back both together — see
[Addressing more than one database](#addressing-more-than-one-database).

### Session behaviour that differs from MongoDB

- **Sessions need a transactional transport.** `startSession()` throws over
  `http://` and `https://`, because SurrealDB's HTTP engine has no transactions
  and nothing done in such a session could be rolled back as a unit. Connect
  with `mongodb://`, `ws://` or `wss://`.
- **`startSession({snapshot: true})` throws `123`**, as it does off a replica
  set. A snapshot session pins one point in time for every read the session
  makes, transaction or not, and outside a transaction a statement is its own —
  so the pin has nothing to hold. `readConcern: 'snapshot'` *is* honoured, per
  operation or client-wide, where the scope of the promise is the operation or the
  caller's transaction.
- **A failed commit is not retried.** SurrealDB's transaction handle is consumed
  by the attempt, so a second `commitTransaction()` reports the original failure
  rather than pretending to try again. MongoDB's retry of the commit alone, on
  `UnknownTransactionCommitResult`, has nothing to retry against here — the label
  is still attached, so a caller can see that the outcome is genuinely unknown.
- **`maxCommitTimeMS` is honoured by racing the commit**, and losing that race is
  reported as `50` labelled `UnknownTransactionCommitResult`: the request is
  already with the server, so the commit may yet apply.
- **Nothing is retried inside a transaction.** Outside one, a write conflict is
  re-issued for you, because MongoDB resolves the same contention by serialising
  rather than by failing. Inside one, the conflict belongs to a transaction the
  server has already given up on, and only re-running the whole of it can clear
  it — which is what `withTransaction` does.
- **Concurrent operations on one session are serialised** rather than
  interleaved, so two overlapping writes apply in call order and a commit never
  lands between a statement and its reply. MongoDB forbids the overlap outright.
- **A failed operation does not abandon the transaction.** MongoDB's server
  aborts a transaction whose operation failed — every later statement and the
  commit itself then report `251` — while SurrealDB keeps it open, so a caller who
  catches the error can carry on and commit the rest. Letting the error out of a
  `withTransaction` callback aborts the transaction either way, which is why that
  is the form to write.
- **A full-text index needs its analyzer outside the transaction.** SurrealDB does
  not show a `DEFINE INDEX` an analyzer defined in the same transaction, so
  `createIndex({ field: "text" }, { session })` establishes the shared `blank`
  analyzer on the connection and keeps the index itself inside the transaction,
  where an abort still removes it. A `$text` search issued inside that same
  transaction cannot read the new analyzer; from the commit onwards it can.

## Compatibility and changes

[COMPATIBILITY.md](./COMPATIBILITY.md) states what this driver is compatible with —
the MongoDB driver v7 API, MongoDB 8.0 behaviour, SurrealDB 3.x, Node 20.19.0,
TypeScript 5.3 — and what a version bump means over a surface that is partly this
driver's own and partly MongoDB's. The short version of the part most likely to
matter: **correcting a wrong answer to match MongoDB is a minor release, not a
major one**, and every such correction is listed in
[CHANGELOG.md](./CHANGELOG.md) with the wrong behaviour spelled out.

## Contributing

See our [contributing guide](CONTRIBUTING.md) for more information.

## License

This project is licensed under the [Apache License 2.0](LICENSE).
