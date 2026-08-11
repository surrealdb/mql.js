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
mongodb://[user:pass@]host[:port]/database[?namespace=ns]
```

| Connection string | SurrealDB equivalent |
| --- | --- |
| `mongodb://root:root@localhost:8000/mydb` | `ws://localhost:8000/rpc` |
| `mongodb+srv://root:root@example.com/mydb` | `wss://example.com/rpc` |
| `ws://localhost:8000/mydb` | Passed through as-is |
| `http://localhost:8000/mydb` | Passed through as-is |

- **Protocol**: `mongodb://` maps to `ws://`, `mongodb+srv://` maps to `wss://`
- **Database**: Extracted from the URL path
- **Namespace**: Set via the `?namespace=` query parameter (defaults to `"default"`)
- **Credentials**: Extracted from the userinfo section of the URL

You can also pass options directly:

```typescript
const client = new MongoClient("mongodb://localhost:8000/mydb", {
  namespace: "production",
  database: "override_db", // overrides the database in the URL
});
```

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

// Create a collection explicitly
const logs = await db.createCollection("logs");

// Drop a collection
await db.dropCollection("logs");

// Drop the entire database
await db.dropDatabase();
```

## Contributing

See our [contributing guide](CONTRIBUTING.md) for more information.

## License

This project is licensed under the [Apache License 2.0](LICENSE).
