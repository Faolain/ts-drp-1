import { describe, expect, it } from "vitest";

import {
	runCrossObjectActivationScenario,
	runRetainedBootstrapHoldScenario,
	runTerminalCommitScenario,
	runTerminalPreEffectScenario,
	runTerminalSinkDispositionScenarios,
} from "./fixtures/phase-3g/rebase-outbox-fixture.js";

describe("Phase 3h-b node-owned terminal transition RED", () => {
	it("reserves the genuine live-plane gate through one handle-bound capability", async () => {
		const result = await runTerminalCommitScenario();
		expect(result.begun).toMatchObject({ ok: true });
		expect(result.begunWhileActive).toMatchObject({ kind: "transition-active", ok: false });
		expect(result.beginSettledBeforeEarlierSinkRelease).toBe(false);
		expect(result.earlierIssue).toMatchObject({ kind: "accepted", ok: true });
		expect(result.forgedReceiverPublish).toMatchObject({ kind: "rejected" });
		expect(result.forgedReceiverIssuanceDelta).toBe(0);
		expect(result.forgedReceiverResume).toMatchObject({ kind: "invalid-state", ok: false });
		expect(result.forgedReceiverSignerCalls).toBe(0);
		expect(result.heldBeforeResume).toBe(true);
		expect(result.heldRemoteRouted).toBe(true);
		expect(result.heldRemoteProcessedBeforeResume).toBe(false);
		expect(result.laterIssueSignerCalls).toBe(1);
		expect(result.ordinaryTerminal).toMatchObject({ ok: false, terminalIntent: "absent" });
		expect(result.issuanceTransactionsAfterResume).toBe(result.issuanceTransactionsBeforeResume + 1);
		expect(result.laterIssue).toMatchObject({ kind: "accepted", ok: true });
		expect(result.resume).toMatchObject({ kind: "resumed", ok: true });
		expect(result.reusedResume).toMatchObject({ kind: "invalid-state", ok: false });
		expect(result.reusedPublish).toMatchObject({ ok: false });
		expect(result.malformedTerminal).toMatchObject({ ok: false, terminalIntent: "absent" });
		// Original D.93.55 requires recovery after possibly committed issuance;
		// signer rejection alone cannot prove native/cryptographic absence.
		expect(result.rejectedSignerTerminal).toMatchObject({ ok: false, terminalIntent: "outcome-unknown" });
		expect(result.rejectedSignerRecovery.resumeAfterRejectedSigner).toMatchObject({ok:false,kind:"invalid-state"});
		expect(result.rejectedSignerRecovery.warmBeginAfterRejectedSigner).toMatchObject({ok:false,kind:"already-terminal"});
		expect(result.rejectedSignerRecovery.coldRecovery).toMatchObject({ok:true});
		expect(result.rejectedSignerRecovery.coldBegin).toMatchObject({ok:true});
		expect(result.rejectedSignerRecovery.nativeImagePreservedAcrossCold).toBe(true);
		expect(result.rejectedSignerRecovery.sameIntentRetry).toMatchObject({ok:true,kind:"accepted",terminalIntent:"committed"});
		expect(result.rejectedSignerRecovery.signerCallsAfterRetry).toBe(2);
		expect(result.begunAgain).toMatchObject({ ok: true });
		expect(result.publishTerminal).toMatchObject({
			kind: "accepted",
			ok: true,
			terminalIntent: "committed",
		});
		expect(result.terminalHeldIssue).toMatchObject({
			kind: "resolved",
			value: { kind: "not-active", ok: false },
		});
		expect(result.issuanceTransactionsAfterTerminal).toBe(result.issuanceTransactionsAfterResume + 1);
		expect(result.terminalHeldSignerCalls).toBe(0);
		expect(result.issuedTerminalAction).toBe("migrationActivation");
		expect(result.admittedActions).toEqual(["message", "message", "message", "migrationActivation"]);
		expect(result.admittedClientOperationIds).toContain("phase-3h-held-remote");
		expect(result.admittedClientOperationIds).not.toContain("phase-3h-after-terminal-remote");
		expect(result.postTerminalRemoteRouted).toBe(true);
		expect(result.postTerminalRemoteProcessed).toBe(true);
		expect(result.journalRowCount).toBe(5);
		expect(result.publication).toMatchObject({ kind: "published", ok: true });
		expect(result.outboxPublishStates).toEqual(["published", "published", "published", "published"]);
		expect(result.publishedDigests).toHaveLength(3);
		expect(result.reopenedBegin).toMatchObject({ kind: "already-terminal", ok: false });

		const rejectedDispositions = await runTerminalSinkDispositionScenarios();
		expect(rejectedDispositions).toHaveLength(3);
		expect(rejectedDispositions.map(({ disposition }) => disposition).sort()).toEqual(["missing", "rejected", "throw"]);
		for (const rejected of rejectedDispositions) {
			expect(rejected.publication).toMatchObject({
				kind: "resolved",
				value: { kind: "terminal-rejected", ok: false, terminalIntent: "outcome-unknown" },
			});
			expect(rejected.laterIssue).toMatchObject({
				kind: "resolved",
				value: { kind: "not-active", ok: false },
			});
			expect(rejected.journalRowCount).toBe(2);
			expect(rejected.reopenedBegin).toMatchObject({ kind: "already-terminal", ok: false });
		}
	});

	it("captures stalled native completion identity and joins only duplicate queued source work", async () => {
		const result = await runCrossObjectActivationScenario(undefined,"stalled");
		expect(result.recovery).toMatchObject({ok:true});
		const value = result.stalledCompletion as {
			beforeRelease:{firstCutFlights:number;secondCutFlights:number;distinctCuts:boolean;sourceStates:{authorSequence:number;state:string}[]};
			firstCut:unknown[];secondCut:unknown[];wrong:unknown;afterSourceStates:{authorSequence:number;state:string}[];sourceSequence:number;
			reentrantCompletion:unknown;reenteredPublication:unknown;afterReentry:unknown[];
		};
		expect(value.beforeRelease).toMatchObject({firstCutFlights:1,secondCutFlights:1,distinctCuts:true,
			reentrantCompletionIsFresh:true,afterReentryFlights:1,afterReentryIsFresh:true});
		expect(value.beforeRelease.sourceStates.find(row=>row.authorSequence===value.sourceSequence)?.state).toBe("pending");
		expect(value.firstCut).toHaveLength(40);expect(value.secondCut).toHaveLength(40);
		for(const completed of [...value.firstCut,...value.secondCut,...value.afterReentry])expect(completed).toMatchObject({ok:true,kind:"published"});
		expect(value.reentrantCompletion).toMatchObject({ok:true,kind:"published"});
		expect(value.reenteredPublication).toMatchObject({ok:true,kind:"published"});
		expect(value.wrong).toMatchObject({ok:false,kind:"record-rejected"});
		expect(value.afterSourceStates.find(row=>row.authorSequence===value.sourceSequence)?.state).toBe("published");
		for(const prior of value.beforeRelease.sourceStates.filter(row=>row.authorSequence!==value.sourceSequence)) {
			expect(value.afterSourceStates.find(row=>row.authorSequence===prior.authorSequence)).toEqual(prior);
		}
		expect(result.targetReplacement).toMatchObject({ok:true,kind:"accepted"});
		expect(result.targetPublication).toMatchObject({ok:true,kind:"published"});
		expect(result.reopenRecovery).toMatchObject({ok:true});
	});
	it("enumerates pending and published source work across the authenticated activation cut", async () => {
		const result = await runCrossObjectActivationScenario();
		expect(result.recovery).toMatchObject({ ok: true });
		expect(result.sourceObjectId).not.toBe(result.targetObjectId);
		expect(result.sourceJournalRowCount).toBe(4);
		expect(result.rebaseOutboxes).toHaveLength(3);
		const sources = result.rebaseOutboxes
			.map((page) => Reflect.get(page as object, "source"))
			.filter((source) => source !== undefined);
		expect(sources.map((source) => Reflect.get(source as object, "vertexDigest"))).toEqual(result.sourceDigests);
		expect(sources.map((source) => Reflect.get(source as object, "publishState"))).toEqual(["published", "pending"]);
		expect(result.completion).toMatchObject({ kind: "published", ok: true });
		expect(result.targetReplacement).toMatchObject({ kind: "accepted", ok: true });
		expect(result.targetPublication).toMatchObject({ kind: "published", ok: true });
		expect(result.reopenRecovery).toMatchObject({ ok: true });
		expect(result.targetPublishedDigests).toEqual([Reflect.get(result.targetReplacement as object, "digest")]);
		expect(result.targetPublishedDigests).not.toContain(result.activationVertexDigest);
		for (const digest of result.sourceDigests) expect(result.targetPublishedDigests).not.toContain(digest);
	});

	it("rejects oversized and irreducible multi-tip activation before signer or store effects", async () => {
		const kinds = ["oversized", "multi-tip"] as const;
		const results = [];
		for (const kind of kinds) results.push(await runTerminalPreEffectScenario(kind));
		for (const [index, kind] of kinds.entries()) {
			const result = results[index];
			if (result === undefined) throw new TypeError("terminal pre-effect result is absent");
			expect(result.recovery).toMatchObject({ ok: true });
			expect(result.begun).toMatchObject({ ok: true });
			expect(result.publication).toMatchObject({
				kind: "graph-rejected",
				ok: false,
				terminalIntent: "absent",
			});
			expect(result.signerCalls).toBe(0);
			expect(result.issuanceTransactions).toBe(0);
			if (kind === "oversized") {
				expect(result.remainingEpochBytes).toBeLessThan(result.terminalCandidateByteCharge as number);
				expect(result.remainingEpochBytes).toBeGreaterThanOrEqual(0);
			}
		}
	});

	it("holds an empty redirected target until the authenticated migration prefix is retained", async () => {
		const result = await runRetainedBootstrapHoldScenario();
		expect(result.recovery).toMatchObject({ ok: true });
		expect(result.prePrefixIssue).toMatchObject({ ok: false });
		expect(result.prePrefixPublication).toMatchObject({ ok: false });
		expect(result.prePrefixRebase).toMatchObject({ ok: false });
		expect(result.routedPrefix).toEqual([true, true]);
		expect(result.admittedActions).toEqual(["message", "migrationRecord", "message"]);
		expect(result.postPrefixIssue).toMatchObject({ kind: "accepted", ok: true });

		for (const mutation of ["missing-activation", "unauthenticated-activation"] as const) {
			const rejected = await runRetainedBootstrapHoldScenario(mutation);
			expect(rejected.recovery).toMatchObject({ ok: false });
			expect(rejected.routedPrefix).toEqual([]);
			expect(rejected.postPrefixIssue).toBeUndefined();
		}
	});

	it("fails closed on wrong cross-object store, scope, target, or activation closure evidence", async () => {
		for (const mutation of ["activation-closure", "source-scope", "source-store", "target-scope"] as const) {
			const result = await runCrossObjectActivationScenario(mutation);
			expect(result.recovery).toMatchObject({ ok: false });
			expect(result.rebaseOutboxes).toEqual([]);
			expect(result.completion).toBeUndefined();
		}
	});
});
