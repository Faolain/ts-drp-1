/** Archive-tier capacity is a local custody policy, not shared operation validity or a hard-memory target. */
export interface ArchiveStorageCapacity {
	readonly maxArtifactBytes: number;
	readonly maxTotalEncodedBytes: number;
	readonly maxArtifacts: number;
	readonly maxAppendArtifacts: number;
	readonly maxAppendEncodedBytes: number;
	readonly maxControlBytes: number;
	readonly maxReadPageEntries: number;
	readonly maxReadPageBytes: number;
	readonly maxReadHandles: number;
	readonly maxQueuedCalls: number;
}

export type ArchiveArtifactRef = Readonly<
	| { kind: "segment" | "index-entry"; digest: string; byteLength: number }
	| { kind: "chunk"; digest: string; byteLength: number; startOrdinal: number; chunkIndex: number }
>;
export interface ArchiveIndexPosition {
	readonly revision: number;
	readonly root: string;
	readonly size: number;
	readonly lastOrdinal: number;
}

/** Mechanical declaration. The existing source/close owner must independently authenticate every field. */
export interface ArchiveAppendDeclaration {
	readonly objectId: string;
	readonly pinnedGenesisAnchorDigest: string;
	readonly sourceEpoch: number;
	readonly sourceAnchorDigest: string;
	readonly sourceCloseSetRoot: string;
	readonly expected: ArchiveIndexPosition;
	readonly targetRoot: string;
	readonly artifacts: readonly ArchiveArtifactRef[];
	/** Exact index entries are immutable content artifacts too; order is certified history order, not arrival. */
	readonly indexEntries: readonly ArchiveArtifactRef[];
}

export interface ArchivePreparedAppend {
	readonly kind: "native-prepared-archive-append";
	readonly intentDigest: string;
	readonly target: ArchiveIndexPosition;
	/** Exact unique declared artifact bytes verified; NOT cumulative proof charges or peak memory. */
	readonly verifiedArtifactBytes: number;
}

/** Widths only, never content digests, signed bytes or portable authority. */
export interface ArchiveAppendCapacityBound {
	readonly artifactBytes: number;
	readonly artifactCount: number;
	readonly indexEntries: number;
	readonly maxArtifactBytes: number;
}
/** The existing close/admission owner authenticates the exact source basis. */
export interface ArchiveCapacityDeclaration {
	readonly objectId: string;
	readonly pinnedGenesisAnchorDigest: string;
	readonly sourceEpoch: number;
	readonly sourceAnchorDigest: string;
	readonly expected: ArchiveIndexPosition;
	readonly current: ArchiveAppendCapacityBound;
	readonly continuation: ArchiveAppendCapacityBound;
}
export interface ArchiveCapacityPromise {
	readonly declaration: ArchiveCapacityDeclaration;
	readonly promiseDigest: string;
	/** Native encoded quota, NOT proof charges, payload bytes or heap. */
	readonly reservedEncodedBytes: number;
	readonly reservedArtifacts: number;
	readonly maxControlByteLength: number;
}

export interface ArchiveStorageStatus {
	readonly maxControlByteLength: number;
	readonly position: ArchiveIndexPosition;
	readonly storedArtifactBytes: number;
	readonly storedArtifacts: number;
	readonly storedArtifactMetadataBytes: number;
	readonly storedIndexMetadataBytes: number;
	readonly reservedAppendBytes: number;
	readonly capacityPromise: ArchiveCapacityPromise | null;
	readonly pending: Readonly<{ intentDigest: string; prepared: boolean }> | null;
}

export interface ArchiveIndexPageEntry {
	readonly leafIndex: number;
	readonly exactCanonicalEntryBytes: Uint8Array;
	readonly proof: Readonly<{ leafIndex: number; treeSize: number; auditPath: Uint8Array[] }>;
}

export interface ArchiveStorageRead {
	readonly position: ArchiveIndexPosition;
	/** O(log index size) native frontier, checked under this same reserved current-position read. */
	readIndexFrontier(): Promise<Readonly<{ size: number; peaks: readonly (Uint8Array | null)[] }>>;
	/** Bounded local lookup; metadata is not authentication or portable authority. */
	lookupArtifact(digest: string): Promise<ArchiveArtifactRef>;
	readArtifact(ref: ArchiveArtifactRef): Promise<Uint8Array>;
	readIndexPage(
		input: Readonly<{ afterLeafIndex: number | null; limit: number }>
	): Promise<readonly ArchiveIndexPageEntry[]>;
	check(): Promise<void>;
	release(): Promise<void>;
}

/**
 * One object-scoped immutable archive tier. No method deletes artifacts.
 * Completion/readback and mechanical CAS are NOT source authentication,
 * portable authority, a certified Cut, retrievability, or permission to prune.
 */
export interface ArchiveStorage {
	inspect(): Promise<ArchiveStorageStatus>;
	/** Persistent bounded custody before admission; exact retry or monotone enlargement.
	 * Advancing to the next basis requires the prior exact append's completed position.
	 * Surplus stays reserved until that original close has completed, never on read release. */
	reserveCapacity(declaration: ArchiveCapacityDeclaration): Promise<ArchiveCapacityPromise>;
	/** Bounded durable intent readback; declaration/labels remain mechanical, never source authority. */
	readAppendDeclaration(input: Readonly<{ sourceEpoch: number; sourceAnchorDigest: string; sourceCloseSetRoot: string }>): Promise<Readonly<{
		intentDigest: string;
		declaration: ArchiveAppendDeclaration;
		phase: "writing" | "prepared" | "committed";
	}> | null>;
	beginAppend(
		declaration: ArchiveAppendDeclaration
	): Promise<Readonly<{ intentDigest: string; phase: "writing" | "prepared" | "committed" }>>;
	writeArtifact(input: Readonly<{ intentDigest: string; ref: ArchiveArtifactRef; bytes: Uint8Array }>): Promise<void>;
	prepareAppend(intentDigest: string): Promise<ArchivePreparedAppend>;
	/** Called only by the existing close/adoption owner AFTER independent certified-root verification. */
	commitPreparedAppend(
		input: Readonly<{ intentDigest: string; expected: ArchiveIndexPosition }>
	): Promise<ArchiveIndexPosition>;
	acquireRead(expected: ArchiveIndexPosition): Promise<ArchiveStorageRead>;
	close(): Promise<void>;
}
