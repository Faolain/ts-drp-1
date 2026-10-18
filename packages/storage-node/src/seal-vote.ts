import { compareBytes, decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import {
	consumeSealDetailRetirementIntent,
	consumeSealRoundChangeIntent,
	consumeSealVoteIntent,
	copyStoredSealCarrier as copiedCarrier,
	copyStoredPendingVoteRow as copiedPendingRow,
	storedSealExactBytes as exactBytes,
	mintSealStorePort,
	type PendingVoteRow,
	storedSealPlainRecord as plainRecord,
	resolveSealVoterEnrollment,
	storedSealSafeNonnegative as safeNonnegative,
	type SealDetailRetirementIntentData,
	type SealDetailRetirementResult,
	type SealStorePort,
	SIGNING_DETAIL_RETIREMENT_BATCH_ROWS,
	storedSealVoteKey as voteKey,
	storedSealQcContainsVote,
} from "@ts-drp/seal/internal/storage-port";
import { AHE_BOUNDED_READ_LIMITS } from "@ts-drp/storage";

import { type SigningKey, type SigningTable } from "./internal/signing-database.js";
import { acquireSqliteSigningLease, type NodeSigningStoreOptions } from "./internal/signing-lease.js";
import type { LocalSessionLifetime } from "./internal/local-session-lifetime.js";
import {
	readSqliteSigningFrontier,
	readSqliteSigningImage,
	sqliteSigningMutationRefusal,
} from "./internal/signing-retirement.js";

export type { NodeSigningStoreOptions } from "./internal/signing-lease.js";
const digestHex = /^[0-9a-f]{64}$/u;
type SigningFrontierScope = Readonly<{ objectId: string; epoch: number; signerId: string }>;

/**
 * Native SQLite signing custody accepting only original protocol capabilities.
 * Structural carriers are not an alternative signature/authentication owner.
 * @param options - Explicit host filename and noncreating reopen policy.
 * @returns Opaque vote port, bounded observation and joined close.
 */
export async function openNodeSealVoteStore(options: NodeSigningStoreOptions, session?: LocalSessionLifetime): Promise<
	Readonly<{
		store: SealStorePort;
		observation: Readonly<{ incarnation: string; pendingCount: number }>;
		close(): Promise<void>;
	}>
> {
	const lease = acquireSqliteSigningLease(options, session),
		{ database, retirement } = lease;
	const writeNativeRow = (table: SigningTable, row: unknown, add: boolean): void => {
		if (!plainRecord(row)) throw new Error("INVALID_SIGNING_ROW");
		const key =
			table === "signerState" || table === "sealEvidence"
				? [row.objectId, row.epoch, row.signerId]
				: [row.objectId, row.epoch, row.round, row.phase, row.signerId];
		database.put(table, key as unknown as SigningKey, row, add);
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
		const admitted = Object.freeze({
			...raw,
			anchor: raw.anchor,
			epoch: raw.epoch,
			expectedIncarnation: raw.expectedIncarnation,
			expectedRevision: raw.expectedRevision,
			objectId: raw.objectId,
			phase: raw.phase,
			round: raw.round,
			signerId: raw.signerId,
			valueDigest: raw.valueDigest,
		});
		return lease.run(true, () => {
			const result = ((): unknown => {
				const metaRow = database.getMeta("incarnation");
				if (!plainRecord(metaRow) || metaRow.value !== admitted.expectedIncarnation) {
					return Object.freeze({ ok: false as const, reason: "STORAGE_LOSS", writes: 0 });
				}
				const retiredBeforeRound = readSqliteSigningFrontier(database, admitted as unknown as SigningFrontierScope);
				const refusal = sqliteSigningMutationRefusal(database, admitted.objectId, admitted.epoch);
				if (refusal !== undefined || admitted.round < retiredBeforeRound) {
					return Object.freeze({ ok: false as const, reason: refusal ?? "SIGNING_RETIRED", writes: 0 });
				}
				const stateKey: [string, number, string] = [admitted.objectId, admitted.epoch, admitted.signerId];
				const existingState = database.get("signerState", stateKey as SigningKey);
				const currentRevision =
					existingState === undefined ? 0 : plainRecord(existingState) ? existingState.revision : undefined;
				if (
					!safeNonnegative(currentRevision) ||
					currentRevision === Number.MAX_SAFE_INTEGER ||
					currentRevision !== admitted.expectedRevision
				) {
					return Object.freeze({ ok: false as const, reason: "REVALIDATION_REQUIRED", writes: 0 });
				}
				if (
					existingState !== undefined &&
					(!plainRecord(existingState) ||
						existingState.anchor !== admitted.anchor ||
						existingState.epoch !== admitted.epoch ||
						!safeNonnegative(existingState.enteredRound) ||
						admitted.round < existingState.enteredRound)
				) {
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
					plainRecord(existingState) && plainRecord(existingState.highestPrepareQC)
						? existingState.highestPrepareQC
						: null;
				if (
					admitted.phase === "commit" &&
					(prepareQC === null ||
						existingHighestPrepareQC === null ||
						existingHighestPrepareQC.digest !== prepareQC.digest ||
						existingHighestPrepareQC.round !== admitted.round ||
						existingHighestPrepareQC.valueDigest !== admitted.valueDigest ||
						!(existingHighestPrepareQC.exactCanonicalQcBytes instanceof Uint8Array))
				) {
					return Object.freeze({ ok: false as const, reason: "PREPARE_QC_REQUIRED", writes: 0 });
				}
				if (existingCommittedValue !== null && existingCommittedValue !== admitted.valueDigest) {
					return Object.freeze({ ok: false as const, reason: "COMMITTED_VALUE_CONFLICT", writes: 0 });
				}
				if (
					existingLockedValue !== null &&
					existingLockedValue !== admitted.valueDigest &&
					(prepareQC === null || existingLockRound === null || prepareQC.round < existingLockRound)
				) {
					return Object.freeze({ ok: false as const, reason: "LOCKED_VALUE_CONFLICT", writes: 0 });
				}
				const key = voteKey({
					epoch: admitted.epoch,
					objectId: admitted.objectId,
					phase: admitted.phase,
					round: admitted.round,
					signerId: admitted.signerId,
				});
				const occupied = database.get("voteSlots", key as SigningKey);
				if (occupied !== undefined) {
					const stored = plainRecord(occupied) ? copiedCarrier(occupied.carrier) : undefined;
					if (stored === undefined) {
						throw new Error("invalid occupied vote slot");
					}
					if (compareBytes(stored.exactCanonicalPreimageBytes, carrier.exactCanonicalPreimageBytes) === 0) {
						return Object.freeze({ duplicate: true, ok: true as const, revision: currentRevision, stored, writes: 0 });
					}
					return Object.freeze({ existing: stored, ok: false as const, reason: "VOTE_CONFLICT", writes: 0 });
				}
				const slotRow = {
					carrier,
					epoch: admitted.epoch,
					objectId: admitted.objectId,
					phase: admitted.phase,
					round: admitted.round,
					signerId: admitted.signerId,
				};
				const enteredRound = Math.max(
					plainRecord(existingState) && safeNonnegative(existingState.enteredRound) ? existingState.enteredRound : 0,
					admitted.round
				);
				const stateRow = {
					retiredBeforeRound,
					anchor: admitted.anchor,
					committedValueDigest:
						admitted.phase === "commit"
							? admitted.valueDigest
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
					epoch: admitted.epoch,
					finalizedCommitQC: plainRecord(existingState) ? (existingState.finalizedCommitQC ?? null) : null,
					finalizedValueDigest: plainRecord(existingState) ? (existingState.finalizedValueDigest ?? null) : null,
					highestPrepareQC: existingHighestPrepareQC,
					lockRound: existingLockRound,
					lockedValueDigest: existingLockedValue,
					objectId: admitted.objectId,
					revision: currentRevision + 1,
					signerId: admitted.signerId,
				};
				const outboxRow: PendingVoteRow = {
					carrier,
					dispatched: false,
					epoch: admitted.epoch,
					objectId: admitted.objectId,
					phase: admitted.phase,
					round: admitted.round,
					signerId: admitted.signerId,
				};
				writeNativeRow("voteSlots", slotRow, true);
				writeNativeRow("signerState", stateRow, false);
				writeNativeRow("voteOutbox", outboxRow, true);
				return Object.freeze({
					duplicate: false,
					ok: true as const,
					revision: currentRevision + 1,
					stored: copiedCarrier(carrier),
					writes: 3,
				});
			})();
			if (plainRecord(result) && result.ok === true) readSqliteSigningImage(database, admitted.objectId as string);
			return result;
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
		const admitted = Object.freeze({
			...raw,
			anchor: raw.anchor,
			epoch: raw.epoch,
			expectedIncarnation: raw.expectedIncarnation,
			expectedRevision: raw.expectedRevision,
			objectId: raw.objectId,
			phase: raw.phase,
			round: raw.round,
			signerId: raw.signerId,
			valueDigest: raw.valueDigest,
			qcDigest: raw.qcDigest,
			proposalHash: raw.proposalHash,
		});
		return lease.run(true, () => {
			const result = ((): unknown => {
				const metaRow = database.getMeta("incarnation");
				if (!plainRecord(metaRow) || metaRow.value !== admitted.expectedIncarnation) {
					return Object.freeze({ ok: false as const, reason: "STORAGE_LOSS" });
				}
				const floor = readSqliteSigningFrontier(database, admitted as unknown as SigningFrontierScope);
				const refusal = sqliteSigningMutationRefusal(database, admitted.objectId as string, admitted.epoch as number);
				if (refusal !== undefined || (admitted.round as number) < floor) {
					return Object.freeze({ ok: false as const, reason: refusal ?? "SIGNING_RETIRED" });
				}
				const stateKey: [string, number, string] = [admitted.objectId, admitted.epoch, admitted.signerId];
				const storedState = database.get("signerState", stateKey as SigningKey);
				if (
					(storedState === undefined && admitted.expectedRevision !== 0) ||
					(storedState !== undefined &&
						(!plainRecord(storedState) ||
							storedState.anchor !== admitted.anchor ||
							storedState.epoch !== admitted.epoch ||
							storedState.revision !== admitted.expectedRevision ||
							!safeNonnegative(storedState.revision) ||
							storedState.revision === Number.MAX_SAFE_INTEGER))
				) {
					return Object.freeze({ ok: false as const, reason: "REVALIDATION_REQUIRED" });
				}
				const state: Record<string, unknown> & { revision: number } =
					storedState === undefined
						? Object.freeze({
								anchor: admitted.anchor,
								committedValueDigest: null,
								durableCommitQcCount: 0,
								durablePrepareQcCount: 0,
								enteredRound: 0,
								epoch: admitted.epoch,
								finalizedCommitQC: null,
								finalizedValueDigest: null,
								highestPrepareQC: null,
								lockRound: null,
								lockedValueDigest: null,
								objectId: admitted.objectId,
								revision: 0,
								signerId: admitted.signerId,
							})
						: { ...storedState, revision: admitted.expectedRevision };
				const exactQc = Object.freeze({
					digest: admitted.qcDigest,
					exactCanonicalQcBytes: Uint8Array.from(exactCanonicalQcBytes),
					phase: admitted.phase,
					proposalHash: admitted.proposalHash,
					round: admitted.round,
					valueDigest: admitted.valueDigest,
				});
				if (admitted.phase === "prepare") {
					const highest = plainRecord(state.highestPrepareQC) ? state.highestPrepareQC : null;
					if (highest !== null && highest.round === admitted.round) {
						if (highest.valueDigest !== admitted.valueDigest) {
							return Object.freeze({ ok: false as const, reason: "PREPARE_QC_CONFLICT" });
						}
						if (highest.digest === admitted.qcDigest) {
							if (compareBytes(exactBytes(highest.exactCanonicalQcBytes), exactCanonicalQcBytes) !== 0) {
								return Object.freeze({ ok: false as const, reason: "PREPARE_QC_CONFLICT" });
							}
							return Object.freeze({ advanced: false, duplicate: true, ok: true as const, revision: state.revision });
						}
						if (typeof highest.digest !== "string") {
							return Object.freeze({ ok: false as const, reason: "PREPARE_QC_CONFLICT" });
						}
						if (admitted.qcDigest > highest.digest) {
							return Object.freeze({ advanced: false, duplicate: false, ok: true as const, revision: state.revision });
						}
					}
					if (highest !== null && safeNonnegative(highest.round) && highest.round > admitted.round) {
						return Object.freeze({ ok: false as const, reason: "QC_ROLLBACK" });
					}
					writeNativeRow(
						"signerState",
						{
							...state,
							durablePrepareQcCount:
								(safeNonnegative(state.durablePrepareQcCount) ? state.durablePrepareQcCount : 0) + 1,
							enteredRound: Math.max(safeNonnegative(state.enteredRound) ? state.enteredRound : 0, admitted.round),
							highestPrepareQC: exactQc,
							lockRound: admitted.round,
							lockedValueDigest: admitted.valueDigest,
							revision: state.revision + 1,
						},
						false
					);
				} else {
					const highest = plainRecord(state.highestPrepareQC) ? state.highestPrepareQC : null;
					if (highest === null || highest.round !== admitted.round || highest.valueDigest !== admitted.valueDigest) {
						return Object.freeze({ ok: false as const, reason: "PREPARE_QC_REQUIRED" });
					}
					const existingFinal = plainRecord(state.finalizedCommitQC) ? state.finalizedCommitQC : null;
					if (existingFinal !== null) {
						if (compareBytes(exactBytes(existingFinal.exactCanonicalQcBytes), exactCanonicalQcBytes) === 0) {
							return Object.freeze({ duplicate: true, ok: true as const, revision: state.revision });
						}
						return Object.freeze({ ok: false as const, reason: "FINALIZED_VALUE_CONFLICT" });
					}
					writeNativeRow(
						"signerState",
						{
							...state,
							durableCommitQcCount: (safeNonnegative(state.durableCommitQcCount) ? state.durableCommitQcCount : 0) + 1,
							finalizedCommitQC: exactQc,
							finalizedValueDigest: admitted.valueDigest,
							revision: state.revision + 1,
						},
						false
					);
				}
				return Object.freeze({
					advanced: true,
					duplicate: false,
					ok: true as const,
					revision: admitted.expectedRevision + 1,
				});
			})();
			if (plainRecord(result) && result.ok === true) {
				// QC persistence is the delivery receipt only for its exact local
				// member. Commit the ACK with the QC, including exact lost-ACK retry.
				const key = voteKey({...admitted, phase: admitted.phase as "prepare" | "commit"});
				const pending = database.get("voteOutbox", key as SigningKey);
				if (plainRecord(pending) && pending.dispatched === false &&
					storedSealQcContainsVote(decoded, pending))
					writeNativeRow("voteOutbox", {...pending, dispatched: true}, false);
				readSqliteSigningImage(database, admitted.objectId as string);
			}
			return result;
		});
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
		const admitted = Object.freeze({
			...raw,
			anchor: raw.anchor,
			epoch: raw.epoch,
			expectedIncarnation: raw.expectedIncarnation,
			expectedRevision: raw.expectedRevision,
			objectId: raw.objectId,
			phase: raw.phase,
			round: raw.round,
			signerId: raw.signerId,
			valueDigest: raw.valueDigest,
		});
		return lease.run(true, () => {
			const result = ((): unknown => {
				const metaRow = database.getMeta("incarnation");
				if (!plainRecord(metaRow) || metaRow.value !== admitted.expectedIncarnation) {
					return Object.freeze({ ok: false as const, reason: "STORAGE_LOSS" });
				}
				const floor = readSqliteSigningFrontier(database, admitted as unknown as SigningFrontierScope);
				const refusal = sqliteSigningMutationRefusal(database, admitted.objectId as string, admitted.epoch as number);
				if (refusal !== undefined || (admitted.round as number) < floor) {
					return Object.freeze({ ok: false as const, reason: refusal ?? "SIGNING_RETIRED" });
				}
				const stateKey: [string, number, string] = [admitted.objectId, admitted.epoch, admitted.signerId];
				const state = database.get("signerState", stateKey as SigningKey);
				const current =
					state === undefined
						? {
								anchor: admitted.anchor,
								committedValueDigest: null,
								durableCommitQcCount: 0,
								durablePrepareQcCount: 0,
								enteredRound: 0,
								epoch: admitted.epoch,
								finalizedCommitQC: null,
								finalizedValueDigest: null,
								highestPrepareQC: null,
								lockRound: null,
								lockedValueDigest: null,
								objectId: admitted.objectId,
								revision: 0,
								signerId: admitted.signerId,
							}
						: state;
				if (
					!plainRecord(current) ||
					current.anchor !== admitted.anchor ||
					current.epoch !== admitted.epoch ||
					current.revision !== admitted.expectedRevision ||
					!safeNonnegative(current.revision) ||
					current.revision === Number.MAX_SAFE_INTEGER ||
					!safeNonnegative(current.enteredRound) ||
					admitted.round <= current.enteredRound
				) {
					return Object.freeze({ ok: false as const, reason: "REVALIDATION_REQUIRED" });
				}
				const key = voteKey({
					epoch: admitted.epoch,
					objectId: admitted.objectId,
					phase: "round-change",
					round: admitted.round,
					signerId: admitted.signerId,
				});
				const occupied = database.get("voteSlots", key as SigningKey);
				if (occupied !== undefined) {
					const stored = plainRecord(occupied) ? copiedCarrier(occupied.carrier) : undefined;
					if (
						stored !== undefined &&
						compareBytes(stored.exactCanonicalPreimageBytes, carrier.exactCanonicalPreimageBytes) === 0
					) {
						return Object.freeze({ duplicate: true, ok: true as const, revision: current.revision });
					}
					return Object.freeze({ existing: stored, ok: false as const, reason: "ROUND_CHANGE_CONFLICT" });
				}
				const row: PendingVoteRow = {
					carrier,
					dispatched: false,
					epoch: admitted.epoch,
					objectId: admitted.objectId,
					phase: "round-change",
					round: admitted.round,
					signerId: admitted.signerId,
				};
				writeNativeRow(
					"voteSlots",
					{
						carrier,
						epoch: admitted.epoch,
						objectId: admitted.objectId,
						phase: "round-change",
						round: admitted.round,
						signerId: admitted.signerId,
					},
					true
				);
				writeNativeRow("voteOutbox", row, true);
				writeNativeRow(
					"signerState",
					{
						...current,
						enteredRound: admitted.round,
						revision: current.revision + 1,
					},
					false
				);
				return Object.freeze({ duplicate: false, ok: true as const, revision: current.revision + 1 });
			})();
			if (plainRecord(result) && result.ok === true) readSqliteSigningImage(database, admitted.objectId as string);
			return result;
		});
	};
	const retireDetails = async (raw: SealDetailRetirementIntentData): Promise<SealDetailRetirementResult> => {
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
		if (raw.expectedIncarnation !== database.incarnation) return Object.freeze({ ok: false, reason: "STORAGE_LOSS" });
		if (database.hasNativeReads) throw new Error("SIGNING_READ_NOT_JOINED");
		return lease.run(true, () => {
			const result = ((): SealDetailRetirementResult => {
				const refuse = (reason: string): SealDetailRetirementResult => {
					return Object.freeze({ ok: false, reason });
				};
				const captured = readSqliteSigningImage(database, raw.objectId);
				if (captured.digest !== raw.imageDigest) return refuse("REVALIDATION_REQUIRED");
				const floor = readSqliteSigningFrontier(database, raw);
				const refusal = sqliteSigningMutationRefusal(database, raw.objectId, raw.epoch);
				if (refusal !== undefined) return refuse(refusal);
				const stateKey = [raw.objectId, raw.epoch, raw.signerId] as const;
				const state: unknown = database.get("signerState", stateKey as SigningKey);
				if (
					!plainRecord(state) ||
					state.anchor !== raw.anchor ||
					state.epoch !== raw.epoch ||
					state.revision !== raw.expectedRevision ||
					!safeNonnegative(state.revision) ||
					state.revision === Number.MAX_SAFE_INTEGER ||
					!safeNonnegative(state.enteredRound)
				)
					return refuse("REVALIDATION_REQUIRED");
				if (raw.retiredBeforeRound < floor || raw.retiredBeforeRound > state.enteredRound)
					return refuse("INVALID_RETIREMENT_FRONTIER");
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
					return refuse("CURRENT_QC_PROTECTED");
				if (raw.finalizedCommitQcBytes === null) {
					if (finalized !== null && finalized !== undefined) return refuse("CURRENT_QC_PROTECTED");
				} else if (
					!plainRecord(finalized) ||
					!safeNonnegative(finalized.round) ||
					finalized.round < raw.retiredBeforeRound ||
					!(finalized.exactCanonicalQcBytes instanceof Uint8Array) ||
					compareBytes(finalized.exactCanonicalQcBytes, raw.finalizedCommitQcBytes) !== 0
				)
					return refuse("CURRENT_QC_PROTECTED");
				const evidence: unknown = database.get("sealEvidence", stateKey as SigningKey);
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
						return refuse("EVIDENCE_DEBT_HELD");
				}
				// Reuse the original addressed, union-byte-bounded native census.
				// Never scan/materialize a second unbounded collection to select GC.
				const detail: Array<
					Readonly<{
						table: string;
						key: SigningKey;
					}>
				> = [];
				const decoded = captured.frames.map((bytes) => {
					const frame = decodeCanonical(bytes, { maxBytes: bytes.byteLength, maxItems: 65536, maxDepth: 128 });
					if (!Array.isArray(frame) || frame.length !== 3) throw new Error("INVALID_SIGNING_FRAME");
					return { bytes, table: frame[0] as string, key: frame[1] as SigningKey, row: frame[2] };
				});
				for (const { table, key, row } of decoded) {
					if (table !== "voteSlots" && table !== "voteOutbox") continue;
					if (!Array.isArray(key) || !plainRecord(row)) throw new Error("INVALID_SIGNING_FRAME");
					if (key[0] !== raw.objectId || key[1] !== raw.epoch || key[4] !== raw.signerId) continue;
					if (!safeNonnegative(key[2]) || key[2] >= raw.retiredBeforeRound) continue;
					// The opaque original-voter intent authenticates lower RC carriers
					// and their inline QCs under the same image CAS. Native currency
					// already requires floor <= enteredRound; no old RC is a current
					// proposal dependency. Unknown phases never grant eligibility.
					if (key[3] !== "prepare" && key[3] !== "commit" && key[3] !== "round-change")
						return refuse("DURABLE_CARRIER_INVALID");
					if (table === "voteOutbox" && row.dispatched !== true) return refuse("PUBLICATION_DEBT_HELD");
					detail.push({ table, key });
				}
				const selected = detail.slice(0, SIGNING_DETAIL_RETIREMENT_BATCH_ROWS);
				const changed = selected.length > 0 || floor !== raw.retiredBeforeRound;
				const revision = changed ? state.revision + 1 : state.revision;
				const next = { ...state, retiredBeforeRound: raw.retiredBeforeRound, revision };
				for (const { table, key } of selected) database.delete(table as SigningTable, key);
				if (changed) writeNativeRow("signerState", next, false);
				// Same-transaction exact framing/readback before commit: every other
				// captured native row survives byte-for-byte, only summary floor/rev
				// may change. This is not a source-authentication or heap-size proof.
				const after = readSqliteSigningImage(database, raw.objectId);
				const identity = (table: string, key: SigningKey): string => JSON.stringify([table, key]);
				const removed = new Set(selected.map(({ table, key }) => identity(table, key)));
				const actual = new Map(
					after.frames.map((bytes) => {
						const frame = decodeCanonical(bytes, {
							maxBytes: bytes.byteLength,
							maxItems: 65536,
							maxDepth: 128,
						}) as unknown[];
						return [identity(frame[0] as string, frame[1] as SigningKey), bytes] as const;
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
						changed && original.table === "signerState" && JSON.stringify(original.key) === JSON.stringify(stateKey)
							? encodeCanonical([original.table, original.key, next], {
									maxBytes: AHE_BOUNDED_READ_LIMITS.maxUnionBytes,
									maxItems: 65536,
									maxDepth: 128,
								})
							: original.bytes;
					const bytes = actual.get(id);
					if (bytes === undefined || compareBytes(bytes, expected) !== 0)
						throw new Error("SIGNING_DETAIL_READBACK_MISMATCH");
				}
				return Object.freeze({
					ok: true,
					revision,
					retiredBeforeRound: raw.retiredBeforeRound,
					deletedRows: selected.length,
					remaining: detail.length > selected.length,
				});
			})();
			if (plainRecord(result) && result.ok === true) readSqliteSigningImage(database, raw.objectId as string);
			return result;
		});
	};
	const readPending = (): Promise<readonly PendingVoteRow[]> =>
		lease.run(false, () => {
			const rows: PendingVoteRow[] = [];
			for (const { value } of database.allRows("voteOutbox")) {
				const row = copiedPendingRow(value);
				if (row === undefined) throw new Error("INVALID_SIGNING_OUTBOX");
				if (row.dispatched) continue;
				const floor = readSqliteSigningFrontier(database, row),
					refusal = sqliteSigningMutationRefusal(database, row.objectId, row.epoch);
				if (refusal !== undefined || row.round < floor) throw new Error(refusal ?? "SIGNING_RETIRED");
				rows.push(row);
			}
			return Object.freeze(rows.sort((a, b) => JSON.stringify(voteKey(a)).localeCompare(JSON.stringify(voteKey(b)))));
		});
	const openSnapshot = (scope: unknown): Promise<unknown> =>
		lease.run(false, () => {
			if (
				!plainRecord(scope) ||
				typeof scope.expectedIncarnation !== "string" ||
				typeof scope.objectId !== "string" ||
				!safeNonnegative(scope.epoch) ||
				typeof scope.signerId !== "string"
			)
				throw new TypeError("invalid voter enrollment scope");
			const incarnation = database.incarnation;
			if (scope.expectedIncarnation !== incarnation)
				return Object.freeze({ enteredRound: 0, incarnation, revision: 0, storageLoss: true });
			const retiredBeforeRound = readSqliteSigningFrontier(database, scope as unknown as SigningFrontierScope);
			const state = database.get("signerState", [scope.objectId, scope.epoch, scope.signerId]);
			let pendingRoundChangeCount = 0;
			for (const { key, value } of database.rows("voteOutbox", scope.objectId))
				if (key[1] === scope.epoch && key[3] === "round-change" && key[4] === scope.signerId && plainRecord(value))
					pendingRoundChangeCount++;
			if (state === undefined)
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
			if (!plainRecord(state) || state.anchor !== scope.anchor || state.epoch !== scope.epoch)
				throw new Error("invalid scoped signer state snapshot");
			const highest = plainRecord(state.highestPrepareQC) ? state.highestPrepareQC : null,
				finalized = plainRecord(state.finalizedCommitQC) ? state.finalizedCommitQC : null;
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
				retiredBeforeRound,
			});
		});
	try {
		const pending = await readPending();
		const store = mintSealStorePort({
			acquireSigningDependencyObservation: (input) => retirement.acquireDependency(input),
			acquireRetirementObservation: (input) => retirement.acquire(input),
			acquireRecoveryRetirementObservation: (input) => retirement.acquireRecovery(input),
			acquireSigningAdmission: async (enrollment) => {
				const scoped = resolveSealVoterEnrollment(enrollment);
				if (scoped === undefined) throw new TypeError("UNTRUSTED_VOTER_ENROLLMENT");
				if (scoped.expectedIncarnation !== database.incarnation) throw new Error("STORAGE_LOSS");
				return retirement.acquireSigningAdmission({ objectId: scoped.objectId });
			},
			commitVote: (vote) => {
				const intent = consumeSealVoteIntent(vote);
				return intent === undefined
					? Promise.resolve(Object.freeze({ ok: false as const, reason: "UNTRUSTED_VOTE_INTENT" }))
					: commitVote(intent);
			},
			commitQc: (enrollment, qc) => {
				const scoped = resolveSealVoterEnrollment(enrollment);
				return scoped === undefined
					? Promise.resolve(Object.freeze({ ok: false as const, reason: "UNTRUSTED_VOTER_ENROLLMENT" }))
					: commitQc({ ...(qc as object), ...scoped });
			},
			commitRoundChange: (request) => {
				const intent = consumeSealRoundChangeIntent(request);
				return intent === undefined
					? Promise.resolve(Object.freeze({ ok: false as const, reason: "UNTRUSTED_ROUND_CHANGE_INTENT" }))
					: commitRoundChange(intent);
			},
			retireDetails: (request) => {
				const intent = consumeSealDetailRetirementIntent(request);
				return intent === undefined
					? Promise.resolve(Object.freeze({ ok: false as const, reason: "UNTRUSTED_DETAIL_RETIREMENT_INTENT" }))
					: retireDetails(intent);
			},
			openSnapshot: (enrollment) => {
				const scoped = resolveSealVoterEnrollment(enrollment);
				return scoped === undefined
					? Promise.reject(new TypeError("untrusted voter enrollment"))
					: openSnapshot(scoped);
			},
		});
		const owner = Object.freeze({
			store,
			observation: Object.freeze({ incarnation: database.incarnation, pendingCount: pending.length }),
			close: () => lease.close().then(() => session?.closedOwner(owner)),
		});
		return owner;
	} catch (primary) {
		try {
			await lease.close();
		} catch (cleanup) {
			throw new AggregateError([primary, cleanup], "native seal-vote open and cleanup failed");
		}
		throw primary;
	}
}
