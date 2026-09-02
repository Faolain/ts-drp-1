import type { TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import type { DurableIssuanceStore, DurableIssueScope } from "@ts-drp/issuance-store";
import type { DurableLiveJournalStore } from "@ts-drp/live-journal";
import type { MessageQueueManager } from "@ts-drp/message-queue";
import type { CurrentAnchorTrust, SignRegisteredVertexDigest } from "@ts-drp/protocol-v3";
import type { AheDurableStore, GenerationRef, PresentHead } from "@ts-drp/storage";
import type {
	SnapshotQuarantineDeclaration,
	SnapshotQuarantineStore,
	SnapshotVerificationReceipt,
} from "@ts-drp/storage/snapshot-transfer";
import type { DRPNetworkNode, Message } from "@ts-drp/types";

import type { CreatorExpectedRoomHead } from "./creator-room-head.js";

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
	readonly catalog: TrustedBlueprintCatalog;
	readonly exactCanonicalLatchedAclBytes: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly exactCanonicalSnapshotPayloadBytes: Uint8Array;
	readonly issuanceScope: DurableIssueScope;
	readonly issuanceStore: DurableIssuanceStore;
	readonly liveJournalStore: DurableLiveJournalStore;
	readonly pinnedGenesisAnchorDigest: string;
	readonly predecessor: CreatorSuccessorGenerationMaterial;
	readonly predecessorExactCanonicalLatchedAclBytes: Uint8Array;
	readonly snapshotPayloadDigest: string;
	readonly sourceRuntimeHandle?: WeakRef<object>;
	readonly stateDigest: string;
	readonly store: AheDurableStore;
	readonly successor: CreatorSuccessorGenerationMaterial;
	terminalizeSource(): boolean;
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
	readonly messageQueueManager: MessageQueueManager<Message>;
	readonly networkNode: DRPNetworkNode;
	onAdmittedVertex(input: Readonly<Record<string, unknown>>): Promise<void> | void;
}

export type CreatorSuccessorLiveResult =
	| Readonly<{ readonly handle: object; readonly ok: true }>
	| Readonly<{ readonly detail: string; readonly kind: string; readonly ok: false }>;

type CreatorSuccessorLiveKernel = (
	material: CreatorSuccessorLiveMaterial,
	bindings: CreatorSuccessorRuntimeBindings
) => Promise<CreatorSuccessorLiveResult>;

type CreatorSuccessorHandleAliasKernel = (rawHandle: object, wrapper: object) => boolean;

let kernel: CreatorSuccessorLiveKernel | undefined;
let handleAliasKernel: CreatorSuccessorHandleAliasKernel | undefined;

export interface CreatorSuccessorReopenInput {
	readonly authenticationProfile: "creator-only";
	readonly author: string;
	readonly catalog: TrustedBlueprintCatalog;
	readonly detachedSignature: Uint8Array;
	readonly exactCanonicalAnchorPreimageBytes: Uint8Array;
	readonly exactCanonicalParametersCarrierBytes: Uint8Array;
	readonly expectedRoomHead: CreatorExpectedRoomHead;
	readonly issuanceStore: DurableIssuanceStore;
	readonly liveJournalStore: DurableLiveJournalStore;
	readonly pinnedGenesisAnchorDigest: string;
	readonly signRegisteredVertexDigest: SignRegisteredVertexDigest;
	readonly snapshotDeclaration: SnapshotQuarantineDeclaration;
	readonly snapshotStore: SnapshotQuarantineStore<SnapshotVerificationReceipt>;
	readonly store: AheDurableStore;
}

export type CreatorSuccessorReopenResult =
	| Readonly<{ readonly material: CreatorSuccessorLiveMaterial; readonly ok: true }>
	| Readonly<{ readonly detail: string; readonly kind: string; readonly ok: false }>;

type CreatorSuccessorReopenOwner = (input: CreatorSuccessorReopenInput) => Promise<CreatorSuccessorReopenResult>;

let reopenOwner: CreatorSuccessorReopenOwner | undefined;

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
