import "fake-indexeddb/auto";
import { decodeCanonical } from "@ts-drp/canonical";
import { openCurrentAnchorTrust } from "@ts-drp/protocol-v3";
import { createCreatorSigningRecoveryOwner, resolveCreatorSigningRecoveryOwner } from "@ts-drp/seal/creator";
import { openBrowserSealEvidenceStore } from "@ts-drp/storage-browser/seal-evidence";
import { openBrowserSealVoteStore } from "@ts-drp/storage-browser/seal-vote";
import { openInternalSealVoteStore } from "../../storage-browser/src/internal/seal-vote-store.js";
import { describe, expect, it } from "vitest";
import { makeCreatorMaterial, makeTrustStateRecord } from "../../../tests/fixtures/phase-3a0-v3/controlled-anchor-trust.js";

async function custody() {
	const material = makeCreatorMaterial();
	const opened = openCurrentAnchorTrust({exactCanonicalTrustStateRecordBytes: makeTrustStateRecord(material),
		expectedObjectId: String(material.anchor.objectId), pinnedGenesisAnchorDigest: material.anchorDigest});
	if (!opened.ok) throw new Error(`genuine trust unavailable: ${opened.reason}`);
	const databaseName = `received-recovery-custody-${crypto.randomUUID()}`;
	const vote = await openBrowserSealVoteStore({databaseName});
	const evidence = await openBrowserSealEvidenceStore({databaseName});
	const input = {currentTrust: opened.trust, voteStore: vote.store, evidenceStore: evidence.store,
		storageIncarnation: vote.observation.incarnation};
	return {input, databaseName, close: async () => {await Promise.all([vote.close(), evidence.close()]);}};
}

describe("received recovery native signing custody", () => {
	it("uses genuine native stores without exposing a signing or close capability", async () => {
		const native = await custody();
		try {
			const opened = await createCreatorSigningRecoveryOwner(native.input);
			expect(opened.ok).toBe(true);
			if (!opened.ok) return;
			try {
				expect(Object.keys(opened.owner).sort()).toEqual(["acquireRecoveryDependencies", "captureRetirementOwners", "stop"]);
				const read = await opened.owner.acquireRecoveryDependencies([native.input.currentTrust]);
				try {
					// Even a never-signing recipient retains the actual native safety
					// metadata. Empty business rows are not an empty proof substitute.
					const rows = read.readExactCanonicalRows().map(bytes => decodeCanonical(bytes) as unknown[]);
					expect(rows.length).toBeGreaterThan(0);
					expect(rows.every(row => row[0] === "storageMeta")).toBe(true);
					await read.checkWhile(async () => undefined);
				} finally {await read.release();}
				const metadata = await opened.owner.captureRetirementOwners().acquireEvidence();
				try {await metadata.check();} finally {await metadata.release();}
			} finally {await opened.owner.stop();}
		} finally {await native.close();}
	});
	it("rejects copied trust and fabricated native evidence instead of supplying empty signing rows", async () => {
		const native = await custody();
		try {
			expect(await createCreatorSigningRecoveryOwner({...native.input, currentTrust: {...native.input.currentTrust}}))
				.toMatchObject({ok: false, reason: "UNTRUSTED_CURRENT_ANCHOR"});
			expect(await createCreatorSigningRecoveryOwner({...native.input, evidenceStore: {}}))
				.toMatchObject({ok: false, reason: "UNTRUSTED_EVIDENCE_STORE"});
			expect(await createCreatorSigningRecoveryOwner({...native.input, voteStore: {...native.input.voteStore}}))
				.toMatchObject({ok: false, reason: "UNTRUSTED_VOTE_STORE"});
		} finally {await native.close();}
	});
	it("preserves ordinary absent-address refusal and does not create rows during recovery capture", async () => {
		const native = await custody();
		const original = await openInternalSealVoteStore({databaseName: native.databaseName});
		try {
			const address = {objectId: native.input.currentTrust.objectId};
			await expect(original.acquireRetirementObservation(address)).rejects.toThrow("SIGNING_ADDRESS_ABSENT");
			const opened = await createCreatorSigningRecoveryOwner(native.input);
			expect(opened.ok).toBe(true);
			if (!opened.ok) return;
			try {
				const captured = await opened.owner.captureRetirementOwners().acquireVote();
				try {await captured.check();} finally {await captured.release();}
				await expect(original.acquireRetirementObservation(address)).rejects.toThrow("SIGNING_ADDRESS_ABSENT");
			} finally {await opened.owner.stop();}
		} finally {await original.close(); await native.close();}
	});
	it("does not accept copied custody or another genuine trust, and revokes nominal custody on stop", async () => {
		const native = await custody(), other = await custody();
		try {
			const opened = await createCreatorSigningRecoveryOwner(native.input);
			expect(opened.ok).toBe(true);
			if (!opened.ok) return;
			try {
				expect(resolveCreatorSigningRecoveryOwner(opened.owner, native.input.currentTrust)).toBe(opened.owner);
				expect(resolveCreatorSigningRecoveryOwner({...opened.owner}, native.input.currentTrust)).toBeUndefined();
				expect(resolveCreatorSigningRecoveryOwner(opened.owner, other.input.currentTrust)).toBeUndefined();
			} finally {await opened.owner.stop();}
			expect(resolveCreatorSigningRecoveryOwner(opened.owner, native.input.currentTrust)).toBeUndefined();
		} finally {await native.close(); await other.close();}
	});
	it("revokes new reads immediately but joins the admitted check before releasing native custody", async () => {
		const native = await custody();
		try {
			const opened = await createCreatorSigningRecoveryOwner(native.input);
			expect(opened.ok).toBe(true);
			if (!opened.ok) return;
			let enter!: () => void, resume!: () => void;
			const entered = new Promise<void>(resolve => {enter = resolve;});
			const barrier = new Promise<void>(resolve => {resume = resolve;});
			const read = await opened.owner.acquireRecoveryDependencies([native.input.currentTrust]);
			const admitted = read.checkWhile(async () => {enter(); await barrier;});
			await entered;
			let joined = false;
			const stopped = opened.owner.stop().then(() => {joined = true;});
			try {
				await expect(opened.owner.acquireRecoveryDependencies([native.input.currentTrust])).rejects.toThrow("unavailable");
				expect(() => read.readExactCanonicalRows()).toThrow("unavailable");
				expect(joined).toBe(false);
			} finally {resume(); await admitted; await stopped; await read.release();}
			expect(joined).toBe(true);
		} finally {await native.close();}
	});
});
