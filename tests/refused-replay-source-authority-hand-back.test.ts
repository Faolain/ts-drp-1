import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { createEphemeralDurableIssuanceStore } from "../packages/issuance-store/src/conformance.js";
import {
	normalizeSettlementSourceAuthorities,
	SETTLEMENT_SOURCE_AUTHORITY_DOMAIN,
	settlementHandBacksAtOrigin,
} from "../packages/issuance-store/src/contract.js";
import type { SettlementPlan } from "../packages/issuance-store/src/types.js";

// cand/int7-c3 merge of fix/browser-rollover-member-stall: int7's refused-replay hand-back (decision
// row 97) composed with the branch's settlement source-authority records (rule R, cold reopen).
//
// A row rule R defers past an install stays an owed plan entry (unreplaced rebase/transform), and the
// merge that added it named it in its source epoch's authority record, so a later install (or a member
// that reopens cold) can still replace it. When that later replay is refused by the Writer's own
// admission (the room's application state limit, the policy, a persisting transient refusal), the room
// hands the move back: ONE plan write turns the entry into `expire` + `handedBack` with its hand-back
// records. The entry is then no longer owed, and the store's law (copySettlementSourceAuthorities)
// accepts a record only while every source it names is owed: the hand-back write must narrow the record
// in that same write (normalizeSettlementSourceAuthorities), as every replacing or give-back write does.
// Written with the prior plan's record unchanged, the store refuses the hand-back as an invalid plan:
// the install fails and the room stops at that epoch for good.
//
// This executes the production closure `handBackRefusedReplay` (packages/node/src/v3-room.ts) on the
// real memory issuance store; the room around it (its install, drain and admission) is the premise.
const path = new URL("../packages/node/src/v3-room.ts", import.meta.url);
const source = readFileSync(path, "utf8");
const parsed = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true);
function closure(name: string): string {
	const found: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer !== undefined)
			found.push(node.initializer.getText(parsed));
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	if (found.length !== 1) throw Error(`PRIVATE_CLOSURE_NOT_UNIQUE:${name}:${found.length}`);
	return found[0]!;
}
const code = `const handBackRefusedReplay = ${closure("handBackRefusedReplay")};`;

const SCOPE = Object.freeze({ author: "author:refused-replay-authority", objectId: "room:refused-replay-authority" });
const digestOf = (sequence: number): Uint8Array => new Uint8Array(32).fill(sequence);
const record = (sourceEpoch: number, sources: readonly number[]) => {
	const bytes = new Uint8Array(512).fill(sourceEpoch);
	return Object.freeze({
		digest: hashDomain(SETTLEMENT_SOURCE_AUTHORITY_DOMAIN, bytes),
		exactCanonicalAuthorityBytes: bytes,
		sourceEpoch,
		sources: Object.freeze([...sources]),
	});
};
const entry = (sourceSequence: number, disposition = "rebase") =>
	Object.freeze({ disposition, replacementSequence: null, sourceDigest: digestOf(sourceSequence), sourceSequence });
const move = (sequence: number) => ({ action: "placeBlock", id: `move-${sequence}`, x: sequence, y: 1 });

type Harness = Readonly<{
	store: ReturnType<typeof createEphemeralDurableIssuanceStore>;
	handBack: (source: unknown, fromIntent: number, reason: string) => Promise<void>;
	deferred: () => number;
}>;
function harness(): Harness {
	const store = createEphemeralDurableIssuanceStore();
	const context = {
		issuanceStore: store,
		settlementScope: SCOPE,
		sameBytes: (left: Uint8Array, right: Uint8Array): boolean => Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0,
		bytes: (value: Uint8Array): Uint8Array => new Uint8Array(value),
		encodeCanonical,
		settlementHandBacksAtOrigin,
		normalizeSettlementSourceAuthorities,
		refreshHandBackListing: async (): Promise<void> => {},
	};
	const made = Function(
		...Object.keys(context),
		`"use strict"; let windowDeferredMoves = 0;${
			ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
		} return { handBackRefusedReplay, deferred: () => windowDeferredMoves };`
	)(...Object.values(context)) as { handBackRefusedReplay: Harness["handBack"]; deferred: () => number };
	return { store, handBack: made.handBackRefusedReplay, deferred: made.deferred };
}
const displaced = (sequence: number, epoch: number) =>
	Object.freeze({ authorSequence: sequence, vertexDigest: digestOf(sequence), epoch, intents: [{ operation: move(sequence) }] });
async function seed(store: Harness["store"], records: readonly unknown[] | undefined): Promise<void> {
	await store.transactWriteSettlementPlan({
		expectedRevision: null,
		scope: SCOPE,
		plan: {
			entries: [entry(1), entry(2, "transform"), entry(3)],
			fenceSequence: null,
			...(records === undefined ? {} : { sourceAuthorities: records }),
			revision: 0,
			scope: SCOPE,
		},
	});
}
const sources = (plan: SettlementPlan | null) =>
	(plan?.sourceAuthorities ?? []).map((value) => ({ epoch: value.sourceEpoch, sources: [...value.sources] }));

describe("a refused replay's hand-back of a row a source-authority record names (int7 row 97 x rule R records)", () => {
	it("control: with no source-authority record the hand-back writes as before", async () => {
		const { store, handBack, deferred } = harness();
		await seed(store, undefined);
		await handBack(displaced(1, 2), 0, "application-state-limit");
		const plan = await store.readSettlementPlan(SCOPE);
		expect(plan?.entries.find((value) => value.sourceSequence === 1)).toMatchObject({
			disposition: "expire",
			handedBack: { fromIntent: 0, reason: "application-state-limit" },
		});
		expect(plan?.handBacks?.map((value) => [value.sourceSequence, value.intent])).toEqual([[1, 0]]);
		expect(deferred()).toBe(0);
	});

	it("narrows the record to the rows still owed, in the hand-back write itself", async () => {
		const { store, handBack } = harness();
		await seed(store, [record(2, [1, 2]), record(3, [3])]);
		await handBack(displaced(1, 2), 0, "application-state-limit");
		const plan = await store.readSettlementPlan(SCOPE);
		expect(plan?.revision).toBe(1);
		expect(plan?.entries.find((value) => value.sourceSequence === 1)).toMatchObject({ disposition: "expire" });
		expect(plan?.handBacks?.map((value) => [value.sourceSequence, value.intent])).toEqual([[1, 0]]);
		// Row 2 is still owed and keeps epoch 2's authority; epoch 3's record is untouched.
		expect(sources(plan)).toEqual([
			{ epoch: 2, sources: [2] },
			{ epoch: 3, sources: [3] },
		]);
	});

	it("drops a record with its last owed row, and the field with the last record", async () => {
		const { store, handBack } = harness();
		await seed(store, [record(3, [3])]);
		await handBack(displaced(3, 3), 0, "admission-rejected");
		const plan = await store.readSettlementPlan(SCOPE);
		expect(plan?.entries.find((value) => value.sourceSequence === 3)).toMatchObject({
			disposition: "expire",
			handedBack: { fromIntent: 0, reason: "admission-rejected" },
		});
		expect(plan !== null && Object.hasOwn(plan, "sourceAuthorities")).toBe(false);
	});
});
