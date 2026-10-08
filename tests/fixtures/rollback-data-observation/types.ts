import type { NativeOwners } from "../cold-discovery/types.js";
export type { NativeOwners };
export interface Bootstrap {
	readonly identity: string;
	readonly objectId: string;
	readonly pinnedGenesisAnchorDigest: string;
	readonly exactCanonicalPinnedGenesisTrustStateRecordBytes: string;
	readonly profileId: "creator-trusted-v1" | "creator-trusted-settlement-v1";
}
export interface Head {
	readonly objectId: string;
	readonly epoch: number;
	readonly currentAnchorDigest: string;
}
export interface Floor {
	readonly stable: Head;
	readonly pending: null | { readonly previous: Head; readonly next: Head };
}
export interface ProducerReport {
	readonly bootstrap: Bootstrap;
	readonly floor: Floor;
	readonly expectedStates: number[];
}
export interface TargetOracle {
	readonly epoch: number;
	readonly state: unknown;
	readonly stateDigest: string;
	readonly closedAclDigest: string;
	readonly successorAclDigest: string;
	readonly manifestDigest: string;
	readonly payloadDigest: string;
	readonly payloadByteLength: number;
	readonly closedAnchorDigest: string;
	readonly successorAnchorDigest: string;
	readonly cutRef: { readonly digest: string; readonly byteLength: number };
	readonly commitQcRef: { readonly digest: string; readonly byteLength: number };
	readonly representation: "settlement" | "aggregate-retirement" | "retirement-only";
}
export const POSITIVES = [
	{ name: "genesis", epoch: 0, settlement: false, legacy: false },
	{ name: "one", epoch: 1, settlement: false, legacy: false },
	{ name: "aggregate-two", epoch: 2, settlement: false, legacy: false },
	{ name: "settlement-two", epoch: 2, settlement: true, legacy: false },
	{ name: "retirement-only-k0", epoch: 2, settlement: false, legacy: true },
	{ name: "retirement-only-first-k1", epoch: 3, settlement: false, legacy: true },
] as const;
export type Fault =
	| "none"
	| "older-missing-chunk"
	| "older-corrupt-chunk"
	| "older-replaced"
	| "older-missing-manifest"
	| "forged-old-acl"
	| "wrong-retirement-anchor"
	| "old-qc-length"
	| "bad-aggregate-link"
	| "bad-settlement-frontier"
	| "same-u"
	| "unpruned-g8"
	| "anchor-cap"
	| "capture-accessor"
	| "already-aborted"
	| "temporary"
	| "open"
	| "legacy"
	| "not-ready"
	| "abort-first"
	| "abort-second"
	| "close-first"
	| "release-failed"
	| "head-stale"
	| "floor-stale"
	| "floor-pending"
	| "missing-anchor"
	| "anchor-neighbor";
export interface NativeImage {
	heads: { objectId: string; record: Uint8Array }[];
	generations: { objectId: string; generationId: string; record: Uint8Array }[];
	blobs: { digest: string; bytes: Uint8Array }[];
	promotions: { objectId: string; generationId: string; digest: string }[];
}
export interface NativePort {
	image(): Promise<NativeImage>;
	snapshotImage(): Promise<unknown>;
	replace(image: NativeImage): Promise<void>;
	snapshotFault(fault: Fault, objectId: string, epoch: number): Promise<void>;
	prepareReplacement(objectId: string, epoch: number): Promise<{ run(): Promise<void>; close(): Promise<void> }>;
	prepareStaleHead(objectId: string): Promise<{ run(): Promise<void>; close(): Promise<void> }>;
	journalFault(fault: Fault, objectId: string, epoch: number): Promise<void>;
	readFloor(): Promise<Floor | null>;
	writeFloor(floor: Floor): Promise<void>;
	observe<T>(
		call: () => Promise<T>,
		nativeChunk?: () => void,
		nativeFailure?: { ready(): boolean; trigger(): void }
	): Promise<{ value: T; evidence: unknown }>;
}
