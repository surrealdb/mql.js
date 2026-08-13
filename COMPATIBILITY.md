# Compatibility policy

`@surrealdb/mql` presents MongoDB's API over SurrealDB. That puts it between two things it does not control — the MongoDB driver API it imitates, and the SurrealDB server it runs against — so "what counts as a breaking change" needs saying out loud rather than being inferred from the version number.

## What this driver is compatible with

**The MongoDB Node.js driver, v7.x.** The exported constant `MONGODB_COMPATIBILITY_VERSION` (`8.0.0`) is the MongoDB *server* version whose behaviour the results and error codes are matched against; the *API* shape is the v7 driver's. Where the two disagree, the driver's typings win, because that is what a caller's editor and `tsc` see.

Behaviour is checked against a real `mongod` rather than against a reading of the documentation: `tests/e2e` runs the same scenarios through this driver and through the official one and compares the answers. Where the answers differ on purpose, the difference is in the README's divergence tables.

**SurrealDB 3.0.0 or newer.** Every supported minor is tested in CI against its latest patch release, plus `nightly` as an early-warning signal. SurrealDB 2.x is not supported and is refused at `connect()` rather than being sent SurrealQL it cannot parse.

**Node 20.19.0 or newer**, matching the MongoDB driver's own floor. CI packs the tarball and consumes it from Node 20.19.0, the current LTS and current, in both an ESM and a CommonJS project.

**TypeScript 5.3 or newer**, if you use the types. See the README's Requirements section for why.

## What a version bump means

Semantic versioning, over the surface below.

### Breaking (major)

- Removing or renaming an export, or narrowing a parameter or return type.
- Changing the **answer** to a query or write that previously succeeded: different documents, a different count, a different result object.
- Turning something that worked into an error, including raising the SurrealDB, Node or TypeScript floor.
- Changing an error's **class** or numeric `code` for a failure that keeps happening for the same reason.
- Changing a documented divergence in a way a caller could have written code against.

### Not breaking (minor or patch)

- **Implementing something that used to raise a named error.** Every unimplemented method already exists and refuses; making one work cannot break code that could not have called it successfully.
- **Correcting a wrong answer to match MongoDB.** This is the one that deserves scrutiny, and the policy is deliberate: a driver whose whole purpose is to answer as MongoDB does is not preserving a contract by continuing to answer wrongly. Such a fix goes in a minor release, is listed in the changelog under **Fixed** with the wrong behaviour spelled out, and says so in the release notes. If you were relying on the wrong answer, the changelog entry is where you will find out.
- Adding an event, an option, an export, or a supported SurrealDB version.
- Error **message** text. Match on class and `code`, never on wording.

### Not covered by the version at all

- Anything named `_internal`, prefixed `_`, or marked `@internal`. `client._surreal` and `client._executor` are reachable and are not API.
- The exact SurrealQL emitted. It is an implementation detail, and identifier quoting, statement shape and clause order have all changed within a patch release.
- Timing and round-trip counts, except where the README states a guarantee (the single-statement atomicity of the single-document writes is one).

## Pre-1.0.0

While the major version is `0`, the minor acts as the major: `0.2.0` may break what `0.1.0` did, and it will say so. The releases up to `1.0.0` exist to exercise the publish path and to shake out packaging under real consumption — the parts no amount of testing in this repository can prove.

## Reporting an incompatibility

A difference from MongoDB that is not in the README's divergence tables is a bug. The most useful report is the one that says what the official driver answers and what this one answers, for the same operation on the same data — that is the form the fix gets tested in.

Where the cause is SurrealDB's rather than this driver's, the issue is filed upstream and referenced from the code and the README, so a reader can see whose constraint they are looking at and when it might lift.
