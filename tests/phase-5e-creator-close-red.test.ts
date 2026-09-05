import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	authenticateCurrentEpochAnchor,
	isAnchorTrustStateRecordBytes,
	openCurrentAnchorTrust,
} from "@ts-drp/protocol-v3";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
	AVAILABILITY_POLICY,
	carrierSha256,
	createCreatorCloseFixture,
	CREATOR_CLOSE_OWNER,
	CREATOR_PRIVATE_KEY_SEED_HEX,
	CREATOR_PUBLIC_KEY_HEX,
	CREATOR_SIGNER_ID,
	type CreatorCloseFixture,
	EXACT_AVAILABILITY_POLICY_BYTES,
	EXACT_PARAMETERS_BYTES,
	EXACT_PROFILE_BYTES,
	EXACT_SIGNER_SET_BYTES,
	independentQc,
	loadCreatorCloseModules,
	LOCAL_AUTHOR_PUBLIC_KEY_HEX,
	MUTANT_REJECTIONS,
	OBJECT_ID,
	ownerReadiness,
	PARAMETERS,
	PROFILE,
	REPOSITORY_ROOT,
	REQUIRED_GREEN_PATHS,
	SIGNER_SET,
	SNAPSHOT_PROFILE,
	successorTrustRecord,
	trustRecordForAnchor,
} from "./fixtures/phase-5e-v3/creator-close-contract.js";
import {
	type CreatorCloseCandidateModules,
	type ExactSealCarrier,
	EXPECTED_EXPORTS,
} from "./fixtures/phase-5e-v3/creator-close-types.js";
import { consumeSealSigningRequest } from "../packages/protocol-v3/src/internal/seal-signing-request.js";
import { decodeSnapshotManifest } from "../packages/protocol-v3/src/snapshot-transfer.js";

interface ReferenceResult {
	readonly canonicalHex: string;
	readonly digestHex: string;
	readonly id: string;
}

interface RegistryKind {
	readonly domain: string;
	readonly fields: readonly { readonly name: string }[];
}

interface RegistryV1 {
	readonly kinds: Readonly<Record<string, RegistryKind>>;
}

const REFERENCE = resolve(REPOSITORY_ROOT, "packages/protocol-v3/conformance/original-reference/reference.mjs");
const REGISTRY = JSON.parse(
	readFileSync(resolve(REPOSITORY_ROOT, "packages/protocol-v3/registry/registry-v1.json"), "utf8")
) as RegistryV1;
const readiness = ownerReadiness();
let fixture: CreatorCloseFixture;

beforeAll(async () => {
	fixture = await createCreatorCloseFixture();
});

function bytesHex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

function hexBytes(value: string): Uint8Array {
	return Uint8Array.from(value.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

function exactKeys(value: object): string[] {
	return Reflect.ownKeys(value)
		.filter((key): key is string => typeof key === "string")
		.sort();
}

function referenceEncode(
	cases: readonly Readonly<{ id: string; input: Readonly<Record<string, unknown>>; kind: string }>[]
): readonly ReferenceResult[] {
	const executed = execFileSync(process.execPath, [REFERENCE], {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
		input: JSON.stringify({ cases, operation: "encode-corpus" }),
		maxBuffer: 16 * 1024 * 1024,
	});
	return (JSON.parse(executed) as { readonly results: readonly ReferenceResult[] }).results;
}

function closeInput(
	fixtureValue: CreatorCloseFixture
): Parameters<CreatorCloseCandidateModules["creator"]["prepareCreatorClose"]>[0] {
	return Object.freeze({
		aclDigest: fixtureValue.snapshot.aclDigest,
		archiveIndexRoot: String(fixtureValue.currentAnchor.archiveIndexRoot),
		blueprintDigest: String(fixtureValue.currentAnchor.blueprintDigest),
		closeReason: "creator-requested",
		closeSetCount: fixtureValue.commitment.closeSetCount,
		closeSetRoot: fixtureValue.commitment.closeSetRoot,
		currentTrust: fixtureValue.currentTrust,
		exactCanonicalAvailabilityPolicyBytes: Uint8Array.from(EXACT_AVAILABILITY_POLICY_BYTES),
		exactCanonicalNextSignerSetBytes: Uint8Array.from(EXACT_SIGNER_SET_BYTES),
		exactCanonicalParametersBytes: Uint8Array.from(EXACT_PARAMETERS_BYTES),
		exactCanonicalSnapshotManifestBytes: Uint8Array.from(fixtureValue.snapshot.exactCanonicalManifestBytes),
		historyRoot: fixtureValue.commitment.historyRoot,
		historySize: fixtureValue.commitment.historySize,
		snapshotManifestDigest: fixtureValue.snapshot.manifestDigest,
		stateDigest: fixtureValue.snapshot.stateDigest,
	});
}

function exactCarrier(
	prepared: Readonly<{
		exactCanonicalPreimageBytes: Uint8Array;
		registeredDigest: Uint8Array;
		signingRequest: unknown;
	}>
): ExactSealCarrier {
	const consumed = consumeSealSigningRequest(prepared.signingRequest);
	expect(consumed).toEqual(prepared.registeredDigest);
	expect(consumeSealSigningRequest(prepared.signingRequest)).toBeUndefined();
	return Object.freeze({
		exactCanonicalPreimageBytes: Uint8Array.from(prepared.exactCanonicalPreimageBytes),
		signature: ed25519.sign(prepared.registeredDigest, hexBytes(CREATOR_PRIVATE_KEY_SEED_HEX)),
	});
}

function mutatedCanonical(bytes: Uint8Array, patch: Readonly<Record<string, unknown>>): Uint8Array {
	return encodeCanonical({ ...(decodeCanonical(bytes) as Record<string, unknown>), ...patch });
}

describe.sequential("Phase 5e creator-certified close RED", () => {
	it("freezes the exact existing registry and bounded ten-path GREEN surface", () => {
		expect(REGISTRY.kinds.cutValue?.fields.map(({ name }) => name)).toEqual([
			"kind",
			"protocolMajor",
			"encodingVersion",
			"objectId",
			"epoch",
			"previousAnchor",
			"previousCutDigest",
			"previousHistoryRoot",
			"previousHistorySize",
			"closeSetRoot",
			"closeSetCount",
			"historyRoot",
			"historySize",
			"stateDigest",
			"aclDigest",
			"snapshotManifestDigest",
			"blueprintDigest",
			"archiveIndexRoot",
			"availabilityPolicyDigest",
			"nextSignerSet",
			"parameters",
			"closeReason",
		]);
		expect(REGISTRY.kinds.snapshotManifest?.fields.map(({ name }) => name)).toEqual([
			"kind",
			"protocolMajor",
			"encodingVersion",
			"objectId",
			"epoch",
			"anchor",
			"schemaVersion",
			"stateDigest",
			"aclDigest",
			"payloadDigest",
			"totalBytes",
			"chunks",
		]);
		expect(REGISTRY.kinds.sealQC?.fields.map(({ name }) => name)).toEqual([
			"kind",
			"objectId",
			"epoch",
			"round",
			"phase",
			"proposalDigest",
			"proposalHash",
			"votes",
		]);
		expect(REGISTRY.kinds.epochAnchor?.fields).toHaveLength(16);
		expect(REQUIRED_GREEN_PATHS).toEqual([
			"packages/protocol-v3/src/index.ts",
			"packages/protocol-v3/src/anchor-trust-singleton.ts",
			CREATOR_CLOSE_OWNER,
			"packages/protocol-v3/src/seal.ts",
			"packages/protocol-v3/src/snapshot-transfer.ts",
			"packages/protocol-v3/src/internal/creator-anchor-signing-request.ts",
			"packages/protocol-v3/src/internal/seal-authority-custody.ts",
			"packages/protocol-v3/package.json",
			"vite.config.mts",
			"tests/fixtures/phase-4c-v3/snapshot-stream-types.ts",
		]);
		expect(new Set(Object.keys(MUTANT_REJECTIONS)).size).toBe(13);
		expect(AVAILABILITY_POLICY).toEqual({
			minLocalCopies: 1,
			minMirrorReceipts: 0,
			minRollbackGenerations: 2,
			mode: "local-only",
		});
		expect(PROFILE).toMatchObject({ profileId: "creator-trusted-v1", quorum: 1, signers: SIGNER_SET });
		expect(PARAMETERS).toMatchObject({
			maxSnapshotBytes: SNAPSHOT_PROFILE.maxSnapshotBytes,
			snapshotChunkBytes: SNAPSHOT_PROFILE.snapshotChunkBytes,
		});
		expect(CREATOR_PUBLIC_KEY_HEX).not.toBe(LOCAL_AUTHOR_PUBLIC_KEY_HEX);
	});

	it("derives a genuine nontrivial close/history commitment and detects a post-sign vertex change", () => {
		expect(fixture.commitment.closeSetCount).toBe(3);
		expect(fixture.commitment.closeSetOrder).toHaveLength(3);
		expect(fixture.commitment.historySize).toBe(3);
		expect(fixture.commitment.closeSetRoot).toMatch(/^[0-9a-f]{64}$/u);
		expect(fixture.commitment.historyRoot).toMatch(/^[0-9a-f]{64}$/u);
		expect(fixture.mutatedCommitment.closeSetRoot).not.toBe(fixture.commitment.closeSetRoot);
		expect(fixture.mutatedCommitment.historyRoot).not.toBe(fixture.commitment.historyRoot);
		expect(fixture.mutatedExactCanonicalCutValueBytes).not.toEqual(fixture.exactCanonicalCutValueBytes);
		expect(bytesHex(hashDomain(REGISTRY.kinds.cutValue?.domain ?? "", fixture.exactCanonicalCutValueBytes))).toBe(
			fixture.valueDigest
		);
		expect(
			bytesHex(hashDomain(REGISTRY.kinds.cutValue?.domain ?? "", fixture.mutatedExactCanonicalCutValueBytes))
		).not.toBe(fixture.valueDigest);
	});

	it("differentially proves the multi-chunk manifest, CutValue and successor-anchor bytes", () => {
		expect(fixture.snapshot.chunks).toHaveLength(2);
		expect(fixture.snapshot.chunks[0]?.byteLength).toBe(SNAPSHOT_PROFILE.snapshotChunkBytes);
		expect(fixture.snapshot.chunks[1]?.byteLength).toBeGreaterThan(0);
		expect(fixture.snapshot.descriptors.map(({ index }) => index)).toEqual([0, 1]);
		for (const [index, chunk] of fixture.snapshot.chunks.entries()) {
			expect(fixture.snapshot.descriptors[index]).toEqual({
				byteLength: chunk.byteLength,
				digest: bytesHex(hashDomain(REGISTRY.kinds.snapshotChunk?.domain ?? "", encodeCanonical(index), chunk)),
				index,
			});
		}
		const decoded = decodeSnapshotManifest({
			exactCanonicalManifestBytes: fixture.snapshot.exactCanonicalManifestBytes,
			expectedManifestDigest: fixture.snapshot.manifestDigest,
			profile: SNAPSHOT_PROFILE,
		});
		expect(decoded.chunks).toEqual(fixture.snapshot.descriptors);
		const reference = referenceEncode([
			{
				id: "manifest",
				input: decodeCanonical(fixture.snapshot.exactCanonicalManifestBytes) as Readonly<Record<string, unknown>>,
				kind: "snapshotManifest",
			},
			{
				id: "cut",
				input: decodeCanonical(fixture.exactCanonicalCutValueBytes) as Readonly<Record<string, unknown>>,
				kind: "cutValue",
			},
			{
				id: "successor-anchor",
				input: decodeCanonical(fixture.exactCanonicalSuccessorAnchorPreimageBytes) as Readonly<Record<string, unknown>>,
				kind: "epochAnchor",
			},
		]);
		expect(reference.map(({ id }) => id)).toEqual(["manifest", "cut", "successor-anchor"]);
		expect(reference[0]).toMatchObject({
			canonicalHex: bytesHex(fixture.snapshot.exactCanonicalManifestBytes),
			digestHex: fixture.snapshot.manifestDigest,
		});
		expect(reference[1]).toMatchObject({
			canonicalHex: bytesHex(fixture.exactCanonicalCutValueBytes),
			digestHex: fixture.valueDigest,
		});
		expect(reference[2]).toMatchObject({
			canonicalHex: bytesHex(fixture.exactCanonicalSuccessorAnchorPreimageBytes),
			digestHex: fixture.successorAnchorDigest,
		});
	});

	it("keeps the legacy v1 trust classifier exact while leaving successor opening to creator-close", () => {
		const successorSignature = ed25519.sign(
			hexBytes(fixture.successorAnchorDigest),
			hexBytes(CREATOR_PRIVATE_KEY_SEED_HEX)
		);
		const v1 = successorTrustRecord(fixture, successorSignature);
		const v2 = successorTrustRecord(fixture, successorSignature, 2);
		expect(isAnchorTrustStateRecordBytes(v1)).toBe(true);
		expect(isAnchorTrustStateRecordBytes(v2)).toBe(true);
		expect(
			openCurrentAnchorTrust({
				exactCanonicalTrustStateRecordBytes: v1,
				expectedObjectId: OBJECT_ID,
				pinnedGenesisAnchorDigest: fixture.anchorDigest,
			})
		).toMatchObject({ ok: false, reason: "trust-state-inconsistent" });
		expect(
			openCurrentAnchorTrust({
				exactCanonicalTrustStateRecordBytes: v2,
				expectedObjectId: OBJECT_ID,
				pinnedGenesisAnchorDigest: fixture.anchorDigest,
			})
		).toMatchObject({ ok: false, reason: "unsupported-trust-state-version" });
	});

	it("keeps the exact-three RED type surface buildable before the missing owner exists", () => {
		const checked = spawnSync(
			"pnpm",
			[
				"exec",
				"tsc",
				"--noEmit",
				"--pretty",
				"false",
				"--skipLibCheck",
				"--target",
				"ES2022",
				"--module",
				"NodeNext",
				"--moduleResolution",
				"NodeNext",
				"tests/fixtures/phase-5e-v3/creator-close-types.ts",
			],
			{ cwd: REPOSITORY_ROOT, encoding: "utf8" }
		);
		expect(checked.status, `${checked.stdout}\n${checked.stderr}`).toBe(0);
	});

	it("[RED readiness] requires the sole pure creator-close semantic owner", () => {
		expect(readiness, `missing D.107a owner: ${readiness.missing.join(", ")}`).toEqual({ missing: [], ready: true });
	});

	it.runIf(readiness.ready)("authors exact detached snapshot transfer bytes through the shipped owner", async () => {
		const modules = await loadCreatorCloseModules();
		expect(exactKeys(modules.creator)).toEqual(EXPECTED_EXPORTS.creator);
		expect(exactKeys(modules.request)).toEqual(EXPECTED_EXPORTS.request);
		expect(exactKeys(modules.seal)).toEqual(EXPECTED_EXPORTS.seal);
		expect(exactKeys(modules.snapshot)).toEqual(EXPECTED_EXPORTS.snapshot);
		const payloadInput = Uint8Array.from(fixture.snapshot.exactCanonicalPayloadBytes);
		const encoded = modules.snapshot.encodeSnapshotTransfer({
			aclDigest: fixture.snapshot.aclDigest,
			anchor: fixture.anchorDigest,
			epoch: 0,
			exactCanonicalPayloadBytes: payloadInput,
			objectId: OBJECT_ID,
			profile: SNAPSHOT_PROFILE,
			schemaVersion: 1,
			stateDigest: fixture.snapshot.stateDigest,
		});
		const beforeMutation = encoded.chunks.map((chunk) => carrierSha256(chunk));
		payloadInput.fill(0);
		expect(encoded.exactCanonicalManifestBytes).toEqual(fixture.snapshot.exactCanonicalManifestBytes);
		expect(encoded.manifestDigest).toBe(fixture.snapshot.manifestDigest);
		expect(encoded.payloadDigest).toBe(fixture.snapshot.payloadDigest);
		expect(encoded.chunks).toEqual(fixture.snapshot.chunks);
		expect(encoded.chunks.map((chunk) => carrierSha256(chunk))).toEqual(beforeMutation);
		expect(
			modules.snapshot.decodeSnapshotManifest({
				exactCanonicalManifestBytes: encoded.exactCanonicalManifestBytes,
				expectedManifestDigest: encoded.manifestDigest,
				profile: SNAPSHOT_PROFILE,
			}).chunks
		).toEqual(fixture.snapshot.descriptors);
	});

	it.runIf(readiness.ready)(
		"mints only one-use creator-anchor signing requests bound to the exact creator tuple",
		async () => {
			const { creator, request } = await loadCreatorCloseModules();
			const prepared = creator.prepareCreatorAnchorSigningRequest({
				exactCanonicalAnchorPreimageBytes: fixture.exactCanonicalCurrentAnchorPreimageBytes,
				exactCanonicalProfileBytes: EXACT_PROFILE_BYTES,
				exactCanonicalSignerSetBytes: EXACT_SIGNER_SET_BYTES,
				signerPublicKey: hexBytes(CREATOR_PUBLIC_KEY_HEX),
			});
			expect(prepared.ok).toBe(true);
			if (!prepared.ok) return;
			expect(Reflect.ownKeys(prepared.signingRequest)).toEqual([]);
			expect(request.consumeCreatorAnchorSigningRequest(prepared.signingRequest)).toEqual(
				hexBytes(fixture.anchorDigest)
			);
			expect(request.consumeCreatorAnchorSigningRequest(prepared.signingRequest)).toBeUndefined();
			expect(request.consumeCreatorAnchorSigningRequest(Object.freeze({}) as never)).toBeUndefined();
			expect(
				creator.prepareCreatorAnchorSigningRequest({
					exactCanonicalAnchorPreimageBytes: fixture.exactCanonicalCurrentAnchorPreimageBytes,
					exactCanonicalProfileBytes: EXACT_PROFILE_BYTES,
					exactCanonicalSignerSetBytes: EXACT_SIGNER_SET_BYTES,
					signerPublicKey: hexBytes(LOCAL_AUTHOR_PUBLIC_KEY_HEX),
				})
			).toMatchObject({ ok: false, reason: MUTANT_REJECTIONS.APPLICATION_AUTHOR_AS_CREATOR });
		}
	);

	it.runIf(readiness.ready)("forms genuine q=1 prepare and commit QCs through the common verifier", async () => {
		const modules = await loadCreatorCloseModules();
		const opened = modules.seal.openSealAuthority({
			signerPublicKey: hexBytes(CREATOR_PUBLIC_KEY_HEX),
			trust: fixture.currentTrust,
		});
		expect(opened).toMatchObject({ ok: true, signerId: CREATOR_SIGNER_ID });
		if (!opened.ok) return;
		expect(
			modules.seal.openSealAuthority({
				signerPublicKey: hexBytes(LOCAL_AUTHOR_PUBLIC_KEY_HEX),
				trust: fixture.currentTrust,
			})
		).toMatchObject({ ok: false, reason: "signer-not-authorized" });

		const close = modules.creator.prepareCreatorClose(closeInput(fixture));
		expect(close).toMatchObject({ ok: true, valueDigest: fixture.valueDigest });
		if (!close.ok) return;
		expect(close.exactCanonicalCutValueBytes).toEqual(fixture.exactCanonicalCutValueBytes);
		expect(
			modules.creator.prepareCreatorClose({
				...closeInput(fixture),
				currentTrust: { ...(fixture.currentTrust as Readonly<Record<string, unknown>>) },
			})
		).toMatchObject({ ok: false, reason: MUTANT_REJECTIONS.FOREIGN_CURRENT_TRUST });
		expect(modules.creator.prepareCreatorClose({ ...closeInput(fixture), aclDigest: "f".repeat(64) })).toMatchObject({
			ok: false,
			reason: MUTANT_REJECTIONS.ACL_SWAP,
		});
		expect(
			modules.creator.prepareCreatorClose({
				...closeInput(fixture),
				closeSetCount: fixture.commitment.closeSetCount + 1,
			})
		).toMatchObject({ ok: false, reason: MUTANT_REJECTIONS.CUT_CLOSE_SET_COUNT });
		expect(
			modules.creator.prepareCreatorClose({
				...closeInput(fixture),
				snapshotManifestDigest: "f".repeat(64),
			})
		).toMatchObject({ ok: false, reason: MUTANT_REJECTIONS.CUT_SNAPSHOT_MANIFEST });
		expect(
			modules.creator.prepareCreatorClose({
				...closeInput(fixture),
				stateDigest: "f".repeat(64),
			})
		).toMatchObject({ ok: false, reason: MUTANT_REJECTIONS.CUT_SNAPSHOT_MANIFEST });
		expect(
			modules.creator.prepareCreatorClose({
				...closeInput(fixture),
				blueprintDigest: "f".repeat(64),
			})
		).toMatchObject({ ok: false, reason: MUTANT_REJECTIONS.CUT_CLOSE_SET_COUNT });
		expect(
			modules.creator.prepareCreatorClose({
				...closeInput(fixture),
				archiveIndexRoot: "f".repeat(64),
			})
		).toMatchObject({ ok: false, reason: MUTANT_REJECTIONS.CUT_CLOSE_SET_COUNT });

		const prepare = modules.seal.prepareSealVote({
			authority: opened.authority,
			exactCanonicalCutValueBytes: close.exactCanonicalCutValueBytes,
			phase: "prepare",
			round: 0,
		});
		expect(prepare.ok).toBe(true);
		if (!prepare.ok) return;
		const prepareCarrier = exactCarrier(prepare);
		const expectedPrepareQc = independentQc(prepareCarrier);
		expect(
			modules.seal.verifySealQC({
				authority: opened.authority,
				exactCanonicalQcBytes: prepareCarrier.exactCanonicalPreimageBytes,
			})
		).toMatchObject({ ok: false, reason: MUTANT_REJECTIONS.QC_SHORTCUT });
		expect(
			modules.seal.verifySealQC({
				authority: opened.authority,
				exactCanonicalQcBytes: expectedPrepareQc.exactCanonicalQcBytes,
			})
		).toMatchObject({
			ok: true,
			phase: "prepare",
			qcDigest: expectedPrepareQc.qcDigest,
			round: 0,
			valueDigest: fixture.valueDigest,
		});

		const commit = modules.seal.prepareSealVote({
			authority: opened.authority,
			exactCanonicalCutValueBytes: close.exactCanonicalCutValueBytes,
			phase: "commit",
			round: 0,
		});
		expect(commit.ok).toBe(true);
		if (!commit.ok) return;
		const commitCarrier = exactCarrier(commit);
		const expectedCommitQc = independentQc(commitCarrier);
		expect(
			modules.seal.verifySealQC({
				authority: opened.authority,
				exactCanonicalQcBytes: expectedCommitQc.exactCanonicalQcBytes,
			})
		).toMatchObject({
			ok: true,
			phase: "commit",
			qcDigest: expectedCommitQc.qcDigest,
			round: 0,
			valueDigest: fixture.valueDigest,
		});
	});

	it.runIf(readiness.ready)("opens only the exact v1 successor chain bound to the durable commit QC", async () => {
		const modules = await loadCreatorCloseModules();
		const opened = modules.seal.openSealAuthority({
			signerPublicKey: hexBytes(CREATOR_PUBLIC_KEY_HEX),
			trust: fixture.currentTrust,
		});
		if (!opened.ok) throw new Error(opened.reason);
		const close = modules.creator.prepareCreatorClose(closeInput(fixture));
		if (!close.ok) throw new Error(close.reason);
		const prepare = modules.seal.prepareSealVote({
			authority: opened.authority,
			exactCanonicalCutValueBytes: close.exactCanonicalCutValueBytes,
			phase: "prepare",
			round: 0,
		});
		if (!prepare.ok) throw new Error(prepare.reason);
		const prepareQc = independentQc(exactCarrier(prepare));
		const verifiedPrepareQc = modules.seal.verifySealQC({
			authority: opened.authority,
			exactCanonicalQcBytes: prepareQc.exactCanonicalQcBytes,
		});
		if (!verifiedPrepareQc.ok) throw new Error(verifiedPrepareQc.reason);
		const commit = modules.seal.prepareSealVote({
			authority: opened.authority,
			exactCanonicalCutValueBytes: close.exactCanonicalCutValueBytes,
			phase: "commit",
			round: 0,
		});
		if (!commit.ok) throw new Error(commit.reason);
		const commitQc = independentQc(exactCarrier(commit));
		const verifiedCommitQc = modules.seal.verifySealQC({
			authority: opened.authority,
			exactCanonicalQcBytes: commitQc.exactCanonicalQcBytes,
		});
		if (!verifiedCommitQc.ok) throw new Error(verifiedCommitQc.reason);
		const decodedCommitQc = decodeCanonical(commitQc.exactCanonicalQcBytes) as Readonly<{
			votes: readonly Readonly<Record<string, unknown>>[];
		}>;
		const foreignCommitQc = mutatedCanonical(commitQc.exactCanonicalQcBytes, {
			votes: [
				{
					...(decodedCommitQc.votes[0] as Readonly<Record<string, unknown>>),
					signature: "00".repeat(64),
				},
			],
		});

		const prepared = modules.creator.prepareCreatorSuccessor({
			authority: opened.authority,
			close: close.close,
			exactCanonicalCommitQcBytes: commitQc.exactCanonicalQcBytes,
		});
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(prepared.exactCanonicalAnchorPreimageBytes).toEqual(fixture.exactCanonicalSuccessorAnchorPreimageBytes);
		expect(prepared.anchorDigest).toBe(fixture.successorAnchorDigest);
		const successorDigest = modules.request.consumeCreatorAnchorSigningRequest(prepared.signingRequest);
		expect(successorDigest).toEqual(hexBytes(fixture.successorAnchorDigest));
		const successorSignature = ed25519.sign(successorDigest as Uint8Array, hexBytes(CREATOR_PRIVATE_KEY_SEED_HEX));
		const completed = modules.creator.completeCreatorSuccessor({
			detachedSignature: successorSignature,
			preparation: prepared.preparation,
		});
		expect(completed.ok).toBe(true);
		if (!completed.ok) return;
		expect(completed.exactCanonicalTrustStateRecordBytes).toEqual(successorTrustRecord(fixture, successorSignature));
		const reopened = modules.creator.openCreatorSuccessorTrust({
			currentTrust: fixture.currentTrust,
			exactCanonicalCommitQcBytes: commitQc.exactCanonicalQcBytes,
			exactCanonicalCutValueBytes: close.exactCanonicalCutValueBytes,
			exactCanonicalTrustStateRecordBytes: completed.exactCanonicalTrustStateRecordBytes,
		});
		expect(reopened.ok).toBe(true);
		if (!reopened.ok) return;
		expect(
			authenticateCurrentEpochAnchor({
				detachedSignature: successorSignature,
				exactCanonicalAnchorPreimageBytes: prepared.exactCanonicalAnchorPreimageBytes,
				trust: reopened.trust as never,
			})
		).toMatchObject({ ok: true, provenance: { epoch: 1, objectId: OBJECT_ID } });
		const foreignAnchorBytes = mutatedCanonical(fixture.exactCanonicalSuccessorAnchorPreimageBytes, {
			historyRoot: "e".repeat(64),
		});
		const foreignAnchorDigest = hashDomain("ts-drp/epoch-anchor/v3", foreignAnchorBytes);
		const foreignAnchorSignature = ed25519.sign(foreignAnchorDigest, hexBytes(CREATOR_PRIVATE_KEY_SEED_HEX));
		const foreignTrustRecord = trustRecordForAnchor(fixture, foreignAnchorBytes, foreignAnchorSignature);
		const gapAnchorBytes = mutatedCanonical(fixture.exactCanonicalSuccessorAnchorPreimageBytes, { epoch: 2 });
		const gapAnchorSignature = ed25519.sign(
			hashDomain("ts-drp/epoch-anchor/v3", gapAnchorBytes),
			hexBytes(CREATOR_PRIVATE_KEY_SEED_HEX)
		);
		const gapTrustRecord = trustRecordForAnchor(fixture, gapAnchorBytes, gapAnchorSignature);

		expect(
			modules.creator.openCreatorSuccessorTrust({
				currentTrust: fixture.currentTrust,
				exactCanonicalCommitQcBytes: prepareQc.exactCanonicalQcBytes,
				exactCanonicalCutValueBytes: close.exactCanonicalCutValueBytes,
				exactCanonicalTrustStateRecordBytes: completed.exactCanonicalTrustStateRecordBytes,
			})
		).toMatchObject({ ok: false, reason: MUTANT_REJECTIONS.COMMIT_QC_AS_PREPARE });
		expect(
			modules.creator.openCreatorSuccessorTrust({
				currentTrust: fixture.currentTrust,
				exactCanonicalCommitQcBytes: new Uint8Array(),
				exactCanonicalCutValueBytes: close.exactCanonicalCutValueBytes,
				exactCanonicalTrustStateRecordBytes: completed.exactCanonicalTrustStateRecordBytes,
			})
		).toMatchObject({ ok: false, reason: MUTANT_REJECTIONS.SUCCESSOR_QC_OMITTED });
		expect(
			modules.creator.openCreatorSuccessorTrust({
				currentTrust: fixture.currentTrust,
				exactCanonicalCommitQcBytes: foreignCommitQc,
				exactCanonicalCutValueBytes: close.exactCanonicalCutValueBytes,
				exactCanonicalTrustStateRecordBytes: completed.exactCanonicalTrustStateRecordBytes,
			})
		).toMatchObject({ ok: false, reason: MUTANT_REJECTIONS.FOREIGN_COMMIT_QC });
		expect(
			modules.creator.openCreatorSuccessorTrust({
				currentTrust: fixture.currentTrust,
				exactCanonicalCommitQcBytes: commitQc.exactCanonicalQcBytes,
				exactCanonicalCutValueBytes: fixture.mutatedExactCanonicalCutValueBytes,
				exactCanonicalTrustStateRecordBytes: completed.exactCanonicalTrustStateRecordBytes,
			})
		).toMatchObject({ ok: false, reason: MUTANT_REJECTIONS.POST_SIGN_VERTEX });
		expect(
			modules.creator.openCreatorSuccessorTrust({
				currentTrust: fixture.currentTrust,
				exactCanonicalCommitQcBytes: commitQc.exactCanonicalQcBytes,
				exactCanonicalCutValueBytes: close.exactCanonicalCutValueBytes,
				exactCanonicalTrustStateRecordBytes: foreignTrustRecord,
			})
		).toMatchObject({ ok: false, reason: MUTANT_REJECTIONS.POST_SIGN_VERTEX });
		expect(
			modules.creator.openCreatorSuccessorTrust({
				currentTrust: fixture.currentTrust,
				exactCanonicalCommitQcBytes: commitQc.exactCanonicalQcBytes,
				exactCanonicalCutValueBytes: close.exactCanonicalCutValueBytes,
				exactCanonicalTrustStateRecordBytes: successorTrustRecord(fixture, successorSignature, 2),
			})
		).toMatchObject({ ok: false, reason: MUTANT_REJECTIONS.TRUST_RECORD_VERSION_2 });
		expect(
			modules.creator.openCreatorSuccessorTrust({
				currentTrust: fixture.currentTrust,
				exactCanonicalCommitQcBytes: commitQc.exactCanonicalQcBytes,
				exactCanonicalCutValueBytes: close.exactCanonicalCutValueBytes,
				exactCanonicalTrustStateRecordBytes: gapTrustRecord,
			})
		).toMatchObject({ ok: false, reason: MUTANT_REJECTIONS.SUCCESSOR_EPOCH_GAP });
		expect(
			modules.creator.openCreatorSuccessorTrust({
				currentTrust: reopened.trust,
				exactCanonicalCommitQcBytes: commitQc.exactCanonicalQcBytes,
				exactCanonicalCutValueBytes: close.exactCanonicalCutValueBytes,
				exactCanonicalTrustStateRecordBytes: foreignTrustRecord,
			})
		).toMatchObject({ ok: false, reason: MUTANT_REJECTIONS.SUCCESSOR_SAME_EPOCH_DIFFERENT });
	});

	it.runIf(readiness.ready)(
		"rejects tampered snapshot and successor carriers without mutating caller bytes",
		async () => {
			const modules = await loadCreatorCloseModules();
			const manifest = Uint8Array.from(fixture.snapshot.exactCanonicalManifestBytes);
			const original = Uint8Array.from(manifest);
			const badManifest = mutatedCanonical(manifest, { aclDigest: "f".repeat(64) });
			expect(
				modules.creator.prepareCreatorClose({
					...closeInput(fixture),
					exactCanonicalSnapshotManifestBytes: badManifest,
					snapshotManifestDigest: bytesHex(hashDomain("ts-drp/snapshot-manifest/v3", badManifest)),
				})
			).toMatchObject({ ok: false, reason: MUTANT_REJECTIONS.CUT_SNAPSHOT_MANIFEST });
			expect(manifest).toEqual(original);
		}
	);
});
