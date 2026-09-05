export interface ExactSealCarrier {
	readonly exactCanonicalPreimageBytes: Uint8Array;
	readonly signature: Uint8Array;
}

declare const creatorAnchorPreparationBrand: unique symbol;
declare const creatorAnchorSigningRequestBrand: unique symbol;
declare const creatorCloseBrand: unique symbol;

export interface CreatorAnchorPreparation {
	readonly [creatorAnchorPreparationBrand]: true;
}

export interface CreatorAnchorSigningRequest {
	readonly [creatorAnchorSigningRequestBrand]: true;
}

export interface VerifiedCreatorClose {
	readonly [creatorCloseBrand]: true;
}

export interface CreatorCloseModule {
	completeCreatorSuccessor(
		input: Readonly<{
			detachedSignature: Uint8Array;
			preparation: CreatorAnchorPreparation;
		}>
	): Readonly<{ ok: false; reason: string }> | Readonly<{ exactCanonicalTrustStateRecordBytes: Uint8Array; ok: true }>;
	openCreatorSuccessorTrust(
		input: Readonly<{
			currentTrust: unknown;
			exactCanonicalCommitQcBytes: Uint8Array;
			exactCanonicalCutValueBytes: Uint8Array;
			exactCanonicalTrustStateRecordBytes: Uint8Array;
		}>
	): Readonly<{ ok: false; reason: string }> | Readonly<{ ok: true; trust: unknown }>;
	prepareCreatorAnchorSigningRequest(
		input: Readonly<{
			exactCanonicalAnchorPreimageBytes: Uint8Array;
			exactCanonicalProfileBytes: Uint8Array;
			exactCanonicalSignerSetBytes: Uint8Array;
			signerPublicKey: Uint8Array;
		}>
	):
		| Readonly<{ ok: false; reason: string }>
		| Readonly<{ anchorDigest: string; ok: true; signingRequest: CreatorAnchorSigningRequest }>;
	prepareCreatorClose(
		input: Readonly<{
			aclDigest: string;
			archiveIndexRoot: string;
			blueprintDigest: string;
			closeReason: string;
			closeSetCount: number;
			closeSetRoot: string;
			currentTrust: unknown;
			exactCanonicalAvailabilityPolicyBytes: Uint8Array;
			exactCanonicalNextSignerSetBytes: Uint8Array;
			exactCanonicalParametersBytes: Uint8Array;
			exactCanonicalSnapshotManifestBytes: Uint8Array;
			historyRoot: string;
			historySize: number;
			snapshotManifestDigest: string;
			stateDigest: string;
		}>
	):
		| Readonly<{ ok: false; reason: string }>
		| Readonly<{
				close: VerifiedCreatorClose;
				exactCanonicalCutValueBytes: Uint8Array;
				ok: true;
				valueDigest: string;
		  }>;
	prepareCreatorSuccessor(
		input: Readonly<{
			authority: unknown;
			close: VerifiedCreatorClose;
			exactCanonicalCommitQcBytes: Uint8Array;
		}>
	):
		| Readonly<{ ok: false; reason: string }>
		| Readonly<{
				anchorDigest: string;
				exactCanonicalAnchorPreimageBytes: Uint8Array;
				ok: true;
				preparation: CreatorAnchorPreparation;
				signingRequest: CreatorAnchorSigningRequest;
		  }>;
}

export interface CreatorAnchorSigningRequestModule {
	consumeCreatorAnchorSigningRequest(request: CreatorAnchorSigningRequest): Uint8Array | undefined;
}

export interface CreatorSealModule {
	openSealAuthority(
		input: Readonly<{ signerPublicKey: Uint8Array; trust: unknown }>
	): Readonly<{ ok: false; reason: string }> | Readonly<{ authority: unknown; ok: true; signerId: string }>;
	prepareSealVote(
		input: Readonly<{
			authority: unknown;
			exactCanonicalCutValueBytes: Uint8Array;
			phase: "commit" | "prepare";
			round: number;
		}>
	):
		| Readonly<{ ok: false; reason: string }>
		| Readonly<{
				exactCanonicalPreimageBytes: Uint8Array;
				ok: true;
				registeredDigest: Uint8Array;
				signerId: string;
				signingRequest: unknown;
				valueDigest: string;
		  }>;
	verifySealQC(input: Readonly<{ authority: unknown; exactCanonicalQcBytes: Uint8Array }>):
		| Readonly<{ ok: false; reason: string }>
		| Readonly<{
				ok: true;
				phase: "commit" | "prepare";
				proposalHash: string;
				round: number;
				valueDigest: string;
		  }>;
}

export interface SnapshotTransferModule {
	readonly SNAPSHOT_MANIFEST_MAX_BYTES: 212_387;
	decodeSnapshotManifest(
		input: Readonly<{
			exactCanonicalManifestBytes: Uint8Array;
			expectedManifestDigest: string;
			profile: SnapshotTransferProfile;
		}>
	): Readonly<{
		chunks: readonly SnapshotChunkDescriptor[];
		exactCanonicalManifestBytes: Uint8Array;
		manifestDigest: string;
	}>;
	encodeSnapshotTransfer(
		input: Readonly<{
			aclDigest: string;
			anchor: string;
			epoch: number;
			exactCanonicalPayloadBytes: Uint8Array;
			objectId: string;
			profile: SnapshotTransferProfile;
			schemaVersion: number;
			stateDigest: string;
		}>
	): Readonly<{
		chunks: readonly Uint8Array[];
		exactCanonicalManifestBytes: Uint8Array;
		manifestDigest: string;
		payloadDigest: string;
	}>;
	snapshotChunkDigest(index: number, exactBytes: Uint8Array): string;
}

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

export interface CreatorCloseCandidateModules {
	readonly creator: CreatorCloseModule;
	readonly request: CreatorAnchorSigningRequestModule;
	readonly seal: CreatorSealModule;
	readonly snapshot: SnapshotTransferModule;
}

export const EXPECTED_EXPORTS = Object.freeze({
	creator: Object.freeze([
		"completeCreatorSuccessor",
		"openCreatorSuccessorTrust",
		"prepareCreatorAnchorSigningRequest",
		"prepareCreatorClose",
		"prepareCreatorSuccessor",
	]),
	request: Object.freeze(["consumeCreatorAnchorSigningRequest"]),
	seal: Object.freeze([
		"openSealAuthority",
		"prepareRoundChange",
		"prepareSealVote",
		"verifyProposalBundle",
		"verifyRoundChange",
		"verifySealQC",
	]),
	snapshot: Object.freeze([
		"SNAPSHOT_MANIFEST_MAX_BYTES",
		"decodeSnapshotManifest",
		"encodeSnapshotTransfer",
		"snapshotChunkDigest",
	]),
});
