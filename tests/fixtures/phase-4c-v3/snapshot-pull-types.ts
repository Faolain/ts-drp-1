import type { MessageQueueManager } from "@ts-drp/message-queue";
import type { DRPNetworkNode, Message } from "@ts-drp/types";

import type { SnapshotChunkDescriptor, SnapshotQuarantineScope } from "./snapshot-quarantine-types.js";

export type SnapshotPullFailureCode =
	| "aborted"
	| "authorization-rejected"
	| "body-budget-exceeded"
	| "chunk-invalid"
	| "connection-unavailable"
	| "inactivity-timeout"
	| "manifest-invalid"
	| "protocol-violation"
	| "quarantine-failed"
	| "session-capacity"
	| "total-timeout"
	| "transfer-exhausted";

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

export interface SnapshotChunkProtocolModule {
	readonly SNAPSHOT_CHUNK_PROTOCOL: "/ts-drp/v3/snapshot-chunk/1.0.0";
	createSnapshotChunkProtocolPort(networkNode: DRPNetworkNode): SnapshotChunkProtocolPort;
}

export interface SnapshotPeerAuthorization {
	authorForPeer(peerId: string): string | undefined;
	isAuthorizedAuthor(author: string): boolean;
}

export interface SnapshotTransferStats {
	readonly attemptedPeers: readonly string[];
	readonly exactReceivedBytes: number;
	readonly fetchedIndices: readonly number[];
	readonly reusedIndices: readonly number[];
}

export type VerifiedSnapshotTransfer = Readonly<Record<never, never>>;

export interface SnapshotTransferResult {
	readonly reference: Readonly<{
		readonly chunkCount: number;
		readonly exactByteLength: number;
		readonly scope: Readonly<{
			readonly anchor: string;
			readonly epoch: number;
			readonly manifestDigest: string;
			readonly objectId: string;
		}>;
	}>;
	readonly stats: SnapshotTransferStats;
	readonly verified: VerifiedSnapshotTransfer;
}

export interface SnapshotActivationResult {
	readonly blueprint: object;
	readonly plane: object;
	readonly reference: SnapshotTransferResult["reference"];
}

export interface V3SnapshotTransferOwner {
	activateSmallSnapshot(
		input: Readonly<{
			readonly expectedApplicationStateDigest: string;
			readonly expectedPayloadDigest: string;
			readonly transfer: VerifiedSnapshotTransfer;
		}>
	): SnapshotActivationResult;
	close(): Promise<void>;
	receive(
		input: Readonly<{
			readonly authorization: SnapshotPeerAuthorization;
			readonly capability: object;
			readonly descriptors: readonly SnapshotChunkDescriptor[];
			readonly exactCanonicalManifestBytes: Uint8Array;
			readonly expectedManifestDigest: string;
			readonly messageQueueManager: MessageQueueManager<Message>;
			readonly networkNode: DRPNetworkNode;
			onAdmittedVertex(...arguments_: readonly unknown[]): unknown;
			readonly peers: readonly string[];
			readonly quarantine: SnapshotQuarantineScope<object>;
			readonly signal?: AbortSignal;
		}>
	): Promise<SnapshotTransferResult>;
	serve(
		input: Readonly<{
			readonly authorization: SnapshotPeerAuthorization;
			readonly descriptors: readonly SnapshotChunkDescriptor[];
			readonly exactCanonicalManifestBytes: Uint8Array;
			readonly quarantine: SnapshotQuarantineScope<object>;
		}>
	): () => void;
}

export interface V3SnapshotTransferModule {
	readonly SNAPSHOT_PULL_INACTIVITY_MS: 10_000;
	readonly SNAPSHOT_PULL_MAX_ATTEMPTS: 3;
	readonly SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS: 4;
	readonly SNAPSHOT_PULL_MAX_OUTSTANDING: 4;
	readonly SNAPSHOT_PULL_TOTAL_MS: 120_000;
	createV3SnapshotTransferOwner(
		input: Readonly<{
			readonly transport: SnapshotChunkProtocolPort;
		}>
	): V3SnapshotTransferOwner;
}

/**
 * Builds the isolated future-owner exact type oracle.
 * @param input - Absolute module paths used only after the RED readiness owner exists.
 * @param input.expectedModule - Frozen expected-type owner.
 * @param input.networkModule - Future fixed-protocol network owner.
 * @param input.nodeModule - Future transfer-session owner.
 * @returns A standalone exact TypeScript contract.
 */
export function snapshotPullTypeContractSource(input: {
	readonly expectedModule: string;
	readonly networkModule: string;
	readonly nodeModule: string;
}): string {
	return `
import * as Network from ${JSON.stringify(input.networkModule)};
import * as Node from ${JSON.stringify(input.nodeModule)};
import type { SnapshotChunkProtocolModule, V3SnapshotTransferModule } from ${JSON.stringify(input.expectedModule)};
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type Assert<Value extends true> = Value;
type _Protocol = Assert<Equal<typeof Network.SNAPSHOT_CHUNK_PROTOCOL, SnapshotChunkProtocolModule["SNAPSHOT_CHUNK_PROTOCOL"]>>;
type _Port = Assert<Equal<typeof Network.createSnapshotChunkProtocolPort, SnapshotChunkProtocolModule["createSnapshotChunkProtocolPort"]>>;
type _Inactivity = Assert<Equal<typeof Node.SNAPSHOT_PULL_INACTIVITY_MS, V3SnapshotTransferModule["SNAPSHOT_PULL_INACTIVITY_MS"]>>;
type _Attempts = Assert<Equal<typeof Node.SNAPSHOT_PULL_MAX_ATTEMPTS, V3SnapshotTransferModule["SNAPSHOT_PULL_MAX_ATTEMPTS"]>>;
type _Sessions = Assert<Equal<typeof Node.SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS, V3SnapshotTransferModule["SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS"]>>;
type _Outstanding = Assert<Equal<typeof Node.SNAPSHOT_PULL_MAX_OUTSTANDING, V3SnapshotTransferModule["SNAPSHOT_PULL_MAX_OUTSTANDING"]>>;
type _Total = Assert<Equal<typeof Node.SNAPSHOT_PULL_TOTAL_MS, V3SnapshotTransferModule["SNAPSHOT_PULL_TOTAL_MS"]>>;
type _Owner = Assert<Equal<typeof Node.createV3SnapshotTransferOwner, V3SnapshotTransferModule["createV3SnapshotTransferOwner"]>>;
void (0 as unknown as _Protocol | _Port | _Inactivity | _Attempts | _Sessions | _Outstanding | _Total | _Owner);
`;
}
