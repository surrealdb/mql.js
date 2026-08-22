/**
 * The README's tables, checked against the code they describe.
 *
 * These exist because that pairing kept drifting, and every time it did the
 * README was the half that was wrong — which for a compatibility driver is the
 * half that matters, since the table *is* the answer to "does this work?".
 *
 * Three instances in two days, all the same shape: a stage shipped, and the list
 * naming it did not change. One was the refusal message (fixed by deriving it),
 * one was the sentence after the stages table, and one was a reason duplicated in
 * prose beside the table that carried it. Reviewing a diff does not catch this,
 * because nothing in the diff is wrong — the staleness is in a file the change
 * did not touch.
 *
 * So the lists are compared to their sources rather than to each other. Asserting
 * the README against a hand-written constant would only move the problem.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SUPPORTED_STAGES } from "../../src/translators/aggregate/index.ts";

const root = join(import.meta.dirname, "..", "..");
const readme = readFileSync(join(root, "README.md"), "utf8");

/** The `$name`s inside one markdown section, in order. */
function operatorsIn(section: string): string[] {
	return [...section.matchAll(/`(\$[a-zA-Z]+)`/g)].map((match) => match[1]);
}

/** A section of the README, from a heading to the next blank-line-delimited end. */
function section(from: string, to: string): string {
	const start = readme.indexOf(from);
	expect(start).toBeGreaterThan(-1);
	const end = readme.indexOf(to, start);
	expect(end).toBeGreaterThan(start);
	return readme.slice(start, end);
}

describe("the aggregation stages table", () => {
	test("names every stage the translator routes, and no others", () => {
		const table = section("### Stages", "Everything else");
		const documented = new Set(operatorsIn(table));

		for (const stage of SUPPORTED_STAGES) {
			expect([...documented]).toContain(stage);
		}
	});

	test("the 'everything else' list claims nothing that is implemented", () => {
		// The drift that shipped in 0.4.0 and survived 0.5.0: `$facet` and
		// `$graphLookup` were listed as raising, two lines under rows saying they
		// work.
		const refused = operatorsIn(
			section("Everything else — ", "raises `MongoCompatibilityError`"),
		);
		expect(refused.length).toBeGreaterThan(0);
		for (const stage of refused) {
			expect(SUPPORTED_STAGES).not.toContain(stage);
		}
	});
});

describe("the expression operators table", () => {
	test("names every operator the registry implements, and no others", () => {
		const source = readFileSync(
			join(root, "src", "translators", "aggregate", "expression.ts"),
			"utf8",
		);
		const implemented = [
			...source.matchAll(
				/(?:name: "|call\("|fixedArity\("|variadicInfix\(")(\$[a-zA-Z]+)"/g,
			),
		].map((match) => match[1]);

		const table = section(
			"| Group | Operators |",
			"An operator not in that table",
		);
		// `$$NOW` is a system variable rather than an operator, and is named in the
		// same table; the pattern reads it as `$NOW`, so it is excluded by name.
		const documented = operatorsIn(table).filter((name) => name !== "$NOW");

		expect(implemented.length).toBeGreaterThan(40);
		expect([...new Set(documented)].sort()).toEqual(
			[...new Set(implemented)].sort(),
		);
	});
});

describe("the not-implemented table", () => {
	test("names every method that refuses, and no others", () => {
		// Read from the sources rather than by calling: a refusal is raised at the
		// call, so enumerating them by invocation would need a client per method.
		const refusing = new Set<string>();
		const files = [
			join(root, "src", "collection", "collection.ts"),
			join(root, "src", "db", "db.ts"),
			join(root, "src", "client", "mongo-client.ts"),
		];
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(
				/unsupported\(\s*"([A-Za-z]+\.[a-zA-Z]+)\(\)"/g,
			)) {
				refusing.add(match[1]);
			}
		}

		const table = section(
			"**Thirteen methods** raise",
			"Two more surfaces raise",
		);
		const documented = new Set(
			[...table.matchAll(/`([A-Za-z]+\.)?([a-zA-Z]+)\(\)`/g)].map(
				(match) => match[2],
			),
		);

		expect(refusing.size).toBe(13);
		for (const method of refusing) {
			expect([...documented]).toContain(method.split(".")[1]);
		}
	});

	test("says how many there are, and is right", () => {
		// The count is the thing a reader trusts without checking, so it is the thing
		// most worth pinning.
		expect(readme).toContain("**Thirteen methods** raise");
	});
});
