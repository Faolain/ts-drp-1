import { readFileSync } from "node:fs";
import ts from "typescript";
import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { normalizeSettlementSourceAuthorities, settlementSourceContextsForEntries } from "@ts-drp/issuance-store";
import { describe, expect, it } from "vitest";

// cand/int7-c3 browser gate m71 r2 (2026-11-21): a member's install threw "v3 room settlement plan
// source differs" (mergedSettlementPlan) and every later install refused its kept moves with it.
//
// The settlement window resolves a displaced own row as expired once its move's origin is
// V3_SETTLEMENT_OWN_WINDOW_EPOCHS old (settlementWindowExpired). The origin is read through the plan's
// replacement links back from the displaced row, and a link whose source row is already retired
// counts as expired. Each merge recomputes it. But the evidence it reads is not durable: once the
// expiry ends the chain, its older link's source row is retired and that completed entry is pruned
// (completedSettlementSourcesPruned, decision row 60 R5). The next merge then meets the expired row
// with no link, reads the origin as the row's own (younger) epoch, finds the window not expired, and
// derives `rebase` for an entry the plan already holds as `expire`. The merge refuses that as a
// changed source. The gap needs a chain whose links are two or more epochs apart, which a skip
// install or a rule R deferral (the replacement waits for the next install) produces.
//
// A window expiry is terminal: its move was given back to the application in that same write (durable
// hand-back records), and `expire` is never replayed. So a merge keeps a prior `expire` whatever the
// window reads now. This runs the production closures of createV3RoomSessionOwned on data, in the
// order writeMergedSettlementPlan runs them.
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
const code = ["settlementWindowExpired", "completedSettlementSourcesPruned", "mergedSettlementPlan"]
	.map(closure)
	.join("\n");

const WINDOW = 4; // V3_SETTLEMENT_OWN_WINDOW_EPOCHS
const scope = { objectId: "room", author: "ee".repeat(32) };
const digest = (sequence: number): Uint8Array => new Uint8Array(32).fill(sequence);
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => Buffer.compare(left, right) === 0;
type Entry = Readonly<Record<string, unknown>> & {
	readonly sourceSequence: number;
	readonly disposition: string;
	readonly replacementSequence: number | null;
};
type Plan = Readonly<{ entries: readonly Entry[]; revision: number; fenceSequence: null; scope: typeof scope }>;
const entry = (sourceSequence: number, fields: Record<string, unknown> = {}): Entry =>
	Object.freeze({
		disposition: "rebase",
		replacementSequence: null,
		sourceDigest: digest(sourceSequence),
		sourceSequence,
		...fields,
	}) as Entry;

/**
 * One drain's merge (writeMergedSettlementPlan's order): the window, the pruned completed entries,
 * then the merged plan. A row the window resolves for the first time would also get its hand-back
 * records in that write; they are not what this test is about, so none are written.
 */
async function merge(
	current: Plan,
	active: number,
	rows: ReadonlyMap<number, number>,
	scan: readonly number[]
): Promise<Readonly<{ plan: Plan; windowExpired: readonly number[] }>> {
	const issued = (sequence: number): unknown => {
		const epoch = rows.get(sequence);
		return epoch === undefined
			? null
			: { authorSequence: sequence, envelope: { canonicalPreimageBytes: encodeCanonical({ epoch, logicalTime: sequence }) } };
	};
	const context = {
		activeHandle: { epoch: active },
		V3_SETTLEMENT_OWN_WINDOW_EPOCHS: WINDOW,
		settlementScope: scope,
		sourceMaterial: undefined,
		migrationInviteAuthority: () => {
			throw Error("no migration in this room");
		},
		settlementDisposition: (displaced: { intents: readonly unknown[] }) =>
			displaced.intents.length === 0 ? undefined : "rebase",
		bytes: (value: Uint8Array) => value,
		sameBytes,
		encodeCanonical,
		decodeCanonical,
		sameSettlementEntry: (left: Entry, right: Entry) => left === right,
		settlementSourceContextsForEntries,
		normalizeSettlementSourceAuthorities,
		issuanceStore: { readIssued: async (_scope: unknown, sequence: number) => issued(sequence) },
	};
	const js = ts.transpileModule(
		`${code}
		(async () => {
			const current = data.current;
			const sources = data.sources;
			const windowExpired = await settlementWindowExpired(current, sources);
			const pruned = await completedSettlementSourcesPruned(current, sources);
			const plan = mergedSettlementPlan(sources, current, new Map(), pruned, windowExpired, {
				handBacks: undefined,
				reissueOrigins: undefined,
			})(undefined, undefined);
			return { plan, windowExpired: [...windowExpired] };
		})();`,
		{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
	).outputText;
	// The displaced rows of the rebase scan: frontier-displaced own moves, one intent each.
	const sources = scan.map((sequence) => ({
		authorSequence: sequence,
		epoch: rows.get(sequence),
		frontierDisplaced: true,
		intents: [{ logicalTime: sequence, operation: { action: "place", at: sequence }, operationCount: 1, operationIndex: 0 }],
		vertexDigest: digest(sequence),
	}));
	return (await Function(
		...Object.keys(context),
		"data",
		`"use strict";return eval(${JSON.stringify(js)});`
	)(...Object.values(context), { current, sources })) as { plan: Plan; windowExpired: readonly number[] };
}

describe("settlement window: an expiry the plan holds is terminal (cand/int7-c3 source differs)", () => {
	it("keeps a chain-aged expiry after the chain's older link is retired and pruned", async () => {
		// Move M: row 7 signed at epoch 6, displaced; its replacement row 16 signed at epoch 9 (the
		// replacement waited two installs: a skip install, or rule R deferring it), displaced as well.
		const plan0: Plan = Object.freeze({
			entries: Object.freeze([entry(7, { replacementSequence: 16 }), entry(16)]),
			fenceSequence: null,
			revision: 10,
			scope,
		});
		const rows = new Map([
			[7, 6],
			[16, 9],
		]);
		// Install at epoch 10: the chain's origin (epoch 6) is WINDOW old, so row 16 is expired.
		const first = await merge(plan0, 10, rows, [16]);
		expect(first.windowExpired).toEqual([16]);
		expect(first.plan.entries.map((row) => `${row.sourceSequence}:${row.disposition}`)).toEqual(["7:rebase", "16:expire"]);
		// The chain ended, so row 7 is no longer protected and is retired. At the next install the
		// window still reads it (a retired link counts as expired) and the completed entry 7 is pruned.
		rows.delete(7);
		const second = await merge(first.plan, 11, rows, [16]);
		expect(second.plan.entries.map((row) => `${row.sourceSequence}:${row.disposition}`)).toEqual(["16:expire"]);
		// Install at epoch 12: row 16 (epoch 9) is still displaced and unretired, and its link is gone. The
		// expiry stays: the move was given back when it expired and is never replayed.
		const third = await merge(second.plan, 12, rows, [16]);
		expect(third.plan.entries.map((row) => `${row.sourceSequence}:${row.disposition}:${String(row.replacementSequence)}`)).toEqual([
			"16:expire:null",
		]);
		// And again at a later install, until the row itself is retired.
		const fourth = await merge(third.plan, 13, rows, [16]);
		expect(fourth.plan.entries.map((row) => `${row.sourceSequence}:${row.disposition}`)).toEqual(["16:expire"]);
	});

	it("still refuses a prior entry whose source row changed", async () => {
		const plan0: Plan = Object.freeze({
			entries: Object.freeze([entry(16, { disposition: "expire", sourceDigest: digest(99) })]),
			fenceSequence: null,
			revision: 3,
			scope,
		});
		await expect(merge(plan0, 12, new Map([[16, 9]]), [16])).rejects.toThrow("v3 room settlement plan source differs");
	});

	it("never turns an unexpired replacement decision into anything but the window's expiry", async () => {
		// A young displaced row keeps its rebase decision (no expiry yet), and is replaced later.
		const plan0: Plan = Object.freeze({ entries: Object.freeze([entry(20)]), fenceSequence: null, revision: 1, scope });
		const merged = await merge(plan0, 12, new Map([[20, 11]]), [20]);
		expect(merged.windowExpired).toEqual([]);
		expect(merged.plan.entries.map((row) => `${row.sourceSequence}:${row.disposition}`)).toEqual(["20:rebase"]);
	});
});
