import { afterEach, describe, expect, it, type Mock } from "vitest";

import { runFrontierScenario } from "./fixtures/phase-3f-b/frontier-reduction-fixture.js";
import {
	runSharedPlaneScenario,
	runTerminalOutcomeUnknownScenario,
} from "./fixtures/phase-3g/rebase-outbox-fixture.js";
import {
	issueFence,
	type OpenSettlementNode,
	openSettlementNode,
	recoverSettlementIssuedOutboxMismatch,
	routeSignedOperation,
	settlementPlan,
	writeSettlementPlan,
} from "./fixtures/phase-6b-d110c-0c1f5b0b/node-settlement-contract.js";

const activeNodes: OpenSettlementNode[] = [];

async function node(): Promise<OpenSettlementNode> {
	const opened = await openSettlementNode();
	activeNodes.push(opened);
	return opened;
}

afterEach(async () => {
	await Promise.all(activeNodes.splice(0).map((entry) => entry.close()));
});

describe("D.110c-0c1f5b0b rejected-GREEN corrective RED", () => {
	it("[RED] preserves legacy causalJoin reservation, sink delivery, and blueprint fold membership", async () => {
		const result = await runFrontierScenario(17, { stageAfterIssue: true });
		expect(result.result).toMatchObject({ kind: "accepted", ok: true });
		expect(result.admittedDigests).toEqual(result.issued.map(({ digest }) => digest));
		expect(result.stagedOutputs).toHaveLength(19);
		expect(result.stagedOutputs).toContain(null);
	});

	it("[control] preserves causalJoin ABI refusal on local generation and genuine signed ingress", async () => {
		for (const causalJoin of ["missing", "altered-abi"] as const) {
			const result = await runFrontierScenario(17, { causalJoin });
			expect(result.result).toMatchObject({ ok: false });
			expect(result.issued.some(({ operation }) => operation.action === "add")).toBe(false);
		}
		const opened = await openSettlementNode("creator-trusted-v1");
		activeNodes.push(opened);
		const routed = await routeSignedOperation(opened, Object.freeze({ action: "causalJoin" }), 1);
		expect(routed.claimed).toBe(true);
		expect(routed.journalRowsAfter).toBe(routed.journalRowsBefore);
		expect(opened.sink).not.toHaveBeenCalled();
	});

	it("[RED] preserves legacy join as an application-visible displaced operation", async () => {
		const result = await runSharedPlaneScenario({ sourceOperationProfile: "join" });
		expect(result.rebaseOutbox).toMatchObject({
			kind: "displaced",
			ok: true,
			source: {
				authorSequence: 1,
				intents: [
					expect.objectContaining({
						operation: { action: "join", clientId: "phase-3g-displaced-client" },
					}),
				],
			},
		});
	});

	it("[control] keeps settlement join control-only", async () => {
		const result = await runSharedPlaneScenario({ settlementProfile: true, sourceOperationProfile: "join" });
		expect(result.rebaseOutbox).toMatchObject({
			kind: "displaced",
			ok: true,
			source: { authorSequence: 1, intents: [] },
		});
	});

	it.each([
		["legacy pending", { leaveSourceBootstrapPending: true, settlementProfile: false }],
		["settlement published", { leaveSourceBootstrapPending: false, settlementProfile: true }],
	] as const)("[RED] surfaces an ordinary same-store non-creator sequence-zero row: %s", async (_label, scenario) => {
		const result = await runSharedPlaneScenario({ nonCreatorWriter: true, ...scenario });
		expect(result.rebaseOutbox).toMatchObject({
			kind: "displaced",
			ok: true,
			source: {
				authorSequence: 0,
				vertexDigest: result.sourceBootstrapDigest,
			},
		});
	});

	it("[control] excludes the creator bootstrap by its authenticated activation identity", async () => {
		const result = await runSharedPlaneScenario({ settlementProfile: true });
		expect(result.rebaseOutbox).toMatchObject({
			kind: "displaced",
			ok: true,
			source: {
				authorSequence: 1,
				vertexDigest: result.sourceDigest,
			},
		});
		expect(result.sourceDigest).not.toBe(result.sourceBootstrapDigest);
	});

	it("[RED] refuses a settlement issued/outbox mismatch with the existing corruption classification", async () => {
		const opened = await node();
		expect(await recoverSettlementIssuedOutboxMismatch(opened)).toEqual({
			detail: "v3 recovery issued record does not match",
			kind: "issuance-rejected",
			ok: false,
		});
	});

	it("[RED] latches terminal state when the terminal transaction outcome is unknown", async () => {
		const result = await runTerminalOutcomeUnknownScenario();
		expect(result.publishTerminal).toMatchObject({
			kind: "issuance-rejected",
			ok: false,
			terminalIntent: "outcome-unknown",
		});
		expect(result.resumeAfterUnknown).toMatchObject({ kind: "invalid-state", ok: false });
		expect(result.beginAfterUnknown).toMatchObject({ kind: "already-terminal", ok: false });
	});

	it.each([
		[
			"non-array entries",
			(plan: Readonly<Record<string, unknown>>): unknown => ({ ...plan, entries: Object.freeze({ length: 0 }) }),
		],
		[
			"throwing entries accessor",
			(plan: Readonly<Record<string, unknown>>): unknown => {
				const hostile = { ...plan } as Record<string, unknown>;
				Object.defineProperty(hostile, "entries", {
					enumerable: true,
					get: () => {
						throw new TypeError("controlled settlement plan accessor");
					},
				});
				return hostile;
			},
		],
		["top-level extra key", (plan: Readonly<Record<string, unknown>>): unknown => ({ ...plan, extra: true })],
	] as const)("[RED] returns a typed failure for a malformed durable settlement plan: %s", async (_label, mutate) => {
		const opened = await node();
		const valid = settlementPlan(opened.scope, { empty: true });
		await writeSettlementPlan(opened.issuanceStore, valid);
		(opened.issuanceStore.readSettlementPlan as Mock).mockResolvedValueOnce(mutate(valid));
		await expect(issueFence(opened)).resolves.toMatchObject({ kind: "issuance-rejected", ok: false });
		expect(opened.issuanceStore.transactIssue).not.toHaveBeenCalled();
	});
});
