import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	SigningAdmissionRefusal,
	type SigningNativeAdmissionFactory,
} from "@ts-drp/protocol-v3/internal/seal-signing-request";

import type { ExactSealCarrier } from "../index.js";

export interface SealVoteIntentData {
	readonly anchor: string;
	readonly carrier: ExactSealCarrier;
	readonly epoch: number;
	readonly expectedIncarnation: string;
	readonly expectedRevision: number;
	readonly objectId: string;
	readonly phase: "commit" | "prepare";
	readonly prepareQC: Readonly<{ digest: string; round: number; valueDigest: string }> | null;
	readonly round: number;
	readonly signerId: string;
	readonly valueDigest: string;
}

export interface SealRoundChangeIntentData {
	readonly anchor: string;
	readonly carrier: ExactSealCarrier;
	readonly epoch: number;
	readonly expectedIncarnation: string;
	readonly expectedRevision: number;
	readonly highestPrepareQcBytes: Uint8Array | null;
	readonly objectId: string;
	readonly round: number;
	readonly signerId: string;
}

export interface SealVoterEnrollmentData {
	readonly anchor: string;
	readonly epoch: number;
	readonly expectedIncarnation: string;
	readonly objectId: string;
	readonly signerId: string;
}

/** Authenticated same-epoch detail selection; native enforcement remains store-local. */
export interface SealDetailRetirementIntentData extends SealVoterEnrollmentData {
	readonly expectedRevision: number;
	readonly imageDigest: string;
	readonly retiredBeforeRound: number;
	readonly highestPrepareQcBytes: Uint8Array;
	readonly finalizedCommitQcBytes: Uint8Array | null;
}

export type SealDetailRetirementResult = Readonly<
	| { ok: false; reason: string }
	| { ok: true; revision: number; retiredBeforeRound: number; deletedRows: number; remaining: boolean }
>;

declare const sealStorePortBrand: unique symbol;
declare const sealVoterEnrollmentBrand: unique symbol;

export interface SealStorePort {
	readonly [sealStorePortBrand]: true;
}

export interface SealVoterEnrollment {
	readonly [sealVoterEnrollmentBrand]: true;
}

export interface SealStoreAdapter {
	acquireSigningDependencyObservation?(input: Readonly<{ objectId: string }>): Promise<SigningDependencyObservation>;
	acquireSigningAdmission?(enrollment: SealVoterEnrollment): Promise<SigningNativeRead>;
	acquireRetirementObservation?(input: Readonly<{ objectId: string }>): Promise<SigningRetirementObservation>;
	acquireRecoveryRetirementObservation?(input: Readonly<{ objectId: string }>): Promise<SigningRetirementObservation>;
	commitQc?(enrollment: SealVoterEnrollment, input: unknown): Promise<unknown>;
	commitRoundChange?(intent: object): Promise<unknown>;
	commitVote(intent: object): Promise<unknown>;
	retireDetails?(intent: object): Promise<SealDetailRetirementResult>;
	openSnapshot(enrollment: SealVoterEnrollment): Promise<unknown>;
}

const intentData = new WeakMap<object, SealVoteIntentData>();
const roundChangeIntentData = new WeakMap<object, SealRoundChangeIntentData>();
const detailRetirementIntentData = new WeakMap<object, SealDetailRetirementIntentData>();
const enrollmentData = new WeakMap<SealVoterEnrollment, SealVoterEnrollmentData>();
const storeAdapters = new WeakMap<SealStorePort, SealStoreAdapter>();
const voterPorts = new WeakSet<object>();

function copiedCarrier(carrier: ExactSealCarrier): ExactSealCarrier {
	return Object.freeze({
		exactCanonicalPreimageBytes: Uint8Array.from(carrier.exactCanonicalPreimageBytes),
		signature: Uint8Array.from(carrier.signature),
	});
}

function copiedPrepareQC(
	value: Readonly<{ digest: string; round: number; valueDigest: string }> | null
): Readonly<{ digest: string; round: number; valueDigest: string }> | null {
	return value === null ? null : Object.freeze({ ...value });
}

function copiedDetailRetirement(data: SealDetailRetirementIntentData): SealDetailRetirementIntentData {
	return Object.freeze({
		...data,
		highestPrepareQcBytes: Uint8Array.from(data.highestPrepareQcBytes),
		finalizedCommitQcBytes: data.finalizedCommitQcBytes === null ? null : Uint8Array.from(data.finalizedCommitQcBytes),
	});
}

/**
 * Captures one original voter's authenticated, destructive-use retirement transition.
 * @param data - Fresh verified snapshot and exact held native image commitment.
 * @returns Fieldless one-use intent, not a public eligibility grant.
 */
export function mintSealDetailRetirementIntent(data: SealDetailRetirementIntentData): object {
	const intent = Object.freeze({});
	detailRetirementIntentData.set(intent, copiedDetailRetirement(data));
	return intent;
}

/**
 * Consumes the original voter's intent at the native adapter boundary.
 * @param value - Candidate opaque intent.
 * @returns Detached selection or undefined for foreign/consumed input.
 */
export function consumeSealDetailRetirementIntent(value: unknown): SealDetailRetirementIntentData | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const captured = detailRetirementIntentData.get(value);
	if (captured === undefined) return undefined;
	detailRetirementIntentData.delete(value);
	return copiedDetailRetirement(captured);
}

/**
 * Mints one fieldless, destructive-use vote intent.
 * @param data - Fully validated voter transition.
 * @returns One-use opaque intent.
 */
export function mintSealVoteIntent(data: SealVoteIntentData): object {
	const captured = Object.freeze({
		...data,
		carrier: copiedCarrier(data.carrier),
		prepareQC: copiedPrepareQC(data.prepareQC),
	});
	const intent = Object.freeze({});
	intentData.set(intent, captured);
	return intent;
}

/**
 * Destructively resolves one genuine vote intent.
 * @param value - Candidate intent.
 * @returns Detached transition, or undefined for foreign/consumed input.
 */
export function consumeSealVoteIntent(value: unknown): SealVoteIntentData | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const captured = intentData.get(value);
	if (captured === undefined) return undefined;
	intentData.delete(value);
	return Object.freeze({
		...captured,
		carrier: copiedCarrier(captured.carrier),
		prepareQC: copiedPrepareQC(captured.prepareQC),
	});
}

/**
 * Mints one fieldless, destructive-use round-change intent.
 * @param data - Fully verified signed round-change transition.
 * @returns One-use opaque intent.
 */
export function mintSealRoundChangeIntent(data: SealRoundChangeIntentData): object {
	const captured = Object.freeze({
		...data,
		carrier: copiedCarrier(data.carrier),
		highestPrepareQcBytes: data.highestPrepareQcBytes === null ? null : Uint8Array.from(data.highestPrepareQcBytes),
	});
	const intent = Object.freeze({});
	roundChangeIntentData.set(intent, captured);
	return intent;
}

/**
 * Destructively resolves one genuine round-change intent.
 * @param value - Candidate intent.
 * @returns Detached transition, or undefined for foreign/consumed input.
 */
export function consumeSealRoundChangeIntent(value: unknown): SealRoundChangeIntentData | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const captured = roundChangeIntentData.get(value);
	if (captured === undefined) return undefined;
	roundChangeIntentData.delete(value);
	return Object.freeze({
		...captured,
		carrier: copiedCarrier(captured.carrier),
		highestPrepareQcBytes:
			captured.highestPrepareQcBytes === null ? null : Uint8Array.from(captured.highestPrepareQcBytes),
	});
}

/**
 * Mints fieldless voter enrollment from authenticated protocol identity.
 * @param data - Certified identity and expected storage incarnation.
 * @returns Opaque enrollment.
 */
export function mintSealVoterEnrollment(data: SealVoterEnrollmentData): SealVoterEnrollment {
	const enrollment = Object.freeze({}) as SealVoterEnrollment;
	enrollmentData.set(enrollment, Object.freeze({ ...data }));
	return enrollment;
}

/**
 * Resolves detached authenticated voter enrollment.
 * @param value - Candidate enrollment.
 * @returns Detached enrollment, or undefined for foreign input.
 */
export function resolveSealVoterEnrollment(value: unknown): SealVoterEnrollmentData | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const captured = enrollmentData.get(value as SealVoterEnrollment);
	return captured === undefined ? undefined : Object.freeze({ ...captured });
}

/**
 * Brands one package-internal mechanical adapter as the only store shape accepted by the voter.
 * @param adapter - Captured mechanical adapter.
 * @returns Fieldless branded store port.
 */
export function mintSealStorePort(adapter: SealStoreAdapter): SealStorePort {
	const port = Object.freeze({}) as SealStorePort;
	storeAdapters.set(
		port,
		Object.freeze({
			...(adapter.acquireSigningDependencyObservation === undefined
				? {}
				: { acquireSigningDependencyObservation: adapter.acquireSigningDependencyObservation.bind(adapter) }),
			...(adapter.acquireSigningAdmission === undefined
				? {}
				: { acquireSigningAdmission: adapter.acquireSigningAdmission.bind(adapter) }),
			...(adapter.acquireRetirementObservation === undefined
				? {}
				: { acquireRetirementObservation: adapter.acquireRetirementObservation.bind(adapter) }),
			...(adapter.acquireRecoveryRetirementObservation === undefined
				? {}
				: { acquireRecoveryRetirementObservation: adapter.acquireRecoveryRetirementObservation.bind(adapter) }),
			...(adapter.commitQc === undefined ? {} : { commitQc: adapter.commitQc.bind(adapter) }),
			...(adapter.commitRoundChange === undefined
				? {}
				: { commitRoundChange: adapter.commitRoundChange.bind(adapter) }),
			commitVote: adapter.commitVote.bind(adapter),
			...(adapter.retireDetails === undefined ? {} : { retireDetails: adapter.retireDetails.bind(adapter) }),
			openSnapshot: adapter.openSnapshot.bind(adapter),
		})
	);
	return port;
}

/** Mechanical native commitments, never authenticated retirement eligibility. */
export interface SigningRetirementPreparation {
	readonly throughEpoch: number;
	readonly protectedEpochs: readonly number[];
	readonly decisionDigest: string;
	readonly sourceProofDigest: string;
	/** v2 only: static compact source survives every metadata interruption prefix. */
	readonly summarySource?: SigningSummaryRetirementSource;
}
export interface SigningRetirementControl {
	readonly kind: "signing-retirement-control-1";
	readonly objectId: string;
	readonly incarnation: string;
	readonly revision: number;
	readonly sequence: number;
	readonly active: null | Readonly<{
		sequence: number;
		preparation: SigningRetirementPreparation;
		sourceImageDigest: string;
	}>;
	readonly completed: null | SigningRetirementPreparation;
	/** Compact native progress only; original private source owns eligibility. */
	readonly drain?: null | Readonly<{
		plan: SigningEvidenceRetirementPlan | SigningSummaryRetirementPlan;
		cursor: number;
		batches: number;
		remainingDataDigest: string;
	}>;
}
export interface SigningEvidenceRetirementEntry {
	readonly key: readonly [string, number, string];
	readonly revision: number;
	readonly frameDigest: string;
}
export interface SigningEvidenceRetirementPlan {
	readonly baseControl: SigningRetirementControl;
	readonly entries: readonly SigningEvidenceRetirementEntry[];
	readonly sourceDataDigest: string;
}

/** Exact native addresses only; the original close proof owns eligibility. */
export type SigningSummaryRetirementEntry = Readonly<{
	store: "signerState" | "voteSlots" | "voteOutbox";
	key: readonly [string, number, string] | readonly [string, number, number, string, string];
	frameDigest: string;
}>;

/** Compact v2 source decomposition; no discarded signing payload is retained. */
export interface SigningSummaryRetirementPlan {
	readonly kind: "signing-summary-retirement-plan-2";
	readonly baseControl: SigningRetirementControl;
	readonly entries: readonly SigningSummaryRetirementEntry[];
	readonly sourceDataDigest: string;
	readonly resumeBasisDigest: string;
	readonly eligibilityFence: Pick<
		SigningRetirementPreparation,
		"throughEpoch" | "protectedEpochs" | "decisionDigest" | "sourceProofDigest"
	>;
}

export type SigningSummaryRetirementSource = Pick<
	SigningSummaryRetirementPlan,
	"entries" | "sourceDataDigest" | "resumeBasisDigest" | "eligibilityFence"
>;

/**
 * Native manifest order: every slot/outbox precedes every safety summary.
 * @param a - First captured native descriptor.
 * @param b - Second captured native descriptor.
 * @returns Native address order with summaries last.
 */
export function compareSigningSummaryRetirementEntries(
	a: SigningSummaryRetirementEntry,
	b: SigningSummaryRetirementEntry
): number {
	const order = ["voteSlots", "voteOutbox", "signerState"];
	const store = order.indexOf(a.store) - order.indexOf(b.store);
	if (store !== 0) return store;
	for (let index = 0; index < a.key.length; index++) {
		const left = a.key[index],
			right = b.key[index];
		if (left === undefined || right === undefined) throw new TypeError("INVALID_SIGNING_SUMMARY_ADDRESS");
		if (left !== right) return left < right ? -1 : 1;
	}
	return 0;
}

/**
 * Discriminates the native format, never authenticates a deletion grant.
 * @param plan - Mechanically captured native manifest.
 * @returns Whether the original manifest has the summary format.
 */
export function isSigningSummaryRetirementPlan(
	plan: SigningEvidenceRetirementPlan | SigningSummaryRetirementPlan
): plan is SigningSummaryRetirementPlan {
	return "kind" in plan && plan.kind === "signing-summary-retirement-plan-2";
}

/** Shared fixed native point-delete bound, not an eligibility predicate. */
export const SIGNING_DETAIL_RETIREMENT_BATCH_ROWS = 16;

const signingFrameLimits = { maxBytes: 262_144, maxItems: 65_536, maxDepth: 128 };

/**
 * Original metadata field transition; the native parser still owns all guards.
 * @param old - Original native control fields.
 * @param kind - Existing prepare, abort or commit transition.
 * @param preparation - Original preparation or private length leaf.
 * @param sourceImageDigest - Original image commitment or private length leaf.
 * @returns Original field shape, still requiring the native strict parser.
 */
export function signingRetirementMetadataFields(
	old: Readonly<{
		revision: number;
		sequence: number;
		active: null | Readonly<{ preparation: unknown }>;
		completed: unknown;
	}>,
	kind: "prepare" | "abort" | "commit",
	preparation: unknown,
	sourceImageDigest: unknown
): Readonly<Record<string, unknown> & { revision: number; sequence: number }> {
	const { drain: _previousDrain, ...cleanOld } = old as typeof old & { drain?: unknown };
	return {
		...(kind === "commit" ? cleanOld : old),
		revision: old.revision + 1,
		sequence: kind === "prepare" ? old.sequence + 1 : old.sequence,
		active: kind === "prepare" ? { sequence: old.sequence + 1, preparation, sourceImageDigest } : null,
		completed: kind === "commit" ? old.active?.preparation : old.completed,
	};
}

/**
 * Original compact drain field transition; not a deletion grant.
 * @param old - Original preceding control fields.
 * @param plan - Original plan or private length leaf.
 * @param cursor - Original bounded row cursor.
 * @param batches - Original nonempty batch count.
 * @param remainingDataDigest - Original residual commitment or private length leaf.
 * @returns Original compact progress shape, still requiring native guards.
 */
export function signingRetirementDrainFields<T extends Readonly<{ revision: number }>>(
	old: T,
	plan: unknown,
	cursor: number,
	batches: number,
	remainingDataDigest: unknown
): Readonly<
	T & { revision: number; drain: { plan: unknown; cursor: number; batches: number; remainingDataDigest: unknown } }
> {
	return { ...old, revision: old.revision + 1, drain: { plan, cursor, batches, remainingDataDigest } };
}

/**
 * Original addressed storage metadata row, not control authority.
 * @param objectId - Original native addressed object.
 * @param value - Original control fields or private length tree.
 * @returns Original native key/value wrapper.
 */
export function signingRetirementStorageMetaRow<T>(objectId: string, value: T): Readonly<{ key: string; value: T }> {
	return { key: `signing-retirement:${objectId}`, value };
}

/** Lengths only: source bytes remain the original caller's exact codec premise. */
export interface SigningRetirementPrefixWidthInput {
	readonly preparationBytes: number;
	readonly drain?:
		| Readonly<{ kind: "evidence"; entriesBytes: number; entryCount: number }>
		| Readonly<{ kind: "summary"; sourceBytes: number; entryCount: number }>;
}
export interface SigningRetirementControlWidth {
	readonly revision: number;
	readonly sequence: number;
	readonly controlBytes: number;
	/** Present-row frame; native metadata absence is separately captured by the caller. */
	readonly storageMetaFrameBytes: number;
	readonly cursor?: number;
	readonly batches?: number;
}

/**
 * Measures original control prefixes without constructing future identities or grants.
 * Unknown encoded leaves are private arithmetic tokens, never canonical bytes.
 * @param old - Actual original inactive native control, including its real incarnation.
 * @param input - Exact original preparation/source encoding lengths and descriptor count.
 * @returns Bounded prefix widths; actual absent metadata is not a born control row.
 */
export function signingRetirementPrefixWidths(
	old: SigningRetirementControl,
	input: SigningRetirementPrefixWidthInput
): Readonly<{
	old: SigningRetirementControlWidth;
	prepared: SigningRetirementControlWidth;
	aborted: SigningRetirementControlWidth;
	completed: SigningRetirementControlWidth;
	drainPrefixes: readonly SigningRetirementControlWidth[];
}> {
	const limit = signingFrameLimits.maxBytes;
	const length = (value: number): number => {
		if (!Number.isSafeInteger(value) || value < 1 || value > limit) throw new TypeError("INVALID_SIGNING_PREFIX_WIDTH");
		return value;
	};
	const varuint = (value: number): number => {
		let count = 1;
		while (value >= 128) {
			value = Math.floor(value / 128);
			count++;
		}
		return count;
	};
	const leaves = new WeakMap<object, number>();
	const leaf = (bytes: number): object => {
		const token = Object.freeze({});
		leaves.set(token, length(bytes));
		return token;
	};
	const width = (value: unknown, depth = 0): number => {
		if (depth > 128) throw new TypeError("INVALID_SIGNING_PREFIX_DEPTH");
		if (value !== null && typeof value === "object") {
			const opaque = leaves.get(value);
			if (opaque !== undefined) return opaque;
			if (Array.isArray(value)) {
				if (value.length > signingFrameLimits.maxItems) throw new TypeError("INVALID_SIGNING_PREFIX_COUNT");
				return length(1 + varuint(value.length) + value.reduce((sum, item) => sum + width(item, depth + 1), 0));
			}
			if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
				const entries = Object.entries(Object.getOwnPropertyDescriptors(value)).filter(([, d]) => d.enumerable);
				if (entries.length > signingFrameLimits.maxItems || Object.getOwnPropertySymbols(value).length !== 0)
					throw new TypeError("INVALID_SIGNING_PREFIX_RECORD");
				return length(
					1 +
						varuint(entries.length) +
						entries.reduce((sum, [key, d]) => {
							if (!Object.hasOwn(d, "value")) throw new TypeError("INVALID_SIGNING_PREFIX_ACCESSOR");
							return sum + encodeCanonical(key, signingFrameLimits).byteLength + width(d.value, depth + 1);
						}, 0)
				);
			}
		}
		return encodeCanonical(value, signingFrameLimits).byteLength;
	};
	if (old.active !== null || !Number.isSafeInteger(old.revision + 2) || old.sequence === Number.MAX_SAFE_INTEGER)
		throw new TypeError("UNSUPPORTED_SIGNING_PREFIX_CONTROL");
	const prior = old.drain;
	if (prior != null && prior.cursor !== prior.plan.entries.length) throw new TypeError("UNJOINED_SIGNING_PREFIX_DRAIN");
	if (
		old.completed?.summarySource !== undefined &&
		(prior == null ||
			!isSigningSummaryRetirementPlan(prior.plan) ||
			compareBytes(
				encodeCanonical(prior.plan.baseControl.completed, signingFrameLimits),
				encodeCanonical(old.completed, signingFrameLimits)
			) !== 0)
	)
		throw new TypeError("UNJOINED_SIGNING_PREFIX_SUMMARY");
	const prep = leaf(input.preparationBytes);
	// Canonical STRING64 has tag+varuint(64)+64 payload bytes. No digest is minted.
	const digest = leaf(1 + varuint(64) + 64);
	const prepared = signingRetirementMetadataFields(old, "prepare", prep, digest);
	const completed = signingRetirementMetadataFields(
		{ ...old, revision: old.revision + 1, sequence: old.sequence + 1, active: { preparation: prep } },
		"commit",
		undefined,
		undefined
	);
	const aborted = signingRetirementMetadataFields(
		{ ...old, revision: old.revision + 1, sequence: old.sequence + 1, active: { preparation: prep } },
		"abort",
		undefined,
		undefined
	);
	const frame = (
		value: unknown,
		revision: number,
		sequence: number,
		cursor?: number,
		batches?: number
	): SigningRetirementControlWidth => {
		if ((cursor === undefined) !== (batches === undefined)) throw new TypeError("INVALID_SIGNING_PREFIX_CURSOR");
		const controlBytes = width(value);
		const row = signingRetirementStorageMetaRow(old.objectId, value);
		return Object.freeze({
			revision,
			sequence,
			controlBytes,
			storageMetaFrameBytes: width(["storageMeta", row.key, row]),
			...(cursor === undefined ? {} : { cursor }),
			...(batches === undefined ? {} : { batches }),
		});
	};
	const preparedWidth = frame(prepared, old.revision + 1, old.sequence + 1, prior?.cursor, prior?.batches);
	const completedWidth = frame(completed, old.revision + 2, old.sequence + 1);
	const drainPrefixes: SigningRetirementControlWidth[] = [];
	if (input.drain !== undefined) {
		const count = input.drain.entryCount;
		if (!Number.isSafeInteger(count) || count < 1 || count > signingFrameLimits.maxItems)
			throw new TypeError("INVALID_SIGNING_PREFIX_COUNT");
		const planBytes =
			input.drain.kind === "evidence"
				? width({ baseControl: completed, entries: leaf(input.drain.entriesBytes), sourceDataDigest: digest })
				: length(
						length(input.drain.sourceBytes) +
							completedWidth.controlBytes +
							encodeCanonical("baseControl", signingFrameLimits).byteLength +
							encodeCanonical("kind", signingFrameLimits).byteLength +
							encodeCanonical("signing-summary-retirement-plan-2", signingFrameLimits).byteLength +
							varuint(6) -
							varuint(4)
					);
		const plan = leaf(planBytes);
		let current = completed;
		for (let batches = 0; batches <= Math.ceil(count / SIGNING_DETAIL_RETIREMENT_BATCH_ROWS); batches++) {
			const cursor = Math.min(batches * SIGNING_DETAIL_RETIREMENT_BATCH_ROWS, count);
			if (old.revision + 3 + batches > Number.MAX_SAFE_INTEGER) throw new TypeError("SIGNING_REVISION_EXHAUSTED");
			current = signingRetirementDrainFields(current, plan, cursor, batches, digest);
			drainPrefixes.push(frame(current, old.revision + 3 + batches, old.sequence + 1, cursor, batches));
		}
	}
	return Object.freeze({
		old: frame(old, old.revision, old.sequence, prior?.cursor, prior?.batches),
		prepared: preparedWidth,
		aborted: frame(aborted, old.revision + 2, old.sequence + 1, prior?.cursor, prior?.batches),
		completed: completedWidth,
		drainPrefixes: Object.freeze(drainPrefixes),
	});
}

const signingHex = (bytes: Uint8Array): string =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Mechanical exact frame commitment, never semantic deletion authority.
 * @param frame - Original bounded canonical native frame.
 * @returns Exact native frame commitment.
 */
export function signingRetirementFrameDigest(frame: Uint8Array): string {
	return signingHex(hashDomain("ts-drp/signing-native-frame/v1", frame));
}

/**
 * Canonical-address ordered unique data frames; excludes only the two controls.
 * @param rows - Original bounded captured frames or authenticated reconstructed frames.
 * @param objectId - Original addressed object; not an authority grant.
 * @returns Unique data commitment, refusing contradictory duplicate addresses.
 */
export function signingRetirementDataDigest(rows: readonly Uint8Array[], objectId: string): string {
	// Preserve the original synchronous unknown-byte boundary, including its
	// original borrowed byte inputs. Only retained captures need private copies.
	return readSigningRetirementDataImage(rows, objectId, false).digest();
}

/**
 * One original bounded native-image parser and its operation-local projections.
 * Every supplied row is decoded before any projection is delivered. This is
 * mechanical syntax only: a fresh native transaction must create its own image,
 * and callers still own all currency, context and authentication checks.
 * @param rows - Original privately owned exact native frames.
 * @param objectId - Original addressed object, not an authority grant.
 * @returns Parsed frames and the unchanged canonical-address ordered commitment.
 */
export function captureSigningRetirementDataImage(rows: readonly Uint8Array[], objectId: string) {
	return readSigningRetirementDataImage(rows, objectId, true);
}

// Nominal membership only: the original capture remains the sole byte owner.
// No content, authorization or native currency is retained in this registry.
const signingRetirementDataCaptures = new WeakSet<object>();
export function releaseCapturedSigningRetirementDataImage(value: unknown): void {
	if (value !== null && typeof value === "object") signingRetirementDataCaptures.delete(value);
}
export function resolveCapturedSigningRetirementDataImage(value: unknown, rows: readonly Uint8Array[], objectId: string):
	ReturnType<typeof captureSigningRetirementDataImage> | undefined {
	if (value === null || typeof value !== "object" || !signingRetirementDataCaptures.has(value)) return undefined;
	const capture = value as ReturnType<typeof captureSigningRetirementDataImage>;
	try {return capture.matchesExactRows(rows, objectId) && signingRetirementDataCaptures.has(capture) ? capture : undefined;}
	catch {return undefined;}
}

function readSigningRetirementDataImage(rows: readonly Uint8Array[], objectId: string, retain: boolean) {
	const distinct = new Map<string, { address: Uint8Array; frame: Uint8Array }>();
	const frames: Readonly<{ bytes: Uint8Array; address?: Uint8Array; addressKey?: string }>[] = [];
	const selections: Readonly<{ index: number; byteLength: number; store: string; epoch?: number; addressKey?: string }>[] = [];
	for (const source of rows) {
		// Only these detached exact bytes back retained commitments. Returned
		// frames are copies; exclusion uses this capture's scalar row indices.
		const bytes = retain ? new Uint8Array(source) : source;
		const frame = decodeCanonical(bytes, signingFrameLimits);
		if (!Array.isArray(frame) || frame.length !== 3 || typeof frame[0] !== "string")
			throw new TypeError("INVALID_SIGNING_DATA_FRAME");
		if (
			frame[0] === "storageMeta" &&
			(frame[1] === `ahe-retirement:${objectId}` || frame[1] === `signing-retirement:${objectId}`)
		) {
			if (retain) {
				selections.push(Object.freeze({ index: frames.length, byteLength: bytes.byteLength, store: frame[0] }));
				frames.push({ bytes });
			}
			continue;
		}
		const address = encodeCanonical(frame.slice(0, 2), signingFrameLimits),
			key = signingHex(address),
			prior = distinct.get(key);
		if (prior !== undefined && compareBytes(prior.frame, bytes) !== 0)
			throw new TypeError("CONFLICTING_SIGNING_DATA_FRAME");
		distinct.set(key, { address, frame: bytes });
		// Immediate unknown-byte digest calls retain only the original distinct
		// map. Do not add a per-row projection inventory to that hot path.
		if (retain) {
			selections.push(Object.freeze({ index: frames.length, byteLength: bytes.byteLength, store: frame[0],
				epoch: Array.isArray(frame[1]) && typeof frame[1][1] === "number" ? frame[1][1] : undefined,
				addressKey: Array.from(address).join(",") }));
			frames.push({ bytes, address, addressKey: key });
		}
	}
	const digest = (excluded?: ReadonlySet<number>): string => {
		// Exclusion selects this capture's original frames only. Rebuild address
		// multiplicities without parsing/encoding; identical duplicate addresses
		// remain present if any original occurrence remains in the residual.
		const remaining = excluded === undefined ? distinct : new Map<string, { address: Uint8Array; frame: Uint8Array }>();
		if (excluded !== undefined) {
			for (const [index, row] of frames.entries()) {
				if (row.address !== undefined && row.addressKey !== undefined && !excluded.has(index))
					remaining.set(row.addressKey, { address: row.address, frame: row.bytes });
			}
		}
		return signingHex(
			hashDomain(
				"ts-drp/signing-native-data/v1",
				...[...remaining.values()].sort((left, right) => compareBytes(left.address, right.address)).map((row) => row.frame)
			)
		);
	};
	// Only frozen scalar selectors and detached byte copies escape, not the
	// private decoder's mutable full trees, canonical addresses or byte inventory.
	const capture = Object.freeze({ frames: Object.freeze(selections), digest,
		readExactCanonicalRows: (): readonly Uint8Array[] => Object.freeze(frames.map(row => new Uint8Array(row.bytes))),
		readCanonicalAddress: (index: number): Uint8Array | undefined => frames[index]?.address?.slice(),
		matchesExactRows: (rows: readonly Uint8Array[], addressedObjectId: string): boolean => {
			if (!retain || addressedObjectId !== objectId || !Array.isArray(rows) || rows.length !== frames.length) return false;
			return frames.every((row, index) => {
				const field = Object.getOwnPropertyDescriptor(rows, index);
				return field !== undefined && "value" in field && field.value instanceof Uint8Array &&
					Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "buffer")!.get!.call(field.value) instanceof ArrayBuffer &&
					compareBytes(field.value, row.bytes) === 0;
			});
		} });
	if (retain) signingRetirementDataCaptures.add(capture);
	return capture;
}
export type SigningRetirementResult = Readonly<
	{ ok: true; control: SigningRetirementControl } | { ok: false; reason: string }
>;
/** Read-only addressed image custody; detached frames cannot authorize mutations. */
export interface SigningDependencyObservation {
	readonly control: SigningRetirementControl;
	readonly imageDigest: string;
	readonly logicalBytes: number;
	readExactCanonicalRows(): readonly Uint8Array[];
	/** Original exact-byte syntax capture only; never authentication/currency.
	 * Absent on external producers, which retain their full unknown-byte path. */
	readRetirementDataImage?(): ReturnType<typeof captureSigningRetirementDataImage>;
	check(): Promise<void>;
	release(): Promise<void>;
}
export interface SigningRetirementObservation extends SigningDependencyObservation {
	readonly control: SigningRetirementControl;
	readonly imageDigest: string;
	readonly logicalBytes: number;
	check(): Promise<void>;
	checkSigningScope(
		input: Readonly<{ epoch: number; round: number; signerId: string }>
	): Promise<Readonly<{ ok: true } | { ok: false; reason: string }>>;
	release(): Promise<void>;
	prepareFence(input: SigningRetirementPreparation): Promise<SigningRetirementResult>;
	abortPrepared(): Promise<SigningRetirementResult>;
	commitPrepared(): Promise<SigningRetirementResult>;
	beginEvidenceDrain(input: SigningEvidenceRetirementPlan): Promise<SigningRetirementResult>;
	beginSummaryDrain(input: SigningSummaryRetirementPlan): Promise<SigningRetirementResult>;
	drainEvidenceBatch(): Promise<SigningRetirementResult>;
}
export interface SigningNativeRead {
	readonly incarnation: string;
	check(): Promise<void>;
	/** Optional local owned-key conformance, not authentication minted by storage. */
	checkSigningIdentity?(input: Readonly<{ publicKey: Uint8Array }>): Promise<void>;
	checkSigningScope(
		input: Readonly<{ epoch: number; round: number; signerId: string }>
	): Promise<Readonly<{ ok: true } | { ok: false; reason: string }>>;
	release(): Promise<void>;
}

/**
 * Resolves a genuine branded store port for voter composition.
 * @param value - Candidate store port.
 * @returns Captured adapter, or undefined for foreign input.
 */
export function resolveSealStorePort(value: unknown): SealStoreAdapter | undefined {
	if (value === null || typeof value !== "object") return undefined;
	return storeAdapters.get(value as SealStorePort);
}

/** Original actor composition only: no public caller provider or scope fallback. */
export function nativeSigningAdmissionFactory(
	port: SealStorePort,
	enrollment: SealVoterEnrollment
): SigningNativeAdmissionFactory {
	const adapter = resolveSealStorePort(port),
		identity = resolveSealVoterEnrollment(enrollment);
	if (adapter?.acquireSigningAdmission === undefined || identity === undefined)
		throw new SigningAdmissionRefusal("NATIVE_SIGNING_UNSUPPORTED");
	const acquire = adapter.acquireSigningAdmission;
	return async (scope) => {
		if (scope.objectId !== identity.objectId || scope.epoch !== identity.epoch || scope.signerId !== identity.signerId)
			throw new SigningAdmissionRefusal("SIGNING_SCOPE_MISMATCH");
		let held: SigningNativeRead;
		try {
			held = await acquire(enrollment);
		} catch (cause) {
			// Only the original native incarnation sentinel is a typed admission
			// refusal. Aggregate/acquisition cleanup causes retain their identity.
			if (cause instanceof Error && cause.message === "STORAGE_LOSS") throw new SigningAdmissionRefusal("STORAGE_LOSS");
			throw cause;
		}
		let released = false;
		const check = async (): Promise<void> => {
			if (released) throw new Error("READ_RELEASED");
			if (held.incarnation !== identity.expectedIncarnation) throw new SigningAdmissionRefusal("STORAGE_LOSS");
			await held.check();
			await held.checkSigningIdentity?.({ publicKey: scope.publicKey });
			const result = await held.checkSigningScope({ epoch: scope.epoch, round: scope.round, signerId: scope.signerId });
			if (!result.ok) throw new SigningAdmissionRefusal(result.reason);
		};
		try {
			await check();
		} catch (primary) {
			try {
				await held.release();
			} catch (cleanup) {
				throw new AggregateError([primary, cleanup], "native signing admission and release failed", { cause: primary });
			}
			throw primary;
		}
		const admission = Object.freeze({
			async check() {
				if (this !== admission) throw new TypeError("FOREIGN_SIGNING_ADMISSION");
				await check();
			},
			release() {
				if (this !== admission) return Promise.reject(new TypeError("FOREIGN_SIGNING_ADMISSION"));
				released = true;
				return held.release();
			},
		});
		return admission;
	};
}

/**
 * Registers one genuine voter handle without changing its public shape.
 * @param handle - Frozen voter handle.
 * @returns The same authenticated handle.
 */
export function mintSealVoterPort<T extends object>(handle: T): T {
	voterPorts.add(handle);
	return handle;
}

/**
 * Tests whether a candidate is a voter minted by this package instance.
 * @param value - Candidate voter handle.
 * @returns True only for an authenticated voter.
 */
export function isSealVoterPort(value: unknown): value is object {
	return value !== null && typeof value === "object" && voterPorts.has(value);
}
