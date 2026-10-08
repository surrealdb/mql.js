import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	type Collection,
	MongoCompatibilityError,
	ObjectId,
} from "../../src/index.ts";
import {
	type SurrealTestContext,
	setupSurreal,
	teardownSurreal,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// Test document shape
// ---------------------------------------------------------------------------

interface TestDoc {
	[key: string]: unknown;
	_id?: ObjectId | string | number;
	name: string;
	age?: number;
	score?: number;
	value?: number;
	tags?: string[];
	scores?: number[];
	email?: string;
	nickname?: string;
	updatedAt?: string;
	grades?: { grade: string; score: number }[];
}

let ctx: SurrealTestContext<TestDoc>;
let col: Collection<TestDoc>;
const PORT = 18737;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
	ctx = await setupSurreal<TestDoc>(PORT);
});

afterAll(async () => {
	await teardownSurreal(ctx);
});

beforeEach(async () => {
	col = ctx.collection("update_ops");
	try {
		await col.deleteMany({});
	} catch {
		// ignore
	}
});

// ---------------------------------------------------------------------------
// POSITIONAL UPDATES: $[] AND $[identifier]
// ---------------------------------------------------------------------------

describe("positional updates compute each element's new value from its own", () => {
	// An update through `v.$[].n` is a rewrite of `v` one element at a time (see
	// `src/translators/update/positional.ts`). Through the path expression it was
	// written as, `v[*].n` evaluates to the *list* of every element's `n`, so `$inc`
	// appended to that list and wrote it into every element: `[{n: 0}, {n: 5}]`
	// became `[{n: [0, 5, 1]}, {n: [0, 5, 1]}]`, and `$mul` failed outright. What a
	// real `mongod` leaves in `v` is what each case below expects, and
	// `tests/e2e/scenarios/crud-scenarios.ts` checks them against one.

	interface ArrayDoc {
		[key: string]: unknown;
		_id?: ObjectId | string | number;
		k: string;
		v?: unknown;
	}

	let docs: Collection<ArrayDoc>;

	beforeEach(async () => {
		docs = ctx.db.collection<ArrayDoc>("positional_updates");
		try {
			await docs.deleteMany({});
		} catch {
			// ignore
		}
	});

	const run = async (
		doc: Record<string, unknown>,
		update: Record<string, unknown>,
		options?: Record<string, unknown> | null,
	) => {
		await docs.deleteMany({});
		await docs.insertOne({ k: "a", ...doc });
		const result = await docs.updateOne(
			{ k: "a" },
			update as never,
			(options ?? undefined) as never,
		);
		return { result, doc: await docs.findOne({ k: "a" }) };
	};

	describe("an operator that reads what it writes", () => {
		const CASES: [
			string,
			Record<string, unknown>,
			Record<string, unknown>,
			Record<string, unknown> | null,
			unknown,
		][] = [
			[
				"$[] $inc n",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $inc: { "v.$[].n": 1 } },
				null,
				[
					{ n: 1, s: 1, t: ["a"], u: 3 },
					{ n: 6, s: 2, t: ["b", "c"], u: 4 },
					{ n: 1, s: 3 },
				],
			],
			[
				"$[] $inc new field",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $inc: { "v.$[].z": 2 } },
				null,
				[
					{ n: 0, s: 1, t: ["a"], u: 3, z: 2 },
					{ n: 5, s: 2, t: ["b", "c"], u: 4, z: 2 },
					{ s: 3, z: 2 },
				],
			],
			[
				"$[] $mul n",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $mul: { "v.$[].u": 2 } },
				null,
				[
					{ n: 0, s: 1, t: ["a"], u: 6 },
					{ n: 5, s: 2, t: ["b", "c"], u: 8 },
					{ s: 3, u: 0 },
				],
			],
			[
				"$[] $mul missing",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $mul: { "v.$[].z": 2 } },
				null,
				[
					{ n: 0, s: 1, t: ["a"], u: 3, z: 0 },
					{ n: 5, s: 2, t: ["b", "c"], u: 4, z: 0 },
					{ s: 3, z: 0 },
				],
			],
			[
				"$[] $min n",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $min: { "v.$[].n": 3 } },
				null,
				[
					{ n: 0, s: 1, t: ["a"], u: 3 },
					{ n: 3, s: 2, t: ["b", "c"], u: 4 },
					{ n: 3, s: 3 },
				],
			],
			[
				"$[] $max n",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $max: { "v.$[].n": 3 } },
				null,
				[
					{ n: 3, s: 1, t: ["a"], u: 3 },
					{ n: 5, s: 2, t: ["b", "c"], u: 4 },
					{ n: 3, s: 3 },
				],
			],
			[
				"$[] $set n",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $set: { "v.$[].n": 9 } },
				null,
				[
					{ n: 9, s: 1, t: ["a"], u: 3 },
					{ n: 9, s: 2, t: ["b", "c"], u: 4 },
					{ n: 9, s: 3 },
				],
			],
			[
				"$[] $unset n",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $unset: { "v.$[].n": "" } },
				null,
				[{ s: 1, t: ["a"], u: 3 }, { s: 2, t: ["b", "c"], u: 4 }, { s: 3 }],
			],
			[
				"$[] $push t",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $push: { "v.$[].t": "z" } },
				null,
				[
					{ n: 0, s: 1, t: ["a", "z"], u: 3 },
					{ n: 5, s: 2, t: ["b", "c", "z"], u: 4 },
					{ s: 3, t: ["z"] },
				],
			],
			[
				"$[] $addToSet t",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $addToSet: { "v.$[].t": "a" } },
				null,
				[
					{ n: 0, s: 1, t: ["a"], u: 3 },
					{ n: 5, s: 2, t: ["b", "c", "a"], u: 4 },
					{ s: 3, t: ["a"] },
				],
			],
			[
				"$[] $addToSet t new",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $addToSet: { "v.$[].t": "q" } },
				null,
				[
					{ n: 0, s: 1, t: ["a", "q"], u: 3 },
					{ n: 5, s: 2, t: ["b", "c", "q"], u: 4 },
					{ s: 3, t: ["q"] },
				],
			],
			[
				"$[] $pop t",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $pop: { "v.$[].t": 1 } },
				null,
				[{ n: 0, s: 1, t: [], u: 3 }, { n: 5, s: 2, t: ["b"], u: 4 }, { s: 3 }],
			],
			[
				"$[] $pull t",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $pull: { "v.$[].t": "a" } },
				null,
				[
					{ n: 0, s: 1, t: [], u: 3 },
					{ n: 5, s: 2, t: ["b", "c"], u: 4 },
					{ s: 3 },
				],
			],
			[
				"$[] $pullAll t",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $pullAll: { "v.$[].t": ["a", "b"] } },
				null,
				[{ n: 0, s: 1, t: [], u: 3 }, { n: 5, s: 2, t: ["c"], u: 4 }, { s: 3 }],
			],
			[
				"$[] $rename n",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $rename: { "v.$[].n": "v.$[].m" } },
				null,
				"error",
			],
			[
				"$[e] $inc n",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $inc: { "v.$[e].n": 1 } },
				{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
				[
					{ n: 0, s: 1, t: ["a"], u: 3 },
					{ n: 6, s: 2, t: ["b", "c"], u: 4 },
					{ n: 1, s: 3 },
				],
			],
			[
				"$[e] $inc new field",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $inc: { "v.$[e].z": 2 } },
				{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
				[
					{ n: 0, s: 1, t: ["a"], u: 3 },
					{ n: 5, s: 2, t: ["b", "c"], u: 4, z: 2 },
					{ s: 3, z: 2 },
				],
			],
			[
				"$[e] $mul u",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $mul: { "v.$[e].u": 2 } },
				{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
				[
					{ n: 0, s: 1, t: ["a"], u: 3 },
					{ n: 5, s: 2, t: ["b", "c"], u: 8 },
					{ s: 3, u: 0 },
				],
			],
			[
				"$[e] $min n",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $min: { "v.$[e].n": 3 } },
				{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
				[
					{ n: 0, s: 1, t: ["a"], u: 3 },
					{ n: 3, s: 2, t: ["b", "c"], u: 4 },
					{ n: 3, s: 3 },
				],
			],
			[
				"$[e] $max n",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $max: { "v.$[e].n": 3 } },
				{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
				[
					{ n: 0, s: 1, t: ["a"], u: 3 },
					{ n: 5, s: 2, t: ["b", "c"], u: 4 },
					{ n: 3, s: 3 },
				],
			],
			[
				"$[e] $set n",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $set: { "v.$[e].n": 9 } },
				{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
				[
					{ n: 0, s: 1, t: ["a"], u: 3 },
					{ n: 9, s: 2, t: ["b", "c"], u: 4 },
					{ n: 9, s: 3 },
				],
			],
			[
				"$[e] $unset n",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $unset: { "v.$[e].n": "" } },
				{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
				[
					{ n: 0, s: 1, t: ["a"], u: 3 },
					{ s: 2, t: ["b", "c"], u: 4 },
					{ s: 3 },
				],
			],
			[
				"$[e] $push t",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $push: { "v.$[e].t": "z" } },
				{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
				[
					{ n: 0, s: 1, t: ["a"], u: 3 },
					{ n: 5, s: 2, t: ["b", "c", "z"], u: 4 },
					{ s: 3, t: ["z"] },
				],
			],
			[
				"$[e] $addToSet t",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $addToSet: { "v.$[e].t": "q" } },
				{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
				[
					{ n: 0, s: 1, t: ["a"], u: 3 },
					{ n: 5, s: 2, t: ["b", "c", "q"], u: 4 },
					{ s: 3, t: ["q"] },
				],
			],
			[
				"$[e] $pop t",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $pop: { "v.$[e].t": 1 } },
				{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
				[
					{ n: 0, s: 1, t: ["a"], u: 3 },
					{ n: 5, s: 2, t: ["b"], u: 4 },
					{ s: 3 },
				],
			],
			[
				"$[e] $pull t",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $pull: { "v.$[e].t": "b" } },
				{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
				[
					{ n: 0, s: 1, t: ["a"], u: 3 },
					{ n: 5, s: 2, t: ["c"], u: 4 },
					{ s: 3 },
				],
			],
			[
				"$[e] $inc, filter matches none",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $inc: { "v.$[e].n": 1 } },
				{ arrayFilters: [{ "e.s": { $gt: 99 } }] },
				[
					{ n: 0, s: 1, t: ["a"], u: 3 },
					{ n: 5, s: 2, t: ["b", "c"], u: 4 },
					{ s: 3 },
				],
			],
			[
				"$[e] $inc, filter matches all",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $inc: { "v.$[e].n": 1 } },
				{ arrayFilters: [{ "e.s": { $gte: 0 } }] },
				[
					{ n: 1, s: 1, t: ["a"], u: 3 },
					{ n: 6, s: 2, t: ["b", "c"], u: 4 },
					{ n: 1, s: 3 },
				],
			],
			[
				"$[e] $inc, equality filter",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $inc: { "v.$[e].n": 1 } },
				{ arrayFilters: [{ "e.s": 2 }] },
				[
					{ n: 0, s: 1, t: ["a"], u: 3 },
					{ n: 6, s: 2, t: ["b", "c"], u: 4 },
					{ s: 3 },
				],
			],
			[
				"$[e] $inc, two conditions",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $inc: { "v.$[e].n": 1 } },
				{ arrayFilters: [{ "e.s": { $gte: 1 }, "e.u": { $lt: 4 } }] },
				[
					{ n: 1, s: 1, t: ["a"], u: 3 },
					{ n: 5, s: 2, t: ["b", "c"], u: 4 },
					{ s: 3 },
				],
			],
			[
				"$[e] $inc, two ops one field",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $inc: { "v.$[e].n": 1, "v.$[e].u": 10 } },
				{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
				[
					{ n: 0, s: 1, t: ["a"], u: 3 },
					{ n: 6, s: 2, t: ["b", "c"], u: 14 },
					{ n: 1, s: 3, u: 10 },
				],
			],
			[
				"$[e] $inc negative",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
				},
				{ $inc: { "v.$[e].n": -2 } },
				{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
				[
					{ n: 0, s: 1, t: ["a"], u: 3 },
					{ n: 3, s: 2, t: ["b", "c"], u: 4 },
					{ n: -2, s: 3 },
				],
			],
			[
				"scalars $[] $inc",
				{ v: [1, 2, 3] },
				{ $inc: { "v.$[]": 1 } },
				null,
				[2, 3, 4],
			],
			[
				"scalars $[] $mul",
				{ v: [1, 2, 3] },
				{ $mul: { "v.$[]": 2 } },
				null,
				[2, 4, 6],
			],
			[
				"scalars $[] $min",
				{ v: [1, 5, 3] },
				{ $min: { "v.$[]": 3 } },
				null,
				[1, 3, 3],
			],
			[
				"scalars $[] $max",
				{ v: [1, 5, 3] },
				{ $max: { "v.$[]": 3 } },
				null,
				[3, 5, 3],
			],
			[
				"scalars $[] $set",
				{ v: [1, 2, 3] },
				{ $set: { "v.$[]": 0 } },
				null,
				[0, 0, 0],
			],
			["empty array $inc", { v: [] }, { $inc: { "v.$[].n": 1 } }, null, []],
			[
				"nested $[a].w.$[b].n $inc",
				{
					v: [
						{
							k: 1,
							w: [
								{ n: 0, s: 1 },
								{ n: 5, s: 2 },
							],
						},
						{ k: 2, w: [{ n: 7, s: 3 }] },
					],
				},
				{ $inc: { "v.$[a].w.$[b].n": 1 } },
				{ arrayFilters: [{ "a.k": 1 }, { "b.s": { $gte: 2 } }] },
				[
					{
						k: 1,
						w: [
							{ n: 0, s: 1 },
							{ n: 6, s: 2 },
						],
					},
					{ k: 2, w: [{ n: 7, s: 3 }] },
				],
			],
			[
				"nested $[].w.$[].n $inc",
				{
					v: [
						{
							k: 1,
							w: [
								{ n: 0, s: 1 },
								{ n: 5, s: 2 },
							],
						},
						{ k: 2, w: [{ n: 7, s: 3 }] },
					],
				},
				{ $inc: { "v.$[].w.$[].n": 1 } },
				null,
				[
					{
						k: 1,
						w: [
							{ n: 1, s: 1 },
							{ n: 6, s: 2 },
						],
					},
					{ k: 2, w: [{ n: 8, s: 3 }] },
				],
			],
			[
				"nested $[a].w.$[].n $inc",
				{
					v: [
						{
							k: 1,
							w: [
								{ n: 0, s: 1 },
								{ n: 5, s: 2 },
							],
						},
						{ k: 2, w: [{ n: 7, s: 3 }] },
					],
				},
				{ $inc: { "v.$[a].w.$[].n": 1 } },
				{ arrayFilters: [{ "a.k": 2 }] },
				[
					{
						k: 1,
						w: [
							{ n: 0, s: 1 },
							{ n: 5, s: 2 },
						],
					},
					{ k: 2, w: [{ n: 8, s: 3 }] },
				],
			],
			[
				"nested $[a].w.$[b].n $set",
				{
					v: [
						{
							k: 1,
							w: [
								{ n: 0, s: 1 },
								{ n: 5, s: 2 },
							],
						},
						{ k: 2, w: [{ n: 7, s: 3 }] },
					],
				},
				{ $set: { "v.$[a].w.$[b].n": 99 } },
				{ arrayFilters: [{ "a.k": 1 }, { "b.s": { $gte: 2 } }] },
				[
					{
						k: 1,
						w: [
							{ n: 0, s: 1 },
							{ n: 99, s: 2 },
						],
					},
					{ k: 2, w: [{ n: 7, s: 3 }] },
				],
			],
			[
				"$inc positional + plain",
				{
					v: [
						{ n: 0, s: 1, t: ["a"], u: 3 },
						{ n: 5, s: 2, t: ["b", "c"], u: 4 },
						{ s: 3 },
					],
					count: 0,
				},
				{ $inc: { "v.$[e].n": 1, count: 1 } },
				{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
				[
					{ n: 0, s: 1, t: ["a"], u: 3 },
					{ n: 6, s: 2, t: ["b", "c"], u: 4 },
					{ n: 1, s: 3 },
				],
			],
			[
				"scalar elems + sub-path",
				{ v: [1, 2] },
				{ $inc: { "v.$[].n": 1 } },
				null,
				"error",
			],
			[
				"mixed elems + sub-path",
				{ v: [{ n: 1 }, 5] },
				{ $inc: { "v.$[].n": 1 } },
				null,
				"error",
			],
			[
				"$unset element itself",
				{ v: [1, 2] },
				{ $unset: { "v.$[]": "" } },
				null,
				[null, null],
			],
			[
				"$set element itself",
				{ v: [1, 2] },
				{ $set: { "v.$[]": { a: 1 } } },
				null,
				[{ a: 1 }, { a: 1 }],
			],
			[
				"conflict: $inc + $set same leaf",
				{ v: [{ n: 0, s: 1 }, { n: 5, s: 2 }, { s: 3 }] },
				{ $inc: { "v.$[].n": 1 }, $set: { "v.$[].n": 9 } },
				null,
				"error",
			],
			[
				"conflict: prefix",
				{ v: [{ a: { b: 1 } }] },
				{ $set: { "v.$[].a": 1 }, $inc: { "v.$[].a.b": 1 } },
				null,
				"error",
			],
			[
				"two identifiers one array",
				{ v: [{ n: 0, s: 1 }, { n: 5, s: 2 }, { s: 3 }] },
				{ $inc: { "v.$[a].n": 1, "v.$[b].s": 10 } },
				{ arrayFilters: [{ "a.s": 1 }, { "b.s": { $gte: 2 } }] },
				[{ n: 1, s: 1 }, { n: 5, s: 12 }, { s: 13 }],
			],
			[
				"$[] and $[e] one array",
				{ v: [{ n: 0, s: 1 }, { n: 5, s: 2 }, { s: 3 }] },
				{ $inc: { "v.$[].n": 1, "v.$[e].s": 10 } },
				{ arrayFilters: [{ "e.s": 1 }] },
				[
					{ n: 1, s: 11 },
					{ n: 6, s: 2 },
					{ n: 1, s: 3 },
				],
			],
			[
				"$inc + $set different leaves",
				{ v: [{ n: 0, s: 1 }, { n: 5, s: 2 }, { s: 3 }] },
				{ $inc: { "v.$[e].n": 1 }, $set: { "v.$[e].flag": true } },
				{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
				[
					{ n: 0, s: 1 },
					{ flag: true, n: 6, s: 2 },
					{ flag: true, n: 1, s: 3 },
				],
			],
			[
				"filter on the field being incremented",
				{ v: [{ n: 4 }, { n: 5 }, { n: 6 }] },
				{ $inc: { "v.$[e].n": 1, "v.$[e].m": 1 } },
				{ arrayFilters: [{ "e.n": { $lt: 6 } }] },
				[{ m: 1, n: 5 }, { m: 1, n: 6 }, { n: 6 }],
			],
			[
				"$inc deep new path ($[])",
				{ v: [{ s: 1 }, { a: { b: 1 } }] },
				{ $inc: { "v.$[].a.b": 2 } },
				null,
				[{ a: { b: 2 }, s: 1 }, { a: { b: 3 } }],
			],
			[
				"$push deep",
				{ v: [{ s: 1 }, { a: { t: [1] } }] },
				{ $push: { "v.$[].a.t": 9 } },
				null,
				[{ a: { t: [9] }, s: 1 }, { a: { t: [1, 9] } }],
			],
			[
				"$push $each $position",
				{ v: [{ t: [1, 2] }, {}] },
				{ $push: { "v.$[].t": { $each: [8, 9], $position: 1 } } },
				null,
				[{ t: [1, 8, 9, 2] }, { t: [8, 9] }],
			],
			[
				"$push $each $sort $slice",
				{ v: [{ t: [3, 1] }, {}] },
				{ $push: { "v.$[].t": { $each: [2, 5], $sort: 1, $slice: 3 } } },
				null,
				[{ t: [1, 2, 3] }, { t: [2, 5] }],
			],
			[
				"$addToSet $each",
				{ v: [{ t: [1] }, {}] },
				{ $addToSet: { "v.$[].t": { $each: [1, 2] } } },
				null,
				[{ t: [1, 2] }, { t: [1, 2] }],
			],
			[
				"$pull condition",
				{ v: [{ t: [1, 5, 9] }, { t: [2] }, {}] },
				{ $pull: { "v.$[].t": { $gt: 4 } } },
				null,
				[{ t: [1] }, { t: [2] }, {}],
			],
			[
				"$pull sub-doc condition",
				{ v: [{ t: [{ p: 1 }, { p: 9 }] }, {}] },
				{ $pull: { "v.$[].t": { p: { $gt: 4 } } } },
				null,
				[{ t: [{ p: 1 }] }, {}],
			],
			[
				"$rename dest positional",
				{ v: [{ a: 1 }] },
				{ $rename: { "v.0.a": "v.$[].b" } },
				null,
				"error",
			],
			[
				"$min/$max strings",
				{ v: [{ s: "b" }, { s: "d" }] },
				{ $min: { "v.$[].s": "c" } },
				null,
				[{ s: "b" }, { s: "c" }],
			],
			[
				"$mul float",
				{ v: [{ n: 2 }, { n: 3 }] },
				{ $mul: { "v.$[].n": 1.5 } },
				null,
				[{ n: 3 }, { n: 4.5 }],
			],
			[
				"$inc on string leaf",
				{ v: [{ n: "a" }] },
				{ $inc: { "v.$[].n": 1 } },
				null,
				"error",
			],
			[
				"$inc on null leaf",
				{ v: [{ n: null }] },
				{ $inc: { "v.$[].n": 1 } },
				null,
				"error",
			],
			[
				"index before marker",
				{ v: [{ w: [{ n: 1 }, { n: 2 }] }, { w: [{ n: 3 }] }] },
				{ $inc: { "v.0.w.$[].n": 1 } },
				null,
				[{ w: [{ n: 2 }, { n: 3 }] }, { w: [{ n: 3 }] }],
			],
			[
				"$unset deep, elements lack the parent",
				{ v: [{ s: 1 }, { a: { b: 1, c: 2 } }, { a: {} }] },
				{ $unset: { "v.$[].a.b": "" } },
				null,
				[{ s: 1 }, { a: { c: 2 } }, { a: {} }],
			],
			[
				"$unset deep, scalar parent",
				{ v: [{ a: 5 }] },
				{ $unset: { "v.$[].a.b": "" } },
				null,
				[{ a: 5 }],
			],
			[
				"$unset + $inc same elements",
				{
					v: [
						{ n: 1, m: 2 },
						{ n: 3, m: 4 },
					],
				},
				{ $unset: { "v.$[e].m": "" }, $inc: { "v.$[e].n": 1 } },
				{ arrayFilters: [{ "e.n": { $gte: 3 } }] },
				[{ m: 2, n: 1 }, { n: 4 }],
			],
			[
				"$set deep creates parent",
				{ v: [{ s: 1 }, { a: { c: 2 } }] },
				{ $set: { "v.$[].a.b": 9 } },
				null,
				[{ a: { b: 9 }, s: 1 }, { a: { b: 9, c: 2 } }],
			],
			[
				"$push on array inside branch, absent",
				{ v: [{ s: 1 }, { a: { t: [1] } }] },
				{ $push: { "v.$[].a.t": 7 } },
				null,
				[{ a: { t: [7] }, s: 1 }, { a: { t: [1, 7] } }],
			],
			[
				"two arrays, one update",
				{ v: [{ n: 1 }], w: [{ m: 1 }] },
				{ $inc: { "v.$[].n": 1, "w.$[].m": 5 } },
				null,
				[{ n: 2 }],
			],
		];

		for (const [label, doc, update, options, expected] of CASES) {
			test(label, async () => {
				if (expected === "error") {
					await expect(run(doc, update, options)).rejects.toThrow();
					return;
				}
				expect((await run(doc, update, options)).doc?.v).toEqual(expected);
			});
		}
	});

	// MongoDB reads the clock as it reaches each element, and so does this driver:
	// over 3,000 elements a real `mongod` wrote two different dates, a millisecond
	// apart. So what is asserted is a date on every element and that they are all
	// the same moment to within a second, and not that they are equal.
	test("$currentDate sets the current date on every element", async () => {
		const before = Date.now();
		const { doc } = await run(
			{ v: Array.from({ length: 200 }, (_, n) => ({ n })) },
			{ $currentDate: { "v.$[].at": true } },
		);
		const after = Date.now();

		const dates = (doc?.v as { at: unknown }[]).map((element) => element.at);
		for (const date of dates) expect(date).toBeInstanceOf(Date);

		const times = (dates as Date[]).map((date) => date.getTime());
		expect(Math.max(...times) - Math.min(...times)).toBeLessThan(1000);
		// The server's clock and this one are the same on any machine these run on,
		// to well within a minute.
		expect(Math.abs(times[0] - before)).toBeLessThan(60_000);
		expect(Math.abs(times[0] - after)).toBeLessThan(60_000);
	});

	test("the plain fields beside it are updated as usual", async () => {
		const { doc } = await run(
			{
				v: [
					{ n: 0, s: 1 },
					{ n: 5, s: 2 },
				],
				count: 0,
			},
			{ $inc: { "v.$[e].n": 1, count: 1 } },
			{ arrayFilters: [{ "e.s": { $gte: 2 } }] },
		);
		expect(doc?.count).toBe(1);
		expect(doc?.v).toEqual([
			{ n: 0, s: 1 },
			{ n: 6, s: 2 },
		]);
	});

	describe("what an update reports", () => {
		test("an update that changes an element is modified", async () => {
			const { result } = await run(
				{ v: [{ n: 1 }] },
				{ $inc: { "v.$[].n": 1 } },
			);
			expect(result.matchedCount).toBe(1);
			expect(result.modifiedCount).toBe(1);
		});

		test("an update that leaves every element as it was is not", async () => {
			const { result } = await run(
				{ v: [{ n: 9 }, { n: 8 }] },
				{ $max: { "v.$[].n": 3 } },
			);
			expect(result.matchedCount).toBe(1);
			expect(result.modifiedCount).toBe(0);
		});

		test("a filter that selects nothing changes nothing", async () => {
			const { result, doc } = await run(
				{ v: [{ n: 1, s: 1 }] },
				{ $inc: { "v.$[e].n": 1 } },
				{ arrayFilters: [{ "e.s": { $gt: 99 } }] },
			);
			expect(result.modifiedCount).toBe(0);
			expect(doc?.v).toEqual([{ n: 1, s: 1 }]);
		});
	});

	describe("where this driver differs from MongoDB", () => {
		test("an array that is absent is left alone, where MongoDB raises", async () => {
			const { result, doc } = await run({}, { $inc: { "v.$[].n": 1 } });
			expect(result.matchedCount).toBe(1);
			expect(doc?.v).toBeUndefined();
		});

		test("an element that is not a document raises, and nothing is written", async () => {
			await docs.insertOne({ k: "a", v: [{ n: 1 }, 5] });
			await expect(
				(async () =>
					docs.updateOne({ k: "a" }, { $inc: { "v.$[].n": 1 } } as never))(),
			).rejects.toThrow("Cannot create a field in an array element");
			expect((await docs.findOne({ k: "a" }))?.v).toEqual([{ n: 1 }, 5]);
		});

		test("an array index after a marker is refused", async () => {
			await docs.insertOne({ k: "a", v: [{ c: [1, 2] }] });
			await expect(
				(async () =>
					docs.updateOne({ k: "a" }, { $inc: { "v.$[].c.0": 1 } } as never))(),
			).rejects.toThrow(MongoCompatibilityError);
		});

		test("$rename through a marker is refused, as MongoDB refuses it", async () => {
			await docs.insertOne({ k: "a", v: [{ n: 1 }] });
			await expect(
				(async () =>
					docs.updateOne({ k: "a" }, {
						$rename: { "v.$[].n": "m" },
					} as never))(),
			).rejects.toThrow("The source field for $rename may not be dynamic");
		});

		test("two operators on one path are refused, as MongoDB refuses them", async () => {
			await docs.insertOne({ k: "a", v: [{ n: 1 }] });
			await expect(
				(async () =>
					docs.updateOne({ k: "a" }, {
						$inc: { "v.$[].n": 1 },
						$set: { "v.$[].n": 9 },
					} as never))(),
			).rejects.toThrow("would create a conflict");
			expect((await docs.findOne({ k: "a" }))?.v).toEqual([{ n: 1 }]);
		});
	});

	describe("every way of running an update", () => {
		test("updateMany, over arrays of different lengths", async () => {
			await docs.insertMany([
				{ k: "a", v: [{ n: 0 }, { n: 5 }] },
				{ k: "b", v: [{ n: 1 }] },
				{ k: "c", v: [] },
			]);
			const result = await docs.updateMany({}, {
				$inc: { "v.$[].n": 10 },
			} as never);
			expect(result.modifiedCount).toBe(2);
			expect((await docs.findOne({ k: "a" }))?.v).toEqual([
				{ n: 10 },
				{ n: 15 },
			]);
			expect((await docs.findOne({ k: "b" }))?.v).toEqual([{ n: 11 }]);
			expect((await docs.findOne({ k: "c" }))?.v).toEqual([]);
		});

		test("findOneAndUpdate, returning the document", async () => {
			await docs.insertOne({
				k: "a",
				v: [
					{ qty: 1, status: "active" },
					{ qty: 5, status: "done" },
				],
			});
			const updated = await docs.findOneAndUpdate(
				{ k: "a" },
				{ $inc: { "v.$[item].qty": 1 } } as never,
				{
					arrayFilters: [{ "item.status": "active" }],
					returnDocument: "after",
				},
			);
			expect(updated?.v).toEqual([
				{ qty: 2, status: "active" },
				{ qty: 5, status: "done" },
			]);
		});

		test("bulkWrite", async () => {
			await docs.insertOne({ k: "a", v: [{ n: 1 }] });
			await docs.bulkWrite([
				{
					updateOne: {
						filter: { k: "a" },
						update: { $inc: { "v.$[].n": 1 } } as never,
					},
				},
			]);
			expect((await docs.findOne({ k: "a" }))?.v).toEqual([{ n: 2 }]);
		});

		test("an upsert that inserts leaves an absent array absent", async () => {
			const result = await docs.updateOne(
				{ k: "new" },
				{ $inc: { "v.$[].n": 1 }, $set: { seen: true } } as never,
				{ upsert: true },
			);
			expect(result.upsertedCount).toBe(1);
			const created = await docs.findOne({ k: "new" });
			expect(created?.seen).toBe(true);
			expect(created?.v).toBeUndefined();
		});
	});
});

// ---------------------------------------------------------------------------
// EQUALITY OPERATORS IN $pull AND arrayFilters
// ---------------------------------------------------------------------------

describe("equality in $pull and arrayFilters reads a value as a field's", () => {
	// A `$pull` condition and an `arrayFilters` entry are query predicates applied
	// to a value the update finds in an array, so equality sees into an array,
	// `null` is a null, a missing field or an array holding one, and `$ne` and
	// `$nin` are exact negations. As a bare `=` and `IN` they compared the value
	// whole: `{$pull: {v: {$eq: 7}}}` over `[[7, 8], 7]` left `[[7, 8]]` where
	// MongoDB leaves `[]`. What a real `mongod` leaves in the array is what each
	// case below expects, and `tests/e2e/scenarios/crud-scenarios.ts` checks them
	// against one. A bare `{$pull: {v: 7}}` and `$pullAll` are whole-value equality
	// in MongoDB and are in the table to show they stayed that way.

	interface ArrayDoc {
		[key: string]: unknown;
		_id?: ObjectId | string | number;
		k: string;
		v?: unknown;
	}

	let docs: Collection<ArrayDoc>;

	beforeEach(async () => {
		docs = ctx.db.collection<ArrayDoc>("array_equality");
		try {
			await docs.deleteMany({});
		} catch {
			// ignore
		}
	});

	const run = async (
		doc: Record<string, unknown>,
		update: Record<string, unknown>,
		options?: Record<string, unknown> | null,
	) => {
		await docs.deleteMany({});
		await docs.insertOne({ k: "a", ...doc });
		await docs.updateOne(
			{ k: "a" },
			update as never,
			(options ?? undefined) as never,
		);
		return (await docs.findOne({ k: "a" }))?.v;
	};

	const CASES: [
		string,
		Record<string, unknown>,
		Record<string, unknown>,
		Record<string, unknown> | null,
		unknown,
	][] = [
		[
			"pull $eq 7",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $eq: 7 } } },
			null,
			[5, "7", [5], null, [null], { a: 7 }],
		],
		[
			"pull $ne 7",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $ne: 7 } } },
			null,
			[[7, 8], 7, [7]],
		],
		[
			"pull $in [7]",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $in: [7] } } },
			null,
			[5, "7", [5], null, [null], { a: 7 }],
		],
		[
			"pull $nin [7]",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $nin: [7] } } },
			null,
			[[7, 8], 7, [7]],
		],
		[
			"pull $in [7,5]",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $in: [7, 5] } } },
			null,
			["7", null, [null], { a: 7 }],
		],
		[
			"pull $nin [7,5]",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $nin: [7, 5] } } },
			null,
			[[7, 8], 7, 5, [5], [7]],
		],
		[
			'pull $in [7,"7"]',
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $in: [7, "7"] } } },
			null,
			[5, [5], null, [null], { a: 7 }],
		],
		[
			'pull $eq "7"',
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $eq: "7" } } },
			null,
			[[7, 8], 7, 5, [5], null, [null], { a: 7 }, [7]],
		],
		[
			"pull $eq [7,8]",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $eq: [7, 8] } } },
			null,
			[7, 5, "7", [5], null, [null], { a: 7 }, [7]],
		],
		[
			"pull $ne [7,8]",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $ne: [7, 8] } } },
			null,
			[[7, 8]],
		],
		[
			"pull $in [[7,8]]",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $in: [[7, 8]] } } },
			null,
			[7, 5, "7", [5], null, [null], { a: 7 }, [7]],
		],
		[
			"pull $nin [[7,8]]",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $nin: [[7, 8]] } } },
			null,
			[[7, 8]],
		],
		[
			"pull $eq [5]",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $eq: [5] } } },
			null,
			[[7, 8], 7, 5, "7", null, [null], { a: 7 }, [7]],
		],
		[
			"pull $in [[5]]",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $in: [[5]] } } },
			null,
			[[7, 8], 7, 5, "7", null, [null], { a: 7 }, [7]],
		],
		[
			"pull $eq null",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $eq: null } } },
			null,
			[[7, 8], 7, 5, "7", [5], { a: 7 }, [7]],
		],
		[
			"pull $ne null",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $ne: null } } },
			null,
			[null, [null]],
		],
		[
			"pull $in [null]",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $in: [null] } } },
			null,
			[[7, 8], 7, 5, "7", [5], { a: 7 }, [7]],
		],
		[
			"pull $nin [null]",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $nin: [null] } } },
			null,
			[null, [null]],
		],
		[
			"pull $eq {a:7}",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $eq: { a: 7 } } } },
			null,
			[[7, 8], 7, 5, "7", [5], null, [null], [7]],
		],
		[
			"pull $in [{a:7}]",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $in: [{ a: 7 }] } } },
			null,
			[[7, 8], 7, 5, "7", [5], null, [null], [7]],
		],
		[
			"pull $eq 7 + $ne 5",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $eq: 7, $ne: 5 } } },
			null,
			[5, "7", [5], null, [null], { a: 7 }],
		],
		[
			"pull $gt 4 + $ne 7",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $gt: 4, $ne: 7 } } },
			null,
			[[7, 8], 7, "7", null, [null], { a: 7 }, [7]],
		],
		[
			"pull $in [7,5] + $nin [5]",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $in: [7, 5], $nin: [5] } } },
			null,
			[5, "7", [5], null, [null], { a: 7 }],
		],
		[
			"pull $ne 7 + $ne? ($nin [5])",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, [7]] },
			{ $pull: { v: { $ne: 7, $nin: [5] } } },
			null,
			[[7, 8], 7, 5, [5], [7]],
		],
		[
			"pull strings $eq 'a'",
			{ v: ["abc", "a", ["abc", "x"], ["a"], "ab"] },
			{ $pull: { v: { $eq: "a" } } },
			null,
			["abc", ["abc", "x"], "ab"],
		],
		[
			"pull strings $ne 'a'",
			{ v: ["abc", "a", ["abc", "x"], ["a"], "ab"] },
			{ $pull: { v: { $ne: "a" } } },
			null,
			["a", ["a"]],
		],
		[
			"pull strings $in ['a']",
			{ v: ["abc", "a", ["abc", "x"], ["a"], "ab"] },
			{ $pull: { v: { $in: ["a"] } } },
			null,
			["abc", ["abc", "x"], "ab"],
		],
		[
			"pull strings $nin ['a']",
			{ v: ["abc", "a", ["abc", "x"], ["a"], "ab"] },
			{ $pull: { v: { $nin: ["a"] } } },
			null,
			["a", ["a"]],
		],
		[
			"pull sub a: 1",
			{
				v: [
					{ a: [1, 2] },
					{ a: 1 },
					{ a: 2 },
					{ a: [3] },
					{ b: 1 },
					{ a: null },
					{ a: [null] },
					{ a: "1" },
				],
			},
			{ $pull: { v: { a: 1 } } },
			null,
			[{ a: 2 }, { a: [3] }, { b: 1 }, { a: null }, { a: [null] }, { a: "1" }],
		],
		[
			"pull sub a $eq 1",
			{
				v: [
					{ a: [1, 2] },
					{ a: 1 },
					{ a: 2 },
					{ a: [3] },
					{ b: 1 },
					{ a: null },
					{ a: [null] },
					{ a: "1" },
				],
			},
			{ $pull: { v: { a: { $eq: 1 } } } },
			null,
			[{ a: 2 }, { a: [3] }, { b: 1 }, { a: null }, { a: [null] }, { a: "1" }],
		],
		[
			"pull sub a $ne 1",
			{
				v: [
					{ a: [1, 2] },
					{ a: 1 },
					{ a: 2 },
					{ a: [3] },
					{ b: 1 },
					{ a: null },
					{ a: [null] },
					{ a: "1" },
				],
			},
			{ $pull: { v: { a: { $ne: 1 } } } },
			null,
			[{ a: [1, 2] }, { a: 1 }],
		],
		[
			"pull sub a $in [1]",
			{
				v: [
					{ a: [1, 2] },
					{ a: 1 },
					{ a: 2 },
					{ a: [3] },
					{ b: 1 },
					{ a: null },
					{ a: [null] },
					{ a: "1" },
				],
			},
			{ $pull: { v: { a: { $in: [1] } } } },
			null,
			[{ a: 2 }, { a: [3] }, { b: 1 }, { a: null }, { a: [null] }, { a: "1" }],
		],
		[
			"pull sub a $nin [1]",
			{
				v: [
					{ a: [1, 2] },
					{ a: 1 },
					{ a: 2 },
					{ a: [3] },
					{ b: 1 },
					{ a: null },
					{ a: [null] },
					{ a: "1" },
				],
			},
			{ $pull: { v: { a: { $nin: [1] } } } },
			null,
			[{ a: [1, 2] }, { a: 1 }],
		],
		[
			"pull sub a: [1,2]",
			{
				v: [
					{ a: [1, 2] },
					{ a: 1 },
					{ a: 2 },
					{ a: [3] },
					{ b: 1 },
					{ a: null },
					{ a: [null] },
					{ a: "1" },
				],
			},
			{ $pull: { v: { a: [1, 2] } } },
			null,
			[
				{ a: 1 },
				{ a: 2 },
				{ a: [3] },
				{ b: 1 },
				{ a: null },
				{ a: [null] },
				{ a: "1" },
			],
		],
		[
			"pull sub a $eq [1,2]",
			{
				v: [
					{ a: [1, 2] },
					{ a: 1 },
					{ a: 2 },
					{ a: [3] },
					{ b: 1 },
					{ a: null },
					{ a: [null] },
					{ a: "1" },
				],
			},
			{ $pull: { v: { a: { $eq: [1, 2] } } } },
			null,
			[
				{ a: 1 },
				{ a: 2 },
				{ a: [3] },
				{ b: 1 },
				{ a: null },
				{ a: [null] },
				{ a: "1" },
			],
		],
		[
			"pull sub a: null",
			{
				v: [
					{ a: [1, 2] },
					{ a: 1 },
					{ a: 2 },
					{ a: [3] },
					{ b: 1 },
					{ a: null },
					{ a: [null] },
					{ a: "1" },
				],
			},
			{ $pull: { v: { a: null } } },
			null,
			[{ a: [1, 2] }, { a: 1 }, { a: 2 }, { a: [3] }, { a: "1" }],
		],
		[
			"pull sub a $ne null",
			{
				v: [
					{ a: [1, 2] },
					{ a: 1 },
					{ a: 2 },
					{ a: [3] },
					{ b: 1 },
					{ a: null },
					{ a: [null] },
					{ a: "1" },
				],
			},
			{ $pull: { v: { a: { $ne: null } } } },
			null,
			[{ b: 1 }, { a: null }, { a: [null] }],
		],
		[
			"pull sub a $in [1,3]",
			{
				v: [
					{ a: [1, 2] },
					{ a: 1 },
					{ a: 2 },
					{ a: [3] },
					{ b: 1 },
					{ a: null },
					{ a: [null] },
					{ a: "1" },
				],
			},
			{ $pull: { v: { a: { $in: [1, 3] } } } },
			null,
			[{ a: 2 }, { b: 1 }, { a: null }, { a: [null] }, { a: "1" }],
		],
		[
			"pull sub a: 1, b: 1 (both)",
			{
				v: [
					{ a: [1, 2] },
					{ a: 1 },
					{ a: 2 },
					{ a: [3] },
					{ b: 1 },
					{ a: null },
					{ a: [null] },
					{ a: "1" },
				],
			},
			{ $pull: { v: { a: 1, b: 1 } } },
			null,
			[
				{ a: [1, 2] },
				{ a: 1 },
				{ a: 2 },
				{ a: [3] },
				{ b: 1 },
				{ a: null },
				{ a: [null] },
				{ a: "1" },
			],
		],
		[
			"arrayFilters p: 9",
			{
				v: [
					{ p: 9 },
					{ p: [1, 9] },
					{ p: 5 },
					{ x: 1 },
					{ p: null },
					{ p: [null] },
					{ p: "9" },
					{ p: [[1, 9]] },
				],
			},
			{ $set: { "v.$[e].flag": true } },
			{ arrayFilters: [{ "e.p": 9 }] },
			[
				{ flag: true, p: 9 },
				{ flag: true, p: [1, 9] },
				{ p: 5 },
				{ x: 1 },
				{ p: null },
				{ p: [null] },
				{ p: "9" },
				{ p: [[1, 9]] },
			],
		],
		[
			"arrayFilters p $eq 9",
			{
				v: [
					{ p: 9 },
					{ p: [1, 9] },
					{ p: 5 },
					{ x: 1 },
					{ p: null },
					{ p: [null] },
					{ p: "9" },
					{ p: [[1, 9]] },
				],
			},
			{ $set: { "v.$[e].flag": true } },
			{ arrayFilters: [{ "e.p": { $eq: 9 } }] },
			[
				{ flag: true, p: 9 },
				{ flag: true, p: [1, 9] },
				{ p: 5 },
				{ x: 1 },
				{ p: null },
				{ p: [null] },
				{ p: "9" },
				{ p: [[1, 9]] },
			],
		],
		[
			"arrayFilters p $ne 9",
			{
				v: [
					{ p: 9 },
					{ p: [1, 9] },
					{ p: 5 },
					{ x: 1 },
					{ p: null },
					{ p: [null] },
					{ p: "9" },
					{ p: [[1, 9]] },
				],
			},
			{ $set: { "v.$[e].flag": true } },
			{ arrayFilters: [{ "e.p": { $ne: 9 } }] },
			[
				{ p: 9 },
				{ p: [1, 9] },
				{ flag: true, p: 5 },
				{ flag: true, x: 1 },
				{ flag: true, p: null },
				{ flag: true, p: [null] },
				{ flag: true, p: "9" },
				{ flag: true, p: [[1, 9]] },
			],
		],
		[
			"arrayFilters p $in [9]",
			{
				v: [
					{ p: 9 },
					{ p: [1, 9] },
					{ p: 5 },
					{ x: 1 },
					{ p: null },
					{ p: [null] },
					{ p: "9" },
					{ p: [[1, 9]] },
				],
			},
			{ $set: { "v.$[e].flag": true } },
			{ arrayFilters: [{ "e.p": { $in: [9] } }] },
			[
				{ flag: true, p: 9 },
				{ flag: true, p: [1, 9] },
				{ p: 5 },
				{ x: 1 },
				{ p: null },
				{ p: [null] },
				{ p: "9" },
				{ p: [[1, 9]] },
			],
		],
		[
			"arrayFilters p $nin [9]",
			{
				v: [
					{ p: 9 },
					{ p: [1, 9] },
					{ p: 5 },
					{ x: 1 },
					{ p: null },
					{ p: [null] },
					{ p: "9" },
					{ p: [[1, 9]] },
				],
			},
			{ $set: { "v.$[e].flag": true } },
			{ arrayFilters: [{ "e.p": { $nin: [9] } }] },
			[
				{ p: 9 },
				{ p: [1, 9] },
				{ flag: true, p: 5 },
				{ flag: true, x: 1 },
				{ flag: true, p: null },
				{ flag: true, p: [null] },
				{ flag: true, p: "9" },
				{ flag: true, p: [[1, 9]] },
			],
		],
		[
			"arrayFilters p $in [9, 5]",
			{
				v: [
					{ p: 9 },
					{ p: [1, 9] },
					{ p: 5 },
					{ x: 1 },
					{ p: null },
					{ p: [null] },
					{ p: "9" },
					{ p: [[1, 9]] },
				],
			},
			{ $set: { "v.$[e].flag": true } },
			{ arrayFilters: [{ "e.p": { $in: [9, 5] } }] },
			[
				{ flag: true, p: 9 },
				{ flag: true, p: [1, 9] },
				{ flag: true, p: 5 },
				{ x: 1 },
				{ p: null },
				{ p: [null] },
				{ p: "9" },
				{ p: [[1, 9]] },
			],
		],
		[
			"arrayFilters p: null",
			{
				v: [
					{ p: 9 },
					{ p: [1, 9] },
					{ p: 5 },
					{ x: 1 },
					{ p: null },
					{ p: [null] },
					{ p: "9" },
					{ p: [[1, 9]] },
				],
			},
			{ $set: { "v.$[e].flag": true } },
			{ arrayFilters: [{ "e.p": null }] },
			[
				{ p: 9 },
				{ p: [1, 9] },
				{ p: 5 },
				{ flag: true, x: 1 },
				{ flag: true, p: null },
				{ flag: true, p: [null] },
				{ p: "9" },
				{ p: [[1, 9]] },
			],
		],
		[
			"arrayFilters p $ne null",
			{
				v: [
					{ p: 9 },
					{ p: [1, 9] },
					{ p: 5 },
					{ x: 1 },
					{ p: null },
					{ p: [null] },
					{ p: "9" },
					{ p: [[1, 9]] },
				],
			},
			{ $set: { "v.$[e].flag": true } },
			{ arrayFilters: [{ "e.p": { $ne: null } }] },
			[
				{ flag: true, p: 9 },
				{ flag: true, p: [1, 9] },
				{ flag: true, p: 5 },
				{ x: 1 },
				{ p: null },
				{ p: [null] },
				{ flag: true, p: "9" },
				{ flag: true, p: [[1, 9]] },
			],
		],
		[
			"arrayFilters p $in [null]",
			{
				v: [
					{ p: 9 },
					{ p: [1, 9] },
					{ p: 5 },
					{ x: 1 },
					{ p: null },
					{ p: [null] },
					{ p: "9" },
					{ p: [[1, 9]] },
				],
			},
			{ $set: { "v.$[e].flag": true } },
			{ arrayFilters: [{ "e.p": { $in: [null] } }] },
			[
				{ p: 9 },
				{ p: [1, 9] },
				{ p: 5 },
				{ flag: true, x: 1 },
				{ flag: true, p: null },
				{ flag: true, p: [null] },
				{ p: "9" },
				{ p: [[1, 9]] },
			],
		],
		[
			"arrayFilters p: [1,9]",
			{
				v: [
					{ p: 9 },
					{ p: [1, 9] },
					{ p: 5 },
					{ x: 1 },
					{ p: null },
					{ p: [null] },
					{ p: "9" },
					{ p: [[1, 9]] },
				],
			},
			{ $set: { "v.$[e].flag": true } },
			{ arrayFilters: [{ "e.p": [1, 9] }] },
			[
				{ p: 9 },
				{ flag: true, p: [1, 9] },
				{ p: 5 },
				{ x: 1 },
				{ p: null },
				{ p: [null] },
				{ p: "9" },
				{ flag: true, p: [[1, 9]] },
			],
		],
		[
			"arrayFilters p $eq [1,9]",
			{
				v: [
					{ p: 9 },
					{ p: [1, 9] },
					{ p: 5 },
					{ x: 1 },
					{ p: null },
					{ p: [null] },
					{ p: "9" },
					{ p: [[1, 9]] },
				],
			},
			{ $set: { "v.$[e].flag": true } },
			{ arrayFilters: [{ "e.p": { $eq: [1, 9] } }] },
			[
				{ p: 9 },
				{ flag: true, p: [1, 9] },
				{ p: 5 },
				{ x: 1 },
				{ p: null },
				{ p: [null] },
				{ p: "9" },
				{ flag: true, p: [[1, 9]] },
			],
		],
		[
			"arrayFilters p $in [[1,9]]",
			{
				v: [
					{ p: 9 },
					{ p: [1, 9] },
					{ p: 5 },
					{ x: 1 },
					{ p: null },
					{ p: [null] },
					{ p: "9" },
					{ p: [[1, 9]] },
				],
			},
			{ $set: { "v.$[e].flag": true } },
			{ arrayFilters: [{ "e.p": { $in: [[1, 9]] } }] },
			[
				{ p: 9 },
				{ flag: true, p: [1, 9] },
				{ p: 5 },
				{ x: 1 },
				{ p: null },
				{ p: [null] },
				{ p: "9" },
				{ flag: true, p: [[1, 9]] },
			],
		],
		[
			"arrayFilters p: '9'",
			{
				v: [
					{ p: 9 },
					{ p: [1, 9] },
					{ p: 5 },
					{ x: 1 },
					{ p: null },
					{ p: [null] },
					{ p: "9" },
					{ p: [[1, 9]] },
				],
			},
			{ $set: { "v.$[e].flag": true } },
			{ arrayFilters: [{ "e.p": "9" }] },
			[
				{ p: 9 },
				{ p: [1, 9] },
				{ p: 5 },
				{ x: 1 },
				{ p: null },
				{ p: [null] },
				{ flag: true, p: "9" },
				{ p: [[1, 9]] },
			],
		],
		[
			"pullAll [7]",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]] },
			{ $pullAll: { v: [7] } },
			null,
			[[7, 8], 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]],
		],
		[
			"pullAll [[7,8]]",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]] },
			{ $pullAll: { v: [[7, 8]] } },
			null,
			[7, 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]],
		],
		[
			"pullAll [null]",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]] },
			{ $pullAll: { v: [null] } },
			null,
			[[7, 8], 7, 5, "7", [5], [null], { a: 7 }, "abc", ["abc"]],
		],
		[
			"pullAll ['abc']",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]] },
			{ $pullAll: { v: ["abc"] } },
			null,
			[[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, ["abc"]],
		],
		[
			"pull bare 7",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]] },
			{ $pull: { v: 7 } },
			null,
			[[7, 8], 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]],
		],
		[
			"pull bare 'abc'",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]] },
			{ $pull: { v: "abc" } },
			null,
			[[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, ["abc"]],
		],
		[
			"pull bare null",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]] },
			{ $pull: { v: null } },
			null,
			[[7, 8], 7, 5, "7", [5], [null], { a: 7 }, "abc", ["abc"]],
		],
		[
			"pull bare [7,8]",
			{ v: [[7, 8], 7, 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]] },
			{ $pull: { v: [7, 8] } },
			null,
			[7, 5, "7", [5], null, [null], { a: 7 }, "abc", ["abc"]],
		],
		[
			"positional $pull $eq 7",
			{ v: [{ t: [[7, 8], 7, 5, null, [null]] }, { t: [7] }, {}] },
			{ $pull: { "v.$[].t": { $eq: 7 } } },
			null,
			[{ t: [5, null, [null]] }, { t: [] }, {}],
		],
		[
			"positional $pull $ne 7",
			{ v: [{ t: [[7, 8], 7, 5, null, [null]] }, { t: [7] }, {}] },
			{ $pull: { "v.$[].t": { $ne: 7 } } },
			null,
			[{ t: [[7, 8], 7] }, { t: [7] }, {}],
		],
		[
			"positional $pull $in [7]",
			{ v: [{ t: [[7, 8], 7, 5, null, [null]] }, { t: [7] }, {}] },
			{ $pull: { "v.$[].t": { $in: [7] } } },
			null,
			[{ t: [5, null, [null]] }, { t: [] }, {}],
		],
		[
			"positional $pull $nin [7]",
			{ v: [{ t: [[7, 8], 7, 5, null, [null]] }, { t: [7] }, {}] },
			{ $pull: { "v.$[].t": { $nin: [7] } } },
			null,
			[{ t: [[7, 8], 7] }, { t: [7] }, {}],
		],
		[
			"positional $pull $eq null",
			{ v: [{ t: [[7, 8], 7, 5, null, [null]] }, { t: [7] }, {}] },
			{ $pull: { "v.$[].t": { $eq: null } } },
			null,
			[{ t: [[7, 8], 7, 5] }, { t: [7] }, {}],
		],
		[
			"positional $pull sub-doc",
			{ v: [{ t: [{ a: [1, 2] }, { a: 1 }, { a: 3 }] }] },
			{ $pull: { "v.$[].t": { a: 1 } } },
			null,
			[{ t: [{ a: 3 }] }],
		],
	];

	for (const [label, doc, update, options, expected] of CASES) {
		test(label, async () => {
			expect(await run(doc, update, options)).toEqual(expected);
		});
	}

	test("it reaches every way of running an update", async () => {
		await docs.insertMany([
			{ k: "a", v: [[7, 8], 7, 5] },
			{ k: "b", v: [7, [5]] },
		]);
		const result = await docs.updateMany({}, {
			$pull: { v: { $eq: 7 } },
		} as never);
		expect(result.modifiedCount).toBe(2);
		expect((await docs.findOne({ k: "a" }))?.v).toEqual([5]);
		expect((await docs.findOne({ k: "b" }))?.v).toEqual([[5]]);

		const updated = await docs.findOneAndUpdate(
			{ k: "b" },
			{ $pull: { v: { $ne: 5 } } } as never,
			{ returnDocument: "after" },
		);
		expect(updated?.v).toEqual([[5]]);
	});

	test("a regular expression as the condition is refused, not matched against nothing", async () => {
		await docs.insertOne({ k: "a", v: ["abc", "xyz"] });
		await expect(
			(async () =>
				docs.updateOne({ k: "a" }, { $pull: { v: /^a/ } } as never))(),
		).rejects.toThrow(MongoCompatibilityError);
		expect((await docs.findOne({ k: "a" }))?.v).toEqual(["abc", "xyz"]);
	});

	test("an operator it has no translation for is refused, and nothing is changed", async () => {
		await docs.insertOne({ k: "a", v: ["abc", "xyz"] });
		await expect(
			(async () =>
				docs.updateOne({ k: "a" }, {
					$pull: { v: { $regex: "^a" } },
				} as never))(),
		).rejects.toThrow("Unsupported operator in $pull condition: $regex");
		expect((await docs.findOne({ k: "a" }))?.v).toEqual(["abc", "xyz"]);
	});
});

// ---------------------------------------------------------------------------
// ORDERING OPERATORS IN $pull AND arrayFilters
// ---------------------------------------------------------------------------

describe("ordering operators in $pull and arrayFilters match within one BSON type", () => {
	// A `$pull` condition and an `arrayFilters` entry are query predicates applied
	// to an array element, so they bracket by type as a filter's do. As a bare `>`
	// they removed the string "x" for `{$pull: {v: {$gt: 5}}}`, because SurrealQL
	// ranks every string above every number. What a real `mongod` leaves in the
	// array is what each case below expects, and
	// `tests/e2e/scenarios/crud-scenarios.ts` checks them against one.

	interface ArrayDoc {
		[key: string]: unknown;
		_id?: ObjectId | string | number;
		k: string;
		v?: unknown;
	}

	let docs: Collection<ArrayDoc>;

	beforeEach(async () => {
		docs = ctx.db.collection<ArrayDoc>("array_ranges");
		try {
			await docs.deleteMany({});
		} catch {
			// ignore
		}
	});

	const MIXED = [
		1,
		10,
		"x",
		null,
		true,
		20,
		7.5,
		new Date(5000),
		[7, 8],
		{ a: 9 },
	];

	const afterUpdate = async (
		v: unknown,
		update: Record<string, unknown>,
		options?: Record<string, unknown>,
	) => {
		// Each call starts clean: a test may make several, and `findOne` would
		// otherwise hand back the first document it left behind.
		await docs.deleteMany({});
		await docs.insertOne({ k: "a", v });
		await docs.updateOne({ k: "a" }, update as never, options as never);
		return (await docs.findOne({ k: "a" }))?.v;
	};

	const pulled = (v: unknown, condition: Record<string, unknown>) =>
		afterUpdate(v, { $pull: { v: condition } });

	describe("$pull of an element", () => {
		const CASES: [string, Record<string, unknown>, unknown[]][] = [
			["$gt 5", { $gt: 5 }, [1, "x", null, true, new Date(5000), { a: 9 }]],
			[
				"$gte 10",
				{ $gte: 10 },
				[1, "x", null, true, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				"$lt 5",
				{ $lt: 5 },
				[10, "x", null, true, 20, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				"$lte 1",
				{ $lte: 1 },
				[10, "x", null, true, 20, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				'$gt "a"',
				{ $gt: "a" },
				[1, 10, null, true, 20, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				'$lt "z"',
				{ $lt: "z" },
				[1, 10, null, true, 20, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				"$gte true",
				{ $gte: true },
				[1, 10, "x", null, 20, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				"$lte true",
				{ $lte: true },
				[1, 10, "x", null, 20, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				"$gt Date(1)",
				{ $gt: new Date(1) },
				[1, 10, "x", null, true, 20, 7.5, [7, 8], { a: 9 }],
			],
			[
				"$lt Date(9999)",
				{ $lt: new Date(9999) },
				[1, 10, "x", null, true, 20, 7.5, [7, 8], { a: 9 }],
			],
			[
				"$gt null",
				{ $gt: null },
				[1, 10, "x", null, true, 20, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				"$gte null",
				{ $gte: null },
				[1, 10, "x", true, 20, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				"$lt null",
				{ $lt: null },
				[1, 10, "x", null, true, 20, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				"$lte null",
				{ $lte: null },
				[1, 10, "x", true, 20, 7.5, new Date(5000), [7, 8], { a: 9 }],
			],
			[
				"$gt 5 $lt 15",
				{ $gt: 5, $lt: 15 },
				[1, "x", null, true, 20, new Date(5000), { a: 9 }],
			],
		];

		for (const [label, condition, expected] of CASES) {
			test(label, async () => {
				expect(await pulled(MIXED, condition)).toEqual(expected);
			});
		}

		test("an element that is an array matches when any of its elements does", async () => {
			expect(await pulled([[7, 8], [1], 6], { $gt: 5 })).toEqual([[1]]);
			expect(await pulled([[7, 8], [1], 6], { $lt: 5 })).toEqual([[7, 8], 6]);
		});

		test("a NaN element is in no range, and equals a NaN operand", async () => {
			const withNaN = () => [1, Number.NaN, 7, "x"];
			expect(await pulled(withNaN(), { $gte: Number.NaN })).toEqual([
				1,
				7,
				"x",
			]);
			expect(await pulled(withNaN(), { $gt: 5 })).toEqual([1, Number.NaN, "x"]);
			expect(await pulled(withNaN(), { $lt: 5 })).toEqual([Number.NaN, 7, "x"]);
			expect(await pulled(withNaN(), { $gt: Number.NaN })).toEqual(withNaN());
		});

		test("an ObjectId is its own bracket", async () => {
			const oid = (hex: string) => new ObjectId(hex);
			const v = [
				oid("000000000000000000000001"),
				oid("000000000000000000000005"),
				"000000000000000000000009",
				5,
			];
			const hexes = (list: unknown) =>
				(list as unknown[]).map((item) =>
					item instanceof ObjectId ? item.toHexString() : item,
				);
			expect(
				hexes(await pulled(v, { $gt: oid("000000000000000000000001") })),
			).toEqual(["000000000000000000000001", "000000000000000000000009", 5]);
			expect(
				hexes(await pulled(v, { $lte: oid("000000000000000000000005") })),
			).toEqual(["000000000000000000000009", 5]);
		});

		test("a missing array is left missing", async () => {
			await docs.insertOne({ k: "a" });
			await docs.updateOne({ k: "a" }, { $pull: { v: { $gt: 5 } } } as never);
			expect((await docs.findOne({ k: "a" }))?.v).toBeUndefined();
		});

		test("an array or an embedded document operand is refused, and nothing is changed", async () => {
			await docs.insertOne({ k: "a", v: [1, 10] });
			await expect(
				(async () =>
					docs.updateOne({ k: "a" }, {
						$pull: { v: { $gt: [1] } },
					} as never))(),
			).rejects.toThrow(MongoCompatibilityError);
			await expect(
				(async () =>
					docs.updateOne({ k: "a" }, {
						$pull: { v: { $lt: { a: 1 } } },
					} as never))(),
			).rejects.toThrow("$lt with an embedded document operand");
			expect((await docs.findOne({ k: "a" }))?.v).toEqual([1, 10]);
		});
	});

	describe("$pull of a sub-document by a condition on one of its fields", () => {
		const DOCS = [
			{ p: 1 },
			{ p: 9 },
			{ p: "9" },
			{ p: [1, 9] },
			{ p: [1, 2] },
			{ q: 1 },
			{ p: null },
			{ p: true },
		];
		const CASES: [string, Record<string, unknown>, unknown[]][] = [
			[
				"p $gt 5",
				{ p: { $gt: 5 } },
				[
					{ p: 1 },
					{ p: "9" },
					{ p: [1, 2] },
					{ q: 1 },
					{ p: null },
					{ p: true },
				],
			],
			[
				"p $lt 5",
				{ p: { $lt: 5 } },
				[{ p: 9 }, { p: "9" }, { q: 1 }, { p: null }, { p: true }],
			],
			[
				'p $gt "5"',
				{ p: { $gt: "5" } },
				[
					{ p: 1 },
					{ p: 9 },
					{ p: [1, 9] },
					{ p: [1, 2] },
					{ q: 1 },
					{ p: null },
					{ p: true },
				],
			],
			[
				"p $gte null",
				{ p: { $gte: null } },
				[
					{ p: 1 },
					{ p: 9 },
					{ p: "9" },
					{ p: [1, 9] },
					{ p: [1, 2] },
					{ p: true },
				],
			],
			[
				"p $lte 1",
				{ p: { $lte: 1 } },
				[{ p: 9 }, { p: "9" }, { q: 1 }, { p: null }, { p: true }],
			],
			[
				"p $gt 0 $lt 3",
				{ p: { $gt: 0, $lt: 3 } },
				[{ p: 9 }, { p: "9" }, { q: 1 }, { p: null }, { p: true }],
			],
		];

		for (const [label, condition, expected] of CASES) {
			test(label, async () => {
				expect(await pulled(DOCS, condition)).toEqual(expected);
			});
		}
	});

	describe("arrayFilters on a field of the element", () => {
		const SCORES = [
			{ score: 95 },
			{ score: 50 },
			{ score: "90" },
			{ score: null },
			{ x: 1 },
			{ score: [95, 10] },
			{ score: [5, 6] },
			{ score: true },
			{ score: new Date(5000) },
		];
		const CASES: [string, Record<string, unknown>, unknown[]][] = [
			[
				"$gte 90",
				{ $gte: 90 },
				[
					{ flag: true, score: 95 },
					{ score: 50 },
					{ score: "90" },
					{ score: null },
					{ x: 1 },
					{ flag: true, score: [95, 10] },
					{ score: [5, 6] },
					{ score: true },
					{ score: new Date(5000) },
				],
			],
			[
				"$gt 5",
				{ $gt: 5 },
				[
					{ flag: true, score: 95 },
					{ flag: true, score: 50 },
					{ score: "90" },
					{ score: null },
					{ x: 1 },
					{ flag: true, score: [95, 10] },
					{ flag: true, score: [5, 6] },
					{ score: true },
					{ score: new Date(5000) },
				],
			],
			[
				"$lt 60",
				{ $lt: 60 },
				[
					{ score: 95 },
					{ flag: true, score: 50 },
					{ score: "90" },
					{ score: null },
					{ x: 1 },
					{ flag: true, score: [95, 10] },
					{ flag: true, score: [5, 6] },
					{ score: true },
					{ score: new Date(5000) },
				],
			],
			[
				"$lte 5",
				{ $lte: 5 },
				[
					{ score: 95 },
					{ score: 50 },
					{ score: "90" },
					{ score: null },
					{ x: 1 },
					{ score: [95, 10] },
					{ flag: true, score: [5, 6] },
					{ score: true },
					{ score: new Date(5000) },
				],
			],
			[
				'$gt "8"',
				{ $gt: "8" },
				[
					{ score: 95 },
					{ score: 50 },
					{ flag: true, score: "90" },
					{ score: null },
					{ x: 1 },
					{ score: [95, 10] },
					{ score: [5, 6] },
					{ score: true },
					{ score: new Date(5000) },
				],
			],
			[
				"$gte true",
				{ $gte: true },
				[
					{ score: 95 },
					{ score: 50 },
					{ score: "90" },
					{ score: null },
					{ x: 1 },
					{ score: [95, 10] },
					{ score: [5, 6] },
					{ flag: true, score: true },
					{ score: new Date(5000) },
				],
			],
			[
				"$gt Date(1)",
				{ $gt: new Date(1) },
				[
					{ score: 95 },
					{ score: 50 },
					{ score: "90" },
					{ score: null },
					{ x: 1 },
					{ score: [95, 10] },
					{ score: [5, 6] },
					{ score: true },
					{ flag: true, score: new Date(5000) },
				],
			],
			[
				"$gte null",
				{ $gte: null },
				[
					{ score: 95 },
					{ score: 50 },
					{ score: "90" },
					{ flag: true, score: null },
					{ flag: true, x: 1 },
					{ score: [95, 10] },
					{ score: [5, 6] },
					{ score: true },
					{ score: new Date(5000) },
				],
			],
			[
				"$lte null",
				{ $lte: null },
				[
					{ score: 95 },
					{ score: 50 },
					{ score: "90" },
					{ flag: true, score: null },
					{ flag: true, x: 1 },
					{ score: [95, 10] },
					{ score: [5, 6] },
					{ score: true },
					{ score: new Date(5000) },
				],
			],
			[
				"$gt null",
				{ $gt: null },
				[
					{ score: 95 },
					{ score: 50 },
					{ score: "90" },
					{ score: null },
					{ x: 1 },
					{ score: [95, 10] },
					{ score: [5, 6] },
					{ score: true },
					{ score: new Date(5000) },
				],
			],
			[
				"$gte 50 $lt 96",
				{ $gte: 50, $lt: 96 },
				[
					{ flag: true, score: 95 },
					{ flag: true, score: 50 },
					{ score: "90" },
					{ score: null },
					{ x: 1 },
					{ flag: true, score: [95, 10] },
					{ score: [5, 6] },
					{ score: true },
					{ score: new Date(5000) },
				],
			],
		];

		for (const [label, condition, expected] of CASES) {
			test(`flags the elements whose score is ${label}`, async () => {
				expect(
					await afterUpdate(
						SCORES,
						{ $set: { "v.$[e].flag": true } },
						{ arrayFilters: [{ "e.score": condition }] },
					),
				).toEqual(expected);
			});
		}

		test("a nested path on the element, one of which is a scalar", async () => {
			const v = [{ a: { b: 1 } }, { a: { b: 9 } }, { a: { b: "1" } }, { a: 1 }];
			expect(
				await afterUpdate(
					v,
					{ $set: { "v.$[e].flag": true } },
					{ arrayFilters: [{ "e.a.b": { $lt: 5 } }] },
				),
			).toEqual([
				{ a: { b: 1 }, flag: true },
				{ a: { b: 9 } },
				{ a: { b: "1" } },
				{ a: 1 },
			]);
		});

		test("an array or an embedded document operand is refused, and nothing is changed", async () => {
			await docs.insertOne({ k: "a", v: [{ score: 1 }] });
			await expect(
				(async () =>
					docs.updateOne(
						{ k: "a" },
						{ $set: { "v.$[e].flag": true } } as never,
						{
							arrayFilters: [{ "e.score": { $gt: [1] } }],
						},
					))(),
			).rejects.toThrow(MongoCompatibilityError);
			expect((await docs.findOne({ k: "a" }))?.v).toEqual([{ score: 1 }]);
		});
	});

	describe("every way of running an update reads them the same way", () => {
		const MIXED = [1, 10, "x", null, true, 20];

		test("updateMany", async () => {
			await docs.insertMany([
				{ k: "a", v: MIXED },
				{ k: "b", v: [3, "y", 8] },
			]);
			const result = await docs.updateMany({}, {
				$pull: { v: { $gt: 5 } },
			} as never);
			expect(result.modifiedCount).toBe(2);
			expect((await docs.findOne({ k: "a" }))?.v).toEqual([1, "x", null, true]);
			expect((await docs.findOne({ k: "b" }))?.v).toEqual([3, "y"]);
		});

		test("findOneAndUpdate, with a pull and with arrayFilters", async () => {
			await docs.insertOne({ k: "a", v: MIXED });
			const pulled = await docs.findOneAndUpdate(
				{ k: "a" },
				{ $pull: { v: { $lt: 5 } } } as never,
				{ returnDocument: "after" },
			);
			expect(pulled?.v).toEqual([10, "x", null, true, 20]);

			await docs.deleteMany({});
			await docs.insertOne({
				k: "b",
				v: [{ score: 95 }, { score: "90" }, { score: 50 }],
			});
			const flagged = await docs.findOneAndUpdate(
				{ k: "b" },
				{ $set: { "v.$[e].flag": true } } as never,
				{
					arrayFilters: [{ "e.score": { $gte: 90 } }],
					returnDocument: "after",
				},
			);
			expect(flagged?.v).toEqual([
				{ score: 95, flag: true },
				{ score: "90" },
				{ score: 50 },
			]);
		});

		test("bulkWrite", async () => {
			await docs.insertOne({ k: "a", v: MIXED });
			await docs.bulkWrite([
				{
					updateOne: {
						filter: { k: "a" },
						update: { $pull: { v: { $gte: 10 } } } as never,
					},
				},
			]);
			expect((await docs.findOne({ k: "a" }))?.v).toEqual([1, "x", null, true]);
		});

		test("an upsert that inserts", async () => {
			const result = await docs.updateOne(
				{ k: "new" },
				{ $pull: { v: { $gt: 5 } }, $set: { seen: true } } as never,
				{ upsert: true },
			);
			expect(result.upsertedCount).toBe(1);
			expect((await docs.findOne({ k: "new" }))?.seen).toBe(true);
		});
	});

	describe("the other operators of the same vocabulary are unchanged", () => {
		test("$pull with $eq, $ne, $in and $nin", async () => {
			expect(await pulled(MIXED, { $eq: 7.5 })).toEqual(
				MIXED.filter((x) => x !== 7.5),
			);
			expect(await pulled([1, 2, 3], { $ne: 1 })).toEqual([1]);
			expect(await pulled([1, 2, 3], { $in: [1, 3] })).toEqual([2]);
			expect(await pulled([1, 2, 3], { $nin: [1, 3] })).toEqual([1, 3]);
		});
	});
});

// ---------------------------------------------------------------------------
// $mul
// ---------------------------------------------------------------------------

describe("$mul", () => {
	test("multiplies a numeric field", async () => {
		await col.insertOne({ name: "Alice", age: 30, score: 10 });
		await col.updateOne({ name: "Alice" }, { $mul: { score: 3 } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.score).toBe(30);
	});

	test("multiplies by decimal", async () => {
		await col.insertOne({ name: "Alice", age: 30, value: 100 });
		await col.updateOne({ name: "Alice" }, { $mul: { value: 0.5 } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.value).toBe(50);
	});

	test("multiplies by zero", async () => {
		await col.insertOne({ name: "Alice", age: 30, score: 42 });
		await col.updateOne({ name: "Alice" }, { $mul: { score: 0 } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.score).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// $min / $max
// ---------------------------------------------------------------------------

describe("$min", () => {
	test("updates field when new value is smaller", async () => {
		await col.insertOne({ name: "Alice", age: 30, score: 80 });
		await col.updateOne({ name: "Alice" }, { $min: { score: 60 } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.score).toBe(60);
	});

	test("does not update when existing value is already smaller", async () => {
		await col.insertOne({ name: "Alice", age: 30, score: 50 });
		await col.updateOne({ name: "Alice" }, { $min: { score: 80 } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.score).toBe(50);
	});
});

describe("$max", () => {
	test("updates field when new value is larger", async () => {
		await col.insertOne({ name: "Alice", age: 30, score: 80 });
		await col.updateOne({ name: "Alice" }, { $max: { score: 95 } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.score).toBe(95);
	});

	test("does not update when existing value is already larger", async () => {
		await col.insertOne({ name: "Alice", age: 30, score: 95 });
		await col.updateOne({ name: "Alice" }, { $max: { score: 80 } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.score).toBe(95);
	});
});

// ---------------------------------------------------------------------------
// $addToSet
// ---------------------------------------------------------------------------

describe("$addToSet", () => {
	test("adds value to array if not present", async () => {
		await col.insertOne({ name: "Alice", age: 30, tags: ["a", "b"] });
		await col.updateOne({ name: "Alice" }, { $addToSet: { tags: "c" } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.tags).toContain("c");
		expect(updated?.tags).toHaveLength(3);
	});

	test("does not duplicate existing value", async () => {
		await col.insertOne({ name: "Alice", age: 30, tags: ["a", "b", "c"] });
		await col.updateOne({ name: "Alice" }, { $addToSet: { tags: "b" } });
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.tags).toHaveLength(3);
	});
});

// ---------------------------------------------------------------------------
// $rename
// ---------------------------------------------------------------------------

describe("$rename", () => {
	test("renames a field", async () => {
		await col.insertOne({
			name: "Alice",
			age: 30,
			email: "alice@test.com",
		});
		await col.updateOne(
			{ name: "Alice" },
			{ $rename: { email: "contactEmail" } },
		);
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.email).toBeUndefined();
		expect((updated as Record<string, unknown>)?.contactEmail).toBe(
			"alice@test.com",
		);
	});
});

// ---------------------------------------------------------------------------
// $currentDate
// ---------------------------------------------------------------------------

describe("$currentDate", () => {
	test("sets field to current timestamp", async () => {
		await col.insertOne({ name: "Alice", age: 30 });
		await col.updateOne(
			{ name: "Alice" },
			{ $currentDate: { updatedAt: true } },
		);
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.updatedAt).toBeDefined();
		// SurrealDB's time::now() returns a datetime object
		expect(updated?.updatedAt).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// $push with $sort modifier
// ---------------------------------------------------------------------------

describe("$push with $sort", () => {
	test("sorts array after push with $each and $sort ascending", async () => {
		await col.insertOne({ name: "Alice", age: 30, scores: [50, 30, 80] });
		await col.updateOne(
			{ name: "Alice" },
			{ $push: { scores: { $each: [10, 90], $sort: 1 } } },
		);
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.scores).toEqual([10, 30, 50, 80, 90]);
	});

	test("sorts array descending with $sort: -1", async () => {
		await col.insertOne({ name: "Alice", age: 30, scores: [50, 30, 80] });
		await col.updateOne(
			{ name: "Alice" },
			{ $push: { scores: { $each: [10, 90], $sort: -1 } } },
		);
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.scores).toEqual([90, 80, 50, 30, 10]);
	});
});

// ---------------------------------------------------------------------------
// $push with $position modifier
// ---------------------------------------------------------------------------

describe("$push with $position", () => {
	test("inserts elements at specified position", async () => {
		await col.insertOne({ name: "Alice", age: 30, tags: ["a", "d", "e"] });
		await col.updateOne(
			{ name: "Alice" },
			{ $push: { tags: { $each: ["b", "c"], $position: 1 } } },
		);
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.tags).toEqual(["a", "b", "c", "d", "e"]);
	});

	test("inserts at position 0 (beginning)", async () => {
		await col.insertOne({ name: "Alice", age: 30, tags: ["c", "d"] });
		await col.updateOne(
			{ name: "Alice" },
			{ $push: { tags: { $each: ["a", "b"], $position: 0 } } },
		);
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.tags).toEqual(["a", "b", "c", "d"]);
	});
});

// ---------------------------------------------------------------------------
// $push with combined modifiers ($each + $sort + $slice)
// ---------------------------------------------------------------------------

describe("$push with $each + $sort + $slice combined", () => {
	test("pushes, sorts, and slices in one operation", async () => {
		await col.insertOne({ name: "Alice", age: 30, scores: [70, 90, 50] });
		await col.updateOne(
			{ name: "Alice" },
			{
				$push: {
					scores: { $each: [80, 95, 60], $sort: -1, $slice: 4 },
				},
			},
		);
		const updated = await col.findOne({ name: "Alice" });
		// After concat: [70,90,50,80,95,60] → sort desc: [95,90,80,70,60,50] → slice first 4
		expect(updated?.scores).toEqual([95, 90, 80, 70]);
	});

	test("$slice with negative keeps last N", async () => {
		await col.insertOne({ name: "Alice", age: 30, scores: [10, 20] });
		await col.updateOne(
			{ name: "Alice" },
			{
				$push: {
					scores: { $each: [30, 40, 50], $slice: -3 },
				},
			},
		);
		const updated = await col.findOne({ name: "Alice" });
		// After concat: [10,20,30,40,50] → slice last 3
		expect(updated?.scores).toEqual([30, 40, 50]);
	});
});

// ---------------------------------------------------------------------------
// $setOnInsert (tested via upsert context in advanced-crud, but verify
// the clause generation here via updateMany with upsert)
// ---------------------------------------------------------------------------

describe("$setOnInsert", () => {
	test("sets fields only when upserting a new document", async () => {
		const result = await col.updateMany(
			{ name: "NewUser" },
			{
				$set: { name: "NewUser", age: 25 },
				$setOnInsert: { score: 100 },
			},
			{ upsert: true },
		);
		expect(result.upsertedCount).toBe(1);
		const doc = await col.findOne({ age: 25 });
		expect(doc).not.toBeNull();
		expect(doc?.age).toBe(25);
		// $setOnInsert uses ?? operator, so score should be set on the new doc
		expect(doc?.score).toBe(100);
	});
});

// ---------------------------------------------------------------------------
// Multiple operators in a single update
// ---------------------------------------------------------------------------

describe("combined update operators", () => {
	test("$set and $inc in one update", async () => {
		await col.insertOne({
			name: "Alice",
			age: 30,
			score: 80,
			active: false,
		} as TestDoc);
		await col.updateOne(
			{ name: "Alice" },
			{ $set: { active: true }, $inc: { score: 10 } },
		);
		const updated = await col.findOne({ name: "Alice" });
		expect((updated as Record<string, unknown>)?.active).toBe(true);
		expect(updated?.score).toBe(90);
	});

	test("$push and $set in one update", async () => {
		await col.insertOne({ name: "Alice", age: 30, tags: ["a"], score: 0 });
		await col.updateOne(
			{ name: "Alice" },
			{ $push: { tags: "b" }, $set: { score: 42 } },
		);
		const updated = await col.findOne({ name: "Alice" });
		expect(updated?.tags).toContain("b");
		expect(updated?.score).toBe(42);
	});
});
