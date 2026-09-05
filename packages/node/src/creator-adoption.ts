import type { ResolvedBlueprintBytes, TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { CloseSetHistoryCommitment } from "@ts-drp/compaction";
import { verifySnapshotStreamWithReceipt } from "@ts-drp/compaction/snapshot-quarantine-receipt";
import type { DurableIssuanceStore, DurableIssueScope } from "@ts-drp/issuance-store";
import type { DurableLiveJournalStore } from "@ts-drp/live-journal";
import { type CurrentAnchorTrust, openCurrentAnchorTrust } from "@ts-drp/protocol-v3";
import { openCreatorCheckpointTrust } from "@ts-drp/protocol-v3/creator-checkpoint";
import { openCreatorSuccessorTrust } from "@ts-drp/protocol-v3/creator-close";
import { openCanonicalLatchedAclSnapshot } from "@ts-drp/protocol-v3/latched-acl";
import { decodeSnapshotManifest, snapshotChunkDigest } from "@ts-drp/protocol-v3/snapshot-transfer";
import {
	type AheDurableStore,
	digestBlob,
	digestClosure,
	type GenerationId,
	type GenerationPageCursor,
	type GenerationRecord,
	type GenerationRef,
	parseGenerationId,
	parseStorageObjectId,
	type PresentHead,
	type StorageObjectId,
} from "@ts-drp/storage";
import type {
	SnapshotQuarantineDeclaration,
	SnapshotQuarantineStore,
	SnapshotVerificationReceipt,
} from "@ts-drp/storage/snapshot-transfer";

import type { CreatorLiveCloseResult } from "./creator-close.js";
import {
	createCreatorAdoptionIntent,
	type CreatorAdoptionIntent,
	resolveCreatorAdoptionFacts,
} from "./internal/creator-adoption-intent.js";
import {
	type CreatorAdoptionPendingRecoveryInput,
	type CreatorAdoptionPendingRecoveryResult,
	type CreatorAdoptionRoomHead,
	installCreatorAdoptionPendingRecovery,
} from "./internal/creator-adoption-recover.js";
import {
	type CreatorSuccessorLiveMaterial,
	type CreatorSuccessorLiveSeed,
	type CreatorSuccessorReopenInput,
	type CreatorSuccessorReopenResult,
	installCreatorSuccessorReopen,
} from "./internal/creator-successor-live.js";
import { inspectCreatorTransitionAdvance } from "./internal/creator-transition-advance.js";

const PROFILE = Object.freeze({
	maxManifestBytes: 212_387,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});
const ED25519_PUBLIC_KEY_HEX = /^[0-9a-f]{64}$/u;

type FailureKind =
	| "malformed-input"
	| "sealed-live-unavailable"
	| "recovery-failed"
	| "chain-invalid"
	| "journal-invalid"
	| "snapshot-invalid"
	| "blueprint-invalid"
	| "internal-invariant";

type AdoptionFailure = Readonly<{ readonly detail: string; readonly kind: FailureKind; readonly ok: false }>;
type AdoptionSuccess = Readonly<{
	readonly descriptor: Readonly<Record<string, unknown>>;
	readonly intent: CreatorAdoptionIntent;
	readonly ok: true;
}>;

interface SealedAdoptionFacts {
	readonly closeResult: CreatorLiveCloseResult;
	readonly currentHead: PresentHead;
	readonly currentReferences: readonly GenerationRef[];
	readonly currentTrust: CurrentAnchorTrust;
	readonly durableReplay: Readonly<{ verify(): Promise<boolean> }>;
	readonly exactCanonicalLatchedAclBytes: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly exactCanonicalPinnedGenesisBootstrapOperationBytes?: Uint8Array;
	readonly history: CloseSetHistoryCommitment;
	readonly issuanceScope: DurableIssueScope;
	readonly issuanceStore: DurableIssuanceStore;
	readonly liveJournalStore: DurableLiveJournalStore;
	readonly objectId: Parameters<AheDurableStore["recoverActiveGeneration"]>[0];
	readonly proposedHead: PresentHead;
	readonly proposedReferences: readonly GenerationRef[];
	readonly snapshotDeclaration: SnapshotQuarantineDeclaration;
	readonly snapshotStore: SnapshotQuarantineStore<SnapshotVerificationReceipt>;
	readonly sourceRuntimeHandle: WeakRef<object>;
	readonly store: AheDurableStore;
	terminalizeSource(): boolean;
}

interface RecoveredClosure {
	readonly currentCandidates: readonly Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>[];
	readonly proposedCandidates: readonly Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>[];
}

interface VerifiedChain {
	readonly currentCatalog: Readonly<{
		readonly artifactDigest: string;
		readonly artifactId: string;
		readonly blueprintDigest: string;
		readonly catalogDigest: string;
		readonly runtimeProfile: string;
	}>;
	readonly currentAnchor: Readonly<Record<string, unknown>>;
	readonly currentEpoch: number;
	readonly currentProjectionKind: "v3-live-generation-1" | "v3-live-generation-2";
	readonly currentTrustRecord: Readonly<Record<string, unknown>>;
	readonly cut: Readonly<Record<string, unknown>>;
	readonly successorAnchor: Readonly<Record<string, unknown>>;
	readonly successorAnchorBytes: Uint8Array;
	readonly successorEpoch: number;
	readonly successorTrust: CurrentAnchorTrust;
	readonly successorTrustRecord: Readonly<Record<string, unknown>>;
}

interface VerifiedSnapshot {
	readonly exactCanonicalPayloadBytes: Uint8Array;
	readonly manifest: Readonly<Record<string, unknown>>;
	readonly payload: Readonly<Record<string, unknown>>;
}

interface CapturedInput {
	readonly catalog: TrustedBlueprintCatalog;
	readonly handle: object;
}

function failure(kind: FailureKind, detail: string): AdoptionFailure {
	return Object.freeze({ detail, kind, ok: false as const });
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function captureInput(value: unknown): CapturedInput | undefined {
	try {
		if (!record(value) || Object.keys(value).sort().join(",") !== "catalog,handle") return undefined;
		const catalog = Object.getOwnPropertyDescriptor(value, "catalog");
		const handle = Object.getOwnPropertyDescriptor(value, "handle");
		if (
			catalog === undefined ||
			!("value" in catalog) ||
			!record(catalog.value) ||
			handle === undefined ||
			!("value" in handle) ||
			!record(handle.value)
		) {
			return undefined;
		}
		return Object.freeze({ catalog: catalog.value as unknown as TrustedBlueprintCatalog, handle: handle.value });
	} catch {
		return undefined;
	}
}

function sameHead(left: PresentHead, right: PresentHead): boolean {
	return (
		left.closureDigest === right.closureDigest &&
		left.generationId === right.generationId &&
		left.objectId === right.objectId &&
		left.revision === right.revision
	);
}

function sameRef(left: GenerationRef, right: GenerationRef): boolean {
	return left.byteLength === right.byteLength && left.digest === right.digest;
}

function sameClosure(left: readonly GenerationRef[], right: readonly GenerationRef[]): boolean {
	return left.length === right.length && left.every((ref, index) => sameRef(ref, right[index] as GenerationRef));
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function currentProjectionKind(epoch: number): "v3-live-generation-1" | "v3-live-generation-2" {
	return epoch === 0 ? "v3-live-generation-1" : "v3-live-generation-2";
}

function canonicalRecord(bytes: Uint8Array): Readonly<Record<string, unknown>> | undefined {
	try {
		const decoded = decodeCanonical(bytes);
		return record(decoded) && sameBytes(encodeCanonical(decoded), bytes) ? decoded : undefined;
	} catch {
		return undefined;
	}
}

function factsFor(handle: unknown): SealedAdoptionFacts | undefined {
	return handle !== null && typeof handle === "object"
		? resolveCreatorAdoptionFacts<SealedAdoptionFacts>(handle)
		: undefined;
}

function validGenerationLineage(generations: readonly GenerationRecord[], facts: SealedAdoptionFacts): boolean {
	const byId = new Map(generations.map((generation) => [generation.generationId, generation]));
	if (byId.size !== generations.length) return false;
	const current = byId.get(facts.currentHead.generationId);
	const proposed = byId.get(facts.proposedHead.generationId);
	if (
		current === undefined ||
		proposed === undefined ||
		current.state !== "Superseded" ||
		proposed.state !== "Adopted" ||
		proposed.baseExpectedHead.kind !== "present" ||
		!sameHead(proposed.baseExpectedHead, facts.currentHead) ||
		!sameClosure(current.closure, facts.currentReferences) ||
		!sameClosure(proposed.closure, facts.proposedReferences)
	) {
		return false;
	}
	for (const generation of generations) {
		if (new Set(generation.closure.map(({ digest }) => digest)).size !== generation.closure.length) return false;
		if (
			generation.baseExpectedHead.kind === "present" &&
			(generation.baseExpectedHead.generationId === generation.generationId ||
				!byId.has(generation.baseExpectedHead.generationId))
		) {
			return false;
		}
	}
	return facts.proposedHead.revision === facts.currentHead.revision + 1;
}

async function loadClosure(
	store: AheDurableStore,
	references: readonly GenerationRef[]
): Promise<readonly Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>[] | undefined> {
	const candidates: Array<Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>> = [];
	for (const ref of references) {
		const loaded = await store.getBlob(ref.digest);
		if (!loaded.ok || loaded.value === null) return undefined;
		candidates.push(Object.freeze({ bytes: Uint8Array.from(loaded.value), ref: Object.freeze({ ...ref }) }));
	}
	return Object.freeze(candidates);
}

async function readGenerationLineage(
	store: AheDurableStore,
	objectId: StorageObjectId
): Promise<readonly GenerationRecord[] | undefined> {
	const generations: GenerationRecord[] = [];
	const seenCursors = new Set<GenerationPageCursor>();
	let cursor: GenerationPageCursor | undefined;
	for (;;) {
		const page = await store.readGenerationPage({
			...(cursor === undefined ? {} : { cursor }),
			limit: 128,
			objectId,
		});
		if (!page.ok || (page.value.generations.length === 0 && page.value.nextCursor !== null)) return undefined;
		generations.push(...page.value.generations);
		if (page.value.nextCursor === null) return Object.freeze(generations);
		if (seenCursors.has(page.value.nextCursor)) return undefined;
		seenCursors.add(page.value.nextCursor);
		cursor = page.value.nextCursor;
	}
}

async function recoverClosure(facts: SealedAdoptionFacts): Promise<RecoveredClosure | undefined> {
	const recovered = await facts.store.recoverActiveGeneration(facts.objectId);
	if (!recovered.ok || recovered.value.kind !== "active") return undefined;
	const active = recovered.value;
	const pending = sameHead(active.head, facts.proposedHead);
	const adopted =
		!pending &&
		active.head.objectId === facts.proposedHead.objectId &&
		active.head.revision === facts.proposedHead.revision + 1 &&
		active.adoptedGeneration.baseExpectedHead.kind === "present" &&
		sameHead(active.adoptedGeneration.baseExpectedHead, facts.proposedHead);
	if (!pending && !adopted) return undefined;
	if (
		pending &&
		(active.references.length !== facts.proposedReferences.length ||
			active.adoptedGeneration.closure.length !== facts.proposedReferences.length ||
			!facts.proposedReferences.every((ref, index) => sameRef(ref, active.references[index] as GenerationRef)) ||
			!facts.proposedReferences.every((ref, index) =>
				sameRef(ref, active.adoptedGeneration.closure[index] as GenerationRef)
			))
	) {
		return undefined;
	}
	const closureDigest = digestClosure(active.references);
	if (!closureDigest.ok || closureDigest.value !== active.head.closureDigest) return undefined;
	const generations = await readGenerationLineage(facts.store, facts.objectId);
	if (generations === undefined) return undefined;
	if (pending && !validGenerationLineage(generations, facts)) return undefined;
	if (adopted) {
		const current = generations.find(({ generationId }) => generationId === facts.currentHead.generationId);
		const proposed = generations.find(({ generationId }) => generationId === facts.proposedHead.generationId);
		const successor = generations.find(({ generationId }) => generationId === active.head.generationId);
		if (
			current?.state !== "Superseded" ||
			proposed?.state !== "Superseded" ||
			successor?.state !== "Adopted" ||
			proposed.baseExpectedHead.kind !== "present" ||
			!sameHead(proposed.baseExpectedHead, facts.currentHead) ||
			successor.baseExpectedHead.kind !== "present" ||
			!sameHead(successor.baseExpectedHead, facts.proposedHead)
		) {
			return undefined;
		}
	}
	const [currentCandidates, proposedCandidates] = await Promise.all([
		loadClosure(facts.store, facts.currentReferences),
		loadClosure(facts.store, facts.proposedReferences),
	]);
	return currentCandidates === undefined || proposedCandidates === undefined
		? undefined
		: Object.freeze({ currentCandidates, proposedCandidates });
}

function bytesForRef(candidates: RecoveredClosure["proposedCandidates"], ref: GenerationRef): Uint8Array | undefined {
	return candidates.find((candidate) => sameRef(candidate.ref, ref))?.bytes;
}

function verifyChain(facts: SealedAdoptionFacts, closure: RecoveredClosure): VerifiedChain | undefined {
	const { closeResult } = facts;
	const cutBytes = bytesForRef(closure.proposedCandidates, closeResult.cutValueRef);
	const commitBytes = bytesForRef(closure.proposedCandidates, closeResult.commitQcRef);
	const successorTrustBytes = bytesForRef(closure.proposedCandidates, closeResult.successorTrustRef);
	const currentTrustBytes = closure.currentCandidates.find((candidate) =>
		sameRef(candidate.ref, closeResult.currentTrustRef)
	)?.bytes;
	if (
		cutBytes === undefined ||
		commitBytes === undefined ||
		successorTrustBytes === undefined ||
		currentTrustBytes === undefined
	) {
		return undefined;
	}
	const opened = openCreatorSuccessorTrust({
		currentTrust: facts.currentTrust,
		exactCanonicalCommitQcBytes: commitBytes,
		exactCanonicalCutValueBytes: cutBytes,
		exactCanonicalTrustStateRecordBytes: successorTrustBytes,
	});
	if (
		!opened.ok ||
		opened.trust.currentAnchorDigest !== closeResult.successorAnchorDigest ||
		opened.trust.currentEpoch !== closeResult.successorEpoch
	) {
		return undefined;
	}
	const advance = inspectCreatorTransitionAdvance({
		current: { candidates: closure.currentCandidates, closure: facts.currentReferences },
		currentTrust: facts.currentTrust,
		mode: "verify",
		proofRefs: [closeResult.cutValueRef, closeResult.commitQcRef],
		proposed: { candidates: closure.proposedCandidates, closure: facts.proposedReferences },
		successorTrust: opened.trust,
	});
	if (!advance.ok) return undefined;
	const cut = canonicalRecord(cutBytes);
	const currentTrustRecord = canonicalRecord(currentTrustBytes);
	const successorTrustRecord = canonicalRecord(successorTrustBytes);
	if (
		cut === undefined ||
		currentTrustRecord === undefined ||
		successorTrustRecord === undefined ||
		!(currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array) ||
		!(successorTrustRecord.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array)
	) {
		return undefined;
	}
	const currentAnchor = canonicalRecord(currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes);
	const successorAnchorBytes = Uint8Array.from(successorTrustRecord.exactCanonicalCurrentAnchorPreimageBytes);
	const successorAnchor = canonicalRecord(successorAnchorBytes);
	const currentEpoch = facts.currentTrust.currentEpoch;
	const successorEpoch = opened.trust.currentEpoch;
	if (
		!Number.isSafeInteger(currentEpoch) ||
		currentEpoch < 0 ||
		!Number.isSafeInteger(successorEpoch) ||
		successorEpoch !== currentEpoch + 1 ||
		facts.closeResult.epoch !== currentEpoch ||
		facts.closeResult.successorEpoch !== successorEpoch ||
		currentTrustRecord.currentEpoch !== currentEpoch ||
		successorTrustRecord.currentEpoch !== successorEpoch ||
		currentAnchor?.epoch !== currentEpoch ||
		successorAnchor?.epoch !== successorEpoch ||
		successorAnchor?.previousAnchor !== facts.currentTrust.currentAnchorDigest
	) {
		return undefined;
	}
	const expectedCurrentProjectionKind = currentProjectionKind(currentEpoch);
	const projections = closure.currentCandidates
		.map(({ bytes }) => canonicalRecord(bytes))
		.filter((candidate) => candidate?.kind === expectedCurrentProjectionKind);
	const currentProjection = projections.length === 1 ? projections[0] : undefined;
	if (
		currentAnchor === undefined ||
		successorAnchor === undefined ||
		currentProjection === undefined ||
		currentProjection.epoch !== currentEpoch ||
		typeof currentProjection.artifactDigest !== "string" ||
		typeof currentProjection.artifactId !== "string" ||
		typeof currentProjection.blueprintDigest !== "string" ||
		typeof currentProjection.catalogDigest !== "string" ||
		typeof currentProjection.runtimeProfile !== "string" ||
		currentProjection.blueprintDigest !== currentAnchor.blueprintDigest ||
		currentProjection.blueprintDigest !== successorAnchor.blueprintDigest
	) {
		return undefined;
	}
	return Object.freeze({
		currentAnchor,
		currentEpoch,
		currentProjectionKind: expectedCurrentProjectionKind,
		currentTrustRecord,
		currentCatalog: Object.freeze({
			artifactDigest: currentProjection.artifactDigest,
			artifactId: currentProjection.artifactId,
			blueprintDigest: currentProjection.blueprintDigest,
			catalogDigest: currentProjection.catalogDigest,
			runtimeProfile: currentProjection.runtimeProfile,
		}),
		cut,
		successorAnchor,
		successorAnchorBytes,
		successorEpoch,
		successorTrust: opened.trust,
		successorTrustRecord,
	});
}

async function verifySnapshot(
	facts: Pick<SealedAdoptionFacts, "snapshotDeclaration" | "snapshotStore">,
	chain: VerifiedChain
): Promise<VerifiedSnapshot | undefined> {
	let scope: Awaited<ReturnType<SealedAdoptionFacts["snapshotStore"]["openScope"]>> | undefined;
	let port: ReturnType<NonNullable<typeof scope>["verificationQuarantine"]["open"]> | undefined;
	try {
		const decoded = decodeSnapshotManifest({
			exactCanonicalManifestBytes: facts.snapshotDeclaration.exactCanonicalManifestBytes,
			expectedManifestDigest: facts.snapshotDeclaration.scope.manifestDigest,
			profile: PROFILE,
		});
		scope = await facts.snapshotStore.openScope(facts.snapshotDeclaration);
		port = scope.verificationQuarantine.open(new AbortController().signal);
		const chunks: Uint8Array[] = [];
		const readChunk = async (descriptor: Readonly<{ readonly index: number }>): Promise<Uint8Array | undefined> => {
			const selected = decoded.chunks[descriptor.index];
			if (selected === undefined) return undefined;
			const bytes = await port?.read(selected);
			if (
				bytes === undefined ||
				bytes.byteLength !== selected.byteLength ||
				snapshotChunkDigest(selected.index, bytes) !== selected.digest
			) {
				return undefined;
			}
			chunks[selected.index] = Uint8Array.from(bytes);
			return bytes;
		};
		const status = await scope.status();
		if (status.kind === "verified") {
			for (const descriptor of decoded.chunks) {
				if ((await readChunk(descriptor)) === undefined) return undefined;
			}
		} else {
			const verified = verifySnapshotStreamWithReceipt({
				exactCanonicalManifestBytes: facts.snapshotDeclaration.exactCanonicalManifestBytes,
				expectedManifestDigest: facts.snapshotDeclaration.scope.manifestDigest,
				expectedScope: facts.snapshotDeclaration.scope,
				profile: PROFILE,
				quarantine: scope.verificationQuarantine,
				source: Object.freeze({ read: readChunk }),
			});
			await verified.completion;
			await scope.complete(await verified.receipt);
		}
		for (const descriptor of decoded.chunks) {
			if (chunks[descriptor.index] === undefined && (await readChunk(descriptor)) === undefined) return undefined;
		}
		if (chunks.length !== decoded.chunks.length || chunks.some((chunk) => chunk === undefined)) return undefined;
		const payloadBytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
		let offset = 0;
		for (const chunk of chunks) {
			payloadBytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const payload = canonicalRecord(payloadBytes);
		const manifest = canonicalRecord(facts.snapshotDeclaration.exactCanonicalManifestBytes);
		if (
			payload === undefined ||
			manifest === undefined ||
			facts.snapshotDeclaration.scope.manifestDigest !== chain.cut.snapshotManifestDigest ||
			hex(hashDomain("ts-drp/snapshot-payload/v3", payloadBytes)) !== manifest.payloadDigest ||
			payload.anchor !== manifest.anchor ||
			payload.anchor !== chain.cut.previousAnchor ||
			payload.objectId !== chain.cut.objectId ||
			payload.epoch !== chain.cut.epoch ||
			payload.archiveIndexRoot !== chain.cut.archiveIndexRoot ||
			payload.blueprintDigest !== chain.cut.blueprintDigest ||
			manifest.stateDigest !== chain.cut.stateDigest ||
			manifest.aclDigest !== chain.cut.aclDigest ||
			hex(hashDomain("ts-drp/state/v3", encodeCanonical(payload.application))) !== manifest.stateDigest ||
			hex(hashDomain("ts-drp/latched-acl/v3", encodeCanonical(payload.acl))) !== manifest.aclDigest
		) {
			return undefined;
		}
		return Object.freeze({ exactCanonicalPayloadBytes: payloadBytes, manifest, payload });
	} catch {
		return undefined;
	} finally {
		try {
			await port?.discard();
		} finally {
			await scope?.release();
		}
	}
}

function verifiedCatalog(
	catalog: TrustedBlueprintCatalog,
	blueprintDigest: unknown,
	expected: VerifiedChain["currentCatalog"]
): ResolvedBlueprintBytes | undefined {
	try {
		if (typeof blueprintDigest !== "string") return undefined;
		const resolved = catalog.resolve(blueprintDigest);
		return resolved.blueprintDigest === blueprintDigest &&
			resolved.blueprintDigest === expected.blueprintDigest &&
			resolved.artifactDigest === hex(hashDomain("ts-drp/blueprint-artifact/v3", resolved.exactArtifactBytes)) &&
			resolved.artifactDigest === expected.artifactDigest &&
			resolved.artifactId === expected.artifactId &&
			resolved.runtimeProfile === expected.runtimeProfile &&
			resolved.evidence.catalogDigest === expected.catalogDigest &&
			resolved.evidence.catalogDigest === catalog.catalogDigest
			? resolved
			: undefined;
	} catch {
		return undefined;
	}
}

function projection(
	facts: SealedAdoptionFacts,
	chain: VerifiedChain,
	snapshot: VerifiedSnapshot,
	resolved: NonNullable<ReturnType<typeof verifiedCatalog>>
): Readonly<{ readonly bytes: Uint8Array; readonly descriptor: Readonly<Record<string, unknown>> }> | undefined {
	try {
		const parameters = record(chain.cut.parameters) ? chain.cut.parameters : undefined;
		if (
			parameters === undefined ||
			chain.cut.previousHistoryRoot !== chain.currentAnchor.historyRoot ||
			chain.cut.previousHistorySize !== chain.currentAnchor.historySize ||
			chain.cut.historyRoot !== facts.history.historyRoot ||
			chain.cut.historySize !== facts.history.historySize
		) {
			return undefined;
		}
		const ordered = encodeCanonical({
			kind: "v3-live-order-1",
			vertexHashes: [facts.closeResult.successorAnchorDigest],
		});
		const graph = encodeCanonical({
			charges: [{ byteCharge: chain.successorAnchorBytes.byteLength, hash: facts.closeResult.successorAnchorDigest }],
			kind: "v3-live-graph-1",
			vertices: [
				{
					dependencies: [],
					epoch: chain.successorEpoch,
					hash: facts.closeResult.successorAnchorDigest,
					kind: "drp-epoch-anchor",
					objectId: chain.successorAnchor.objectId,
				},
			],
		});
		const orderDigest = digestBlob(ordered);
		const graphDigest = digestBlob(graph);
		if (!orderDigest.ok || !graphDigest.ok) return undefined;
		const bytes = encodeCanonical({
			aclDigest: chain.successorAnchor.aclDigest,
			anchorDigest: facts.closeResult.successorAnchorDigest,
			archiveIndexRoot: chain.successorAnchor.archiveIndexRoot,
			artifactDigest: resolved.artifactDigest,
			artifactId: resolved.artifactId,
			blueprintDigest: chain.successorAnchor.blueprintDigest,
			byteCharge: chain.successorAnchorBytes.byteLength,
			catalogDigest: resolved.evidence.catalogDigest,
			compactHistory: facts.history.historySnapshot,
			epoch: chain.successorEpoch,
			graphDigest: graphDigest.value,
			historyRoot: facts.history.historyRoot,
			historySize: facts.history.historySize,
			kind: "v3-live-generation-2",
			maxDependencies: parameters.maxDependencies,
			maxEpochBytes: parameters.maxEpochBytes,
			maxEpochVertices: parameters.maxEpochVertices,
			objectId: chain.successorAnchor.objectId,
			orderedVertexHashesDigest: orderDigest.value,
			parametersDigest: chain.successorAnchor.parametersDigest,
			previousHistoryRoot: chain.currentAnchor.historyRoot,
			previousHistorySize: chain.currentAnchor.historySize,
			profileDigest: chain.successorAnchor.profileDigest,
			runtimeProfile: resolved.runtimeProfile,
			signerSetDigest: chain.successorAnchor.signerSetDigest,
			snapshotManifestDigest: chain.cut.snapshotManifestDigest,
			snapshotPayloadDigest: snapshot.manifest.payloadDigest,
			stateDigest: chain.successorAnchor.stateDigest,
			trustProfile: "creator-only",
			vertexCount: 1,
			version: 2,
		});
		const descriptor = canonicalRecord(bytes);
		return descriptor === undefined ? undefined : Object.freeze({ bytes, descriptor: Object.freeze(descriptor) });
	} catch {
		return undefined;
	}
}

function successorCommitMaterial(
	facts: SealedAdoptionFacts,
	closure: RecoveredClosure,
	exactCanonicalProjectionBytes: Uint8Array,
	predecessorKind: VerifiedChain["currentProjectionKind"]
):
	| Readonly<{
			readonly candidateReferences: readonly GenerationRef[];
			readonly generationId: GenerationId;
			readonly predecessorLiveRef: GenerationRef;
	  }>
	| undefined {
	try {
		const predecessors = closure.currentCandidates.filter(({ bytes, ref }) => {
			const decoded = canonicalRecord(bytes);
			return decoded?.kind === predecessorKind && facts.proposedReferences.some((candidate) => sameRef(candidate, ref));
		});
		if (predecessors.length !== 1) return undefined;
		const predecessorLiveRef = predecessors[0]?.ref;
		if (predecessorLiveRef === undefined) return undefined;
		const projectionDigest = digestBlob(exactCanonicalProjectionBytes);
		if (!projectionDigest.ok) return undefined;
		const projectionRef = Object.freeze({
			byteLength: exactCanonicalProjectionBytes.byteLength,
			digest: projectionDigest.value,
		});
		const predecessorAclDigest = digestBlob(facts.exactCanonicalLatchedAclBytes);
		if (!predecessorAclDigest.ok) return undefined;
		const predecessorAclRef = Object.freeze({
			byteLength: facts.exactCanonicalLatchedAclBytes.byteLength,
			digest: predecessorAclDigest.value,
		});
		const retained = facts.proposedReferences.filter((candidate) => !sameRef(candidate, predecessorLiveRef));
		const candidateReferences = Object.freeze(
			[
				...retained,
				projectionRef,
				...(retained.some((candidate) => sameRef(candidate, predecessorAclRef)) ? [] : [predecessorAclRef]),
			].sort((left, right) => (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0))
		);
		if (
			!candidateReferences.some((candidate) => sameRef(candidate, predecessorAclRef)) ||
			new Set(candidateReferences.map(({ digest }) => digest)).size !== candidateReferences.length
		) {
			return undefined;
		}
		const random = new Uint8Array(32);
		crypto.getRandomValues(random);
		const parsed = parseGenerationId(hex(random));
		return parsed.ok
			? Object.freeze({ candidateReferences, generationId: parsed.value, predecessorLiveRef })
			: undefined;
	} catch {
		return undefined;
	}
}

function creatorSuccessorLiveSeed(
	facts: SealedAdoptionFacts,
	closure: RecoveredClosure,
	chain: VerifiedChain,
	snapshot: VerifiedSnapshot,
	resolved: ResolvedBlueprintBytes,
	projected: Readonly<{ readonly bytes: Uint8Array; readonly descriptor: Readonly<Record<string, unknown>> }>,
	commitMaterial: NonNullable<ReturnType<typeof successorCommitMaterial>>
): CreatorSuccessorLiveSeed | undefined {
	try {
		const predecessorProjection = closure.currentCandidates.filter(
			({ bytes, ref }) =>
				canonicalRecord(bytes)?.kind === chain.currentProjectionKind && sameRef(ref, commitMaterial.predecessorLiveRef)
		);
		const exactCanonicalLatchedAclBytes = encodeCanonical(snapshot.payload.acl);
		if (
			predecessorProjection.length !== 1 ||
			hex(hashDomain("ts-drp/latched-acl/v3", exactCanonicalLatchedAclBytes)) !== chain.successorAnchor.aclDigest ||
			typeof snapshot.manifest.payloadDigest !== "string" ||
			typeof snapshot.manifest.stateDigest !== "string" ||
			!(chain.currentTrustRecord.detachedCurrentAnchorSignature instanceof Uint8Array) ||
			!(chain.currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array) ||
			!(chain.successorTrustRecord.detachedCurrentAnchorSignature instanceof Uint8Array)
		) {
			return undefined;
		}
		const projectionDigest = digestBlob(projected.bytes);
		const predecessorAclDigest = digestBlob(facts.exactCanonicalLatchedAclBytes);
		if (!projectionDigest.ok || !predecessorAclDigest.ok) return undefined;
		const projectionRef = Object.freeze({ byteLength: projected.bytes.byteLength, digest: projectionDigest.value });
		const predecessorAclRef = Object.freeze({
			byteLength: facts.exactCanonicalLatchedAclBytes.byteLength,
			digest: predecessorAclDigest.value,
		});
		const successorCandidates = commitMaterial.candidateReferences.map((ref) => {
			if (sameRef(ref, projectionRef)) return Object.freeze({ bytes: Uint8Array.from(projected.bytes), ref });
			if (sameRef(ref, predecessorAclRef)) {
				return Object.freeze({ bytes: Uint8Array.from(facts.exactCanonicalLatchedAclBytes), ref });
			}
			const candidate = closure.proposedCandidates.find((entry) => sameRef(entry.ref, ref));
			if (candidate === undefined) throw new TypeError("creator successor candidate is unavailable");
			return Object.freeze({ bytes: Uint8Array.from(candidate.bytes), ref: Object.freeze({ ...ref }) });
		});
		return Object.freeze({
			catalog: factsForCatalog(resolved),
			exactCanonicalLatchedAclBytes: Uint8Array.from(exactCanonicalLatchedAclBytes),
			exactCanonicalParametersCarrierBytes: Uint8Array.from(facts.exactCanonicalParametersCarrierBytes),
			exactCanonicalPinnedGenesisBootstrapOperationBytes:
				facts.exactCanonicalPinnedGenesisBootstrapOperationBytes === undefined
					? undefined
					: Uint8Array.from(facts.exactCanonicalPinnedGenesisBootstrapOperationBytes),
			exactCanonicalSnapshotPayloadBytes: Uint8Array.from(snapshot.exactCanonicalPayloadBytes),
			issuanceScope: Object.freeze({ ...facts.issuanceScope }),
			issuanceStore: facts.issuanceStore,
			liveJournalStore: facts.liveJournalStore,
			pinnedGenesisAnchorDigest: facts.currentTrust.genesisAnchorDigest,
			predecessor: Object.freeze({
				candidates: Object.freeze(closure.currentCandidates),
				detachedAnchorSignature: Uint8Array.from(chain.currentTrustRecord.detachedCurrentAnchorSignature),
				exactCanonicalAnchorPreimageBytes: Uint8Array.from(
					chain.currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes
				),
				exactCanonicalProjectionBytes: Uint8Array.from(predecessorProjection[0]?.bytes as Uint8Array),
				head: Object.freeze({ ...facts.currentHead }),
				references: Object.freeze(facts.currentReferences.map((ref) => Object.freeze({ ...ref }))),
				trust: facts.currentTrust,
				trustRef: Object.freeze({ ...facts.closeResult.currentTrustRef }),
			}),
			predecessorExactCanonicalLatchedAclBytes: Uint8Array.from(facts.exactCanonicalLatchedAclBytes),
			snapshotPayloadDigest: snapshot.manifest.payloadDigest,
			sourceRuntimeHandle: facts.sourceRuntimeHandle,
			stateDigest: snapshot.manifest.stateDigest,
			store: facts.store,
			successor: Object.freeze({
				candidates: Object.freeze(successorCandidates),
				detachedAnchorSignature: Uint8Array.from(chain.successorTrustRecord.detachedCurrentAnchorSignature),
				exactCanonicalAnchorPreimageBytes: Uint8Array.from(chain.successorAnchorBytes),
				exactCanonicalProjectionBytes: Uint8Array.from(projected.bytes),
				references: Object.freeze(commitMaterial.candidateReferences.map((ref) => Object.freeze({ ...ref }))),
				trust: chain.successorTrust,
				trustRef: Object.freeze({ ...facts.closeResult.successorTrustRef }),
			}),
			terminalizeSource: facts.terminalizeSource,
		});
	} catch {
		return undefined;
	}
}

function factsForCatalog(resolved: ResolvedBlueprintBytes): TrustedBlueprintCatalog {
	return Object.freeze({
		blueprintDigests: Object.freeze([resolved.blueprintDigest]),
		catalogDigest: resolved.evidence.catalogDigest,
		resolve: (blueprintDigest: string) => {
			if (blueprintDigest !== resolved.blueprintDigest) throw new TypeError("blueprint is not catalogued");
			return resolved;
		},
	}) as TrustedBlueprintCatalog;
}

/**
 * Verifies a sealed creator close and mints one owner-bound, one-use successor-adoption intent.
 * @param input - Genuine sealed close handle and trusted blueprint catalog.
 * @returns Frozen failure or verified descriptor with an opaque adoption intent.
 */
export async function verifyCreatorSuccessorAdoption(input: unknown): Promise<AdoptionFailure | AdoptionSuccess> {
	const captured = captureInput(input);
	if (captured === undefined) {
		return failure("malformed-input", "creator adoption input is invalid");
	}
	const facts = factsFor(captured.handle);
	if (facts === undefined) return failure("sealed-live-unavailable", "sealed creator live evidence is unavailable");
	try {
		const closure = await recoverClosure(facts);
		if (closure === undefined) return failure("recovery-failed", "creator close generation recovery failed");
		const chain = verifyChain(facts, closure);
		if (chain === undefined) return failure("chain-invalid", "creator successor trust chain is invalid");
		if (!(await facts.durableReplay.verify())) {
			return failure("journal-invalid", "creator close durable replay is invalid");
		}
		const snapshot = await verifySnapshot(facts, chain);
		if (snapshot === undefined) return failure("snapshot-invalid", "creator close snapshot is invalid");
		const resolved = verifiedCatalog(captured.catalog, snapshot.payload.blueprintDigest, chain.currentCatalog);
		if (resolved === undefined) return failure("blueprint-invalid", "creator successor blueprint is invalid");
		const projected = projection(facts, chain, snapshot, resolved);
		if (projected === undefined) return failure("internal-invariant", "creator successor projection failed");
		const commitMaterial = successorCommitMaterial(facts, closure, projected.bytes, chain.currentProjectionKind);
		if (commitMaterial === undefined) {
			return failure("internal-invariant", "creator successor commit material failed");
		}
		const activation = creatorSuccessorLiveSeed(facts, closure, chain, snapshot, resolved, projected, commitMaterial);
		if (activation === undefined) return failure("internal-invariant", "creator successor activation material failed");
		return Object.freeze({
			descriptor: projected.descriptor,
			intent: createCreatorAdoptionIntent(captured.handle, {
				activation,
				candidateReferences: commitMaterial.candidateReferences,
				exactCanonicalProjectionBytes: projected.bytes,
				generationId: commitMaterial.generationId,
				pendingHead: facts.proposedHead,
				pendingReferences: facts.proposedReferences,
				predecessorLiveRef: commitMaterial.predecessorLiveRef,
			}),
			ok: true as const,
		});
	} catch {
		return failure("internal-invariant", "creator adoption verification failed unexpectedly");
	}
}

function coldFailure(kind: string, detail: string): CreatorSuccessorReopenResult {
	return Object.freeze({ detail, kind, ok: false as const });
}

function uniqueCandidateByKind(
	candidates: readonly Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>[],
	kind: string
):
	| Readonly<{
			readonly bytes: Uint8Array;
			readonly record: Readonly<Record<string, unknown>>;
			readonly ref: GenerationRef;
	  }>
	| undefined {
	const matches = candidates.flatMap((candidate) => {
		const decoded = canonicalRecord(candidate.bytes);
		return decoded?.kind === kind ? [Object.freeze({ ...candidate, record: decoded })] : [];
	});
	return matches.length === 1 ? matches[0] : undefined;
}

function presentBase(generation: GenerationRecord): PresentHead | undefined {
	return generation.baseExpectedHead.kind === "present" ? Object.freeze({ ...generation.baseExpectedHead }) : undefined;
}

type AuthenticatedSuccessorIssuanceScopeResult =
	| Readonly<{ readonly ok: true; readonly scope: DurableIssueScope }>
	| Readonly<{ readonly ok: false; readonly reason: "authority" | "lineage" | "possession" }>;

async function authenticatedSuccessorIssuanceScope(
	input: CreatorSuccessorReopenInput,
	objectId: StorageObjectId,
	expectedAclDigest: string,
	expectedEpoch: number,
	exactCanonicalLatchedAclBytes: Uint8Array
): Promise<AuthenticatedSuccessorIssuanceScopeResult> {
	let writers: readonly string[];
	try {
		const opened = openCanonicalLatchedAclSnapshot({
			exactCanonicalLatchedAclBytes,
			expectedAclDigest,
			expectedEpoch,
			expectedObjectId: objectId,
		});
		if (!opened.ok) return Object.freeze({ ok: false as const, reason: "authority" as const });
		writers = opened.snapshot.members.flatMap(({ author, groups }) =>
			opened.snapshot.permissionless || groups.includes("writer") ? [author] : []
		);
		if (
			writers.length === 0 ||
			new Set(writers).size !== writers.length ||
			!ED25519_PUBLIC_KEY_HEX.test(input.author) ||
			!writers.includes(input.author)
		) {
			return Object.freeze({ ok: false as const, reason: "authority" as const });
		}
	} catch {
		return Object.freeze({ ok: false as const, reason: "authority" as const });
	}
	try {
		const webCrypto = globalThis.crypto;
		if (
			webCrypto === undefined ||
			typeof webCrypto.getRandomValues !== "function" ||
			webCrypto.subtle === undefined ||
			typeof webCrypto.subtle.importKey !== "function" ||
			typeof webCrypto.subtle.verify !== "function"
		) {
			return Object.freeze({ ok: false as const, reason: "possession" as const });
		}
		const challenge = new Uint8Array(32);
		webCrypto.getRandomValues(challenge);
		const retainedChallenge = Uint8Array.from(challenge);
		const signerChallenge = Uint8Array.from(challenge);
		const signature = await input.signRegisteredVertexDigest(signerChallenge);
		if (
			!sameBytes(signerChallenge, retainedChallenge) ||
			!(signature instanceof Uint8Array) ||
			Object.getPrototypeOf(signature) !== Uint8Array.prototype ||
			signature.byteOffset !== 0 ||
			signature.byteLength !== 64 ||
			signature.buffer.byteLength !== 64
		) {
			return Object.freeze({ ok: false as const, reason: "possession" as const });
		}
		const authorBytes = Uint8Array.from(input.author.match(/.{2}/gu)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
		const publicKey = await webCrypto.subtle.importKey("raw", authorBytes, { name: "Ed25519" }, false, ["verify"]);
		if (!(await webCrypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, retainedChallenge))) {
			return Object.freeze({ ok: false as const, reason: "possession" as const });
		}
	} catch {
		return Object.freeze({ ok: false as const, reason: "possession" as const });
	}
	try {
		for (const author of writers) {
			const scope = Object.freeze({ author, objectId });
			const lineage = await input.issuanceStore.readLineage(scope);
			if (lineage.exhausted !== false || !Number.isSafeInteger(lineage.next) || lineage.next < 0) {
				return Object.freeze({ ok: false as const, reason: "lineage" as const });
			}
			if (author !== input.author && lineage.next !== 0) {
				return Object.freeze({ ok: false as const, reason: "lineage" as const });
			}
		}
		return Object.freeze({ ok: true as const, scope: Object.freeze({ author: input.author, objectId }) });
	} catch {
		return Object.freeze({ ok: false as const, reason: "lineage" as const });
	}
}

async function reopenCreatorSuccessorMaterial(
	input: CreatorSuccessorReopenInput
): Promise<CreatorSuccessorReopenResult> {
	try {
		const rawBootstrapOperationBytes = input.exactCanonicalPinnedGenesisBootstrapOperationBytes;
		const exactCanonicalPinnedGenesisBootstrapOperationBytes =
			rawBootstrapOperationBytes === undefined
				? undefined
				: rawBootstrapOperationBytes instanceof Uint8Array &&
					  Object.getPrototypeOf(rawBootstrapOperationBytes) === Uint8Array.prototype
					? Uint8Array.from(rawBootstrapOperationBytes)
					: undefined;
		if (rawBootstrapOperationBytes !== undefined && exactCanonicalPinnedGenesisBootstrapOperationBytes === undefined) {
			return coldFailure("malformed-input", "creator successor bootstrap policy input is invalid");
		}
		const parsedObjectId = parseStorageObjectId(input.snapshotDeclaration.scope.objectId);
		if (!parsedObjectId.ok) return coldFailure("chain-invalid", "creator successor object identity is invalid");
		const objectId = parsedObjectId.value;
		const recovered = await input.store.recoverActiveGeneration(objectId);
		if (!recovered.ok || recovered.value.kind !== "active") {
			return coldFailure("storage-failed", "creator successor durable generation is unavailable");
		}
		const active = recovered.value;
		const proposedHead = presentBase(active.adoptedGeneration);
		const lineage = await readGenerationLineage(input.store, objectId);
		const proposedGeneration = lineage?.find((generation) => generation.generationId === proposedHead?.generationId);
		const currentHead = proposedGeneration === undefined ? undefined : presentBase(proposedGeneration);
		const currentGeneration = lineage?.find((generation) => generation.generationId === currentHead?.generationId);
		if (
			proposedHead === undefined ||
			currentHead === undefined ||
			proposedGeneration === undefined ||
			currentGeneration === undefined ||
			active.head.revision !== proposedHead.revision + 1 ||
			proposedHead.revision !== currentHead.revision + 1 ||
			!sameClosure(active.references, active.adoptedGeneration.closure)
		) {
			return coldFailure("chain-invalid", "creator successor generation lineage is invalid");
		}
		const [currentCandidates, proposedCandidates, activeCandidates] = await Promise.all([
			loadClosure(input.store, currentGeneration.closure),
			loadClosure(input.store, proposedGeneration.closure),
			loadClosure(input.store, active.references),
		]);
		if (currentCandidates === undefined || proposedCandidates === undefined || activeCandidates === undefined) {
			return coldFailure("storage-failed", "creator successor closure is unavailable");
		}
		const currentTrustCandidate = uniqueCandidateByKind(currentCandidates, "drp-anchor-trust-state");
		const successorTrustCandidate = uniqueCandidateByKind(proposedCandidates, "drp-anchor-trust-state");
		const cutCandidate = uniqueCandidateByKind(proposedCandidates, "drp-hard-epoch-cut");
		if (currentTrustCandidate === undefined || successorTrustCandidate === undefined || cutCandidate === undefined) {
			return coldFailure("chain-invalid", "creator successor authenticated closure is incomplete");
		}
		const currentTrustRecord = currentTrustCandidate.record;
		const successorTrustRecord = successorTrustCandidate.record;
		if (
			!(currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array) ||
			!(currentTrustRecord.detachedCurrentAnchorSignature instanceof Uint8Array) ||
			!(successorTrustRecord.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array) ||
			!(successorTrustRecord.detachedCurrentAnchorSignature instanceof Uint8Array) ||
			typeof currentTrustRecord.currentEpoch !== "number" ||
			typeof successorTrustRecord.currentEpoch !== "number"
		) {
			return coldFailure("chain-invalid", "creator durable trust carriers are invalid");
		}
		const currentEpoch = currentTrustRecord.currentEpoch;
		const successorEpoch = successorTrustRecord.currentEpoch;
		const currentProjection = uniqueCandidateByKind(currentCandidates, currentProjectionKind(currentEpoch));
		const successorProjection = uniqueCandidateByKind(activeCandidates, "v3-live-generation-2");
		if (
			currentProjection === undefined ||
			successorProjection === undefined ||
			!Number.isSafeInteger(currentEpoch) ||
			currentEpoch < 0 ||
			successorEpoch !== currentEpoch + 1
		) {
			return coldFailure("chain-invalid", "creator successor epoch projection is invalid");
		}
		const qcs = proposedCandidates.flatMap((candidate) => {
			const decoded = canonicalRecord(candidate.bytes);
			return decoded?.kind === "drp-seal-qc" && decoded.phase === "commit" && decoded.epoch === currentEpoch
				? [candidate]
				: [];
		});
		if (qcs.length !== 1) return coldFailure("chain-invalid", "creator successor QC is invalid");
		const selectedQc = qcs[0] as (typeof qcs)[number];
		let predecessorTrust: CurrentAnchorTrust;
		let successorTrust: CurrentAnchorTrust;
		if (currentEpoch === 0) {
			if (
				!sameBytes(
					input.exactCanonicalAnchorPreimageBytes,
					currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes
				) ||
				!sameBytes(input.detachedSignature, currentTrustRecord.detachedCurrentAnchorSignature)
			) {
				return coldFailure("chain-invalid", "creator genesis carriers do not match durable trust");
			}
			const openedCurrent = openCurrentAnchorTrust({
				exactCanonicalTrustStateRecordBytes: currentTrustCandidate.bytes,
				expectedObjectId: objectId,
				pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
			});
			if (!openedCurrent.ok) return coldFailure("chain-invalid", "creator genesis trust is invalid");
			const openedSuccessor = openCreatorSuccessorTrust({
				currentTrust: openedCurrent.trust,
				exactCanonicalCommitQcBytes: selectedQc.bytes,
				exactCanonicalCutValueBytes: cutCandidate.bytes,
				exactCanonicalTrustStateRecordBytes: successorTrustCandidate.bytes,
			});
			if (!openedSuccessor.ok) return coldFailure("chain-invalid", "creator successor QC is invalid");
			predecessorTrust = openedCurrent.trust;
			successorTrust = openedSuccessor.trust;
		} else {
			const openedCheckpoint = openCreatorCheckpointTrust({
				detachedGenesisSignature: input.detachedSignature,
				exactCanonicalCommitQcBytes: selectedQc.bytes,
				exactCanonicalCurrentTrustStateRecordBytes: successorTrustCandidate.bytes,
				exactCanonicalCutValueBytes: cutCandidate.bytes,
				exactCanonicalGenesisAnchorPreimageBytes: input.exactCanonicalAnchorPreimageBytes,
				exactCanonicalPredecessorTrustStateRecordBytes: currentTrustCandidate.bytes,
				expectedCurrentHead: input.expectedRoomHead,
				expectedObjectId: objectId,
				pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
			});
			if (!openedCheckpoint.ok) return coldFailure("chain-invalid", "creator checkpoint trust is invalid");
			predecessorTrust = openedCheckpoint.predecessorTrust;
			successorTrust = openedCheckpoint.currentTrust;
		}
		if (
			!inspectCreatorTransitionAdvance({
				current: { candidates: currentCandidates, closure: currentGeneration.closure },
				currentTrust: predecessorTrust,
				mode: "verify",
				proofRefs: [cutCandidate.ref, selectedQc.ref],
				proposed: { candidates: proposedCandidates, closure: proposedGeneration.closure },
				successorTrust,
			}).ok
		) {
			return coldFailure("chain-invalid", "creator successor trust advance is invalid");
		}
		const currentAnchor = canonicalRecord(currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes);
		const successorAnchorBytes = Uint8Array.from(successorTrustRecord.exactCanonicalCurrentAnchorPreimageBytes);
		const successorAnchor = canonicalRecord(successorAnchorBytes);
		if (
			currentAnchor === undefined ||
			successorAnchor === undefined ||
			currentProjection.record.epoch !== currentEpoch ||
			currentProjection.record.objectId !== objectId ||
			currentProjection.record.blueprintDigest !== currentAnchor.blueprintDigest ||
			currentProjection.record.blueprintDigest !== successorAnchor.blueprintDigest
		) {
			return coldFailure("chain-invalid", "creator anchor carriers are invalid");
		}
		const chain: VerifiedChain = Object.freeze({
			currentAnchor,
			currentEpoch,
			currentCatalog: Object.freeze({
				artifactDigest: String(currentProjection.record.artifactDigest),
				artifactId: String(currentProjection.record.artifactId),
				blueprintDigest: String(currentProjection.record.blueprintDigest),
				catalogDigest: String(currentProjection.record.catalogDigest),
				runtimeProfile: String(currentProjection.record.runtimeProfile),
			}),
			currentProjectionKind: currentProjectionKind(currentEpoch),
			currentTrustRecord,
			cut: cutCandidate.record,
			successorAnchor,
			successorAnchorBytes,
			successorEpoch,
			successorTrust,
			successorTrustRecord,
		});
		const snapshot = await verifySnapshot(input, chain);
		if (snapshot === undefined) return coldFailure("snapshot-unavailable", "creator successor snapshot is unavailable");
		const resolved = verifiedCatalog(input.catalog, snapshot.payload.blueprintDigest, chain.currentCatalog);
		const manifestDigest = input.snapshotDeclaration.scope.manifestDigest;
		if (
			resolved === undefined ||
			successorProjection.record.anchorDigest !== successorTrust.currentAnchorDigest ||
			successorProjection.record.epoch !== successorEpoch ||
			successorProjection.record.objectId !== objectId ||
			successorProjection.record.blueprintDigest !== successorAnchor.blueprintDigest ||
			successorProjection.record.parametersDigest !== successorAnchor.parametersDigest ||
			successorProjection.record.snapshotManifestDigest !== manifestDigest ||
			successorProjection.record.snapshotPayloadDigest !== snapshot.manifest.payloadDigest ||
			successorProjection.record.stateDigest !== snapshot.manifest.stateDigest ||
			hex(hashDomain("ts-drp/parameters/v3", input.exactCanonicalParametersCarrierBytes)) !==
				successorAnchor.parametersDigest
		) {
			return coldFailure("chain-invalid", "creator successor projection is invalid");
		}
		const exactCanonicalLatchedAclBytes = encodeCanonical(snapshot.payload.acl);
		const predecessorAclCandidates = activeCandidates.filter(
			(candidate) => hex(hashDomain("ts-drp/latched-acl/v3", candidate.bytes)) === currentAnchor.aclDigest
		);
		const predecessorExactCanonicalLatchedAclBytes = predecessorAclCandidates[0]?.bytes;
		const openedPredecessorAcl =
			predecessorAclCandidates.length === 1 && predecessorExactCanonicalLatchedAclBytes !== undefined
				? openCanonicalLatchedAclSnapshot({
						exactCanonicalLatchedAclBytes: predecessorExactCanonicalLatchedAclBytes,
						expectedAclDigest: String(currentAnchor.aclDigest),
						expectedEpoch: currentEpoch,
						expectedObjectId: objectId,
					})
				: undefined;
		if (
			predecessorExactCanonicalLatchedAclBytes === undefined ||
			openedPredecessorAcl === undefined ||
			!openedPredecessorAcl.ok
		) {
			return coldFailure("chain-invalid", "creator predecessor ACL cannot be reconstructed");
		}
		const issuance = await authenticatedSuccessorIssuanceScope(
			input,
			objectId,
			String(successorAnchor.aclDigest),
			successorEpoch,
			exactCanonicalLatchedAclBytes
		);
		if (!issuance.ok) {
			const detail =
				issuance.reason === "authority"
					? "creator issuance ACL authority is invalid"
					: issuance.reason === "possession"
						? "creator issuance possession proof failed"
						: "creator issuance lineage is invalid";
			return coldFailure("chain-invalid", detail);
		}
		const issuanceScope = issuance.scope;
		const material: CreatorSuccessorLiveMaterial = Object.freeze({
			catalog: factsForCatalog(resolved),
			exactCanonicalLatchedAclBytes,
			exactCanonicalParametersCarrierBytes: Uint8Array.from(input.exactCanonicalParametersCarrierBytes),
			exactCanonicalPinnedGenesisBootstrapOperationBytes,
			exactCanonicalSnapshotPayloadBytes: Uint8Array.from(snapshot.exactCanonicalPayloadBytes),
			issuanceScope,
			issuanceStore: input.issuanceStore,
			liveJournalStore: input.liveJournalStore,
			pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
			predecessor: Object.freeze({
				candidates: currentCandidates,
				detachedAnchorSignature: Uint8Array.from(currentTrustRecord.detachedCurrentAnchorSignature),
				exactCanonicalAnchorPreimageBytes: Uint8Array.from(currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes),
				exactCanonicalProjectionBytes: Uint8Array.from(currentProjection.bytes),
				head: currentHead,
				references: Object.freeze(currentGeneration.closure.map((ref) => Object.freeze({ ...ref }))),
				trust: predecessorTrust,
				trustRef: Object.freeze({ ...currentTrustCandidate.ref }),
			}),
			predecessorExactCanonicalLatchedAclBytes,
			snapshotPayloadDigest: String(snapshot.manifest.payloadDigest),
			stateDigest: String(snapshot.manifest.stateDigest),
			store: input.store,
			successor: Object.freeze({
				candidates: activeCandidates,
				detachedAnchorSignature: Uint8Array.from(successorTrustRecord.detachedCurrentAnchorSignature),
				exactCanonicalAnchorPreimageBytes: successorAnchorBytes,
				exactCanonicalProjectionBytes: Uint8Array.from(successorProjection.bytes),
				head: Object.freeze({ ...active.head }),
				references: Object.freeze(active.references.map((ref) => Object.freeze({ ...ref }))),
				trust: successorTrust,
				trustRef: Object.freeze({ ...successorTrustCandidate.ref }),
			}),
			terminalizeSource: () => true,
		});
		return Object.freeze({ material, ok: true as const });
	} catch {
		return coldFailure("internal-invariant", "creator successor reopen failed unexpectedly");
	}
}

interface AuthenticatedPendingCandidate {
	readonly closureDigest: string;
	readonly generation: GenerationRecord;
	readonly head: PresentHead;
}

function exactRoomHead(value: unknown): CreatorAdoptionRoomHead | undefined {
	try {
		if (
			value === null ||
			typeof value !== "object" ||
			Object.getPrototypeOf(value) !== Object.prototype ||
			Reflect.ownKeys(value).sort().join(",") !== "currentAnchorDigest,epoch,objectId"
		) {
			return undefined;
		}
		const anchor = Object.getOwnPropertyDescriptor(value, "currentAnchorDigest");
		const epoch = Object.getOwnPropertyDescriptor(value, "epoch");
		const objectId = Object.getOwnPropertyDescriptor(value, "objectId");
		return anchor !== undefined &&
			"value" in anchor &&
			anchor.enumerable === true &&
			typeof anchor.value === "string" &&
			/^[0-9a-f]{64}$/u.test(anchor.value) &&
			epoch !== undefined &&
			"value" in epoch &&
			epoch.enumerable === true &&
			typeof epoch.value === "number" &&
			Number.isSafeInteger(epoch.value) &&
			epoch.value >= 0 &&
			objectId !== undefined &&
			"value" in objectId &&
			objectId.enumerable === true &&
			typeof objectId.value === "string"
			? Object.freeze({
					currentAnchorDigest: anchor.value,
					epoch: epoch.value,
					objectId: objectId.value,
				})
			: undefined;
	} catch {
		return undefined;
	}
}

function sameRoomHead(left: CreatorAdoptionRoomHead, right: CreatorAdoptionRoomHead): boolean {
	return (
		left.currentAnchorDigest === right.currentAnchorDigest &&
		left.epoch === right.epoch &&
		left.objectId === right.objectId
	);
}

function roomHeadFromTrust(trust: CurrentAnchorTrust): CreatorAdoptionRoomHead {
	return Object.freeze({
		currentAnchorDigest: trust.currentAnchorDigest,
		epoch: trust.currentEpoch,
		objectId: trust.objectId,
	});
}

async function authenticatePendingCandidate(
	input: CreatorAdoptionPendingRecoveryInput,
	lineage: readonly GenerationRecord[],
	candidate: GenerationRecord,
	expectedPrevious: CreatorAdoptionRoomHead,
	expectedNext: CreatorAdoptionRoomHead,
	objectId: StorageObjectId
): Promise<AuthenticatedPendingCandidate | undefined> {
	try {
		if (candidate.state !== "Complete" && candidate.state !== "Adopted") return undefined;
		const proposedHead = presentBase(candidate);
		const byId = new Map(lineage.map((generation) => [generation.generationId, generation]));
		if (byId.size !== lineage.length || proposedHead === undefined) return undefined;
		const proposedGeneration = byId.get(proposedHead.generationId);
		const currentHead = proposedGeneration === undefined ? undefined : presentBase(proposedGeneration);
		const currentGeneration = currentHead === undefined ? undefined : byId.get(currentHead.generationId);
		if (
			proposedGeneration === undefined ||
			currentHead === undefined ||
			currentGeneration === undefined ||
			currentGeneration.state !== "Superseded" ||
			(proposedGeneration.state !== "Adopted" && proposedGeneration.state !== "Superseded") ||
			candidate.baseExpectedHead.kind !== "present" ||
			proposedGeneration.baseExpectedHead.kind !== "present" ||
			candidate.objectId !== objectId ||
			proposedGeneration.objectId !== objectId ||
			currentGeneration.objectId !== objectId ||
			proposedHead.revision !== currentHead.revision + 1
		) {
			return undefined;
		}
		const closureDigest = digestClosure(candidate.closure);
		if (!closureDigest.ok || candidate.closureDigest !== closureDigest.value) return undefined;
		const candidateHead: PresentHead = Object.freeze({
			closureDigest: closureDigest.value,
			generationId: candidate.generationId,
			kind: "present",
			objectId,
			revision: (proposedHead.revision + 1) as PresentHead["revision"],
		});
		const [currentCandidates, proposedCandidates, candidateCandidates] = await Promise.all([
			loadClosure(input.store, currentGeneration.closure),
			loadClosure(input.store, proposedGeneration.closure),
			loadClosure(input.store, candidate.closure),
		]);
		if (currentCandidates === undefined || proposedCandidates === undefined || candidateCandidates === undefined) {
			return undefined;
		}
		const currentEpoch = expectedPrevious.epoch;
		const successorEpoch = expectedNext.epoch;
		const expectedCurrentProjectionKind = currentProjectionKind(currentEpoch);
		const currentProjection = uniqueCandidateByKind(currentCandidates, expectedCurrentProjectionKind);
		const successorProjection = uniqueCandidateByKind(candidateCandidates, "v3-live-generation-2");
		const currentTrustCandidate = uniqueCandidateByKind(currentCandidates, "drp-anchor-trust-state");
		const successorTrustCandidate = uniqueCandidateByKind(proposedCandidates, "drp-anchor-trust-state");
		const cutCandidate = uniqueCandidateByKind(proposedCandidates, "drp-hard-epoch-cut");
		if (
			currentProjection === undefined ||
			successorProjection === undefined ||
			currentTrustCandidate === undefined ||
			successorTrustCandidate === undefined ||
			cutCandidate === undefined
		) {
			return undefined;
		}
		const qcs = proposedCandidates.flatMap((entry) =>
			canonicalRecord(entry.bytes)?.kind === "drp-seal-qc" ? [entry] : []
		);
		const currentTrustRecord = currentTrustCandidate.record;
		const successorTrustRecord = successorTrustCandidate.record;
		if (
			!(currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array) ||
			!(currentTrustRecord.detachedCurrentAnchorSignature instanceof Uint8Array) ||
			!(successorTrustRecord.exactCanonicalCurrentAnchorPreimageBytes instanceof Uint8Array)
		) {
			return undefined;
		}
		let predecessorTrust: CurrentAnchorTrust;
		let successorTrust: CurrentAnchorTrust;
		let selectedQc: (typeof qcs)[number];
		if (currentEpoch === 0) {
			if (
				!sameBytes(
					input.exactCanonicalAnchorPreimageBytes,
					currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes
				) ||
				!sameBytes(input.detachedSignature, currentTrustRecord.detachedCurrentAnchorSignature)
			) {
				return undefined;
			}
			const openedCurrent = openCurrentAnchorTrust({
				exactCanonicalTrustStateRecordBytes: currentTrustCandidate.bytes,
				expectedObjectId: objectId,
				pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
			});
			if (!openedCurrent.ok) return undefined;
			const openedSuccessors = qcs.flatMap((entry) => {
				const opened = openCreatorSuccessorTrust({
					currentTrust: openedCurrent.trust,
					exactCanonicalCommitQcBytes: entry.bytes,
					exactCanonicalCutValueBytes: cutCandidate.bytes,
					exactCanonicalTrustStateRecordBytes: successorTrustCandidate.bytes,
				});
				return opened.ok ? [Object.freeze({ qc: entry, trust: opened.trust })] : [];
			});
			if (openedSuccessors.length !== 1) return undefined;
			const openedSuccessor = openedSuccessors[0] as (typeof openedSuccessors)[number];
			predecessorTrust = openedCurrent.trust;
			successorTrust = openedSuccessor.trust;
			selectedQc = openedSuccessor.qc;
		} else {
			const openedCheckpoints = qcs.flatMap((entry) => {
				const opened = openCreatorCheckpointTrust({
					detachedGenesisSignature: input.detachedSignature,
					exactCanonicalCommitQcBytes: entry.bytes,
					exactCanonicalCurrentTrustStateRecordBytes: successorTrustCandidate.bytes,
					exactCanonicalCutValueBytes: cutCandidate.bytes,
					exactCanonicalGenesisAnchorPreimageBytes: input.exactCanonicalAnchorPreimageBytes,
					exactCanonicalPredecessorTrustStateRecordBytes: currentTrustCandidate.bytes,
					expectedCurrentHead: expectedNext,
					expectedObjectId: objectId,
					pinnedGenesisAnchorDigest: input.pinnedGenesisAnchorDigest,
				});
				return opened.ok ? [Object.freeze({ opened, qc: entry })] : [];
			});
			if (openedCheckpoints.length !== 1) return undefined;
			const selected = openedCheckpoints[0] as (typeof openedCheckpoints)[number];
			predecessorTrust = selected.opened.predecessorTrust;
			successorTrust = selected.opened.currentTrust;
			selectedQc = selected.qc;
		}
		if (
			!sameRoomHead(roomHeadFromTrust(predecessorTrust), expectedPrevious) ||
			!sameRoomHead(roomHeadFromTrust(successorTrust), expectedNext) ||
			!inspectCreatorTransitionAdvance({
				current: { candidates: currentCandidates, closure: currentGeneration.closure },
				currentTrust: predecessorTrust,
				mode: "verify",
				proofRefs: [cutCandidate.ref, selectedQc.ref],
				proposed: { candidates: proposedCandidates, closure: proposedGeneration.closure },
				successorTrust,
			}).ok
		) {
			return undefined;
		}
		const currentAnchor = canonicalRecord(currentTrustRecord.exactCanonicalCurrentAnchorPreimageBytes);
		const successorAnchor = canonicalRecord(successorTrustRecord.exactCanonicalCurrentAnchorPreimageBytes);
		if (
			currentAnchor === undefined ||
			successorAnchor === undefined ||
			currentProjection.record.epoch !== currentEpoch ||
			currentProjection.record.objectId !== objectId ||
			currentProjection.record.blueprintDigest !== currentAnchor.blueprintDigest ||
			currentProjection.record.blueprintDigest !== successorAnchor.blueprintDigest
		) {
			return undefined;
		}
		const chain: VerifiedChain = Object.freeze({
			currentAnchor,
			currentEpoch,
			currentCatalog: Object.freeze({
				artifactDigest: String(currentProjection.record.artifactDigest),
				artifactId: String(currentProjection.record.artifactId),
				blueprintDigest: String(currentProjection.record.blueprintDigest),
				catalogDigest: String(currentProjection.record.catalogDigest),
				runtimeProfile: String(currentProjection.record.runtimeProfile),
			}),
			currentProjectionKind: expectedCurrentProjectionKind,
			currentTrustRecord,
			cut: cutCandidate.record,
			successorAnchor,
			successorAnchorBytes: Uint8Array.from(successorTrustRecord.exactCanonicalCurrentAnchorPreimageBytes),
			successorEpoch,
			successorTrust,
			successorTrustRecord,
		});
		const snapshot = await verifySnapshot(input, chain);
		if (snapshot === undefined) return undefined;
		const resolved = verifiedCatalog(input.catalog, snapshot.payload.blueprintDigest, chain.currentCatalog);
		const manifestDigest = input.snapshotDeclaration.scope.manifestDigest;
		if (
			resolved === undefined ||
			successorProjection.record.anchorDigest !== successorTrust.currentAnchorDigest ||
			successorProjection.record.epoch !== expectedNext.epoch ||
			successorProjection.record.objectId !== objectId ||
			successorProjection.record.blueprintDigest !== successorAnchor.blueprintDigest ||
			successorProjection.record.parametersDigest !== successorAnchor.parametersDigest ||
			successorProjection.record.snapshotManifestDigest !== manifestDigest ||
			successorProjection.record.snapshotPayloadDigest !== snapshot.manifest.payloadDigest ||
			successorProjection.record.stateDigest !== snapshot.manifest.stateDigest ||
			hex(hashDomain("ts-drp/parameters/v3", input.exactCanonicalParametersCarrierBytes)) !==
				successorAnchor.parametersDigest
		) {
			return undefined;
		}
		const predecessorAclCandidates = candidateCandidates.filter(
			(entry) => hex(hashDomain("ts-drp/latched-acl/v3", entry.bytes)) === currentAnchor.aclDigest
		);
		if (predecessorAclCandidates.length !== 1) return undefined;
		const openedPredecessorAcl = openCanonicalLatchedAclSnapshot({
			exactCanonicalLatchedAclBytes: predecessorAclCandidates[0]?.bytes as Uint8Array,
			expectedAclDigest: String(currentAnchor.aclDigest),
			expectedEpoch: expectedPrevious.epoch,
			expectedObjectId: objectId,
		});
		return openedPredecessorAcl.ok
			? Object.freeze({ closureDigest: closureDigest.value, generation: candidate, head: candidateHead })
			: undefined;
	} catch {
		return undefined;
	}
}

function pendingRecoveryFailure(kind: string, detail: string): CreatorAdoptionPendingRecoveryResult {
	return Object.freeze({ detail, kind, ok: false as const });
}

async function recoverPendingCreatorSuccessorMaterial(
	input: CreatorAdoptionPendingRecoveryInput
): Promise<CreatorAdoptionPendingRecoveryResult> {
	try {
		const expectedPrevious = exactRoomHead(input.expectedPreviousRoomHead);
		const expectedNext = exactRoomHead(input.expectedNextRoomHead);
		const parsedObjectId = parseStorageObjectId(input.snapshotDeclaration.scope.objectId);
		if (
			input.authenticationProfile !== "creator-only" ||
			expectedPrevious === undefined ||
			expectedNext === undefined ||
			!parsedObjectId.ok ||
			expectedPrevious.objectId !== parsedObjectId.value ||
			expectedNext.objectId !== parsedObjectId.value ||
			expectedNext.epoch !== expectedPrevious.epoch + 1
		) {
			return pendingRecoveryFailure("chain-invalid", "creator pending room-head input is invalid");
		}
		const objectId = parsedObjectId.value;
		const [headResult, lineage] = await Promise.all([
			input.store.readHead(objectId),
			readGenerationLineage(input.store, objectId),
		]);
		if (!headResult.ok || headResult.value.kind !== "present" || lineage === undefined) {
			return pendingRecoveryFailure("storage-failed", "creator pending durable state is unavailable");
		}
		const durableHead = headResult.value;
		const candidates: AuthenticatedPendingCandidate[] = [];
		for (const generation of lineage) {
			const candidate = await authenticatePendingCandidate(
				input,
				lineage,
				generation,
				expectedPrevious,
				expectedNext,
				objectId
			);
			if (candidate !== undefined) candidates.push(candidate);
		}
		if (candidates.length === 0) {
			return pendingRecoveryFailure("pending-missing", "creator pending successor is unavailable");
		}
		const closureDigests = new Set(candidates.map(({ closureDigest }) => closureDigest));
		if (closureDigests.size !== 1) {
			return pendingRecoveryFailure("true-fork", "creator pending successors disagree");
		}
		const alreadyActive = candidates.find(({ head }) => sameHead(head, durableHead));
		if (alreadyActive !== undefined) {
			return Object.freeze({
				head: Object.freeze({ ...expectedNext }),
				lifecycle: "successor-published" as const,
				ok: true as const,
				recovery: "active-new" as const,
			});
		}
		const selected = [...candidates].sort((left, right) =>
			left.generation.generationId < right.generation.generationId
				? -1
				: left.generation.generationId > right.generation.generationId
					? 1
					: 0
		)[0] as AuthenticatedPendingCandidate;
		const previous = presentBase(selected.generation);
		if (previous === undefined || !sameHead(previous, durableHead)) {
			return pendingRecoveryFailure("stale-head", "creator pending head is stale");
		}
		try {
			await input.store.swapHead({
				expectedHead: previous,
				generationId: selected.generation.generationId,
				objectId,
			});
		} catch {
			// The authenticated reread below is the only authority after an ambiguous CAS.
		}
		const recovered = await input.store.recoverActiveGeneration(objectId);
		if (!recovered.ok || recovered.value.kind !== "active") {
			return pendingRecoveryFailure("pending-old", "creator pending successor remains unpublished");
		}
		const recoveredHead = recovered.value.head;
		if (!candidates.some(({ head }) => sameHead(head, recoveredHead))) {
			return pendingRecoveryFailure("pending-old", "creator pending successor remains unpublished");
		}
		return Object.freeze({
			head: Object.freeze({ ...expectedNext }),
			lifecycle: "successor-published" as const,
			ok: true as const,
			recovery: "active-new" as const,
		});
	} catch {
		return pendingRecoveryFailure("internal-invariant", "creator pending recovery failed unexpectedly");
	}
}

if (!installCreatorSuccessorReopen(reopenCreatorSuccessorMaterial)) {
	throw new TypeError("creator successor reopen owner was already installed");
}
if (!installCreatorAdoptionPendingRecovery(recoverPendingCreatorSuccessorMaterial)) {
	throw new TypeError("creator adoption pending recovery owner was already installed");
}
