import {
	ANCHOR_TRUST_STATE_MAX_RECORD_BYTES,
	authenticateCurrentEpochAnchor,
	type AuthenticateCurrentEpochAnchorInput,
	type AuthenticateCurrentEpochAnchorResult,
	type CurrentAnchorTrust,
	installCreatorAnchorTrustRoot,
	type InstallCreatorAnchorTrustRootInput,
	type InstallCreatorAnchorTrustRootResult,
	isAnchorTrustStateRecordBytes,
	openCurrentAnchorTrust,
	type OpenCurrentAnchorTrustInput,
	type OpenCurrentAnchorTrustResult,
} from "@ts-drp/protocol-v3";

const maximum: 8192 = ANCHOR_TRUST_STATE_MAX_RECORD_BYTES;
const classifier: (bytes: Uint8Array) => boolean = isAnchorTrustStateRecordBytes;

void [maximum, classifier, authenticateCurrentEpochAnchor, installCreatorAnchorTrustRoot, openCurrentAnchorTrust];

export type Phase3a0BuiltTypes =
	| AuthenticateCurrentEpochAnchorInput
	| AuthenticateCurrentEpochAnchorResult
	| CurrentAnchorTrust
	| InstallCreatorAnchorTrustRootInput
	| InstallCreatorAnchorTrustRootResult
	| OpenCurrentAnchorTrustInput
	| OpenCurrentAnchorTrustResult;
