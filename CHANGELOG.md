# Changelog

All notable changes to `@surrealdb/mql` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioning follows the policy in [COMPATIBILITY.md](./COMPATIBILITY.md) — which is [Semantic Versioning](https://semver.org/spec/v2.0.0.html) over a surface that is partly this driver's own and partly MongoDB's.

## [Unreleased]

### Added

- **`$addFields` and `$set`, `$replaceRoot` and `$replaceWith`, `$sortByCount`.** `$addFields` is `SELECT *, <expr> AS name`, which carries MongoDB's rule that a field already present is replaced rather than duplicated — measured, since nothing in SurrealQL's grammar promises which of two same-named entries wins. `$replaceRoot` is `SELECT VALUE <expr>`. `$sortByCount` is applied as the `$group` and `$sort` MongoDB defines it to be, so everything true of that pair — that the sort folds into the grouping statement — stays true here without being restated.

  Like `$lookup`, `$addFields` leaves `_id` meaning the record identity for the stages after it: it keeps every column the rows already had rather than replacing the shape.

- **`$lookup`.** The `localField`/`foreignField` form, including `foreignField: "_id"`, with MongoDB's left-outer semantics: an array per row, empty where nothing matched, and a match on any element when the local field is an array.

  It is not translated as the obvious correlated subquery, which is semantically exact but loses the index — measured with `EXPLAIN`, `WHERE cid = $parent.customer` plans as a `TableScan` where `WHERE cid = 'c1'` plans as an `IndexScan`, so that shape scans the whole foreign collection once per outer row. Instead the outer rows are bound to a variable, their distinct keys collected, and the foreign rows fetched by a single uncorrelated query that keeps the index; the join is then an in-memory filter. The cost is the number of distinct keys rather than the number of rows. What it costs instead is memory, since the matching foreign documents are held server-side for the length of the statement — documented rather than discovered.

  The `pipeline`/`let` form is refused: it runs a sub-pipeline per joined document, which this plan cannot express. A foreign collection that does not exist joins as empty, as MongoDB answers a collection it has never seen.

## [0.3.0] — 2026-08-14

Aggregation. `collection.aggregate(pipeline)` works, which was the largest thing this driver did not do.

It is also the first release to change an answer this driver had already given. `{$divide: [7, 2]}` returned `3`; it now returns `3.5`, which is what MongoDB returns. Under the policy in [COMPATIBILITY.md](./COMPATIBILITY.md) that is a minor release rather than a major one, and this is the first time that rule has been exercised on something real — so if you wrote code against the old answer, this paragraph is the notice, and the entry under **Fixed** is the detail.

The bug is worth a word on its own, because of how it was found. It was not found by review, or by the unit tests, or by the integration tests, all of which agreed with `3`. It was found by running the same expectations through the official MongoDB driver against a real `mongod` and comparing — on the parity suite's first run, minutes after aggregation was written. A wrong number is not an error; nothing else was ever going to notice.

### Added

- **Aggregation pipelines.** `collection.aggregate(pipeline)` returns an `AggregationCursor` synchronously, as MongoDB does, and serves `$match`, `$group`, `$project`, `$sort`, `$skip`, `$limit`, `$count` and `$unwind`, with about forty expression operators available inside `$project` and inside accumulators. A pipeline compiles to as few `SELECT`s as its stages allow: SurrealQL is one statement with clause slots in a fixed evaluation order rather than a sequence of steps, so consecutive stages fold into one statement while each lands in a slot it has not passed, and a subquery opens when one does not — which is how `$match` after `$group` becomes a `HAVING`. Every stage and every expression operator that is not implemented raises `MongoCompatibilityError` naming it, because a pipeline whose later stages were dropped would still return documents. `Db.aggregate()` still refuses: a database-level pipeline reads from a source stage such as `$documents`, and none of those has a SurrealDB counterpart. See the README's Aggregation section for the boundary in full.

  The parity suite also runs under Node now, not only Bun — the mql leg of it, on every pull request, against two SurrealDB versions. That is the strongest check in the repository: it asserts MongoDB's answers rather than this driver's, on undici's WebSocket, which is the transport the published package actually uses. Only the mql leg, because the MongoDB leg runs the official driver and would be re-testing a Node library.

  Aggregation now runs in the e2e parity suite, so every expectation is asserted of the official driver against a real `mongod` as well as of this one — an assumption about MongoDB that is wrong fails on the MongoDB leg rather than becoming this driver's behaviour. One divergence is documented rather than fixed: `$divide` by zero answers `null` where MongoDB raises, because SurrealDB's `/` evaluates to `NONE` and the divisor is normally a field rather than a literal.

  Two places where SurrealDB's nearest equivalent is not MongoDB's answer, both measured rather than assumed. `SPLIT` emits a row for an empty array and for a missing field where `$unwind` emits neither, so `$unwind` filters those out first. And `SELECT NULL AS _id … GROUP ALL` returns `_id` as one null per row rather than a single collapsed group, so `$group` always groups by the `_id` alias instead — one idiom that covers a scalar key, a compound key and `null` alike.

### Fixed

- **`$divide` did integer division.** `{$divide: [7, 2]}` answered `3` where MongoDB answers `3.5`, because SurrealQL's `/` on two integers is integer division while MongoDB's `$divide` always produces a double. Found by the new e2e parity scenarios on their first run against a real `mongod`, which is the point of them: `3` is a number rather than an error, so nothing short of comparing the two drivers would have noticed.
- **`watch()`'s refusal gave a reason that stopped being true.** It told callers a change stream was not possible partly because "this driver has no event emitter to deliver one on", which `MongoClient` becoming an emitter in 0.1.0 had already made false — `MqlEventEmitter` is exported, and a `ChangeStream` would have an emitter to be built on. The obstacle is the resume contract and only that: SurrealDB's live queries carry no resume token, so the stream could not be resumed after a disconnect. The message now says that and nothing more.

## [0.2.0] — 2026-08-13

Mongoose works. That is the whole of this release: `mongoose.connect()` against this driver, and the one breaking change that was standing in its way.

It is also the first release published by CI rather than by hand, which is what `npm audit signatures` needs to have something to check — 0.2.0 carries a provenance attestation tying the tarball to the commit and the workflow that built it, and 0.1.0 does not.

And it is the first release whose test suite has run under Node. `surrealdb` resolves `globalThis.WebSocket`, so under Bun the transport is Bun's class and under Node it is undici's; the transport the published package actually uses had never been exercised. It is now, on every pull request, against two SurrealDB versions. Nothing in `src/` needed changing to make that pass — what it found was two bugs in the tests, both of which had been passing under Bun for reasons that were not the ones intended.

### Added

- **`mongoose.connect()` works**, through mongoose's own `setDriver()` extension point: `mongoose.setDriver(mqlDriver(mongoose))`. Models, queries, `populate()`, sessions and `connection.transaction()` — commit and rollback — all work. `mongoose` is an optional peer dependency behind a separate entry point, `@surrealdb/mql/mongoose`, so importing the driver never pulls it in.

### Changed

- **`Db.listCollections()` returns a cursor**, synchronously, as MongoDB does — not `Promise<CollectionInfo[]>`. A caller who wrote `await db.listCollections()` adds `.toArray()`. This is why mongoose could not consume the driver: it calls `db.listCollections()` and then reads `.toArray` off the result.

  This is a breaking change in a minor release, which is what the `0.x` policy in force at the time allowed: while the major was `0`, the minor acted as the major.

### Fixed

- **The claim that `mongoose.connect()` could not work was wrong**, and it was in the 0.1.0 README and release notes. The `instanceof mongodb.MongoClient` gate that claim rested on is on `setClient()`, which `connect()` never calls — `connect()` goes through `createClient()`, which a custom driver may override.
- **Seven tests asserted a rejection in a way that could not fail.** A closed cursor's async methods were checked with `expect(() => cursor.toArray()).toThrow()`, which passes under Bun only because its `expect` unwraps a returned rejected promise. The behaviour they meant to pin — that `await cursor.toArray()` rejects — was never asserted. The driver was already correct; the tests now say so under both runtimes.
- **Two integration test files bound the same port**, which `bun test` hides by running files one at a time and `node --test` exposes by running them in parallel: the second server cannot bind, exits, and the health check passes against the first file's server — so the file fails partway through, once the other file tears that server down. It presented as an unrelated flake. The port is now unique, `waitForSurreal` watches its own process rather than only the port, and a unit test fails on a duplicate whether or not the race does.
- **The e2e suite drew its host port from inside the ephemeral range.** 30000–39999 overlaps Linux's default `net.ipv4.ip_local_port_range` (32768–60999), so the kernel could hand the same port to any outbound connection the runner made — and during an image pull it did, failing `docker run` with "address already in use" on a port nothing in the suite had asked for. Ports are now drawn from below that range and bound to confirm they are free, `docker run` retries if it loses the race anyway, and the binary provider fails immediately when its own process is gone instead of polling a port it does not own.

## [0.1.0] — 2026-08-13

The first release, published to npm from a maintainer's terminal: a trusted publisher cannot be configured for a package that does not exist yet, so the first one cannot come from CI. Later releases publish from GitHub Actions over OIDC, which is also what gives them provenance attestations — 0.1.0 has none.

Nothing has been published before it, so there is nothing to be compatible with and no migration to describe: the entries below are what the driver does, not what changed for anyone.

They are worth reading anyway. Most of this work was correcting behaviour that looked right and was not — a driver that answered a query with plausible wrong documents rather than an error — and each entry says what the wrong answer was, because that is what a reader needs to recognise it in their own logs.

### Added

- **CRUD**, in MongoDB's shapes and with MongoDB's result objects: `insertOne`, `insertMany`, `find`/`findOne` with cursors, `updateOne`/`updateMany`, `replaceOne`, `deleteOne`/`deleteMany`, the three `findOneAnd*`, `countDocuments`, `estimatedDocumentCount` and `distinct`.
- **Filter operators**: comparison, membership, logical, element, evaluation (`$regex`, `$text`), array (`$all`, `$elemMatch`, `$size`) and geospatial.
- **Update operators**: field, array, and the positional forms `$[]` and `$[identifier]` with `arrayFilters`.
- **Sessions and transactions**, including `withTransaction` with retry on a transient conflict, `await using` support, and transactions that span more than one database as MongoDB's do.
- **Indexes**: `createIndex(es)`, `dropIndex(es)`, `listIndexes` as a cursor, `indexes`, `indexExists`, `indexInformation`, unique and full-text indexes, and `createIndex` idempotency matching MongoDB's contract.
- **Geospatial queries**: `$geoWithin`, `$geoIntersects`, `$near` and `$nearSphere`, with GeoJSON stored as SurrealDB's own geometry type.
- **BSON identities that round-trip**: `ObjectId` and `Date` come back as themselves, nested and inside arrays, and ids from `bson` or mongoose interoperate with this driver's own.
- **Database and admin operations**: `listCollections`, `createCollection`, `dropCollection`, `dropDatabase`, `db.command()` for the commands that have a SurrealDB counterpart, `db.admin()`, and per-database handles from `client.db(name)`.
- **Connection events**: `MongoClient` is an event emitter, with `open`, `close` and `error`.
- **A documented boundary.** Every method this driver does not implement exists, has the real signature, and raises a named error saying what to use instead — rather than being absent, which tells a caller nothing and an ORM probing for a capability even less.

### Fixed

Each of these was live at some point during 0.1.0's development. They are listed because the wrong behaviour is more informative than the right one.

- **`_id` was not queryable.** `findOne({_id})` returned `null`, `updateOne({_id})` reported `matchedCount: 0` and `deleteOne({_id})` reported `deletedCount: 0`, all without an error, while reads handed back an `_id` that could not be used to find the document again.
- **Identifiers were interpolated into SurrealQL unescaped.** Values were bound, names were not: `{'first name': 'x'}` was a parse error, `{'a-b': 1}` was silently read as subtraction, and a crafted filter key was evaluated as a predicate — `{'x` = 1 OR true OR `': 1}` matched every row, which is an injection vector wherever filter keys come from request input. Every identifier is now quoted, which also fixed collections, fields, indexes and databases named after any of the 33 SurrealQL keywords that fail bare.
- **`updateOne` with `upsert` was unbounded**, modifying every match and fabricating an `upsertedId`.
- **An index on a field named after a SurrealQL keyword left the collection unreadable and the database undroppable.** SurrealDB stores the definition and then cannot re-parse it (`surrealdb/surrealdb-private#906`); `createIndex` now refuses those names and reads every definition it does send back inside the transaction that wrote it.
- **`client.db("other")` reported the new name and read the connected database** — silent cross-database access.
- **`insertMany` was all-or-nothing.** A mid-batch failure rolled back the documents that had succeeded, where MongoDB keeps them, and the error carried neither `writeErrors` nor `insertedCount`.
- **`unique: true` was accepted and enforced nothing**, and `createIndex` was not idempotent.
- **Declared options were silently ignored** — `sort` and `projection` on the `findOneAnd*` methods (leaking fields a caller had excluded), `skip` and `limit` on `countDocuments`.
- **A duplicate `_id` was reported as error code 48** rather than 11000, so `err.code === 11000` could never be true.
- **`session` was accepted and discarded**, so nothing ran in the caller's transaction.
- **Geospatial queries did not work at all.**
- **A sort a projection did not cover named this driver's SurrealQL escaping back to the caller** as if it were their own field name, and a field name containing a comma was refused a read MongoDB answers.
- **The package shipped ESM type declarations for its CommonJS entry point**, and declarations that did not compile in a stock TypeScript project.

### Known limitations

The README documents these in full; they are named here so a reader of the changelog alone is not surprised.

- No aggregation pipeline, `bulkWrite`, change streams, Atlas Search indexes or collection renaming. Each raises a named error.
- A sort an inclusion projection does not cover is refused rather than served, pending `surrealdb/surrealdb-private#900`.
- Below SurrealDB 3.3.0 on the in-memory storage engine, two concurrent writes to one document can both report success with one write dropped. It is a storage-engine bug, not a driver one; prefer a persistent engine for concurrent writes to a hot document.

[Unreleased]: https://github.com/surrealdb/mql.js/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/surrealdb/mql.js/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/surrealdb/mql.js/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/surrealdb/mql.js/releases/tag/v0.1.0
