export type SealPhase = "prepare" | "commit";

export interface ExactSealCarrier {
	readonly exactCanonicalPreimageBytes: Uint8Array;
	readonly signature: Uint8Array;
}

export interface SealAuthorityModule {
	openSealAuthority(
		input: Readonly<{ trust: unknown; signerPublicKey: Uint8Array }>
	): Readonly<{ ok: false; reason: string }> | Readonly<{ ok: true; authority: unknown; signerId: string }>;
	prepareSealVote(
		input: Readonly<{
			authority: unknown;
			exactCanonicalCutValueBytes: Uint8Array;
			phase: SealPhase;
			round: number;
		}>
	):
		| Readonly<{ ok: false; reason: string }>
		| Readonly<{
				ok: true;
				exactCanonicalPreimageBytes: Uint8Array;
				proposalHash: string;
				registeredDigest: Uint8Array;
				signingRequest: unknown;
				valueDigest: string;
		  }>;
	verifySealQC(input: Readonly<{ authority: unknown; exactCanonicalQcBytes: Uint8Array }>):
		| Readonly<{ ok: false; reason: string }>
		| Readonly<{
				ok: true;
				phase: SealPhase;
				proposalHash: string;
				round: number;
				valueDigest: string;
		  }>;
}

export interface FinalityKeychainModule {
	createRecoverableFinalitySigner(input: Readonly<{ seed: Uint8Array }>): Promise<
		Readonly<{
			publicKey: Uint8Array;
			signer: unknown;
		}>
	>;
	signCreatorAnchorRequest(input: Readonly<{ request: unknown; signer: unknown }>): Promise<Uint8Array>;
	signSealRegisteredDigest(input: Readonly<{ request: unknown; signer: unknown }>): Promise<Uint8Array>;
}

export type SealStorePort = object;

export interface SealVoterHandle {
	enterRound(input: Readonly<{ expectedRevision: number; round: number }>): Promise<unknown>;
	status(): Readonly<{ enteredRound: number; revision: number; terminal: boolean }>;
	vote(
		input: Readonly<{
			exactCanonicalCutValueBytes: Uint8Array;
			expectedRevision: number;
			phase: SealPhase;
			round: number;
		}>
	): Promise<
		| Readonly<{ ok: false; reason: string; existing?: ExactSealCarrier }>
		| Readonly<{ ok: true; carrierDigest: string; duplicate: boolean }>
	>;
}

export interface SealVoterModule {
	createSealVoter(
		input: Readonly<{
			authority: unknown;
			expectedStorageIncarnation: string;
			signer: unknown;
			store: SealStorePort;
		}>
	): Promise<Readonly<{ ok: false; reason: string } | { ok: true; voter: SealVoterHandle }>>;
}

export interface BrowserSealVoteModule {
	openBrowserSealVoteStore(input: Readonly<{ databaseName: string }>): Promise<
		Readonly<{
			close(): Promise<void>;
			observation: Readonly<{
				incarnation: string;
				pendingCount: number;
				version: 3;
			}>;
			store: SealStorePort;
		}>
	>;
}

export interface CandidateSealModules {
	readonly browser: BrowserSealVoteModule;
	readonly keychain: FinalityKeychainModule;
	readonly protocol: SealAuthorityModule;
	readonly seal: SealVoterModule;
}

export const EXPECTED_EXPORTS = Object.freeze({
	browser: Object.freeze(["openBrowserSealVoteStore"]),
	keychain: Object.freeze(["createRecoverableFinalitySigner", "signCreatorAnchorRequest", "signSealRegisteredDigest"]),
	protocol: Object.freeze([
		"openSealAuthority",
		"prepareRoundChange",
		"prepareSealVote",
		"verifyProposalBundle",
		"verifyRoundChange",
		"verifySealQC",
	]),
	seal: Object.freeze(["createSealVoter"]),
});
