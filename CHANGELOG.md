# Changelog

All notable changes to `@surrealdb/mql` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioning follows
the policy in [COMPATIBILITY.md](./COMPATIBILITY.md) — which is [Semantic
Versioning](https://semver.org/spec/v2.0.0.html) over a surface that is partly
this driver's own and partly MongoDB's.

## [Unreleased]

Nothing yet.

## [0.1.0] — unreleased

The first release. Nothing has been published before it, so there is nothing to
be compatible with and no migration to describe: the entries below are what the
driver does, not what changed for anyone.

They are worth reading anyway. Most of this work was correcting behaviour that
looked right and was not — a driver that answered a query with plausible wrong
documents rather than an error — and each entry says what the wrong answer was,
because that is what a reader needs to recognise it in their own logs.

### Added

- **CRUD**, in MongoDB's shapes and with MongoDB's result objects: `insertOne`,
  `insertMany`, `find`/`findOne` with cursors, `updateOne`/`updateMany`,
  `replaceOne`, `deleteOne`/`deleteMany`, the three `findOneAnd*`,
  `countDocuments`, `estimatedDocumentCount` and `distinct`.
- **Filter operators**: comparison, membership, logical, element, evaluation
  (`$regex`, `$text`), array (`$all`, `$elemMatch`, `$size`) and geospatial.
- **Update operators**: field, array, and the positional forms `$[]` and
  `$[identifier]` with `arrayFilters`.
- **Sessions and transactions**, including `withTransaction` with retry on a
  transient conflict, `await using` support, and transactions that span more than
  one database as MongoDB's do.
- **Indexes**: `createIndex(es)`, `dropIndex(es)`, `listIndexes` as a cursor,
  `indexes`, `indexExists`, `indexInformation`, unique and full-text indexes, and
  `createIndex` idempotency matching MongoDB's contract.
- **Geospatial queries**: `$geoWithin`, `$geoIntersects`, `$near` and
  `$nearSphere`, with GeoJSON stored as SurrealDB's own geometry type.
- **BSON identities that round-trip**: `ObjectId` and `Date` come back as
  themselves, nested and inside arrays, and ids from `bson` or mongoose
  interoperate with this driver's own.
- **Database and admin operations**: `listCollections`, `createCollection`,
  `dropCollection`, `dropDatabase`, `db.command()` for the commands that have a
  SurrealDB counterpart, `db.admin()`, and per-database handles from
  `client.db(name)`.
- **Connection events**: `MongoClient` is an event emitter, with `open`, `close`
  and `error`.
- **A documented boundary.** Every method this driver does not implement exists,
  has the real signature, and raises a named error saying what to use instead —
  rather than being absent, which tells a caller nothing and an ORM probing for a
  capability even less.

### Fixed

Each of these was live at some point during 0.1.0's development. They are listed
because the wrong behaviour is more informative than the right one.

- **`_id` was not queryable.** `findOne({_id})` returned `null`,
  `updateOne({_id})` reported `matchedCount: 0` and `deleteOne({_id})` reported
  `deletedCount: 0`, all without an error, while reads handed back an `_id` that
  could not be used to find the document again.
- **Identifiers were interpolated into SurrealQL unescaped.** Values were bound,
  names were not: `{'first name': 'x'}` was a parse error, `{'a-b': 1}` was
  silently read as subtraction, and a crafted filter key was evaluated as a
  predicate — `{'x` = 1 OR true OR `': 1}` matched every row, which is an
  injection vector wherever filter keys come from request input. Every identifier
  is now quoted, which also fixed collections, fields, indexes and databases named
  after any of the 33 SurrealQL keywords that fail bare.
- **`updateOne` with `upsert` was unbounded**, modifying every match and
  fabricating an `upsertedId`.
- **An index on a field named after a SurrealQL keyword left the collection
  unreadable and the database undroppable.** SurrealDB stores the definition and
  then cannot re-parse it (`surrealdb/surrealdb-private#906`); `createIndex` now
  refuses those names and reads every definition it does send back inside the
  transaction that wrote it.
- **`client.db("other")` reported the new name and read the connected database** —
  silent cross-database access.
- **`insertMany` was all-or-nothing.** A mid-batch failure rolled back the
  documents that had succeeded, where MongoDB keeps them, and the error carried
  neither `writeErrors` nor `insertedCount`.
- **`unique: true` was accepted and enforced nothing**, and `createIndex` was not
  idempotent.
- **Declared options were silently ignored** — `sort` and `projection` on the
  `findOneAnd*` methods (leaking fields a caller had excluded), `skip` and `limit`
  on `countDocuments`.
- **A duplicate `_id` was reported as error code 48** rather than 11000, so
  `err.code === 11000` could never be true.
- **`session` was accepted and discarded**, so nothing ran in the caller's
  transaction.
- **Geospatial queries did not work at all.**
- **A sort a projection did not cover named this driver's SurrealQL escaping back
  to the caller** as if it were their own field name, and a field name containing
  a comma was refused a read MongoDB answers.
- **The package shipped ESM type declarations for its CommonJS entry point**, and
  declarations that did not compile in a stock TypeScript project.

### Known limitations

The README documents these in full; they are named here so a reader of the
changelog alone is not surprised.

- No aggregation pipeline, `bulkWrite`, change streams, Atlas Search indexes or
  collection renaming. Each raises a named error.
- A sort an inclusion projection does not cover is refused rather than served,
  pending `surrealdb/surrealdb-private#900`.
- Below SurrealDB 3.3.0 on the in-memory storage engine, two concurrent writes to
  one document can both report success with one write dropped. It is a
  storage-engine bug, not a driver one; prefer a persistent engine for concurrent
  writes to a hot document.

[Unreleased]: https://github.com/surrealdb/mql.js/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/surrealdb/mql.js/releases/tag/v0.1.0
