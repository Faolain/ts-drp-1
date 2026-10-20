import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";

import { isWellFormedUtf16 } from "./internal/validation.js";
import type { NativeReadReservation } from "./types.js";

export interface RoomHead {
	readonly currentAnchorDigest: string;
	readonly epoch: number;
	readonly objectId: string;
}
export interface RoomHeadScope {
	readonly objectId: string;
	readonly pinnedGenesisAnchorDigest: string;
}
export interface RoomHeadState {
	readonly stable: RoomHead;
	readonly pending: null | Readonly<{ readonly previous: RoomHead; readonly next: RoomHead }>;
}
export type RoomHeadInitialization =
	| Readonly<{ kind: "create" }>
	| Readonly<{ kind: "reopen" }>
	| Readonly<{ kind: "migrate"; head: RoomHead }>;
export type RoomHeadResult =
	| Readonly<{ ok: true; state: RoomHeadState | null }>
	| Readonly<{ ok: false; reason: "conflict" | "unavailable" }>;
export interface RoomHeadAuthority {
	readonly initialization: RoomHeadInitialization;
	read(input: Readonly<{ scope: RoomHeadScope }>): Promise<RoomHeadResult>;
	create(input: Readonly<{ scope: RoomHeadScope; stable: RoomHead }>): Promise<RoomHeadResult>;
	migrate(input: Readonly<{ scope: RoomHeadScope; stable: RoomHead }>): Promise<RoomHeadResult>;
	begin(input: Readonly<{ scope: RoomHeadScope; expected: RoomHeadState; next: RoomHead }>): Promise<RoomHeadResult>;
	commit(input: Readonly<{ scope: RoomHeadScope; expected: RoomHeadState }>): Promise<RoomHeadResult>;
	acquireNativeReadReservation?(input: Readonly<{ scope: RoomHeadScope }>): Promise<NativeReadReservation>;
	/** Complete noncreating point capture; borrows an existing native read when present. */
	readRetirementImage?(
		input: Readonly<{ scope: RoomHeadScope }>
	): Promise<Pick<RoomHeadRetirementObservation, "scope" | "state" | "control" | "imageDigest" | "metadataBytes">>;
}
export interface RoomHeadFenceCommitment {
	readonly decisionDigest: string;
	readonly sourceProofDigest: string;
	readonly throughEpoch: number;
}
export interface RoomHeadControl {
	readonly incarnation: string;
	readonly revision: number;
	readonly completed: null | RoomHeadFenceCommitment;
	readonly active: null | Readonly<RoomHeadFenceCommitment & { readonly imageDigest: string }>;
}
/** Native mechanical CAS participant. The original protocol owner supplies eligibility; no handle grants it. */
export interface RoomHeadRetirementObservation {
	readonly scope: RoomHeadScope;
	readonly state: RoomHeadState;
	readonly control: RoomHeadControl;
	readonly imageDigest: string;
	readonly metadataBytes: number;
	prepareFence(input: RoomHeadFenceCommitment): Promise<RoomHeadControl>;
	abortPrepared(input: RoomHeadFenceCommitment): Promise<RoomHeadControl>;
	commitPrepared(input: RoomHeadFenceCommitment): Promise<RoomHeadControl>;
	/**
	 * Optional (slice 14b step A): the same prepare then commit of one decision's labels,
	 * in ONE native transaction, so no crash leaves the floor's control active. The
	 * result is exactly the state `prepareFence` then `commitPrepared` reach.
	 */
	fenceDecision?(input: RoomHeadFenceCommitment): Promise<RoomHeadControl>;
	release(): Promise<void>;
}

export const ROOM_HEAD_IMAGE_LIMITS = Object.freeze({ maxBytes: 16_384, maxDepth: 8, maxItems: 128 });
export interface RoomHeadImage {
	readonly version: 1;
	readonly scope: RoomHeadScope;
	readonly state: RoomHeadState;
	readonly control: RoomHeadControl;
}
export interface RoomHeadRetirementBinding {
	readonly scope: RoomHeadScope;
	readonly commitment: RoomHeadFenceCommitment;
	readonly incarnation: string;
	readonly revision: number;
	readonly oldImageDigest: string;
	readonly completedImageDigest: string;
}
export interface RoomHeadRetirementPlan {
	readonly binding: RoomHeadRetirementBinding;
	readonly preparedImageDigest: string;
	readonly preparedMetadataBytes: number;
	readonly completedMetadataBytes: number;
}
type RetirementSnapshot = Pick<
	RoomHeadRetirementObservation,
	"scope" | "state" | "control" | "imageDigest" | "metadataBytes"
>;

/** Original native schema fields. Resource slots are numerical premises only;
 * these projections perform no validation, authentication or freshness check. */
export function roomHeadStateFields<S, P>(input: Readonly<{stable: S; pending: P}>) {
	return {stable: input.stable, pending: input.pending};
}
export function roomHeadImageFields<S, T, C>(input: Readonly<{scope: S; state: T; control: C}>) {
	return {version: 1 as const, scope: input.scope, state: input.state, control: input.control};
}
export function roomHeadRetirementControlFields<I, R, A, C>(input: Readonly<{
	incarnation: I; revision: R; active: A; completed: C;
}>) {
	return {incarnation: input.incarnation, revision: input.revision, active: input.active, completed: input.completed};
}

/**
 * Captures the original bounded native floor control, not protocol authority.
 * @param value - Native decoded control.
 * @returns Detached exact control fields.
 */
export function captureRoomHeadControl(value: unknown): RoomHeadControl {
	const r = roomHeadFields(value, ["incarnation", "revision", "active", "completed"]);
	let active: RoomHeadControl["active"] = null;
	if (r.active !== null) {
		const a = roomHeadFields(r.active, ["decisionDigest", "sourceProofDigest", "throughEpoch", "imageDigest"]);
		active = Object.freeze({
			...captureRoomHeadFence({
				decisionDigest: a.decisionDigest,
				sourceProofDigest: a.sourceProofDigest,
				throughEpoch: a.throughEpoch,
			}),
			imageDigest: roomHeadDigest(a.imageDigest),
		});
	}
	return Object.freeze(roomHeadRetirementControlFields({
		incarnation: roomHeadDigest(r.incarnation),
		revision: roomHeadInteger(r.revision),
		active,
		completed: r.completed === null ? null : captureRoomHeadFence(r.completed),
	}));
}

/**
 * Decodes the single canonical floor image using its original native ceiling.
 * @param value - Exact native record bytes.
 * @returns Complete image; no authentication or independent freshness claim.
 */
export function captureRoomHeadImage(value: unknown): RoomHeadImage {
	if (!(value instanceof Uint8Array) || value.byteLength > ROOM_HEAD_IMAGE_LIMITS.maxBytes)
		throw new TypeError("ROOM_HEAD_INVALID_IMAGE");
	const r = roomHeadFields(decodeCanonical(value, ROOM_HEAD_IMAGE_LIMITS), ["version", "scope", "state", "control"]);
	if (r.version !== 1) throw new TypeError("ROOM_HEAD_INVALID_VERSION");
	const scope = captureRoomHeadScope(r.scope),
		state = captureRoomHeadState(r.state, scope),
		control = captureRoomHeadControl(r.control);
	if (
		(control.completed !== null && control.completed.throughEpoch >= state.stable.epoch) ||
		(control.active !== null && control.active.throughEpoch >= state.stable.epoch) ||
		(control.active !== null &&
			control.completed !== null &&
			control.active.throughEpoch < control.completed.throughEpoch)
	)
		throw new TypeError("ROOM_HEAD_INVALID_FRONTIER");
	const image: RoomHeadImage = Object.freeze(roomHeadImageFields({scope, state, control}));
	const exact = encodeCanonical(image, ROOM_HEAD_IMAGE_LIMITS);
	if (value.length !== exact.length || !value.every((byte, i) => byte === exact[i]))
		throw new TypeError("ROOM_HEAD_NONCANONICAL");
	return image;
}

/**
 * Commits the entire original floor image, including its control metadata.
 * @param image - Complete captured image.
 * @returns Original domain-separated digest.
 */
export function roomHeadImageDigest(image: RoomHeadImage): string {
	return Array.from(
		hashDomain("drp.native-room-head-image.v1", encodeCanonical(image, ROOM_HEAD_IMAGE_LIMITS)),
		(byte) => byte.toString(16).padStart(2, "0")
	).join("");
}

/**
 * Projects the existing native metadata transition without performing a write.
 * @param image - Complete captured native preimage.
 * @param kind - Original native preparation, abort or completion operation.
 * @param value - Fixed mechanical labels; not protocol permission.
 * @returns Exact next image under the same monotone native control rules.
 */
export function roomHeadRetirementChange(
	image: RoomHeadImage,
	kind: "prepare" | "abort" | "commit",
	value: RoomHeadFenceCommitment
): RoomHeadImage {
	const commitment = captureRoomHeadFence(value),
		c = image.control;
	let control: RoomHeadControl;
	if (kind === "prepare") {
		if (
			c.active !== null ||
			commitment.throughEpoch >= image.state.stable.epoch ||
			(c.completed !== null && commitment.throughEpoch < c.completed.throughEpoch)
		)
			throw new Error("ROOM_HEAD_FENCE_CONFLICT");
		if (c.revision === Number.MAX_SAFE_INTEGER) throw new Error("ROOM_HEAD_REVISION_EXHAUSTED");
		control = Object.freeze({
			...c,
			revision: c.revision + 1,
			active: Object.freeze({ ...commitment, imageDigest: roomHeadImageDigest(image) }),
		});
	} else {
		const active = c.active;
		if (
			active === null ||
			!sameRoomHeadValue(
				{
					decisionDigest: active.decisionDigest,
					sourceProofDigest: active.sourceProofDigest,
					throughEpoch: active.throughEpoch,
				},
				commitment
			)
		)
			throw new Error("ROOM_HEAD_FENCE_CONFLICT");
		if (c.revision === Number.MAX_SAFE_INTEGER) throw new Error("ROOM_HEAD_REVISION_EXHAUSTED");
		control = Object.freeze({
			...c,
			revision: c.revision + 1,
			active: null,
			...(kind === "commit" ? { completed: commitment } : {}),
		});
	}
	return Object.freeze({ ...image, control });
}

function retirementSnapshotImage(snapshot: RetirementSnapshot): RoomHeadImage {
	const data: Record<string, unknown> = {};
	for (const key of ["scope", "state", "control", "imageDigest", "metadataBytes"]) {
		const d = Object.getOwnPropertyDescriptor(snapshot, key);
		if (d?.enumerable !== true || !("value" in d)) throw new TypeError("ROOM_HEAD_INVALID_RECORD");
		data[key] = d.value;
	}
	const bytes = encodeCanonical(
		roomHeadImageFields({scope: data.scope, state: data.state, control: data.control}),
		ROOM_HEAD_IMAGE_LIMITS
	);
	const image = captureRoomHeadImage(bytes);
	if (
		roomHeadDigest(data.imageDigest) !== roomHeadImageDigest(image) ||
		roomHeadInteger(data.metadataBytes) !== bytes.length
	)
		throw new TypeError("ROOM_HEAD_CONTROL_STALE");
	return image;
}

/**
 * Plans only the exact native metadata deltas after independent protocol labels
 * have been authenticated. Labels must not depend on these planned image hashes.
 * @param original - Actual original native observation, before preparing.
 * @param value - Fixed original-owner decision/source/frontier labels.
 * @returns Bounded whole-image commitments, never retirement eligibility.
 */
export function captureRoomHeadRetirementPlan(
	original: RetirementSnapshot,
	value: RoomHeadFenceCommitment
): RoomHeadRetirementPlan {
	const image = retirementSnapshotImage(original),
		commitment = captureRoomHeadFence(value),
		c = image.control;
	if (c.revision > Number.MAX_SAFE_INTEGER - 2) throw new TypeError("ROOM_HEAD_REVISION_EXHAUSTED");
	const oldImageDigest = roomHeadImageDigest(image);
	const prepared = roomHeadRetirementChange(image, "prepare", commitment);
	const completed = roomHeadRetirementChange(prepared, "commit", commitment);
	return Object.freeze({
		binding: Object.freeze({
			scope: image.scope,
			commitment,
			incarnation: c.incarnation,
			revision: c.revision,
			oldImageDigest,
			completedImageDigest: roomHeadImageDigest(completed),
		}),
		preparedImageDigest: roomHeadImageDigest(prepared),
		preparedMetadataBytes: encodeCanonical(prepared, ROOM_HEAD_IMAGE_LIMITS).length,
		completedMetadataBytes: encodeCanonical(completed, ROOM_HEAD_IMAGE_LIMITS).length,
	});
}

/**
 * Validates fresh native readback against retained exact OLD/completed images.
 * Prepared readback reconstructs the whole OLD image, including its prior
 * completed fence; completed readback cannot invent that discarded prior fence.
 * @param current - Actual fresh native observation.
 * @param value - Retained original binding, not a phase/eligibility flag.
 * @returns Exact mechanical phase; protocol custody remains the caller's owner.
 */
export function validateRoomHeadRetirementObservation(
	current: RetirementSnapshot,
	value: RoomHeadRetirementBinding
): "old" | "prepared" | "completed" {
	const b = roomHeadFields(value, [
		"scope",
		"commitment",
		"incarnation",
		"revision",
		"oldImageDigest",
		"completedImageDigest",
	]);
	const scope = captureRoomHeadScope(b.scope),
		commitment = captureRoomHeadFence(b.commitment),
		incarnation = roomHeadDigest(b.incarnation),
		revision = roomHeadInteger(b.revision);
	const oldImageDigest = roomHeadDigest(b.oldImageDigest),
		completedImageDigest = roomHeadDigest(b.completedImageDigest);
	const image = retirementSnapshotImage(current),
		c = image.control;
	if (revision > Number.MAX_SAFE_INTEGER - 2 || c.incarnation !== incarnation || !sameRoomHeadValue(scope, image.scope))
		throw new TypeError("ROOM_HEAD_CONTROL_STALE");
	const digest = roomHeadImageDigest(image);
	if (c.revision === revision && c.active === null && digest === oldImageDigest) {
		const plan = captureRoomHeadRetirementPlan(current, commitment);
		if (plan.binding.completedImageDigest === completedImageDigest) return "old";
	}
	if (
		c.revision === revision + 1 &&
		c.active !== null &&
		c.active.imageDigest === oldImageDigest &&
		sameRoomHeadValue(
			{
				decisionDigest: c.active.decisionDigest,
				sourceProofDigest: c.active.sourceProofDigest,
				throughEpoch: c.active.throughEpoch,
			},
			commitment
		)
	) {
		const old: RoomHeadImage = { ...image, control: { ...c, revision, active: null } };
		const completed = roomHeadRetirementChange(image, "commit", commitment);
		if (roomHeadImageDigest(old) === oldImageDigest && roomHeadImageDigest(completed) === completedImageDigest)
			return "prepared";
	}
	if (
		c.revision === revision + 2 &&
		c.active === null &&
		c.completed !== null &&
		sameRoomHeadValue(c.completed, commitment) &&
		digest === completedImageDigest
	)
		return "completed";
	throw new TypeError("ROOM_HEAD_CONTROL_STALE");
}

/**
 * Capture a closed data-only record without invoking caller accessors.
 * @param value - Untrusted structural input.
 * @param keys - Exact permitted field names.
 * @returns Detached own data fields.
 */
export function roomHeadFields(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object") throw new TypeError("ROOM_HEAD_INVALID_RECORD");
	const prototype = Object.getPrototypeOf(value);
	const actual = Reflect.ownKeys(value);
	if (
		(prototype !== Object.prototype && prototype !== null) ||
		actual.length !== keys.length ||
		actual.some((key) => typeof key !== "string" || !keys.includes(key))
	)
		throw new TypeError("ROOM_HEAD_INVALID_RECORD");
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor?.enumerable !== true || !("value" in descriptor)) throw new TypeError("ROOM_HEAD_INVALID_RECORD");
		result[key] = descriptor.value;
	}
	return result;
}
/**
 * Capture a canonical fixed-size digest spelling.
 * @param value - Untrusted digest input.
 * @returns The validated lowercase digest.
 */
export function roomHeadDigest(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new TypeError("ROOM_HEAD_INVALID_DIGEST");
	return value;
}
/**
 * Capture a bounded integer without coercion.
 * @param value - Untrusted epoch or revision input.
 * @returns The validated nonnegative safe integer.
 */
export function roomHeadInteger(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new TypeError("ROOM_HEAD_INVALID_INTEGER");
	return value;
}
/**
 * Capture the host's exact object and genesis pin.
 * @param value - Untrusted scope input.
 * @returns An immutable, mechanically bounded scope.
 */
export function captureRoomHeadScope(value: unknown): RoomHeadScope {
	const r = roomHeadFields(value, ["objectId", "pinnedGenesisAnchorDigest"]);
	// Protocol object spellings are not selected here. Bound mechanical metadata before encoding.
	if (
		typeof r.objectId !== "string" ||
		r.objectId.length === 0 ||
		r.objectId.length > 1024 ||
		r.objectId.includes("\0") ||
		!isWellFormedUtf16(r.objectId)
	)
		throw new TypeError("ROOM_HEAD_INVALID_OBJECT");
	return Object.freeze({
		objectId: r.objectId,
		pinnedGenesisAnchorDigest: roomHeadDigest(r.pinnedGenesisAnchorDigest),
	});
}
/**
 * Capture one head in the original host scope.
 * @param value - Untrusted head input.
 * @param scope - Original object and genesis pin.
 * @returns An immutable head; authentication remains the host/protocol owner's responsibility.
 */
export function captureRoomHead(value: unknown, scope: RoomHeadScope): RoomHead {
	const r = roomHeadFields(value, ["currentAnchorDigest", "epoch", "objectId"]);
	const epoch = roomHeadInteger(r.epoch),
		currentAnchorDigest = roomHeadDigest(r.currentAnchorDigest);
	if (r.objectId !== scope.objectId || (epoch === 0 && currentAnchorDigest !== scope.pinnedGenesisAnchorDigest))
		throw new TypeError("ROOM_HEAD_SCOPE_CONFLICT");
	return Object.freeze({ currentAnchorDigest, epoch, objectId: scope.objectId });
}
/**
 * Compare exact bounded canonical mechanical values.
 * @param a - First closed captured value.
 * @param b - Second closed captured value.
 * @returns Whether the canonical images are identical.
 */
export function sameRoomHeadValue(a: unknown, b: unknown): boolean {
	const x = encodeCanonical(a, { maxBytes: 16_384, maxDepth: 8, maxItems: 128 });
	const y = encodeCanonical(b, { maxBytes: 16_384, maxDepth: 8, maxItems: 128 });
	return x.length === y.length && x.every((v, i) => v === y[i]);
}
/**
 * Capture stable/pending state with exact predecessor and adjacent successor.
 * @param value - Untrusted state input.
 * @param scope - Original object and genesis pin.
 * @returns Immutable mechanically valid state, not an authenticated recovery decision.
 */
export function captureRoomHeadState(value: unknown, scope: RoomHeadScope): RoomHeadState {
	const r = roomHeadFields(value, ["stable", "pending"]),
		stable = captureRoomHead(r.stable, scope);
	if (r.pending === null) return Object.freeze(roomHeadStateFields({stable, pending: null}));
	const p = roomHeadFields(r.pending, ["previous", "next"]);
	const previous = captureRoomHead(p.previous, scope),
		next = captureRoomHead(p.next, scope);
	if (
		!sameRoomHeadValue(previous, stable) ||
		next.epoch !== stable.epoch + 1 ||
		next.currentAnchorDigest === stable.currentAnchorDigest
	)
		throw new TypeError("ROOM_HEAD_INVALID_ADJACENCY");
	return Object.freeze(roomHeadStateFields({stable, pending: Object.freeze({previous, next})}));
}
/**
 * Capture fixed-width source-owned commitment labels for native CAS only.
 * @param value - Untrusted mechanical commitment input.
 * @returns Immutable labels and the requested retired prefix endpoint.
 */
export function captureRoomHeadFence(value: unknown): RoomHeadFenceCommitment {
	const r = roomHeadFields(value, ["decisionDigest", "sourceProofDigest", "throughEpoch"]);
	return Object.freeze({
		decisionDigest: roomHeadDigest(r.decisionDigest),
		sourceProofDigest: roomHeadDigest(r.sourceProofDigest),
		throughEpoch: roomHeadInteger(r.throughEpoch),
	});
}

/** Retention owners that keep a per-owner fence entry in the host floor (slice 14c). */
export const ROOM_RETIREMENT_FENCE_OWNERS = Object.freeze([
	"ahe",
	"issuance",
	"journal",
	"signing",
	"snapshot",
] as const);
export type RoomRetirementFenceOwner = (typeof ROOM_RETIREMENT_FENCE_OWNERS)[number];
/** Expected owner control digests around one decision; an expectation, never deletion authority. */
export interface RoomRetirementFence {
	readonly base: string;
	readonly target: string;
	readonly through: number;
}
export type RoomRetirementFenceEntry = readonly [RoomRetirementFenceOwner, RoomRetirementFence];
export interface RoomHeadRetirementFences {
	readonly version: 1;
	readonly scope: RoomHeadScope;
	readonly revision: number;
	readonly owners: readonly RoomRetirementFenceEntry[];
}
export interface RoomRetirementFenceRequest {
	readonly scope: RoomHeadScope;
	readonly owners: readonly RoomRetirementFenceEntry[];
}

function captureFenceOwner(value: unknown): RoomRetirementFenceOwner {
	if (typeof value !== "string" || !(ROOM_RETIREMENT_FENCE_OWNERS as readonly string[]).includes(value))
		throw new TypeError("ROOM_HEAD_INVALID_OWNER");
	return value as RoomRetirementFenceOwner;
}
function captureFence(value: unknown): RoomRetirementFence {
	const r = roomHeadFields(value, ["base", "target", "through"]);
	return Object.freeze({
		base: roomHeadDigest(r.base),
		target: roomHeadDigest(r.target),
		through: roomHeadInteger(r.through),
	});
}
function sortedFenceEntries(entries: readonly RoomRetirementFenceEntry[]): readonly RoomRetirementFenceEntry[] {
	const sorted = [...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	for (let index = 1; index < sorted.length; index++)
		if (sorted[index - 1]![0] === sorted[index]![0]) throw new TypeError("ROOM_HEAD_INVALID_OWNER");
	return Object.freeze(sorted);
}

/**
 * Captures one host request to record per-owner retirement fences.
 * @param value - Untrusted `{ scope, owners: [{ owner, through, base, target }] }`.
 * @returns Detached request with owners sorted by name; mechanical validation only.
 */
export function captureRoomRetirementFenceRequest(value: unknown): RoomRetirementFenceRequest {
	const r = roomHeadFields(value, ["scope", "owners"]);
	const scope = captureRoomHeadScope(r.scope);
	if (!Array.isArray(r.owners) || r.owners.length === 0 || r.owners.length > ROOM_RETIREMENT_FENCE_OWNERS.length)
		throw new TypeError("ROOM_HEAD_INVALID_OWNERS");
	const entries = (r.owners as unknown[]).map((item): RoomRetirementFenceEntry => {
		const e = roomHeadFields(item, ["owner", "through", "base", "target"]);
		return Object.freeze([
			captureFenceOwner(e.owner),
			captureFence({ base: e.base, target: e.target, through: e.through }),
		] as const);
	});
	return Object.freeze({ scope, owners: sortedFenceEntries(entries) });
}

function fenceRecordValue(record: RoomHeadRetirementFences): Readonly<Record<string, unknown>> {
	return {
		version: 1,
		scope: record.scope,
		revision: record.revision,
		owners: record.owners.map(([owner, fence]) => [
			owner,
			{ base: fence.base, target: fence.target, through: fence.through },
		]),
	};
}

/**
 * Encodes a fence record as exact canonical bytes under the floor's image limits.
 * @param record - Complete captured record.
 * @returns Canonical bytes.
 */
export function encodeRoomHeadRetirementFences(record: RoomHeadRetirementFences): Uint8Array {
	return encodeCanonical(fenceRecordValue(record), ROOM_HEAD_IMAGE_LIMITS);
}

/**
 * Decodes one stored fence record. Any malformed, noncanonical or out-of-scope record is corrupt.
 * @param value - Exact native record bytes.
 * @param scope - The floor image's scope.
 * @returns Complete detached record; an expectation only, never deletion authority.
 */
export function captureRoomHeadRetirementFences(value: unknown, scope: RoomHeadScope): RoomHeadRetirementFences {
	try {
		if (!(value instanceof Uint8Array) || value.byteLength > ROOM_HEAD_IMAGE_LIMITS.maxBytes)
			throw new TypeError("ROOM_HEAD_INVALID_FENCES");
		const r = roomHeadFields(decodeCanonical(value, ROOM_HEAD_IMAGE_LIMITS), [
			"version",
			"scope",
			"revision",
			"owners",
		]);
		if (r.version !== 1) throw new TypeError("ROOM_HEAD_INVALID_VERSION");
		const recordScope = captureRoomHeadScope(r.scope);
		if (!sameRoomHeadValue(recordScope, scope)) throw new TypeError("ROOM_HEAD_SCOPE_CONFLICT");
		if (!Array.isArray(r.owners) || r.owners.length === 0 || r.owners.length > ROOM_RETIREMENT_FENCE_OWNERS.length)
			throw new TypeError("ROOM_HEAD_INVALID_OWNERS");
		const entries = (r.owners as unknown[]).map((item): RoomRetirementFenceEntry => {
			if (!Array.isArray(item) || item.length !== 2) throw new TypeError("ROOM_HEAD_INVALID_OWNERS");
			return Object.freeze([captureFenceOwner(item[0]), captureFence(item[1])] as const);
		});
		const owners = sortedFenceEntries(entries);
		if (owners.some(([owner], index) => owner !== entries[index]![0])) throw new TypeError("ROOM_HEAD_INVALID_OWNERS");
		const record: RoomHeadRetirementFences = Object.freeze({
			version: 1,
			scope: recordScope,
			revision: roomHeadInteger(r.revision),
			owners,
		});
		const exact = encodeRoomHeadRetirementFences(record);
		if (value.length !== exact.length || !value.every((byte, index) => byte === exact[index]))
			throw new TypeError("ROOM_HEAD_NONCANONICAL");
		return record;
	} catch {
		throw new Error("ROOM_HEAD_FENCE_CORRUPT");
	}
}

/**
 * Domain-separated digest of a fence record, for exact readback only.
 * @param record - Complete captured record.
 * @returns Lowercase hex digest.
 */
export function roomHeadRetirementFencesDigest(record: RoomHeadRetirementFences): string {
	return Array.from(
		hashDomain("drp.native-room-head-retirement-fences.v1", encodeRoomHeadRetirementFences(record)),
		(byte) => byte.toString(16).padStart(2, "0")
	).join("");
}

/**
 * Projects one monotone fence transition without performing a write (slice 14c).
 * For each requested owner: a first entry is accepted; otherwise the request's
 * base must be the old target (applied) or the old base (unapplied, replaced),
 * and `through` never decreases. Every `through` stays below the stable epoch.
 * Refusal precedence: scope, window, corrupt stored record, fence conflict.
 * @param stored - Exact stored record bytes from the same transaction, or undefined when none exists.
 * @param image - Current floor image in the same transaction.
 * @param request - Captured request.
 * @returns The next record, or the old record itself when the request changes nothing.
 */
export function roomHeadRetirementFenceChange(
	stored: unknown,
	image: RoomHeadImage,
	request: RoomRetirementFenceRequest
): RoomHeadRetirementFences {
	if (!sameRoomHeadValue(image.scope, request.scope)) throw new Error("ROOM_HEAD_CONTROL_CONFLICT");
	for (const [, fence] of request.owners)
		if (fence.through >= image.state.stable.epoch) throw new Error("ROOM_HEAD_FENCE_WINDOW");
	const old = stored === undefined ? null : captureRoomHeadRetirementFences(stored, image.scope);
	const current = new Map<RoomRetirementFenceOwner, RoomRetirementFence>(old?.owners ?? []);
	let changed = false;
	for (const [owner, fence] of request.owners) {
		const previous = current.get(owner);
		if (previous !== undefined) {
			if (sameRoomHeadValue(previous, fence)) continue;
			if ((fence.base !== previous.target && fence.base !== previous.base) || fence.through < previous.through)
				throw new Error("ROOM_HEAD_FENCE_CONFLICT");
		}
		current.set(owner, fence);
		changed = true;
	}
	if (!changed && old !== null) return old;
	const revision = old === null ? 0 : old.revision;
	if (revision === Number.MAX_SAFE_INTEGER) throw new Error("ROOM_HEAD_REVISION_EXHAUSTED");
	return Object.freeze({
		version: 1,
		scope: image.scope,
		revision: revision + 1,
		owners: sortedFenceEntries(
			[...current.entries()].map(([owner, fence]): RoomRetirementFenceEntry => Object.freeze([owner, fence] as const))
		),
	});
}

// Slices 14a/14b/14e (Track M): the room-retention formats, on this subpath (the root
// entry's runtime surface is pinned).
export {
	createRoomRetentionProofBook,
	ROOM_RETENTION_LIMITS,
	ROOM_RETENTION_OWNERS,
	RoomRetentionRefusal,
	roomRetentionControlDigest,
	roomRetentionDecisionDigest,
	roomRetentionRefusalOf,
	roomRetentionRowBytes,
	roomRetentionRowDigest,
	roomRetentionSourceDigest,
	roomRetentionWriteCount,
} from "./room-retention.js";
export type {
	RoomRetentionAheSelection,
	RoomRetentionApplied,
	RoomRetentionControls,
	RoomRetentionDecision,
	RoomRetentionIssuanceSelection,
	RoomRetentionJournalScope,
	RoomRetentionJournalSelection,
	RoomRetentionKey,
	RoomRetentionLabels,
	RoomRetentionPlanned,
	RoomRetentionSelection,
	RoomRetentionSigningSelection,
	RoomRetentionSnapshotScope,
	RoomRetentionSnapshotSelection,
	RoomRetentionSurvivors,
	RoomRetentionTransactionLimits,
	RoomRetentionOwner,
	RoomRetentionOwnerDecision,
	RoomRetentionProofBook,
	RoomRetentionRefusalCode,
	RoomRetentionRewriteRef,
	RoomRetentionRowRef,
	RoomRetentionTraceEvent,
} from "./room-retention.js";
