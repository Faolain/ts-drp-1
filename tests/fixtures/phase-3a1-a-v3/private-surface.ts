import type { TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import type { AheDurableStore, BlobDigest, GenerationRef, PresentHead, StorageObjectId } from "@ts-drp/storage";

import type {
	PreparedV3Live,
	PrepareV3LiveFailureKind,
	prepareV3LiveGeneration,
	PrepareV3LiveGenerationInput,
	PrepareV3LiveResult,
	V3LiveDescriptor,
} from "../../../packages/node/src/v3-live.js";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Expect<Value extends true> = Value;

type ExpectedInput = Readonly<{
	authenticationProfile: "creator-only";
	store: AheDurableStore;
	objectId: StorageObjectId;
	pinnedGenesisAnchorDigest: string;
	exactCanonicalAnchorPreimageBytes: Uint8Array;
	detachedSignature: Uint8Array;
	exactCanonicalParametersCarrierBytes: Uint8Array;
	catalog: TrustedBlueprintCatalog;
}>;

type ExpectedFailureKind =
	| "malformed-input"
	| "trust-open-failed"
	| "anchor-authentication-failed"
	| "parameters-rejected"
	| "blueprint-unresolved"
	| "admission-rejected"
	| "runtime-preparation-failed"
	| "graph-rejected"
	| "trust-not-preserved"
	| "stale-head"
	| "storage-failed"
	| "internal-invariant";

type ExpectedDescriptor = Readonly<{
	objectId: string;
	epoch: 0;
	anchorDigest: string;
	blueprintDigest: string;
	parametersDigest: string;
	profileDigest: string;
	signerSetDigest: string;
	artifactDigest: string;
	artifactId: string;
	catalogDigest: string;
	runtimeProfile: "ecmascript-2024-sync-v1";
	trustProfile: "creator-only";
	trustRef: GenerationRef;
	maxEpochVertices: number;
	maxEpochBytes: number;
	maxDependencies: number;
	vertexCount: 1;
	byteCharge: number;
	projectionDigest: BlobDigest;
	head: PresentHead;
}>;

type _Input = Expect<Equal<PrepareV3LiveGenerationInput, ExpectedInput>>;
type _Failure = Expect<Equal<PrepareV3LiveFailureKind, ExpectedFailureKind>>;
type _Descriptor = Expect<Equal<V3LiveDescriptor, ExpectedDescriptor>>;
type _Result = Expect<
	Equal<
		PrepareV3LiveResult,
		| Readonly<{ ok: true; capability: PreparedV3Live; descriptor: V3LiveDescriptor }>
		| Readonly<{ ok: false; kind: PrepareV3LiveFailureKind; detail: string }>
	>
>;
type _Prepare = Expect<
	Equal<typeof prepareV3LiveGeneration, (input: PrepareV3LiveGenerationInput) => Promise<PrepareV3LiveResult>>
>;

declare const catalog: TrustedBlueprintCatalog;
declare const store: AheDurableStore;
declare const objectId: StorageObjectId;

const valid: PrepareV3LiveGenerationInput = {
	authenticationProfile: "creator-only",
	store,
	objectId,
	pinnedGenesisAnchorDigest: "0".repeat(64),
	exactCanonicalAnchorPreimageBytes: new Uint8Array(),
	detachedSignature: new Uint8Array(),
	exactCanonicalParametersCarrierBytes: new Uint8Array(),
	catalog,
};
void valid;

// @ts-expect-error The private input is closed and has no caller graph.
const extra: PrepareV3LiveGenerationInput = { ...valid, graph: new Map() };
void extra;

// @ts-expect-error A structural object cannot forge the nominal capability.
const forged: PreparedV3Live = {};
void forged;
