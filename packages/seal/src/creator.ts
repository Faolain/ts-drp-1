import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { type FinalitySigner, signCreatorAnchorRequest } from "@ts-drp/keychain/finality";
import {
	completeCreatorSuccessor,
	openCreatorSuccessorTrust,
	prepareCreatorClose,
	prepareCreatorSuccessor,
} from "@ts-drp/protocol-v3/creator-close";
import { resolveSealAuthorityIdentity } from "@ts-drp/protocol-v3/internal/seal-authority-identity";
import { openSealAuthority, type SealAuthority, verifySealQC } from "@ts-drp/protocol-v3/seal";

import { createSealVoter, type ExactSealCarrier, type SealStorePort, type SealVoterHandle } from "./index.js";
import {
	copyCreatorCloseEvidenceRecord,
	type CreatorCloseEvidenceAdapter,
	type CreatorCloseEvidencePhase,
	type CreatorCloseEvidenceRecord,
	resolveCreatorCloseEvidenceStore,
} from "./internal/creator-close-intent.js";

type ActorResult = Readonly<
	| { ok: false; reason: string }
	| {
			exactCanonicalCommitQcBytes: Uint8Array;
			exactCanonicalPrepareQcBytes: Uint8Array;
			exactCanonicalTrustStateRecordBytes: Uint8Array;
			ok: true;
			valueDigest: string;
	  }
>;

interface CreatorActorStatus {
	readonly evidenceRevision: number;
	readonly phase: string;
	readonly terminal: boolean;
}

interface CreatorActor {
	close(input: Readonly<{ closeInput: Readonly<Record<string, unknown>> }>): Promise<ActorResult>;
	status(): CreatorActorStatus;
	stop(): Promise<void>;
}

interface ActorState {
	activeTask: Promise<ActorResult> | null;
	authority: SealAuthority | null;
	currentTrust: unknown;
	evidence: CreatorCloseEvidenceAdapter;
	evidenceRecord: CreatorCloseEvidenceRecord | null;
	onObservation(event: Readonly<Record<string, unknown>>): void;
	phase: string;
	signer: FinalitySigner;
	stopRequested: boolean;
	stopped: boolean;
	storageIncarnation: string;
	terminalReason: string | null;
	voteStore: SealStorePort;
	voter: SealVoterHandle | null;
}

const actorStates = new WeakMap<CreatorActor, ActorState>();
const digestHex = /^[0-9a-f]{64}$/u;
const publicKeyHex = /^[0-9a-f]{64}$/u;

function failure(reason: string): Readonly<{ ok: false; reason: string }> {
	return Object.freeze({ ok: false as const, reason });
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as object | null;
	return prototype === Object.prototype || prototype === null;
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexBytes(value: string): Uint8Array {
	if (!publicKeyHex.test(value)) throw new TypeError("invalid public key");
	return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

function signerIdentity(closeInput: Readonly<Record<string, unknown>>): Readonly<{
	publicKey: Uint8Array;
	signerId: string;
}> {
	const bytes = closeInput.exactCanonicalNextSignerSetBytes;
	if (!(bytes instanceof Uint8Array)) throw new TypeError("missing signer-set bytes");
	const decoded = decodeCanonical(bytes);
	if (!Array.isArray(decoded) || decoded.length !== 1 || !plainRecord(decoded[0])) {
		throw new TypeError("invalid creator signer set");
	}
	const signer = decoded[0];
	if (typeof signer.publicKey !== "string" || typeof signer.signerId !== "string") {
		throw new TypeError("invalid creator signer identity");
	}
	return Object.freeze({ publicKey: hexBytes(signer.publicKey), signerId: signer.signerId });
}

function cutIdentity(
	exactCanonicalCutValueBytes: Uint8Array
): Readonly<{ anchor: string; epoch: number; objectId: string }> {
	const decoded = decodeCanonical(exactCanonicalCutValueBytes);
	if (
		!plainRecord(decoded) ||
		typeof decoded.epoch !== "number" ||
		!Number.isSafeInteger(decoded.epoch) ||
		decoded.epoch < 0 ||
		typeof decoded.objectId !== "string" ||
		typeof decoded.previousAnchor !== "string" ||
		!digestHex.test(decoded.previousAnchor)
	) {
		throw new TypeError("invalid creator cut identity");
	}
	return Object.freeze({ anchor: decoded.previousAnchor, epoch: decoded.epoch, objectId: decoded.objectId });
}

function q1QcBytes(carrier: Readonly<{ exactCanonicalPreimageBytes: Uint8Array; signature: Uint8Array }>): Uint8Array {
	const vote = decodeCanonical(carrier.exactCanonicalPreimageBytes);
	if (!plainRecord(vote)) throw new TypeError("invalid signed vote carrier");
	return encodeCanonical({
		epoch: vote.epoch,
		kind: "drp-seal-qc",
		objectId: vote.objectId,
		phase: vote.phase,
		proposalDigest: vote.proposalDigest,
		proposalHash: vote.proposalHash,
		round: vote.round,
		votes: [
			{
				signature: hex(carrier.signature),
				signerId: vote.signerId,
				voteDigest: hex(hashDomain("ts-drp/seal-vote/v3", carrier.exactCanonicalPreimageBytes)),
			},
		],
	});
}

async function durableVoteCarrier(
	voter: SealVoterHandle,
	exactCanonicalCutValueBytes: Uint8Array,
	phase: "commit" | "prepare"
): Promise<Readonly<{ carrier: ExactSealCarrier; ok: true } | { ok: false; reason: string }>> {
	const voted = await voter.vote({
		exactCanonicalCutValueBytes,
		expectedRevision: voter.status().revision,
		phase,
		round: 0,
	});
	return voted.ok
		? Object.freeze({ carrier: voted.stored, ok: true as const })
		: Object.freeze({ ok: false as const, reason: voted.reason });
}

function phaseForRevision(revision: number): string {
	if (revision >= 4) return "finalized";
	if (revision === 3) return "commit-voted";
	if (revision === 2) return "prepared";
	if (revision === 1) return "prepare-voted";
	return "evidence-committed";
}

function emit(state: ActorState, kind: string): void {
	state.onObservation(Object.freeze({ kind }));
}

async function openVoter(
	state: ActorState,
	signerPublicKey: Uint8Array,
	expectedSignerId: string
): Promise<string | undefined> {
	if (state.voter !== null && state.authority !== null) return undefined;
	const opened = openSealAuthority({ signerPublicKey, trust: state.currentTrust });
	if (!opened.ok) return opened.reason === "signer-not-authorized" ? "SIGNER_NOT_AUTHORIZED" : opened.reason;
	if (opened.signerId !== expectedSignerId) return "SIGNER_NOT_AUTHORIZED";
	const created = await createSealVoter({
		authority: opened.authority,
		expectedStorageIncarnation: state.storageIncarnation,
		signer: state.signer,
		store: state.voteStore,
	});
	if (!created.ok) return created.reason;
	state.authority = opened.authority;
	state.voter = created.voter;
	state.phase = phaseForRevision(created.voter.status().revision);
	return undefined;
}

async function persistEvidence(
	state: ActorState,
	record: CreatorCloseEvidenceRecord,
	expectedPhase: CreatorCloseEvidencePhase | null
): Promise<string | undefined> {
	try {
		const result = await state.evidence.put(record, expectedPhase);
		if (!result.ok) {
			state.terminalReason = result.reason;
			return result.reason;
		}
		state.evidenceRecord = copyCreatorCloseEvidenceRecord(record);
		state.phase = record.phase;
		return undefined;
	} catch {
		state.terminalReason = "AMBIGUOUS_OUTCOME";
		return "AMBIGUOUS_OUTCOME";
	}
}

function nextRecord(
	record: CreatorCloseEvidenceRecord,
	input: Readonly<{
		commitQcBytes?: Uint8Array;
		phase: CreatorCloseEvidencePhase;
		prepareQcBytes?: Uint8Array;
		revision: number;
		trustBytes?: Uint8Array;
	}>
): CreatorCloseEvidenceRecord {
	return copyCreatorCloseEvidenceRecord({
		...record,
		exactCanonicalCommitQcBytes: input.commitQcBytes ?? record.exactCanonicalCommitQcBytes,
		exactCanonicalPrepareQcBytes: input.prepareQcBytes ?? record.exactCanonicalPrepareQcBytes,
		exactCanonicalTrustStateRecordBytes: input.trustBytes ?? record.exactCanonicalTrustStateRecordBytes,
		phase: input.phase,
		revision: input.revision,
	});
}

async function runClose(
	state: ActorState,
	input: Readonly<{ closeInput: Readonly<Record<string, unknown>> }>
): Promise<ActorResult> {
	try {
		if (!plainRecord(input) || Reflect.ownKeys(input).length !== 1 || !plainRecord(input.closeInput)) {
			return failure("MALFORMED_INPUT");
		}
		if (input.closeInput.currentTrust !== state.currentTrust) return failure("UNTRUSTED_CURRENT_ANCHOR");
		const preparedClose = prepareCreatorClose(input.closeInput);
		if (!preparedClose.ok) return failure(preparedClose.reason);
		const signer = signerIdentity(input.closeInput);
		const identity = cutIdentity(preparedClose.exactCanonicalCutValueBytes);
		const voterFailure = await openVoter(state, signer.publicKey, signer.signerId);
		if (voterFailure !== undefined) return failure(voterFailure);
		const authority = state.authority;
		const voter = state.voter;
		if (authority === null || voter === null) return failure("UNTRUSTED_CREATOR_ACTOR");

		let record = state.evidenceRecord;
		if (record === null) {
			record = Object.freeze({
				anchor: identity.anchor,
				epoch: identity.epoch,
				exactCanonicalCommitQcBytes: null,
				exactCanonicalCutValueBytes: Uint8Array.from(preparedClose.exactCanonicalCutValueBytes),
				exactCanonicalPrepareQcBytes: null,
				exactCanonicalTrustStateRecordBytes: null,
				objectId: identity.objectId,
				phase: "evidence-committed" as const,
				revision: 0,
				signerId: signer.signerId,
				signerPublicKey: Uint8Array.from(signer.publicKey),
				storageIncarnation: state.storageIncarnation,
				valueDigest: preparedClose.valueDigest,
			});
			const evidenceFailure = await persistEvidence(state, record, null);
			if (evidenceFailure !== undefined) return failure(evidenceFailure);
			emit(state, "close_evidence_committed");
		} else if (
			record.anchor !== identity.anchor ||
			record.epoch !== identity.epoch ||
			record.objectId !== identity.objectId ||
			record.signerId !== signer.signerId ||
			record.valueDigest !== preparedClose.valueDigest ||
			compareBytes(record.exactCanonicalCutValueBytes, preparedClose.exactCanonicalCutValueBytes) !== 0
		) {
			state.terminalReason = "CLOSE_CONFLICT";
			return failure("CLOSE_CONFLICT");
		}

		if (record.phase === "commit-vote-pending") {
			state.terminalReason = "AMBIGUOUS_OUTCOME";
			return failure("AMBIGUOUS_OUTCOME");
		}
		if (state.stopRequested) return failure("STOPPED");
		let voterStatus = voter.status();
		let prepareQcBytes = record.exactCanonicalPrepareQcBytes;
		let commitQcBytes = record.exactCanonicalCommitQcBytes;
		let prepareCarrier: ExactSealCarrier | null = null;
		let commitCarrier: ExactSealCarrier | null = null;

		if (voterStatus.revision < 1) {
			const voted = await voter.vote({
				exactCanonicalCutValueBytes: preparedClose.exactCanonicalCutValueBytes,
				expectedRevision: voterStatus.revision,
				phase: "prepare",
				round: 0,
			});
			if (!voted.ok) return failure(voted.reason);
			prepareCarrier = voted.stored;
			voterStatus = voter.status();
			record = nextRecord(record, { phase: "prepare-voted", revision: 1 });
			const evidenceFailure = await persistEvidence(state, record, state.evidenceRecord?.phase ?? null);
			if (evidenceFailure !== undefined) return failure(evidenceFailure);
			emit(state, "prepare_vote_committed");
		}
		if (state.stopRequested) return failure("STOPPED");

		if (voterStatus.revision < 2) {
			if (prepareCarrier === null) {
				const durable = await durableVoteCarrier(voter, preparedClose.exactCanonicalCutValueBytes, "prepare");
				if (!durable.ok) return failure(durable.reason);
				prepareCarrier = durable.carrier;
			}
			prepareQcBytes = q1QcBytes(prepareCarrier);
			const persisted = await voter.persistQc({ exactCanonicalQcBytes: prepareQcBytes });
			if (!plainRecord(persisted) || persisted.ok !== true) {
				return failure(plainRecord(persisted) && typeof persisted.reason === "string" ? persisted.reason : "QC_FAILED");
			}
			voterStatus = voter.status();
			record = nextRecord(record, { phase: "prepared", prepareQcBytes, revision: 2 });
			const evidenceFailure = await persistEvidence(state, record, state.evidenceRecord?.phase ?? null);
			if (evidenceFailure !== undefined) return failure(evidenceFailure);
			emit(state, "prepare_qc_committed");
		} else {
			prepareQcBytes ??= voterStatus.highestPrepareQcBytes;
		}
		if (prepareQcBytes === null) return failure("DURABLE_QC_INVALID");
		if (state.stopRequested) return failure("STOPPED");

		if (voterStatus.revision < 3) {
			const voted = await voter.vote({
				exactCanonicalCutValueBytes: preparedClose.exactCanonicalCutValueBytes,
				expectedRevision: voterStatus.revision,
				phase: "commit",
				round: 0,
			});
			if (!voted.ok) return failure(voted.reason);
			commitCarrier = voted.stored;
			voterStatus = voter.status();
			record = nextRecord(record, { phase: "commit-voted", prepareQcBytes, revision: 3 });
			const evidenceFailure = await persistEvidence(state, record, state.evidenceRecord?.phase ?? null);
			if (evidenceFailure !== undefined) return failure(evidenceFailure);
			emit(state, "commit_vote_committed");
		}
		if (state.stopRequested) return failure("STOPPED");

		if (voterStatus.revision < 4) {
			if (commitCarrier === null) {
				const durable = await durableVoteCarrier(voter, preparedClose.exactCanonicalCutValueBytes, "commit");
				if (!durable.ok) return failure(durable.reason);
				commitCarrier = durable.carrier;
			}
			commitQcBytes = q1QcBytes(commitCarrier);
			const persisted = await voter.persistQc({ exactCanonicalQcBytes: commitQcBytes });
			if (!plainRecord(persisted) || persisted.ok !== true) {
				return failure(plainRecord(persisted) && typeof persisted.reason === "string" ? persisted.reason : "QC_FAILED");
			}
			voterStatus = voter.status();
			record = nextRecord(record, { commitQcBytes, phase: "commit-qc-committed", revision: 4 });
			const evidenceFailure = await persistEvidence(state, record, state.evidenceRecord?.phase ?? null);
			if (evidenceFailure !== undefined) return failure(evidenceFailure);
			emit(state, "commit_qc_committed");
		} else if (commitQcBytes === null) {
			const durable = await durableVoteCarrier(voter, preparedClose.exactCanonicalCutValueBytes, "commit");
			if (!durable.ok) return failure(durable.reason);
			commitQcBytes = q1QcBytes(durable.carrier);
		}
		if (commitQcBytes === null || voterStatus.revision < 4) return failure("DURABLE_QC_INVALID");
		if (state.stopRequested) return failure("STOPPED");

		let trustBytes = record.exactCanonicalTrustStateRecordBytes;
		if (trustBytes === null) {
			const successor = prepareCreatorSuccessor({
				authority,
				close: preparedClose.close,
				exactCanonicalCommitQcBytes: commitQcBytes,
			});
			if (!successor.ok) return failure(successor.reason);
			const signature = await signCreatorAnchorRequest({ request: successor.signingRequest, signer: state.signer });
			const completed = completeCreatorSuccessor({ detachedSignature: signature, preparation: successor.preparation });
			if (!completed.ok) return failure(completed.reason);
			trustBytes = completed.exactCanonicalTrustStateRecordBytes;
			record = nextRecord(record, { commitQcBytes, phase: "finalized", prepareQcBytes, revision: 4, trustBytes });
			const evidenceFailure = await persistEvidence(state, record, state.evidenceRecord?.phase ?? null);
			if (evidenceFailure !== undefined) return failure(evidenceFailure);
			emit(state, "successor_completed");
		}

		const reopened = openCreatorSuccessorTrust({
			currentTrust: state.currentTrust,
			exactCanonicalCommitQcBytes: commitQcBytes,
			exactCanonicalCutValueBytes: preparedClose.exactCanonicalCutValueBytes,
			exactCanonicalTrustStateRecordBytes: trustBytes,
		});
		if (!reopened.ok) return failure(reopened.reason);
		state.phase = "finalized";
		return Object.freeze({
			exactCanonicalCommitQcBytes: Uint8Array.from(commitQcBytes),
			exactCanonicalPrepareQcBytes: Uint8Array.from(prepareQcBytes),
			exactCanonicalTrustStateRecordBytes: Uint8Array.from(trustBytes),
			ok: true as const,
			valueDigest: preparedClose.valueDigest,
		});
	} catch {
		state.terminalReason = "AMBIGUOUS_OUTCOME";
		return failure("AMBIGUOUS_OUTCOME");
	}
}

/**
 * Opens the durable singleton creator-close actor over opaque storage and signing capabilities.
 * @param input - Genuine creator trust, finality signer, and durable browser ports.
 * @returns Authenticated actor handle or a typed open failure.
 */
export async function createCreatorSealActor(
	input: Readonly<{
		currentTrust: unknown;
		evidenceStore: unknown;
		onObservation(event: Readonly<Record<string, unknown>>): void;
		signer: FinalitySigner;
		storageIncarnation: string;
		voteStore: SealStorePort;
	}>
): Promise<Readonly<{ actor: CreatorActor; ok: true } | { ok: false; reason: string }>> {
	try {
		if (
			!plainRecord(input) ||
			Reflect.ownKeys(input).length !== 6 ||
			typeof input.onObservation !== "function" ||
			typeof input.storageIncarnation !== "string"
		) {
			return failure("MALFORMED_INPUT");
		}
		const evidence = resolveCreatorCloseEvidenceStore(input.evidenceStore);
		if (evidence === undefined) return failure("UNTRUSTED_EVIDENCE_STORE");
		const rows = await evidence.readAll();
		const currentRows = rows.filter((candidate) => {
			const opened = openSealAuthority({ signerPublicKey: candidate.signerPublicKey, trust: input.currentTrust });
			if (!opened.ok || opened.signerId !== candidate.signerId) return false;
			const identity = resolveSealAuthorityIdentity(opened.authority);
			return (
				identity !== undefined &&
				candidate.anchor === identity.anchor &&
				candidate.epoch === identity.epoch &&
				candidate.objectId === identity.objectId &&
				candidate.signerId === identity.signerId
			);
		});
		if (currentRows.length > 1) return failure("SIGNER_NOT_AUTHORIZED");
		const record = currentRows[0] ?? null;
		if (record !== null && record.storageIncarnation !== input.storageIncarnation) return failure("STORAGE_LOSS");
		const state: ActorState = {
			activeTask: null,
			authority: null,
			currentTrust: input.currentTrust,
			evidence,
			evidenceRecord: record,
			onObservation: input.onObservation,
			phase: record?.phase ?? "empty",
			signer: input.signer,
			stopRequested: false,
			stopped: false,
			storageIncarnation: input.storageIncarnation,
			terminalReason: record?.phase === "commit-vote-pending" ? "AMBIGUOUS_OUTCOME" : null,
			voteStore: input.voteStore,
			voter: null,
		};
		if (record !== null) {
			const voterFailure = await openVoter(state, record.signerPublicKey, record.signerId);
			if (voterFailure !== undefined) return failure(voterFailure);
			if (record.exactCanonicalPrepareQcBytes !== null) {
				const authority = state.authority;
				const verified =
					authority === null
						? undefined
						: verifySealQC({ authority, exactCanonicalQcBytes: record.exactCanonicalPrepareQcBytes });
				if (
					verified === undefined ||
					!verified.ok ||
					verified.phase !== "prepare" ||
					verified.valueDigest !== record.valueDigest
				) {
					return failure("DURABLE_QC_INVALID");
				}
			}
			const revision = state.voter?.status().revision ?? 0;
			if (record.revision > revision || revision - record.revision > 1) state.terminalReason = "AMBIGUOUS_OUTCOME";
			if (record.phase === "finalized") {
				if (
					record.exactCanonicalCommitQcBytes === null ||
					record.exactCanonicalTrustStateRecordBytes === null ||
					!openCreatorSuccessorTrust({
						currentTrust: input.currentTrust,
						exactCanonicalCommitQcBytes: record.exactCanonicalCommitQcBytes,
						exactCanonicalCutValueBytes: record.exactCanonicalCutValueBytes,
						exactCanonicalTrustStateRecordBytes: record.exactCanonicalTrustStateRecordBytes,
					}).ok
				) {
					return failure("DURABLE_QC_INVALID");
				}
				state.phase = "finalized";
			}
		}
		const actor: CreatorActor = Object.freeze({
			close(this: CreatorActor, closeInput: Readonly<{ closeInput: Readonly<Record<string, unknown>> }>) {
				const owned = actorStates.get(this);
				if (owned === undefined) return Promise.resolve(failure("UNTRUSTED_CREATOR_ACTOR"));
				if (owned.stopped || owned.stopRequested) return Promise.resolve(failure("STOPPED"));
				if (owned.terminalReason !== null) return Promise.resolve(failure(owned.terminalReason));
				if (owned.activeTask !== null) return owned.activeTask;
				const wasFinalized = owned.evidenceRecord?.phase === "finalized";
				const task = runClose(owned, closeInput).then((result) =>
					result.ok && wasFinalized ? Object.freeze({ ...result, duplicate: true }) : result
				);
				owned.activeTask = task;
				void task.finally(() => {
					owned.activeTask = null;
				});
				return task;
			},
			status(this: CreatorActor) {
				const owned = actorStates.get(this);
				if (owned === undefined) return Object.freeze({ evidenceRevision: 0, phase: "terminal", terminal: true });
				return Object.freeze({
					evidenceRevision: owned.voter?.status().revision ?? owned.evidenceRecord?.revision ?? 0,
					phase: owned.stopped ? "stopped" : owned.phase,
					terminal: owned.terminalReason !== null,
				});
			},
			async stop(this: CreatorActor) {
				const owned = actorStates.get(this);
				if (owned === undefined || owned.stopped) return;
				owned.stopRequested = true;
				if (owned.activeTask !== null) await owned.activeTask;
				owned.stopped = true;
			},
		});
		actorStates.set(actor, state);
		return Object.freeze({ actor, ok: true as const });
	} catch {
		return failure("DURABLE_EVIDENCE_INVALID");
	}
}
