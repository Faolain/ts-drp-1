import type { DRPNetworkNode } from "@ts-drp/types";

export const SNAPSHOT_CHUNK_PROTOCOL = "/ts-drp/v3/snapshot-chunk/1.0.0" as const;

export interface SnapshotChunkProtocolStream {
	readonly peerId: string;
	abort(reason?: Error): void;
	close(): Promise<void>;
	read(maxBytes: number, options: Readonly<{ readonly signal: AbortSignal }>): Promise<Uint8Array>;
	write(exactBytes: Uint8Array, options: Readonly<{ readonly signal: AbortSignal }>): Promise<void>;
}

export interface SnapshotChunkProtocolPort {
	readonly localPeerId: string;
	close(): Promise<void>;
	connectedPeers(): readonly string[];
	open(peerId: string, options: Readonly<{ readonly signal: AbortSignal }>): Promise<SnapshotChunkProtocolStream>;
	serve(handler: (stream: SnapshotChunkProtocolStream) => Promise<void>): () => void;
}

interface SnapshotChunkProtocolHostOwner {
	createSnapshotChunkProtocolHost(): SnapshotChunkProtocolPort;
}

/**
 * Opens the dedicated snapshot protocol over existing authenticated connections only.
 * @param networkNode - Started production network owner.
 * @returns One bounded protocol port owned by that node lifecycle.
 */
export function createSnapshotChunkProtocolPort(networkNode: DRPNetworkNode): SnapshotChunkProtocolPort {
	const owner = networkNode as unknown as Partial<SnapshotChunkProtocolHostOwner>;
	if (typeof owner.createSnapshotChunkProtocolHost !== "function") {
		throw new TypeError("snapshot protocol requires a production network node");
	}
	return owner.createSnapshotChunkProtocolHost();
}
