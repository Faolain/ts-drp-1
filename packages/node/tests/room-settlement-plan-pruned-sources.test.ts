import { readFileSync } from "node:fs";
import ts from "typescript";
import { encodeCanonical } from "@ts-drp/canonical";
import { settlementSourceContextsForEntries } from "@ts-drp/issuance-store";
import { describe, expect, it } from "vitest";

// Track X, decision row 60 (R5, piece 2): the room's merged settlement plan carries prior entries
// that the current rebase scan no longer meets, so their intent/source/replacement link survives
// a new operational anchor. Once authenticated pruning has removed a COMPLETED local entry's own
// source, the merge drops that entry: carrying it would name retired work, which the store refuses
// on every later plan write. Every other entry stays: an incomplete one, one whose source is not
// pruned, a manual-review, inherited or migrated one, and one the current scan still meets.
// This executes the two private production closures of createV3RoomSessionOwned on data.
const path = new URL("../src/v3-room.ts", import.meta.url);
const source = readFileSync(path, "utf8");
const parsed = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true);
function closure(name: string): string {
	const found: ts.VariableDeclaration[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found.push(node);
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	if (found.length !== 1 || found[0]!.initializer === undefined)
		throw Error(`PRIVATE_CLOSURE_NOT_UNIQUE:${name}:${found.length}`);
	return `const ${name} = ${found[0]!.initializer.getText(parsed)};`;
}
const code = ["mergedSettlementPlan", "completedSettlementSourcesPruned"].map(closure).join("\n");

const scope = { objectId: "room", author: "ee".repeat(32) };
const digest = (sequence: number): Uint8Array => new Uint8Array(32).fill(sequence);
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => Buffer.compare(left, right) === 0;
type Entry = Readonly<Record<string, unknown>> & { readonly sourceSequence: number };
const entry = (sourceSequence: number, fields: Record<string, unknown> = {}): Entry =>
	Object.freeze({
		disposition: "rebase",
		replacementSequence: sourceSequence + 100,
		sourceDigest: digest(sourceSequence),
		sourceSequence,
		...fields,
	});

async function merge(entries: readonly Entry[], pruned: ReadonlySet<number>, scan: readonly number[] = []) {
	const reads: number[] = [];
	const context = {
		settlementScope: scope,
		sourceMaterial: undefined,
		migrationInviteAuthority: () => {
			throw Error("no migration in this room");
		},
		settlementDisposition: () => "rebase",
		bytes: (value: Uint8Array) => value,
		sameBytes,
		encodeCanonical,
		sameSettlementEntry: (left: Entry, right: Entry) => left === right,
		// 34b08cd7: the merge carries each retained entry's exact source contexts.
		settlementSourceContextsForEntries,
		issuanceStore: {
			readIssued: async (at: unknown, sequence: number) => {
				expect(at).toBe(scope);
				reads.push(sequence);
				return pruned.has(sequence) ? null : { authorSequence: sequence };
			},
		},
	};
	const js = ts.transpileModule(
		`${code}
		(async () => {
			const current = data.current;
			const sources = data.scan;
			const dropped = await completedSettlementSourcesPruned(current, sources);
			return { dropped, plan: mergedSettlementPlan(sources, current, new Map(), dropped)(undefined, undefined) };
		})();`,
		{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
	).outputText;
	const current = Object.freeze({ entries: Object.freeze([...entries]), fenceSequence: null, revision: 4, scope });
	const sources = scan.map((sequence) => ({ authorSequence: sequence, intents: [], vertexDigest: digest(sequence) }));
	const result = (await Function(
		...Object.keys(context),
		"data",
		`"use strict";return eval(${JSON.stringify(js)});`
	)(...Object.values(context), { current, scan: sources })) as {
		dropped: ReadonlySet<number>;
		plan: { entries: readonly Entry[]; revision: number };
	};
	return { ...result, reads, current };
}

describe("R5: the merged settlement plan drops only completed local entries whose source is pruned", () => {
	it("drops a completed entry once its source reads as pruned, and keeps it while it does not", async () => {
		const dropped = await merge([entry(1), entry(2)], new Set([1]));
		expect([...dropped.dropped]).toEqual([1]);
		expect(dropped.plan.entries.map((row) => row.sourceSequence)).toEqual([2]);
		expect(dropped.plan.revision).toBe(5);
		const kept = await merge([entry(1), entry(2)], new Set());
		expect([...kept.dropped]).toEqual([]);
		// Nothing changed: the merge returns the durable plan itself.
		expect(kept.plan).toBe(kept.current);
	});

	it("keeps an incomplete entry even when its source reads as pruned, without reading it", async () => {
		const { dropped, plan, reads } = await merge([entry(3, { replacementSequence: null })], new Set([3]));
		expect([...dropped]).toEqual([]);
		expect(plan.entries.map((row) => row.sourceSequence)).toEqual([3]);
		expect(reads).toEqual([]);
	});

	it("keeps manual-review, inherited and migrated entries, and one the current scan still meets", async () => {
		const entries = [
			entry(4, { disposition: "manual-review", replacementSequence: null }),
			entry(5, { disposition: "inherited", inheritance: { kind: "target" }, replacementSequence: null }),
			entry(6, { sourceObjectId: "source-room" }),
			entry(7),
		];
		const { dropped, plan, reads } = await merge(entries, new Set([4, 5, 6, 7]), [7]);
		expect([...dropped]).toEqual([]);
		expect(plan.entries.map((row) => row.sourceSequence)).toEqual([4, 5, 6, 7]);
		expect(reads).toEqual([]);
	});

	it("drops an expired entry once its source reads as pruned (the store counts it complete)", async () => {
		const { dropped, plan } = await merge(
			[entry(8, { disposition: "expire", replacementSequence: null })],
			new Set([8])
		);
		expect([...dropped]).toEqual([8]);
		expect(plan.entries).toEqual([]);
	});
});
