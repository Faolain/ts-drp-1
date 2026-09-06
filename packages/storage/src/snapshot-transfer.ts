export const SNAPSHOT_QUARANTINE_RETENTION_MS = 86_400_000 as const;

export interface SnapshotChunkDescriptor {
	readonly byteLength: number;
	readonly digest: string;
	readonly index: number;
}

export interface SnapshotQuarantineScopeKey {
	readonly anchor: string;
	readonly epoch: number;
	readonly manifestDigest: string;
	readonly objectId: string;
}

export interface SnapshotQuarantineDeclaration {
	readonly chunks: readonly SnapshotChunkDescriptor[];
	readonly exactCanonicalManifestBytes: Uint8Array;
	readonly scope: SnapshotQuarantineScopeKey;
	readonly totalBytes: number;
}

export interface SnapshotQuarantinePort {
	discard(): Promise<void>;
	read(descriptor: SnapshotChunkDescriptor): Promise<Uint8Array | undefined>;
	write(descriptor: SnapshotChunkDescriptor, exactBytes: Uint8Array): Promise<void>;
}

export interface SnapshotVerificationQuarantine {
	open(signal: AbortSignal): SnapshotQuarantinePort;
}

export type SnapshotVerificationReceipt = Readonly<Record<never, never>>;

export type VerifiedSnapshotQuarantineReference = Readonly<{
	readonly chunkCount: number;
	readonly exactByteLength: number;
	readonly scope: SnapshotQuarantineScopeKey;
}>;

export type SnapshotQuarantineStatus = Readonly<{
	readonly expiresAt: number;
	readonly kind: "open" | "poisoned" | "verified";
	readonly missingIndices: readonly number[];
}>;

export interface SnapshotQuarantineScope<Receipt extends object> {
	readonly scope: SnapshotQuarantineScopeKey;
	readonly verificationQuarantine: SnapshotVerificationQuarantine;
	cancel(options?: Readonly<{ readonly signal?: AbortSignal }>): Promise<void>;
	complete(
		receipt: Receipt,
		options?: Readonly<{ readonly signal?: AbortSignal }>
	): Promise<VerifiedSnapshotQuarantineReference>;
	missingIndices(options?: Readonly<{ readonly signal?: AbortSignal }>): Promise<readonly number[]>;
	release(): Promise<void>;
	status(options?: Readonly<{ readonly signal?: AbortSignal }>): Promise<SnapshotQuarantineStatus>;
}

export interface SnapshotQuarantineStore<Receipt extends object> {
	close(): Promise<void>;
	openScope(
		declaration: SnapshotQuarantineDeclaration,
		options?: Readonly<{ readonly signal?: AbortSignal }>
	): Promise<SnapshotQuarantineScope<Receipt>>;
	sweepExpired(options?: Readonly<{ readonly signal?: AbortSignal }>): Promise<number>;
}
