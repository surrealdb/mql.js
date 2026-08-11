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
- **Geospatial queries** - $geoWithin, $geoIntersects, $near, $nearSphere with full GeoJSON support
- **Full-text search** - $text queries with createIndex for text indexes
- **Positional array updates** - $[] and $[identifier] with arrayFilters
- **Cursor chaining** - sort, limit, skip, project, plus `for await...of` async iteration
- **ObjectId support** - MongoDB-compatible ObjectId generation and parsing
- **TypeScript generics** - Typed collections with full type inference
- **MongoDB connection strings** - Use `mongodb://` connection strings that map to SurrealDB

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
| `writeConcern`, `w`, `journal`, `wtimeoutMS` | accepted, no effect | writes always wait for SurrealDB to acknowledge |
| `retryWrites`, `retryReads`, `maxAdaptiveRetries`, `enableOverloadRetargeting` | accepted, no effect | nothing is retried, so `false` is exact and `true` is a no-op |
| `compressors`, `zlibCompressionLevel`, `noDelay` | accepted, no effect | transport tuning, invisible in results |
| `appName`, `driverInfo`, `mongodbLog*` | accepted, no effect | no client-metadata channel and no logger |
| `serverApi` | accepted, no effect | there is no MongoDB command surface to version |
| `authMechanism` of `DEFAULT`, `SCRAM-SHA-*`, `PLAIN`, and `authMechanismProperties` | accepted, no effect | all describe a username/password exchange SurrealDB settles its own way |
| `readConcern`/`readConcernLevel` of `linearizable` or `snapshot` | throws `123` | needs a replica set, as it does in MongoDB |
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

// Upsert (insert if no match)
await users.updateOne(
  { name: "Dave" },
  { $set: { age: 28 } },
  { upsert: true },
);
```

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
| `sort` | honoured | orders the id lookup, which is what decides *which* document a `findOneAnd*`/`replaceOne` modifies |
| `projection` | honoured | a field list in the `SELECT` for `find`/`findOne`, applied to the returned document for the `findOneAnd*` methods |
| `upsert`, `returnDocument`, `includeResultMetadata`, `arrayFilters` | honoured | the created document is seeded from the filter's equalities, as MongoDB seeds it |
| `ignoreUndefined` | honoured | decides whether an `undefined` property is dropped or stored as `null`; overrides the client's setting, including with an explicit `false` |
| `comment` | accepted, no effect | SurrealDB has no query-level comment mechanism, and a comment cannot change the answer |
| `readPreference`, `readConcern` of `local`/`majority`/`available` | accepted, no effect | reading the only node is at least what they ask for |
| `writeConcern`, other than `w: 0` and `w > 1` | accepted, no effect | every write waits for SurrealDB to acknowledge |
| `batchSize`, `maxAwaitTimeMS`, `noCursorTimeout`, `allowDiskUse`, `allowPartialResults`, `oplogReplay`, `ordered: true` | accepted, no effect | server-cursor and sharding mechanics; results are materialised in one round trip |
| `session` | throws `MongoTransactionError` | there are no sessions or transactions yet, so the operation would run outside the session while the caller believed it could be rolled back |
| `readConcern` of `linearizable` or `snapshot` | throws `123` | needs a replica set, as it does in MongoDB |
| `writeConcern: {w: 0}` | throws | asks for an unacknowledged write |
| `writeConcern: {w: >1}` | throws `2` | `cannot use 'w' > 1 when a host is not replicated` |
| `collation` | throws | SurrealDB compares strings by code point, so a locale-aware comparison would match and order differently |
| `let` | throws | `$$var` references need an expression compiler this driver does not have |
| `explain` | throws | SurrealDB's `EXPLAIN` describes a different planner |
| `bypassDocumentValidation: true` | throws | `ASSERT`s are enforced inside the storage engine |
| `ordered: false` | throws | a SurrealDB batch insert is atomic, so the documents it promises to keep would not be written |
| `forceServerObjectId: true` | throws | the reported `insertedId` would have nothing truthful to say |
| `min`, `max` | throws | no index-bound clause, so the scan would not be restricted (in `createIndex` these are a `2d` index's coordinate limits, and are accepted there) |
| `returnKey`, `showRecordId`, `singleBatch`, `tailable`, `awaitData` | throws | no index-key projection, no storage-level record id and no capped collections |
| `out`, `dbName` | throws | the results would not be written where the caller asked, or read from the database they named |
| `raw`, `promote*`, `useBigInt64`, `bsonRegExp`, `serializeFunctions`, `checkKeys`, `fieldsAsRaw`, `enableUtf8Validation` | throws | this driver encodes CBOR and has no BSON layer |

An option this driver does not recognise **at all** is tolerated, deliberately:
real MongoDB drivers ignore unknown keys, and wrapper layers such as mongoose
compute their options objects and attach bookkeeping of their own.

### A collection that has never been written to

SurrealDB refuses to read a table it holds no definition for, where MongoDB
treats a missing collection as an empty one. The single-document write paths —
`updateOne`, `deleteOne`, `replaceOne` and the `findOneAnd*` methods — read that
refusal as "no match", so `upsert: true` creates the first document of a
collection and a `deleteOne` reports `deletedCount: 0`. The read paths
(`find`, `findOne`, `countDocuments`, `estimatedDocumentCount`, `distinct`) and
the multi-document writes (`updateMany`, `deleteMany`) still raise `26`
(`NamespaceNotFound`) where MongoDB would return nothing.

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

The driver supports MongoDB's geospatial query operators, mapped to SurrealDB's native geo functions and operators.

```typescript
// Documents within a polygon
{ location: { $geoWithin: { $geometry: {
  type: "Polygon",
  coordinates: [[[-74, 40.7], [-73.9, 40.7], [-73.9, 40.8], [-74, 40.8], [-74, 40.7]]]
} } } }

// Documents within a spherical radius (radians)
{ location: { $geoWithin: { $centerSphere: [[-73.93, 40.82], 5 / 3963.2] } } }

// Documents within a bounding box
{ location: { $geoWithin: { $box: [[-74.0, 40.7], [-73.9, 40.8]] } } }

// Documents intersecting a geometry
{ area: { $geoIntersects: { $geometry: {
  type: "Polygon",
  coordinates: [[[0, 0], [3, 6], [6, 1], [0, 0]]]
} } } }

// Nearest documents (sorted by distance)
{ location: { $near: {
  $geometry: { type: "Point", coordinates: [-73.9667, 40.78] },
  $maxDistance: 5000,  // metres
  $minDistance: 100,   // metres (optional)
} } }

// Nearest with spherical geometry (same as $near for SurrealDB)
{ location: { $nearSphere: {
  $geometry: { type: "Point", coordinates: [-73.9667, 40.78] },
  $maxDistance: 5000,
} } }
```

`$geoWithin` supports `$geometry`, `$centerSphere`, `$center`, `$box`, and `$polygon` shape specifiers. `$near` and `$nearSphere` automatically sort results by distance ascending.

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
| `2d`, `2dsphere`, `geoHaystack`, `hashed` keys | throws | no equivalent index type; a plain index would not make `$near` index-backed |
| `background`, `storageEngine`, `commitQuorum`, version fields | accepted, no effect | no meaning here, and MongoDB itself ignores several of them |

Other differences worth knowing:

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
  and inventing them would be worse than omitting them.

## Database operations

```typescript
const db = client.db("mydb");

// List all collections
const collections = await db.listCollections();
// [{ name: "users", type: "collection" }, ...]

// Filter by the fields a collection reply carries
await db.listCollections({ name: "users" });
await db.listCollections({ name: { $in: ["users", "logs"] } });

// Create a collection explicitly
const logs = await db.createCollection("logs");

// Drop a collection
await db.dropCollection("logs");

// Drop the entire database
await db.dropDatabase();
```

Every `Db` method runs its options through the same gate as the collection
operations, so an unsupported option is refused here too rather than dropped a
layer above the code that would have applied it — `session` most importantly.

`listCollections` filters the *reply*, so its predicate applies to the
`{name, type}` documents rather than to stored rows. `name` and `type` are
matched with `$eq`, `$ne`, `$in`, `$nin` and `$regex`; a filter naming any other
field is rejected, because a predicate over data the reply does not carry would
otherwise silently match everything.

`createCollection` rejects the collection-shaping options `DEFINE TABLE` has no
counterpart for — `capped`, `size`, `max`, `validator`, `validationLevel`,
`validationAction`, `timeseries`, `expireAfterSeconds`, `viewOn`, `pipeline` and
`clusteredIndex`. Handing back an ordinary table for a request that asked for a
capped one, a view, or a time-series collection would misrepresent the storage
being written to, rather than merely omitting a refinement.

## Contributing

See our [contributing guide](CONTRIBUTING.md) for more information.

## License

This project is licensed under the [Apache License 2.0](LICENSE).
