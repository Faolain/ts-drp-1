import {
	type AdmissionDecision,
	type AdmitReceivedVertexInput,
	type AdmittedReceivedVertexView,
	ANCHOR_TRUST_STATE_MAX_RECORD_BYTES,
	authenticateCurrentEpochAnchor,
	type AuthenticateCurrentEpochAnchorInput,
	type AuthenticateCurrentEpochAnchorResult,
	type CurrentAnchorTrust,
	extractAdmittedReceivedVertex,
	type ExtractAdmittedReceivedVertexFailureReason,
	type ExtractAdmittedReceivedVertexResult,
	installCreatorAnchorTrustRoot,
	type InstallCreatorAnchorTrustRootInput,
	type InstallCreatorAnchorTrustRootResult,
	isAnchorTrustStateRecordBytes,
	openCurrentAnchorTrust,
	type OpenCurrentAnchorTrustInput,
	type OpenCurrentAnchorTrustResult,
	type PreparedBlueprintAdmission,
	type RawEd25519PublicKey,
} from "../../../packages/protocol-v3/src/public.js";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Value extends true> = Value;

type ExpectedAdmitInput = Readonly<{
	domain: string;
	expectedAnchor: string;
	preparedBlueprintAdmission: PreparedBlueprintAdmission;
	receivedCanonicalPreimageBytes: Uint8Array;
	resolveAuthorPublicKey(author: string): RawEd25519PublicKey | undefined;
	signature: Uint8Array;
	suiteId: string;
}>;
type ExpectedFailureReason = "malformed-input" | "not-authenticated" | "admission-rejected";
type ExpectedView = Readonly<{
	kind: "drp-vertex";
	protocolMajor: 3;
	objectId: string;
	epoch: number;
	anchor: string;
	author: string;
	authorSequence: number;
	logicalTime: number;
	dependencies: readonly string[];
	operation: Readonly<Record<string, unknown>>;
	digest: Uint8Array;
}>;
type ExpectedExtractResult =
	| Readonly<{ ok: false; reason: ExpectedFailureReason }>
	| Readonly<{ ok: true; vertex: ExpectedView }>;

type _AdmitInput = Assert<Equal<AdmitReceivedVertexInput, ExpectedAdmitInput>>;
type _AdmissionDecision = Assert<Equal<AdmissionDecision, Readonly<{ admitted: boolean; digest?: Uint8Array }>>>;
type _ExtractFailure = Assert<Equal<ExtractAdmittedReceivedVertexFailureReason, ExpectedFailureReason>>;
type _ExtractView = Assert<Equal<AdmittedReceivedVertexView, ExpectedView>>;
type _ExtractResult = Assert<Equal<ExtractAdmittedReceivedVertexResult, ExpectedExtractResult>>;
type _ExtractFunction = Assert<
	Equal<typeof extractAdmittedReceivedVertex, (input: ExpectedAdmitInput) => ExpectedExtractResult>
>;

const maximum: 8192 = ANCHOR_TRUST_STATE_MAX_RECORD_BYTES;
const classifier: (bytes: Uint8Array) => boolean = isAnchorTrustStateRecordBytes;

void [
	maximum,
	classifier,
	authenticateCurrentEpochAnchor,
	extractAdmittedReceivedVertex,
	installCreatorAnchorTrustRoot,
	openCurrentAnchorTrust,
];

export type Phase3a0PublicTypes =
	| _AdmitInput
	| _AdmissionDecision
	| _ExtractFailure
	| _ExtractView
	| _ExtractResult
	| _ExtractFunction
	| AuthenticateCurrentEpochAnchorInput
	| AuthenticateCurrentEpochAnchorResult
	| CurrentAnchorTrust
	| InstallCreatorAnchorTrustRootInput
	| InstallCreatorAnchorTrustRootResult
	| OpenCurrentAnchorTrustInput
	| OpenCurrentAnchorTrustResult;
