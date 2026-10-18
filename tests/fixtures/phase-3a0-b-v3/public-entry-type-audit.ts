import {
	assertTrustPreserved,
	type AssertTrustPreservedInput,
	type AssertTrustPreservedResult,
	createCurrentAnchorTrustStore,
	type CurrentAnchorTrustStore,
	type CurrentAnchorTrustStoreOptions,
	type DetachedClosureCandidate,
	inspectTrustClosure,
	type InspectTrustClosureInput,
	type InspectTrustClosureResult,
	type InstallCreatorAnchorTrustRootFailureReason,
	type InstallCurrentAnchorTrustResult,
	type OpenCurrentAnchorTrustFailureReason,
	type OpenDurableCurrentAnchorTrustResult,
	type TrustClosureRejection,
} from "../../../packages/control-plane/src/index.js";
import type {
	CurrentAnchorTrust,
	InstallCreatorAnchorTrustRootInput,
	InstallCreatorAnchorTrustRootResult,
} from "../../../packages/protocol-v3/src/public.js";
import type {
	AheDurableStore,
	GenerationRef,
	PresentHead,
	StorageObjectId,
} from "../../../packages/storage/src/index.js";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Expect<Value extends true> = Value;

type ExpectedCandidate = Readonly<{ bytes: Uint8Array; ref: GenerationRef }>;
type ExpectedInspectInput = Readonly<{
	candidates: readonly DetachedClosureCandidate[];
	closure: readonly GenerationRef[];
}>;
type ExpectedPreserveInput = Readonly<{
	candidates: readonly DetachedClosureCandidate[];
	closure: readonly GenerationRef[];
	expectedTrustRef: GenerationRef;
}>;
type ExpectedOptions = Readonly<{
	objectId: StorageObjectId;
	pinnedGenesisAnchorDigest: string;
	store: AheDurableStore;
}>;
type ExpectedStore = Readonly<{
	install(input: InstallCreatorAnchorTrustRootInput): Promise<InstallCurrentAnchorTrustResult>;
	open(): Promise<OpenDurableCurrentAnchorTrustResult>;
}>;
type ExpectedCreateFunction = (options: ExpectedOptions) => ExpectedStore;
type ExpectedScannerReason =
	| "malformed-input"
	| "closure-invalid"
	| "candidate-invalid"
	| "candidate-not-in-closure"
	| "candidate-duplicate"
	| "candidate-not-scannable"
	| "candidate-missing"
	| "candidate-length-mismatch"
	| "candidate-digest-mismatch"
	| "trust-state-missing"
	| "trust-state-ambiguous";
type ExpectedInspectResult =
	| Readonly<{ ok: false; reason: ExpectedScannerReason }>
	| Readonly<{
			exactCanonicalTrustStateRecordBytes: Uint8Array;
			ok: true;
			trustRef: GenerationRef;
	  }>;
type ExpectedPreserveResult =
	| Readonly<{ ok: false; reason: ExpectedScannerReason | "trust-ref-not-preserved" }>
	| Readonly<{
			exactCanonicalTrustStateRecordBytes: Uint8Array;
			ok: true;
			trustRef: GenerationRef;
	  }>;
type ExpectedOpenFailureReason =
	| "malformed-input"
	| "record-decode-failed"
	| "noncanonical-record"
	| "record-schema-invalid"
	| "unsupported-trust-state-version"
	| "object-id-mismatch"
	| "genesis-pin-mismatch"
	| "unsupported-trust-profile"
	| "trust-state-inconsistent"
	| "invalid-signature";

type _CandidateExact = Expect<Equal<DetachedClosureCandidate, ExpectedCandidate>>;
type _InspectInputExact = Expect<Equal<InspectTrustClosureInput, ExpectedInspectInput>>;
type _InspectResultExact = Expect<Equal<InspectTrustClosureResult, ExpectedInspectResult>>;
type _PreserveInputExact = Expect<Equal<AssertTrustPreservedInput, ExpectedPreserveInput>>;
type _PreserveResultExact = Expect<Equal<AssertTrustPreservedResult, ExpectedPreserveResult>>;
type _OptionsExact = Expect<Equal<CurrentAnchorTrustStoreOptions, ExpectedOptions>>;
type _StoreExact = Expect<Equal<CurrentAnchorTrustStore, ExpectedStore>>;
type _CreateFunctionExact = Expect<Equal<typeof createCurrentAnchorTrustStore, ExpectedCreateFunction>>;
type _ScannerReasonExact = Expect<Equal<TrustClosureRejection, ExpectedScannerReason>>;
type _OpenFailureReasonExact = Expect<Equal<OpenCurrentAnchorTrustFailureReason, ExpectedOpenFailureReason>>;
type ExpectedGenesisReason = Extract<InstallCreatorAnchorTrustRootResult, { readonly ok: false }>["reason"];
type ExpectedFourteenReasons =
	| "malformed-input"
	| "anchor-decode-failed"
	| "noncanonical-anchor"
	| "anchor-schema-invalid"
	| "inactive-crypto-suite"
	| "not-genesis-anchor"
	| "object-id-invalid"
	| "genesis-pin-mismatch"
	| "signer-set-digest-mismatch"
	| "profile-digest-mismatch"
	| "unsupported-trust-profile"
	| "signer-set-profile-mismatch"
	| "trust-state-too-large"
	| "invalid-signature";
type _DerivedAlias = Expect<Equal<InstallCreatorAnchorTrustRootFailureReason, ExpectedGenesisReason>>;
type _ExactFourteen = Expect<Equal<InstallCreatorAnchorTrustRootFailureReason, ExpectedFourteenReasons>>;
type _GenesisArm = Expect<
	Equal<
		Extract<InstallCurrentAnchorTrustResult, { readonly reason: "genesis-rejected" }>,
		Readonly<{
			cause: InstallCreatorAnchorTrustRootFailureReason;
			ok: false;
			reason: "genesis-rejected";
		}>
	>
>;
type _TrustArmStillOpen = Expect<
	Equal<
		Extract<InstallCurrentAnchorTrustResult, { readonly reason: "trust-rejected" }>,
		Readonly<{ cause: OpenCurrentAnchorTrustFailureReason; ok: false; reason: "trust-rejected" }>
	>
>;
type ExpectedInstallResult =
	| Readonly<{ head: PresentHead; ok: true; trust: CurrentAnchorTrust; trustRef: GenerationRef }>
	| Readonly<{ ok: false; reason: "already-installed" | "trust-state-conflict" | "store-failed" }>
	| Readonly<{ cause: InstallCreatorAnchorTrustRootFailureReason; ok: false; reason: "genesis-rejected" }>
	| Readonly<{ cause: TrustClosureRejection; ok: false; reason: "closure-rejected" }>
	| Readonly<{ cause: OpenCurrentAnchorTrustFailureReason; ok: false; reason: "trust-rejected" }>;
type ExpectedOpenResult =
	| Readonly<{ head: PresentHead; ok: true; trust: CurrentAnchorTrust; trustRef: GenerationRef }>
	| Readonly<{ ok: false; reason: "not-installed" | "store-failed" | "trust-state-unreadable" }>
	| Readonly<{ cause: TrustClosureRejection; ok: false; reason: "closure-rejected" }>
	| Readonly<{ cause: OpenCurrentAnchorTrustFailureReason; ok: false; reason: "trust-rejected" }>;
type _InstallResultExact = Expect<Equal<InstallCurrentAnchorTrustResult, ExpectedInstallResult>>;
type _OpenResultExact = Expect<Equal<OpenDurableCurrentAnchorTrustResult, ExpectedOpenResult>>;

const inspectFunction: (input: InspectTrustClosureInput) => InspectTrustClosureResult = inspectTrustClosure;
const preserveFunction: (input: AssertTrustPreservedInput) => AssertTrustPreservedResult = assertTrustPreserved;
const createFunction: ExpectedCreateFunction = createCurrentAnchorTrustStore;

declare const candidate: DetachedClosureCandidate;
declare const inspectInput: InspectTrustClosureInput;
declare const preserveInput: AssertTrustPreservedInput;
declare const options: CurrentAnchorTrustStoreOptions;
const inspected: InspectTrustClosureResult = inspectFunction(inspectInput);
const preserved: AssertTrustPreservedResult = preserveFunction(preserveInput);
const durable: CurrentAnchorTrustStore = createFunction(options);
declare const installResult: InstallCurrentAnchorTrustResult;
declare const openResult: OpenDurableCurrentAnchorTrustResult;
declare const scannerReason: TrustClosureRejection;
declare const openReason: OpenCurrentAnchorTrustFailureReason;

void [candidate, inspected, preserved, durable, installResult, openResult, scannerReason, openReason];
