import { decodeCanonical } from "@ts-drp/canonical";
import type { DurableIssuanceStore } from "@ts-drp/issuance-store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import profile from "./fixtures/phase-0g2s/ed25519-acceptance-profile-contract.json" with { type: "json" };
import { runPhase2lDRealAdapterConformance } from "./fixtures/phase-2l-d/real-adapter-conformance.js";
import { createTransactionalVertexIssuer, verifyReceivedVertex } from "../packages/protocol-v3/src/index.js";
import { createNodeDurableIssuanceStore } from "../packages/storage-node/src/issuance.js";

const temporaryDirectories: string[] = [];

function fromHex(value: string): Uint8Array {
	return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

async function primaryFilename(label: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), `phase-2l-d-${label}-`));
	temporaryDirectories.push(directory);
	return join(directory, "primary.sqlite");
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("Phase 2l-d shared conformance through the real Node adapter", () => {
	it("matches the exact backend-neutral observable report", async () => {
		const store = createNodeDurableIssuanceStore({ primaryFilename: await primaryFilename("shared") });
		await expect(runPhase2lDRealAdapterConformance(store)).resolves.toEqual({
			builderFailures: ["sync-identity", "async-identity"],
			builderFailureOldState: [true, true],
			builderInvocations: 1,
			closedCode: "ISSUANCE_STORE_CLOSED",
			copy: {
				durableDigest: [29, 209],
				durableScope: { author: "author:success", objectId: "object:success" },
				durableSignature: [29, 81],
				freshRead: true,
				returnedDetached: true,
				sourceDetached: true,
				sourceDigest: [29, 209],
			},
			invalidCodes: ["ISSUANCE_INVALID_ARGUMENT", "ISSUANCE_INVALID_ARGUMENT"],
			invalidOldState: [true, true],
			invalidTypeErrors: [true, true],
			malformedCode: "ISSUANCE_COMMIT_INVALID",
			malformedLineage: { exhausted: false, next: 0 },
			malformedOldState: true,
			pendingCount: 1,
			scopeBoundary: {
				accepted1024: true,
				acceptedBuilderCalls: 1,
				rejected1025Code: "ISSUANCE_INVALID_ARGUMENT",
				rejectedBuilderCalls: 0,
			},
		});
	});

	it("kills an adapter mutant that invokes one trusted builder twice", async () => {
		const real = createNodeDurableIssuanceStore({ primaryFilename: await primaryFilename("twice-mutant") });
		const mutant: DurableIssuanceStore = {
			close: real.close,
			readIssued: real.readIssued,
			readLineage: real.readLineage,
			readOutboxPage: real.readOutboxPage,
			transactIssue: (scope, buildAndSign) =>
				real.transactIssue(scope, async (selected) => {
					const candidate = await buildAndSign(selected);
					await buildAndSign(selected);
					return candidate;
				}),
		};
		const report = await runPhase2lDRealAdapterConformance(mutant);
		expect(report).toMatchObject({ builderInvocations: 2 });
		expect(report).not.toMatchObject({ builderInvocations: 1 });
	});

	it("binds the unmodified frozen issuer to durable selection and strict admission", async () => {
		const store = createNodeDurableIssuanceStore({ primaryFilename: await primaryFilename("issuer") });
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
			expect(decoded).toMatchObject({ authorSequence: 0, dependencies: profile.live.preimage.dependencies });
			expect(await store.readIssued(commit.issuedRecord.scope, 0)).toEqual(commit);
			expect(
				verifyReceivedVertex({
					domain: profile.live.domain,
					expectedAnchor: profile.live.preimage.anchor,
					receivedCanonicalPreimageBytes: commit.envelope.canonicalPreimageBytes,
					resolveAuthorPublicKey: () => ({ bytes: fromHex(profile.live.publicKeyHex), format: "raw" }),
					signature: commit.envelope.signature,
					suiteId: profile.live.suiteId,
				})
			).toMatchObject({ accepted: true, digest: commit.envelope.digest });
		} finally {
			await store.close();
		}
	});
});
