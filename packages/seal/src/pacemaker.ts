import { resolveSealAuthorityIdentity } from "@ts-drp/protocol-v3/internal/seal-authority-identity";
import { type SealAuthority, verifyProposalBundle, verifyRoundChange, verifySealQC } from "@ts-drp/protocol-v3/seal";

import type { SealVoterHandle } from "./index.js";
import { isSealVoterPort, resolveSealStorePort, type SealStorePort } from "./internal/seal-vote-intent.js";

export const ROUND_TIMEOUT_BASE_MS = 1000;
export const ROUND_TIMEOUT_MAX_MS = 30_000;
export const MAX_FUTURE_ROUND_GAP = 8;

const ZERO_DIGEST = "0".repeat(64);

export type PacemakerEventKind =
	| "finalized"
	| "lock_acquired"
	| "qc_formed"
	| "restart"
	| "round_entered"
	| "vote_cast";

export interface PacemakerEvent {
	readonly anchor: string;
	readonly epoch: 0;
	readonly kind: PacemakerEventKind;
	readonly objectId: string;
	readonly phase: "commit" | "prepare" | "round-change";
	readonly qcDigest: string | null;
	readonly round: number;
	readonly sequence: number;
	readonly signerId: string;
	readonly valueDigest: string;
}

export interface PacemakerStatus {
	readonly bufferedFutureRounds: number;
	readonly durableCommitQcCount: number;
	readonly durablePrepareQcCount: number;
	readonly durableRevision: number;
	readonly finalizedValueDigest: string | null;
	readonly highestPrepareQcDigest: string | null;
	readonly lockedValueDigest: string | null;
	readonly pendingRoundChangeCount: number;
	readonly phase: "awaiting" | "committed" | "finalized" | "prepared" | "stopped" | "terminal";
	readonly round: number;
}

export interface SealPacemakerHandle {
	observeCommitQc(exactCanonicalQcBytes: Uint8Array): Promise<Readonly<{ ok: boolean; reason?: string }>>;
	observePrepareQc(exactCanonicalQcBytes: Uint8Array): Promise<Readonly<{ ok: boolean; reason?: string }>>;
	observeProposalBundle(input: Readonly<Record<string, unknown>>): Promise<Readonly<{ ok: boolean; reason?: string }>>;
	observeRoundChange(
		input: Readonly<{ exactCanonicalRoundChangeBytes: Uint8Array; signature: Uint8Array }>
	): Promise<Readonly<{ ok: boolean; reason?: string }>>;
	status(): PacemakerStatus;
	stop(): Promise<void>;
}

interface MetricsPort {
	traceFunc(name: string, operation: (event: PacemakerEvent) => unknown): (event: PacemakerEvent) => unknown;
}

const textEncoder = new TextEncoder();

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as object | null;
	return prototype === Object.prototype || prototype === null;
}

function compareUtf8(left: string, right: string): number {
	const leftBytes = textEncoder.encode(left);
	const rightBytes = textEncoder.encode(right);
	const length = Math.min(leftBytes.length, rightBytes.length);
	for (let index = 0; index < length; index++) {
		const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return leftBytes.length - rightBytes.length;
}

function safeRound(round: number): boolean {
	return Number.isSafeInteger(round) && round >= 0;
}

function failure(reason: string): Readonly<{ ok: false; reason: string }> {
	return Object.freeze({ ok: false as const, reason });
}

/**
 * Returns the governed capped exponential timeout for one round.
 * @param round - Nonnegative safe-integer round.
 * @returns Timeout in milliseconds, capped by the governed profile.
 */
export function roundTimeoutMs(round: number): number {
	if (!safeRound(round)) throw new TypeError("invalid pacemaker round");
	if (round >= 5) return ROUND_TIMEOUT_MAX_MS;
	return Math.min(ROUND_TIMEOUT_MAX_MS, ROUND_TIMEOUT_BASE_MS * 2 ** round);
}

/**
 * Selects the round leader by UTF-8 byte order and round modulo roster length.
 * @param signerIds - Certified signer identifiers.
 * @param round - Nonnegative safe-integer round.
 * @returns The elected signer identifier.
 */
export function leaderForRound(signerIds: readonly string[], round: number): string {
	if (!safeRound(round) || !Array.isArray(signerIds) || signerIds.length === 0) {
		throw new TypeError("invalid leader input");
	}
	const sorted = [...signerIds];
	if (sorted.some((signerId) => typeof signerId !== "string" || signerId.length === 0)) {
		throw new TypeError("invalid signer roster");
	}
	sorted.sort(compareUtf8);
	if (new Set(sorted).size !== sorted.length) throw new TypeError("duplicate signer roster");
	return sorted[round % sorted.length] as string;
}

/**
 * Opens the epoch-zero pacemaker over genuine protocol, voter, and durable-store capabilities.
 * @param input - Authenticated protocol, metrics, storage, and voter capabilities.
 * @returns A pacemaker handle or a typed failure.
 */
export function createSealPacemaker(
	input: Readonly<{
		authority: SealAuthority;
		metrics: MetricsPort;
		store: SealStorePort;
		voter: SealVoterHandle;
	}>
): Promise<Readonly<{ ok: false; reason: string } | { ok: true; pacemaker: SealPacemakerHandle }>> {
	if (
		!plainRecord(input) ||
		Reflect.ownKeys(input).length !== 4 ||
		resolveSealStorePort(input.store) === undefined ||
		!isSealVoterPort(input.voter) ||
		!plainRecord(input.metrics) ||
		typeof input.metrics.traceFunc !== "function"
	) {
		return Promise.resolve(failure("malformed-input"));
	}
	const identity = resolveSealAuthorityIdentity(input.authority);
	if (identity === undefined) return Promise.resolve(failure("untrusted-context"));
	const authority = input.authority;
	const voter = input.voter;
	const metrics = input.metrics;
	const evidence = new Map<number, Map<string, true>>();
	let phase: PacemakerStatus["phase"] = "awaiting";
	let valueDigest: string | null = null;
	let activeCutValueBytes: Uint8Array | null = null;
	let activeProposalRound: number | null = null;
	let accepting = true;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let operationTail: Promise<void> = Promise.resolve();
	let stopTask: Promise<void> | undefined;
	let sequence = 0;

	const voterStatus = (): ReturnType<SealVoterHandle["status"]> => voter.status();
	const snapshot = (): PacemakerStatus => {
		const durable = voterStatus();
		return Object.freeze({
			bufferedFutureRounds: evidence.size,
			durableCommitQcCount: durable.durableCommitQcCount,
			durablePrepareQcCount: durable.durablePrepareQcCount,
			durableRevision: durable.revision,
			finalizedValueDigest: durable.finalizedValueDigest,
			highestPrepareQcDigest: durable.highestPrepareQcDigest,
			lockedValueDigest: durable.lockedValueDigest,
			pendingRoundChangeCount: durable.pendingRoundChangeCount,
			phase: stopped ? "stopped" : durable.terminal ? "terminal" : phase,
			round: durable.enteredRound,
		});
	};
	const emit = (
		kind: PacemakerEventKind,
		eventPhase: PacemakerEvent["phase"],
		round: number,
		eventValueDigest: string | null,
		qcDigest: string | null
	): void => {
		const event = Object.freeze({
			anchor: identity.anchor,
			epoch: 0 as const,
			kind,
			objectId: identity.objectId,
			phase: eventPhase,
			qcDigest,
			round,
			sequence: sequence++,
			signerId: identity.signerId,
			valueDigest: eventValueDigest ?? ZERO_DIGEST,
		});
		try {
			metrics.traceFunc(kind, (fact: PacemakerEvent) => fact)(event);
		} catch {
			// Diagnostics never authorize or roll back a durable transition.
		}
	};
	const pruneEvidence = (enteredRound: number): void => {
		for (const round of evidence.keys()) if (round <= enteredRound) evidence.delete(round);
	};
	const clearTimer = (): void => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
	const enqueue = <T>(operation: () => Promise<T>): Promise<T | Readonly<{ ok: false; reason: string }>> => {
		if (!accepting) return Promise.resolve(failure("STOPPED"));
		const result = operationTail.then(operation);
		operationTail = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	};
	const schedule = (): void => {
		clearTimer();
		if (!accepting || phase === "finalized" || phase === "terminal") return;
		const round = voterStatus().enteredRound;
		timer = setTimeout(() => {
			timer = undefined;
			if (!accepting) return;
			void enqueue(async () => {
				const before = voterStatus();
				if (before.enteredRound === Number.MAX_SAFE_INTEGER) {
					phase = "terminal";
					return;
				}
				const nextRound = before.enteredRound + 1;
				const result = await voter.roundChange({ expectedRevision: before.revision, round: nextRound });
				if (!plainRecord(result) || result.ok !== true) {
					phase = "terminal";
					return;
				}
				phase = "awaiting";
				activeCutValueBytes = null;
				activeProposalRound = null;
				pruneEvidence(nextRound);
				emit("round_entered", "round-change", nextRound, voterStatus().lockedValueDigest, null);
				schedule();
			});
		}, roundTimeoutMs(round));
	};

	const initial = voterStatus();
	const initialHighestPrepareQc =
		initial.highestPrepareQcBytes === null
			? null
			: verifySealQC({ authority, exactCanonicalQcBytes: initial.highestPrepareQcBytes });
	if (initial.finalizedValueDigest !== null) {
		phase = "finalized";
		valueDigest = initial.finalizedValueDigest;
	} else if (initialHighestPrepareQc?.ok === true && initialHighestPrepareQc.round === initial.enteredRound) {
		phase = "committed";
		valueDigest = initial.lockedValueDigest;
	} else if (initial.highestPrepareQcBytes !== null || initial.pendingRoundChangeCount > 0) {
		phase = "awaiting";
		valueDigest = initial.lockedValueDigest;
	}
	if (initial.revision > 0) {
		emit("restart", "round-change", initial.enteredRound, valueDigest, initial.highestPrepareQcDigest);
	}
	schedule();

	const handle: SealPacemakerHandle = Object.freeze({
		observeCommitQc(exactCanonicalQcBytes: Uint8Array) {
			return enqueue(async () => {
				if (phase === "finalized") return failure("FINALIZED");
				if (phase === "terminal") return failure("TERMINAL");
				const verified = verifySealQC({ authority, exactCanonicalQcBytes });
				if (!verified.ok || verified.phase !== "commit") {
					return failure(verified.ok ? "COMMIT_QC_REQUIRED" : verified.reason);
				}
				const persisted = await voter.persistQc({ exactCanonicalQcBytes });
				if (!plainRecord(persisted) || persisted.ok !== true) {
					return failure(
						plainRecord(persisted) && typeof persisted.reason === "string" ? persisted.reason : "QC_FAILED"
					);
				}
				if (persisted.advanced === false) return Object.freeze({ ok: true as const, revision: voterStatus().revision });
				phase = "finalized";
				valueDigest = verified.valueDigest;
				pruneEvidence(voterStatus().enteredRound);
				clearTimer();
				emit("qc_formed", "commit", verified.round, verified.valueDigest, verified.qcDigest);
				emit("finalized", "commit", verified.round, verified.valueDigest, verified.qcDigest);
				return Object.freeze({ ok: true as const, revision: voterStatus().revision });
			});
		},
		observePrepareQc(exactCanonicalQcBytes: Uint8Array) {
			return enqueue(async () => {
				if (phase === "finalized") return failure("FINALIZED");
				if (phase === "terminal") return failure("TERMINAL");
				const verified = verifySealQC({ authority, exactCanonicalQcBytes });
				if (!verified.ok || verified.phase !== "prepare") {
					return failure(verified.ok ? "PREPARE_QC_REQUIRED" : verified.reason);
				}
				const persisted = await voter.persistQc({ exactCanonicalQcBytes });
				if (!plainRecord(persisted) || persisted.ok !== true) {
					return failure(
						plainRecord(persisted) && typeof persisted.reason === "string" ? persisted.reason : "QC_FAILED"
					);
				}
				if (persisted.advanced === false) return Object.freeze({ ok: true as const, revision: voterStatus().revision });
				phase = "committed";
				valueDigest = verified.valueDigest;
				pruneEvidence(voterStatus().enteredRound);
				emit("qc_formed", "prepare", verified.round, verified.valueDigest, verified.qcDigest);
				emit("lock_acquired", "prepare", verified.round, verified.valueDigest, verified.qcDigest);
				if (activeProposalRound === verified.round && activeCutValueBytes !== null) {
					const committedVote = await voter.vote({
						exactCanonicalCutValueBytes: activeCutValueBytes,
						expectedRevision: voterStatus().revision,
						phase: "commit",
						round: verified.round,
					});
					if (!plainRecord(committedVote) || committedVote.ok !== true) {
						return failure(
							plainRecord(committedVote) && typeof committedVote.reason === "string"
								? committedVote.reason
								: "COMMIT_VOTE_FAILED"
						);
					}
					emit("vote_cast", "commit", verified.round, verified.valueDigest, verified.qcDigest);
				}
				schedule();
				return Object.freeze({ ok: true as const, revision: voterStatus().revision });
			});
		},
		observeProposalBundle(bundle: Readonly<Record<string, unknown>>) {
			return enqueue(async () => {
				if (phase === "finalized") return failure("FINALIZED");
				if (phase === "terminal") return failure("TERMINAL");
				const verified = verifyProposalBundle({ ...bundle, authority });
				if (!verified.ok) return failure(verified.reason);
				const cutValue = bundle.exactCanonicalCutValueBytes;
				if (!(cutValue instanceof Uint8Array)) return failure("CUT_VALUE_REQUIRED");
				const before = voterStatus();
				if (verified.round < before.enteredRound) return failure("STALE_ROUND");
				if (verified.round > before.enteredRound) {
					const entered = await voter.roundChange({ expectedRevision: before.revision, round: verified.round });
					if (!plainRecord(entered) || entered.ok !== true) {
						return failure(
							plainRecord(entered) && typeof entered.reason === "string" ? entered.reason : "ROUND_FAILED"
						);
					}
					pruneEvidence(verified.round);
					emit("round_entered", "round-change", verified.round, voterStatus().lockedValueDigest, null);
				}
				const voted = await voter.vote({
					exactCanonicalCutValueBytes: cutValue,
					expectedRevision: voterStatus().revision,
					phase: "prepare",
					round: verified.round,
				});
				if (!plainRecord(voted) || voted.ok !== true) {
					return failure(plainRecord(voted) && typeof voted.reason === "string" ? voted.reason : "PREPARE_VOTE_FAILED");
				}
				phase = "prepared";
				valueDigest = verified.valueDigest;
				activeProposalRound = verified.round;
				activeCutValueBytes = Uint8Array.from(cutValue);
				emit("vote_cast", "prepare", verified.round, verified.valueDigest, verified.selectedPrepareQcDigest);
				schedule();
				return Object.freeze({ ok: true as const });
			});
		},
		observeRoundChange(roundChange: Readonly<{ exactCanonicalRoundChangeBytes: Uint8Array; signature: Uint8Array }>) {
			return enqueue(async () => {
				if (phase === "finalized") return failure("FINALIZED");
				if (phase === "terminal") return failure("TERMINAL");
				const verified = verifyRoundChange({ authority, ...roundChange });
				if (!verified.ok) return failure(verified.reason);
				const currentRound = voterStatus().enteredRound;
				if (verified.round <= currentRound || verified.round > currentRound + MAX_FUTURE_ROUND_GAP) {
					return Object.freeze({ ok: true as const });
				}
				const bySigner = evidence.get(verified.round) ?? new Map<string, true>();
				bySigner.set(verified.signerId, true);
				evidence.set(verified.round, bySigner);
				const fPlusOne = verified.signerCount - verified.quorum + 1;
				if (bySigner.size >= fPlusOne) {
					const result = await voter.roundChange({
						expectedRevision: voterStatus().revision,
						round: verified.round,
					});
					if (!plainRecord(result) || result.ok !== true) {
						return failure(plainRecord(result) && typeof result.reason === "string" ? result.reason : "ROUND_FAILED");
					}
					pruneEvidence(verified.round);
					phase = "awaiting";
					activeCutValueBytes = null;
					activeProposalRound = null;
					emit("round_entered", "round-change", verified.round, voterStatus().lockedValueDigest, null);
					schedule();
				}
				return Object.freeze({ ok: true as const });
			});
		},
		status(): PacemakerStatus {
			return snapshot();
		},
		stop(): Promise<void> {
			if (stopTask !== undefined) return stopTask;
			accepting = false;
			clearTimer();
			stopTask = operationTail.then(() => {
				stopped = true;
				phase = "stopped";
			});
			return stopTask;
		},
	});
	return Promise.resolve(Object.freeze({ ok: true as const, pacemaker: handle }));
}
