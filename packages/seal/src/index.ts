import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical } from "@ts-drp/canonical";
import { type FinalitySigner, signSealRegisteredDigest } from "@ts-drp/keychain/finality";
import { resolveSealAuthorityIdentity } from "@ts-drp/protocol-v3/internal/seal-authority-identity";
import { bindSealSigningRequest, SigningAdmissionRefusal } from "@ts-drp/protocol-v3/internal/seal-signing-request";
import {
	prepareRoundChange,
	prepareSealVote,
	type SealAuthority,
	verifyRoundChange,
	verifySealQC,
	verifySealVoteCarrier,
} from "@ts-drp/protocol-v3/seal";

import {
	mintSealDetailRetirementIntent,
	mintSealRoundChangeIntent,
	mintSealVoteIntent,
	mintSealVoterEnrollment,
	mintSealVoterPort,
	nativeSigningAdmissionFactory,
	resolveSealStorePort,
	type SealDetailRetirementIntentData,
	type SealDetailRetirementResult,
	type SealStorePort,
	type SigningDependencyObservation,
} from "./internal/seal-vote-intent.js";

export type { SealStorePort } from "./internal/seal-vote-intent.js";

export interface ExactSealCarrier {
	readonly exactCanonicalPreimageBytes: Uint8Array;
	readonly signature: Uint8Array;
}

export interface SealVoterHandle {
	persistQc(input: Readonly<{ exactCanonicalQcBytes: Uint8Array }>): Promise<unknown>;
	retireDetails(input: Readonly<{ expectedRevision: number }>): Promise<SealDetailRetirementResult>;
	roundChange(input: Readonly<{ expectedRevision: number; round: number }>): Promise<unknown>;
	status(): Readonly<{
		durableCommitQcCount: number;
		durablePrepareQcCount: number;
		enteredRound: number;
		finalizedValueDigest: string | null;
		highestPrepareQcBytes: Uint8Array | null;
		highestPrepareQcDigest: string | null;
		lockedValueDigest: string | null;
		pendingRoundChangeCount: number;
		revision: number;
		terminal: boolean;
	}>;
	vote(
		input: Readonly<{
			exactCanonicalCutValueBytes: Uint8Array;
			expectedRevision: number;
			phase: "commit" | "prepare";
			round: number;
		}>
	): Promise<
		| Readonly<{ existing?: ExactSealCarrier; ok: false; reason: string }>
		| Readonly<{ carrierDigest: string; duplicate: boolean; ok: true; stored: ExactSealCarrier }>
	>;
}

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
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get as (
	this: ArrayBuffer
) => number;
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get as
	| ((this: ArrayBuffer) => boolean)
	| undefined;

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
		// Copy the checked native backing view, not a caller-defined iterator.
		return new Uint8Array(new Uint8Array(buffer as ArrayBuffer, 0, length));
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

function copyCarrier(value: unknown): ExactSealCarrier | undefined {
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

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function failure(
	reason: string,
	existing?: ExactSealCarrier
): Readonly<{ existing?: ExactSealCarrier; ok: false; reason: string }> {
	return Object.freeze({ ...(existing === undefined ? {} : { existing }), ok: false as const, reason });
}

/**
 * Checks the original restored QC/lock snapshot under genuine signer authority.
 * @param authority - Original certified signer authority.
 * @param expectedStorageIncarnation - Original enrolled storage incarnation.
 * @param candidate - Restored native snapshot to authenticate.
 * @returns Authenticated snapshot fields or the original typed refusal.
 */
export const verifySealRecoverySnapshot = (
	authority: SealAuthority,
	expectedStorageIncarnation: string,
	candidate: unknown
):
	| Readonly<{ ok: false; reason: string }>
	| Readonly<{
			durableCommitQcCount: number;
			durablePrepareQcCount: number;
			enteredRound: number;
			finalizedValueDigest: string | null;
			highestPrepareQcBytes: Uint8Array | null;
			highestPrepareQcDigest: string | null;
			lockedValueDigest: string | null;
			ok: true;
			pendingRoundChangeCount: number;
			revision: number;
	  }> => {
	if (
		!plainRecord(candidate) ||
		candidate.incarnation !== expectedStorageIncarnation ||
		!safeNonnegative(candidate.revision) ||
		!safeNonnegative(candidate.enteredRound)
	) {
		return failure(plainRecord(candidate) ? "STORAGE_LOSS" : "malformed-store-snapshot");
	}
	const highestPrepareQcBytes =
		candidate.highestPrepareQcBytes instanceof Uint8Array ? exactBytes(candidate.highestPrepareQcBytes) : null;
	const highestPrepareQcDigest =
		typeof candidate.highestPrepareQcDigest === "string" ? candidate.highestPrepareQcDigest : null;
	const lockedValueDigest = typeof candidate.lockedValueDigest === "string" ? candidate.lockedValueDigest : null;
	if ((highestPrepareQcBytes === null) !== (highestPrepareQcDigest === null)) {
		return failure("DURABLE_QC_INVALID");
	}
	if (highestPrepareQcBytes !== null) {
		const verified = verifySealQC({ authority, exactCanonicalQcBytes: highestPrepareQcBytes });
		if (
			!verified.ok ||
			verified.phase !== "prepare" ||
			verified.qcDigest !== highestPrepareQcDigest ||
			verified.valueDigest !== lockedValueDigest ||
			verified.round > candidate.enteredRound
		) {
			return failure("DURABLE_QC_INVALID");
		}
	}
	const finalizedValueDigest =
		typeof candidate.finalizedValueDigest === "string" ? candidate.finalizedValueDigest : null;
	const finalizedCommitQcBytes =
		candidate.finalizedCommitQcBytes instanceof Uint8Array ? exactBytes(candidate.finalizedCommitQcBytes) : null;
	if ((finalizedCommitQcBytes === null) !== (finalizedValueDigest === null)) {
		return failure("DURABLE_QC_INVALID");
	}
	if (finalizedCommitQcBytes !== null) {
		const verified = verifySealQC({ authority, exactCanonicalQcBytes: finalizedCommitQcBytes });
		if (
			!verified.ok ||
			verified.phase !== "commit" ||
			verified.valueDigest !== finalizedValueDigest ||
			verified.valueDigest !== lockedValueDigest ||
			verified.round > candidate.enteredRound
		) {
			return failure("DURABLE_QC_INVALID");
		}
	}
	return Object.freeze({
		durableCommitQcCount: safeNonnegative(candidate.durableCommitQcCount) ? candidate.durableCommitQcCount : 0,
		durablePrepareQcCount: safeNonnegative(candidate.durablePrepareQcCount) ? candidate.durablePrepareQcCount : 0,
		enteredRound: candidate.enteredRound,
		finalizedValueDigest,
		highestPrepareQcBytes,
		highestPrepareQcDigest,
		lockedValueDigest,
		ok: true as const,
		pendingRoundChangeCount: safeNonnegative(candidate.pendingRoundChangeCount) ? candidate.pendingRoundChangeCount : 0,
		revision: candidate.revision,
	});
};

/**
 * Opens the original durable voter under certified authority and enrolled storage custody.
 * @param input - Original authority, signer, durable port and enrollment.
 * @returns Original voter handle or a typed refusal.
 */
export async function createSealVoter(
	input: Readonly<{
		authority: SealAuthority;
		expectedStorageIncarnation: string;
		signer: FinalitySigner;
		store: SealStorePort;
	}>
): Promise<Readonly<{ ok: false; reason: string } | { ok: true; voter: SealVoterHandle }>> {
	try {
		if (!plainRecord(input) || Reflect.ownKeys(input).length !== 4) return failure("malformed-input");
		const authority = input.authority;
		const expectedStorageIncarnation = input.expectedStorageIncarnation;
		const signer = input.signer;
		const store = resolveSealStorePort(input.store);
		const authorityIdentity = resolveSealAuthorityIdentity(authority);
		if (
			typeof expectedStorageIncarnation !== "string" ||
			expectedStorageIncarnation.length === 0 ||
			store === undefined ||
			authorityIdentity === undefined
		) {
			return failure("malformed-input");
		}
		const enrollment = mintSealVoterEnrollment({
			...authorityIdentity,
			expectedIncarnation: expectedStorageIncarnation,
		});
		const verifySnapshot = (candidate: unknown): ReturnType<typeof verifySealRecoverySnapshot> =>
			verifySealRecoverySnapshot(authority, expectedStorageIncarnation, candidate);
		const initialSnapshot = verifySnapshot(await store.openSnapshot(enrollment));
		if (!initialSnapshot.ok) return initialSnapshot;
		let revision = initialSnapshot.revision;
		let enteredRound = initialSnapshot.enteredRound;
		let durableCommitQcCount = initialSnapshot.durableCommitQcCount;
		let durablePrepareQcCount = initialSnapshot.durablePrepareQcCount;
		let finalizedValueDigest = initialSnapshot.finalizedValueDigest;
		let highestPrepareQcBytes = initialSnapshot.highestPrepareQcBytes;
		let highestPrepareQcDigest = initialSnapshot.highestPrepareQcDigest;
		let lockedValueDigest = initialSnapshot.lockedValueDigest;
		let pendingRoundChangeCount = initialSnapshot.pendingRoundChangeCount;
		let terminal = false;
		let active = false;
		const refreshSnapshot = async (
			expectedRetirement?: Readonly<{ revision: number; retiredBeforeRound: number }>
		): Promise<string | undefined> => {
			try {
				const candidate = await store.openSnapshot(enrollment);
				const refreshed = verifySnapshot(candidate);
				if (!refreshed.ok) {
					terminal = true;
					return refreshed.reason;
				}
				revision = refreshed.revision;
				enteredRound = refreshed.enteredRound;
				durableCommitQcCount = refreshed.durableCommitQcCount;
				durablePrepareQcCount = refreshed.durablePrepareQcCount;
				finalizedValueDigest = refreshed.finalizedValueDigest;
				highestPrepareQcBytes = refreshed.highestPrepareQcBytes;
				highestPrepareQcDigest = refreshed.highestPrepareQcDigest;
				lockedValueDigest = refreshed.lockedValueDigest;
				pendingRoundChangeCount = refreshed.pendingRoundChangeCount;
				if (
					expectedRetirement !== undefined &&
					(refreshed.revision !== expectedRetirement.revision ||
						!plainRecord(candidate) ||
						candidate.retiredBeforeRound !== expectedRetirement.retiredBeforeRound)
				)
					return "REVALIDATION_REQUIRED";
				return undefined;
			} catch {
				terminal = true;
				return "AMBIGUOUS_STORAGE_OUTCOME";
			}
		};

		const voter: SealVoterHandle = Object.freeze({
			async retireDetails(
				retirementInput: Readonly<{ expectedRevision: number }>
			): Promise<SealDetailRetirementResult> {
				if (terminal) return failure("TERMINAL");
				if (active) return failure("BUSY");
				if (
					!plainRecord(retirementInput) ||
					Reflect.ownKeys(retirementInput).length !== 1 ||
					!safeNonnegative(retirementInput.expectedRevision)
				)
					return failure("MALFORMED_INPUT");
				if (retirementInput.expectedRevision !== revision) return failure("REVALIDATION_REQUIRED");
				if (store.acquireSigningDependencyObservation === undefined || store.retireDetails === undefined)
					return failure("SIGNING_DETAIL_RETIREMENT_UNSUPPORTED");
				const acquire = store.acquireSigningDependencyObservation;
				active = true;
				try {
					let held: SigningDependencyObservation | undefined;
					let captured: SealDetailRetirementIntentData | Readonly<{ ok: false; reason: string }> | undefined;
					let primary: unknown;
					let failed = false;
					try {
						captured = await (async (): Promise<SealDetailRetirementIntentData | ReturnType<typeof failure>> => {
							held = await acquire({ objectId: authorityIdentity.objectId });
							// The native adapter borrows this same held reservation for its
							// original snapshot parser; a separate queued RO is not sufficient.
							const raw = await store.openSnapshot(enrollment);
							const restored = verifySnapshot(raw);
							if (!restored.ok) return restored;
							if (restored.revision !== retirementInput.expectedRevision) return failure("REVALIDATION_REQUIRED");
							if (
								!plainRecord(raw) ||
								!safeNonnegative(raw.retiredBeforeRound) ||
								held.control.incarnation !== expectedStorageIncarnation ||
								held.control.objectId !== authorityIdentity.objectId
							)
								return failure("STORAGE_LOSS");
							const highestPrepareQcBytes = restored.highestPrepareQcBytes;
							if (highestPrepareQcBytes === null) return failure("CURRENT_QC_REQUIRED");
							const highest = verifySealQC({ authority, exactCanonicalQcBytes: highestPrepareQcBytes });
							if (!highest.ok || highest.phase !== "prepare") return failure("DURABLE_QC_INVALID");
							const finalizedCommitQcBytes =
								raw.finalizedCommitQcBytes === null ? null : exactBytes(raw.finalizedCommitQcBytes);
							let retiredBeforeRound = Math.min(highest.round, restored.enteredRound);
							if (finalizedCommitQcBytes !== null) {
								const finalized = verifySealQC({ authority, exactCanonicalQcBytes: finalizedCommitQcBytes });
								if (!finalized.ok || finalized.phase !== "commit") return failure("DURABLE_QC_INVALID");
								retiredBeforeRound = Math.min(retiredBeforeRound, finalized.round);
							}
							if (retiredBeforeRound === 0 || retiredBeforeRound < raw.retiredBeforeRound)
								return failure("INVALID_RETIREMENT_FRONTIER");
							// Authenticate every potentially selected carrier, not just a caller
							// round label. Other scopes and all safety summaries remain native debt.
							for (const bytes of held.readExactCanonicalRows()) {
								const frame = decodeCanonical(bytes, { maxBytes: bytes.byteLength, maxItems: 65_536, maxDepth: 128 });
								if (!Array.isArray(frame) || frame.length !== 3) return failure("DURABLE_CARRIER_INVALID");
								const [name, key, row] = frame;
								if (name !== "voteSlots" && name !== "voteOutbox") continue;
								if (!Array.isArray(key) || key.length !== 5 || !plainRecord(row))
									return failure("DURABLE_CARRIER_INVALID");
								if (
									key[0] !== authorityIdentity.objectId ||
									key[1] !== authorityIdentity.epoch ||
									key[4] !== authorityIdentity.signerId
								)
									continue;
								if (
									!safeNonnegative(row.round) ||
									row.round !== key[2] ||
									row.objectId !== key[0] ||
									row.epoch !== key[1] ||
									row.signerId !== key[4] ||
									row.phase !== key[3]
								)
									return failure("DURABLE_CARRIER_INVALID");
								if (row.round >= retiredBeforeRound) continue;
								if (name === "voteOutbox" && row.dispatched !== true) return failure("PUBLICATION_DEBT_HELD");
								const carrier = copyCarrier(row.carrier);
								if (carrier === undefined) return failure("DURABLE_CARRIER_INVALID");
								if (row.phase === "round-change") {
									// The original bundle verifier requires RC.round == proposal.round;
									// the original pacemaker refuses proposal.round < enteredRound.
									// Selected RC.round < floor <= enteredRound cannot justify any
									// locally admissible proposal or advance the current pacemaker.
									// Authenticate its inline nested QC, not an age/phase label.
									const verified = verifyRoundChange({
										authority,
										exactCanonicalRoundChangeBytes: carrier.exactCanonicalPreimageBytes,
										signature: carrier.signature,
									});
									if (!verified.ok || verified.round !== row.round || verified.signerId !== authorityIdentity.signerId)
										return failure("DURABLE_CARRIER_INVALID");
									continue;
								}
								const verified = verifySealVoteCarrier({ authority, ...carrier });
								if (
									!verified.ok ||
									verified.phase !== row.phase ||
									verified.round !== row.round ||
									verified.signerId !== authorityIdentity.signerId
								)
									return failure("DURABLE_CARRIER_INVALID");
							}
							await held.check();
							return Object.freeze({
								...authorityIdentity,
								expectedIncarnation: expectedStorageIncarnation,
								expectedRevision: restored.revision,
								imageDigest: held.imageDigest,
								retiredBeforeRound,
								highestPrepareQcBytes,
								finalizedCommitQcBytes,
							});
						})();
					} catch (cause) {
						failed = true;
						primary = cause;
					}
					if (held !== undefined) {
						try {
							await held.release();
						} catch (cleanup) {
							if (failed)
								throw new AggregateError([primary, cleanup], "signing detail capture and release failed", {
									cause: primary,
								});
							throw cleanup;
						}
					}
					if (failed) throw primary;
					if (captured === undefined) return failure("REVALIDATION_REQUIRED");
					if ("ok" in captured) return captured;
					const selection = captured;
					let result: SealDetailRetirementResult;
					try {
						result = await store.retireDetails(mintSealDetailRetirementIntent(selection));
					} catch {
						terminal = true;
						return failure("AMBIGUOUS_STORAGE_OUTCOME");
					}
					if (!plainRecord(result) || typeof result.ok !== "boolean") {
						terminal = true;
						return failure("AMBIGUOUS_STORAGE_OUTCOME");
					}
					if (!result.ok) return result;
					if (
						!safeNonnegative(result.revision) ||
						!safeNonnegative(result.deletedRows) ||
						result.deletedRows > 16 ||
						result.retiredBeforeRound !== selection.retiredBeforeRound ||
						typeof result.remaining !== "boolean"
					) {
						terminal = true;
						return failure("AMBIGUOUS_STORAGE_OUTCOME");
					}
					const refreshFailure = await refreshSnapshot(result);
					return refreshFailure === undefined ? Object.freeze({ ...result }) : failure(refreshFailure);
				} finally {
					active = false;
				}
			},
			async persistQc(qcInput: Readonly<{ exactCanonicalQcBytes: Uint8Array }>) {
				if (terminal) return failure("TERMINAL");
				if (active) return failure("BUSY");
				if (!plainRecord(qcInput) || Reflect.ownKeys(qcInput).length !== 1 || store.commitQc === undefined) {
					return failure("MALFORMED_INPUT");
				}
				const exactCanonicalQcBytes = exactBytes(qcInput.exactCanonicalQcBytes);
				const verified = verifySealQC({ authority, exactCanonicalQcBytes });
				if (!verified.ok) return failure(verified.reason);
				const beforeRevision = revision;
				active = true;
				try {
					const committed = await store.commitQc(enrollment, {
						exactCanonicalQcBytes,
						expectedIncarnation: expectedStorageIncarnation,
						expectedRevision: revision,
						phase: verified.phase,
						proposalHash: verified.proposalHash,
						qcDigest: verified.qcDigest,
						round: verified.round,
						valueDigest: verified.valueDigest,
					});
					if (!plainRecord(committed) || committed.ok !== true) {
						return failure(
							plainRecord(committed) && typeof committed.reason === "string" ? committed.reason : "QC_FAILED"
						);
					}
					const refreshFailure = await refreshSnapshot();
					return refreshFailure === undefined
						? Object.freeze({ advanced: revision > beforeRevision, ok: true as const, revision })
						: failure(refreshFailure);
				} catch {
					terminal = true;
					return failure("AMBIGUOUS_STORAGE_OUTCOME");
				} finally {
					active = false;
				}
			},
			async roundChange(roundInput: Readonly<{ expectedRevision: number; round: number }>) {
				if (terminal) return failure("TERMINAL");
				if (active) return failure("BUSY");
				if (!plainRecord(roundInput) || store.commitRoundChange === undefined) return failure("MALFORMED_INPUT");
				if (
					!safeNonnegative(roundInput.expectedRevision) ||
					!safeNonnegative(roundInput.round) ||
					roundInput.expectedRevision !== revision ||
					roundInput.round <= enteredRound
				) {
					return failure("REVALIDATION_REQUIRED");
				}
				active = true;
				try {
					const prepared = prepareRoundChange({
						authority,
						highestPrepareQC: highestPrepareQcBytes,
						round: roundInput.round,
					});
					if (!prepared.ok) return failure(prepared.reason);
					bindSealSigningRequest(prepared.signingRequest, nativeSigningAdmissionFactory(input.store, enrollment));
					const signature = await signSealRegisteredDigest({
						request: prepared.signingRequest,
						signer,
					});
					if (!ed25519.verify(signature, prepared.registeredDigest, prepared.publicKey, { zip215: false })) {
						return failure("invalid-signature");
					}
					const committed = await store.commitRoundChange(
						mintSealRoundChangeIntent({
							anchor: authorityIdentity.anchor,
							carrier: Object.freeze({
								exactCanonicalPreimageBytes: exactBytes(prepared.exactCanonicalPreimageBytes),
								signature: exactBytes(signature, 64, 64),
							}),
							epoch: authorityIdentity.epoch,
							expectedIncarnation: expectedStorageIncarnation,
							expectedRevision: revision,
							highestPrepareQcBytes,
							objectId: authorityIdentity.objectId,
							round: roundInput.round,
							signerId: authorityIdentity.signerId,
						})
					);
					if (!plainRecord(committed) || committed.ok !== true) {
						return failure(
							plainRecord(committed) && typeof committed.reason === "string" ? committed.reason : "ROUND_CHANGE_FAILED"
						);
					}
					const refreshFailure = await refreshSnapshot();
					return refreshFailure === undefined
						? Object.freeze({ ok: true as const, revision })
						: failure(refreshFailure);
				} catch (cause) {
					if (cause instanceof SigningAdmissionRefusal) return failure(cause.reason);
					terminal = true;
					return failure("AMBIGUOUS_STORAGE_OUTCOME");
				} finally {
					active = false;
				}
			},
			status: () =>
				Object.freeze({
					durableCommitQcCount,
					durablePrepareQcCount,
					enteredRound,
					finalizedValueDigest,
					highestPrepareQcBytes: highestPrepareQcBytes === null ? null : Uint8Array.from(highestPrepareQcBytes),
					highestPrepareQcDigest,
					lockedValueDigest,
					pendingRoundChangeCount,
					revision,
					terminal,
				}),
			async vote(
				voteInput: Readonly<{
					exactCanonicalCutValueBytes: Uint8Array;
					expectedRevision: number;
					phase: "commit" | "prepare";
					round: number;
				}>
			) {
				if (terminal) return failure("TERMINAL");
				if (active) return failure("BUSY");
				if (!plainRecord(voteInput) || Reflect.ownKeys(voteInput).length !== 4) {
					return failure("malformed-input");
				}
				const exactCanonicalCutValueBytes = exactBytes(voteInput.exactCanonicalCutValueBytes);
				const expectedRevision = voteInput.expectedRevision;
				const phase = voteInput.phase;
				const round = voteInput.round;
				if (
					!safeNonnegative(expectedRevision) ||
					!safeNonnegative(round) ||
					(phase !== "prepare" && phase !== "commit")
				) {
					return failure("malformed-input");
				}
				if (expectedRevision !== revision || round < enteredRound) {
					return failure("REVALIDATION_REQUIRED");
				}
				active = true;
				try {
					const prepared = prepareSealVote({
						authority,
						exactCanonicalCutValueBytes,
						phase,
						round,
					});
					if (!prepared.ok) return failure(prepared.reason);
					bindSealSigningRequest(prepared.signingRequest, nativeSigningAdmissionFactory(input.store, enrollment));
					const signature = await signSealRegisteredDigest({
						request: prepared.signingRequest,
						signer,
					});
					if (!ed25519.verify(signature, prepared.registeredDigest, prepared.publicKey, { zip215: false })) {
						return failure("invalid-signature");
					}
					const carrier = Object.freeze({
						exactCanonicalPreimageBytes: exactBytes(prepared.exactCanonicalPreimageBytes),
						signature: exactBytes(signature, 64, 64),
					});
					let committed: unknown;
					try {
						committed = await store.commitVote(
							mintSealVoteIntent({
								anchor: prepared.anchor,
								carrier,
								epoch: authorityIdentity.epoch,
								expectedIncarnation: expectedStorageIncarnation,
								expectedRevision,
								objectId: prepared.objectId,
								phase,
								prepareQC: prepared.prepareQC,
								round,
								signerId: prepared.signerId,
								valueDigest: prepared.valueDigest,
							})
						);
					} catch {
						terminal = true;
						return failure("AMBIGUOUS_STORAGE_OUTCOME");
					}
					if (!plainRecord(committed) || typeof committed.ok !== "boolean") {
						terminal = true;
						return failure("AMBIGUOUS_STORAGE_OUTCOME");
					}
					if (!committed.ok) {
						const existing = copyCarrier(committed.existing);
						const reason = typeof committed.reason === "string" ? committed.reason : "COMMIT_REJECTED";
						if (reason === "REVALIDATION_REQUIRED") {
							const refreshFailure = await refreshSnapshot();
							return failure(refreshFailure ?? reason, existing);
						}
						if (reason === "STORAGE_LOSS") terminal = true;
						return failure(reason, existing);
					}
					if (typeof committed.duplicate !== "boolean") {
						terminal = true;
						return failure("AMBIGUOUS_STORAGE_OUTCOME");
					}
					const stored = copyCarrier(committed.stored);
					if (stored === undefined) {
						terminal = true;
						return failure("AMBIGUOUS_STORAGE_OUTCOME");
					}
					const nextRevision = plainRecord(committed.state) ? committed.state.revision : committed.revision;
					if (!safeNonnegative(nextRevision)) {
						terminal = true;
						return failure("AMBIGUOUS_STORAGE_OUTCOME");
					}
					revision = nextRevision;
					enteredRound = Math.max(enteredRound, round);
					return Object.freeze({
						carrierDigest: bytesToHex(prepared.registeredDigest),
						duplicate: committed.duplicate,
						ok: true as const,
						stored,
					});
				} catch (cause) {
					if (cause instanceof SigningAdmissionRefusal) return failure(cause.reason);
					throw cause;
				} finally {
					active = false;
				}
			},
		});
		return Object.freeze({ ok: true as const, voter: mintSealVoterPort(voter) });
	} catch {
		return failure("malformed-input");
	}
}
