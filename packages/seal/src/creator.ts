import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { type FinalitySigner, signCreatorAnchorRequest } from "@ts-drp/keychain/finality";
import type { CurrentAnchorTrust } from "@ts-drp/protocol-v3";
import {
	completeCreatorForwardPromotionSuccessor,
	completeCreatorSuccessor,
	openCreatorForwardPromotionSuccessorTrust,
	openCreatorSuccessorTrust,
	prepareCreatorClose,
	prepareCreatorForwardPromotion,
	prepareCreatorForwardPromotionSuccessor,
	prepareCreatorSuccessor,
	readPreparedCreatorSuccessorAnchorForSizing,
} from "@ts-drp/protocol-v3/creator-close";
import { resolveSealAuthorityIdentity } from "@ts-drp/protocol-v3/internal/seal-authority-identity";
import { bindCreatorAnchorSigningRequest } from "@ts-drp/protocol-v3/internal/creator-anchor-signing-request";
import { SigningAdmissionRefusal } from "@ts-drp/protocol-v3/internal/seal-signing-request";
import {
	openSealAuthority,
	resolveSealRecoveryTrust,
	type SealAuthority,
	verifyRoundChange,
	verifySealQC,
	verifySealVoteCarrier,
} from "@ts-drp/protocol-v3/seal";

import {
	createSealVoter,
	type ExactSealCarrier,
	type SealStorePort,
	type SealVoterHandle,
	verifySealRecoverySnapshot,
} from "./index.js";
import {
	copyCreatorCloseEvidenceRecord,
	type CreatorCloseEvidenceAdapter,
	type CreatorCloseEvidencePhase,
	type CreatorCloseEvidenceRecord,
	resolveCreatorCloseEvidenceStore,
} from "./internal/creator-close-intent.js";
import {
	mintSealVoterEnrollment,
	nativeSigningAdmissionFactory,
	resolveSealStorePort,
	type SigningDependencyObservation,
	type SigningRetirementObservation,
} from "./internal/seal-vote-intent.js";

/** Original actor's authenticated native signing child; never a retirement grant. */
export interface CreatorSigningDependencyRead {
	readonly dependencyAnchors: readonly Readonly<{ epoch: number; anchorDigest: string }>[];
	readExactCanonicalRows(): readonly Uint8Array[];
	checkWhile(read: () => Promise<void>): Promise<void>;
	release(): Promise<void>;
}

/**
 * Slice 14a: a room retirement session's signing acquisition. It receives the actor's
 * own original facet, which the session accepts only when genuine for its database.
 */
export type CreatorSigningSessionAcquire = (
	store: unknown,
	input: Readonly<{ objectId: string }>,
	recovery: boolean
) => Promise<SigningRetirementObservation>;

/** Original actor-native factories, not proof of retirement eligibility. */
export interface CreatorSigningRetirementOwners {
	acquireVote(): Promise<SigningRetirementObservation>;
	acquireEvidence(): Promise<SigningRetirementObservation>;
	/** Slice 14a: the same gated, actor-tracked acquisition through a room retirement session. */
	acquireVoteIn?(session: CreatorSigningSessionAcquire): Promise<SigningRetirementObservation>;
	/** Slice 14a: the same gated, actor-tracked acquisition through a room retirement session. */
	acquireEvidenceIn?(session: CreatorSigningSessionAcquire): Promise<SigningRetirementObservation>;
}

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
	acquireRecoveryDependencies(trusts: readonly CurrentAnchorTrust[]): Promise<CreatorSigningDependencyRead>;
	captureRetirementOwners(): CreatorSigningRetirementOwners;
	close(input: Readonly<{ closeInput: Readonly<Record<string, unknown>> }>): Promise<ActorResult>;
	status(): CreatorActorStatus;
	stop(): Promise<void>;
}

/** Native recovery custody has no close/signing capability. It uses the same
 * authenticated rows and joined lifetime as the creator actor. */
export type CreatorSigningRecoveryOwner = Pick<CreatorActor,
	"acquireRecoveryDependencies" | "captureRetirementOwners" | "stop">;

type CreatorSigningCarrierContentFact =
	Pick<Extract<ReturnType<typeof verifyRoundChange>, {ok: true}>, "ok" | "signerId" | "round"> |
	Pick<Extract<ReturnType<typeof verifySealVoteCarrier>, {ok: true}>, "ok" | "signerId" | "round" | "phase">;
type CreatorSigningPeerContentFact = Readonly<{ok: true; signerId: string; round: number;
	phase: "prepare" | "commit"; valueDigest: string}>;
type CreatorSigningRowContentFact = Readonly<{carrier?: CreatorSigningCarrierContentFact;
	peer?: CreatorSigningPeerContentFact}>;
type CreatorSigningImageContentFact = Readonly<{incarnation: string; rows: readonly Uint8Array[];
	content: readonly CreatorSigningRowContentFact[]}>;
/** Last successful actor-local PURE verification only. These owned bytes never
 * carry native currency, a held reader, paid credit, or signing authority. */
type CreatorSigningContentFacts = Readonly<{
	exactContextBytes: Uint8Array; images: readonly CreatorSigningImageContentFact[]}>;

interface ActorState {
	dependencyTasks: Set<Promise<unknown>>;
	dependencyReads: Set<CreatorSigningDependencyRead>;
	retirementReads: Set<SigningRetirementObservation>;
	activeTask: Promise<ActorResult> | null;
	authority: SealAuthority | null;
	currentTrust: unknown;
	evidence: CreatorCloseEvidenceAdapter;
	/** The original minted evidence facet, offered only to a room retirement session. */
	evidenceStore: unknown;
	evidenceRecord: CreatorCloseEvidenceRecord | null;
	onObservation(event: Readonly<Record<string, unknown>>): void;
	phase: string;
	signer: FinalitySigner | undefined;
	stopRequested: boolean;
	stopped: boolean;
	storageIncarnation: string;
	terminalReason: string | null;
	voteStore: SealStorePort;
	voter: SealVoterHandle | null;
	signingContentFacts?: CreatorSigningContentFacts | undefined;
	signingContentAttempt?: object | undefined;
}

function invalidateCreatorSigningContentFacts(state: ActorState): void {
	state.signingContentFacts = undefined;
	state.signingContentAttempt = undefined;
}

const actorStates = new WeakMap<CreatorActor, ActorState>();
const signingRecoveryOwners = new WeakMap<CreatorSigningRecoveryOwner, CreatorActor>();
const digestHex = /^[0-9a-f]{64}$/u;
const publicKeyHex = /^[0-9a-f]{64}$/u;

/** Mechanical original q1 native frames; every unknown frame needs full charge. */
export interface CreatorCloseSigningFrameWidth {
	readonly store: "signerState" | "voteSlots" | "voteOutbox" | "sealEvidence";
	readonly key: readonly (string | number)[];
	readonly phase: string;
	readonly canonicalRowByteLength: number;
	readonly canonicalFrameByteLength: number;
}

function signingUnknownBytesWidth(length: number): number {
	if (!Number.isSafeInteger(length) || length < 0) throw new TypeError("invalid signing encoding length");
	let count = 1;
	for (let remainder = length; remainder >= 128; remainder = Math.floor(remainder / 128)) count++;
	const width = 1 + count + length;
	if (!Number.isSafeInteger(width)) throw new TypeError("signing encoding length overflow");
	return width;
}

function signingRecordWidth(
	known: Readonly<Record<string, unknown>>,
	unknown: Readonly<Record<string, number>>
): number {
	const keys = Object.keys(unknown);
	// These original native codecs have fewer than 128 fields. The map-count
	// varuint is unchanged when the omitted unknown fields are put back.
	if (Object.keys(known).length + keys.length >= 128 || keys.some((key) => Object.hasOwn(known, key)))
		throw new TypeError("invalid signing encoding fields");
	const width =
		encodeCanonical(known).byteLength +
		keys.reduce((sum, key) => {
			const width = unknown[key];
			if (width === undefined || !Number.isSafeInteger(width) || width < 1)
				throw new TypeError("invalid signing encoding length");
			return sum + encodeCanonical(key).byteLength + width;
		}, 0);
	if (!Number.isSafeInteger(width)) throw new TypeError("signing encoding length overflow");
	return width;
}

/** The ORIGINAL fresh round-zero q=1 phase record fields. T is a complete
 * encoded child slot (a scalar width or codec resource footprint), never bytes,
 * a signature, authenticated trust, a prepared close or a native capability.
 * The authoritative reader below still owns every freshness/crypto guard. */
export function creatorCloseSigningPhaseFields<T>(input: Readonly<{
	scope: Readonly<{epoch: unknown; objectId: unknown; signerId: unknown}>;
	anchor: unknown; valueDigest: unknown; storageIncarnation: unknown; signerPublicKey: unknown;
	exactCanonicalCutValueBytes: unknown;
	prepareSummary: T; commitSummary: T;
	prepareQcBytes: T; commitQcBytes: T; trustBytes: T;
	prepareCarrier: T; commitCarrier: T;
}>): readonly Readonly<{store: CreatorCloseSigningFrameWidth["store"]; phase: string;
	known: Readonly<Record<string, unknown>>; unknown: Readonly<Record<string, T>>}>[] {
	const scope = input.scope, rows: {store: CreatorCloseSigningFrameWidth["store"]; phase: string;
		known: Readonly<Record<string, unknown>>; unknown: Readonly<Record<string, T>>}[] = [];
	const add = (store: CreatorCloseSigningFrameWidth["store"], phase: string,
		known: Readonly<Record<string, unknown>>, unknown: Readonly<Record<string, T>> = {}) =>
		rows.push(Object.freeze({store, phase, known: Object.freeze(known), unknown: Object.freeze(unknown)}));
	const baseState = {...scope, anchor: input.anchor, retiredBeforeRound: 0, enteredRound: 0,
		committedValueDigest: null, durableCommitQcCount: 0, durablePrepareQcCount: 0,
		finalizedCommitQC: null, finalizedValueDigest: null, highestPrepareQC: null,
		lockRound: null, lockedValueDigest: null, revision: 1};
	add("signerState", "prepare-voted", baseState);
	const {highestPrepareQC: _highest, ...preparedState} = {...baseState, durablePrepareQcCount: 1,
		lockRound: 0, lockedValueDigest: input.valueDigest, revision: 2};
	add("signerState", "prepared", preparedState, {highestPrepareQC: input.prepareSummary});
	add("signerState", "commit-voted", {...preparedState, committedValueDigest: input.valueDigest, revision: 3},
		{highestPrepareQC: input.prepareSummary});
	const {finalizedCommitQC: _final, ...finalState} = {...preparedState, committedValueDigest: input.valueDigest,
		finalizedValueDigest: input.valueDigest, durableCommitQcCount: 1, revision: 4};
	add("signerState", "commit-qc-committed", finalState,
		{highestPrepareQC: input.prepareSummary, finalizedCommitQC: input.commitSummary});
	for (const phase of ["prepare", "commit"] as const) {
		const carrier = phase === "prepare" ? input.prepareCarrier : input.commitCarrier;
		add("voteSlots", phase, {...scope, phase, round: 0}, {carrier});
		add("voteOutbox", phase, {...scope, phase, round: 0, dispatched: false}, {carrier});
	}
	const baseEvidence = {...scope, anchor: input.anchor,
		exactCanonicalCutValueBytes: input.exactCanonicalCutValueBytes,
		storageIncarnation: input.storageIncarnation, signerPublicKey: input.signerPublicKey, valueDigest: input.valueDigest};
	for (const [phase, revision, prepare, commit, trust] of [
		["evidence-committed", 0, false, false, false], ["prepare-voted", 1, false, false, false],
		["prepared", 2, true, false, false], ["commit-voted", 3, true, false, false],
		["commit-qc-committed", 4, true, true, false], ["finalized", 4, true, true, true],
	] as const) add("sealEvidence", phase, {...baseEvidence, phase, revision,
		...(prepare ? {} : {exactCanonicalPrepareQcBytes: null}),
		...(commit ? {} : {exactCanonicalCommitQcBytes: null}),
		...(trust ? {} : {exactCanonicalTrustStateRecordBytes: null})}, {
		...(prepare ? {exactCanonicalPrepareQcBytes: input.prepareQcBytes} : {}),
		...(commit ? {exactCanonicalCommitQcBytes: input.commitQcBytes} : {}),
		...(trust ? {exactCanonicalTrustStateRecordBytes: input.trustBytes} : {}),
	});
	return Object.freeze(rows);
}

export function creatorCloseSigningQcSummaryFields<T>(input: Readonly<{phase: "prepare" | "commit";
	valueDigest: unknown; digest: T; proposalHash: T; exactCanonicalQcBytes: T}>) {
	return {known: {phase: input.phase, round: 0, valueDigest: input.valueDigest},
		unknown: {digest: input.digest, proposalHash: input.proposalHash, exactCanonicalQcBytes: input.exactCanonicalQcBytes}};
}

export function creatorCloseSigningVotePreimageFields<T>(input: Readonly<{
	scope: Readonly<{epoch: unknown; objectId: unknown; signerId: unknown}>;
	phase: "prepare" | "commit"; valueDigest: unknown; proposalHash: T}>) {
	return {known: {...input.scope, kind: "drp-seal-vote", phase: input.phase, proposalDigest: input.valueDigest, round: 0},
		unknown: {proposalHash: input.proposalHash}};
}

export function creatorCloseSigningStoredCarrierFields<T>(input: Readonly<{exactCanonicalPreimageBytes: T; signature: T}>) {
	return {known: {}, unknown: {exactCanonicalPreimageBytes: input.exactCanonicalPreimageBytes, signature: input.signature}};
}

/**
 * Sizes the original fresh round-zero q1 close, without signing or native writes.
 * Existing protected scopes remain in the source ledger. An entered current
 * close is not a fresh-issuance quote: its original recovery owner must finish it.
 * @param input - Genuine prepared close/current trust and already authenticated native source frames.
 * @returns Full native frame lengths, never eligibility, future authority or dedup identities.
 */
/** SAME original pristine round-zero native-row eligibility. This returns no
 * trust, signer, prepared-close or deletion authority; the caller still owes
 * the original authenticated scope and fresh native capture. */
export function creatorPristineSigningSourceMatchesForSizing(input: Readonly<{
	objectId: string; currentEpoch: number; currentAnchorDigest: string;
	signerId: string; storageIncarnation: string; actualRows: readonly Uint8Array[];
}>): boolean {
	try {
		let incarnationSeen = false, pristineBytes: Uint8Array | undefined;
		for (const bytes of input.actualRows) {
			const frame = decodeCanonical(bytes);
			if (!Array.isArray(frame) || frame.length !== 3) return false;
			const [store, key, row] = frame;
			if (store === "storageMeta") {
				if (key === "incarnation") {
					if (!plainRecord(row) || row.value !== input.storageIncarnation) return false;
					incarnationSeen = true;
				}
				continue;
			}
			if (!Array.isArray(key) || key[0] !== input.objectId || key[1] !== input.currentEpoch) continue;
			if (store !== "signerState" || key.length !== 3 || key[2] !== input.signerId || !plainRecord(row) ||
				row.anchor !== input.currentAnchorDigest || row.revision !== 0 || row.enteredRound !== 0 ||
				(row.retiredBeforeRound !== undefined && row.retiredBeforeRound !== 0) || row.lockRound !== null ||
				row.lockedValueDigest !== null || row.committedValueDigest !== null || row.finalizedValueDigest !== null ||
				row.highestPrepareQC !== null || row.finalizedCommitQC !== null || row.durablePrepareQcCount !== 0 ||
				row.durableCommitQcCount !== 0 || (pristineBytes !== undefined && compareBytes(pristineBytes, bytes) !== 0)) return false;
			pristineBytes = bytes;
		}
		return incarnationSeen;
	} catch { return false; }
}

export function readCreatorCloseSigningFramesForSizing(
	input: Readonly<{
		currentTrust: CurrentAnchorTrust;
		genuinePreparedClose: object;
		exactCanonicalCutValueBytes: Uint8Array;
		prepareQcByteLength: number;
		commitQcByteLength: number;
		successorTrustByteLength: number;
		storageIncarnation: string;
		actualRows: readonly Uint8Array[];
	}>
): Readonly<{ ok: true; frames: readonly CreatorCloseSigningFrameWidth[] } | { ok: false; reason: string }> {
	try {
		const material = resolveSealRecoveryTrust(input.currentTrust);
		const unsigned = readPreparedCreatorSuccessorAnchorForSizing({ close: input.genuinePreparedClose });
		if (material === undefined || !unsigned.ok || !/^[0-9a-f]{32}$/u.test(input.storageIncarnation))
			return failure("SIGNING_QUOTE_UNAVAILABLE");
		const anchor = decodeCanonical(unsigned.exactCanonicalAnchorPreimageBytes);
		const valueDigest = hex(hashDomain("ts-drp/hard-epoch-cut/v3", input.exactCanonicalCutValueBytes));
		const cut = cutIdentity(input.exactCanonicalCutValueBytes);
		if (
			!plainRecord(anchor) ||
			anchor.cutDigest !== valueDigest ||
			anchor.previousAnchor !== material.currentAnchorDigest ||
			anchor.objectId !== material.objectId ||
			anchor.epoch !== material.currentEpoch + 1 ||
			cut.objectId !== material.objectId ||
			cut.epoch !== material.currentEpoch ||
			cut.anchor !== material.currentAnchorDigest
		)
			return failure("SIGNING_QUOTE_UNAVAILABLE");
		const members = decodeCanonical(material.exactCanonicalSignerSetBytes);
		if (
			!Array.isArray(members) ||
			members.length !== 1 ||
			!plainRecord(members[0]) ||
			typeof members[0].signerId !== "string" ||
			typeof members[0].publicKey !== "string"
		)
			return failure("SIGNING_QUOTE_UNAVAILABLE");
		const signerId = members[0].signerId,
			signerPublicKey = hexBytes(members[0].publicKey);
		const authority = openSealAuthority({ trust: input.currentTrust, signerPublicKey });
		if (!authority.ok || authority.signerId !== signerId) return failure("SIGNING_QUOTE_UNAVAILABLE");
		if (!creatorPristineSigningSourceMatchesForSizing({objectId: material.objectId, currentEpoch: material.currentEpoch,
			currentAnchorDigest: material.currentAnchorDigest, signerId, storageIncarnation: input.storageIncarnation,
			actualRows: input.actualRows})) return failure("SIGNING_QUOTE_UNAVAILABLE");
		for (const length of [input.prepareQcByteLength, input.commitQcByteLength, input.successorTrustByteLength])
			if (!Number.isSafeInteger(length) || length < 1) return failure("SIGNING_QUOTE_UNAVAILABLE");
		const scope = { epoch: material.currentEpoch, objectId: material.objectId, signerId };
		const key = [scope.objectId, scope.epoch, signerId] as const;
		const frames: CreatorCloseSigningFrameWidth[] = [];
		const add = (
			store: CreatorCloseSigningFrameWidth["store"],
			address: readonly (string | number)[],
			phase: string,
			rowWidth: number
		): void => {
			const frameWidth =
				encodeCanonical([store, address, null]).byteLength - encodeCanonical(null).byteLength + rowWidth;
			if (!Number.isSafeInteger(frameWidth)) throw new TypeError("signing frame encoding length overflow");
			frames.push(
				Object.freeze({
					store,
					key: Object.freeze([...address]),
					phase,
					canonicalRowByteLength: rowWidth,
					// ARRAY3 header is unchanged; replace only the actual NULL row value.
					canonicalFrameByteLength: frameWidth,
				})
			);
		};
		const unknownHex64 = 1 + 1 + 64;
		const qcSummaryWidth = (phase: "prepare" | "commit", length: number): number => {
			const fields = creatorCloseSigningQcSummaryFields({phase, valueDigest, digest: unknownHex64,
				proposalHash: unknownHex64, exactCanonicalQcBytes: signingUnknownBytesWidth(length)});
			return signingRecordWidth(fields.known, fields.unknown);
		};
		const prepareSummary = qcSummaryWidth("prepare", input.prepareQcByteLength);
		const commitSummary = qcSummaryWidth("commit", input.commitQcByteLength);
		const carrierWidth = (phase: "prepare" | "commit") => {
			const vote = creatorCloseSigningVotePreimageFields({scope, phase, valueDigest, proposalHash: unknownHex64});
			const voteWidth = signingRecordWidth(vote.known, vote.unknown);
			const carrier = creatorCloseSigningStoredCarrierFields({exactCanonicalPreimageBytes: signingUnknownBytesWidth(voteWidth),
				signature: signingUnknownBytesWidth(64)});
			return signingRecordWidth(carrier.known, carrier.unknown);
		};
		for (const row of creatorCloseSigningPhaseFields({scope, anchor: material.currentAnchorDigest, valueDigest,
			storageIncarnation: input.storageIncarnation, signerPublicKey,
			exactCanonicalCutValueBytes: input.exactCanonicalCutValueBytes,
			prepareSummary, commitSummary, prepareCarrier: carrierWidth("prepare"), commitCarrier: carrierWidth("commit"),
			prepareQcBytes: signingUnknownBytesWidth(input.prepareQcByteLength),
			commitQcBytes: signingUnknownBytesWidth(input.commitQcByteLength),
			trustBytes: signingUnknownBytesWidth(input.successorTrustByteLength)})) {
			const address = row.store === "voteSlots" || row.store === "voteOutbox"
				? [scope.objectId, scope.epoch, 0, row.phase, signerId] : key;
			add(row.store, address, row.phase, signingRecordWidth(row.known, row.unknown));
		}
		return Object.freeze({ ok: true as const, frames: Object.freeze(frames) });
	} catch {
		return failure("SIGNING_QUOTE_UNAVAILABLE");
	}
}

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

/** Original q=1 vote/QC schemas, also accepting scalar resource slots. They
 * neither verify signatures nor grant vote, QC, seal or close authority. */
export function creatorQ1SealVoteFields(input: Readonly<{signature: unknown; signerId: unknown; voteDigest: unknown}>):
	Readonly<Record<string, unknown>> {
	return {signature: input.signature, signerId: input.signerId, voteDigest: input.voteDigest};
}

export function creatorQ1SealQcFields(vote: Readonly<Record<string, unknown>>, votes: unknown): Readonly<Record<string, unknown>> {
	return {
		epoch: vote.epoch,
		kind: "drp-seal-qc",
		objectId: vote.objectId,
		phase: vote.phase,
		proposalDigest: vote.proposalDigest,
		proposalHash: vote.proposalHash,
		round: vote.round,
		votes,
	};
}

function q1QcBytes(carrier: Readonly<{ exactCanonicalPreimageBytes: Uint8Array; signature: Uint8Array }>): Uint8Array {
	const vote = decodeCanonical(carrier.exactCanonicalPreimageBytes);
	if (!plainRecord(vote)) throw new TypeError("invalid signed vote carrier");
	return encodeCanonical(creatorQ1SealQcFields(vote, [creatorQ1SealVoteFields({
		signature: hex(carrier.signature), signerId: vote.signerId,
		voteDigest: hex(hashDomain("ts-drp/seal-vote/v3", carrier.exactCanonicalPreimageBytes)),
	})]));
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

/**
 * Same QC/successor law used by original restore and the held native row census.
 * @param authority - Original certified signer authority.
 * @param trust - Original authenticated current-trust capability.
 * @param row - Original native creator-close evidence row.
 * @returns Original refusal reason, or no reason when the evidence authenticates.
 */
function recoveryEvidenceFailure(
	authority: SealAuthority,
	trust: CurrentAnchorTrust,
	row: Pick<
		CreatorCloseEvidenceRecord,
		| "anchor"
		| "epoch"
		| "objectId"
		| "signerId"
		| "valueDigest"
		| "phase"
		| "exactCanonicalCutValueBytes"
		| "exactCanonicalPrepareQcBytes"
		| "exactCanonicalCommitQcBytes"
		| "exactCanonicalTrustStateRecordBytes"
	>
): string | undefined {
	const identity = resolveSealAuthorityIdentity(authority);
	const cut = cutIdentity(row.exactCanonicalCutValueBytes);
	if (
		identity === undefined ||
		identity.objectId !== row.objectId ||
		identity.epoch !== row.epoch ||
		identity.signerId !== row.signerId ||
		identity.anchor !== row.anchor ||
		cut.objectId !== row.objectId ||
		cut.epoch !== row.epoch ||
		cut.anchor !== row.anchor ||
		row.valueDigest !== hex(hashDomain("ts-drp/hard-epoch-cut/v3", row.exactCanonicalCutValueBytes))
	)
		return "DURABLE_EVIDENCE_INVALID";
	for (const [phase, bytes] of [
		["prepare", row.exactCanonicalPrepareQcBytes],
		["commit", row.exactCanonicalCommitQcBytes],
	] as const) {
		if (bytes === null) continue;
		const verified = verifySealQC({ authority, exactCanonicalQcBytes: bytes });
		if (!verified.ok || verified.phase !== phase || verified.valueDigest !== row.valueDigest)
			return "DURABLE_QC_INVALID";
	}
	if (row.phase === "finalized") {
		if (row.exactCanonicalCommitQcBytes === null || row.exactCanonicalTrustStateRecordBytes === null)
			return "DURABLE_QC_INVALID";
		const opened = (
			Object.hasOwn(decodeCanonical(row.exactCanonicalCutValueBytes) as object, "forwardPromotion")
				? openCreatorForwardPromotionSuccessorTrust
				: openCreatorSuccessorTrust
		)({
			currentTrust: trust,
			exactCanonicalCommitQcBytes: row.exactCanonicalCommitQcBytes,
			exactCanonicalCutValueBytes: row.exactCanonicalCutValueBytes,
			exactCanonicalTrustStateRecordBytes: row.exactCanonicalTrustStateRecordBytes,
		});
		if (!opened.ok) return "DURABLE_QC_INVALID";
	}
	return undefined;
}

type CreatorFinalizedEvidenceMaterial = Readonly<{
	trust: CurrentAnchorTrust;
	signerId: string;
	exactCanonicalCutValueBytes: Uint8Array;
	exactCanonicalPrepareQcBytes: Uint8Array;
	exactCanonicalCommitQcBytes: Uint8Array;
	exactCanonicalTrustStateRecordBytes: Uint8Array;
}>;

function resolveCreatorEvidenceSigner(
	trust: CurrentAnchorTrust,
	signerId: string
):
	| Readonly<{
			material: NonNullable<ReturnType<typeof resolveSealRecoveryTrust>>;
			signerPublicKey: Uint8Array;
			authority: SealAuthority;
	  }>
	| undefined {
	const material = resolveSealRecoveryTrust(trust);
	if (material === undefined) return undefined;
	const members = decodeCanonical(material.exactCanonicalSignerSetBytes);
	if (!Array.isArray(members)) return undefined;
	const signers = members.filter((member) => plainRecord(member) && member.signerId === signerId);
	const signer = signers[0] as Readonly<Record<string, unknown>> | undefined;
	if (signers.length !== 1 || signer === undefined || typeof signer.publicKey !== "string") return undefined;
	const signerPublicKey = hexBytes(signer.publicKey);
	const authority = openSealAuthority({ trust, signerPublicKey });
	if (!authority.ok || authority.signerId !== signerId) return undefined;
	return { material, signerPublicKey, authority: authority.authority };
}

/**
 * Verifies retained finalized content without manufacturing a deleted native row.
 * Eligibility, native currency and permanent fences remain the retirement owner's laws.
 * @param input - Original nominal trust, signer and exact retained Cut/QCs/successor.
 * @returns Whether the same original recovery verifier authenticates the content.
 */
export function verifyCreatorFinalizedEvidence(input: CreatorFinalizedEvidenceMaterial): boolean {
	try {
		if (
			[
				input.exactCanonicalCutValueBytes,
				input.exactCanonicalPrepareQcBytes,
				input.exactCanonicalCommitQcBytes,
				input.exactCanonicalTrustStateRecordBytes,
			].some((bytes) => !(bytes instanceof Uint8Array) || bytes.byteLength === 0)
		)
			return false;
		const signer = resolveCreatorEvidenceSigner(input.trust, input.signerId);
		if (signer === undefined) return false;
		return (
			recoveryEvidenceFailure(signer.authority, input.trust, {
				anchor: signer.material.currentAnchorDigest,
				epoch: signer.material.currentEpoch,
				objectId: signer.material.objectId,
				signerId: input.signerId,
				phase: "finalized",
				valueDigest: hex(hashDomain("ts-drp/hard-epoch-cut/v3", input.exactCanonicalCutValueBytes)),
				exactCanonicalCutValueBytes: input.exactCanonicalCutValueBytes,
				exactCanonicalPrepareQcBytes: input.exactCanonicalPrepareQcBytes,
				exactCanonicalCommitQcBytes: input.exactCanonicalCommitQcBytes,
				exactCanonicalTrustStateRecordBytes: input.exactCanonicalTrustStateRecordBytes,
			}) === undefined
		);
	} catch {
		return false;
	}
}

/**
 * Reconstructs a finalized local row from retained authenticated content. This
 * only authenticates the original evidence shape; it grants no retirement law.
 * @param input - Original trust and exact retained Cut/QCs/successor bytes.
 * @returns The original row, or undefined when its original verifier refuses.
 */
export function reconstructCreatorFinalizedEvidence(
	input: Readonly<{
		trust: CurrentAnchorTrust;
		signerId: string;
		revision: number;
		storageIncarnation: string;
		exactCanonicalCutValueBytes: Uint8Array;
		exactCanonicalPrepareQcBytes: Uint8Array;
		exactCanonicalCommitQcBytes: Uint8Array;
		exactCanonicalTrustStateRecordBytes: Uint8Array;
	}>
): CreatorCloseEvidenceRecord | undefined {
	const material = resolveSealRecoveryTrust(input.trust);
	if (material === undefined || !Number.isSafeInteger(input.revision) || input.revision < 4) return undefined;
	const signer = resolveCreatorEvidenceSigner(input.trust, input.signerId);
	if (signer === undefined) return undefined;
	const row = copyCreatorCloseEvidenceRecord({
		anchor: material.currentAnchorDigest,
		epoch: material.currentEpoch,
		objectId: material.objectId,
		exactCanonicalCutValueBytes: input.exactCanonicalCutValueBytes,
		exactCanonicalPrepareQcBytes: input.exactCanonicalPrepareQcBytes,
		exactCanonicalCommitQcBytes: input.exactCanonicalCommitQcBytes,
		exactCanonicalTrustStateRecordBytes: input.exactCanonicalTrustStateRecordBytes,
		phase: "finalized",
		revision: input.revision,
		signerId: input.signerId,
		signerPublicKey: signer.signerPublicKey,
		storageIncarnation: input.storageIncarnation,
		valueDigest: hex(hashDomain("ts-drp/hard-epoch-cut/v3", input.exactCanonicalCutValueBytes)),
	});
	return recoveryEvidenceFailure(signer.authority, input.trust, row) === undefined ? row : undefined;
}

async function acquireSigningDependencies(
	state: ActorState,
	supplied: readonly CurrentAnchorTrust[],
	prepareData?: CreatorSigningDependencyPreparation
): Promise<CreatorSigningDependencyRead> {
	const contextTrust = state.currentTrust, contextIncarnation = state.storageIncarnation;
	const previousContent = state.signingContentFacts, contentAttempt = Object.freeze({});
	// A failed/overlapping acquisition cannot install another attempt's facts.
	// Never accumulate images as the room ages; only this latest success survives.
	state.signingContentFacts = undefined;
	state.signingContentAttempt = contentAttempt;
	if (!Array.isArray(supplied)) throw new TypeError("creator signing dependency authority is unavailable");
	const length = Object.getOwnPropertyDescriptor(supplied, "length");
	if (
		length === undefined ||
		!("value" in length) ||
		!Number.isSafeInteger(length.value) ||
		length.value < 1 ||
		length.value > 7
	)
		throw new TypeError("creator signing dependency authority is unavailable");
	const trusts: CurrentAnchorTrust[] = [];
	for (let index = 0; index < length.value; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(supplied, String(index));
		if (descriptor === undefined || !("value" in descriptor))
			throw new TypeError("creator signing dependency authority is unavailable");
		trusts.push(descriptor.value as CurrentAnchorTrust);
	}
	// Resolve original private trust custody before opening any native transaction.
	// Numeric epoch/anchor records and copied capabilities cannot enter this set.
	const current = resolveSealRecoveryTrust(state.currentTrust as CurrentAnchorTrust);
	const materials = trusts.map((trust) => ({ trust, material: resolveSealRecoveryTrust(trust) }));
	if (
		current === undefined ||
		!materials.some(
			({ material }) =>
				material !== undefined &&
				material.currentEpoch === current.currentEpoch &&
				material.currentAnchorDigest === current.currentAnchorDigest &&
				compareBytes(
					material.exactCanonicalCurrentAnchorPreimageBytes,
					current.exactCanonicalCurrentAnchorPreimageBytes
				) === 0
		)
	)
		throw new TypeError("creator signing current authority is unavailable");
	const authenticatedMaterials = materials.map(({ trust, material }) => {
		if (
			material === undefined ||
			material.objectId !== current.objectId ||
			material.genesisAnchorDigest !== current.genesisAnchorDigest
		)
			throw new TypeError("creator signing dependency authority is foreign");
		return { trust, material };
	});
	// Resolve ALL original nominal custody freshly above, then bind every byte
	// and scalar of the detached material, not merely epoch/digest/signer labels.
	let exactContextBytes: Uint8Array | undefined;
	try {
		exactContextBytes = encodeCanonical({current, materials: authenticatedMaterials.map(({material}) => material),
			storageIncarnation: state.storageIncarnation});
	} catch { /* Optional reuse cannot impose a new combined-encoding admission limit. */ }
	const sameContentContext = exactContextBytes !== undefined && previousContent !== undefined &&
		compareBytes(previousContent.exactContextBytes, exactContextBytes) === 0;
	// This acquisition resolved and owns the exact original trust material above.
	// Every captured native row still gets fresh original role/key resolution.
	// Exact last-image facts may reuse PURE crypto results only; rows sharing
	// that same trust and signer need not repeatedly decode the
	// immutable signer set and construct equivalent authorities. This map never
	// crosses an acquisition/native lifetime or enters ActorState/the returned read.
	const signerAuthorities = new Map<CurrentAnchorTrust, Map<string, SealAuthority>>();
	const authorityFor = (
		epoch: unknown,
		signerId: unknown
	): Readonly<{ authority: SealAuthority; trust: CurrentAnchorTrust }> => {
		if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0 || typeof signerId !== "string")
			throw new TypeError("UNCLASSIFIED_SIGNING_DEPENDENCY");
		const candidates = authenticatedMaterials.filter(({ material }) => material.currentEpoch === epoch);
		const candidate = candidates[0];
		if (
			candidate === undefined ||
			candidates.some(({ material }) => material.currentAnchorDigest !== candidate.material.currentAnchorDigest)
		)
			throw new TypeError(`UNCLASSIFIED_SIGNING_DEPENDENCY:${epoch}`);
		const { trust, material } = candidate;
		const previous = signerAuthorities.get(trust)?.get(signerId);
		if (previous !== undefined) return {authority: previous, trust};
		const signerSet = decodeCanonical(material.exactCanonicalSignerSetBytes);
		if (!Array.isArray(signerSet)) throw new TypeError("DURABLE_EVIDENCE_INVALID");
		const signer = signerSet.find((entry) => plainRecord(entry) && entry.signerId === signerId) as
			| Record<string, unknown>
			| undefined;
		if (signer === undefined || typeof signer.publicKey !== "string") throw new TypeError("SIGNER_NOT_AUTHORIZED");
		const opened = openSealAuthority({ trust, signerPublicKey: hexBytes(signer.publicKey) });
		if (!opened.ok || opened.signerId !== signerId) throw new TypeError("SIGNER_NOT_AUTHORIZED");
		let signers = signerAuthorities.get(trust);
		if (signers === undefined) {signers = new Map(); signerAuthorities.set(trust, signers);}
		signers.set(signerId, opened.authority);
		return { authority: opened.authority, trust };
	};
	const vote = resolveSealStorePort(state.voteStore);
	const acquireVote = vote?.acquireSigningDependencyObservation;
	const acquireEvidence = state.evidence.acquireSigningDependencyObservation;
	if (acquireVote === undefined || acquireEvidence === undefined)
		throw new TypeError("native signing dependency observation is unsupported");
	const held: SigningDependencyObservation[] = [];
	// These values come only from the original native control/trust producers.
	// Copy/compare their complete data domain without adding another combined
	// canonical-encoding limit or retaining any native method in preparation.
	const copyData = (value: unknown): unknown => {
		if (value instanceof Uint8Array) return Uint8Array.from(value);
		if (Array.isArray(value)) return Object.freeze(value.map(copyData));
		if (value !== null && typeof value === "object") return Object.freeze(Object.fromEntries(
			Object.keys(value).map(key => [key, copyData((value as Record<string, unknown>)[key])])));
		return value;
	};
	const sameData = (left: unknown, right: unknown): boolean => {
		if (left instanceof Uint8Array || right instanceof Uint8Array)
			return left instanceof Uint8Array && right instanceof Uint8Array && compareBytes(left, right) === 0;
		if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) &&
			left.length === right.length && left.every((value, index) => sameData(value, right[index]));
		if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return Object.is(left, right);
		const keys = Object.keys(left), other = Object.keys(right);
		return keys.length === other.length && keys.every(key => Object.hasOwn(right, key) &&
			sameData((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
	};
	let primary: unknown;
	let failed = false;
	try {
		held.push(await acquireVote({ objectId: current.objectId }));
		held.push(await acquireEvidence({ objectId: current.objectId }));
		// Each genuine producer has already enforced its ORIGINAL complete native
		// image/count limits. Retain at most these TWO images from one success;
		// no per-epoch history, decoded rows, native reads or authorities enter the cell.
		const captured = held.map((observation) => ({
			// OWN before verifying. A post-verification copied witness could differ
			// from bytes a hostile adapter/caller mutated during verification.
			rows: Object.freeze(observation.readExactCanonicalRows().map(bytes => Uint8Array.from(bytes))),
			incarnation: observation.control.incarnation,
			control: copyData(observation.control),
			imageDigest: observation.imageDigest,
			logicalBytes: observation.logicalBytes,
		}));
		await Promise.all(held.map(observation => observation.check()));
		const rawJoins = await Promise.allSettled(held.map(observation => observation.release()));
		const rawJoinFailures = rawJoins.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
		if (rawJoinFailures.length !== 0)
			throw new AggregateError(rawJoinFailures, "creator signing raw capture joined release failed", {cause: rawJoinFailures[0]});
		held.length = 0;
		// No original native view survives into pure row/QC/signature preparation.
		// The captured complete vectors are DATA only. Final acquisition below
		// must establish new actual custody and exact full-image correspondence.
		if (state.stopRequested || state.stopped) throw new TypeError("creator signing dependency owner is unavailable");
		// Only completed pure content verification is shared. Fresh nominal trust
		// resolution above binds EVERY material/context byte, rather than requiring
		// re-derived aliases to be the same capability object. Native metadata is
		// independently checked and cannot authorize a hit: each reused row must
		// have its COMPLETE original bytes/signatures and native incarnation.
		const rows = captured.flatMap((image) => image.rows);
		const verified: CreatorSigningImageContentFact[] = [];
		for (const image of captured) {
			if (verified.some((prior) => prior.incarnation === image.incarnation &&
				prior.rows.length === image.rows.length &&
				prior.rows.every((bytes, index) => compareBytes(bytes, image.rows[index]!) === 0))) continue;
			const previous = sameContentContext ? previousContent!.images.filter(prior => prior.incarnation === image.incarnation) : [];
			const content: CreatorSigningRowContentFact[] = [];
			const incarnation = image.incarnation;
			for (const bytes of image.rows) {
				// A control-only change or lawful removal/reordering of another row
				// does not change this immutable crypto tuple. Search only the SAME
				// bounded latest-success images; no historical row inventory accrues.
				let reused: CreatorSigningRowContentFact | undefined;
				for (const prior of previous) {
					const at = prior.rows.findIndex(raw => raw.byteLength === bytes.byteLength && compareBytes(raw, bytes) === 0);
					if (at !== -1) {reused = prior.content[at]; break;}
				}
				let carrierFact: CreatorSigningCarrierContentFact | undefined, peerFact: CreatorSigningPeerContentFact | undefined;
				const frame = decodeCanonical(bytes);
				if (!Array.isArray(frame) || frame.length !== 3 || typeof frame[0] !== "string")
					throw new TypeError("DURABLE_EVIDENCE_INVALID");
				const [name, key, row] = frame;
				if (name === "storageMeta") {content.push(Object.freeze({})); continue;} // Original native metadata validation remains fresh.
				if (
					!Array.isArray(key) ||
					!plainRecord(row) ||
					key[0] !== current.objectId ||
					row.objectId !== key[0] ||
					row.epoch !== key[1] ||
					row.signerId !== key[key.length - 1]
				)
					throw new TypeError("DURABLE_EVIDENCE_INVALID");
				const { authority, trust } = authorityFor(row.epoch, row.signerId);
				const identity = resolveSealAuthorityIdentity(authority);
				if (identity === undefined) throw new TypeError("DURABLE_EVIDENCE_INVALID");
				if (name === "signerState") {
					if (row.anchor !== identity.anchor) throw new TypeError("DURABLE_EVIDENCE_INVALID");
					const highest = plainRecord(row.highestPrepareQC) ? row.highestPrepareQC : null;
					const finalized = plainRecord(row.finalizedCommitQC) ? row.finalizedCommitQC : null;
					const snapshot = reused === undefined ? verifySealRecoverySnapshot(authority, incarnation, {
						incarnation,
						revision: row.revision,
						enteredRound: row.enteredRound,
						highestPrepareQcBytes: highest?.exactCanonicalQcBytes ?? null,
						highestPrepareQcDigest: highest?.digest ?? null,
						lockedValueDigest: row.lockedValueDigest,
						finalizedCommitQcBytes: finalized?.exactCanonicalQcBytes ?? null,
						finalizedValueDigest: row.finalizedValueDigest,
					}) : {ok: true as const};
					if (!snapshot.ok) throw new TypeError(snapshot.reason);
				} else if (name === "voteSlots" || name === "voteOutbox") {
					if (
						!plainRecord(row.carrier) ||
						key[2] !== row.round ||
						key[3] !== row.phase ||
						(name === "voteOutbox" && typeof row.dispatched !== "boolean")
					)
						throw new TypeError("DURABLE_EVIDENCE_INVALID");
					const carrier = row.carrier;
					const verified = reused?.carrier ?? (
						row.phase === "round-change"
							? verifyRoundChange({
									authority,
									exactCanonicalRoundChangeBytes: carrier.exactCanonicalPreimageBytes as Uint8Array,
									signature: carrier.signature as Uint8Array,
								})
							: verifySealVoteCarrier({
									authority,
									exactCanonicalPreimageBytes: carrier.exactCanonicalPreimageBytes as Uint8Array,
									signature: carrier.signature as Uint8Array,
								}));
					if (
						!verified.ok ||
						verified.signerId !== row.signerId ||
						verified.round !== row.round ||
						("phase" in verified && verified.phase !== row.phase)
					)
						throw new TypeError("DURABLE_CARRIER_INVALID");
					// Keep only verifier fields actually consumed by the ORIGINAL
					// caller; those same output/row comparisons execute on every hit.
					if ("phase" in verified) {
						if (verified.phase !== "prepare" && verified.phase !== "commit") throw new TypeError("DURABLE_CARRIER_INVALID");
						carrierFact = Object.freeze({ok: true as const, signerId: verified.signerId, round: verified.round,
							phase: verified.phase});
					} else carrierFact = Object.freeze({ok: true as const, signerId: verified.signerId, round: verified.round});
				} else if (name === "sealEvidence") {
					if (row.exactCanonicalCutValueBytes !== undefined) {
						const own = row as unknown as CreatorCloseEvidenceRecord;
						const opened = openSealAuthority({ trust, signerPublicKey: own.signerPublicKey });
						if (
							!opened.ok ||
							opened.signerId !== row.signerId ||
							own.storageIncarnation !== incarnation ||
							![
								"commit-qc-committed",
								"commit-vote-pending",
								"commit-voted",
								"evidence-committed",
								"finalized",
								"prepare-voted",
								"prepared",
							].includes(own.phase) ||
							!Number.isSafeInteger(own.revision) ||
							own.revision < 0
						)
							throw new TypeError("DURABLE_EVIDENCE_INVALID");
						const reason = reused === undefined ? recoveryEvidenceFailure(opened.authority, trust, own) : undefined;
						if (reason !== undefined) throw new TypeError(reason);
					}
					if (row.peerEvidence !== undefined) {
						if (!plainRecord(row.peerEvidence) || !plainRecord(row.peerEvidence.carrier))
							throw new TypeError("DURABLE_EVIDENCE_INVALID");
						const peer = row.peerEvidence;
						const carrier = peer.carrier as Readonly<Record<string, unknown>>;
						const verified = reused?.peer ?? verifySealVoteCarrier({
							authority,
							exactCanonicalPreimageBytes: carrier.exactCanonicalPreimageBytes as Uint8Array,
							signature: carrier.signature as Uint8Array,
						});
						if (
							peer.kind !== "drp-creator-seal-evidence" ||
							!verified.ok ||
							verified.phase !== "commit" ||
							verified.signerId !== row.signerId
						)
							throw new TypeError("DURABLE_CARRIER_INVALID");
						peerFact = Object.freeze({ok: true as const, signerId: verified.signerId, round: verified.round,
							phase: verified.phase, valueDigest: verified.valueDigest});
						const reason = reused === undefined ? recoveryEvidenceFailure(authority, trust, {
							...row,
							anchor: identity.anchor,
							phase: "finalized",
							valueDigest: verified.valueDigest,
							exactCanonicalPrepareQcBytes: null,
							exactCanonicalCutValueBytes: peer.exactCanonicalCutValueBytes,
							exactCanonicalCommitQcBytes: peer.exactCanonicalCommitQcBytes,
							exactCanonicalTrustStateRecordBytes: peer.exactCanonicalTrustStateRecordBytes,
							} as unknown as CreatorCloseEvidenceRecord) : undefined;
						const opened = openSealAuthority({ trust, signerPublicKey: peer.signerPublicKey });
						if (reason !== undefined || !opened.ok || opened.signerId !== row.signerId)
							throw new TypeError(reason ?? "SIGNER_NOT_AUTHORIZED");
					}
					if (row.exactCanonicalCutValueBytes === undefined && row.peerEvidence === undefined)
						throw new TypeError("DURABLE_EVIDENCE_INVALID");
				} else throw new TypeError("UNCLASSIFIED_SIGNING_DEPENDENCY");
				content.push(Object.freeze({...(carrierFact === undefined ? {} : {carrier: carrierFact}),
					...(peerFact === undefined ? {} : {peer: peerFact})}));
			}
			verified.push(Object.freeze({rows: image.rows, incarnation: image.incarnation, content: Object.freeze(content)}));
		}
		// Internal DATA consumer runs inside this SAME capture/authentication
		// invocation, after BOTH raw native joins and before ANY new custody.
		// Original captured rows/controls/incarnations stay private and qualify
		// completely afterwards, including identical bytes in a new incarnation.
		if (prepareData !== undefined) await prepareData(Object.freeze({rows: Object.freeze(rows.map(bytes => bytes.slice()))}));
		if (state.stopRequested || state.stopped) throw new TypeError("creator signing dependency owner is unavailable");
		// Reacquire the ORIGINAL native producers, not a copied reservation or a
		// revived read. Full controls include incarnation and all progress; row
		// equality checks every actual byte, not only a head/key/image digest.
		held.push(await acquireVote({objectId: current.objectId}));
		held.push(await acquireEvidence({objectId: current.objectId}));
		for (const [index, observation] of held.entries()) {
			const original = captured[index]!;
			const actual = observation.readExactCanonicalRows();
			if (!sameData(observation.control, original.control) || observation.control.incarnation !== original.incarnation ||
				observation.imageDigest !== original.imageDigest || observation.logicalBytes !== original.logicalBytes ||
				actual.length !== original.rows.length || !actual.every((bytes, row) => compareBytes(bytes, original.rows[row]!) === 0))
				throw new TypeError("creator signing dependency capture is stale");
		}
		const contextCurrent = (): boolean => state.currentTrust === contextTrust && state.storageIncarnation === contextIncarnation &&
			sameData(resolveSealRecoveryTrust(state.currentTrust as CurrentAnchorTrust), current) &&
			authenticatedMaterials.every(({trust, material}) => sameData(resolveSealRecoveryTrust(trust), material));
		if (!contextCurrent())
			throw new TypeError("creator signing dependency authority changed during preparation");
		await Promise.all(held.map((observation) => observation.check()));
		if (state.stopRequested || state.stopped) throw new TypeError("creator signing dependency owner is unavailable");
		if (!contextCurrent()) throw new TypeError("creator signing dependency authority changed during qualification");
		if (exactContextBytes !== undefined && state.signingContentAttempt === contentAttempt) state.signingContentFacts = Object.freeze({
			exactContextBytes, images: Object.freeze(verified)});
		let live = true;
		let releaseTask: Promise<void> | undefined;
		const pending = new Set<Promise<void>>();
		const child: CreatorSigningDependencyRead = Object.freeze({
			dependencyAnchors: Object.freeze(
				authenticatedMaterials.map(({ material }) =>
					Object.freeze({ epoch: material.currentEpoch, anchorDigest: material.currentAnchorDigest })
				)
			),
			readExactCanonicalRows: function () {
				if (this !== child || !live || state.stopRequested)
					throw new TypeError("creator signing dependency read is unavailable");
				return Object.freeze(rows.map((bytes) => Uint8Array.from(bytes)));
			},
			checkWhile: function (read: () => Promise<void>) {
				if (this !== child || !live || state.stopRequested || typeof read !== "function")
					return Promise.reject(new TypeError("creator signing dependency read is unavailable"));
				const task = (async (): Promise<void> => {
					await Promise.all(held.map((observation) => observation.check()));
					await read();
					await Promise.all(held.map((observation) => observation.check()));
				})();
				pending.add(task);
				void task.then(
					() => pending.delete(task),
					() => { invalidateCreatorSigningContentFacts(state); pending.delete(task); }
				);
				return task;
			},
			release: function () {
				if (this !== child) return Promise.reject(new TypeError("creator signing dependency read is foreign"));
				if (releaseTask !== undefined) return releaseTask;
				live = false;
				releaseTask = (async (): Promise<void> => {
					const checks = await Promise.allSettled([...pending]);
					const releases = await Promise.allSettled(held.map((observation) => observation.release()));
					state.dependencyReads.delete(child);
					const errors = [...checks, ...releases].flatMap((outcome) =>
						outcome.status === "rejected" ? [outcome.reason] : []
					);
					if (errors.length !== 0) {
						invalidateCreatorSigningContentFacts(state);
						throw new AggregateError(errors, "creator signing dependency release failed", { cause: errors[0] });
					}
				})();
				return releaseTask;
			},
		});
		state.dependencyReads.add(child);
		return child;
	} catch (error) {
		invalidateCreatorSigningContentFacts(state);
		primary = error;
		failed = true;
	} finally {
		signerAuthorities.clear();
	}
	if (failed) {
		const releases = await Promise.allSettled(held.map((observation) => observation.release()));
		const errors = releases.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
		if (errors.length !== 0)
			throw new AggregateError([primary, ...errors], "creator signing dependency acquisition failed", {
				cause: primary,
			});
		throw primary;
	}
	throw new TypeError("creator signing dependency acquisition did not complete");
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
	if (state.signer === undefined) return "SIGNING_OWNER_UNAVAILABLE";
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
		if (state.signer === undefined) return failure("SIGNING_OWNER_UNAVAILABLE");
		if (!plainRecord(input) || Reflect.ownKeys(input).length !== 1 || !plainRecord(input.closeInput)) {
			return failure("MALFORMED_INPUT");
		}
		if (input.closeInput.currentTrust !== state.currentTrust) return failure("UNTRUSTED_CURRENT_ANCHOR");
		const promotion = Object.hasOwn(input.closeInput, "forwardPromotion");
		const preparedClose = promotion
			? prepareCreatorForwardPromotion(input.closeInput)
			: prepareCreatorClose(input.closeInput);
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
			const successor =
				"promotion" in preparedClose
					? prepareCreatorForwardPromotionSuccessor({
							authority,
							promotion: preparedClose.promotion,
							exactCanonicalCommitQcBytes: commitQcBytes,
						})
					: prepareCreatorSuccessor({
							authority,
							close: preparedClose.close,
							exactCanonicalCommitQcBytes: commitQcBytes,
						});
			if (!successor.ok) return failure(successor.reason);
			const signingIdentity = resolveSealAuthorityIdentity(authority);
			if (signingIdentity === undefined) return failure("UNTRUSTED_CREATOR_ACTOR");
			bindCreatorAnchorSigningRequest(
				successor.signingRequest,
				nativeSigningAdmissionFactory(
					state.voteStore,
					mintSealVoterEnrollment({ ...signingIdentity, expectedIncarnation: state.storageIncarnation })
				)
			);
			const signature = await signCreatorAnchorRequest({ request: successor.signingRequest, signer: state.signer });
			const completed = (promotion ? completeCreatorForwardPromotionSuccessor : completeCreatorSuccessor)({
				detachedSignature: signature,
				preparation: successor.preparation,
			});
			if (!completed.ok) return failure(completed.reason);
			trustBytes = completed.exactCanonicalTrustStateRecordBytes;
			record = nextRecord(record, { commitQcBytes, phase: "finalized", prepareQcBytes, revision: 4, trustBytes });
			const evidenceFailure = await persistEvidence(state, record, state.evidenceRecord?.phase ?? null);
			if (evidenceFailure !== undefined) return failure(evidenceFailure);
			emit(state, "successor_completed");
		}

		const reopened = (promotion ? openCreatorForwardPromotionSuccessorTrust : openCreatorSuccessorTrust)({
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
	} catch (cause) {
		if (cause instanceof SigningAdmissionRefusal) return failure(cause.reason);
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
	return createCreatorNativeActor(input, false);
}

/** Opens real native signing stores for received recovery without inventing a
 * finality signer. Unknown/foreign rows still fail the original dependency read;
 * factories alone never establish retirement eligibility. */
export async function createCreatorSigningRecoveryOwner(
	input: Readonly<{
		currentTrust: CurrentAnchorTrust;
		evidenceStore: unknown;
		storageIncarnation: string;
		voteStore: SealStorePort;
	}>
): Promise<Readonly<{owner: CreatorSigningRecoveryOwner; ok: true} | {ok: false; reason: string}>> {
	if (!plainRecord(input) || Reflect.ownKeys(input).length !== 4) return failure("MALFORMED_INPUT");
	if (resolveSealRecoveryTrust(input.currentTrust) === undefined) return failure("UNTRUSTED_CURRENT_ANCHOR");
	if (resolveSealStorePort(input.voteStore) === undefined) return failure("UNTRUSTED_VOTE_STORE");
	const opened = await createCreatorNativeActor({...input, signer: undefined, onObservation: () => undefined}, true);
	if (!opened.ok) return opened;
	const actor = opened.actor;
	const owner: CreatorSigningRecoveryOwner = Object.freeze({
		acquireRecoveryDependencies: actor.acquireRecoveryDependencies.bind(actor),
		captureRetirementOwners: actor.captureRetirementOwners.bind(actor),
		stop: actor.stop.bind(actor),
	});
	signingRecoveryOwners.set(owner, actor);
	return Object.freeze({ok: true, owner});
}

/** Resolves only original live custody for the exact genuine trust identity.
 * Copied methods or structural empty-row providers cannot enter a received hold. */
export function resolveCreatorSigningRecoveryOwner(
	value: unknown,
	trust: CurrentAnchorTrust
): CreatorSigningRecoveryOwner | undefined {
	const actor = value !== null && typeof value === "object" ? signingRecoveryOwners.get(value as CreatorSigningRecoveryOwner) : undefined;
	const state = actor === undefined ? undefined : actorStates.get(actor);
	return state === undefined || state.stopRequested || state.stopped || state.currentTrust !== trust ? undefined :
		value as CreatorSigningRecoveryOwner;
}

/** Internal bounded proof-DATA consumer; no observation, check/release or
 * signing/retirement authority crosses the preparation boundary. */
export type CreatorSigningDependencyPreparation = (data: Readonly<{rows: readonly Uint8Array[]}>) => Promise<void>;

/** Same original actor task lifecycle and native source qualifier as the public
 * acquisition; this internal subpath adds only a method-free DATA interval. */
export function acquireCreatorSigningDependenciesForPreparation(
	owner: CreatorActor | CreatorSigningRecoveryOwner,
	trusts: readonly CurrentAnchorTrust[],
	prepareData: CreatorSigningDependencyPreparation
): Promise<CreatorSigningDependencyRead> {
	const actor = actorStates.has(owner as CreatorActor) ? owner as CreatorActor : signingRecoveryOwners.get(owner as CreatorSigningRecoveryOwner);
	const state = actor === undefined ? undefined : actorStates.get(actor);
	if (state === undefined || state.stopRequested || state.stopped || typeof prepareData !== "function")
		return Promise.reject(new TypeError("creator signing dependency owner is unavailable"));
	return enterSigningDependencyTask(state, trusts, prepareData);
}

function enterSigningDependencyTask(state: ActorState, trusts: readonly CurrentAnchorTrust[],
	prepareData?: CreatorSigningDependencyPreparation): Promise<CreatorSigningDependencyRead> {
	const task = acquireSigningDependencies(state, trusts, prepareData);
	state.dependencyTasks.add(task);
	void task.then(() => state.dependencyTasks.delete(task), () => state.dependencyTasks.delete(task));
	return task;
}

/** One implementation owns native recovery rows for both genuine origins. */
async function createCreatorNativeActor(
	input: Readonly<{
		currentTrust: unknown;
		evidenceStore: unknown;
		onObservation(event: Readonly<Record<string, unknown>>): void;
		signer: FinalitySigner | undefined;
		storageIncarnation: string;
		voteStore: SealStorePort;
	}>,
	recoveryOnly: boolean
): Promise<Readonly<{actor: CreatorActor; ok: true} | {ok: false; reason: string}>> {
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
			dependencyTasks: new Set(),
			dependencyReads: new Set(),
			retirementReads: new Set(),
			activeTask: null,
			authority: null,
			currentTrust: input.currentTrust,
			evidence,
			evidenceStore: input.evidenceStore,
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
		if (record !== null && !recoveryOnly) {
			const voterFailure = await openVoter(state, record.signerPublicKey, record.signerId);
			if (voterFailure !== undefined) return failure(voterFailure);
			const authority = state.authority;
			if (authority === null) return failure("DURABLE_QC_INVALID");
			const recoveryFailure = recoveryEvidenceFailure(authority, input.currentTrust as CurrentAnchorTrust, record);
			if (recoveryFailure !== undefined) return failure(recoveryFailure);
			const revision = state.voter?.status().revision ?? 0;
			if (record.revision > revision || revision - record.revision > 1) state.terminalReason = "AMBIGUOUS_OUTCOME";
			if (record.phase === "finalized") state.phase = "finalized";
		}
		const actor: CreatorActor = Object.freeze({
			captureRetirementOwners(this: CreatorActor): CreatorSigningRetirementOwners {
				const owned = actorStates.get(this);
				const current =
					owned === undefined ? undefined : resolveSealRecoveryTrust(owned.currentTrust as CurrentAnchorTrust);
				if (owned === undefined || current === undefined || owned.stopRequested || owned.stopped)
					throw new TypeError("creator signing retirement owner is unavailable");
				const vote = resolveSealStorePort(owned.voteStore);
				const voteAcquire = (owned.signer === undefined ? vote?.acquireRecoveryRetirementObservation :
					vote?.acquireRetirementObservation)?.bind(vote);
				const evidenceAcquire = (owned.signer === undefined ? owned.evidence.acquireRecoveryRetirementObservation :
					owned.evidence.acquireRetirementObservation)?.bind(owned.evidence);
				if (voteAcquire === undefined || evidenceAcquire === undefined)
					throw new TypeError("native signing retirement is unsupported");
				const scope = Object.freeze({ objectId: current.objectId });
				const acquire = (original: typeof voteAcquire): Promise<SigningRetirementObservation> => {
					if (owned.stopRequested || owned.stopped)
						return Promise.reject(new TypeError("creator signing retirement owner is unavailable"));
					const task = (async (): Promise<SigningRetirementObservation> => {
						const read = await original(scope);
						try {
							await read.check();
							if (owned.stopRequested || owned.stopped)
								throw new TypeError("creator signing retirement owner is unavailable");
						} catch (primary) {
							try {
								await read.release();
							} catch (cleanup) {
								throw new AggregateError([primary, cleanup], "creator retirement acquisition cleanup failed", {
									cause: primary,
								});
							}
							throw primary;
						}
						// Native views own their one-use CAS and admitted operation join.
						// The original actor additionally invalidates/releases every view
						// on stop, without pretending to cancel entered signing execution.
						owned.retirementReads.add(read);
						const release = read.release.bind(read);
						let releaseTask: Promise<void> | undefined;
						return Object.freeze({
							control: read.control,
							imageDigest: read.imageDigest,
							logicalBytes: read.logicalBytes,
							readExactCanonicalRows: read.readExactCanonicalRows.bind(read),
							...(read.readRetirementDataImage === undefined ? {} : {
								readRetirementDataImage: read.readRetirementDataImage.bind(read),
							}),
							check: read.check.bind(read),
							checkSigningScope: read.checkSigningScope.bind(read),
							prepareFence: read.prepareFence.bind(read),
							abortPrepared: read.abortPrepared.bind(read),
							commitPrepared: read.commitPrepared.bind(read),
							beginEvidenceDrain: read.beginEvidenceDrain.bind(read),
							beginSummaryDrain: read.beginSummaryDrain.bind(read),
							drainEvidenceBatch: read.drainEvidenceBatch.bind(read),
							release: (): Promise<void> => {
								releaseTask ??= release().finally(() => owned.retirementReads.delete(read));
								return releaseTask;
							},
						});
					})();
					owned.dependencyTasks.add(task);
					void task.then(
						() => owned.dependencyTasks.delete(task),
						() => owned.dependencyTasks.delete(task)
					);
					return task;
				};
				const recovery = owned.signer === undefined;
				return Object.freeze({
					acquireVote: () => acquire(voteAcquire),
					acquireEvidence: () => acquire(evidenceAcquire),
					// Slice 14a: the same gate, check and actor tracking; only the native
					// view comes from the caller's room retirement session.
					acquireVoteIn: (session: CreatorSigningSessionAcquire) =>
						acquire((input) => session(owned.voteStore, input, recovery)),
					acquireEvidenceIn: (session: CreatorSigningSessionAcquire) =>
						acquire((input) => session(owned.evidenceStore, input, recovery)),
				});
			},
			acquireRecoveryDependencies(this: CreatorActor, trusts: readonly CurrentAnchorTrust[]) {
				const owned = actorStates.get(this);
				if (owned === undefined || owned.stopRequested || owned.stopped)
					return Promise.reject(new TypeError("creator signing dependency owner is unavailable"));
				return enterSigningDependencyTask(owned, trusts);
			},
			close(this: CreatorActor, closeInput: Readonly<{ closeInput: Readonly<Record<string, unknown>> }>) {
				const owned = actorStates.get(this);
				if (owned === undefined) return Promise.resolve(failure("UNTRUSTED_CREATOR_ACTOR"));
				if (owned.signer === undefined) return Promise.resolve(failure("SIGNING_OWNER_UNAVAILABLE"));
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
				invalidateCreatorSigningContentFacts(owned);
				const outcomes = await Promise.allSettled([
					...(owned.activeTask === null ? [] : [owned.activeTask]),
					...owned.dependencyTasks,
					...[...owned.dependencyReads].map((read) => read.release()),
					...[...owned.retirementReads].map((read) => read.release()),
				]);
				owned.stopped = true;
				const errors = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
				if (errors.length !== 0)
					throw new AggregateError(errors, "creator signing dependency stop failed", { cause: errors[0] });
			},
		});
		actorStates.set(actor, state);
		return Object.freeze({ actor, ok: true as const });
	} catch {
		return failure("DURABLE_EVIDENCE_INVALID");
	}
}
