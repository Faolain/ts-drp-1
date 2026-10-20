import { encodeCanonical, hashDomain } from "@ts-drp/canonical";

import { LOCAL_WORKLOAD_CAPACITY } from "./types.js";

/**
 * Slices 14a/14b/14e: one verified retention decision applied by one strict room-database
 * transaction. This module owns only LOCAL, non-consensus formats: the decision record,
 * its digest, the per-transaction bounds, the proof book and the refusal codes. Nothing
 * here is sent, signed or used as authority; every owner section re-checks its own facts
 * inside the transaction that deletes.
 */

/** The five room retention owners, in the order their sections run (14a). */
export const ROOM_RETENTION_OWNERS = Object.freeze(["snapshot", "journal", "signing", "ahe", "issuance"] as const);
export type RoomRetentionOwner = (typeof ROOM_RETENTION_OWNERS)[number];

/**
 * Per-transaction bounds (14e). The write cap is NEW policy pending review; the byte
 * budget is the existing `maintenanceProofBytes`. Neither is an eligibility rule.
 */
export const ROOM_RETENTION_LIMITS = Object.freeze({
	maxWrites: 512,
	maxChargedBytes: LOCAL_WORKLOAD_CAPACITY.maintenanceProofBytes,
});

/** Refusals added by slices 14a/14e. Each leaves every store unchanged. */
export type RoomRetentionRefusalCode =
	| "RETENTION_DURABILITY"
	| "RETENTION_LAYOUT"
	| "RETENTION_STALE"
	| "RETENTION_CORRUPT"
	| "RETENTION_CAPACITY"
	| "RETENTION_BUDGET";

const REFUSAL_CODES: ReadonlySet<string> = new Set([
	"RETENTION_DURABILITY",
	"RETENTION_LAYOUT",
	"RETENTION_STALE",
	"RETENTION_CORRUPT",
	"RETENTION_CAPACITY",
	"RETENTION_BUDGET",
]);

/** A retention refusal: the transaction that raised it is aborted whole. */
export class RoomRetentionRefusal extends Error {
	readonly code: RoomRetentionRefusalCode;
	readonly detail: string;
	constructor(code: RoomRetentionRefusalCode, detail: string) {
		super(`${code}:${detail}`);
		this.name = "RoomRetentionRefusal";
		this.code = code;
		this.detail = detail;
	}
}

/**
 * Recognises a retention refusal, including one carried as the cause of another error.
 * @param value - Candidate error.
 * @returns The refusal, or undefined.
 */
export function roomRetentionRefusalOf(value: unknown): RoomRetentionRefusal | undefined {
	for (let current = value, depth = 0; current !== null && typeof current === "object" && depth < 8; depth++) {
		if (current instanceof RoomRetentionRefusal) return current;
		const message = (current as { message?: unknown }).message;
		if (typeof message === "string") {
			const code = message.split(":", 1)[0];
			if (code !== undefined && REFUSAL_CODES.has(code))
				return new RoomRetentionRefusal(code as RoomRetentionRefusalCode, message.slice(code.length + 1));
		}
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

/** A store key as IndexedDB holds it: a string, a safe integer or an array of them. */
export type RoomRetentionKey = string | number | readonly (string | number)[];

/** One row a section deletes, named by its exact key and the digest of its exact row bytes. */
export interface RoomRetentionRowRef {
	readonly store: string;
	readonly key: RoomRetentionKey;
	readonly digest: string;
}

/** One in-place rewrite, with the exact before and after row digests. */
export interface RoomRetentionRewriteRef {
	readonly store: string;
	readonly key: RoomRetentionKey;
	readonly before: string;
	readonly after: string;
}

/** One owner's part of a decision (14a). `base` and `target` digest the control row. */
export interface RoomRetentionOwnerDecision {
	readonly base: string;
	readonly target: string;
	readonly through: number;
	/** The owner's own census digest the decision relies on, when it has one (AHE: its native image). */
	readonly census?: string;
	readonly delete: readonly RoomRetentionRowRef[];
	readonly rewrite: readonly RoomRetentionRewriteRef[];
}

/** The decision record (14a). Local only; never sent, signed or used as authority. */
export interface RoomRetentionDecision {
	readonly version: 1;
	readonly kind: "room-retention-decision-1";
	readonly objectId: string;
	readonly stableEpoch: number;
	readonly owners: Readonly<Partial<Record<RoomRetentionOwner, RoomRetentionOwnerDecision>>>;
}

const DOMAIN = "ts-drp/retention-decision/v1";
const TAG_DECISION = new TextEncoder().encode("decision");
const TAG_ROW = new TextEncoder().encode("row");
const TAG_CONTROL = new TextEncoder().encode("control");
const ROW_LIMITS = Object.freeze({ maxBytes: 8_388_608, maxItems: 1_048_576, maxDepth: 32 });

const hex = (bytes: Uint8Array): string => {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
};

/**
 * Exact row bytes as every room owner encodes a row for its retention image: the
 * canonical triple of logical store, key and stored value.
 * @param store - Logical (un-namespaced) store name.
 * @param key - Exact key.
 * @param value - Exact stored value.
 * @returns Canonical row bytes.
 */
export function roomRetentionRowBytes(store: string, key: RoomRetentionKey, value: unknown): Uint8Array {
	return encodeCanonical([store, key, value], ROW_LIMITS);
}

/**
 * Digest of exact row bytes.
 * @param bytes - Canonical row bytes.
 * @returns Lowercase hex digest.
 */
export function roomRetentionRowDigest(bytes: Uint8Array): string {
	return hex(hashDomain(DOMAIN, TAG_ROW, bytes));
}

/**
 * Digest of an owner control row, or of its absence.
 * @param bytes - Canonical control row bytes, or null when the owner has no control yet.
 * @returns Lowercase hex digest.
 */
export function roomRetentionControlDigest(bytes: Uint8Array | null): string {
	return hex(hashDomain(DOMAIN, TAG_CONTROL, bytes ?? new Uint8Array(0)));
}

function decisionWithoutTargets(decision: RoomRetentionDecision): unknown {
	const owners: Record<string, unknown> = {};
	for (const owner of ROOM_RETENTION_OWNERS) {
		const section = decision.owners[owner];
		if (section === undefined) continue;
		owners[owner] = {
			base: section.base,
			through: section.through,
			...(section.census === undefined ? {} : { census: section.census }),
			delete: section.delete.map((row) => ({ store: row.store, key: row.key, digest: row.digest })),
			rewrite: section.rewrite.map((row) => ({ store: row.store, key: row.key, before: row.before, after: row.after })),
		};
	}
	return {
		version: decision.version,
		kind: decision.kind,
		objectId: decision.objectId,
		stableEpoch: decision.stableEpoch,
		owners,
	};
}

/**
 * The decision digest written as `decisionDigest` into every advanced control. It covers
 * the record WITHOUT the target control digests, because each target control contains it.
 * @param decision - Complete decision record.
 * @returns Lowercase hex digest.
 */
export function roomRetentionDecisionDigest(decision: RoomRetentionDecision): string {
	return hex(hashDomain(DOMAIN, TAG_DECISION, encodeCanonical(decisionWithoutTargets(decision), ROW_LIMITS)));
}

/**
 * Counts a decision's deletes and rewrites, the quantity the per-transaction cap bounds.
 * @param decision - Decision record.
 * @returns Total writes other than control puts.
 */
export function roomRetentionWriteCount(decision: RoomRetentionDecision): number {
	let count = 0;
	for (const owner of ROOM_RETENTION_OWNERS) {
		const section = decision.owners[owner];
		if (section !== undefined) count += section.delete.length + section.rewrite.length;
	}
	return count;
}

/** A snapshot recovery scope key, as the snapshot owner names it. */
export interface RoomRetentionSnapshotScope {
	readonly objectId: string;
	readonly epoch: number;
	readonly anchor: string;
	readonly manifestDigest: string;
}

/** A journal scope, as the journal owner names it. */
export interface RoomRetentionJournalScope {
	readonly objectId: string;
	readonly epoch: number;
	readonly anchorDigest: string;
}

/**
 * The snapshot part of a selection: the recovery scopes the existing role turnover
 * retires (inventory minus the signed Cut's protected roles), with the survivor fact.
 */
export interface RoomRetentionSnapshotSelection {
	readonly retire: readonly Readonly<{ scope: RoomRetentionSnapshotScope; incarnation: string }>[];
	readonly turnover: Readonly<{
		certificateDigest: string;
		currentHead: Readonly<{ objectId: string; epoch: number; currentAnchorDigest: string }>;
		survivorScope: RoomRetentionSnapshotScope;
	}> | null;
}

/**
 * The journal part: collectible membership prefixes (every row named by its verified
 * native frame digest) and empty fenced headers (named by their exact frame digest).
 */
export interface RoomRetentionJournalSelection {
	readonly prefixes: readonly Readonly<{
		scope: RoomRetentionJournalScope;
		highWatermark: number;
		/** The exact frame digest of the prefix's header, as verified (its carrier is stripped). */
		headerFrameDigest: string;
		rows: readonly Readonly<{ journalSequence: number; nativeFrameDigest: string }>[];
	}>[];
	readonly headers: readonly Readonly<{ scope: RoomRetentionJournalScope; nativeFrameDigest: string }>[];
	/** The pinned genesis anchor digest; a genesis header is never retired. */
	readonly genesisAnchorDigest: string;
}

/**
 * The signing part: whole-epoch evidence rows, and summaries of epochs whose evidence
 * already retired or retires in the same unit (one epoch's signing work, 14b).
 */
export interface RoomRetentionSigningSelection {
	readonly evidence: readonly Readonly<{
		key: readonly [string, number, string];
		revision: number;
		frameDigest: string;
	}>[];
	readonly summaries: readonly Readonly<{
		store: "signerState" | "voteSlots" | "voteOutbox";
		key: readonly (string | number)[];
		frameDigest: string;
	}>[];
}

/** The AHE part: ordered existing reclamation inputs (Q before P), applied sequentially. */
export interface RoomRetentionAheSelection {
	readonly units: readonly unknown[];
}

/** The issuance part: the protected records of the new checkpoint. Role 16 deletes nothing. */
export interface RoomRetentionIssuanceSelection {
	readonly protectedRecords: readonly Readonly<{ author: string; authorSequence: number; digest: string }>[];
}

/**
 * The survivors a decision relies on, exactly as the verification that selected it saw
 * them (14b "Inside the transaction"). Step B compares each with the bytes it reads.
 */
export interface RoomRetentionSurvivors {
	/** The AHE data image the decision starts from: head, its rollbacks and every generation. */
	readonly aheImage: string;
	/** The snapshot image (every recovery scope and chunk) before the turnover this decision carries; null without one. */
	readonly snapshotImage: string | null;
	/** Every closed journal header (epoch at most `throughEpoch`) expected present, by its exact frame digest. */
	readonly journalHeaders: readonly Readonly<{ scope: RoomRetentionJournalScope; nativeFrameDigest: string }>[];
	/** Closed headers this boundary's prefixes rewrite (their carrier stripped): present in either form. */
	readonly journalRewritten: readonly RoomRetentionJournalScope[];
}

/**
 * Each owner's control exactly as the verification that selected a decision saw it (14b:
 * "each owner control equals the decision's base"): `roomRetentionControlDigest` of the
 * owner's canonical control encoding (the signing owner's exact control frame).
 */
export type RoomRetentionControls = Readonly<Record<RoomRetentionOwner, string>>;

/**
 * One retention selection (14b): what the node planner decided to retire, each item named
 * by the exact digests of the verified facts that make it retirable. Every section is
 * present: every decision advances all five owner controls with its own labels.
 */
export interface RoomRetentionSelection {
	readonly version: 1;
	readonly objectId: string;
	readonly stableEpoch: number;
	readonly throughEpoch: number;
	readonly snapshot: RoomRetentionSnapshotSelection;
	readonly journal: RoomRetentionJournalSelection;
	readonly signing: RoomRetentionSigningSelection;
	readonly ahe: RoomRetentionAheSelection;
	readonly issuance: RoomRetentionIssuanceSelection;
	readonly survivors: RoomRetentionSurvivors;
	readonly controls: RoomRetentionControls;
}

/** The labels every advanced control and the floor fence carry for one decision. */
export interface RoomRetentionLabels {
	readonly throughEpoch: number;
	readonly decisionDigest: string;
	readonly sourceProofDigest: string;
}

/** Per-transaction bounds a caller may lower (tests), never raise. */
export interface RoomRetentionTransactionLimits {
	readonly maxWrites: number;
	readonly maxChargedBytes: number;
}

/** A planned decision: the record (targets not yet composed) and what planning read. */
export interface RoomRetentionPlanned {
	readonly decision: RoomRetentionDecision;
	readonly decisionDigest: string;
	readonly writes: number;
	readonly charged: number;
}

const TAG_SOURCE = new TextEncoder().encode("source");

/**
 * The digest of one selection, used as the decision's `sourceProofDigest` label. Local
 * only: it binds the label to the exact verified-fact digests the selection names.
 * @param selection - Complete selection.
 * @returns Lowercase hex digest.
 */
export function roomRetentionSourceDigest(selection: RoomRetentionSelection): string {
	return hex(hashDomain(DOMAIN, TAG_SOURCE, encodeCanonical(selection, ROW_LIMITS)));
}

/** What one applied step B reports: the decision digest and its proof book trace. */
export interface RoomRetentionApplied {
	/** The decision record with the target control digests composed from the labels. */
	readonly decision: RoomRetentionDecision;
	readonly decisionDigest: string;
	readonly writes: number;
	readonly charged: number;
	readonly trace: readonly RoomRetentionTraceEvent[];
	/** Each owner's control as step B wrote it, in the form `RoomRetentionControls` names. */
	readonly controls: RoomRetentionControls;
}

/** One entry of a proof book trace (14e RED 3): charges precede the first write. */
export type RoomRetentionTraceEvent = Readonly<
	| { kind: "charge"; owner: RoomRetentionOwner | "room"; bytes: number; total: number }
	| { kind: "delete"; owner: RoomRetentionOwner; store: string }
	| { kind: "rewrite"; owner: RoomRetentionOwner; store: string }
	| { kind: "control"; owner: RoomRetentionOwner }
>;

/** A fresh, operation-local maintenance proof book: charge only, never refund. */
export interface RoomRetentionProofBook {
	readonly limit: number;
	readonly charged: () => number;
	/** Charges exact bytes; refuses RETENTION_BUDGET once the total exceeds the limit. */
	charge(owner: RoomRetentionOwner | "room", bytes: number): void;
	/** Records a write; refuses if any charge happens after the first write. */
	write(event: Exclude<RoomRetentionTraceEvent, { kind: "charge" }>): void;
	readonly trace: () => readonly RoomRetentionTraceEvent[];
}

/**
 * Creates a fresh proof book for one retention transaction.
 * @param limit - Charged-byte budget.
 * @returns The book.
 */
export function createRoomRetentionProofBook(
	limit: number = ROOM_RETENTION_LIMITS.maxChargedBytes
): RoomRetentionProofBook {
	if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError("INVALID_ARGUMENT");
	let total = 0;
	let writing = false;
	const events: RoomRetentionTraceEvent[] = [];
	return Object.freeze({
		limit,
		charged: () => total,
		charge(owner: RoomRetentionOwner | "room", bytes: number): void {
			if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RoomRetentionRefusal("RETENTION_CORRUPT", "charge");
			// Every byte the transaction relies on is charged before its first irreversible effect.
			if (writing) throw new RoomRetentionRefusal("RETENTION_BUDGET", "charge-after-write");
			total += bytes;
			events.push(Object.freeze({ kind: "charge", owner, bytes, total }));
			if (total > limit) throw new RoomRetentionRefusal("RETENTION_BUDGET", `${total}>${limit}`);
		},
		write(event: Exclude<RoomRetentionTraceEvent, { kind: "charge" }>): void {
			writing = true;
			events.push(Object.freeze({ ...event }));
		},
		trace: () => Object.freeze([...events]),
	});
}
