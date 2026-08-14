import { createAnchorTrustApi } from "./index.js";

export {
	ANCHOR_TRUST_STATE_MAX_RECORD_BYTES,
	admitReceivedVertex,
	createAdmissionBoundTransactionalVertexIssuer,
	extractAdmittedReceivedVertex,
	prepareBlueprintAdmission,
	prepareBlueprintRuntime,
} from "./index.js";

const anchorTrustApi = createAnchorTrustApi();

export const authenticateCurrentEpochAnchor = anchorTrustApi.authenticateCurrentEpochAnchor;
export const installCreatorAnchorTrustRoot = anchorTrustApi.installCreatorAnchorTrustRoot;
export const isAnchorTrustStateRecordBytes = anchorTrustApi.isAnchorTrustStateRecordBytes;
export const openCurrentAnchorTrust = anchorTrustApi.openCurrentAnchorTrust;

export type {
	AdmissionBoundTransactionalIssuerOptions,
	AdmissionDecision,
	AdmitReceivedVertexInput,
	AdmittedReceivedVertexView,
	AuthenticateCurrentEpochAnchorInput,
	AuthenticateCurrentEpochAnchorResult,
	BlueprintPreparationInput,
	BlueprintRuntimePreparationInput,
	BuildAndSign,
	CurrentAnchorTrust,
	ExtractAdmittedReceivedVertexFailureReason,
	ExtractAdmittedReceivedVertexResult,
	InstallCreatorAnchorTrustRootInput,
	InstallCreatorAnchorTrustRootResult,
	IssuanceOutboxEntry,
	IssueCommit,
	IssuedVertexRecord,
	IssueScope,
	LocalVertexInput,
	OpenCurrentAnchorTrustInput,
	OpenCurrentAnchorTrustResult,
	PreparedBlueprintAdmission,
	PreparedBlueprintRuntime,
	RawEd25519PublicKey,
	SignedVertexEnvelope,
	TransactionalVertexIssuer,
	TransactIssue,
} from "./index.js";
