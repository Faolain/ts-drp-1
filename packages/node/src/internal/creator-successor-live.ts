import type { TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import type { DurableIssuanceStore, DurableIssueScope } from "@ts-drp/issuance-store";
import type { DurableLiveJournalStore } from "@ts-drp/live-journal";
import type { MessageQueueManager } from "@ts-drp/message-queue";
import type { CurrentAnchorTrust, SignRegisteredVertexDigest } from "@ts-drp/protocol-v3";
import type { AheDurableStore, GenerationRecord, GenerationRef, PresentHead } from "@ts-drp/storage";
import type {
	SnapshotQuarantineStore,
	SnapshotRecoveryStore,
	SnapshotVerificationReceipt,
} from "@ts-drp/storage/snapshot-transfer";
import type { DRPNetworkNode, Message } from "@ts-drp/types";

import type {
	V3LocalSettlementFloor,
	V3LocalSettlementPolicy,
	V3OperationAdmissionPolicyFactory,
	V3TerminalVertexClassifier,
} from "../v3-live.js";
import type { CreatorSnapshotRetirementReconstructionRequest } from "./creator-closed-rollback-data.js";
import type { CreatorExpectedRoomHead } from "./creator-room-head.js";
import type { VerifiedCreatorCheckpointAttachment } from "./creator-transition-advance.js";

export interface CreatorSuccessorGenerationMaterial {
	readonly candidates: readonly Readonly<{ readonly bytes: Uint8Array; readonly ref: GenerationRef }>[];
	readonly detachedAnchorSignature: Uint8Array;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalProjectionBytes: Uint8Array;
	readonly head: PresentHead;
	readonly references: readonly GenerationRef[];
	readonly trust: CurrentAnchorTrust;
	readonly trustRef: GenerationRef;
}

export interface CreatorSuccessorLiveMaterial {
	readonly checkpoint?: VerifiedCreatorCheckpointAttachment;
	/** Local authoring restriction inherited from genuine custody, never a wire authority. */
	readonly receiveOnly?: true;
	/** Trusted local application input, never obtained from the received proof. */
	readonly settlementPolicy?: V3LocalSettlementPolicy;
	readonly settlementFloor?: V3LocalSettlementFloor;
	/**
	 * Copied original proof-owner receipt, only a request to reconstruct the
	 * same close before ordinary admissions; never retirement permission.
	 */
	readonly retirementReconstruction?: CreatorSnapshotRetirementReconstructionRequest;
	/** Native historical readers handed to the activation owner, never a wire capability. */
	readonly promotionDependencies?: Readonly<{ checkSnapshots(): Promise<void>; release(): Promise<void> }>;
	readonly origin: "local-close" | "received" | "durable-reopen";
	readonly catalog: TrustedBlueprintCatalog;
	readonly exactCanonicalLatchedAclBytes: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly exactCanonicalPinnedGenesisBootstrapOperationBytes?: Uint8Array;
	readonly exactCanonicalSnapshotPayloadBytes: Uint8Array;
	readonly issuanceScope: DurableIssueScope;
	readonly issuanceStore: DurableIssuanceStore;
	readonly liveJournalStore: DurableLiveJournalStore;
	/** Original native readiness owner, never supplied by received wire material. */
	readonly snapshotStore: SnapshotQuarantineStore<SnapshotVerificationReceipt>;
	readonly pinnedGenesisAnchorDigest: string;
	readonly certifiedRecoverySourceGenerations?: readonly GenerationRecord[];
	readonly classifiedRecoverySourceGenerations?: readonly GenerationRecord[];
	readonly predecessor: CreatorSuccessorGenerationMaterial;
	readonly predecessorExactCanonicalLatchedAclBytes: Uint8Array;
	readonly predecessorExactCanonicalParametersBytes?: Uint8Array;
	readonly snapshotPayloadDigest: string;
	readonly sourceRuntimeHandle?: WeakRef<object>;
	readonly stateDigest: string;
	readonly store: AheDurableStore;
	readonly successor: CreatorSuccessorGenerationMaterial;
	terminalizeSource(): Promise<boolean>;
}

export type CreatorSuccessorLiveSeed = Omit<CreatorSuccessorLiveMaterial, "successor"> &
	Readonly<{ readonly successor: Omit<CreatorSuccessorGenerationMaterial, "head"> }>;

/**
 * Completes verified successor material with the durable post-CAS head.
 * @param seed - Authenticated successor material awaiting its committed head.
 * @param head - Exact durable head returned by the adoption CAS.
 * @returns Complete successor-live custody.
 */
export function completeCreatorSuccessorLiveMaterial(
	seed: CreatorSuccessorLiveSeed,
	head: PresentHead
): CreatorSuccessorLiveMaterial {
	return Object.freeze({
		...seed,
		successor: Object.freeze({ ...seed.successor, head: Object.freeze({ ...head }) }),
	});
}

export interface CreatorSuccessorRuntimeBindings {
	readonly createOperationAdmissionPolicy?: V3OperationAdmissionPolicyFactory;
	readonly classifyTerminalVertex?: V3TerminalVertexClassifier;
	readonly messageQueueManager: MessageQueueManager<Message>;
	readonly networkNode: DRPNetworkNode;
	onAdmittedVertex(input: Readonly<Record<string, unknown>>): Promise<void> | void;
}

export type CreatorSuccessorLiveResult =
	| Readonly<{ readonly handle: object; readonly ok: true }>
	| Readonly<{ readonly cause?: unknown; readonly detail: string; readonly kind: string; readonly ok: false }>;

export interface CreatorSuccessorRetainedReadPause {
	finish(outcome: "restored" | "unavailable"): void;
}

let retainedReadPauseOwner: ((plane: object) => Promise<CreatorSuccessorRetainedReadPause>) | undefined;

/**
 * Installs the original registration owner for joined replay quiescence.
 * @param owner - Private registration resolver; grants no native authority.
 * @returns Whether this call installed the sole resolver.
 */
export function installCreatorSuccessorRetainedReadPause(
	owner: (plane: object) => Promise<CreatorSuccessorRetainedReadPause>
): boolean {
	if (retainedReadPauseOwner !== undefined) return false;
	retainedReadPauseOwner = owner;
	return true;
}

/**
 * Pauses future replay reads while an original successor operation owns native work.
 * @param plane - Genuine active plane or its registered alias.
 * @returns Original phase finisher, invoked only after native work and release join.
 */
export function pauseCreatorSuccessorRetainedReads(plane: object): Promise<CreatorSuccessorRetainedReadPause> {
	if (retainedReadPauseOwner === undefined) return Promise.reject(new TypeError("creator replay owner is unavailable"));
	return retainedReadPauseOwner(plane);
}

type CreatorSuccessorLiveKernel = (
	material: CreatorSuccessorLiveMaterial,
	bindings: CreatorSuccessorRuntimeBindings
) => Promise<CreatorSuccessorLiveResult>;

type CreatorSuccessorHandleAliasKernel = (rawHandle: object, wrapper: object) => boolean;

let kernel: CreatorSuccessorLiveKernel | undefined;
let handleAliasKernel: CreatorSuccessorHandleAliasKernel | undefined;

export interface CreatorSuccessorReopenInput {
	readonly exactCanonicalGenesisLatchedAclBytes?: Uint8Array;
	readonly receiveOnly?: true;
	readonly settlementPolicy?: V3LocalSettlementPolicy;
	readonly settlementFloor?: V3LocalSettlementFloor;
	readonly authenticationProfile: "creator-only";
	readonly author: string;
	readonly catalog: TrustedBlueprintCatalog;
	readonly detachedSignature: Uint8Array;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly exactCanonicalPinnedGenesisBootstrapOperationBytes?: Uint8Array;
	readonly expectedRoomHead: CreatorExpectedRoomHead;
	readonly issuanceStore: DurableIssuanceStore;
	readonly liveJournalStore: DurableLiveJournalStore;
	readonly pinnedGenesisAnchorDigest: string;
	readonly signRegisteredVertexDigest: SignRegisteredVertexDigest;
	readonly snapshotStore: SnapshotRecoveryStore<SnapshotVerificationReceipt>;
	readonly store: AheDurableStore;
}

export type CreatorSuccessorReopenResult =
	| Readonly<{ readonly material: CreatorSuccessorLiveMaterial; readonly ok: true }>
	| Readonly<{ readonly detail: string; readonly kind: string; readonly ok: false }>;

type CreatorSuccessorReopenOwner = (input: CreatorSuccessorReopenInput) => Promise<CreatorSuccessorReopenResult>;

let reopenOwner: CreatorSuccessorReopenOwner | undefined;

/**
 * Refuses narrowing existing local issuance into observer custody.
 * Native lineage atomicity remains the issuance owner's premise; this grants no signing authority.
 * @param store Existing native issuance owner.
 * @param scope Exact local identity and room.
 */
export async function assertEmptyReceiveOnlyIssuance(
	store: DurableIssuanceStore,
	scope: DurableIssueScope
): Promise<void> {
	const before = await store.readLineage(scope);
	if (
		before.next !== 0 ||
		before.exhausted !== false ||
		(await store.readIssued(scope, 0)) !== null ||
		(await store.readOutboxPage({ scope, limit: 1 })).length !== 0 ||
		(await store.readSettlementPlan(scope)) !== null
	) {
		throw new TypeError("v3 receive-only local issuance custody is not empty");
	}
	const after = await store.readLineage(scope);
	if (after.next !== 0 || after.exhausted !== false)
		throw new TypeError("v3 receive-only local issuance custody changed");
}

/**
 * Installs the sole private v3 successor-live owner.
 * @param owner - Private activation kernel.
 * @returns Whether this call installed the sole owner.
 */
export function installCreatorSuccessorLive(owner: CreatorSuccessorLiveKernel): boolean {
	if (kernel !== undefined) return false;
	kernel = owner;
	return true;
}

/**
 * Activates authenticated successor custody through the installed private owner.
 * @param material - Authenticated successor-live custody.
 * @param bindings - Runtime network and queue bindings.
 * @returns Active handle or a typed fail-closed result.
 */
export function consumeCreatorSuccessorLive(
	material: CreatorSuccessorLiveMaterial,
	bindings: CreatorSuccessorRuntimeBindings
): Promise<CreatorSuccessorLiveResult> {
	return kernel === undefined
		? Promise.resolve(
				Object.freeze({ detail: "creator successor live owner is unavailable", kind: "internal-invariant", ok: false })
			)
		: kernel(material, bindings);
}

/**
 * Installs the sole private wrapper-to-registration identity bridge.
 * @param owner - Private handle-alias kernel.
 * @returns Whether this call installed the sole owner.
 */
export function installCreatorSuccessorHandleAlias(owner: CreatorSuccessorHandleAliasKernel): boolean {
	if (handleAliasKernel !== undefined) return false;
	handleAliasKernel = owner;
	return true;
}

/**
 * Associates one successor wrapper with its genuine raw live-plane handle.
 * @param rawHandle - Genuine activated live-plane handle.
 * @param wrapper - Newly frozen public successor wrapper.
 * @returns Whether the private registration owner accepted the alias.
 */
export function consumeCreatorSuccessorHandleAlias(rawHandle: object, wrapper: object): boolean {
	try {
		return handleAliasKernel?.(rawHandle, wrapper) === true;
	} catch {
		return false;
	}
}

/**
 * Installs the private durable successor reconstruction owner.
 * @param owner - Private cold-reopen kernel.
 * @returns Whether this call installed the sole owner.
 */
export function installCreatorSuccessorReopen(owner: CreatorSuccessorReopenOwner): boolean {
	if (reopenOwner !== undefined) return false;
	reopenOwner = owner;
	return true;
}

/**
 * Reconstructs authenticated successor custody from durable state.
 * @param input - Exact durable carriers and stores.
 * @returns Reconstructed custody or a typed fail-closed result.
 */
export function consumeCreatorSuccessorReopen(
	input: CreatorSuccessorReopenInput
): Promise<CreatorSuccessorReopenResult> {
	return reopenOwner === undefined
		? Promise.resolve(
				Object.freeze({
					detail: "creator successor reopen owner is unavailable",
					kind: "internal-invariant",
					ok: false,
				})
			)
		: reopenOwner(input);
}
