import {
	createRoomRetentionProofBook,
	ROOM_RETENTION_LIMITS,
	ROOM_RETENTION_OWNERS,
	type RoomRetentionApplied,
	type RoomRetentionDecision,
	roomRetentionDecisionDigest,
	type RoomRetentionKey,
	type RoomRetentionLabels,
	type RoomRetentionOwner,
	type RoomRetentionOwnerDecision,
	type RoomRetentionPlanned,
	type RoomRetentionProofBook,
	RoomRetentionRefusal,
	roomRetentionRowBytes,
	roomRetentionRowDigest,
	type RoomRetentionSelection,
	roomRetentionSourceDigest,
	type RoomRetentionTransactionLimits,
	roomRetentionWriteCount,
} from "@ts-drp/storage/room-head";

import type { RoomRetirementSession } from "./native-read-reservation.js";

/**
 * Slices 14a/14b/14e, step B: the generic part of one retention decision over a room
 * database. It never issues an IndexedDB request: each owner section, in that owner's
 * module, reads and writes its own stores on the session's strict transaction. The
 * same owner code plans the decision and, in step B, plans it again inside the acting
 * transaction; step B writes only when the re-planned decision is byte-for-byte the
 * planned one (its digest), so every row deleted is exactly the row the decision named.
 */

/** One deleted row: exact key and the digest of its exact canonical row bytes. */
export interface RoomRetentionDraftDelete {
	readonly store: string;
	readonly key: RoomRetentionKey;
	readonly digest: string;
}

/** One rewritten row: exact key, before/after digests and the value written. */
export interface RoomRetentionDraftRewrite {
	readonly store: string;
	readonly key: RoomRetentionKey;
	readonly before: string;
	readonly after: string;
	readonly value: unknown;
}

/** The composed target control row of one owner. */
export interface RoomRetentionTarget {
	/** Digest of the target control's canonical row bytes. */
	readonly digest: string;
	readonly value: unknown;
	/** The target control in the form `RoomRetentionControls` names (what the next continuation expects). */
	readonly control: string;
}

/** One owner's planned part of a decision. Planning never writes. */
export interface RoomRetentionSectionDraft {
	readonly owner: RoomRetentionOwner;
	/** Digest of the current control's canonical row bytes (the decision's `base`). */
	readonly base: string;
	/** The control read, in the form `RoomRetentionControls` names; must equal the selection's. */
	readonly control: string;
	readonly through: number;
	/** The owner's own census digest, when the decision relies on one (folded into the decision digest). */
	readonly census?: string;
	readonly deletes: readonly RoomRetentionDraftDelete[];
	readonly rewrites: readonly RoomRetentionDraftRewrite[];
	/** Composes the owner's target control from the labels through its existing transitions. */
	compose(labels: RoomRetentionLabels): Promise<RoomRetentionTarget>;
	/** Issues this section's deletes, rewrites and control write on the session transaction. */
	write(target: RoomRetentionTarget, book: RoomRetentionProofBook): Promise<void>;
}

/** What earlier sections leave for later ones (the real cross-owner order of 14b). */
export interface RoomRetentionContext {
	/** Every recovery snapshot scope that survives the snapshot section, with its incarnation. */
	snapshotSurvivors?: readonly Readonly<{
		scope: Readonly<{ objectId: string; epoch: number; anchor: string; manifestDigest: string }>;
		incarnation: string;
	}>[];
}

/** One owner's retention section over a room database. */
export interface RoomRetentionSection {
	readonly owner: RoomRetentionOwner;
	prepare(
		input: Readonly<{
			session: RoomRetirementSession;
			selection: RoomRetentionSelection;
			book: RoomRetentionProofBook;
			context: RoomRetentionContext;
		}>
	): Promise<RoomRetentionSectionDraft>;
}

/** The five sections of one room database, by owner. */
export type RoomRetentionSections = Readonly<Record<RoomRetentionOwner, RoomRetentionSection>>;

/**
 * Exact canonical row bytes of a stored row, refusing an unencodable row as corrupt.
 * @param store - Logical store name.
 * @param key - Exact key.
 * @param value - Exact stored value.
 * @returns Canonical row bytes.
 */
export function retentionRowBytes(store: string, key: RoomRetentionKey, value: unknown): Uint8Array {
	try {
		return roomRetentionRowBytes(store, key, value);
	} catch {
		throw new RoomRetentionRefusal("RETENTION_CORRUPT", `row:${store}:${JSON.stringify(key)}`);
	}
}

/**
 * Charges one read row at its exact canonical length and returns its digest.
 * @param book - The operation's proof book.
 * @param owner - Charged owner.
 * @param store - Logical store.
 * @param key - Exact key.
 * @param value - Exact stored value.
 * @param charge - False only for snapshot chunk payloads, bounded by the snapshot owner's own limits (14e).
 * @returns Row digest.
 */
export function chargeRetentionRow(
	book: RoomRetentionProofBook,
	owner: RoomRetentionOwner,
	store: string,
	key: RoomRetentionKey,
	value: unknown,
	charge = true
): string {
	const bytes = retentionRowBytes(store, key, value);
	if (charge) book.charge(owner, bytes.byteLength);
	return roomRetentionRowDigest(bytes);
}

/**
 * Digest of a row value that has not been read (a rewrite's after value, a target control).
 * @param store - Logical store.
 * @param key - Exact key.
 * @param value - Value.
 * @returns Row digest.
 */
export function retentionValueDigest(store: string, key: RoomRetentionKey, value: unknown): string {
	return roomRetentionRowDigest(retentionRowBytes(store, key, value));
}

/**
 * Refuses a stale decision.
 * @param detail - Diagnostic detail.
 */
export function retentionStale(detail: string): never {
	throw new RoomRetentionRefusal("RETENTION_STALE", detail);
}

function checkLimits(limits: RoomRetentionTransactionLimits | undefined): RoomRetentionTransactionLimits {
	if (limits === undefined) return ROOM_RETENTION_LIMITS;
	if (
		!Number.isSafeInteger(limits.maxWrites) ||
		!Number.isSafeInteger(limits.maxChargedBytes) ||
		limits.maxWrites < 0 ||
		limits.maxChargedBytes < 0 ||
		limits.maxWrites > ROOM_RETENTION_LIMITS.maxWrites ||
		limits.maxChargedBytes > ROOM_RETENTION_LIMITS.maxChargedBytes
	)
		throw new TypeError("INVALID_ARGUMENT");
	return limits;
}

function checkSelection(selection: RoomRetentionSelection): void {
	if (
		selection === null ||
		typeof selection !== "object" ||
		selection.version !== 1 ||
		typeof selection.objectId !== "string" ||
		!Number.isSafeInteger(selection.stableEpoch) ||
		!Number.isSafeInteger(selection.throughEpoch) ||
		selection.throughEpoch < 0 ||
		selection.throughEpoch >= selection.stableEpoch
	)
		throw new RoomRetentionRefusal("RETENTION_CORRUPT", "selection");
	for (const owner of ROOM_RETENTION_OWNERS)
		if (
			selection[owner] === null ||
			typeof selection[owner] !== "object" ||
			selection.controls === null ||
			typeof selection.controls !== "object" ||
			typeof selection.controls[owner] !== "string"
		)
			throw new RoomRetentionRefusal("RETENTION_CORRUPT", `selection:${owner}`);
}

async function draftAll(
	session: RoomRetirementSession,
	sections: RoomRetentionSections,
	selection: RoomRetentionSelection,
	book: RoomRetentionProofBook
): Promise<readonly RoomRetentionSectionDraft[]> {
	const context: RoomRetentionContext = {};
	const drafts: RoomRetentionSectionDraft[] = [];
	for (const owner of ROOM_RETENTION_OWNERS) {
		const draft = await sections[owner].prepare({ session, selection, book, context });
		if (draft.owner !== owner || draft.through !== selection.throughEpoch)
			throw new RoomRetentionRefusal("RETENTION_CORRUPT", `draft:${owner}`);
		// 14b: each owner control equals the one the verification that selected the decision saw.
		if (draft.control !== selection.controls[owner]) retentionStale(`${owner}:control`);
		drafts.push(draft);
	}
	return drafts;
}

function decisionOf(
	selection: RoomRetentionSelection,
	drafts: readonly RoomRetentionSectionDraft[],
	targets?: ReadonlyMap<RoomRetentionOwner, string>
): RoomRetentionDecision {
	const owners: Partial<Record<RoomRetentionOwner, RoomRetentionOwnerDecision>> = {};
	for (const draft of drafts)
		owners[draft.owner] = Object.freeze({
			base: draft.base,
			target: targets?.get(draft.owner) ?? "",
			through: draft.through,
			...(draft.census === undefined ? {} : { census: draft.census }),
			delete: Object.freeze(
				draft.deletes.map((row) => Object.freeze({ store: row.store, key: row.key, digest: row.digest }))
			),
			rewrite: Object.freeze(
				draft.rewrites.map((row) =>
					Object.freeze({ store: row.store, key: row.key, before: row.before, after: row.after })
				)
			),
		});
	return Object.freeze({
		version: 1,
		kind: "room-retention-decision-1",
		objectId: selection.objectId,
		stableEpoch: selection.stableEpoch,
		owners: Object.freeze(owners),
	});
}

/**
 * Plans one decision on the session's current transaction. Nothing is written; the
 * caller ends the transaction before step A.
 * @param session - Open room retirement session.
 * @param sections - The database's five owner sections.
 * @param selection - The node planner's selection.
 * @param limits - Per-transaction bounds (tests may lower them).
 * @returns The decision record without targets, its digest and its write count.
 */
export async function planRoomRetention(
	session: RoomRetirementSession,
	sections: RoomRetentionSections,
	selection: RoomRetentionSelection,
	limits?: RoomRetentionTransactionLimits
): Promise<RoomRetentionPlanned> {
	checkSelection(selection);
	const bounds = checkLimits(limits);
	const book = createRoomRetentionProofBook(bounds.maxChargedBytes);
	const drafts = await draftAll(session, sections, selection, book);
	const decision = decisionOf(selection, drafts);
	return Object.freeze({
		decision,
		decisionDigest: roomRetentionDecisionDigest(decision),
		writes: roomRetentionWriteCount(decision),
		charged: book.charged(),
	});
}

/**
 * Step B: one strict room transaction. Every section re-plans the same selection inside
 * the acting transaction; the re-planned decision must have exactly the planned digest
 * (every control base, every deleted row's exact bytes, every rewrite), every byte read is
 * charged before the first write, and only then are the writes issued. The caller commits;
 * any refusal aborts the whole transaction.
 * @param session - Open room retirement session.
 * @param sections - The database's five owner sections.
 * @param selection - The same selection that was planned.
 * @param labels - The decision's labels (floor fence already committed with them).
 * @param limits - Per-transaction bounds (tests may lower them).
 * @returns The decision with targets, its digest and the proof book trace.
 */
export async function applyRoomRetention(
	session: RoomRetirementSession,
	sections: RoomRetentionSections,
	selection: RoomRetentionSelection,
	labels: RoomRetentionLabels,
	limits?: RoomRetentionTransactionLimits
): Promise<RoomRetentionApplied> {
	checkSelection(selection);
	const bounds = checkLimits(limits);
	if (
		labels === null ||
		typeof labels !== "object" ||
		labels.throughEpoch !== selection.throughEpoch ||
		labels.sourceProofDigest !== roomRetentionSourceDigest(selection) ||
		typeof labels.decisionDigest !== "string"
	)
		throw new RoomRetentionRefusal("RETENTION_CORRUPT", "labels");
	const book = createRoomRetentionProofBook(bounds.maxChargedBytes);
	const drafts = await draftAll(session, sections, selection, book);
	const planned = decisionOf(selection, drafts);
	// Every byte the decision relies on was read above in this transaction; a changed,
	// missing or extra row, or a changed control, changes the decision digest.
	if (roomRetentionDecisionDigest(planned) !== labels.decisionDigest) retentionStale("decision");
	const writes = roomRetentionWriteCount(planned);
	if (writes > bounds.maxWrites) throw new RoomRetentionRefusal("RETENTION_CAPACITY", `${writes}>${bounds.maxWrites}`);
	const targets = new Map<RoomRetentionOwner, RoomRetentionTarget>();
	for (const draft of drafts) targets.set(draft.owner, await draft.compose(labels));
	for (const draft of drafts) await draft.write(targets.get(draft.owner)!, book);
	const decision = decisionOf(
		selection,
		drafts,
		new Map([...targets].map(([owner, target]) => [owner, target.digest]))
	);
	return Object.freeze({
		decision,
		decisionDigest: labels.decisionDigest,
		writes,
		charged: book.charged(),
		trace: book.trace(),
		controls: Object.freeze(
			Object.fromEntries([...targets].map(([owner, target]) => [owner, target.control]))
		) as RoomRetentionApplied["controls"],
	});
}
