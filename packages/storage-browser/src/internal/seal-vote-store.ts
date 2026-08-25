import { compareBytes, decodeCanonical } from "@ts-drp/canonical";

import {
	openPhase2dInternalDatabase,
	PHASE_5C_SIGNER_STATE_STORE,
	PHASE_5C_STORAGE_META_STORE,
	PHASE_5C_VOTE_OUTBOX_STORE,
	PHASE_5C_VOTE_SLOTS_STORE,
} from "./schema-idb.js";

export const VOTE_TRANSACTION_STORES = Object.freeze([
	PHASE_5C_SIGNER_STATE_STORE,
	PHASE_5C_STORAGE_META_STORE,
	PHASE_5C_VOTE_OUTBOX_STORE,
	PHASE_5C_VOTE_SLOTS_STORE,
] as const);

export interface StoredSealCarrier {
	readonly exactCanonicalPreimageBytes: Uint8Array;
	readonly signature: Uint8Array;
}

export interface PendingVoteRow {
	readonly carrier: StoredSealCarrier;
	readonly epoch: 0;
	readonly objectId: string;
	readonly phase: "commit" | "prepare" | "round-change";
	readonly round: number;
	readonly signerId: string;
	readonly dispatched: boolean;
}

export interface InternalSealVoteStore {
	readonly incarnation: string;
	readonly schema: Readonly<{ stores: readonly string[]; version: 2 }>;
	commitQc(input: unknown): Promise<unknown>;
	commitRound(input: unknown): Promise<unknown>;
	commitRoundChange(input: unknown): Promise<unknown>;
	commitVote(input: unknown): Promise<unknown>;
	close(): void;
	markDispatched(key: readonly [string, 0, number, "commit" | "prepare" | "round-change", string]): Promise<void>;
	openSnapshot(scope: unknown): Promise<unknown>;
	readPending(maxRows?: number): Promise<readonly PendingVoteRow[]>;
}

interface OpenInternalSealVoteStoreInput {
	readonly databaseName: string;
	onCommitted?(row: PendingVoteRow): void;
	onVersionChange?(): void;
}

const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get as (
	this: ArrayBuffer
) => number;
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get as
	| ((this: ArrayBuffer) => boolean)
	| undefined;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get as (
	this: Uint8Array
) => ArrayBufferLike;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get as (
	this: Uint8Array
) => number;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get as (
	this: Uint8Array
) => number;
const digestHex = /^[0-9a-f]{64}$/u;

function exactBytes(value: unknown, expectedLength?: number, maximumLength = 65_536): Uint8Array {
	try {
		if (Object.getPrototypeOf(value) !== Uint8Array.prototype) throw new TypeError("invalid byte carrier");
		const bytes = value as Uint8Array;
		const length = Reflect.apply(typedArrayByteLength, bytes, []) as number;
		if (length > maximumLength || (expectedLength !== undefined && length !== expectedLength)) {
			throw new TypeError("invalid byte length");
		}
		if ((Reflect.apply(typedArrayByteOffset, bytes, []) as number) !== 0) throw new TypeError("invalid byte offset");
		const buffer = Reflect.apply(typedArrayBuffer, bytes, []) as ArrayBufferLike;
		if (Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) throw new TypeError("invalid backing buffer");
		if ((Reflect.apply(arrayBufferByteLength, buffer, []) as number) !== length)
			throw new TypeError("invalid buffer length");
		if (arrayBufferResizable !== undefined && (Reflect.apply(arrayBufferResizable, buffer, []) as boolean)) {
			throw new TypeError("resizable buffer is unsupported");
		}
		return Uint8Array.from(bytes);
	} catch {
		throw new TypeError("invalid exact byte carrier");
	}
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as object | null;
	return prototype === Object.prototype || prototype === null;
}

function safeNonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

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

function copiedCarrier(value: unknown): StoredSealCarrier | undefined {
	if (!plainRecord(value)) return undefined;
	try {
		return Object.freeze({
			exactCanonicalPreimageBytes: exactBytes(value.exactCanonicalPreimageBytes),
			signature: exactBytes(value.signature, 64, 64),
		});
	} catch {
		return undefined;
	}
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

function voteKey(input: {
	readonly objectId: string;
	readonly round: number;
	readonly phase: "commit" | "prepare" | "round-change";
	readonly signerId: string;
}): [string, 0, number, "commit" | "prepare" | "round-change", string] {
	return [input.objectId, 0, input.round, input.phase, input.signerId];
}

function copiedPendingRow(value: unknown): PendingVoteRow | undefined {
	if (!plainRecord(value)) return undefined;
	const carrier = copiedCarrier(value.carrier);
	if (
		carrier === undefined ||
		typeof value.objectId !== "string" ||
		value.epoch !== 0 ||
		!safeNonnegative(value.round) ||
		(value.phase !== "prepare" && value.phase !== "commit" && value.phase !== "round-change") ||
		typeof value.signerId !== "string" ||
		typeof value.dispatched !== "boolean"
	) {
		return undefined;
	}
	return Object.freeze({
		carrier,
		dispatched: value.dispatched,
		epoch: 0,
		objectId: value.objectId,
		phase: value.phase,
		round: value.round,
		signerId: value.signerId,
	});
}

/**
 * Opens the package-internal strict four-store vote adapter.
 * @param input - Primary database identity and optional causal test observers.
 * @returns Validated internal vote-store capability.
 */
export async function openInternalSealVoteStore(input: OpenInternalSealVoteStoreInput): Promise<InternalSealVoteStore> {
	const connection = { database: undefined as IDBDatabase | undefined };
	const opened = (await openPhase2dInternalDatabase({ databaseName: input.databaseName }, () => {
		connection.database?.close();
		input.onVersionChange?.();
	})) as IDBDatabase;
	connection.database = opened;
	const metaTransaction = opened.transaction(PHASE_5C_STORAGE_META_STORE, "readonly");
	const meta = await requestResult(metaTransaction.objectStore(PHASE_5C_STORAGE_META_STORE).get("incarnation"));
	await transactionComplete(metaTransaction);
	if (!plainRecord(meta) || meta.key !== "incarnation" || typeof meta.value !== "string" || meta.value.length < 32) {
		opened.close();
		throw new Error("invalid storage incarnation row");
	}
	const incarnation = meta.value;

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
			raw.epoch !== undefined ||
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
			decoded.epoch !== 0 ||
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
		const stateKey: [string, 0, string] = [raw.objectId, 0, raw.signerId];
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
		const key = voteKey({ objectId: raw.objectId, phase: raw.phase, round: raw.round, signerId: raw.signerId });
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
			epoch: 0,
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
			epoch: 0,
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
			epoch: 0,
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
			decoded.epoch !== 0 ||
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
			raw.epoch !== 0 ||
			(raw.phase !== "prepare" && raw.phase !== "commit") ||
			!safeNonnegative(raw.round) ||
			typeof raw.signerId !== "string" ||
			typeof raw.valueDigest !== "string" ||
			!digestHex.test(raw.valueDigest)
		) {
			return Object.freeze({ ok: false as const, reason: "MALFORMED_INPUT" });
		}
		const transaction = opened.transaction([PHASE_5C_SIGNER_STATE_STORE, PHASE_5C_STORAGE_META_STORE], "readwrite", {
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
		const stateStore = transaction.objectStore(PHASE_5C_SIGNER_STATE_STORE);
		const stateKey: [string, 0, string] = [raw.objectId, 0, raw.signerId];
		const storedState = await requestResult(stateStore.get(stateKey));
		if (
			(storedState === undefined && raw.expectedRevision !== 0) ||
			(storedState !== undefined &&
				(!plainRecord(storedState) ||
					storedState.anchor !== raw.anchor ||
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
						epoch: 0,
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
					await completion;
					return Object.freeze({ advanced: false, duplicate: true, ok: true as const, revision: state.revision });
				}
				if (typeof highest.digest !== "string") {
					abort(transaction);
					await settleAbort(transaction);
					return Object.freeze({ ok: false as const, reason: "PREPARE_QC_CONFLICT" });
				}
				if (raw.qcDigest > highest.digest) {
					await completion;
					return Object.freeze({ advanced: false, duplicate: false, ok: true as const, revision: state.revision });
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
					await completion;
					return Object.freeze({ duplicate: true, ok: true as const, revision: state.revision });
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
		await completion;
		return Object.freeze({ advanced: true, duplicate: false, ok: true as const, revision: raw.expectedRevision + 1 });
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
			decoded.epoch !== 0 ||
			decoded.anchor !== raw.anchor ||
			decoded.round !== raw.round ||
			decoded.phase !== "round-change" ||
			decoded.signerId !== raw.signerId ||
			typeof raw.anchor !== "string" ||
			typeof raw.expectedIncarnation !== "string" ||
			!safeNonnegative(raw.expectedRevision) ||
			typeof raw.objectId !== "string" ||
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
		const stateStore = transaction.objectStore(PHASE_5C_SIGNER_STATE_STORE);
		const stateKey: [string, 0, string] = [raw.objectId, 0, raw.signerId];
		const state = await requestResult(stateStore.get(stateKey));
		const current =
			state === undefined
				? {
						anchor: raw.anchor,
						committedValueDigest: null,
						durableCommitQcCount: 0,
						durablePrepareQcCount: 0,
						enteredRound: 0,
						epoch: 0,
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
		const key = voteKey({ objectId: raw.objectId, phase: "round-change", round: raw.round, signerId: raw.signerId });
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
			epoch: 0,
			objectId: raw.objectId,
			phase: "round-change",
			round: raw.round,
			signerId: raw.signerId,
		};
		await Promise.all([
			requestResult(
				transaction.objectStore(PHASE_5C_VOTE_SLOTS_STORE).add({
					carrier,
					epoch: 0,
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
		const transaction = opened.transaction(PHASE_5C_VOTE_OUTBOX_STORE, "readonly");
		const rows: PendingVoteRow[] = [];
		const limit = Math.min(maxRows, 65_536);
		const cursor = transaction.objectStore(PHASE_5C_VOTE_OUTBOX_STORE).openCursor();
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
					if (row !== undefined && !row.dispatched) rows.push(row);
					if (rows.length >= limit) resolve();
					else selected.continue();
				},
				{ once: false }
			);
			cursor.addEventListener("error", () => reject(cursor.error ?? new Error("vote outbox cursor failed")), {
				once: true,
			});
		});
		await transactionComplete(transaction);
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
			raw.epoch !== 0 ||
			typeof raw.signerId !== "string"
		) {
			return Object.freeze({ ok: false as const, reason: "MALFORMED_INPUT" });
		}
		const transaction = opened.transaction([PHASE_5C_SIGNER_STATE_STORE, PHASE_5C_STORAGE_META_STORE], "readwrite", {
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
		const stateStore = transaction.objectStore(PHASE_5C_SIGNER_STATE_STORE);
		const stateKey: [string, 0, string] = [raw.objectId, 0, raw.signerId];
		const existingState = await requestResult(stateStore.get(stateKey));
		const state =
			existingState === undefined
				? {
						anchor: raw.anchor,
						committedValueDigest: null,
						durableCommitQcCount: 0,
						durablePrepareQcCount: 0,
						enteredRound: 0,
						epoch: 0,
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
		commitQc,
		commitRound,
		commitRoundChange,
		commitVote,
		close: () => opened.close(),
		incarnation,
		markDispatched: async (key: readonly [string, 0, number, "commit" | "prepare" | "round-change", string]) => {
			const transaction = opened.transaction(PHASE_5C_VOTE_OUTBOX_STORE, "readwrite", { durability: "strict" });
			if (transaction.durability !== "strict") {
				abort(transaction);
				await settleAbort(transaction);
				throw new Error("strict IndexedDB durability is unavailable");
			}
			const store = transaction.objectStore(PHASE_5C_VOTE_OUTBOX_STORE);
			const row = await requestResult(store.get([...key]));
			if (!plainRecord(row)) {
				abort(transaction);
				await settleAbort(transaction);
				throw new Error("missing durable vote outbox row");
			}
			await requestResult(store.put({ ...row, dispatched: true }));
			await transactionComplete(transaction);
		},
		openSnapshot: async (scope: unknown) => {
			if (
				!plainRecord(scope) ||
				typeof scope.expectedIncarnation !== "string" ||
				typeof scope.objectId !== "string" ||
				scope.epoch !== 0 ||
				typeof scope.signerId !== "string"
			) {
				throw new TypeError("invalid voter enrollment scope");
			}
			if (scope.expectedIncarnation !== incarnation) {
				return Object.freeze({ enteredRound: 0, incarnation, revision: 0, storageLoss: true });
			}
			const transaction = opened.transaction([PHASE_5C_SIGNER_STATE_STORE, PHASE_5C_VOTE_OUTBOX_STORE], "readonly");
			const state = await requestResult(
				transaction.objectStore(PHASE_5C_SIGNER_STATE_STORE).get([scope.objectId, 0, scope.signerId])
			);
			const pendingRows = await requestResult(transaction.objectStore(PHASE_5C_VOTE_OUTBOX_STORE).getAll());
			await transactionComplete(transaction);
			const pendingRoundChangeCount = pendingRows.filter(
				(row) =>
					plainRecord(row) &&
					row.objectId === scope.objectId &&
					row.epoch === 0 &&
					row.signerId === scope.signerId &&
					row.phase === "round-change"
			).length;
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
				});
			}
			if (!plainRecord(state) || state.anchor !== scope.anchor) throw new Error("invalid scoped signer state snapshot");
			const highest = plainRecord(state.highestPrepareQC) ? state.highestPrepareQC : null;
			const finalized = plainRecord(state.finalizedCommitQC) ? state.finalizedCommitQC : null;
			return Object.freeze({
				durableCommitQcCount: safeNonnegative(state.durableCommitQcCount) ? state.durableCommitQcCount : 0,
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
		schema: Object.freeze({ stores: Object.freeze(Array.from(opened.objectStoreNames)), version: 2 as const }),
	});
}
