export type PacemakerPhase = "awaiting" | "prepared" | "committed" | "finalized" | "stopped" | "terminal";

export type PacemakerEventKind =
	| "round_entered"
	| "vote_cast"
	| "qc_formed"
	| "lock_acquired"
	| "finalized"
	| "restart";

export interface PacemakerStatus {
	readonly bufferedFutureRounds: number;
	readonly durableCommitQcCount: number;
	readonly durablePrepareQcCount: number;
	readonly durableRevision: number;
	readonly finalizedValueDigest: string | null;
	readonly highestPrepareQcDigest: string | null;
	readonly lockedValueDigest: string | null;
	readonly pendingRoundChangeCount: number;
	readonly phase: PacemakerPhase;
	readonly round: number;
}

export interface SealPacemakerHandle {
	observeCommitQc(exactCanonicalQcBytes: Uint8Array): Promise<Readonly<{ ok: boolean; reason?: string }>>;
	observePrepareQc(exactCanonicalQcBytes: Uint8Array): Promise<Readonly<{ ok: boolean; reason?: string }>>;
	observeProposalBundle(
		input: Readonly<{
			exactCanonicalCutValueBytes: Uint8Array;
			exactCanonicalLeaderVotePreimageBytes: Uint8Array;
			exactCanonicalProposalBytes: Uint8Array;
			leaderVoteSignature: Uint8Array;
			newRoundCertificate?: readonly Readonly<{
				exactCanonicalRoundChangeBytes: Uint8Array;
				signature: Uint8Array;
			}>[];
		}>
	): Promise<Readonly<{ ok: boolean; reason?: string }>>;
	observeRoundChange(
		input: Readonly<{
			exactCanonicalRoundChangeBytes: Uint8Array;
			signature: Uint8Array;
		}>
	): Promise<Readonly<{ ok: boolean; reason?: string }>>;
	status(): PacemakerStatus;
	stop(): Promise<void>;
}

export interface PacemakerModule {
	readonly MAX_FUTURE_ROUND_GAP: 8;
	readonly ROUND_TIMEOUT_BASE_MS: 1000;
	readonly ROUND_TIMEOUT_MAX_MS: 30000;
	createSealPacemaker(
		input: Readonly<{
			authority: unknown;
			metrics: Readonly<{
				traceFunc(name: string, operation: (...args: never[]) => unknown): (...args: never[]) => unknown;
			}>;
			store: object;
			voter: object;
		}>
	): Promise<Readonly<{ ok: false; reason: string } | { ok: true; pacemaker: SealPacemakerHandle }>>;
	leaderForRound(signerIds: readonly string[], round: number): string;
	roundTimeoutMs(round: number): number;
}

export interface PacemakerProtocolModule {
	openSealAuthority(input: unknown): unknown;
	prepareRoundChange(input: unknown): unknown;
	prepareSealVote(input: unknown): unknown;
	verifyProposalBundle(input: unknown): unknown;
	verifyRoundChange(input: unknown): unknown;
	verifySealQC(input: unknown): unknown;
}

export interface PacemakerKeychainModule {
	createRecoverableFinalitySigner(
		input: Readonly<{ seed: Uint8Array }>
	): Promise<Readonly<{ publicKey: Uint8Array; signer: unknown }>>;
	signSealRegisteredDigest(input: Readonly<{ request: unknown; signer: unknown }>): Promise<Uint8Array>;
}

export interface PacemakerCandidateModules {
	readonly browser: Readonly<{
		openBrowserSealVoteStore(input: { databaseName: string }): Promise<
			Readonly<{
				close(): Promise<void>;
				observation: Readonly<{ incarnation: string }>;
				store: object;
			}>
		>;
	}>;
	readonly keychain: PacemakerKeychainModule;
	readonly pacemaker: PacemakerModule;
	readonly protocol: PacemakerProtocolModule;
	readonly seal: Readonly<{
		createSealVoter(input: unknown): Promise<Readonly<{ ok: false; reason: string } | { ok: true; voter: object }>>;
	}>;
}

export interface ItfTraceState {
	readonly "#meta": Readonly<{ readonly index: number }>;
	readonly "durableCommitQcCount": number;
	readonly "durablePrepareQcCount": number;
	readonly "durableRevision": number;
	readonly "futureBucketCount": number;
	readonly "lastEvent": string;
	readonly "n": 4 | 5 | 6 | 7;
	readonly "phase": PacemakerPhase;
	readonly "pendingRoundChangeCount": number;
	readonly "round": number;
	readonly "valueDigest": string;
}

export interface ItfTrace {
	readonly "#meta": Readonly<{ readonly format: "ITF"; readonly source: string }>;
	readonly "states": readonly ItfTraceState[];
	readonly "vars": readonly string[];
}

export interface PacemakerTraceDriver {
	apply(step: ItfTraceState): Promise<PacemakerStatus>;
	close(): Promise<void>;
}
