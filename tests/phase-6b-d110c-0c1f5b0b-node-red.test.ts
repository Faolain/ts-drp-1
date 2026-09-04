import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { afterEach, describe, expect, it, type Mock } from "vitest";

import { runSharedPlaneScenario } from "./fixtures/phase-3g/rebase-outbox-fixture.js";
import {
	auditNodeSettlementSource,
	issueFence,
	issueReplacement,
	type OpenSettlementNode,
	openSettlementNode,
	reopenSettlementNode,
	routeSignedOperation,
	runDurableFenceRestart,
	settlementPlan,
	writeSettlementPlan,
} from "./fixtures/phase-6b-d110c-0c1f5b0b/node-settlement-contract.js";
import { inspectCreatorAuthorSettlementAdvance } from "../packages/node/src/internal/creator-transition-advance.js";
import { openCanonicalLatchedAclSnapshot } from "../packages/protocol-v3/src/latched-acl.js";

const AUTHOR = "1".repeat(64);
const OBJECT_ID = `creator:${"a".repeat(32)}`;
const activeNodes: OpenSettlementNode[] = [];

function acl(epoch: number): Readonly<Record<string, unknown>> {
	return Object.freeze({
		epoch,
		kind: "drp-v3-latched-acl",
		members: Object.freeze([
			Object.freeze({ author: AUTHOR, finalityKey: null, groups: Object.freeze(["admin", "writer"]) }),
		]),
		objectId: OBJECT_ID,
		permissionless: false,
		version: 3,
	});
}

function adjacentAdvanceInput(): Readonly<Record<string, unknown>> {
	return Object.freeze({
		currentAcl: acl(2),
		predecessor: Object.freeze({
			candidateDigest: "a".repeat(64),
			closedEpoch: 1,
			frontiers: Object.freeze([Object.freeze([AUTHOR, 0, 7])]),
			successorEpoch: 2,
		}),
		proposed: Object.freeze({
			closedEpoch: 2,
			frontiers: Object.freeze([Object.freeze([AUTHOR, 0, 8])]),
			priorCheckpointDigest: "a".repeat(64),
			priorCheckpointKind: "settled-v1",
			successorEpoch: 3,
		}),
		successorAcl: acl(3),
	});
}

async function node(
	profile: "creator-trusted-settlement-v1" | "creator-trusted-v1" = "creator-trusted-settlement-v1"
): Promise<OpenSettlementNode> {
	const opened = await openSettlementNode(profile);
	activeNodes.push(opened);
	return opened;
}

afterEach(async () => {
	await Promise.all(activeNodes.splice(0).map((entry) => entry.close()));
});

describe("D.110c-0c1f5b0b Node settlement RED", () => {
	it("[control] pins settlement-v3 ACL as required from genesis while legacy retains v1", () => {
		const settlementBytes = encodeCanonical(acl(0));
		const settlementDigest = Buffer.from(hashDomain("ts-drp/latched-acl/v3", settlementBytes)).toString("hex");
		expect(
			openCanonicalLatchedAclSnapshot({
				exactCanonicalLatchedAclBytes: settlementBytes,
				expectedAclDigest: settlementDigest,
				expectedEpoch: 0,
				expectedObjectId: OBJECT_ID,
				expectedProfileId: "creator-trusted-settlement-v1",
			})
		).toMatchObject({ ok: true, snapshot: { version: 3 } });
		const legacy = { ...acl(0), version: 1 };
		const legacyBytes = encodeCanonical(legacy);
		expect(
			openCanonicalLatchedAclSnapshot({
				exactCanonicalLatchedAclBytes: legacyBytes,
				expectedAclDigest: Buffer.from(hashDomain("ts-drp/latched-acl/v3", legacyBytes)).toString("hex"),
				expectedEpoch: 0,
				expectedObjectId: OBJECT_ID,
				expectedProfileId: "creator-trusted-v1",
			})
		).toMatchObject({ ok: true, snapshot: { version: 1 } });
	});

	it("[control] accepts an adjacent settled predecessor above epoch zero and rejects a gap", () => {
		const input = adjacentAdvanceInput();
		expect(inspectCreatorAuthorSettlementAdvance(input)).toEqual({ ok: true });
		expect(
			inspectCreatorAuthorSettlementAdvance({
				...input,
				predecessor: { ...(input.predecessor as object), closedEpoch: 0, successorEpoch: 1 },
			})
		).toEqual({ ok: false, reason: "SETTLEMENT_ADVANCE_INVALID" });
	});

	it.each([
		[
			"top-level extra key",
			(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => ({ ...input, extra: true }),
		],
		[
			"ACL member extra key",
			(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => ({
				...input,
				currentAcl: {
					...(input.currentAcl as Record<string, unknown>),
					members: [{ ...((input.currentAcl as { members: readonly object[] }).members[0] as object), extra: true }],
				},
			}),
		],
		[
			"accessor-backed ACL",
			(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
				const hostile = Object.create(Object.prototype) as Record<string, unknown>;
				Object.defineProperty(hostile, "currentAcl", {
					enumerable: true,
					get: () => input.currentAcl,
				});
				Object.assign(hostile, {
					predecessor: input.predecessor,
					proposed: input.proposed,
					successorAcl: input.successorAcl,
				});
				return hostile;
			},
		],
	] as const)("[RED] rejects non-exact Node settlement frontier/ACL input: %s", (_label, mutate) => {
		expect(inspectCreatorAuthorSettlementAdvance(mutate(adjacentAdvanceInput()))).toEqual({
			ok: false,
			reason: "SETTLEMENT_ADVANCE_SHAPE_INVALID",
		});
	});

	it.each([
		["missing", undefined],
		["manual-review", "manual-review"],
		["fence-already-set", "fence-already-set"],
	] as const)("[RED] refuses fence causally from durable plan state: %s", async (_label, state) => {
		const opened = await node();
		if (state === "manual-review") {
			await writeSettlementPlan(opened.issuanceStore, settlementPlan(opened.scope, { disposition: state }));
		} else if (state === "fence-already-set") {
			await writeSettlementPlan(opened.issuanceStore, settlementPlan(opened.scope, { fenceSequence: 7 }));
		}
		const result = await issueFence(opened);
		expect(result).toMatchObject({ ok: false });
		expect(opened.issuanceStore.readSettlementPlan).toHaveBeenCalledWith(opened.scope);
		expect(opened.issuanceStore.transactIssue).not.toHaveBeenCalled();
	});

	it("[RED] issues the fence first and atomically links the complete durable plan", async () => {
		const opened = await node();
		await writeSettlementPlan(opened.issuanceStore, settlementPlan(opened.scope, { empty: true }));
		const result = await issueFence(opened);
		expect(result, "D110C_0C1F5B0B_DEDICATED_FENCE_ISSUER_REQUIRED").toMatchObject({
			authorSequence: 1,
			ok: true,
		});
		if (!result.ok) return;
		const durable = await opened.issuanceStore.readIssued(opened.scope, 1);
		expect(durable?.planEffect).toEqual({ kind: "fence" });
		expect(await opened.issuanceStore.readSettlementPlan(opened.scope)).toMatchObject({
			fenceSequence: 1,
			revision: 1,
		});
	});

	it("[RED] reopens SQLite issuance+journal truth and replays exactly one linked pending fence", async () => {
		const result = await runDurableFenceRestart();
		expect(result.firstIssue, "D110C_0C1F5B0B_FENCE_RESTART_PRECONDITION").toMatchObject({ ok: true });
		if (!result.firstIssue.ok) return;
		expect(result).toMatchObject({
			fenceSequence: result.firstIssue.authorSequence,
			lineageNext: 2,
			pendingFenceCount: 1,
			replayedFence: true,
		});
	});

	it("[RED] links one replacement exactly once across same-epoch retry and restart", async () => {
		const opened = await node();
		await writeSettlementPlan(opened.issuanceStore, settlementPlan(opened.scope));
		const fenced = await issueFence(opened);
		expect(fenced, "D110C_0C1F5B0B_REPLACEMENT_FENCE_PRECONDITION").toMatchObject({ ok: true });
		if (!fenced.ok) return;
		const replacement = await issueReplacement(opened);
		expect(replacement).toMatchObject({ authorSequence: 2, ok: true });
		if (!replacement.ok) return;
		expect(await opened.issuanceStore.readSettlementPlan(opened.scope)).toMatchObject({
			entries: [expect.objectContaining({ replacementSequence: 2, sourceSequence: 10 })],
		});
		expect(await issueReplacement(opened, 10, 4)).toMatchObject({ ok: false });
		const restarted = await reopenSettlementNode(opened);
		try {
			expect(await opened.issuanceStore.readLineage(opened.scope)).toEqual({ exhausted: false, next: 3 });
		} finally {
			restarted.deactivate();
		}
	});

	it("[RED] halts after outcome-unknown and reopens to the atomic row+link or neither", async () => {
		const opened = await node();
		await writeSettlementPlan(opened.issuanceStore, settlementPlan(opened.scope));
		const transaction = opened.issuanceStore.transactIssue as Mock;
		const implementation = transaction.getMockImplementation();
		if (implementation === undefined) throw new TypeError("fixture transaction implementation is unavailable");
		transaction.mockImplementationOnce(async (...args: unknown[]) => {
			await implementation(...args);
			throw Object.assign(new Error("controlled ambiguous commit"), { code: "ISSUANCE_OUTCOME_UNKNOWN" });
		});
		const uncertain = await issueFence(opened);
		expect(uncertain).toMatchObject({ kind: "issuance-rejected", ok: false });
		if (transaction.mock.calls.length === 0) return;
		const transactionsAfterUnknown = transaction.mock.calls.length;
		expect(await issueFence(opened, 3)).toMatchObject({ ok: false });
		expect(transaction).toHaveBeenCalledTimes(transactionsAfterUnknown);
		const planAfterUnknown = await opened.issuanceStore.readSettlementPlan(opened.scope);
		const rowAfterUnknown = await opened.issuanceStore.readIssued(opened.scope, 1);
		expect([planAfterUnknown?.fenceSequence, rowAfterUnknown?.authorSequence]).toEqual([1, 1]);
		const restarted = await reopenSettlementNode(opened);
		restarted.deactivate();
	});

	it("[RED] makes completeRebaseSource unreachable under settlement while keeping the callable legacy seam", async () => {
		const opened = await node();
		const readIssued = opened.issuanceStore.readIssued;
		const result = await opened.plane.completeRebaseSource({ authorSequence: 0, digest: "0".repeat(64) });
		expect(result).toEqual({
			detail: "v3 displaced source completion is unavailable under settlement",
			kind: "not-active",
			ok: false,
		});
		expect(readIssued).not.toHaveBeenCalled();
	});

	it("[control] keeps creator-trusted-v1 fence issuance rejected before plan or issuance work", async () => {
		const opened = await node("creator-trusted-v1");
		expect(await issueFence(opened)).toEqual({
			detail: "v3 local issue operation is unknown",
			kind: "malformed-input",
			ok: false,
		});
		expect(opened.issuanceStore.readSettlementPlan).not.toHaveBeenCalled();
		expect(opened.issuanceStore.transactIssue).not.toHaveBeenCalled();
	});

	it("[RED] rejects a genuine legacy-profile fence at ingress without journaling it", async () => {
		const opened = await node("creator-trusted-v1");
		const routed = await routeSignedOperation(
			opened,
			{ action: "$drp.author-fence.v1", fenceSequence: 1, version: 1 },
			1
		);
		expect(routed.claimed).toBe(true);
		expect(routed.journalRowsAfter).toBe(routed.journalRowsBefore);
		expect(opened.sink).not.toHaveBeenCalled();
	});

	it("[control] admits a huge valid settlement fence, rejects m > f, and never calls the application sink", async () => {
		const opened = await node();
		const valid = await routeSignedOperation(
			opened,
			{ action: "$drp.author-fence.v1", fenceSequence: 20, version: 1 },
			20
		);
		const invalid = await routeSignedOperation(
			opened,
			{ action: "$drp.author-fence.v1", fenceSequence: 22, version: 1 },
			21,
			4
		);
		expect(valid.journalRowsAfter).toBe(valid.journalRowsBefore + 1);
		expect(invalid.journalRowsAfter).toBe(invalid.journalRowsBefore);
		expect(opened.sink).not.toHaveBeenCalled();
		const staged = await opened.blueprint.stageBlueprintEpoch();
		expect(staged).toMatchObject({ ok: true, outputs: [1] });
	});

	it("[control] uses the current anchor as admission authority for stale same-key ingress", async () => {
		const opened = await node();
		const current = await routeSignedOperation(opened, { action: "add", value: 9 }, 1);
		const stale = await routeSignedOperation(opened, { action: "add", value: 10 }, 2, 4, "f".repeat(64));
		expect(current.journalRowsAfter).toBe(current.journalRowsBefore + 1);
		expect(stale.journalRowsAfter).toBe(stale.journalRowsBefore);
		expect(opened.sink).toHaveBeenCalledTimes(1);
	});

	it("[RED] surfaces a published same-key displaced row under settlement", async () => {
		const result = await runSharedPlaneScenario({ publishSourceBeforeClose: true, settlementProfile: true });
		expect(result.recovery).toMatchObject({ ok: true });
		expect(result.rebaseOutbox).toMatchObject({
			kind: "displaced",
			ok: true,
			source: { authorSequence: 1, vertexDigest: result.sourceDigest },
		});
	});

	it("[control] classifies signed same-key cross-anchor causalJoin without application intents", async () => {
		const result = await runSharedPlaneScenario({ settlementProfile: true, sourceOperationProfile: "structural" });
		expect(result.sourceAnchor).not.toBe(result.targetAnchor);
		expect(result.sourceContextAuthor).toBe(result.targetAuthor);
		expect(result.rebaseOutbox).toMatchObject({
			kind: "displaced",
			ok: true,
			source: { authorSequence: 1, intents: [] },
		});
	});

	it("[RED] classifies signed same-key cross-anchor join without application intents", async () => {
		const result = await runSharedPlaneScenario({ settlementProfile: true, sourceOperationProfile: "join" });
		expect(result.sourceAnchor).not.toBe(result.targetAnchor);
		expect(result.sourceContextAuthor).toBe(result.targetAuthor);
		expect(result.rebaseOutbox).toMatchObject({
			kind: "displaced",
			ok: true,
			source: { authorSequence: 1, intents: [] },
		});
	});

	it("[RED] surfaces a displaced ACL source before fence issuance", async () => {
		const result = await runSharedPlaneScenario({ settlementProfile: true, sourceOperationProfile: "acl" });
		expect(result.rebaseOutbox).toMatchObject({
			kind: "displaced",
			ok: true,
			source: {
				authorSequence: 1,
				intents: [expect.objectContaining({ operation: expect.objectContaining({ action: "acl" }) })],
			},
		});
	});

	it.each([
		["dedicated fence transaction + planEffect", "dedicatedFencePlanEffect"],
		["anchor-agnostic any-older-epoch/old-incarnation classification", "anchorAgnosticOlderEpochClassification"],
		["all own source rows regardless publication state", "settlementReaderOwnRows"],
		["settlement-only completion gate", "settlementCompletionProfileGate"],
		["complete close graph and application/control split", "applicationControlSplit"],
		["legacy-profile fence admission guard", "legacyFenceAdmissionGuard"],
	] as const)("[RED] Node owner materializes %s", (_label, key) => {
		expect(auditNodeSettlementSource()[key], `D110C_0C1F5B0B_${key}`).toBe(true);
	});
});
