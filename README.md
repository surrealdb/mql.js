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
- **Query filter operators** - $eq, $gt, $lt, $in, $and, $or, $regex, $elemMatch, and more
- **Update operators** - $set, $inc, $push, $pull, $addToSet, $min, $max, $rename, and more
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
{ name: { $regex: "^Al" } }  // regex match
{ name: /^Al/i }              // native RegExp
```

### Array

```typescript
{ tags: { $all: ["a", "b"] } }     // contains all elements
{ tags: { $size: 3 } }              // array has exactly 3 elements
{ results: { $elemMatch: { score: { $gt: 80 }, grade: "A" } } } // element matches
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
