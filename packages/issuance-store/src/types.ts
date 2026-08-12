export const DURABLE_ISSUANCE_ERROR_CODES = Object.freeze([
	"ISSUANCE_INVALID_ARGUMENT",
	"ISSUANCE_EXHAUSTED",
	"ISSUANCE_COMMIT_INVALID",
	"ISSUANCE_RETRY_REQUIRED",
	"ISSUANCE_STORE_CLOSED",
	"ISSUANCE_UNSUPPORTED_SCHEMA",
	"ISSUANCE_DURABILITY_UNAVAILABLE",
	"ISSUANCE_SUBSTRATE_FAILURE",
	"ISSUANCE_RECOVERY_CORRUPT",
	"ISSUANCE_OUTCOME_UNKNOWN",
] as const);

export const DURABLE_ISSUANCE_RETRY_CLASSES = Object.freeze(["transient", "resource-exhausted", "permanent"] as const);

export const DEFAULT_DURABLE_ISSUANCE_PAGE_LIMIT = 64;
export const MAXIMUM_DURABLE_ISSUANCE_PAGE_LIMIT = 128;
export const MAXIMUM_DURABLE_ISSUANCE_SCOPE_UTF16_UNITS = 1024;

export type DurableIssuanceErrorCode = (typeof DURABLE_ISSUANCE_ERROR_CODES)[number];
export type DurableIssuanceRetryClass = (typeof DURABLE_ISSUANCE_RETRY_CLASSES)[number];
export type DurableIssuancePublishState = "pending" | "published";

export interface DurableIssueScope {
	readonly author: string;
	readonly objectId: string;
}

export interface DurableSignedEnvelope {
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly signature: Uint8Array;
}

export interface DurableIssuedRecord {
	readonly authorSequence: number;
	readonly envelope: DurableSignedEnvelope;
	readonly scope: DurableIssueScope;
}

export interface DurableIssuanceOutboxEntry {
	readonly authorSequence: number;
	readonly envelope: DurableSignedEnvelope;
	readonly scope: DurableIssueScope;
}

export interface DurableIssueCommit {
	readonly authorSequence: number;
	readonly envelope: DurableSignedEnvelope;
	readonly issuedRecord: DurableIssuedRecord;
	readonly outboxEntry: DurableIssuanceOutboxEntry;
}

export type DurableBuildAndSign = (authorSequence: number) => Promise<DurableIssueCommit>;
export type DurableTransactIssue = (
	scope: DurableIssueScope,
	buildAndSign: DurableBuildAndSign
) => Promise<DurableIssueCommit>;

export interface DurableLineage {
	readonly exhausted: boolean;
	readonly next: number;
}

export interface DurableIssuanceOutboxRecord {
	readonly commit: DurableIssueCommit;
	readonly publishState: DurableIssuancePublishState;
}

export interface DurableOutboxPageInput {
	readonly afterKey?: readonly [string, string, number] | null;
	readonly limit?: number;
	readonly scope?: DurableIssueScope;
}

export interface DurableIssuanceStore {
	readonly transactIssue: DurableTransactIssue;
	readIssued(scope: DurableIssueScope, authorSequence: number): Promise<DurableIssueCommit | null>;
	readOutboxPage(input?: DurableOutboxPageInput): Promise<readonly DurableIssuanceOutboxRecord[]>;
	readLineage(scope: DurableIssueScope): Promise<DurableLineage>;
	close(): Promise<void>;
}

export interface DurableIssuanceError extends Error {
	readonly code: DurableIssuanceErrorCode;
	readonly retryClass?: DurableIssuanceRetryClass;
	readonly scope?: DurableIssueScope;
}
