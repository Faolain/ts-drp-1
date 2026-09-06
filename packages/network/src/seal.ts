import type { DRPNetworkNode } from "@ts-drp/types";

export const SEAL_EVIDENCE_PROTOCOL = "/ts-drp/v3/seal-evidence/1.0.0" as const;

export interface SealEvidenceProtocolPort {
	readonly localPeerId: string;
	close(): Promise<void>;
	connectedPeers(): readonly string[];
	query(peerId: string, request: unknown, options: Readonly<{ signal: AbortSignal }>): Promise<unknown>;
	serve(
		handler: (input: Readonly<{ peerId: string; request: unknown; signal: AbortSignal }>) => Promise<unknown>
	): () => void;
}

interface SealEvidenceProtocolHostOwner {
	createSealEvidenceProtocolHost(): SealEvidenceProtocolPort;
}

/**
 * Opens the creator-seal evidence protocol over existing authenticated connections only.
 * @param networkNode - Started production network owner.
 * @returns One bounded dumb carrier owned by the network-node lifecycle.
 */
export function createSealEvidenceProtocolPort(networkNode: DRPNetworkNode): SealEvidenceProtocolPort {
	const owner = networkNode as unknown as Partial<SealEvidenceProtocolHostOwner>;
	if (typeof owner.createSealEvidenceProtocolHost !== "function") {
		throw new TypeError("seal-evidence protocol requires a production network node");
	}
	return owner.createSealEvidenceProtocolHost();
}
