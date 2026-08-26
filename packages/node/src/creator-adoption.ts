import type { ResolvedBlueprintBytes, TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { CloseSetHistoryCommitment } from "@ts-drp/compaction";
import { inspectCreatorTrustAdvance } from "@ts-drp/control-plane/creator-trust-advance";
import type { CurrentAnchorTrust } from "@ts-drp/protocol-v3";
import { openCreatorSuccessorTrust } from "@ts-drp/protocol-v3/creator-close";
import { decodeSnapshotManifest, snapshotChunkDigest } from "@ts-drp/protocol-v3/snapshot-transfer";
import {
	type AheDurableStore,
	digestBlob,
	digestClosure,
	type GenerationPageCursor,
	type GenerationRecord,
	type GenerationRef,
	type PresentHead,
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

const PROFILE = Object.freeze({
	maxManifestBytes: 212_387,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});

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
	readonly history: CloseSetHistoryCommitment;
	readonly objectId: Parameters<AheDurableStore["recoverActiveGeneration"]>[0];
	readonly proposedHead: PresentHead;
	readonly proposedReferences: readonly GenerationRef[];
	readonly snapshotDeclaration: SnapshotQuarantineDeclaration;
	readonly snapshotStore: SnapshotQuarantineStore<SnapshotVerificationReceipt>;
	readonly store: AheDurableStore;
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
	readonly cut: Readonly<Record<string, unknown>>;
	readonly successorAnchor: Readonly<Record<string, unknown>>;
	readonly successorAnchorBytes: Uint8Array;
}

interface VerifiedSnapshot {
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

function canonicalRecord(bytes: Uint8Array): Readonly<Record<string, unknown>> | undefined {
	try {
		const decoded = decodeCanonical(bytes);
		return record(decoded) && Buffer.from(encodeCanonical(decoded)).equals(bytes) ? decoded : undefined;
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
	objectId: SealedAdoptionFacts["objectId"]
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
	if (
		!sameHead(active.head, facts.proposedHead) ||
		active.references.length !== facts.proposedReferences.length ||
		active.adoptedGeneration.closure.length !== facts.proposedReferences.length ||
		!facts.proposedReferences.every((ref, index) => sameRef(ref, active.references[index] as GenerationRef)) ||
		!facts.proposedReferences.every((ref, index) =>
			sameRef(ref, active.adoptedGeneration.closure[index] as GenerationRef)
		)
	) {
		return undefined;
	}
	const closureDigest = digestClosure(active.references);
	if (!closureDigest.ok || closureDigest.value !== facts.proposedHead.closureDigest) return undefined;
	const generations = await readGenerationLineage(facts.store, facts.objectId);
	if (generations === undefined || !validGenerationLineage(generations, facts)) return undefined;
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
	const advance = inspectCreatorTrustAdvance({
		current: { candidates: closure.currentCandidates, closure: facts.currentReferences },
		proofRefs: [closeResult.cutValueRef, closeResult.commitQcRef],
		proposed: { candidates: closure.proposedCandidates, closure: facts.proposedReferences },
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
	const projections = closure.currentCandidates
		.map(({ bytes }) => canonicalRecord(bytes))
		.filter((candidate) => candidate?.kind === "v3-live-generation-1");
	const currentProjection = projections.length === 1 ? projections[0] : undefined;
	if (
		currentAnchor === undefined ||
		successorAnchor === undefined ||
		currentProjection === undefined ||
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
	});
}

async function verifySnapshot(facts: SealedAdoptionFacts, chain: VerifiedChain): Promise<VerifiedSnapshot | undefined> {
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
		for (const descriptor of decoded.chunks) {
			const bytes = await port.read(descriptor);
			if (
				bytes === undefined ||
				bytes.byteLength !== descriptor.byteLength ||
				snapshotChunkDigest(descriptor.index, bytes) !== descriptor.digest
			) {
				return undefined;
			}
			chunks.push(Uint8Array.from(bytes));
		}
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
		return Object.freeze({ manifest, payload });
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
					epoch: 1,
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
			epoch: 1,
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
		return Object.freeze({
			descriptor: projected.descriptor,
			intent: createCreatorAdoptionIntent(captured.handle, {
				exactCanonicalProjectionBytes: projected.bytes,
			}),
			ok: true as const,
		});
	} catch {
		return failure("internal-invariant", "creator adoption verification failed unexpectedly");
	}
}
