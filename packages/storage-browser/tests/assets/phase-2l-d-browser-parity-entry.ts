import { decodeCanonical } from "@ts-drp/canonical";
import { createBrowserDurableIssuanceStore } from "@ts-drp/storage-browser/issuance";

// eslint-disable-next-line import/no-unresolved -- resolved by the private Phase 2l-d bundler.
import { runPhase2lDRealAdapterConformance } from "#phase-2l-d-shared-harness";
// eslint-disable-next-line import/no-unresolved -- resolved by the private Phase 2l-d bundler.
import { createTransactionalVertexIssuer, verifyReceivedVertex } from "#phase-2l-d-unmodified-protocol";
import profile from "../../../../tests/fixtures/phase-0g2s/ed25519-acceptance-profile-contract.json" with { type: "json" };

declare global {
	interface Window {
		phase2lDRun(caseId: "golden-path" | "shared-conformance"): Promise<unknown>;
	}
}

function fromHex(value: string): Uint8Array {
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function deleteDatabase(name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.addEventListener("success", () => resolve(), { once: true });
		request.addEventListener("blocked", () => reject(new Error(`delete blocked: ${name}`)), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error(`delete failed: ${name}`)), {
			once: true,
		});
	});
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function sharedConformance(): Promise<unknown> {
	const primaryDatabaseName = `phase-2l-d-shared-${crypto.randomUUID()}`;
	const store = await createBrowserDurableIssuanceStore({ primaryDatabaseName });
	try {
		return await runPhase2lDRealAdapterConformance(store);
	} finally {
		await store.close();
		await deleteDatabase(`${primaryDatabaseName}--drp-issuance-v1`);
	}
}

async function goldenPath(): Promise<unknown> {
	const primaryDatabaseName = `phase-2l-d-golden-${crypto.randomUUID()}`;
	const store = await createBrowserDurableIssuanceStore({ primaryDatabaseName });
	try {
		const issuer = createTransactionalVertexIssuer({
			author: profile.live.preimage.author,
			privateKeySeed: fromHex(profile.live.privateKeySeedHex),
			publicKey: { bytes: fromHex(profile.live.publicKeyHex), format: "raw" },
			transactIssue: store.transactIssue,
		});
		const commit = await issuer.issue({
			anchor: profile.live.preimage.anchor,
			dependencies: profile.live.unsortedDependencies,
			epoch: profile.live.preimage.epoch,
			logicalTime: profile.live.preimage.logicalTime,
			objectId: profile.live.preimage.objectId,
			operation: profile.live.preimage.operation,
		});
		const decoded = decodeCanonical(commit.envelope.canonicalPreimageBytes) as {
			authorSequence: number;
			dependencies: string[];
		};
		const durable = await store.readIssued(commit.issuedRecord.scope, 0);
		const admitted = verifyReceivedVertex({
			domain: profile.live.domain,
			expectedAnchor: profile.live.preimage.anchor,
			receivedCanonicalPreimageBytes: commit.envelope.canonicalPreimageBytes,
			resolveAuthorPublicKey: () => ({ bytes: fromHex(profile.live.publicKeyHex), format: "raw" }),
			signature: commit.envelope.signature,
			suiteId: profile.live.suiteId,
		});
		return {
			accepted: admitted.accepted,
			admissionDigestEqual:
				admitted.digest !== undefined &&
				equalBytes(admitted.digest, commit.envelope.digest) &&
				durable !== null &&
				equalBytes(admitted.digest, durable.envelope.digest),
			authorSequence: decoded.authorSequence,
			dependencies: decoded.dependencies,
			durableClosureEqual:
				durable !== null &&
				durable.authorSequence === commit.authorSequence &&
				equalBytes(durable.envelope.canonicalPreimageBytes, commit.envelope.canonicalPreimageBytes) &&
				equalBytes(durable.envelope.digest, commit.envelope.digest) &&
				equalBytes(durable.envelope.signature, commit.envelope.signature) &&
				durable.issuedRecord.scope.author === commit.issuedRecord.scope.author &&
				durable.issuedRecord.scope.objectId === commit.issuedRecord.scope.objectId &&
				durable.outboxEntry.scope.author === commit.outboxEntry.scope.author &&
				durable.outboxEntry.scope.objectId === commit.outboxEntry.scope.objectId,
			pendingCount: (await store.readOutboxPage({ scope: commit.issuedRecord.scope })).length,
		};
	} finally {
		await store.close();
		await deleteDatabase(`${primaryDatabaseName}--drp-issuance-v1`);
	}
}

window.phase2lDRun = (caseId): Promise<unknown> =>
	caseId === "shared-conformance" ? sharedConformance() : goldenPath();
