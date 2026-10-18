import type {
	DurableLiveJournalStore,
	InstallLiveJournalGenesisInput,
	InstallLiveJournalGenesisResult,
	LiveJournalFailureKind,
	LiveJournalScope,
} from "@ts-drp/live-journal";
import type { CurrentAnchorTrust } from "@ts-drp/protocol-v3";

export type SignedReadResult =
	| Readonly<{ ok: true; kind: "missing" }>
	| Readonly<{
			ok: true;
			kind: "present";
			scope: LiveJournalScope;
			parametersDigest: string;
			envelope: InstallLiveJournalGenesisInput;
	  }>
	| Readonly<{ ok: false; kind: LiveJournalFailureKind | "read-budget-exceeded" }>;
export type HistoricalImportResult =
	| Extract<InstallLiveJournalGenesisResult, { ok: true }>
	| Readonly<{ ok: false; kind: LiveJournalFailureKind | "read-budget-exceeded" | "import-populated" }>;
export interface FutureJournal extends DurableLiveJournalStore {
	readSignedAnchorEnvelope(input: Readonly<{ scope: LiveJournalScope; maxBytes: number }>): Promise<SignedReadResult>;
	importHistoricalAnchor(
		input: Readonly<{ envelope: InstallLiveJournalGenesisInput; maxBytes: number }>
	): Promise<HistoricalImportResult>;
}
export type ImportFailure =
	| "malformed-input"
	| "requirement-unavailable"
	| "authority-invalid"
	| "authority-stale"
	| "source-unavailable"
	| "source-invalid"
	| "destination-unavailable"
	| "destination-invalid"
	| "proof-budget-exceeded"
	| "install-outcome-unknown"
	| "aborted"
	| "release-failed"
	| "internal-invariant";
export type ImportResult =
	| Readonly<{ ok: true; material: object }>
	| Readonly<{
			ok: false;
			kind: ImportFailure;
			cause?: Readonly<{ owner: "ahe" | "floor" | "source-journal" | "destination-journal"; reason: string }>;
	  }>;
export interface FuturePrivate {
	importCreatorClosedRollbackAnchor(
		input: Readonly<{
			requirement: object;
			sourceJournal: DurableLiveJournalStore;
			proofLedger: object;
			signal?: AbortSignal;
		}>
	): Promise<ImportResult>;
}
export interface FutureProtocol {
	inspectCreatorHistoricalAnchorEnvelope(
		input: Readonly<{ successorTrust: CurrentAnchorTrust; envelope: InstallLiveJournalGenesisInput }>
	): Readonly<{ ok: boolean }>;
}
export const MAX_ENVELOPE = 8192 + 64 + 65536;
