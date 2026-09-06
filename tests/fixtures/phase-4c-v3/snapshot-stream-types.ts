export interface SnapshotChunkDescriptor {
	readonly byteLength: number;
	readonly digest: string;
	readonly index: number;
}

export interface SnapshotTransferProfile {
	readonly maxManifestBytes: 212_387;
	readonly maxSnapshotBytes: 268_435_456;
	readonly snapshotChunkBytes: 131_072;
}

export interface SnapshotChunkSource {
	read(
		descriptor: SnapshotChunkDescriptor,
		options: Readonly<{ readonly signal: AbortSignal }>
	): Promise<Uint8Array | undefined>;
}

export interface SnapshotQuarantinePort {
	discard(): Promise<void>;
	read(descriptor: SnapshotChunkDescriptor): Promise<Uint8Array | undefined>;
	write(descriptor: SnapshotChunkDescriptor, exactBytes: Uint8Array): Promise<void>;
}

export type SnapshotStreamFailureCode =
	| "aborted"
	| "chunk-digest-mismatch"
	| "chunk-invalid-carrier"
	| "chunk-length-mismatch"
	| "chunk-missing"
	| "manifest-digest-mismatch"
	| "manifest-invalid"
	| "manifest-noncanonical"
	| "manifest-too-large"
	| "payload-digest-mismatch"
	| "quarantine-failed"
	| "source-failed";

export interface SnapshotStreamCompletion {
	readonly chunkCount: number;
	readonly exactByteLength: number;
	readonly manifestDigest: string;
	readonly payloadDigest: string;
}

export interface VerifiedSnapshotStream extends AsyncIterable<Uint8Array> {
	readonly completion: Promise<SnapshotStreamCompletion>;
}

export interface SnapshotStreamModule {
	verifySnapshotStream(input: {
		readonly exactCanonicalManifestBytes: Uint8Array;
		readonly expectedManifestDigest: string;
		readonly profile: SnapshotTransferProfile;
		readonly quarantine: SnapshotQuarantinePort;
		readonly signal?: AbortSignal;
		readonly source: SnapshotChunkSource;
	}): VerifiedSnapshotStream;
}

export interface SnapshotTransferCodecModule {
	readonly SNAPSHOT_MANIFEST_MAX_BYTES: 212_387;
	decodeSnapshotManifest(input: {
		readonly exactCanonicalManifestBytes: Uint8Array;
		readonly expectedManifestDigest: string;
		readonly profile: SnapshotTransferProfile;
	}): Readonly<{
		readonly chunks: readonly SnapshotChunkDescriptor[];
		readonly exactCanonicalManifestBytes: Uint8Array;
		readonly manifest: Readonly<Record<string, unknown>>;
		readonly manifestDigest: string;
	}>;
	snapshotChunkDigest(index: number, exactBytes: Uint8Array): string;
}

export interface DomainHashStream {
	digest(): Uint8Array;
	update(bytes: Uint8Array): void;
}

export interface DomainHashStreamModule {
	createDomainHashStream(domain: string, exactPartByteLength: number): DomainHashStream;
}

export const EXPECTED_CANONICAL_EXPORTS = Object.freeze(["createDomainHashStream"] as const);
export const EXPECTED_PROTOCOL_EXPORTS = Object.freeze([
	"SNAPSHOT_MANIFEST_MAX_BYTES",
	"decodeSnapshotManifest",
	"encodeSnapshotTransfer",
	"snapshotChunkDigest",
] as const);
export const EXPECTED_STREAM_EXPORTS = Object.freeze(["verifySnapshotStream"] as const);

/**
 * Builds the exact future-owner TypeScript contract used by the dormant GREEN suite.
 * @param input - Absolute module locations compiled in an isolated temporary project.
 * @param input.canonicalModule - Incremental domain-hash owner module.
 * @param input.expectedModule - This frozen expected-type module.
 * @param input.protocolModule - Snapshot manifest/chunk codec owner module.
 * @param input.streamModule - Receipt-gated stream verifier owner module.
 * @returns A TypeScript source file containing bidirectional exact type assertions.
 */
export function typeContractSource(input: {
	readonly canonicalModule: string;
	readonly expectedModule: string;
	readonly protocolModule: string;
	readonly streamModule: string;
}): string {
	return `
import * as Canonical from ${JSON.stringify(input.canonicalModule)};
import * as Protocol from ${JSON.stringify(input.protocolModule)};
import * as Stream from ${JSON.stringify(input.streamModule)};
import type {
  DomainHashStreamModule,
  SnapshotStreamModule,
  SnapshotTransferCodecModule,
} from ${JSON.stringify(input.expectedModule)};

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type Assert<Value extends true> = Value;

type _Canonical = Assert<Equal<typeof Canonical.createDomainHashStream, DomainHashStreamModule["createDomainHashStream"]>>;
type _ManifestMaximum = Assert<Equal<typeof Protocol.SNAPSHOT_MANIFEST_MAX_BYTES, 212387>>;
type _Decode = Assert<Equal<typeof Protocol.decodeSnapshotManifest, SnapshotTransferCodecModule["decodeSnapshotManifest"]>>;
type _Chunk = Assert<Equal<typeof Protocol.snapshotChunkDigest, SnapshotTransferCodecModule["snapshotChunkDigest"]>>;
type _Stream = Assert<Equal<typeof Stream.verifySnapshotStream, SnapshotStreamModule["verifySnapshotStream"]>>;
void (0 as unknown as _Canonical | _ManifestMaximum | _Decode | _Chunk | _Stream);
`;
}
