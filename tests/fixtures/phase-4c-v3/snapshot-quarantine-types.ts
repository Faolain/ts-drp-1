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

export interface SnapshotStreamCompletion {
	readonly chunkCount: number;
	readonly exactByteLength: number;
	readonly manifestDigest: string;
	readonly payloadDigest: string;
}

export interface ReceiptVerifiedSnapshotStream extends AsyncIterable<Uint8Array> {
	readonly completion: Promise<SnapshotStreamCompletion>;
	readonly receipt: Promise<SnapshotVerificationReceipt>;
}

export interface SnapshotQuarantineReceiptModule {
	consumeSnapshotVerificationReceipt(
		input: Readonly<{
			readonly expectedScope: SnapshotQuarantineScopeKey;
			readonly quarantine: SnapshotVerificationQuarantine;
			readonly receipt: SnapshotVerificationReceipt;
		}>
	): SnapshotStreamCompletion;
	verifySnapshotStreamWithReceipt(
		input: Readonly<{
			readonly exactCanonicalManifestBytes: Uint8Array;
			readonly expectedManifestDigest: string;
			readonly expectedScope: SnapshotQuarantineScopeKey;
			readonly profile: Readonly<{
				readonly maxManifestBytes: 212_387;
				readonly maxSnapshotBytes: 268_435_456;
				readonly snapshotChunkBytes: 131_072;
			}>;
			readonly quarantine: SnapshotVerificationQuarantine;
			readonly signal?: AbortSignal;
			readonly source: Readonly<{
				read(
					descriptor: SnapshotChunkDescriptor,
					options: Readonly<{ readonly signal: AbortSignal }>
				): Promise<Uint8Array | undefined>;
			}>;
		}>
	): ReceiptVerifiedSnapshotStream;
}

export interface SnapshotQuarantineCommonModule {
	readonly SNAPSHOT_QUARANTINE_RETENTION_MS: 86_400_000;
}

export interface NodeSnapshotQuarantineModule {
	createNodeSnapshotQuarantineStore(
		options: Readonly<{
			readonly primaryFilename: string;
		}>
	): SnapshotQuarantineStore<SnapshotVerificationReceipt>;
}

export interface BrowserSnapshotQuarantineModule {
	createBrowserSnapshotQuarantineStore(
		options: Readonly<{
			readonly primaryDatabaseName: string;
		}>
	): Promise<SnapshotQuarantineStore<SnapshotVerificationReceipt>>;
}

/**
 * Builds the isolated exact future-owner type contract.
 * @param input - Absolute owner paths.
 * @param input.browserModule - Future browser adapter module.
 * @param input.commonModule - Future common contract module.
 * @param input.expectedModule - Frozen expected-type module.
 * @param input.nodeModule - Future Node adapter module.
 * @param input.receiptModule - Future compaction receipt module.
 * @returns Standalone TypeScript exact-type oracle.
 */
export function snapshotQuarantineTypeContractSource(input: {
	readonly browserModule: string;
	readonly commonModule: string;
	readonly expectedModule: string;
	readonly nodeModule: string;
	readonly receiptModule: string;
}): string {
	return `
import * as Browser from ${JSON.stringify(input.browserModule)};
import * as Common from ${JSON.stringify(input.commonModule)};
import * as Node from ${JSON.stringify(input.nodeModule)};
import * as Receipt from ${JSON.stringify(input.receiptModule)};
import type {
  BrowserSnapshotQuarantineModule,
  NodeSnapshotQuarantineModule,
  SnapshotQuarantineCommonModule,
  SnapshotQuarantineReceiptModule,
} from ${JSON.stringify(input.expectedModule)};
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type Assert<Value extends true> = Value;
type _Retention = Assert<Equal<typeof Common.SNAPSHOT_QUARANTINE_RETENTION_MS, SnapshotQuarantineCommonModule["SNAPSHOT_QUARANTINE_RETENTION_MS"]>>;
type _Node = Assert<Equal<typeof Node.createNodeSnapshotQuarantineStore, NodeSnapshotQuarantineModule["createNodeSnapshotQuarantineStore"]>>;
type _Browser = Assert<Equal<typeof Browser.createBrowserSnapshotQuarantineStore, BrowserSnapshotQuarantineModule["createBrowserSnapshotQuarantineStore"]>>;
type _Verify = Assert<Equal<typeof Receipt.verifySnapshotStreamWithReceipt, SnapshotQuarantineReceiptModule["verifySnapshotStreamWithReceipt"]>>;
type _Consume = Assert<Equal<typeof Receipt.consumeSnapshotVerificationReceipt, SnapshotQuarantineReceiptModule["consumeSnapshotVerificationReceipt"]>>;
void (0 as unknown as _Retention | _Node | _Browser | _Verify | _Consume);
`;
}
