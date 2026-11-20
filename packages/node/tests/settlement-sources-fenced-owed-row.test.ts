import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// fix/browser-rollover-member-stall: box run m35 of the chain RED at fa69364a (install 1 failed "v3 room
// settlement source is unavailable", then the member stopped one epoch behind).
//
// A drain issues the author fence of its epoch before its replacements: fenceSequence = the lineage's next,
// so the fence sits above every displaced row. Rule R then defers replacements (a newer offer is queued,
// or the chunk is stopped mid-signing), so a displaced row the plan still owes a replacement stays below
// that fence. Once the creator admits the fence, its signed frontier puts the boundary at fence - 1: the
// row's class becomes "terminal". The settlement scan (readRebaseOutbox) skips terminal rows unless the
// plan still has open work on them (openProgressSources: a split replacement or a retained source), so
// the next install's drain finds an eligible entry without its source and fails the install.
//
// A row the plan still owes a replacement (rebase or transform, not replaced) is open work exactly as a
// split one is. Its epoch closed without it (it was classified displaced when the entry was written), and
// the fence admitted later does not make it admittable; it only declares the author's slots below it
// settled, which the replacement (issued above the fence) does. Before R the same state followed a crash
// between the fence and the replacements, then a received install.
const path = new URL("../src/v3-live.ts", import.meta.url);
const source = readFileSync(path, "utf8");
const parsed = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true);
function declaration(name: string): string {
	const found: ts.FunctionDeclaration[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node);
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	const [only] = found;
	if (found.length !== 1 || only === undefined) throw Error(`PRIVATE_FUNCTION_NOT_UNIQUE:${name}:${found.length}`);
	return only.getText(parsed);
}

type Entry = Readonly<Record<string, unknown>>;
let scanned: ReadonlySet<number> | undefined;
const context = {
	ObjectFreeze: Object.freeze,
	copySettlementPlan: (plan: unknown): unknown => plan,
	readRebaseOutbox: (
		_registration: unknown,
		_published: boolean,
		_frontier: unknown,
		open?: ReadonlySet<number>
	): Promise<unknown> => {
		scanned = open;
		return Promise.resolve({ ok: true, kind: "empty" });
	},
};
const functions = Function(
	...Object.keys(context),
	`"use strict";${
		ts.transpileModule(declaration("readSettlementSources"), {
			compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
		}).outputText
	}return { readSettlementSources };`
)(...Object.values(context)) as {
	readSettlementSources(registration: unknown, frontier: unknown): Promise<unknown>;
};

const entry = (sourceSequence: number, extra: Entry = {}): Entry => ({
	sourceSequence,
	sourceDigest: Uint8Array.of(sourceSequence),
	disposition: "rebase",
	replacementSequence: null,
	...extra,
});
async function open(entries: readonly Entry[]): Promise<number[]> {
	scanned = undefined;
	const registration = {
		issuanceScope: { objectId: "room", author: "writer" },
		issuanceStore: { readSettlementPlan: (): Promise<unknown> => Promise.resolve({ entries }) },
	};
	await functions.readSettlementSources(registration, { admissionEpoch: 0, currentEpoch: 4, terminalThrough: 10 });
	return [...(scanned ?? [])].sort((left, right) => left - right);
}

describe("the settlement scan keeps the source of every row the plan still owes a replacement", () => {
	it("a deferred row below the author's own fence stays open work", async () => {
		// 9 and 10: deferred rebase/transform rows (the creator's frontier now calls them terminal).
		expect(await open([entry(9), entry(10, { disposition: "transform" })])).toEqual([9, 10]);
		// A recorded admission refusal is still owed its (original-operation) replacement.
		expect(
			await open([
				entry(9, { disposition: "transform", transformRefusal: { proposedIntentDigest: new Uint8Array(32) } }),
			])
		).toEqual([9]);
	});

	it("keeps the existing open work and nothing settled", async () => {
		expect(
			await open([
				entry(3, { replacementProgress: { chunks: [], intentCount: 2, intentDigest: new Uint8Array(32), version: 1 } }),
				entry(4, { disposition: "manual-review", sourceContextDigest: new Uint8Array(32) }),
				entry(5, { replacementSequence: 12 }),
				entry(6, { disposition: "expire" }),
				entry(7, { disposition: "committed" }),
				entry(8, { disposition: "inherited" }),
				entry(11, { disposition: "manual-review" }),
			])
		).toEqual([3, 4]);
	});
});
