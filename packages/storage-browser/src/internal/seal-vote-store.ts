import {openSigningBackend, type SigningBackend} from "./signing-backend.js";
import { compareBytes, decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import {
	copyStoredSealCarrier as copiedCarrier,
	copyStoredPendingVoteRow as copiedPendingRow,
	storedSealExactBytes as exactBytes,
	storedSealPlainRecord as plainRecord,
	storedSealSafeNonnegative as safeNonnegative,
	storedSealVoteKey as voteKey,
	storedSealQcContainsVote,
	type StoredSealCarrier,
	type PendingVoteRow,
	type SealDetailRetirementIntentData,
	type SealDetailRetirementResult,
	SIGNING_DETAIL_RETIREMENT_BATCH_ROWS,
	type SigningDependencyObservation,
	type SigningNativeRead,
	type SigningRetirementObservation,
} from "@ts-drp/seal/internal/storage-port";
import { AHE_BOUNDED_READ_LIMITS } from "@ts-drp/storage";

import {
	nativeReadonlyTransaction,
	nativeReadReservationCheck,
	nativeReadReservationTransaction,
	needsNativeReadReservationTurn,
	runNativeReservedRead,
} from "./native-read-reservation.js";
import {
	CURRENT_BROWSER_SCHEMA_VERSION,
	PHASE_5C_SIGNER_STATE_STORE,
	PHASE_5C_STORAGE_META_STORE,
	PHASE_5C_VOTE_OUTBOX_STORE,
	PHASE_5C_VOTE_SLOTS_STORE,
	PHASE_5E_SEAL_EVIDENCE_STORE,
	SIGNING_FRONTIER_SCHEMA_AUTHORITY,
} from "./schema-idb.js";
import {
	assertSigningCurrency,
	readSigningFrontier,
	readSigningNativeImage,
	type SigningFrontierScope,
	signingMutationRefusal,
	signingNativeTransactionComplete,
} from "./signing-retirement.js";

export { readSigningFrontier, type SigningFrontierScope } from "./signing-retirement.js";
export type { StoredSealCarrier, PendingVoteRow } from "@ts-drp/seal/internal/storage-port";

// Schema checks inspect the whole actual primary catalog in the SAME native
// transaction. This is not a cross-database reservation or a protocol grant.
export const VOTE_TRANSACTION_STORES = Object.freeze(
	SIGNING_FRONTIER_SCHEMA_AUTHORITY.stores.map((store) => store.name)
);

export interface AdvanceSigningFrontierInput extends SigningFrontierScope {
	readonly anchor: string;
	readonly expectedIncarnation: string;
	readonly expectedRevision: number;
	readonly retiredBeforeRound: number;
}

export type AdvanceSigningFrontierResult = Readonly<
	{ ok: true; revision: number; retiredBeforeRound: number } | { ok: false; reason: string }
>;

export interface InternalSealVoteStore {
	acquireSigningDependencyObservation(input: Readonly<{ objectId: string }>): Promise<SigningDependencyObservation>;
	readonly incarnation: string;
	readonly schema: Readonly<{ stores: readonly string[]; version: number }>;
	advanceRetirementFloor(input: AdvanceSigningFrontierInput): Promise<AdvanceSigningFrontierResult>;
	acquireRetirementObservation(input: Readonly<{ objectId: string }>): Promise<SigningRetirementObservation>;
	acquireRecoveryRetirementObservation(input: Readonly<{ objectId: string }>): Promise<SigningRetirementObservation>;
	acquireSigningAdmission(input: Readonly<{ objectId: string }>): Promise<SigningNativeRead>;
	commitQc(input: unknown): Promise<unknown>;
	commitRound(input: unknown): Promise<unknown>;
	commitRoundChange(input: unknown): Promise<unknown>;
	commitVote(input: unknown): Promise<unknown>;
	close(): Promise<void>;
	markDispatched(key: readonly [string, number, number, "commit" | "prepare" | "round-change", string]): Promise<void>;
	openSnapshot(scope: unknown): Promise<unknown>;
	readPending(maxRows?: number): Promise<readonly PendingVoteRow[]>;
	readPublicationCandidate(row: PendingVoteRow): Promise<PendingVoteRow | undefined>;
	retireDetails(input: SealDetailRetirementIntentData): Promise<SealDetailRetirementResult>;
}

interface OpenInternalSealVoteStoreInput {
	readonly databaseName: string;
	onCommitted?(row: PendingVoteRow): void;
	onVersionChange?(): void;
}

const digestHex = /^[0-9a-f]{64}$/u;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), {
			once: true,
		});
	});
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
	const completion = new Promise<void>((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener(
			"abort",
			() => reject(transaction.error ?? new DOMException("transaction aborted", "AbortError")),
			{ once: true }
		);
		transaction.addEventListener(
			"error",
			() => reject(transaction.error ?? new Error("IndexedDB transaction failed")),
			{ once: true }
		);
	});
	void completion.catch(() => undefined);
	return completion;
}

function abort(transaction: IDBTransaction): void {
	try {
		transaction.abort();
	} catch {
		// A transaction that has already aborted remains a rejected attempt.
	}
}

async function settleAbort(transaction: IDBTransaction): Promise<void> {
	try {
		await transactionComplete(transaction);
	} catch {
		// Typed rejection is returned by the semantic owner below.
	}
}

/**
 * Opens the package-internal strict four-store vote adapter.
 * @param input - Primary database identity and optional causal test observers.
 * @returns Validated internal vote-store capability.
 */
export async function openInternalSealVoteStore(input: OpenInternalSealVoteStoreInput, room = false): Promise<InternalSealVoteStore> {
	return createInternalSealVoteStore(await openSigningBackend(input, room), input);
}

/** Builds only mechanical storage methods over the original private backend. */
export function createInternalSealVoteStore(backend: SigningBackend, input: OpenInternalSealVoteStoreInput, sharedDependencies = false): InternalSealVoteStore {
	const {database: opened, incarnation, participant} = backend;

	const advanceRetirementFloor = async (value: AdvanceSigningFrontierInput): Promise<AdvanceSigningFrontierResult> => {
		if (!plainRecord(value)) return Object.freeze({ ok: false, reason: "MALFORMED_INPUT" });
		const keys = [
			"anchor",
			"epoch",
			"expectedIncarnation",
			"expectedRevision",
			"objectId",
			"retiredBeforeRound",
			"signerId",
		] as const;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (
			Reflect.ownKeys(descriptors).length !== keys.length ||
			keys.some((key) => descriptors[key] === undefined || !("value" in descriptors[key]))
		)
			return Object.freeze({ ok: false, reason: "MALFORMED_INPUT" });
		const raw = Object.fromEntries(
			keys.map((key) => [key, descriptors[key].value])
		) as unknown as AdvanceSigningFrontierInput;
		if (
			typeof raw.anchor !== "string" ||
			typeof raw.objectId !== "string" ||
			typeof raw.signerId !== "string" ||
			typeof raw.expectedIncarnation !== "string" ||
			!safeNonnegative(raw.epoch) ||
			!safeNonnegative(raw.expectedRevision) ||
			!safeNonnegative(raw.retiredBeforeRound)
		)
			return Object.freeze({ ok: false, reason: "MALFORMED_INPUT" });
		const transaction = opened.transaction([...VOTE_TRANSACTION_STORES], "readwrite", { durability: "strict" });
		const completion = transactionComplete(transaction);
		const refuse = async (reason: string): Promise<AdvanceSigningFrontierResult> => {
			abort(transaction);
			try {
				await completion;
			} catch {
				/* The original native abort is joined before typed delivery. */
			}
			return Object.freeze({ ok: false, reason });
		};
		try {
			if (transaction.durability !== "strict") throw new Error("strict IndexedDB durability is unavailable");
			const floor = await readSigningFrontier(transaction, raw, raw.expectedIncarnation);
			const refusal = await signingMutationRefusal(transaction, raw.objectId, raw.epoch, raw.expectedIncarnation);
			if (refusal !== undefined) {
				abort(transaction);
				await settleAbort(transaction);
				return { ok: false, reason: refusal };
			}
			const store = transaction.objectStore(PHASE_5C_SIGNER_STATE_STORE);
			const state = await requestResult(store.get([raw.objectId, raw.epoch, raw.signerId]));
			// Native row eligibility is not authentication or all-owner retirement.
			if (
				!plainRecord(state) ||
				state.anchor !== raw.anchor ||
				state.revision !== raw.expectedRevision ||
				!safeNonnegative(state.revision) ||
				state.revision === Number.MAX_SAFE_INTEGER
			)
				return await refuse("REVALIDATION_REQUIRED");
			if (raw.retiredBeforeRound < floor || raw.retiredBeforeRound > (state.enteredRound as number))
				return await refuse("INVALID_RETIREMENT_FRONTIER");
			for (const summary of [state.highestPrepareQC, state.finalizedCommitQC]) {
				if (
					summary !== null &&
					summary !== undefined &&
					(!plainRecord(summary) || !safeNonnegative(summary.round) || summary.round < raw.retiredBeforeRound)
				)
					return await refuse("CURRENT_QC_PROTECTED");
			}
			if (
				state.lockRound !== null &&
				state.lockRound !== undefined &&
				(!safeNonnegative(state.lockRound) || state.lockRound < raw.retiredBeforeRound)
			)
				return await refuse("CURRENT_LOCK_PROTECTED");
			if (raw.retiredBeforeRound === floor) {
				await completion;
				return Object.freeze({ ok: true, revision: state.revision, retiredBeforeRound: floor });
			}
			const evidence = await requestResult(
				transaction.objectStore(PHASE_5E_SEAL_EVIDENCE_STORE).get([raw.objectId, raw.epoch, raw.signerId])
			);
			if (evidence !== undefined) {
				const bytes =
					plainRecord(evidence) && plainRecord(evidence.peerEvidence)
						? evidence.peerEvidence.exactCanonicalCommitQcBytes
						: plainRecord(evidence)
							? evidence.exactCanonicalCommitQcBytes
							: undefined;
				if (
					!plainRecord(state.finalizedCommitQC) ||
					!(bytes instanceof Uint8Array) ||
					!(state.finalizedCommitQC.exactCanonicalQcBytes instanceof Uint8Array) ||
					compareBytes(bytes, state.finalizedCommitQC.exactCanonicalQcBytes) !== 0
				)
					return await refuse("EVIDENCE_DEBT_HELD");
			}
			// Existing outbox debt is genuine custody of publication/ACK work. The
			// adapter's existing 65536-row ceiling bounds this prerequisite scan.
			const debt = await new Promise<boolean>((resolve, reject) => {
				let count = 0;
				const cursor = transaction
					.objectStore(PHASE_5C_VOTE_OUTBOX_STORE)
					.openCursor(
						IDBKeyRange.bound([raw.objectId, raw.epoch], [raw.objectId, raw.epoch, raw.retiredBeforeRound], false, true)
					);
				cursor.addEventListener("error", () => reject(cursor.error));
				cursor.addEventListener("success", () => {
					const row = cursor.result;
					if (row === null) {
						resolve(false);
						return;
					}
					if (++count > 65_536) {
						reject(new Error("SIGNING_FRONTIER_SCAN_BUDGET"));
						return;
					}
					const captured = copiedPendingRow(row.value);
					if (captured === undefined) {
						reject(new Error("INVALID_SIGNING_OUTBOX"));
						return;
					}
					if (captured.signerId === raw.signerId && !captured.dispatched) {
						resolve(true);
						return;
					}
					row.continue();
				});
			});
			if (debt) return await refuse("PUBLICATION_DEBT_HELD");
			const revision = state.revision + 1;
			await requestResult(store.put({ ...state, retiredBeforeRound: raw.retiredBeforeRound, revision }));
			await completion;
			return Object.freeze({ ok: true, revision, retiredBeforeRound: raw.retiredBeforeRound });
		} catch (cause) {
			abort(transaction);
			try {
				await completion;
			} catch {
				/* Preserve the initiating cause. */
			}
			throw cause;
		}
	};

	const commitVote = async (raw: unknown): Promise<unknown> => {
		if (!plainRecord(raw)) return Object.freeze({ ok: false as const, reason: "MALFORMED_INPUT" });
		const carrier = copiedCarrier(raw.carrier);
		const prepareQC =
			raw.prepareQC === undefined || raw.prepareQC === null
				? null
				: plainRecord(raw.prepareQC) &&
					  Reflect.ownKeys(raw.prepareQC).length === 3 &&
					  typeof raw.prepareQC.digest === "string" &&
					  digestHex.test(raw.prepareQC.digest) &&
					  safeNonnegative(raw.prepareQC.round) &&
					  typeof raw.prepareQC.valueDigest === "string" &&
					  digestHex.test(raw.prepareQC.valueDigest)
					? Object.freeze({
							digest: raw.prepareQC.digest,
							round: raw.prepareQC.round,
							valueDigest: raw.prepareQC.valueDigest,
						})
					: undefined;
		if (
			carrier === undefined ||
			prepareQC === undefined ||
			!safeNonnegative(raw.epoch) ||
			typeof raw.anchor !== "string" ||
			typeof raw.expectedIncarnation !== "string" ||
			!safeNonnegative(raw.expectedRevision) ||
			typeof raw.objectId !== "string" ||
			(raw.phase !== "prepare" && raw.phase !== "commit") ||
			!safeNonnegative(raw.round) ||
			typeof raw.signerId !== "string" ||
			typeof raw.valueDigest !== "string" ||
			!digestHex.test(raw.valueDigest) ||
			(raw.phase === "commit" &&
				(prepareQC === null || prepareQC.round !== raw.round || prepareQC.valueDigest !== raw.valueDigest))
		) {
			return Object.freeze({ ok: false as const, reason: "MALFORMED_INPUT" });
		}
		let decoded: unknown;
		try {
			decoded = decodeCanonical(carrier.exactCanonicalPreimageBytes);
		} catch {
			return Object.freeze({ ok: false as const, reason: "MALFORMED_INPUT" });
		}
		if (
			!plainRecord(decoded) ||
			decoded.kind !== "drp-seal-vote" ||
			decoded.objectId !== raw.objectId ||
			decoded.epoch !== raw.epoch ||
			decoded.phase !== raw.phase ||
			decoded.round !== raw.round ||
			decoded.signerId !== raw.signerId ||
			decoded.proposalDigest !== raw.valueDigest
		) {
			return Object.freeze({ ok: false as const, reason: "MALFORMED_INPUT" });
		}
		const transaction = opened.transaction([...VOTE_TRANSACTION_STORES], "readwrite", { durability: "strict" });
		if (transaction.durability !== "strict") {
			abort(transaction);
			await settleAbort(transaction);
			throw new Error("strict IndexedDB durability is unavailable");
		}
		const completion = transactionComplete(transaction);
		const metaRow = await requestResult(transaction.objectStore(PHASE_5C_STORAGE_META_STORE).get("incarnation"));
		if (!plainRecord(metaRow) || metaRow.value !== raw.expectedIncarnation) {
			abort(transaction);
			await settleAbort(transaction);
			return Object.freeze({ ok: false as const, reason: "STORAGE_LOSS", writes: 0 });
		}

		const retiredBeforeRound = await readSigningFrontier(
			transaction,
			raw as unknown as SigningFrontierScope,
			raw.expectedIncarnation
		);
		const refusal = await signingMutationRefusal(transaction, raw.objectId, raw.epoch, raw.expectedIncarnation);
		if (refusal !== undefined || raw.round < retiredBeforeRound) {
			abort(transaction);
			await settleAbort(transaction);
			return Object.freeze({ ok: false as const, reason: refusal ?? "SIGNING_RETIRED", writes: 0 });
		}
		const stateKey: [string, number, string] = [raw.objectId, raw.epoch, raw.signerId];
		const existingState = await requestResult(transaction.objectStore(PHASE_5C_SIGNER_STATE_STORE).get(stateKey));
		const currentRevision =
			existingState === undefined ? 0 : plainRecord(existingState) ? existingState.revision : undefined;
		if (
			!safeNonnegative(currentRevision) ||
			currentRevision === Number.MAX_SAFE_INTEGER ||
			currentRevision !== raw.expectedRevision
		) {
			abort(transaction);
			await settleAbort(transaction);
			return Object.freeze({ ok: false as const, reason: "REVALIDATION_REQUIRED", writes: 0 });
		}
		if (
			existingState !== undefined &&
			(!plainRecord(existingState) ||
				existingState.anchor !== raw.anchor ||
				existingState.epoch !== raw.epoch ||
				!safeNonnegative(existingState.enteredRound) ||
				raw.round < existingState.enteredRound)
		) {
			abort(transaction);
			await settleAbort(transaction);
			return Object.freeze({ ok: false as const, reason: "REVALIDATION_REQUIRED", writes: 0 });
		}
		const existingLockedValue =
			plainRecord(existingState) && typeof existingState.lockedValueDigest === "string"
				? existingState.lockedValueDigest
				: null;
		const existingLockRound =
			plainRecord(existingState) && safeNonnegative(existingState.lockRound) ? existingState.lockRound : null;
		const existingCommittedValue =
			plainRecord(existingState) && typeof existingState.committedValueDigest === "string"
				? existingState.committedValueDigest
				: null;
		const existingHighestPrepareQC =
			plainRecord(existingState) && plainRecord(existingState.highestPrepareQC) ? existingState.highestPrepareQC : null;
		if (
			raw.phase === "commit" &&
			(prepareQC === null ||
				existingHighestPrepareQC === null ||
				existingHighestPrepareQC.digest !== prepareQC.digest ||
				existingHighestPrepareQC.round !== raw.round ||
				existingHighestPrepareQC.valueDigest !== raw.valueDigest ||
				!(existingHighestPrepareQC.exactCanonicalQcBytes instanceof Uint8Array))
		) {
			abort(transaction);
			await settleAbort(transaction);
			return Object.freeze({ ok: false as const, reason: "PREPARE_QC_REQUIRED", writes: 0 });
		}
		if (existingCommittedValue !== null && existingCommittedValue !== raw.valueDigest) {
			abort(transaction);
			await settleAbort(transaction);
			return Object.freeze({ ok: false as const, reason: "COMMITTED_VALUE_CONFLICT", writes: 0 });
		}
		if (
			existingLockedValue !== null &&
			existingLockedValue !== raw.valueDigest &&
			(prepareQC === null || existingLockRound === null || prepareQC.round < existingLockRound)
		) {
			abort(transaction);
			await settleAbort(transaction);
			return Object.freeze({ ok: false as const, reason: "LOCKED_VALUE_CONFLICT", writes: 0 });
		}
		const key = voteKey({
			epoch: raw.epoch,
			objectId: raw.objectId,
			phase: raw.phase,
			round: raw.round,
			signerId: raw.signerId,
		});
		const occupied = await requestResult(transaction.objectStore(PHASE_5C_VOTE_SLOTS_STORE).get(key));
		if (occupied !== undefined) {
			const stored = plainRecord(occupied) ? copiedCarrier(occupied.carrier) : undefined;
			if (stored === undefined) {
				abort(transaction);
				await settleAbort(transaction);
				throw new Error("invalid occupied vote slot");
			}
			if (compareBytes(stored.exactCanonicalPreimageBytes, carrier.exactCanonicalPreimageBytes) === 0) {
				await completion;
				return Object.freeze({ duplicate: true, ok: true as const, revision: currentRevision, stored, writes: 0 });
			}
			abort(transaction);
			await settleAbort(transaction);
			return Object.freeze({ existing: stored, ok: false as const, reason: "VOTE_CONFLICT", writes: 0 });
		}
		const slotRow = {
			carrier,
			epoch: raw.epoch,
			objectId: raw.objectId,
			phase: raw.phase,
			round: raw.round,
			signerId: raw.signerId,
		};
		const enteredRound = Math.max(
			plainRecord(existingState) && safeNonnegative(existingState.enteredRound) ? existingState.enteredRound : 0,
			raw.round
		);
		const stateRow = {
			retiredBeforeRound,
			anchor: raw.anchor,
			committedValueDigest:
				raw.phase === "commit"
					? raw.valueDigest
					: plainRecord(existingState)
						? (existingState.committedValueDigest ?? null)
						: null,
			durableCommitQcCount:
				plainRecord(existingState) && safeNonnegative(existingState.durableCommitQcCount)
					? existingState.durableCommitQcCount
					: 0,
			durablePrepareQcCount:
				plainRecord(existingState) && safeNonnegative(existingState.durablePrepareQcCount)
					? existingState.durablePrepareQcCount
					: 0,
			enteredRound,
			epoch: raw.epoch,
			finalizedCommitQC: plainRecord(existingState) ? (existingState.finalizedCommitQC ?? null) : null,
			finalizedValueDigest: plainRecord(existingState) ? (existingState.finalizedValueDigest ?? null) : null,
			highestPrepareQC: existingHighestPrepareQC,
			lockRound: existingLockRound,
			lockedValueDigest: existingLockedValue,
			objectId: raw.objectId,
			revision: currentRevision + 1,
			signerId: raw.signerId,
		};
		const outboxRow: PendingVoteRow = {
			carrier,
			dispatched: false,
			epoch: raw.epoch,
			objectId: raw.objectId,
			phase: raw.phase,
			round: raw.round,
			signerId: raw.signerId,
		};
		const slotRequest = transaction.objectStore(PHASE_5C_VOTE_SLOTS_STORE).add(slotRow);
		const stateRequest = transaction.objectStore(PHASE_5C_SIGNER_STATE_STORE).put(stateRow);
		const outboxRequest = transaction.objectStore(PHASE_5C_VOTE_OUTBOX_STORE).add(outboxRow);
		await Promise.all([requestResult(slotRequest), requestResult(stateRequest), requestResult(outboxRequest)]);
		await completion;
		input.onCommitted?.(copiedPendingRow(outboxRow) as PendingVoteRow);
		return Object.freeze({
			duplicate: false,
			ok: true as const,
			revision: currentRevision + 1,
			stored: copiedCarrier(carrier),
			writes: 3,
		});
	};

	const commitQc = async (raw: unknown): Promise<unknown> => {
		if (!plainRecord(raw)) return Object.freeze({ ok: false as const, reason: "MALFORMED_INPUT" });
		let exactCanonicalQcBytes: Uint8Array;
		let decoded: unknown;
		try {
			exactCanonicalQcBytes = exactBytes(raw.exactCanonicalQcBytes);
			decoded = decodeCanonical(exactCanonicalQcBytes);
		} catch {
			return Object.freeze({ ok: false as const, reason: "MALFORMED_INPUT" });
		}
		if (
			!plainRecord(decoded) ||
			decoded.kind !== "drp-seal-qc" ||
			decoded.objectId !== raw.objectId ||
			decoded.epoch !== raw.epoch ||
			decoded.phase !== raw.phase ||
			decoded.round !== raw.round ||
			decoded.proposalDigest !== raw.valueDigest ||
			decoded.proposalHash !== raw.proposalHash ||
			typeof raw.qcDigest !== "string" ||
			!digestHex.test(raw.qcDigest) ||
			typeof raw.anchor !== "string" ||
			typeof raw.expectedIncarnation !== "string" ||
			!safeNonnegative(raw.expectedRevision) ||
			typeof raw.objectId !== "string" ||
			!safeNonnegative(raw.epoch) ||
			(raw.phase !== "prepare" && raw.phase !== "commit") ||
			!safeNonnegative(raw.round) ||
			typeof raw.signerId !== "string" ||
			typeof raw.valueDigest !== "string" ||
			!digestHex.test(raw.valueDigest)
		) {
			return Object.freeze({ ok: false as const, reason: "MALFORMED_INPUT" });
		}
		const transaction = opened.transaction([...VOTE_TRANSACTION_STORES], "readwrite", {
			durability: "strict",
		});
		if (transaction.durability !== "strict") {
			abort(transaction);
			await settleAbort(transaction);
			throw new Error("strict IndexedDB durability is unavailable");
		}
		const completion = transactionComplete(transaction);
		const metaRow = await requestResult(transaction.objectStore(PHASE_5C_STORAGE_META_STORE).get("incarnation"));
		if (!plainRecord(metaRow) || metaRow.value !== raw.expectedIncarnation) {
			abort(transaction);
			await settleAbort(transaction);
			return Object.freeze({ ok: false as const, reason: "STORAGE_LOSS" });
		}

		const floor = await readSigningFrontier(
			transaction,
			raw as unknown as SigningFrontierScope,
			raw.expectedIncarnation
		);
		const refusal = await signingMutationRefusal(
			transaction,
			raw.objectId as string,
			raw.epoch as number,
			raw.expectedIncarnation as string
		);
		if (refusal !== undefined || (raw.round as number) < floor) {
			abort(transaction);
			await settleAbort(transaction);
			return Object.freeze({ ok: false as const, reason: refusal ?? "SIGNING_RETIRED" });
		}
		const stateStore = transaction.objectStore(PHASE_5C_SIGNER_STATE_STORE);
		const stateKey: [string, number, string] = [raw.objectId, raw.epoch, raw.signerId];
		const storedState = await requestResult(stateStore.get(stateKey));
		if (
			(storedState === undefined && raw.expectedRevision !== 0) ||
			(storedState !== undefined &&
				(!plainRecord(storedState) ||
					storedState.anchor !== raw.anchor ||
					storedState.epoch !== raw.epoch ||
					storedState.revision !== raw.expectedRevision ||
					!safeNonnegative(storedState.revision) ||
					storedState.revision === Number.MAX_SAFE_INTEGER))
		) {
			abort(transaction);
			await settleAbort(transaction);
			return Object.freeze({ ok: false as const, reason: "REVALIDATION_REQUIRED" });
		}
		const state =
			storedState === undefined
				? Object.freeze({
						anchor: raw.anchor,
						committedValueDigest: null,
						durableCommitQcCount: 0,
						durablePrepareQcCount: 0,
						enteredRound: 0,
						epoch: raw.epoch,
						finalizedCommitQC: null,
						finalizedValueDigest: null,
						highestPrepareQC: null,
						lockRound: null,
						lockedValueDigest: null,
						objectId: raw.objectId,
						revision: 0,
						signerId: raw.signerId,
					})
				: storedState;
		const exactQc = Object.freeze({
			digest: raw.qcDigest,
			exactCanonicalQcBytes: Uint8Array.from(exactCanonicalQcBytes),
			phase: raw.phase,
			proposalHash: raw.proposalHash,
			round: raw.round,
			valueDigest: raw.valueDigest,
		});
		const completeQc = async <T>(result: T): Promise<T> => {
			// Same successful QC transaction, not a best-effort later dispatcher.
			// An absent/unmatched carrier remains pending; duplicate QC retries may
			// complete this exact receipt without changing the signer revision.
			const outbox = transaction.objectStore(PHASE_5C_VOTE_OUTBOX_STORE);
			const key = voteKey(raw as unknown as PendingVoteRow);
			const pending = await requestResult(outbox.get(key));
			if (plainRecord(pending) && pending.dispatched === false && storedSealQcContainsVote(decoded, pending))
				await requestResult(outbox.put({...pending, dispatched: true}));
			await completion;
			return result;
		};
		if (raw.phase === "prepare") {
			const highest = plainRecord(state.highestPrepareQC) ? state.highestPrepareQC : null;
			if (highest !== null && highest.round === raw.round) {
				if (highest.valueDigest !== raw.valueDigest) {
					abort(transaction);
					await settleAbort(transaction);
					return Object.freeze({ ok: false as const, reason: "PREPARE_QC_CONFLICT" });
				}
				if (highest.digest === raw.qcDigest) {
					if (compareBytes(exactBytes(highest.exactCanonicalQcBytes), exactCanonicalQcBytes) !== 0) {
						abort(transaction);
						await settleAbort(transaction);
						return Object.freeze({ ok: false as const, reason: "PREPARE_QC_CONFLICT" });
					}
					return completeQc(Object.freeze({ advanced: false, duplicate: true, ok: true as const, revision: state.revision }));
				}
				if (typeof highest.digest !== "string") {
					abort(transaction);
					await settleAbort(transaction);
					return Object.freeze({ ok: false as const, reason: "PREPARE_QC_CONFLICT" });
				}
				if (raw.qcDigest > highest.digest) {
					return completeQc(Object.freeze({ advanced: false, duplicate: false, ok: true as const, revision: state.revision }));
				}
			}
			if (highest !== null && safeNonnegative(highest.round) && highest.round > raw.round) {
				abort(transaction);
				await settleAbort(transaction);
				return Object.freeze({ ok: false as const, reason: "QC_ROLLBACK" });
			}
			await requestResult(
				stateStore.put({
					...state,
					durablePrepareQcCount: (safeNonnegative(state.durablePrepareQcCount) ? state.durablePrepareQcCount : 0) + 1,
					enteredRound: Math.max(safeNonnegative(state.enteredRound) ? state.enteredRound : 0, raw.round),
					highestPrepareQC: exactQc,
					lockRound: raw.round,
					lockedValueDigest: raw.valueDigest,
					revision: state.revision + 1,
				})
			);
		} else {
			const highest = plainRecord(state.highestPrepareQC) ? state.highestPrepareQC : null;
			if (highest === null || highest.round !== raw.round || highest.valueDigest !== raw.valueDigest) {
				abort(transaction);
				await settleAbort(transaction);
				return Object.freeze({ ok: false as const, reason: "PREPARE_QC_REQUIRED" });
			}
			const existingFinal = plainRecord(state.finalizedCommitQC) ? state.finalizedCommitQC : null;
			if (existingFinal !== null) {
				if (compareBytes(exactBytes(existingFinal.exactCanonicalQcBytes), exactCanonicalQcBytes) === 0) {
					return completeQc(Object.freeze({ duplicate: true, ok: true as const, revision: state.revision }));
				}
				abort(transaction);
				await settleAbort(transaction);
				return Object.freeze({ ok: false as const, reason: "FINALIZED_VALUE_CONFLICT" });
			}
			await requestResult(
				stateStore.put({
					...state,
					durableCommitQcCount: (safeNonnegative(state.durableCommitQcCount) ? state.durableCommitQcCount : 0) + 1,
					finalizedCommitQC: exactQc,
					finalizedValueDigest: raw.valueDigest,
					revision: state.revision + 1,
				})
			);
		}
		return completeQc(Object.freeze({ advanced: true, duplicate: false, ok: true as const, revision: raw.expectedRevision + 1 }));
	};

	const commitRoundChange = async (raw: unknown): Promise<unknown> => {
		if (!plainRecord(raw)) return Object.freeze({ ok: false as const, reason: "MALFORMED_INPUT" });
		const carrier = copiedCarrier(raw.carrier);
		let decoded: unknown;
		try {
			decoded = carrier === undefined ? undefined : decodeCanonical(carrier.exactCanonicalPreimageBytes);
		} catch {
			return Object.freeze({ ok: false as const, reason: "MALFORMED_INPUT" });
		}
		if (
			carrier === undefined ||
			!plainRecord(decoded) ||
			decoded.kind !== "drp-round-change" ||
			decoded.objectId !== raw.objectId ||
			decoded.epoch !== raw.epoch ||
			decoded.anchor !== raw.anchor ||
			decoded.round !== raw.round ||
			decoded.phase !== "round-change" ||
			decoded.signerId !== raw.signerId ||
			typeof raw.anchor !== "string" ||
			typeof raw.expectedIncarnation !== "string" ||
			!safeNonnegative(raw.expectedRevision) ||
			typeof raw.objectId !== "string" ||
			!safeNonnegative(raw.epoch) ||
			!safeNonnegative(raw.round) ||
			typeof raw.signerId !== "string"
		) {
			return Object.freeze({ ok: false as const, reason: "MALFORMED_INPUT" });
		}
		const transaction = opened.transaction([...VOTE_TRANSACTION_STORES], "readwrite", { durability: "strict" });
		if (transaction.durability !== "strict") {
			abort(transaction);
			await settleAbort(transaction);
			throw new Error("strict IndexedDB durability is unavailable");
		}
		const completion = transactionComplete(transaction);
		const metaRow = await requestResult(transaction.objectStore(PHASE_5C_STORAGE_META_STORE).get("incarnation"));
		if (!plainRecord(metaRow) || metaRow.value !== raw.expectedIncarnation) {
			abort(transaction);
			await settleAbort(transaction);
			return Object.freeze({ ok: false as const, reason: "STORAGE_LOSS" });
		}

		const floor = await readSigningFrontier(
			transaction,
			raw as unknown as SigningFrontierScope,
			raw.expectedIncarnation
		);
		const refusal = await signingMutationRefusal(
			transaction,
			raw.objectId as string,
			raw.epoch as number,
			raw.expectedIncarnation as string
		);
		if (refusal !== undefined || (raw.round as number) < floor) {
			abort(transaction);
			await settleAbort(transaction);
			return Object.freeze({ ok: false as const, reason: refusal ?? "SIGNING_RETIRED" });
		}
		const stateStore = transaction.objectStore(PHASE_5C_SIGNER_STATE_STORE);
		const stateKey: [string, number, string] = [raw.objectId, raw.epoch, raw.signerId];
		const state = await requestResult(stateStore.get(stateKey));
		const current =
			state === undefined
				? {
						anchor: raw.anchor,
						committedValueDigest: null,
						durableCommitQcCount: 0,
						durablePrepareQcCount: 0,
						enteredRound: 0,
						epoch: raw.epoch,
						finalizedCommitQC: null,
						finalizedValueDigest: null,
						highestPrepareQC: null,
						lockRound: null,
						lockedValueDigest: null,
						objectId: raw.objectId,
						revision: 0,
						signerId: raw.signerId,
					}
				: state;
		if (
			!plainRecord(current) ||
			current.anchor !== raw.anchor ||
			current.epoch !== raw.epoch ||
			current.revision !== raw.expectedRevision ||
			!safeNonnegative(current.revision) ||
			current.revision === Number.MAX_SAFE_INTEGER ||
			!safeNonnegative(current.enteredRound) ||
			raw.round <= current.enteredRound
		) {
			abort(transaction);
			await settleAbort(transaction);
			return Object.freeze({ ok: false as const, reason: "REVALIDATION_REQUIRED" });
		}
		const key = voteKey({
			epoch: raw.epoch,
			objectId: raw.objectId,
			phase: "round-change",
			round: raw.round,
			signerId: raw.signerId,
		});
		const occupied = await requestResult(transaction.objectStore(PHASE_5C_VOTE_SLOTS_STORE).get(key));
		if (occupied !== undefined) {
			const stored = plainRecord(occupied) ? copiedCarrier(occupied.carrier) : undefined;
			if (
				stored !== undefined &&
				compareBytes(stored.exactCanonicalPreimageBytes, carrier.exactCanonicalPreimageBytes) === 0
			) {
				await completion;
				return Object.freeze({ duplicate: true, ok: true as const, revision: current.revision });
			}
			abort(transaction);
			await settleAbort(transaction);
			return Object.freeze({ existing: stored, ok: false as const, reason: "ROUND_CHANGE_CONFLICT" });
		}
		const row: PendingVoteRow = {
			carrier,
			dispatched: false,
			epoch: raw.epoch,
			objectId: raw.objectId,
			phase: "round-change",
			round: raw.round,
			signerId: raw.signerId,
		};
		await Promise.all([
			requestResult(
				transaction.objectStore(PHASE_5C_VOTE_SLOTS_STORE).add({
					carrier,
					epoch: raw.epoch,
					objectId: raw.objectId,
					phase: "round-change",
					round: raw.round,
					signerId: raw.signerId,
				})
			),
			requestResult(transaction.objectStore(PHASE_5C_VOTE_OUTBOX_STORE).add(row)),
			requestResult(
				stateStore.put({
					...current,
					enteredRound: raw.round,
					revision: current.revision + 1,
				})
			),
		]);
		await completion;
		input.onCommitted?.(copiedPendingRow(row) as PendingVoteRow);
		return Object.freeze({ duplicate: false, ok: true as const, revision: current.revision + 1 });
	};

	const readPending = async (maxRows = Number.MAX_SAFE_INTEGER): Promise<readonly PendingVoteRow[]> => {
		if (!safeNonnegative(maxRows) || maxRows === 0) return Object.freeze([]);
		const transaction = opened.transaction([...VOTE_TRANSACTION_STORES], "readonly");
		const completion = transactionComplete(transaction);
		try {
			await assertSigningCurrency(transaction, incarnation);
		} catch (cause) {
			abort(transaction);
			try {
				await completion;
			} catch {
				/* Preserve currency failure. */
			}
			throw cause;
		}
		const rows: PendingVoteRow[] = [];
		const limit = Math.min(maxRows, 65_536);
		const cursor = transaction.objectStore(PHASE_5C_VOTE_OUTBOX_STORE).openCursor();
		try {
			await new Promise<void>((resolve, reject) => {
				cursor.addEventListener(
					"success",
					() => {
						const selected = cursor.result;
						if (selected === null || rows.length >= limit) {
							resolve();
							return;
						}
						const row = copiedPendingRow(selected.value);
						void (async (): Promise<void> => {
							if (row !== undefined && !row.dispatched) {
								const floor = await readSigningFrontier(transaction, row, incarnation);
								const refusal = await signingMutationRefusal(transaction, row.objectId, row.epoch, incarnation);
								if (refusal !== undefined || row.round < floor) throw new Error(refusal ?? "SIGNING_RETIRED");
								rows.push(row);
							}
							if (rows.length >= limit) resolve();
							else selected.continue();
						})().catch((cause) => {
							abort(transaction);
							reject(cause);
						});
					},
					{ once: false }
				);
				cursor.addEventListener("error", () => reject(cursor.error ?? new Error("vote outbox cursor failed")), {
					once: true,
				});
			});
			await completion;
		} catch (cause) {
			abort(transaction);
			try {
				await completion;
			} catch {
				/* Preserve the selected failure after native settlement. */
			}
			throw cause;
		}
		return Object.freeze(
			rows.sort((left, right) => JSON.stringify(voteKey(left)).localeCompare(JSON.stringify(voteKey(right))))
		);
	};

	const commitRound = async (raw: unknown): Promise<unknown> => {
		if (
			!plainRecord(raw) ||
			typeof raw.expectedIncarnation !== "string" ||
			!safeNonnegative(raw.expectedRevision) ||
			!safeNonnegative(raw.round) ||
			typeof raw.anchor !== "string" ||
			typeof raw.objectId !== "string" ||
			!safeNonnegative(raw.epoch) ||
			typeof raw.signerId !== "string"
		) {
			return Object.freeze({ ok: false as const, reason: "MALFORMED_INPUT" });
		}
		const transaction = opened.transaction([...VOTE_TRANSACTION_STORES], "readwrite", {
			durability: "strict",
		});
		if (transaction.durability !== "strict") {
			abort(transaction);
			await settleAbort(transaction);
			throw new Error("strict IndexedDB durability is unavailable");
		}
		const completion = transactionComplete(transaction);
		const metaRow = await requestResult(transaction.objectStore(PHASE_5C_STORAGE_META_STORE).get("incarnation"));
		if (!plainRecord(metaRow) || metaRow.value !== raw.expectedIncarnation) {
			abort(transaction);
			await settleAbort(transaction);
			return Object.freeze({ ok: false as const, reason: "STORAGE_LOSS" });
		}

		const floor = await readSigningFrontier(
			transaction,
			raw as unknown as SigningFrontierScope,
			raw.expectedIncarnation
		);
		const refusal = await signingMutationRefusal(
			transaction,
			raw.objectId as string,
			raw.epoch as number,
			raw.expectedIncarnation as string
		);
		if (refusal !== undefined || (raw.round as number) < floor) {
			abort(transaction);
			await settleAbort(transaction);
			return Object.freeze({ ok: false as const, reason: refusal ?? "SIGNING_RETIRED" });
		}
		const stateStore = transaction.objectStore(PHASE_5C_SIGNER_STATE_STORE);
		const stateKey: [string, number, string] = [raw.objectId, raw.epoch, raw.signerId];
		const existingState = await requestResult(stateStore.get(stateKey));
		const state =
			existingState === undefined
				? {
						anchor: raw.anchor,
						committedValueDigest: null,
						durableCommitQcCount: 0,
						durablePrepareQcCount: 0,
						enteredRound: 0,
						epoch: raw.epoch,
						finalizedCommitQC: null,
						finalizedValueDigest: null,
						highestPrepareQC: null,
						lockRound: null,
						lockedValueDigest: null,
						objectId: raw.objectId,
						revision: 0,
						signerId: raw.signerId,
					}
				: existingState;
		if (
			!plainRecord(state) ||
			state.anchor !== raw.anchor ||
			state.epoch !== raw.epoch ||
			!safeNonnegative(state.revision) ||
			state.revision === Number.MAX_SAFE_INTEGER ||
			state.revision !== raw.expectedRevision ||
			!safeNonnegative(state.enteredRound) ||
			raw.round < state.enteredRound
		) {
			abort(transaction);
			await settleAbort(transaction);
			return Object.freeze({ ok: false as const, reason: "REVALIDATION_REQUIRED" });
		}
		const revision = state.revision + 1;
		await requestResult(stateStore.put({ ...state, enteredRound: raw.round, revision }));
		await completion;
		return Object.freeze({ ok: true as const, revision });
	};

	return Object.freeze({
		advanceRetirementFloor,
		acquireSigningDependencyObservation: (input: Readonly<{ objectId: string }>) =>
			sharedDependencies ? participant.acquireSharedDependency(input, "vote") : participant.acquireDependency(input),
		acquireRetirementObservation: (input: Readonly<{ objectId: string }>) =>
			sharedDependencies ? participant.acquireSharedRetirement(input, "vote") : participant.acquire(input),
		acquireRecoveryRetirementObservation: (input: Readonly<{ objectId: string }>) =>
			sharedDependencies ? participant.acquireSharedRetirement(input, "vote", true) : participant.acquireRecovery(input),
		acquireSigningAdmission: (input: Readonly<{ objectId: string }>) => participant.acquireSigningAdmission(input),
		commitQc,
		commitRound,
		commitRoundChange,
		commitVote,
		close: () => participant.close(),
		incarnation,
		markDispatched: async (key: readonly [string, number, number, "commit" | "prepare" | "round-change", string]) => {
			if (
				!Array.isArray(key) ||
				key.length !== 5 ||
				typeof key[0] !== "string" ||
				!safeNonnegative(key[1]) ||
				!safeNonnegative(key[2]) ||
				typeof key[4] !== "string" ||
				(key[3] !== "prepare" && key[3] !== "commit" && key[3] !== "round-change")
			)
				throw new TypeError("invalid dispatched vote key");
			const transaction = opened.transaction([...VOTE_TRANSACTION_STORES], "readwrite", { durability: "strict" });
			if (transaction.durability !== "strict") {
				abort(transaction);
				await settleAbort(transaction);
				throw new Error("strict IndexedDB durability is unavailable");
			}
			const store = transaction.objectStore(PHASE_5C_VOTE_OUTBOX_STORE);
			const floor = await readSigningFrontier(
				transaction,
				{ objectId: key[0], epoch: key[1], signerId: key[4] },
				incarnation
			);
			const refusal = await signingMutationRefusal(transaction, key[0], key[1], incarnation);
			if (refusal !== undefined || key[2] < floor) {
				abort(transaction);
				await settleAbort(transaction);
				throw new Error(refusal ?? "SIGNING_RETIRED");
			}
			const row = await requestResult(store.get([...key]));
			if (!plainRecord(row)) {
				abort(transaction);
				await settleAbort(transaction);
				throw new Error("missing durable vote outbox row");
			}
			await requestResult(store.put({ ...row, dispatched: true }));
			await transactionComplete(transaction);
		},
		openSnapshot: async function openSnapshot(scope: unknown): Promise<unknown> {
			// A genuine voter may already hold the whole native signing image.
			// Borrow that SAME RO turn: a fresh RO could queue behind a foreign
			// writer which is itself waiting for the held image to be released.
			if (needsNativeReadReservationTurn(opened)) return runNativeReservedRead(opened, () => openSnapshot(scope));
			if (
				!plainRecord(scope) ||
				typeof scope.expectedIncarnation !== "string" ||
				typeof scope.objectId !== "string" ||
				!safeNonnegative(scope.epoch) ||
				typeof scope.signerId !== "string"
			) {
				throw new TypeError("invalid voter enrollment scope");
			}
			if (scope.expectedIncarnation !== incarnation) {
				return Object.freeze({ enteredRound: 0, incarnation, revision: 0, storageLoss: true });
			}
			const transaction = nativeReadonlyTransaction(opened, [...VOTE_TRANSACTION_STORES]);
			const retiredBeforeRound = await readSigningFrontier(
				transaction,
				scope as unknown as SigningFrontierScope,
				incarnation
			);
			const state = await requestResult(
				transaction.objectStore(PHASE_5C_SIGNER_STATE_STORE).get([scope.objectId, scope.epoch, scope.signerId])
			);
			const outbox = transaction.objectStore(PHASE_5C_VOTE_OUTBOX_STORE);
			// The native compound key binds object/epoch/phase/signer. Walk only
			// this epoch's keys and materialize matching rows for the existing
			// plain-record check, not every historical carrier in the database.
			const pendingRoundChangeCount = await new Promise<number>((resolve, reject) => {
				let count = 0;
				const cursorRequest = outbox.openKeyCursor(
					// A next-epoch prefix includes every native round-key type,
					// including arrays. MAX_SAFE_INTEGER + 1 is still a finite,
					// strictly larger IDB boundary, not an admitted protocol epoch.
					IDBKeyRange.bound([scope.objectId, scope.epoch], [scope.objectId, (scope.epoch as number) + 1], false, true)
				);
				cursorRequest.addEventListener("error", () =>
					reject(cursorRequest.error ?? new Error("vote outbox cursor failed"))
				);
				cursorRequest.addEventListener("success", () => {
					const cursor = cursorRequest.result;
					if (cursor === null) {
						resolve(count);
						return;
					}
					const key = cursor.key;
					if (
						!Array.isArray(key) ||
						key[0] !== scope.objectId ||
						key[1] !== scope.epoch ||
						key[3] !== "round-change" ||
						key[4] !== scope.signerId
					) {
						cursor.continue();
						return;
					}
					const rowRequest = outbox.get(key);
					rowRequest.addEventListener("error", () => reject(rowRequest.error ?? new Error("vote outbox read failed")), {
						once: true,
					});
					rowRequest.addEventListener(
						"success",
						() => {
							if (plainRecord(rowRequest.result)) count++;
							cursor.continue();
						},
						{ once: true }
					);
				});
			});
			await (nativeReadReservationCheck(transaction) ?? transactionComplete(transaction));
			if (state === undefined) {
				return Object.freeze({
					durableCommitQcCount: 0,
					durablePrepareQcCount: 0,
					enteredRound: 0,
					finalizedCommitQcBytes: null,
					finalizedValueDigest: null,
					highestPrepareQcBytes: null,
					highestPrepareQcDigest: null,
					incarnation,
					lockedValueDigest: null,
					pendingRoundChangeCount,
					revision: 0,
					retiredBeforeRound,
				});
			}
			if (!plainRecord(state) || state.anchor !== scope.anchor || state.epoch !== scope.epoch) {
				throw new Error("invalid scoped signer state snapshot");
			}
			const highest = plainRecord(state.highestPrepareQC) ? state.highestPrepareQC : null;
			const finalized = plainRecord(state.finalizedCommitQC) ? state.finalizedCommitQC : null;
			return Object.freeze({
				durableCommitQcCount: safeNonnegative(state.durableCommitQcCount) ? state.durableCommitQcCount : 0,
				retiredBeforeRound,
				durablePrepareQcCount: safeNonnegative(state.durablePrepareQcCount) ? state.durablePrepareQcCount : 0,
				enteredRound: state.enteredRound,
				finalizedCommitQcBytes: finalized === null ? null : exactBytes(finalized.exactCanonicalQcBytes),
				finalizedValueDigest: typeof state.finalizedValueDigest === "string" ? state.finalizedValueDigest : null,
				highestPrepareQcBytes: highest === null ? null : exactBytes(highest.exactCanonicalQcBytes),
				highestPrepareQcDigest: highest === null || typeof highest.digest !== "string" ? null : highest.digest,
				incarnation,
				lockedValueDigest: typeof state.lockedValueDigest === "string" ? state.lockedValueDigest : null,
				pendingRoundChangeCount,
				revision: state.revision,
			});
		},
		readPending,
		readPublicationCandidate: async function readPublicationCandidate(
			candidate: PendingVoteRow
		): Promise<PendingVoteRow | undefined> {
			if (needsNativeReadReservationTurn(opened))
				return runNativeReservedRead(opened, () => readPublicationCandidate(candidate));
			const transaction = nativeReadReservationTransaction(opened);
			if (transaction === undefined) throw new Error("PUBLICATION_ADMISSION_REQUIRED");
			const key = voteKey(candidate);
			const floor = await readSigningFrontier(transaction, candidate, incarnation);
			const refusal = await signingMutationRefusal(transaction, candidate.objectId, candidate.epoch, incarnation);
			if (refusal !== undefined || candidate.round < floor) throw new Error(refusal ?? "SIGNING_RETIRED");
			const value: unknown = await requestResult(transaction.objectStore(PHASE_5C_VOTE_OUTBOX_STORE).get(key));
			await nativeReadReservationCheck(transaction);
			if (value === undefined) return undefined;
			const row = copiedPendingRow(value);
			if (
				row === undefined ||
				JSON.stringify(voteKey(row)) !== JSON.stringify(key) ||
				compareBytes(row.carrier.exactCanonicalPreimageBytes, candidate.carrier.exactCanonicalPreimageBytes) !== 0 ||
				compareBytes(row.carrier.signature, candidate.carrier.signature) !== 0
			)
				throw new Error("PUBLICATION_CANDIDATE_CHANGED");
			return row.dispatched ? undefined : row;
		},
		retireDetails: async (raw: SealDetailRetirementIntentData): Promise<SealDetailRetirementResult> => {
			// Only the public adapter's consumed genuine-voter intent grants the
			// authenticated selection. This original store enforces native CAS,
			// bounded detail-only mutation and permanent mechanical admission.
			if (
				!plainRecord(raw) ||
				Reflect.ownKeys(raw).length !== 10 ||
				typeof raw.anchor !== "string" ||
				typeof raw.objectId !== "string" ||
				typeof raw.signerId !== "string" ||
				typeof raw.imageDigest !== "string" ||
				!digestHex.test(raw.imageDigest) ||
				!safeNonnegative(raw.epoch) ||
				!safeNonnegative(raw.expectedRevision) ||
				!safeNonnegative(raw.retiredBeforeRound) ||
				raw.retiredBeforeRound === 0 ||
				!(raw.highestPrepareQcBytes instanceof Uint8Array) ||
				(raw.finalizedCommitQcBytes !== null && !(raw.finalizedCommitQcBytes instanceof Uint8Array))
			)
				return Object.freeze({ ok: false, reason: "MALFORMED_INPUT" });
			if (raw.expectedIncarnation !== incarnation) return Object.freeze({ ok: false, reason: "STORAGE_LOSS" });
			if (nativeReadReservationTransaction(opened) !== undefined) throw new Error("SIGNING_READ_NOT_JOINED");
			const transaction = opened.transaction([...VOTE_TRANSACTION_STORES], "readwrite", { durability: "strict" });
			const completion = signingNativeTransactionComplete(transaction);
			const refuse = async (reason: string): Promise<SealDetailRetirementResult> => {
				abort(transaction);
				try {
					await completion;
				} catch {
					/* Definite refusal joins its native abort. */
				}
				return Object.freeze({ ok: false, reason });
			};
			try {
				if (transaction.durability !== "strict") throw new Error("strict IndexedDB durability is unavailable");
				const captured = await readSigningNativeImage(transaction, raw.objectId, incarnation);
				if (captured.digest !== raw.imageDigest) return await refuse("REVALIDATION_REQUIRED");
				const floor = await readSigningFrontier(transaction, raw, incarnation);
				const refusal = await signingMutationRefusal(transaction, raw.objectId, raw.epoch, incarnation);
				if (refusal !== undefined) return await refuse(refusal);
				const stateStore = transaction.objectStore(PHASE_5C_SIGNER_STATE_STORE);
				const stateKey = [raw.objectId, raw.epoch, raw.signerId];
				const state: unknown = await requestResult(stateStore.get(stateKey));
				if (
					!plainRecord(state) ||
					state.anchor !== raw.anchor ||
					state.epoch !== raw.epoch ||
					state.revision !== raw.expectedRevision ||
					!safeNonnegative(state.revision) ||
					state.revision === Number.MAX_SAFE_INTEGER ||
					!safeNonnegative(state.enteredRound)
				)
					return await refuse("REVALIDATION_REQUIRED");
				if (raw.retiredBeforeRound < floor || raw.retiredBeforeRound > state.enteredRound)
					return await refuse("INVALID_RETIREMENT_FRONTIER");
				const highest = state.highestPrepareQC,
					finalized = state.finalizedCommitQC;
				if (
					!plainRecord(highest) ||
					!safeNonnegative(highest.round) ||
					highest.round < raw.retiredBeforeRound ||
					!(highest.exactCanonicalQcBytes instanceof Uint8Array) ||
					compareBytes(highest.exactCanonicalQcBytes, raw.highestPrepareQcBytes) !== 0 ||
					!safeNonnegative(state.lockRound) ||
					state.lockRound < raw.retiredBeforeRound
				)
					return await refuse("CURRENT_QC_PROTECTED");
				if (raw.finalizedCommitQcBytes === null) {
					if (finalized !== null && finalized !== undefined) return await refuse("CURRENT_QC_PROTECTED");
				} else if (
					!plainRecord(finalized) ||
					!safeNonnegative(finalized.round) ||
					finalized.round < raw.retiredBeforeRound ||
					!(finalized.exactCanonicalQcBytes instanceof Uint8Array) ||
					compareBytes(finalized.exactCanonicalQcBytes, raw.finalizedCommitQcBytes) !== 0
				)
					return await refuse("CURRENT_QC_PROTECTED");
				const evidence: unknown = await requestResult(
					transaction.objectStore(PHASE_5E_SEAL_EVIDENCE_STORE).get(stateKey)
				);
				if (evidence !== undefined) {
					const bytes =
						plainRecord(evidence) && plainRecord(evidence.peerEvidence)
							? evidence.peerEvidence.exactCanonicalCommitQcBytes
							: plainRecord(evidence)
								? evidence.exactCanonicalCommitQcBytes
								: undefined;
					if (
						!plainRecord(finalized) ||
						!(bytes instanceof Uint8Array) ||
						!(finalized.exactCanonicalQcBytes instanceof Uint8Array) ||
						compareBytes(bytes, finalized.exactCanonicalQcBytes) !== 0
					)
						return await refuse("EVIDENCE_DEBT_HELD");
				}
				// Reuse the original addressed, union-byte-bounded native census.
				// Never scan/materialize a second unbounded collection to select GC.
				const detail: Array<Readonly<{ table: string; key: IDBValidKey }>> = [];
				const decoded = captured.frames.map((bytes) => {
					const frame = decodeCanonical(bytes, { maxBytes: bytes.byteLength, maxItems: 65_536, maxDepth: 128 });
					if (!Array.isArray(frame) || frame.length !== 3) throw new Error("INVALID_SIGNING_FRAME");
					return { bytes, table: frame[0] as string, key: frame[1] as IDBValidKey, row: frame[2] };
				});
				for (const { table, key, row } of decoded) {
					if (table !== PHASE_5C_VOTE_SLOTS_STORE && table !== PHASE_5C_VOTE_OUTBOX_STORE) continue;
					if (!Array.isArray(key) || !plainRecord(row)) throw new Error("INVALID_SIGNING_FRAME");
					if (key[0] !== raw.objectId || key[1] !== raw.epoch || key[4] !== raw.signerId) continue;
					if (!safeNonnegative(key[2]) || key[2] >= raw.retiredBeforeRound) continue;
					// The opaque original-voter intent authenticates lower RC carriers
					// and their inline QCs under the same image CAS. Native currency
					// already requires floor <= enteredRound; no old RC is a current
					// proposal dependency. Unknown phases never grant eligibility.
					if (key[3] !== "prepare" && key[3] !== "commit" && key[3] !== "round-change")
						return await refuse("DURABLE_CARRIER_INVALID");
					if (table === PHASE_5C_VOTE_OUTBOX_STORE && row.dispatched !== true)
						return await refuse("PUBLICATION_DEBT_HELD");
					detail.push({ table, key });
				}
				const selected = detail.slice(0, SIGNING_DETAIL_RETIREMENT_BATCH_ROWS);
				const changed = selected.length > 0 || floor !== raw.retiredBeforeRound;
				const revision = changed ? state.revision + 1 : state.revision;
				const next = { ...state, retiredBeforeRound: raw.retiredBeforeRound, revision };
				for (const { table, key } of selected) await requestResult(transaction.objectStore(table).delete(key));
				if (changed) await requestResult(stateStore.put(next));
				// Same-transaction exact framing/readback before commit: every other
				// captured native row survives byte-for-byte, only summary floor/rev
				// may change. This is not a source-authentication or heap-size proof.
				const after = await readSigningNativeImage(transaction, raw.objectId, incarnation);
				const identity = (table: string, key: IDBValidKey): string => JSON.stringify([table, key]);
				const removed = new Set(selected.map(({ table, key }) => identity(table, key)));
				const actual = new Map(
					after.frames.map((bytes) => {
						const frame = decodeCanonical(bytes, {
							maxBytes: bytes.byteLength,
							maxItems: 65_536,
							maxDepth: 128,
						}) as unknown[];
						return [identity(frame[0] as string, frame[1] as IDBValidKey), bytes] as const;
					})
				);
				if (actual.size !== decoded.length - selected.length) throw new Error("SIGNING_DETAIL_READBACK_MISMATCH");
				for (const original of decoded) {
					const id = identity(original.table, original.key);
					if (removed.has(id)) {
						if (actual.has(id)) throw new Error("SIGNING_DETAIL_READBACK_MISMATCH");
						continue;
					}
					const expected =
						changed &&
						original.table === PHASE_5C_SIGNER_STATE_STORE &&
						JSON.stringify(original.key) === JSON.stringify(stateKey)
							? encodeCanonical([original.table, original.key, next], {
									maxBytes: AHE_BOUNDED_READ_LIMITS.maxUnionBytes,
									maxItems: 65_536,
									maxDepth: 128,
								})
							: original.bytes;
					const bytes = actual.get(id);
					if (bytes === undefined || compareBytes(bytes, expected) !== 0)
						throw new Error("SIGNING_DETAIL_READBACK_MISMATCH");
				}
				await completion;
				return Object.freeze({
					ok: true,
					revision,
					retiredBeforeRound: raw.retiredBeforeRound,
					deletedRows: selected.length,
					remaining: detail.length > selected.length,
				});
			} catch (primary) {
				abort(transaction);
				try {
					await completion;
				} catch {
					/* Preserve original native failure after settlement. */
				}
				throw primary;
			}
		},
		schema: Object.freeze({
			stores: Object.freeze(Array.from(opened.objectStoreNames)),
			version: CURRENT_BROWSER_SCHEMA_VERSION,
		}),
	});
}
