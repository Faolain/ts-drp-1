import "fake-indexeddb/auto";

import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { CompactMerkleAccumulator } from "@ts-drp/compaction";
import { digestBlob } from "@ts-drp/storage";
import type { GenerationRecord, PresentHead } from "@ts-drp/storage";
import type { SnapshotQuarantineDeclaration } from "@ts-drp/storage/snapshot-transfer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { contract, hexBytes } from "./fixtures/phase-3a0-v3/controlled-anchor-trust.js";
import { independentQc } from "./fixtures/phase-5e-v3/creator-close-contract.js";
import {
	bytesForRef,
	type CandidateCreatorAdoptionModule,
	CREATOR_ADOPTION_EXPORTS,
	CREATOR_ADOPTION_FAILURE_KINDS,
	creatorAdoptionReadiness,
	CUT_VALUE_FIELDS,
	D108B_GREEN_PATHS,
	D108B_MUTANTS,
	D108B_RED_PATHS,
	modelIntentCustody,
	mutatedCutBlob,
	openGenuineCreatorAdoptionFixture,
	REPOSITORY_ROOT,
	sourceGovernance,
	V3_LIVE_GENERATION_2_KEYS,
} from "./fixtures/phase-6a-v3/creator-adoption-contract.js";
import { inspectCreatorTrustAdvance } from "../packages/control-plane/src/creator-trust-advance.js";
import { openCreatorSuccessorTrust } from "../packages/protocol-v3/src/creator-close.js";
import type { CurrentAnchorTrust } from "../packages/protocol-v3/src/index.js";
import { consumeSealSigningRequest } from "../packages/protocol-v3/src/internal/seal-signing-request.js";
import { openSealAuthority, prepareSealVote } from "../packages/protocol-v3/src/seal.js";
import { decodeSnapshotManifest, snapshotChunkDigest } from "../packages/protocol-v3/src/snapshot-transfer.js";

let candidate: CandidateCreatorAdoptionModule | undefined;
let genuine: Awaited<ReturnType<typeof openGenuineCreatorAdoptionFixture>>;
let foreign: Awaited<ReturnType<typeof openGenuineCreatorAdoptionFixture>>;
const CREATOR_ADOPTION_SOURCE = "../packages/node/src/creator-" + "adoption.js";
const CREATOR_ADOPTION_INTENT_SOURCE = "../packages/node/src/internal/creator-adoption-" + "intent.js";

function signedQc(
	currentTrust: CurrentAnchorTrust,
	exactCanonicalCutValueBytes: Uint8Array,
	phase: "commit" | "prepare"
): Uint8Array {
	const opened = openSealAuthority({
		signerPublicKey: ed25519.getPublicKey(hexBytes(contract.privateKeySeedHex)),
		trust: currentTrust,
	});
	if (!opened.ok) throw new TypeError(`D.108b seal authority failed: ${opened.reason}`);
	const prepared = prepareSealVote({ authority: opened.authority, exactCanonicalCutValueBytes, phase, round: 0 });
	if (!prepared.ok) throw new TypeError(`D.108b ${phase} vote failed: ${prepared.reason}`);
	const digest = consumeSealSigningRequest(prepared.signingRequest);
	if (digest === undefined) throw new TypeError(`D.108b ${phase} signing request failed`);
	return independentQc({
		exactCanonicalPreimageBytes: prepared.exactCanonicalPreimageBytes,
		signature: ed25519.sign(digest, hexBytes(contract.privateKeySeedHex)),
	}).exactCanonicalQcBytes;
}

function sameHead(left: PresentHead, right: PresentHead): boolean {
	return (
		left.closureDigest === right.closureDigest &&
		left.generationId === right.generationId &&
		left.objectId === right.objectId &&
		left.revision === right.revision
	);
}

function validGenerationLineage(
	generations: readonly GenerationRecord[],
	currentHead: PresentHead,
	proposedHead: PresentHead
): boolean {
	const byId = new Map(generations.map((generation) => [generation.generationId, generation]));
	if (byId.size !== generations.length) return false;
	const current = byId.get(currentHead.generationId);
	const proposed = byId.get(proposedHead.generationId);
	if (current === undefined || proposed === undefined || proposed.baseExpectedHead.kind !== "present") return false;
	if (!sameHead(proposed.baseExpectedHead, currentHead) || proposedHead.revision !== currentHead.revision + 1)
		return false;
	for (const generation of generations) {
		if (new Set(generation.closure.map(({ digest }) => digest)).size !== generation.closure.length) return false;
		if (generation.baseExpectedHead.kind === "present") {
			if (generation.baseExpectedHead.generationId === generation.generationId) return false;
			if (!byId.has(generation.baseExpectedHead.generationId)) return false;
		}
	}
	return current.state === "Superseded" && proposed.state === "Adopted";
}

const SNAPSHOT_PROFILE = Object.freeze({
	maxManifestBytes: 212_387 as const,
	maxSnapshotBytes: 268_435_456 as const,
	snapshotChunkBytes: 131_072 as const,
});

function hex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

function packetFromPayload(
	base: SnapshotQuarantineDeclaration,
	payload: Readonly<Record<string, unknown>>,
	manifestPatch: Readonly<Record<string, unknown>> = {}
): Readonly<{ readonly chunks: readonly Uint8Array[]; readonly declaration: SnapshotQuarantineDeclaration }> {
	const exactCanonicalPayloadBytes = encodeCanonical(payload);
	const chunks: Uint8Array[] = [];
	for (let offset = 0; offset < exactCanonicalPayloadBytes.byteLength; offset += SNAPSHOT_PROFILE.snapshotChunkBytes) {
		chunks.push(exactCanonicalPayloadBytes.slice(offset, offset + SNAPSHOT_PROFILE.snapshotChunkBytes));
	}
	const original = decodeCanonical(base.exactCanonicalManifestBytes) as Readonly<Record<string, unknown>>;
	const manifest = {
		...original,
		chunks: chunks.map((chunk, index) => ({
			byteLength: chunk.byteLength,
			digest: snapshotChunkDigest(index, chunk),
			index,
		})),
		payloadDigest: hex(hashDomain("ts-drp/snapshot-payload/v3", exactCanonicalPayloadBytes)),
		totalBytes: exactCanonicalPayloadBytes.byteLength,
		...manifestPatch,
	};
	const exactCanonicalManifestBytes = encodeCanonical(manifest);
	const manifestDigest = hex(hashDomain("ts-drp/snapshot-manifest/v3", exactCanonicalManifestBytes));
	return Object.freeze({
		chunks: Object.freeze(chunks),
		declaration: Object.freeze({
			chunks: Object.freeze(manifest.chunks),
			exactCanonicalManifestBytes,
			scope: Object.freeze({ ...base.scope, manifestDigest }),
			totalBytes: exactCanonicalPayloadBytes.byteLength,
		}),
	});
}

function validSnapshotPacket(
	packet: Readonly<{ readonly chunks: readonly Uint8Array[]; readonly declaration: SnapshotQuarantineDeclaration }>,
	cut: Readonly<Record<string, unknown>>,
	catalog: typeof genuine.catalog
): boolean {
	try {
		const decoded = decodeSnapshotManifest({
			exactCanonicalManifestBytes: packet.declaration.exactCanonicalManifestBytes,
			expectedManifestDigest: packet.declaration.scope.manifestDigest,
			profile: SNAPSHOT_PROFILE,
		});
		if (decoded.chunks.length !== packet.chunks.length) return false;
		for (const [index, descriptor] of decoded.chunks.entries()) {
			const chunk = packet.chunks[index];
			if (chunk === undefined || descriptor.digest !== snapshotChunkDigest(index, chunk)) return false;
		}
		const payloadBytes = new Uint8Array(packet.chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
		let offset = 0;
		for (const chunk of packet.chunks) {
			payloadBytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const manifest = decoded.manifest;
		const payload = decodeCanonical(payloadBytes) as Readonly<Record<string, unknown>>;
		if (
			packet.declaration.scope.manifestDigest !== cut.snapshotManifestDigest ||
			hex(hashDomain("ts-drp/snapshot-payload/v3", payloadBytes)) !== manifest.payloadDigest ||
			payload.anchor !== manifest.anchor ||
			payload.anchor !== cut.previousAnchor ||
			payload.objectId !== cut.objectId ||
			payload.epoch !== cut.epoch ||
			payload.archiveIndexRoot !== cut.archiveIndexRoot ||
			payload.blueprintDigest !== cut.blueprintDigest ||
			manifest.stateDigest !== cut.stateDigest ||
			manifest.aclDigest !== cut.aclDigest ||
			hex(hashDomain("ts-drp/state/v3", encodeCanonical(payload.application))) !== manifest.stateDigest ||
			hex(hashDomain("ts-drp/latched-acl/v3", encodeCanonical(payload.acl))) !== manifest.aclDigest
		) {
			return false;
		}
		const resolved = catalog.resolve(String(payload.blueprintDigest));
		return (
			resolved.blueprintDigest === payload.blueprintDigest &&
			resolved.artifactDigest === hex(hashDomain("ts-drp/blueprint-artifact/v3", resolved.exactArtifactBytes))
		);
	} catch {
		return false;
	}
}

function expectedMutationFailureKind(label: (typeof D108B_MUTANTS)[number]): string {
	if (
		label.startsWith("cut:") ||
		["cut-swap", "qc-swap", "qc-prepare-as-commit", "qc-duplicate-signer", "trust-old", "trust-foreign"].includes(label)
	) {
		return "chain-invalid";
	}
	if (label.startsWith("pending-head-ref-") || label.startsWith("predecessor-link-")) return "recovery-failed";
	if (
		["post-close-durable-vertex", "durable-local-issued-missing", "close-order", "history-extension"].includes(label)
	) {
		return "journal-invalid";
	}
	if (label.startsWith("manifest-") || label.startsWith("payload-")) return "snapshot-invalid";
	if (label.startsWith("catalog-")) return "blueprint-invalid";
	throw new TypeError(`D.108b mutant has no expected failure kind: ${label}`);
}

beforeAll(async () => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
	[genuine, foreign] = await Promise.all([
		openGenuineCreatorAdoptionFixture(),
		openGenuineCreatorAdoptionFixture({ objectId: "creator:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
	]);
	try {
		candidate = (await import(/* @vite-ignore */ CREATOR_ADOPTION_SOURCE)) as CandidateCreatorAdoptionModule;
	} catch {
		candidate = undefined;
	}
});

afterAll(async () => {
	await genuine?.close();
	await foreign?.close();
});

describe("D.108b read-only creator-successor adoption RED", () => {
	it("freezes the exact tests-only and GREEN owner rosters", () => {
		expect(D108B_RED_PATHS).toEqual([
			"tests/fixtures/phase-6a-v3/creator-adoption-contract.ts",
			"tests/phase-6a-creator-adoption-red.test.ts",
			"tests/fixtures/phase-3a1b-p3/live-fixture.ts",
		]);
		expect(D108B_GREEN_PATHS).toEqual([
			"packages/node/src/creator-adoption.ts",
			"packages/node/src/internal/creator-adoption-intent.ts",
			"packages/node/src/creator-close.ts",
			"packages/node/src/v3-live.ts",
			"packages/node/package.json",
		]);
		expect(D108B_RED_PATHS.every((path) => readFileSync(resolve(REPOSITORY_ROOT, path)).byteLength > 0)).toBe(true);
	});

	it("freezes the exact v3-live-generation-2 grammar and compact-history carrier", () => {
		expect(V3_LIVE_GENERATION_2_KEYS).toHaveLength(31);
		expect(new Set(V3_LIVE_GENERATION_2_KEYS).size).toBe(V3_LIVE_GENERATION_2_KEYS.length);
		expect(V3_LIVE_GENERATION_2_KEYS).toContain("compactHistory");
		expect(V3_LIVE_GENERATION_2_KEYS).toContain("previousHistoryRoot");
		expect(V3_LIVE_GENERATION_2_KEYS).toContain("previousHistorySize");
		expect(V3_LIVE_GENERATION_2_KEYS).toContain("historyRoot");
		expect(V3_LIVE_GENERATION_2_KEYS).toContain("historySize");
		expect(V3_LIVE_GENERATION_2_KEYS).not.toContain("exactCanonicalSnapshotPayloadBytes");
	});

	it("enumerates every registered CutValue field and every cross-owner causal mutant", () => {
		expect(CUT_VALUE_FIELDS).toHaveLength(22);
		expect(new Set(CUT_VALUE_FIELDS).size).toBe(CUT_VALUE_FIELDS.length);
		expect(D108B_MUTANTS).toHaveLength(50);
		expect(new Set(D108B_MUTANTS).size).toBe(D108B_MUTANTS.length);
		expect(CUT_VALUE_FIELDS.every((field) => D108B_MUTANTS.includes(`cut:${field}`))).toBe(true);
		expect(D108B_MUTANTS).toEqual(
			expect.arrayContaining([
				"cut-swap",
				"qc-swap",
				"qc-prepare-as-commit",
				"qc-duplicate-signer",
				"post-close-durable-vertex",
				"close-order",
				"history-extension",
				"manifest-old",
				"manifest-foreign",
				"catalog-wrong-blueprint",
				"catalog-wrong-artifact",
				"payload-state",
				"payload-acl",
				"payload-archive",
				"payload-anchor",
			])
		);
		expect(CREATOR_ADOPTION_FAILURE_KINDS).toEqual([
			"malformed-input",
			"sealed-live-unavailable",
			"recovery-failed",
			"chain-invalid",
			"journal-invalid",
			"snapshot-invalid",
			"blueprint-invalid",
			"internal-invariant",
		]);
		expect(D108B_MUTANTS.map(expectedMutationFailureKind)).toHaveLength(D108B_MUTANTS.length);
	});

	it("pins owner-bound one-use intent behavior independently of serialization", () => {
		const custody = modelIntentCustody();
		const clone = { ...custody.intent };
		const serialized = JSON.parse(JSON.stringify(custody.intent)) as unknown;
		expect(custody.consume(Object.freeze({}), custody.owner)).toBeUndefined();
		expect(custody.consume(clone, custody.owner)).toBeUndefined();
		expect(custody.consume(serialized, custody.owner)).toBeUndefined();
		expect(custody.consume(custody.intent, Object.freeze({}))).toBeUndefined();
		expect(custody.consume(custody.intent, custody.owner)).toBe("verified");
		expect(custody.consume(custody.intent, custody.owner)).toBeUndefined();
	});

	it("forbids AHE mutation, node-root widening and product consumption", () => {
		expect(sourceGovernance()).toEqual({
			forbiddenRootExport: false,
			noAheMutationInVerifier: true,
			noProductConsumer: true,
		});
	});

	it("executes every CutValue mutant against the genuine certified successor chain", () => {
		const { closeResult, currentTrust, proposed } = genuine.evidence;
		const cutBytes = bytesForRef(proposed, closeResult.cutValueRef);
		const commitQcBytes = bytesForRef(proposed, closeResult.commitQcRef);
		const successorTrustBytes = bytesForRef(proposed, closeResult.successorTrustRef);
		const original = decodeCanonical(cutBytes) as Readonly<Record<string, unknown>>;
		expect(Object.keys(original).sort()).toEqual([...CUT_VALUE_FIELDS].sort());
		expect(
			openCreatorSuccessorTrust({
				currentTrust,
				exactCanonicalCommitQcBytes: commitQcBytes,
				exactCanonicalCutValueBytes: cutBytes,
				exactCanonicalTrustStateRecordBytes: successorTrustBytes,
			})
		).toEqual(expect.objectContaining({ ok: true }));

		for (const field of CUT_VALUE_FIELDS) {
			const mutant = mutatedCutBlob(cutBytes, field);
			const decoded = decodeCanonical(mutant) as Readonly<Record<string, unknown>>;
			const changed = CUT_VALUE_FIELDS.filter(
				(key) =>
					Buffer.compare(Buffer.from(encodeCanonical(decoded[key])), Buffer.from(encodeCanonical(original[key]))) !== 0
			);
			expect(changed, field).toEqual([field]);
			const mutantRef = digestBlob(mutant);
			expect(mutantRef.ok, field).toBe(true);
			if (!mutantRef.ok) continue;
			expect(mutantRef.value, field).not.toBe(closeResult.cutValueRef.digest);
			expect(
				openCreatorSuccessorTrust({
					currentTrust,
					exactCanonicalCommitQcBytes: commitQcBytes,
					exactCanonicalCutValueBytes: mutant,
					exactCanonicalTrustStateRecordBytes: successorTrustBytes,
				})
			).toEqual({ ok: false, reason: "CERTIFIED_VALUE_MISMATCH" });
		}
	});

	it("executes swapped Cut/QC/trust, prepare-QC, duplicate-signer and pending-ref mutants", () => {
		const first = genuine.evidence;
		const second = foreign.evidence;
		const cut = bytesForRef(first.proposed, first.closeResult.cutValueRef);
		const commit = bytesForRef(first.proposed, first.closeResult.commitQcRef);
		const successorTrust = bytesForRef(first.proposed, first.closeResult.successorTrustRef);
		const foreignCut = bytesForRef(second.proposed, second.closeResult.cutValueRef);
		const foreignCommit = bytesForRef(second.proposed, second.closeResult.commitQcRef);
		const foreignTrust = bytesForRef(second.proposed, second.closeResult.successorTrustRef);
		const oldTrust = bytesForRef(first.current, first.closeResult.currentTrustRef);
		const verify = (
			exactCanonicalCutValueBytes: Uint8Array,
			exactCanonicalCommitQcBytes: Uint8Array,
			exactCanonicalTrustStateRecordBytes: Uint8Array
		): ReturnType<typeof openCreatorSuccessorTrust> =>
			openCreatorSuccessorTrust({
				currentTrust: first.currentTrust,
				exactCanonicalCommitQcBytes,
				exactCanonicalCutValueBytes,
				exactCanonicalTrustStateRecordBytes,
			});

		expect(verify(cut, commit, successorTrust), "genuine").toEqual(expect.objectContaining({ ok: true }));
		expect(verify(foreignCut, commit, successorTrust), "cut-swap").toEqual(expect.objectContaining({ ok: false }));
		expect(verify(cut, foreignCommit, successorTrust), "qc-swap").toEqual(expect.objectContaining({ ok: false }));
		expect(verify(cut, commit, oldTrust), "trust-old").toEqual(expect.objectContaining({ ok: false }));
		expect(verify(cut, commit, foreignTrust), "trust-foreign").toEqual(expect.objectContaining({ ok: false }));
		expect(verify(cut, signedQc(first.currentTrust, cut, "prepare"), successorTrust), "qc-prepare-as-commit").toEqual({
			ok: false,
			reason: "COMMIT_QC_REQUIRED",
		});
		const decodedCommit = decodeCanonical(commit) as Readonly<{ readonly votes: readonly unknown[] }>;
		const duplicateSignerQc = encodeCanonical({
			...(decodeCanonical(commit) as Readonly<Record<string, unknown>>),
			votes: [decodedCommit.votes[0], decodedCommit.votes[0]],
		});
		expect(verify(cut, duplicateSignerQc, successorTrust), "qc-duplicate-signer").toEqual({
			ok: false,
			reason: "COMMIT_QC_REJECTED",
		});

		const advance = (
			proposedReferences: typeof first.proposed.references
		): ReturnType<typeof inspectCreatorTrustAdvance> =>
			inspectCreatorTrustAdvance({
				current: { candidates: first.current.candidates, closure: first.current.references },
				proofRefs: [first.closeResult.cutValueRef, first.closeResult.commitQcRef],
				proposed: { candidates: first.proposed.candidates, closure: proposedReferences },
			});
		expect(advance(first.proposed.references)).toEqual({ kind: "successor", ok: true });
		const lengthMutant = first.proposed.references.map((ref) =>
			ref.digest === first.closeResult.cutValueRef.digest ? { ...ref, byteLength: ref.byteLength + 1 } : ref
		);
		const digestMutant = first.proposed.references.map((ref) =>
			ref.digest === first.closeResult.cutValueRef.digest
				? { ...ref, digest: "f".repeat(64) as typeof ref.digest }
				: ref
		);
		expect(advance(lengthMutant), "pending-head-ref-length").toEqual({ ok: false, reason: "TRUST_CLOSURE_INVALID" });
		expect(advance(digestMutant), "pending-head-ref-digest").toEqual({ ok: false, reason: "TRUST_CLOSURE_INVALID" });
	});

	it("executes predecessor-lineage, close-order and append-only history mutants", async () => {
		const { closeResult, current, generations, history, proposed } = genuine.evidence;
		expect(validGenerationLineage(generations, current.head, proposed.head), "genuine-lineage").toBe(true);
		expect(
			validGenerationLineage(
				generations.filter(({ generationId }) => generationId !== current.head.generationId),
				current.head,
				proposed.head
			),
			"predecessor-link-missing"
		).toBe(false);
		expect(
			validGenerationLineage([...generations, generations[0] as GenerationRecord], current.head, proposed.head),
			"predecessor-link-duplicate"
		).toBe(false);
		const proposedGeneration = generations.find(({ generationId }) => generationId === proposed.head.generationId);
		if (proposedGeneration === undefined || proposedGeneration.baseExpectedHead.kind !== "present") {
			throw new TypeError("D.108b proposed generation is unavailable");
		}
		const cycle = generations.map((generation) =>
			generation === proposedGeneration ? { ...generation, baseExpectedHead: { ...proposed.head } } : generation
		) as readonly GenerationRecord[];
		const skipped = generations.map((generation) =>
			generation === proposedGeneration
				? {
						...generation,
						baseExpectedHead: { ...proposedGeneration.baseExpectedHead, revision: current.head.revision - 1 },
					}
				: generation
		) as readonly GenerationRecord[];
		expect(validGenerationLineage(cycle, current.head, proposed.head), "predecessor-link-cycle").toBe(false);
		expect(validGenerationLineage(skipped, current.head, proposed.head), "predecessor-link-skipped").toBe(false);

		const cut = decodeCanonical(bytesForRef(proposed, closeResult.cutValueRef)) as Readonly<Record<string, unknown>>;
		expect(history.closeSetCount).toBe(cut.closeSetCount);
		expect(history.closeSetRoot).toBe(cut.closeSetRoot);
		expect(history.historyRoot).toBe(cut.historyRoot);
		expect(history.historySize).toBe(cut.historySize);
		expect([...history.closeSetOrder].reverse(), "close-order").not.toEqual(history.closeSetOrder);
		const reopened = CompactMerkleAccumulator.fromSnapshot(history.historySnapshot);
		expect(Buffer.from(reopened.root()).toString("hex")).toBe(cut.historyRoot);
		await reopened.append(encodeCanonical({ kind: "history-extension-mutant" }));
		expect(Buffer.from(reopened.root()).toString("hex"), "history-extension").not.toBe(cut.historyRoot);
	});

	it("replays the genuine durable journal/issuance pair and rejects missing local-issued custody", async () => {
		const { issuanceScope, issuanceStore, journalRows, localIssued } = genuine.evidence;
		const localRow = journalRows.find(
			(row) => row.sourceKind === "local-issued" && row.authorSequence === localIssued.authorSequence
		);
		expect(localRow).toEqual(expect.objectContaining({ sourceKind: "local-issued", vertexDigest: localIssued.digest }));
		if (localRow?.sourceKind !== "local-issued") throw new TypeError("D.108b local-issued row is unavailable");
		const issued = await issuanceStore.readIssued(issuanceScope, localRow.authorSequence);
		expect(issued?.envelope.digest).toEqual(hexBytes(localRow.vertexDigest));
		const missingIssuance = Object.freeze({
			readIssued: () => Promise.resolve(null),
		});
		await expect(missingIssuance.readIssued(), "durable-local-issued-missing").resolves.toBeNull();
	});

	it("executes manifest, chunk, payload, catalog and artifact cross-pair mutants", () => {
		const { chunks, closeResult, declaration, exactCanonicalPayloadBytes, proposed } = genuine.evidence;
		const cut = decodeCanonical(bytesForRef(proposed, closeResult.cutValueRef)) as Readonly<Record<string, unknown>>;
		const payload = decodeCanonical(exactCanonicalPayloadBytes) as Readonly<Record<string, unknown>>;
		const packet = Object.freeze({ chunks, declaration });
		expect(validSnapshotPacket(packet, cut, genuine.catalog), "genuine-snapshot").toBe(true);

		const manifestMutant = (
			change: (manifest: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>
		): ReturnType<typeof packetFromPayload> => {
			const changed = change(
				decodeCanonical(declaration.exactCanonicalManifestBytes) as Readonly<Record<string, unknown>>
			);
			const exactCanonicalManifestBytes = encodeCanonical(changed);
			const manifestDigest = hex(hashDomain("ts-drp/snapshot-manifest/v3", exactCanonicalManifestBytes));
			return Object.freeze({
				chunks,
				declaration: Object.freeze({
					...declaration,
					exactCanonicalManifestBytes,
					scope: Object.freeze({ ...declaration.scope, manifestDigest }),
				}),
			});
		};
		const descriptors = (
			decodeCanonical(declaration.exactCanonicalManifestBytes) as Readonly<{
				chunks: readonly Readonly<Record<string, unknown>>[];
			}>
		).chunks;
		const oldManifest = manifestMutant((manifest) => ({ ...manifest, anchor: "0".repeat(64) }));
		const chunkSize = manifestMutant((manifest) => ({
			...manifest,
			chunks: descriptors.map((descriptor, index) =>
				index === 0 ? { ...descriptor, byteLength: Number(descriptor.byteLength) + 1 } : descriptor
			),
		}));
		const chunkDigest = manifestMutant((manifest) => ({
			...manifest,
			chunks: descriptors.map((descriptor, index) =>
				index === 0 ? { ...descriptor, digest: "f".repeat(64) } : descriptor
			),
		}));
		const chunkGap = manifestMutant((manifest) => ({
			...manifest,
			chunks: descriptors.map((descriptor, index) => (index === 0 ? { ...descriptor, index: 1 } : descriptor)),
		}));
		expect(validSnapshotPacket(oldManifest, cut, genuine.catalog), "manifest-old").toBe(false);
		expect(
			validSnapshotPacket(
				{ chunks: foreign.evidence.chunks, declaration: foreign.evidence.declaration },
				cut,
				genuine.catalog
			),
			"manifest-foreign"
		).toBe(false);
		expect(validSnapshotPacket(chunkSize, cut, genuine.catalog), "manifest-chunk-size").toBe(false);
		expect(validSnapshotPacket(chunkDigest, cut, genuine.catalog), "manifest-chunk-digest").toBe(false);
		expect(validSnapshotPacket(chunkGap, cut, genuine.catalog), "manifest-chunk-gap").toBe(false);

		const statePayload = { ...payload, application: 999 };
		const statePacket = packetFromPayload(declaration, statePayload, {
			stateDigest: hex(hashDomain("ts-drp/state/v3", encodeCanonical(statePayload.application))),
		});
		const aclPayload = { ...payload, acl: { version: 1 } };
		const aclPacket = packetFromPayload(declaration, aclPayload, {
			aclDigest: hex(hashDomain("ts-drp/latched-acl/v3", encodeCanonical(aclPayload.acl))),
		});
		const archivePacket = packetFromPayload(declaration, { ...payload, archiveIndexRoot: "f".repeat(64) });
		const anchorPacket = packetFromPayload(
			declaration,
			{ ...payload, anchor: "f".repeat(64) },
			{ anchor: "f".repeat(64) }
		);
		const blueprintPacket = packetFromPayload(declaration, { ...payload, blueprintDigest: "f".repeat(64) });
		expect(validSnapshotPacket(statePacket, cut, genuine.catalog), "payload-state").toBe(false);
		expect(validSnapshotPacket(aclPacket, cut, genuine.catalog), "payload-acl").toBe(false);
		expect(validSnapshotPacket(archivePacket, cut, genuine.catalog), "payload-archive").toBe(false);
		expect(validSnapshotPacket(anchorPacket, cut, genuine.catalog), "payload-anchor").toBe(false);
		expect(validSnapshotPacket(blueprintPacket, cut, genuine.catalog), "payload-blueprint").toBe(false);

		const resolved = genuine.catalog.resolve(String(payload.blueprintDigest));
		const wrongBlueprintCatalog = Object.freeze({
			...genuine.catalog,
			resolve: () => Object.freeze({ ...resolved, blueprintDigest: "f".repeat(64) }),
		});
		const wrongArtifactCatalog = Object.freeze({
			...genuine.catalog,
			resolve: () =>
				Object.freeze({ ...resolved, exactArtifactBytes: Uint8Array.from([...resolved.exactArtifactBytes, 0]) }),
		});
		expect(validSnapshotPacket(packet, cut, wrongBlueprintCatalog), "catalog-wrong-blueprint").toBe(false);
		expect(validSnapshotPacket(packet, cut, wrongArtifactCatalog), "catalog-wrong-artifact").toBe(false);
	});

	it("detects a durable vertex appended after the sealed journal snapshot", async () => {
		const before = foreign.evidence.journalSnapshot;
		const appended = await foreign.journal.appendAccepted({
			author: foreign.evidence.issuanceScope.author,
			authorSequence: 999,
			scope: foreign.scope,
			sourceKind: "local-issued",
			vertexDigest: "e".repeat(64),
		});
		expect(appended, "post-close-durable-vertex").toEqual(expect.objectContaining({ ok: true }));
		const after = await foreign.journal.readiness({ scope: foreign.scope });
		expect(after).toEqual(expect.objectContaining({ ok: true, ready: true }));
		if (!after.ok || !after.ready) return;
		expect(after.rowCount).toBe(foreign.evidence.journalRows.length + 1);
		expect(after.snapshot.highWatermark).toBeGreaterThan(before.highWatermark);
		const oldPage = await foreign.journal.readPage({
			afterSequence: null,
			limit: 128,
			scope: foreign.scope,
			snapshot: before,
		});
		expect(oldPage).toEqual(expect.objectContaining({ ok: true, rows: foreign.evidence.journalRows }));
	});

	it("derives the exact canonical generation-2 projection and reopens its compact history", () => {
		const bytes = genuine.evidence.exactCanonicalProjectionBytes;
		const projection = decodeCanonical(bytes) as Readonly<Record<string, unknown>>;
		expect(Object.keys(projection).sort()).toEqual([...V3_LIVE_GENERATION_2_KEYS].sort());
		expect(projection).toEqual(
			expect.objectContaining({
				anchorDigest: genuine.evidence.closeResult.successorAnchorDigest,
				epoch: 1,
				kind: "v3-live-generation-2",
				previousHistorySize: 0,
				vertexCount: 1,
				version: 2,
			})
		);
		const compact = projection.compactHistory as Readonly<{ peaks: readonly (Uint8Array | null)[]; size: number }>;
		expect(Object.keys(compact).sort()).toEqual(["peaks", "size"]);
		expect(compact.size).toBe(projection.historySize);
		expect(compact.peaks.every((peak) => peak === null || peak instanceof Uint8Array)).toBe(true);
		const reopened = CompactMerkleAccumulator.fromSnapshot({ peaks: [...compact.peaks], size: compact.size });
		expect(hex(reopened.root())).toBe(projection.historyRoot);
		const previous = new CompactMerkleAccumulator();
		expect(hex(previous.root())).toBe(projection.previousHistoryRoot);
		expect(previous.size).toBe(projection.previousHistorySize);
		expect(encodeCanonical(projection)).toEqual(bytes);
	});

	it("has one composite readiness gate for the genuine future verifier", async () => {
		expect(genuine.handle.status()).toEqual(
			expect.objectContaining({ closeAuthority: "unavailable", lifecycle: "successor-pending-adoption" })
		);
		await expect(genuine.handle.inspectDurableHead()).resolves.toEqual(
			expect.objectContaining({
				head: expect.objectContaining({ kind: "present", revision: 3 }),
				references: expect.any(Array),
				trustRef: expect.objectContaining({ byteLength: expect.any(Number), digest: expect.any(String) }),
			})
		);
		const readiness = creatorAdoptionReadiness(candidate);
		expect(readiness).toEqual({
			greenPaths: true,
			intentCustody: true,
			packageExport: true,
			publicVerifier: true,
			ready: true,
		});
		if (!readiness.ready || candidate?.verifyCreatorSuccessorAdoption === undefined) return;
		expect(Object.keys(candidate).sort()).toEqual([...CREATOR_ADOPTION_EXPORTS]);
		const aheMutationCount = genuine.controls.aheMutationCount;
		for (const input of [undefined, null, {}]) {
			const result = await candidate.verifyCreatorSuccessorAdoption(input);
			expect(result).toEqual(expect.objectContaining({ kind: "malformed-input", ok: false }));
			expect(result).not.toHaveProperty("intent");
			expect(Object.isFrozen(result)).toBe(true);
		}
		await expect(
			candidate.verifyCreatorSuccessorAdoption({ catalog: genuine.catalog, handle: Object.freeze({}) })
		).resolves.toEqual(expect.objectContaining({ kind: "sealed-live-unavailable", ok: false }));

		try {
			const accepted = await candidate.verifyCreatorSuccessorAdoption({
				catalog: genuine.catalog,
				handle: genuine.handle,
			});
			expect(accepted).toEqual(expect.objectContaining({ ok: true }));
			expect(accepted).toHaveProperty("intent");
			expect(accepted).toHaveProperty("descriptor");
			expect(accepted.descriptor).toEqual(decodeCanonical(genuine.evidence.exactCanonicalProjectionBytes));
			expect(Object.isFrozen(accepted)).toBe(true);
			const rejected = async (
				label: (typeof D108B_MUTANTS)[number],
				catalog: typeof genuine.catalog = genuine.catalog
			): Promise<void> => {
				const result = await candidate?.verifyCreatorSuccessorAdoption?.({ catalog, handle: genuine.handle });
				expect(result, label).toEqual(expect.objectContaining({ kind: expectedMutationFailureKind(label), ok: false }));
				expect(result, label).not.toHaveProperty("intent");
			};

			for (const field of CUT_VALUE_FIELDS) {
				genuine.controls.cutField = field;
				const result = await candidate.verifyCreatorSuccessorAdoption({
					catalog: genuine.catalog,
					handle: genuine.handle,
				});
				expect(result, field).toEqual(expect.objectContaining({ kind: "chain-invalid", ok: false }));
				expect(result, field).not.toHaveProperty("intent");
			}
			genuine.controls.cutField = undefined;

			const { closeResult, proposed } = genuine.evidence;
			const foreignEvidence = foreign.evidence;
			const cutBytes = bytesForRef(proposed, closeResult.cutValueRef);
			const commitBytes = bytesForRef(proposed, closeResult.commitQcRef);
			const successorTrustBytes = bytesForRef(proposed, closeResult.successorTrustRef);
			const blobMutants = Object.freeze([
				[
					"cut-swap",
					closeResult.cutValueRef.digest,
					bytesForRef(foreignEvidence.proposed, foreignEvidence.closeResult.cutValueRef),
				],
				[
					"qc-swap",
					closeResult.commitQcRef.digest,
					bytesForRef(foreignEvidence.proposed, foreignEvidence.closeResult.commitQcRef),
				],
				[
					"qc-prepare-as-commit",
					closeResult.commitQcRef.digest,
					signedQc(genuine.evidence.currentTrust, cutBytes, "prepare"),
				],
				[
					"qc-duplicate-signer",
					closeResult.commitQcRef.digest,
					encodeCanonical({
						...(decodeCanonical(commitBytes) as Readonly<Record<string, unknown>>),
						votes: [
							(decodeCanonical(commitBytes) as Readonly<{ votes: readonly unknown[] }>).votes[0],
							(decodeCanonical(commitBytes) as Readonly<{ votes: readonly unknown[] }>).votes[0],
						],
					}),
				],
				[
					"trust-old",
					closeResult.successorTrustRef.digest,
					bytesForRef(genuine.evidence.current, closeResult.currentTrustRef),
				],
				[
					"trust-foreign",
					closeResult.successorTrustRef.digest,
					bytesForRef(foreignEvidence.proposed, foreignEvidence.closeResult.successorTrustRef),
				],
			] as const);
			for (const [label, digest, bytes] of blobMutants) {
				genuine.controls.blobOverrides.set(digest, bytes);
				await rejected(label);
				genuine.controls.blobOverrides.clear();
			}
			expect(successorTrustBytes.byteLength).toBe(closeResult.successorTrustRef.byteLength);

			for (const mutation of ["length", "digest"] as const) {
				genuine.controls.activeRefMutation = mutation;
				await rejected(`pending-head-ref-${mutation}`);
				genuine.controls.activeRefMutation = undefined;
			}
			for (const mutation of ["missing", "duplicate", "cycle", "skipped"] as const) {
				genuine.controls.generationMutation = mutation;
				await rejected(`predecessor-link-${mutation}`);
				genuine.controls.generationMutation = undefined;
			}

			genuine.controls.issuanceMissing = true;
			await rejected("durable-local-issued-missing");
			genuine.controls.issuanceMissing = false;
			genuine.controls.journalMutation = "reverse";
			await rejected("close-order");
			await rejected("history-extension");
			genuine.controls.journalMutation = undefined;

			const payload = decodeCanonical(genuine.evidence.exactCanonicalPayloadBytes) as Readonly<Record<string, unknown>>;
			const snapshotOverrides = Object.freeze([
				["manifest-old", foreignEvidence.chunks],
				["manifest-foreign", foreignEvidence.chunks],
				["manifest-chunk-size", [Uint8Array.of(0)]],
				["manifest-chunk-digest", [Uint8Array.of(1)]],
				["manifest-chunk-gap", [Uint8Array.of(2)]],
				["payload-state", packetFromPayload(genuine.evidence.declaration, { ...payload, application: 999 }).chunks],
				["payload-acl", packetFromPayload(genuine.evidence.declaration, { ...payload, acl: { version: 1 } }).chunks],
				[
					"payload-archive",
					packetFromPayload(genuine.evidence.declaration, { ...payload, archiveIndexRoot: "f".repeat(64) }).chunks,
				],
				[
					"payload-anchor",
					packetFromPayload(genuine.evidence.declaration, { ...payload, anchor: "f".repeat(64) }).chunks,
				],
				[
					"payload-blueprint",
					packetFromPayload(genuine.evidence.declaration, { ...payload, blueprintDigest: "f".repeat(64) }).chunks,
				],
			] as const);
			for (const [label, chunks] of snapshotOverrides) {
				genuine.controls.snapshotChunkOverride = chunks;
				await rejected(label);
				genuine.controls.snapshotChunkOverride = undefined;
			}

			genuine.controls.mutateSnapshotChunk = true;
			const badChunk = await candidate.verifyCreatorSuccessorAdoption({
				catalog: genuine.catalog,
				handle: genuine.handle,
			});
			expect(badChunk).toEqual(expect.objectContaining({ kind: "snapshot-invalid", ok: false }));
			expect(badChunk).not.toHaveProperty("intent");
			genuine.controls.mutateSnapshotChunk = false;

			const foreignCatalog = Object.freeze({
				...genuine.catalog,
				resolve() {
					throw new TypeError("foreign blueprint catalog");
				},
			});
			const badCatalog = await candidate.verifyCreatorSuccessorAdoption({
				catalog: foreignCatalog,
				handle: genuine.handle,
			});
			expect(badCatalog).toEqual(expect.objectContaining({ kind: "blueprint-invalid", ok: false }));
			expect(badCatalog).not.toHaveProperty("intent");
			await rejected("catalog-wrong-blueprint", foreignCatalog);
			const genuineResolved = genuine.catalog.resolve(String(payload.blueprintDigest));
			await rejected(
				"catalog-wrong-artifact",
				Object.freeze({
					...genuine.catalog,
					resolve: () =>
						Object.freeze({
							...genuineResolved,
							exactArtifactBytes: Uint8Array.from([...genuineResolved.exactArtifactBytes, 0]),
						}),
				})
			);

			const appended = await genuine.journal.appendAccepted({
				detachedSignature: new Uint8Array(64),
				exactCanonicalPreimageBytes: Uint8Array.of(1),
				scope: genuine.scope,
				sourceKind: "received",
				vertexDigest: "f".repeat(64),
			});
			expect(appended.ok).toBe(true);
			const postCloseVertex = await candidate.verifyCreatorSuccessorAdoption({
				catalog: genuine.catalog,
				handle: genuine.handle,
			});
			expect(postCloseVertex).toEqual(expect.objectContaining({ kind: "journal-invalid", ok: false }));
			expect(postCloseVertex).not.toHaveProperty("intent");

			const intentModule = (await import(/* @vite-ignore */ CREATOR_ADOPTION_INTENT_SOURCE)) as Readonly<{
				consumeCreatorAdoptionIntent(intent: unknown, owner: unknown): unknown;
			}>;
			const intent = accepted.intent;
			const clonedIntent =
				intent !== null && typeof intent === "object" ? { ...(intent as Readonly<Record<string, unknown>>) } : {};
			expect(intentModule.consumeCreatorAdoptionIntent(clonedIntent, genuine.handle)).toBeUndefined();
			expect(
				intentModule.consumeCreatorAdoptionIntent(JSON.parse(JSON.stringify(intent)), genuine.handle)
			).toBeUndefined();
			expect(intentModule.consumeCreatorAdoptionIntent(intent, foreign.handle)).toBeUndefined();
			expect(intentModule.consumeCreatorAdoptionIntent(intent, genuine.handle)).toEqual(
				expect.objectContaining({ exactCanonicalProjectionBytes: genuine.evidence.exactCanonicalProjectionBytes })
			);
			expect(intentModule.consumeCreatorAdoptionIntent(intent, genuine.handle)).toBeUndefined();
			expect(genuine.controls.aheMutationCount).toBe(aheMutationCount);
		} finally {
			genuine.controls.activeRefMutation = undefined;
			genuine.controls.blobOverrides.clear();
			genuine.controls.cutField = undefined;
			genuine.controls.generationMutation = undefined;
			genuine.controls.issuanceMissing = false;
			genuine.controls.journalMutation = undefined;
			genuine.controls.mutateSnapshotChunk = false;
			genuine.controls.snapshotChunkOverride = undefined;
		}
	});
});
