import {
	CanonicalEncodingError,
	type CanonicalLimits,
	decodeCanonical,
	encodeCanonical,
	hashDomain,
} from "@ts-drp/canonical";
import { AHE_BOUNDED_READ_LIMITS, LOCAL_WORKLOAD_CAPACITY } from "@ts-drp/storage";
import {canonicalPrimitiveResourceForSizing, canonicalBytesResourceForSizing,
	canonicalArrayResourcesForSizing, canonicalRecordResourceForSizing,
	type CanonicalResourceFootprint} from "@ts-drp/canonical/resource";
import {createCanonicalEncodingCapture, type CanonicalEncodingCaptureValue} from "@ts-drp/canonical/encoding-capture";

import { captureLiveJournalInput, captureLiveJournalUnsignedSuccessorInput } from "./contract.js";
import type {
	LiveJournalFailureKind,
	LiveJournalClosedMembershipReadInput,
	LiveJournalClosedMembershipReadResult,
	LiveJournalRetirementControl,
	LiveJournalRetirementControlRead,
	LiveJournalRetirementDrainPlan,
	LiveJournalRetirementDrainSource,
	LiveJournalRetirementDrainState,
	LiveJournalRetirementImage,
	LiveJournalRetirementLocalPrefix,
	LiveJournalRetirementPreparation,
	LiveJournalRetirementResult,
	LiveJournalScope,
} from "./types.js";

// Native journal capacity is separate from cumulative proof/AHE-reader budgets.
// maxScopes bounds authenticated protected
// scopes/eligible prefixes; complete physical headers use the native row-work
// ceiling and image bytes, never the AHE generation count as a header policy.
export const LIVE_JOURNAL_RETIREMENT_LIMITS = Object.freeze({
	maxScopes: AHE_BOUNDED_READ_LIMITS.maxObjectGenerations,
	maxRows: LOCAL_WORKLOAD_CAPACITY.journalRows,
	maxImageBytes: LOCAL_WORKLOAD_CAPACITY.journalImageBytes,
});
export const LIVE_JOURNAL_RETIREMENT_BATCH_ROWS = 16;
/**
 * Bounds complete physical header/detail capture independently of the seven
 * authenticated protected scopes and eligible prefixes. Every captured native
 * row remains subject to the same complete image/frame byte ceiling.
 * @param scopeCount - Addressed physical signed-header count.
 * @param rowCount - Addressed physical accepted-detail count.
 * @returns Whether both native item counts fit the original row-work ceiling.
 */
export function journalRetirementImageCountsFit(scopeCount: number, rowCount: number): boolean {
	return [scopeCount, rowCount].every(
		(count) => Number.isSafeInteger(count) && count >= 0 && count <= LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows
	);
}
const hex = /^[0-9a-f]{64}$/u;
const fail = (kind: LiveJournalFailureKind): Extract<LiveJournalRetirementResult<never>, {ok: false}> => ({ ok: false, kind });
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("malformed-input");
	const proto = Object.getPrototypeOf(value);
	if ((proto !== Object.prototype && proto !== null) || Reflect.ownKeys(value).length !== keys.length)
		throw new TypeError("malformed-input");
	const own: Record<string, unknown> = {};
	for (const key of keys) {
		const d = Object.getOwnPropertyDescriptor(value, key);
		if (d === undefined || !("value" in d) || !d.enumerable) throw new TypeError("malformed-input");
		own[key] = d.value;
	}
	return own;
}
function integer(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError("malformed-input");
	return value;
}
function digest(value: unknown): string {
	if (typeof value !== "string" || !hex.test(value)) throw new TypeError("malformed-input");
	return value;
}
/**
 * Captures the closed object selector without evaluating accessors.
 * @param input - Untrusted selector record.
 * @returns The owned finite object identifier.
 */
export function captureJournalRetirementObject(input: unknown): string {
	const { objectId } = record(input, ["objectId"]);
	if (typeof objectId !== "string" || objectId.length === 0 || objectId.length > 1024 || objectId.includes("\0"))
		throw new TypeError("malformed-input");
	return objectId;
}
function scope(value: unknown, objectId: string): LiveJournalScope {
	const r = record(value, ["objectId", "epoch", "anchorDigest"]);
	if (r.objectId !== objectId) throw new TypeError("malformed-input");
	return Object.freeze({ objectId, epoch: integer(r.epoch), anchorDigest: digest(r.anchorDigest) });
}
/** Capture a bounded point selector without invoking caller accessors. */
export function captureJournalClosedMembershipReadInput(input: unknown): LiveJournalClosedMembershipReadInput {
	const r = record(input, ["scope", "maxBytes"]);
	const selected = record(r.scope, ["objectId", "epoch", "anchorDigest"]);
	const objectId = captureJournalRetirementObject({ objectId: selected.objectId });
	const maxBytes = integer(r.maxBytes);
	if (maxBytes > LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes) throw new TypeError("malformed-input");
	return Object.freeze({scope: scope(r.scope, objectId), maxBytes});
}

/** Detach native evidence only after its physical byte bound passes. No protocol authority is inferred. */
export function captureJournalClosedMembershipObservation(
	input: LiveJournalClosedMembershipReadInput, observedScope: unknown, bytes: unknown
): LiveJournalClosedMembershipReadResult {
	try {
		const observed = scope(observedScope, input.scope.objectId);
		if (observed.epoch !== input.scope.epoch || observed.anchorDigest !== input.scope.anchorDigest)
			return fail("store-poisoned");
		if (bytes === undefined || bytes === null) return Object.freeze({ok: true, kind: "missing"});
		const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
		if (Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)?.get?.call(bytes) !== "Uint8Array")
			return fail("store-poisoned");
		const size = Object.getOwnPropertyDescriptor(typed, "byteLength")!.get!.call(bytes) as number;
		if (size === 0 || size > LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes) return fail("store-poisoned");
		if (size > input.maxBytes) return Object.freeze({ok: false, kind: "read-budget-exceeded"});
		const buffer = Object.getOwnPropertyDescriptor(typed, "buffer")!.get!.call(bytes) as ArrayBuffer;
		const offset = Object.getOwnPropertyDescriptor(typed, "byteOffset")!.get!.call(bytes) as number;
		Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!.call(buffer);
		return Object.freeze({ok: true, kind: "present", scope: observed,
			exactCanonicalMembershipBytes: new Uint8Array(new Uint8Array(buffer, offset, size))});
	} catch { return fail("store-poisoned"); }
}
/** Captures bounded opaque canonical evidence and mandatory exact native currency.
 * Neither canonical encoding nor this capture authenticates a close certificate. */
export function captureJournalClosedMembershipInput(input: unknown): Readonly<{
	scope: LiveJournalScope;
	exactCanonicalMembershipBytes: Uint8Array;
	expectedNativeImage: Readonly<{ imageDigest: string; controlBytes: Uint8Array | null }>;
}> {
	const r = record(input, ["scope", "exactCanonicalMembershipBytes", "expectedNativeImage"]);
	const selected = record(r.scope, ["objectId", "epoch", "anchorDigest"]);
	const objectId = captureJournalRetirementObject({ objectId: selected.objectId });
	const capturedScope = scope(r.scope, objectId);
	const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
	const length = Object.getOwnPropertyDescriptor(typed, "byteLength")?.get;
	const offset = Object.getOwnPropertyDescriptor(typed, "byteOffset")?.get;
	const buffer = Object.getOwnPropertyDescriptor(typed, "buffer")?.get;
	const tag = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)?.get;
	const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
	const copy = (value: unknown, maximum: number): Uint8Array => {
		if (tag?.call(value) !== "Uint8Array") throw new TypeError("malformed-input");
		const size = length?.call(value) as number,
			start = offset?.call(value) as number;
		const storage = buffer?.call(value) as ArrayBuffer;
		arrayBufferLength?.call(storage);
		if (size === 0 || size > maximum) throw new TypeError("malformed-input");
		return new Uint8Array(new Uint8Array(storage, start, size));
	};
	const bytes = copy(r.exactCanonicalMembershipBytes, LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes);
	const limits = { maxBytes: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes, maxItems: 65_536, maxDepth: 32 };
	const decoded = decodeCanonical(bytes, limits);
	if (!equalNative(bytes, encodeCanonical(decoded, limits))) throw new TypeError("malformed-input");
	const expected = record(r.expectedNativeImage, ["imageDigest", "controlBytes"]);
	const controlBytes =
		expected.controlBytes === null ? null : copy(expected.controlBytes, LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES);
	if (controlBytes !== null && decodeJournalRetirementControl(controlBytes).objectId !== objectId)
		throw new TypeError("malformed-input");
	return Object.freeze({
		scope: capturedScope,
		exactCanonicalMembershipBytes: bytes,
		expectedNativeImage: Object.freeze({ imageDigest: digest(expected.imageDigest), controlBytes }),
	});
}
/** One additive encoding transition for interrupted received-close retries. The
 * original canonical membership remains byte-for-byte inside the new envelope.
 * This mechanical preservation check grants no authority to either record. */
export function journalClosedMembershipCanExtend(existing: Uint8Array, proposed: Uint8Array): boolean {
	try {
		const limits = { maxBytes: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes, maxItems: 65_536, maxDepth: 32 };
		if (existing.byteLength === 0 || proposed.byteLength === 0 ||
			existing.byteLength > limits.maxBytes || proposed.byteLength > limits.maxBytes) return false;
		const original = decodeCanonical(existing, limits);
		const extended = record(decodeCanonical(proposed, limits), ["kind", "exactCanonicalMembershipBytes",
			"exactCanonicalCutValueBytes", "exactCanonicalCommitQcBytes", "exactCanonicalSuccessorTrustStateRecordBytes"]);
		if (original === null || typeof original !== "object" || Array.isArray(original) ||
			Reflect.get(original, "kind") !== "creator-close-membership-1" ||
			extended.kind !== "creator-received-close-membership-1" ||
			!equalNative(existing, encodeCanonical(original, limits)) ||
			!equalNative(proposed, encodeCanonical(extended, limits))) return false;
		return extended.exactCanonicalMembershipBytes instanceof Uint8Array &&
			equalNative(existing, extended.exactCanonicalMembershipBytes) &&
			[extended.exactCanonicalCutValueBytes, extended.exactCanonicalCommitQcBytes,
				extended.exactCanonicalSuccessorTrustStateRecordBytes].every(value =>
				value instanceof Uint8Array && value.byteLength > 0);
	} catch { return false; }
}
const scopeKey = (s: LiveJournalScope): string => `${s.epoch.toString().padStart(16, "0")}:${s.anchorDigest}`;
/**
 * Captures one bounded mechanical frontier; digests are not protocol permission.
 * @param value - Untrusted preparation record.
 * @param objectId - Exact addressed native object.
 * @returns The detached preparation and sorted protected holes.
 */
export function captureJournalRetirementPreparation(
	value: unknown,
	objectId: string
): LiveJournalRetirementPreparation {
	const r = record(value, ["decisionDigest", "sourceProofDigest", "throughEpoch", "protectedScopes"]);
	const throughEpoch = integer(r.throughEpoch);
	const array = r.protectedScopes;
	if (!Array.isArray(array) || Object.getPrototypeOf(array) !== Array.prototype) throw new TypeError("malformed-input");
	const size = Object.getOwnPropertyDescriptor(array, "length")?.value;
	if (
		!Number.isSafeInteger(size) ||
		size > LIVE_JOURNAL_RETIREMENT_LIMITS.maxScopes ||
		Reflect.ownKeys(array).length !== size + 1
	)
		throw new TypeError("malformed-input");
	const protectedScopes: LiveJournalScope[] = [];
	for (let i = 0; i < size; i++) {
		const d = Object.getOwnPropertyDescriptor(array, String(i));
		if (d === undefined || !("value" in d) || !d.enumerable) throw new TypeError("malformed-input");
		const s = scope(d.value, objectId);
		const prior = protectedScopes[i - 1];
		if (s.epoch > throughEpoch || (prior !== undefined && scopeKey(s) <= scopeKey(prior)))
			throw new TypeError("malformed-input");
		protectedScopes.push(s);
	}
	return Object.freeze({
		decisionDigest: digest(r.decisionDigest),
		sourceProofDigest: digest(r.sourceProofDigest),
		throughEpoch,
		protectedScopes: Object.freeze(protectedScopes),
	});
}
/**
 * Validates a complete native control and its monotone frontier relationship.
 * @param value - Decoded native control.
 * @returns The detached complete control.
 */
/** Original native control fields, without validation or a retirement grant. */
export function journalRetirementControlFields<O, I, R, S, A, C, D>(input: Readonly<{
	version2: boolean; objectId: O; incarnation: I; revision: R; sequence: S; active: A; completed: C; drain: D;
}>) {
	return {kind: input.version2 ? "v3-live-journal-retirement-control-2" as const : "v3-live-journal-retirement-control-1" as const,
		objectId: input.objectId, incarnation: input.incarnation, revision: input.revision, sequence: input.sequence,
		active: input.active, completed: input.completed, ...(input.version2 ? {drain: input.drain} : {})};
}
export function captureJournalRetirementControl(value: unknown): LiveJournalRetirementControl {
	return captureJournalRetirementControlWithPlan(value);
}
// Only private one-use transitions may supply their own captured plan. Public
// inputs, fresh native reads and decoders always take the complete capture path.
// The retained plan has detached byte leaves and never escapes through view.control.
function captureJournalRetirementControlWithPlan(
	value: unknown,
	capturedPlan?: LiveJournalRetirementDrainPlan
): LiveJournalRetirementControl {
	const kind =
		value !== null && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "kind")?.value : undefined;
	const version2 = kind === "v3-live-journal-retirement-control-2";
	const r = record(value, [
		"kind",
		"objectId",
		"incarnation",
		"revision",
		"sequence",
		"active",
		"completed",
		...(version2 ? ["drain"] : []),
	]);
	const objectId = captureJournalRetirementObject({ objectId: r.objectId });
	if (r.kind !== "v3-live-journal-retirement-control-1" && !version2) throw new TypeError("malformed-input");
	const sequence = integer(r.sequence);
	const completed = r.completed === null ? null : captureJournalRetirementPreparation(r.completed, objectId);
	let active: LiveJournalRetirementControl["active"] = null;
	if (r.active !== null) {
		const a = record(r.active, ["sequence", "preparation"]);
		if (integer(a.sequence) !== sequence || sequence === 0) throw new TypeError("malformed-input");
		active = Object.freeze({ sequence, preparation: captureJournalRetirementPreparation(a.preparation, objectId) });
	}
	if (active !== null && completed !== null && !frontierAdvanceAllowed(completed, active.preparation))
		throw new TypeError("malformed-input");
	const control: LiveJournalRetirementControl = Object.freeze(journalRetirementControlFields({
		version2,
		objectId,
		incarnation: digest(r.incarnation),
		revision: integer(r.revision),
		sequence,
		active,
		completed,
		drain: version2 && r.drain !== null ? captureJournalRetirementDrainState(r.drain, capturedPlan) : null,
	}));
	if (control.drain != null) {
		const state = control.drain,
			base = state.plan.baseControl;
		const terminal = journalRetirementDrainItemCount(state.plan);
		const revision = base.revision + 1 + state.batches;
		if (
			!Number.isSafeInteger(revision) ||
			base.objectId !== control.objectId ||
			base.incarnation !== control.incarnation ||
			control.revision < revision ||
			control.sequence < base.sequence ||
			control.completed === null ||
			base.completed === null ||
			!frontierAdvanceAllowed(base.completed, control.completed)
		)
			throw new TypeError("malformed-input");
		if (
			state.cursor < terminal &&
			(control.active !== null ||
				control.revision !== revision ||
				control.sequence !== base.sequence ||
				!equalNative(control.completed, base.completed))
		)
			throw new TypeError("malformed-input");
	}
	return control;
}

function equalNative(left: unknown, right: unknown): boolean {
	const a = encodeCanonical(left),
		b = encodeCanonical(right);
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
function dense(value: unknown, maximum: number): readonly unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError("malformed-input");
	const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (!Number.isSafeInteger(length) || length > maximum || Reflect.ownKeys(value).length !== length + 1)
		throw new TypeError("malformed-input");
	const owned: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
			throw new TypeError("malformed-input");
		owned.push(descriptor.value);
	}
	return owned;
}
function captureImage(value: unknown): LiveJournalRetirementImage {
	const r = record(value, ["imageDigest", "scopeCount", "rowCount", "byteCharge"]);
	const image = Object.freeze({
		imageDigest: digest(r.imageDigest),
		scopeCount: integer(r.scopeCount),
		rowCount: integer(r.rowCount),
		byteCharge: integer(r.byteCharge),
	});
	if (
		!journalRetirementImageCountsFit(image.scopeCount, image.rowCount) ||
		image.byteCharge > LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes
	)
		throw new TypeError("malformed-input");
	return image;
}
/** Captures bounded native descriptors; neither this plan nor its digests authenticate eligibility. */
export function captureJournalRetirementDrainPlan(value: unknown): LiveJournalRetirementDrainPlan {
	const hasHeaders = value !== null && typeof value === "object" && Object.hasOwn(value, "retiredEmptyHeaders");
	const r = record(value, ["baseControl", "sourceImage", "prefixes", ...(hasHeaders ? ["retiredEmptyHeaders", "protectedHeaderScopes"] : [])]);
	// Reject nesting BEFORE recursion: completed prior manifests clear at the next
	// authenticated commit, not by retaining an ever-growing checkpoint chain.
	const baseKind =
		r.baseControl !== null && typeof r.baseControl === "object"
			? Object.getOwnPropertyDescriptor(r.baseControl, "kind")?.value
			: undefined;
	const baseRaw = record(r.baseControl, [
		"kind",
		"objectId",
		"incarnation",
		"revision",
		"sequence",
		"active",
		"completed",
		...(baseKind === "v3-live-journal-retirement-control-2" ? ["drain"] : []),
	]);
	if (
		baseRaw.active !== null ||
		baseRaw.completed === null ||
		(baseKind === "v3-live-journal-retirement-control-2" && baseRaw.drain !== null)
	)
		throw new TypeError("malformed-input");
	const baseControl = captureJournalRetirementControl(r.baseControl),
		sourceImage = captureImage(r.sourceImage);
	if (baseControl.completed === null) throw new TypeError("malformed-input");
	let count = 0,
		charge = encodeJournalRetirementControl(baseControl).byteLength;
	const prefixes: LiveJournalRetirementLocalPrefix[] = [];
	for (const item of dense(r.prefixes, LIVE_JOURNAL_RETIREMENT_LIMITS.maxScopes)) {
		const p = record(item, ["scope", "highWatermark", "rows"]),
			selected = scope(p.scope, baseControl.objectId);
		const highWatermark = integer(p.highWatermark),
			prior = prefixes.at(-1);
		if (
			highWatermark === 0 ||
			highWatermark > LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows ||
			selected.epoch > baseControl.completed.throughEpoch ||
			journalRetirementAllows(baseControl, selected) ||
			(prior !== undefined && scopeKey(selected) <= scopeKey(prior.scope))
		)
			throw new TypeError("malformed-input");
		const rows: LiveJournalRetirementLocalPrefix["rows"][number][] = [];
		for (const raw of dense(p.rows, LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows - count)) {
			const received =
				raw !== null &&
				typeof raw === "object" &&
				Object.getOwnPropertyDescriptor(raw, "exactCanonicalNativeFrameBytes") !== undefined;
			const row = record(raw, [
				"journalSequence",
				"vertexDigest",
				"author",
				"authorSequence",
				"nativeFrameDigest",
				...(received ? ["exactCanonicalNativeFrameBytes"] : []),
			]);
			if (
				typeof row.author !== "string" ||
				row.author.length === 0 ||
				row.author.length > 1024 ||
				row.author.includes("\0")
			)
				throw new TypeError("malformed-input");
			const metadata = Object.freeze({
				journalSequence: integer(row.journalSequence),
				vertexDigest: digest(row.vertexDigest),
				author: row.author,
				authorSequence: integer(row.authorSequence),
				nativeFrameDigest: digest(row.nativeFrameDigest),
			});
			const owned = received
				? Object.freeze({
						...metadata,
						exactCanonicalNativeFrameBytes: captureReceivedDrainFrame(
							{ scope: selected, row: metadata },
							row.exactCanonicalNativeFrameBytes
						),
					})
				: metadata;
			charge += journalRetirementRowCharge(owned);
			if (owned.journalSequence !== rows.length || charge > LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes)
				throw new TypeError("malformed-input");
			rows.push(owned);
			count++;
		}
		if (rows.length !== highWatermark) throw new TypeError("malformed-input");
		prefixes.push(Object.freeze({ scope: selected, highWatermark, rows: Object.freeze(rows) }));
	}
	const retiredEmptyHeaders: JournalRetirementDrainHeader[] = [];
	const protectedHeaderScopes: LiveJournalScope[] = [];
	if (hasHeaders) {
		// The role/prefix ceiling is not a complete certificate-chain ceiling.
		// Reuse the original aggregate native-item/image bounds, without truncation.
		for (const raw of dense(r.protectedHeaderScopes, LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows)) {
			const fields = record(raw, ["objectId", "epoch", "anchorDigest"]);
			const selected = scope(fields, captureJournalRetirementObject({ objectId: fields.objectId }));
			if (protectedHeaderScopes.some(prior => prior.objectId === selected.objectId && scopeKey(prior) === scopeKey(selected))) throw new TypeError("malformed-input");
			protectedHeaderScopes.push(selected);
		}
		for (const raw of dense(r.retiredEmptyHeaders, LIVE_JOURNAL_RETIREMENT_BATCH_ROWS)) {
			const entry = record(raw, ["scope", "exactCanonicalNativeFrameBytes"]);
			const selected = scope(entry.scope, baseControl.objectId);
			if (selected.epoch === 0 || journalRetirementAllows(baseControl, selected) ||
				protectedHeaderScopes.some(p => p.objectId === selected.objectId && scopeKey(p) === scopeKey(selected)) ||
				prefixes.some(p => scopeKey(p.scope) === scopeKey(selected)) ||
				retiredEmptyHeaders.some(p => scopeKey(p.scope) === scopeKey(selected))) throw new TypeError("malformed-input");
			const bytes = captureEmptyHeaderFrame(selected, entry.exactCanonicalNativeFrameBytes);
			charge += bytes.byteLength;
			if (charge > LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes) throw new TypeError("malformed-input");
			retiredEmptyHeaders.push(Object.freeze({ scope: selected, exactCanonicalNativeFrameBytes: bytes }));
		}
	}
	if ((prefixes.length === 0 && retiredEmptyHeaders.length === 0) || prefixes.length + retiredEmptyHeaders.length > sourceImage.scopeCount || count > sourceImage.rowCount)
		throw new TypeError("malformed-input");
	const plan = Object.freeze({ baseControl, sourceImage, prefixes: Object.freeze(prefixes), ...(hasHeaders ? {
		retiredEmptyHeaders: Object.freeze(retiredEmptyHeaders), protectedHeaderScopes: Object.freeze(protectedHeaderScopes)
	} : {}) });
	encodeCanonical(plan, { maxBytes: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes, maxItems: 65_536, maxDepth: 32 });
	return plan;
}
function captureJournalRetirementDrainState(
	value: unknown,
	capturedPlan?: LiveJournalRetirementDrainPlan
): LiveJournalRetirementDrainState {
	const r = record(value, ["plan", "cursor", "batches", "residualImageDigest"]);
	if (capturedPlan !== undefined && r.plan !== capturedPlan) throw new TypeError("malformed-input");
	const plan = capturedPlan ?? captureJournalRetirementDrainPlan(r.plan),
		cursor = integer(r.cursor),
		batches = integer(r.batches);
	const terminal = journalRetirementDrainItemCount(plan);
	if (
		cursor > terminal ||
		batches > cursor ||
		(cursor === 0) !== (batches === 0) ||
		cursor !== Math.min(terminal, batches * LIVE_JOURNAL_RETIREMENT_BATCH_ROWS)
	)
		throw new TypeError("malformed-input");
	return Object.freeze({ plan, cursor, batches, residualImageDigest: digest(r.residualImageDigest) });
}
export type JournalRetirementDrainRow = Readonly<{
	scope: LiveJournalScope;
	row: LiveJournalRetirementLocalPrefix["rows"][number];
}>;
export type JournalRetirementDrainHeader = Readonly<{ scope: LiveJournalScope; exactCanonicalNativeFrameBytes: Uint8Array }>;
export type JournalRetirementDrainItem = JournalRetirementDrainRow | JournalRetirementDrainHeader;
export function journalRetirementDrainItemCount(plan: LiveJournalRetirementDrainPlan): number {
	return plan.prefixes.reduce((n, p) => n + p.rows.length, 0) + (plan.retiredEmptyHeaders?.length ?? 0);
}
function drainItems(plan: LiveJournalRetirementDrainPlan): readonly JournalRetirementDrainItem[] {
	return [...drainRows(plan), ...(plan.retiredEmptyHeaders ?? [])];
}
function drainRows(plan: LiveJournalRetirementDrainPlan): readonly JournalRetirementDrainRow[] {
	return plan.prefixes.flatMap((prefix) => prefix.rows.map((row) => ({ scope: prefix.scope, row })));
}
/** Exact native frame commitment; not a protocol vertex digest or permission. */
export function journalRetirementFrameDigest(bytes: Uint8Array): string {
	return Array.from(hashDomain("ts-drp/live-journal-retirement-frame/v1", bytes), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
}
function frontierAdvanceAllowed(
	prior: LiveJournalRetirementPreparation,
	next: LiveJournalRetirementPreparation
): boolean {
	return (
		next.throughEpoch >= prior.throughEpoch &&
		next.protectedScopes.every(
			(s) => s.epoch > prior.throughEpoch || prior.protectedScopes.some((p) => scopeKey(p) === scopeKey(s))
		)
	);
}
const maximumObject = "\u0800".repeat(1024);
const maximumPreparation = {
	decisionDigest: "f".repeat(64),
	sourceProofDigest: "f".repeat(64),
	throughEpoch: Number.MAX_SAFE_INTEGER,
	protectedScopes: Array.from({ length: LIVE_JOURNAL_RETIREMENT_LIMITS.maxScopes }, (_, i) => ({
		objectId: maximumObject,
		epoch: Number.MAX_SAFE_INTEGER,
		anchorDigest: i.toString(16).padStart(64, "0"),
	})),
};
const maximumControl = {
	kind: "v3-live-journal-retirement-control-1",
	objectId: maximumObject,
	incarnation: "f".repeat(64),
	revision: Number.MAX_SAFE_INTEGER,
	sequence: Number.MAX_SAFE_INTEGER,
	active: { sequence: Number.MAX_SAFE_INTEGER, preparation: maximumPreparation },
	completed: maximumPreparation,
};
export const LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES = Math.max(
	encodeCanonical(maximumControl).byteLength,
	LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes
);
/**
 * Encodes the complete validated durable control.
 * @param value - Owned control postimage.
 * @returns Exact canonical control bytes.
 */
export function encodeJournalRetirementControl(value: LiveJournalRetirementControl): Uint8Array {
	return encodeCapturedJournalRetirementControl(captureJournalRetirementControl(value));
}
// Private synchronous consumers have just captured every field and detached all
// mutable bytes. Re-encoding that representation must not recapture the complete
// received-row plan. Public encoders still capture untrusted inputs above/below.
function encodeCapturedJournalRetirementControl(value: LiveJournalRetirementControl): Uint8Array {
	return encodeCanonical(value, {
		maxBytes: LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES,
		maxItems: 65_536,
		maxDepth: 32,
	});
}

/** Structural fields only; the native codec independently validates their values.
 * Shared with bounded width composition, never an executable authorization. */
export function journalRetirementNativeProgressFields<T extends object>(
	base: T,
	planDigest: unknown,
	planByteLength: unknown,
	cursor: unknown,
	batches: unknown,
	residualImageDigest: unknown
) {
	return Object.freeze({
		...base,
		kind: "v3-live-journal-retirement-native-control-1" as const,
		drain: Object.freeze({ planDigest, planByteLength, cursor, batches, residualImageDigest }),
	});
}

function nativePlanDigest(bytes: Uint8Array): string {
	return Array.from(hashDomain("ts-drp/live-journal-retirement-native-plan/v1", bytes), (b) =>
		b.toString(16).padStart(2, "0")
	).join("");
}

/** Complete actual durable carriers; the immutable plan is never nested in progress. */
export function encodeJournalRetirementNativeCarriers(value: LiveJournalRetirementControl): Readonly<{
	controlBytes: Uint8Array;
	planBytes?: Uint8Array;
}> {
	return encodeCapturedJournalRetirementNativeCarriers(captureJournalRetirementControl(value));
}
type CapturedNativePlanSyntax = Readonly<{
	bytes: Uint8Array;
	digest: string;
	plan: LiveJournalRetirementDrainPlan;
}>;
function encodeCapturedJournalRetirementNativeCarriers(
	own: LiveJournalRetirementControl,
	planSyntax?: CapturedNativePlanSyntax
): Readonly<{
	controlBytes: Uint8Array;
	planBytes?: Uint8Array;
}> {
	if (own.drain == null) return Object.freeze({ controlBytes: encodeCapturedJournalRetirementControl(own) });
	const state = own.drain;
	const limits = { maxBytes: LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES, maxItems: 65_536, maxDepth: 32 };
	const unchanged = planSyntax !== undefined && state.plan === planSyntax.plan;
	// Neither public carrier arrays nor adapter callbacks may mutate the retained
	// syntax fact. Its only strong owner is the bounded native codec below.
	const planBytes = unchanged ? planSyntax.bytes.slice() : encodeCanonical(state.plan, limits);
	const controlBytes = encodeCanonical(
		journalRetirementNativeProgressFields(
			own,
			unchanged ? planSyntax.digest : nativePlanDigest(planBytes),
			planBytes.byteLength,
			state.cursor,
			state.batches,
			state.residualImageDigest
		),
		limits
	);
	if (planBytes.byteLength + controlBytes.byteLength > LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES)
		throw new TypeError("malformed-input");
	return Object.freeze({ controlBytes, planBytes });
}

/** Validates BOTH canonical carriers before materializing the logical control. */
export function decodeJournalRetirementNativeCarriers(
	controlBytes: unknown,
	planBytes?: unknown
): LiveJournalRetirementControl {
	return decodeCapturedJournalRetirementNativeCarriers(controlBytes, planBytes);
}
function decodeCapturedJournalRetirementNativeCarriers(
	controlBytes: unknown,
	planBytes?: unknown,
	syntax?: {plan?: CapturedNativePlanSyntax | undefined}
): LiveJournalRetirementControl {
	const capture = (value: unknown): Uint8Array => {
		if (
			!(value instanceof Uint8Array) ||
			(typeof SharedArrayBuffer !== "undefined" && value.buffer instanceof SharedArrayBuffer) ||
			value.byteLength === 0 ||
			value.byteLength > LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES
		)
			throw new TypeError("store-poisoned");
		return new Uint8Array(value);
	};
	const bytes = capture(controlBytes);
	// Bytes already verified as a complete legacy (non-native) control take the
	// same branch below without decoding them twice more.
	const verified = verifiedJournalControl(bytes);
	if (verified !== undefined) {
		if (planBytes !== undefined) throw new TypeError("store-poisoned");
		if (verified.drain != null) throw new TypeError("store-poisoned");
		if (syntax !== undefined) syntax.plan = undefined;
		return verified;
	}
	const raw = decodeCanonical(bytes);
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("store-poisoned");
	if ((raw as { kind?: unknown }).kind !== "v3-live-journal-retirement-native-control-1") {
		if (planBytes !== undefined) throw new TypeError("store-poisoned");
		const control = decodeJournalRetirementControl(bytes);
		// Inline checkpoints belong only to the explicit persisted-schema migration.
		if (control.drain != null) throw new TypeError("store-poisoned");
		if (syntax !== undefined) syntax.plan = undefined;
		return control;
	}
	const fields = record(raw, [
		"kind",
		"objectId",
		"incarnation",
		"revision",
		"sequence",
		"active",
		"completed",
		"drain",
	]);
	const progress = record(fields.drain, ["planDigest", "planByteLength", "cursor", "batches", "residualImageDigest"]);
	const plan = capture(planBytes);
	const previous = syntax?.plan;
	const unchanged = previous !== undefined && plan.length === previous.bytes.length &&
		plan.every((byte, index) => byte === previous.bytes[index]);
	const planDigest = unchanged ? previous.digest : nativePlanDigest(plan);
	if (
		bytes.byteLength + plan.byteLength > LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES ||
		integer(progress.planByteLength) !== plan.byteLength ||
		digest(progress.planDigest) !== planDigest
	)
		throw new TypeError("store-poisoned");
	const capturedPlan = unchanged ? previous.plan : captureJournalRetirementDrainPlan(decodeCanonical(plan));
	if (!unchanged) {
		const encoded = encodeCanonical(capturedPlan, {
			maxBytes: LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES, maxItems: 65_536, maxDepth: 32,
		});
		if (encoded.length !== plan.length || !plan.every((byte, index) => byte === encoded[index]))
			throw new TypeError("store-poisoned");
	}
	const capturedSyntax = unchanged ? previous : Object.freeze({bytes: plan, digest: planDigest, plan: capturedPlan});
	const control = captureJournalRetirementControlWithPlan({
		...fields,
		kind: "v3-live-journal-retirement-control-2",
		drain: {
			plan: capturedPlan,
			cursor: progress.cursor,
			batches: progress.batches,
			residualImageDigest: progress.residualImageDigest,
		},
	}, capturedPlan);
	// The complete input plan already matched either the private exact capture
	// or its freshly validated canonical roundtrip above. Re-encoding a logical
	// control merely to copy that SAME plan back out and compare it again adds a
	// full-buffer pass on every progress/fence read. Only changing progress owes
	// another roundtrip here; no plan bytes or plan validation are omitted.
	const encoded = encodeCanonical(journalRetirementNativeProgressFields(
		control, capturedSyntax.digest, capturedSyntax.bytes.byteLength,
		control.drain!.cursor, control.drain!.batches, control.drain!.residualImageDigest
	), {maxBytes: LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES, maxItems: 65_536, maxDepth: 32});
	if (
		bytes.length !== encoded.length ||
		!bytes.every((byte, index) => byte === encoded[index])
	)
		throw new TypeError("store-poisoned");
	if (syntax !== undefined) syntax.plan = capturedSyntax;
	return control;
}

/** One native store's bounded syntax reuse, never admission/retirement authority.
 * Fresh carriers must be read by the adapter on every original native boundary.
 * Only one exact plan and the latest detached control observation are retained;
 * different bytes/context, malformed input, terminal compaction or release evict it.
 * No signatures, native currency, resource charges or physical images are cached.
 */
export function createJournalRetirementControlCodec() {
	const syntax: {plan?: CapturedNativePlanSyntax | undefined} = {};
	let latest: Readonly<{exposed: LiveJournalRetirementControl; own: LiveJournalRetirementControl}> | undefined;
	let released = false;
	const available = (): void => {if (released) throw new TypeError("retirement-released");};
	const clear = (): void => {syntax.plan = undefined; latest = undefined;};
	const decodeOwned = (controlBytes: unknown, planBytes?: unknown): LiveJournalRetirementControl => {
		available();
		try { return decodeCapturedJournalRetirementNativeCarriers(controlBytes, planBytes, syntax); }
		catch (error) {clear(); throw error;}
	};
	const owned = (value: LiveJournalRetirementControl): LiveJournalRetirementControl => {
		available();
		if (latest?.exposed === value && unchangedCapturedPlanLeaves(value, latest.own)) return latest.own;
		return captureJournalRetirementControl(value);
	};
	return Object.freeze({
		decode(controlBytes: unknown, planBytes?: unknown): LiveJournalRetirementControl {
			const own = decodeOwned(controlBytes, planBytes);
			const exposed = detachCapturedJournalRetirementControl(own);
			latest = Object.freeze({exposed, own});
			return exposed;
		},
		/** Native replay needs the current fence decision, not an exposed clone of
		 * every immutable drain row. Decode every fresh control, validate exact plan
		 * bytes, and keep the private plan within this SAME bounded codec owner. */
		readFence(controlBytes: unknown, planBytes: unknown, selected: LiveJournalScope): Readonly<{objectId: string; allowed: boolean}> {
			const own = decodeOwned(controlBytes, planBytes);
			return Object.freeze({objectId: own.objectId, allowed: journalRetirementAllows(own, selected)});
		},
		encode(value: LiveJournalRetirementControl) {
			return encodeCapturedJournalRetirementNativeCarriers(owned(value), syntax.plan);
		},
		createRead(
			control: LiveJournalRetirementControl,
			image: LiveJournalRetirementImage,
			compare: Parameters<typeof createJournalRetirementControlRead>[2],
			frames: readonly Uint8Array[],
			drainSource?: LiveJournalRetirementDrainSource
		): LiveJournalRetirementControlRead {
			return createCapturedJournalRetirementControlRead(owned(control), image, compare, frames, drainSource, syntax.plan);
		},
		clear(): void {clear();},
		release(): void {released = true; clear();},
	});
}

// All enclosing objects/arrays and non-byte fields in a genuine exposed control
// are frozen by capture. Only these detached real typed-array leaves can change.
// Compare native lengths (not caller-overridden properties or iterators).
function unchangedCapturedPlanLeaves(exposed: LiveJournalRetirementControl, own: LiveJournalRetirementControl): boolean {
	if (own.drain == null) return true;
	const length = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")!.get!;
	const same = (left: Uint8Array | undefined, right: Uint8Array | undefined): boolean => {
		if (left === undefined || right === undefined) return left === right;
		const size = length.call(left) as number;
		if (size !== length.call(right)) return false;
		for (let i = 0; i < size; i++) if (left[i] !== right[i]) return false;
		return true;
	};
	const a = exposed.drain!.plan, b = own.drain.plan;
	for (let p = 0; p < b.prefixes.length; p++)
		for (let r = 0; r < b.prefixes[p]!.rows.length; r++)
			if (!same(a.prefixes[p]!.rows[r]!.exactCanonicalNativeFrameBytes,
				b.prefixes[p]!.rows[r]!.exactCanonicalNativeFrameBytes)) return false;
	for (let h = 0; h < (b.retiredEmptyHeaders?.length ?? 0); h++)
		if (!same(a.retiredEmptyHeaders![h]!.exactCanonicalNativeFrameBytes,
			b.retiredEmptyHeaders![h]!.exactCanonicalNativeFrameBytes)) return false;
	return true;
}
/**
 * Checks the bounded native carrier and exact canonical round trip.
 * @param value - Native binary record.
 * @returns The validated owned control.
 */
export function decodeJournalRetirementControl(value: unknown): LiveJournalRetirementControl {
	if (
		!(value instanceof Uint8Array) ||
		(typeof SharedArrayBuffer !== "undefined" && value.buffer instanceof SharedArrayBuffer) ||
		value.byteLength > LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES
	)
		throw new TypeError("store-poisoned");
	const own = new Uint8Array(value);
	const known = knownJournalControl(own);
	// A hit is the verification of byte-identical input; each caller still
	// receives its own complete capture with detached byte leaves.
	if (known !== undefined) return captureJournalRetirementControl(known);
	const control = captureJournalRetirementControl(decodeCanonical(own));
	const encoded = encodeCapturedJournalRetirementControl(control);
	if (own.length !== encoded.length) throw new TypeError("store-poisoned");
	for (let index = 0; index < own.length; index++) if (own[index] !== encoded[index]) throw new TypeError("store-poisoned");
	rememberJournalControl(own, captureJournalRetirementControl(control));
	return control;
}
/** Verify-once decode + canonical re-encode of exact journal control bytes. */
function verifiedJournalControl(bytes: Uint8Array): LiveJournalRetirementControl | undefined {
	const known = knownJournalControl(bytes);
	return known === undefined ? undefined : captureJournalRetirementControl(known);
}
// Bounded verify-once cache: private copies of verified control bytes, most
// recent last. Every hit requires full byte equality, so the cached value is
// always the verification of exactly the presented bytes; no invalidation is
// needed because the verification is a pure function of those bytes.
const VERIFIED_JOURNAL_CONTROL_ENTRIES = 64,
	VERIFIED_JOURNAL_CONTROL_BYTES = 2 * 1024 * 1024;
const verifiedJournalControls: { readonly bytes: Uint8Array; readonly control: LiveJournalRetirementControl }[] = [];
let verifiedJournalControlBytes = 0;
function knownJournalControl(bytes: Uint8Array): LiveJournalRetirementControl | undefined {
	search: for (let index = verifiedJournalControls.length - 1; index >= 0; index--) {
		const entry = verifiedJournalControls[index]!;
		if (entry.bytes.length !== bytes.length) continue;
		for (let at = 0; at < bytes.length; at++) if (entry.bytes[at] !== bytes[at]) continue search;
		if (index !== verifiedJournalControls.length - 1) verifiedJournalControls.push(...verifiedJournalControls.splice(index, 1));
		return entry.control;
	}
	return undefined;
}
function rememberJournalControl(bytes: Uint8Array, control: LiveJournalRetirementControl): void {
	if (bytes.length > LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES) return;
	verifiedJournalControls.push({ bytes: bytes.slice(), control });
	verifiedJournalControlBytes += bytes.length;
	while (
		verifiedJournalControls.length > VERIFIED_JOURNAL_CONTROL_ENTRIES ||
		verifiedJournalControlBytes > VERIFIED_JOURNAL_CONTROL_BYTES
	)
		verifiedJournalControlBytes -= verifiedJournalControls.shift()!.bytes.length;
}
/**
 * Applies both the active fence and permanent frontier to an exact scope.
 * @param control - Actual native object control, or absent birth.
 * @param selected - The original operation scope.
 * @returns Whether the mechanical native fence permits this scope.
 */
export function journalRetirementAllows(
	control: LiveJournalRetirementControl | null,
	selected: LiveJournalScope
): boolean {
	const allows = (p: LiveJournalRetirementPreparation | null): boolean =>
		p === null ||
		selected.epoch > p.throughEpoch ||
		p.protectedScopes.some((s) => s.objectId === selected.objectId && scopeKey(s) === scopeKey(selected));
	return (
		control === null ||
		(control.objectId === selected.objectId && allows(control.completed) && allows(control.active?.preparation ?? null))
	);
}
/** Incomplete physical maintenance backpressures mutations, not protected reads.
 * The original owner must finish its finite checkpoint before ordinary writes resume. */
export function journalRetirementMutationAllows(
	control: LiveJournalRetirementControl | null,
	selected: LiveJournalScope
): boolean {
	return (
		journalRetirementAllows(control, selected) &&
		(control?.drain == null || control.drain.cursor === journalRetirementDrainItemCount(control.drain.plan))
	);
}
/**
 * Advances the durable revision without changing its retirement decision.
 * @param control - Actual native preimage.
 * @returns A fresh next revision, or exhaustion refusal.
 */
export function advanceJournalRetirementControl(control: LiveJournalRetirementControl): LiveJournalRetirementControl {
	if (control.revision === Number.MAX_SAFE_INTEGER) throw new TypeError("retirement-exhausted");
	return captureJournalRetirementControl({ ...control, revision: control.revision + 1 });
}
/** Genuine journal mutation advances the checkpoint only after a drain is complete. */
export function advanceJournalRetirementMutationControl(
	control: LiveJournalRetirementControl
): LiveJournalRetirementControl {
	return advanceCapturedJournalRetirementMutationControl(captureJournalRetirementControl(control));
}
function advanceCapturedJournalRetirementMutationControl(
	control: LiveJournalRetirementControl
): LiveJournalRetirementControl {
	if (
		control.drain != null &&
		control.drain.cursor < journalRetirementDrainItemCount(control.drain.plan)
	)
		throw new TypeError("retirement-fenced");
	if (control.revision === Number.MAX_SAFE_INTEGER) throw new TypeError("retirement-exhausted");
	return captureJournalRetirementControl({
		...control,
		revision: control.revision + 1,
		...(control.kind === "v3-live-journal-retirement-control-2" ? { drain: null } : {}),
	});
}
function encodeNativeImagePart(value: unknown, limits: Partial<CanonicalLimits>): Uint8Array {
	try {
		return encodeCanonical(value, limits);
	} catch (error) {
		// Only the frozen codec's exact byte-ceiling refusals are budget failures.
		// Malformed canonical values and native/parser failures retain their cause.
		if (
			error instanceof CanonicalEncodingError &&
			(error.message === "canonical value exceeds byte limit" || error.message === "string exceeds byte limit")
		)
			throw new TypeError("retirement-fenced", { cause: error });
		throw error;
	}
}
function nativeScopeEncoding(row: unknown): unknown {
	if (
		typeof row !== "object" ||
		row === null ||
		!Object.hasOwn(row, "object_id") ||
		!Object.hasOwn(row, "next_journal_sequence")
	)
		return row;
	const absent = Object.getOwnPropertyDescriptor(row, "closed_membership_bytes");
	if (absent === undefined || !("value" in absent) || absent.value !== null) return row;
	const descriptors = Object.getOwnPropertyDescriptors(row);
	delete descriptors.closed_membership_bytes;
	return Object.create(Object.getPrototypeOf(row), descriptors) as unknown;
}
/**
 * Commits a complete bounded adapter-native row image, not authentication.
 * @param scopes - Native scope records.
 * @param rows - Native accepted entries.
 * @returns Exact image digest, cardinalities and encoded byte charge.
 */
export function journalRetirementImage(
	scopes: readonly unknown[],
	rows: readonly unknown[]
): LiveJournalRetirementImage {
	if (!journalRetirementImageCountsFit(scopes.length, rows.length)) throw new TypeError("retirement-fenced");
	scopes = scopes.map(nativeScopeEncoding);
	let byteCharge = 0;
	// Charge each bounded native row BEFORE creating the digest/preparation graph.
	for (const row of [...scopes, ...rows]) {
		byteCharge += journalRetirementRowCharge(row);
		if (byteCharge > LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes) throw new TypeError("retirement-fenced");
	}
	const exact = encodeNativeImagePart(
		{ scopes, rows },
		{
			maxBytes: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes,
			maxItems: 1 + (scopes.length + rows.length) * 128,
			maxDepth: 16,
		}
	);
	return retirementImageFromExact(exact, scopes.length, rows.length);
}
function retirementImageFromExact(exact: Uint8Array, scopeCount: number, rowCount: number): LiveJournalRetirementImage {
	return Object.freeze({
		imageDigest: Array.from(hashDomain("ts-drp/live-journal-retirement-image/v1", exact), (b) =>
			b.toString(16).padStart(2, "0")
		).join(""),
		scopeCount,
		rowCount,
		byteCharge: exact.byteLength,
	});
}

/** One adapter-native capture, not a replacement for the public arbitrary-value
 * image functions. Actual native rows are freshly
 * scanned under the ORIGINAL transaction. The codec owns detached syntax only;
 * no input row, lease, authority or paid credit survives finish/release.
 */
export function createJournalRetirementImageCapture(): Readonly<{
	append(table: "scopes" | "accepted_entries" | "acceptedEntries", row: unknown, key?: unknown): Uint8Array | undefined;
	finish(): LiveJournalRetirementImage;
	release(): void;
}> {
	const codec = createCanonicalEncodingCapture(), limit = LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes,
		scopes: CanonicalEncodingCaptureValue[] = [], rows: CanonicalEncodingCaptureValue[] = [];
	let live = true, charged = 0, frameCharge = 0;
	const release = (): void => { live = false; scopes.length = 0; rows.length = 0; codec.release(); };
	const requireLive = (): void => { if (!live) throw new TypeError("retirement-released"); };
	const rethrow = (error: unknown): never => {
		if (error instanceof CanonicalEncodingError &&
			(error.message === "canonical value exceeds byte limit" || error.message === "string exceeds byte limit"))
			throw new TypeError("retirement-fenced", {cause: error});
		throw error;
	};
	return Object.freeze({
		append(table: "scopes" | "accepted_entries" | "acceptedEntries", row: unknown, key?: unknown): Uint8Array | undefined {
			requireLive();
			const target = table === "scopes" ? scopes : rows;
			if (target.length >= LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows) { release(); throw new Error("retirement-fenced"); }
			try {
				const normalized = nativeScopeEncoding(row);
				const chargedRow = codec.capture(normalized,
					{maxBytes: limit, maxItems: 128, maxDepth: 16});
				charged += chargedRow.byteLength;
				if (charged > limit) throw new Error("retirement-fenced");
				// Standalone charges elide exactly one SQL-scope NULL field, even
				// for arbitrary/corrupt accepted values. RAW accepted images and
				// frames do not. Retain that original distinction. Restoring this
				// scalar field changes neither nesting nor the original encoder's
				// checked Array/Map/Set cardinalities. The same 128-item limit is
				// dominated by frame (144) and nonempty image (1+128*N) limits.
				// Normal SQL/IDB entries take one traversal.
				const captured = table === "scopes" || normalized === row ? chargedRow :
					codec.capture(row, {maxBytes: limit, maxItems: 128, maxDepth: 16});
				target.push(captured);
				if (key === undefined) return undefined;
				const frame = codec.encode([table, key, captured], {maxBytes: limit, maxItems: 144, maxDepth: 17});
				frameCharge += frame.byteLength;
				if (frameCharge > limit) throw new Error("retirement-fenced");
				return frame;
			} catch (error) { release(); return rethrow(error); }
		},
		finish(): LiveJournalRetirementImage {
			requireLive();
			try {
				if (!journalRetirementImageCountsFit(scopes.length, rows.length)) throw new TypeError("retirement-fenced");
				// All original standalone charges/frame checks precede RAW-image
				// depth and final byte checks. Reusing syntax never weakens limits.
				const exact = codec.encode({scopes, rows}, {maxBytes: limit,
					maxItems: 1 + (scopes.length + rows.length) * 128, maxDepth: 16});
				return retirementImageFromExact(exact, scopes.length, rows.length);
			} catch (error) { return rethrow(error); }
			finally { release(); }
		},
		release,
	});
}
/**
 * Charges one native row before retaining it in the bounded image.
 * @param row - One native scope or accepted-entry record.
 * @returns Its bounded canonical encoded byte length.
 */
export function journalRetirementRowCharge(row: unknown): number {
	return encodeNativeImagePart(nativeScopeEncoding(row), {
		maxBytes: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes,
		maxItems: 128,
		maxDepth: 16,
	}).byteLength;
}
/**
 * Encodes one original native row and its actual address under the existing image ceiling.
 * @param table - Adapter-native table name.
 * @param key - Actual native primary key.
 * @param row - Exact row from the same native capture as the image commitment.
 * @returns Detached canonical bytes, not authenticated scope permission.
 */
export function journalRetirementCanonicalRow(table: string, key: unknown, row: unknown): Uint8Array {
	return encodeNativeImagePart([table, key, table === "scopes" ? nativeScopeEncoding(row) : row], {
		maxBytes: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes,
		maxItems: 144,
		maxDepth: 17,
	});
}

type NativeFrame = Readonly<{ bytes: Uint8Array; table: string; key: readonly unknown[]; row: unknown }>;

/** Encoded widths, not future image identities, authentication or admission. */
export interface JournalFutureNativeWidths {
	readonly scopeCount: number;
	readonly rowCount: number;
	readonly canonicalRowBytes: readonly number[];
	readonly canonicalRowsBytes: number;
	readonly nativeImageBytes: number;
}
function varUintWidth(value: number): number {
	let width = 1;
	while (value >= 128) {
		value = Math.floor(value / 128);
		width++;
	}
	return width;
}
type FutureWidthFrame = Pick<NativeFrame, "table" | "key" | "row">;

/** Original successor header fields; resource slots neither install a signed
 * header nor establish lineage or a native scope. */
export function journalUnsignedSuccessorHeaderFields<O, E, A, B, P, C>(input: Readonly<{
	sql: boolean; scope: Readonly<{objectId: O; epoch: E; anchorDigest: A}>;
	exactCanonicalAnchorPreimageBytes: B; parametersDigest: P;
	exactCanonicalParametersCarrierBytes: C;
}>): Readonly<Record<string, O | E | A | B | P | C | number>> {
	const s = input;
	return s.sql ? {object_id: s.scope.objectId, epoch: s.scope.epoch, anchor_digest: s.scope.anchorDigest,
		next_journal_sequence: 0, exact_anchor_preimage: s.exactCanonicalAnchorPreimageBytes,
		parameters_digest: s.parametersDigest, exact_parameters_carrier: s.exactCanonicalParametersCarrierBytes}
		: {objectId: s.scope.objectId, epoch: s.scope.epoch, anchorDigest: s.scope.anchorDigest,
			nextJournalSequence: 0, exactCanonicalAnchorPreimageBytes: s.exactCanonicalAnchorPreimageBytes,
			parametersDigest: s.parametersDigest, exactCanonicalParametersCarrierBytes: s.exactCanonicalParametersCarrierBytes};
}
/** Same synchronous forecast only. Frames and rows are privately decoded or
 * newly constructed; replacements get new identities. Schema input snapshots
 * exist only until this invocation returns, with no authority or currency. */
interface FutureWidthMeasurements {
	readonly frames: Map<FutureWidthFrame, { canonical?: number; charged?: number; raw?: number; input?: Uint8Array }>;
	sourceValidated: boolean;
	/** Only the synchronous schema owner's first complete capture. Never caller
	 * facts: the second defensive capture must match every owned input byte. */
	sourceFrames?: readonly NativeFrame[];
	sourceWidths?: JournalFutureNativeWidths;
	sourceUnchanged?: boolean;
}
function futureWidths(
	frames: readonly Pick<NativeFrame, "table" | "key" | "row">[],
	unknownSignatureIndex?: number | readonly number[],
	unknownLocalDigestIndex?: number | readonly number[],
	measurements?: FutureWidthMeasurements
): JournalFutureNativeWidths {
	const indices = (value: number | readonly number[] | undefined): readonly number[] =>
		value === undefined ? [] : typeof value === "number" ? [value] : value;
	const scopes = frames.filter((f) => f.table === "scopes"),
		rows = frames.filter((f) => f.table !== "scopes");
	if (!journalRetirementImageCountsFit(scopes.length, rows.length)) throw new TypeError("retirement-fenced");
	// The missing registered BYTES64 field is measured structurally. No placeholder
	// signature, native row, digest or dedup identity is created for that field.
	const missingField = (index: number, sqlName: string, browserName: string): number => {
		const f = frames[index];
		if (f === undefined || typeof f.row !== "object" || f.row === null) throw new TypeError("malformed-input");
		const n = Object.keys(f.row).length;
		const name = Object.hasOwn(f.row, "object_id") ? sqlName : browserName;
		// Complete BYTES64 / STRING64 field width; no prospective signature or digest value is created.
		return encodeCanonical(name).length + 1 + varUintWidth(64) + 64 + varUintWidth(n + 1) - varUintWidth(n);
	};
	const signatureIndices = indices(unknownSignatureIndex), digestIndices = indices(unknownLocalDigestIndex);
	const missingSignatures = signatureIndices.map(index => missingField(index, "detached_anchor_signature", "detachedAnchorSignature"));
	const missingDigests = digestIndices.map(index => missingField(index, "vertex_digest", "vertexDigest"));
	const missing = missingSignatures.reduce((n, width) => n + width, 0),
		missingDigest = missingDigests.reduce((n, width) => n + width, 0);
	const missingAt = (index: number): number =>
		signatureIndices.reduce((n, at, k) => n + (at === index ? missingSignatures[k]! : 0), 0) +
		digestIndices.reduce((n, at, k) => n + (at === index ? missingDigests[k]! : 0), 0);
	const measured = (frame: FutureWidthFrame) => {
		let value = measurements?.frames.get(frame);
		if (value === undefined) {
			value = {};
			measurements?.frames.set(frame, value);
		}
		return value;
	};
	// Preserve the original validation order: ALL canonical frames, then ALL
	// standalone row charges, then the RAW image (scopes before rows).
	const canonicalRowBytes = frames.map((f, index) => {
		const value = measured(f);
		value.canonical ??= journalRetirementCanonicalRow(f.table, f.key, f.row).length;
		return value.canonical + missingAt(index);
	});
	let rowCharge = 0;
	for (let index = 0; index < frames.length; index++) {
		const frame = frames[index]!, value = measured(frame);
		value.charged ??= journalRetirementRowCharge(frame.row);
		rowCharge += value.charged + missingAt(index);
	}
	const limit = LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes;
	let rawImageBytes: number;
	if (measurements?.sourceValidated) {
		// The original PRE was completely encoded/validated below. Within this
		// call frame count only increases; every changed row gets all original
		// frame/charge checks above and its RAW image checks here. The codec's
		// maxItems bounds each container, not aggregate nodes. Outer arrays have
		// at most N items against 1+128*N; RAW rows stay at image depth 2. Keeping
		// maxDepth 14 here therefore preserves the original image maxDepth 16.
		rawImageBytes = 1 + varUintWidth(2) + encodeCanonical("scopes").length + encodeCanonical("rows").length +
			1 + varUintWidth(scopes.length) + 1 + varUintWidth(rows.length);
		for (const frame of [...scopes, ...rows]) {
			const value = measured(frame);
			value.raw ??= encodeNativeImagePart(frame.row, {
				maxBytes: limit, maxItems: 1 + frames.length * 128, maxDepth: 14,
			}).length;
			rawImageBytes += value.raw;
		}
		if (rawImageBytes > limit)
			throw new TypeError("retirement-fenced", { cause: new CanonicalEncodingError("canonical value exceeds byte limit") });
	} else {
		// Keep the ORIGINAL complete PRE image serialization and all its bounds.
		rawImageBytes = encodeNativeImagePart(
			{ scopes: scopes.map((f) => f.row), rows: rows.map((f) => f.row) },
			{
				maxBytes: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes,
				maxItems: 1 + frames.length * 128,
				maxDepth: 16,
			}
		).length;
	}
	const nativeImageBytes = rawImageBytes + missing + missingDigest;
	if (rowCharge > limit || nativeImageBytes > limit || canonicalRowBytes.reduce((n, length) => n + length, 0) > limit)
		throw new TypeError("retirement-fenced");
	if (measurements !== undefined && !measurements.sourceValidated) {
		// RAW SQLite image rows retain an explicit NULL membership, while the
		// standalone charge/frame encoder omits exactly that field. Reconstruct
		// only its validated structural width, including the 127/128 count edge.
		for (const frame of frames) {
			const value = measured(frame), row = frame.row;
			const normalized = nativeScopeEncoding(row);
			value.raw = value.charged! + (normalized === row ? 0 :
				encodeCanonical("closed_membership_bytes").length + 1 +
				varUintWidth(Object.keys(row as object).length) - varUintWidth(Object.keys(normalized as object).length));
		}
		measurements.sourceValidated = true;
	}
	return Object.freeze({
		scopeCount: scopes.length,
		rowCount: rows.length,
		canonicalRowBytes: Object.freeze(canonicalRowBytes),
		canonicalRowsBytes:
			1 +
			varUintWidth(frames.length) +
			canonicalRowBytes.reduce((n, length) => n + 1 + varUintWidth(length) + length, 0),
		nativeImageBytes,
	});
}

/**
 * Measures the complete original native image after one authenticated received
 * or local-issued append and
 * then one absent successor header install. Backend shape is derived from the
 * genuine current header, not a caller-selected encoding. Control/readout wrappers
 * are separate carriers. Registered signature width is unknown, never a grant.
 * @param actualCanonicalRows - Complete physical frames from the original capture.
 * @param appendCandidate - Original append fields, with real vertex digest. Received
 * bytes undergo the same canonical scope/digest validation as native append;
 * signature authentication remains the admission owner's responsibility.
 * @param unsignedSuccessorInstall - Genuine original install fields without signature.
 * @param successorLocalAppendForSizing - Original terminal fence identity; its future digest remains unknown.
 * @param currentContinuationAppends - Exact prepared local-issued continuation fields, in native issuance order.
 * @param sizingOptions - Optional genuine native lifecycle context and opaque close-carrier byte width only.
 * @returns Complete lengths for each future native point, without bytes or digests.
 */
export function journalFutureAppendPostimageWidths(
	actualCanonicalRows: readonly Uint8Array[],
	appendCandidate: unknown,
	unsignedSuccessorInstall: unknown,
	successorLocalAppendForSizing?: Readonly<{ author: string; authorSequence: number }>,
	currentContinuationAppends: readonly unknown[] = [],
	sizingOptions?: Readonly<{ control?: LiveJournalRetirementControl | null; closedMembershipByteLength?: number;
		localIssuerBasis?: Readonly<{objectId: string; author: string; nextAuthorSequence: number}>;
		/** Also measure the successor's mandatory fence horizon (see fenceHorizon below). */
		fenceHorizon?: boolean;
		/** Width of the membership row the successor epoch's own close writes when it holds only its fence: the
		 * horizon's next fence acquires the journal after that close (fenceHorizon only). */
		successorClosedMembershipByteLength?: number }>
): Readonly<{
	afterLocal: JournalFutureNativeWidths;
	afterSuccessor: JournalFutureNativeWidths;
	afterSuccessorLocal?: JournalFutureNativeWidths;
	/** What the next mandatory fence observes beyond afterSuccessorLocal when the successor epoch holds only its own
	 * fence (a refusal-triggered rollover): the successor epoch's close membership row (successorClosedMembershipByteLength),
	 * the next successor's scope header, and that successor's first local fence. */
	fenceHorizon?: Readonly<{ afterSuccessor: JournalFutureNativeWidths; afterSuccessorLocal: JournalFutureNativeWidths }>;
}> {
	const frames = decodeNativeFrames(
		dense(actualCanonicalRows, LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows * 2) as readonly Uint8Array[]
	);
	const capturedImage = imageOfFrames(frames);
	// A lawful smaller postimage never excuses an oversized retained PRE image.
	// A bounded same-call table of scalar measurements, never a portable source
	// fact. All later edits replace frames; no captured row/byte escapes or lives
	// beyond this synchronous forecast. Dense PRE is bounded by 2*maxRows and
	// continuation appends by maxRows. The immediate/successor/fence additions
	// and three measured header replacements add at most six entries: the table
	// has at most 3*maxRows+6 entries, independently of sparse PRE cardinality.
	// Original per-point counts/image ceilings still apply before measurements.
	// A new call always validates a new PRE.
	const measurements: FutureWidthMeasurements = { frames: new Map(), sourceValidated: false };
	futureWidths(frames, undefined, undefined, measurements);
	const copied = captureLiveJournalInput("append", appendCandidate);
	if (!copied.ok) throw new TypeError(copied.kind);
	const captured = "sourceKind" in copied.value && copied.value.sourceKind === "received"
		? captureLiveJournalInput("received", copied.value)
		: copied;
	if (!captured.ok) throw new TypeError(captured.kind);
	const local = captured.value;
	if (!("sourceKind" in local)) throw new TypeError("malformed-input");
	const localIssued = local.sourceKind === "local-issued";
	let localIssuer = localIssued ? {objectId: local.scope.objectId, author: local.author,
		nextAuthorSequence: local.authorSequence + 1} : undefined;
	let completedScopes: readonly LiveJournalScope[] = [],
		membershipByteLength = 0,
		horizonMembershipByteLength = 0,
		fenceHorizon = false;
	if (sizingOptions !== undefined) {
		const present = ["control", "closedMembershipByteLength", "localIssuerBasis", "fenceHorizon",
			"successorClosedMembershipByteLength"].filter(
			(key) => Object.getOwnPropertyDescriptor(sizingOptions, key) !== undefined
		);
		const options = record(sizingOptions, present);
		if (present.includes("localIssuerBasis")) {
			if (localIssued) throw new TypeError("malformed-input");
			const basis = record(options.localIssuerBasis, ["objectId", "author", "nextAuthorSequence"]);
			if (basis.objectId !== local.scope.objectId || typeof basis.author !== "string" || basis.author.length === 0)
				throw new TypeError("malformed-input");
			localIssuer = {objectId: basis.objectId as string, author: basis.author,
				nextAuthorSequence: integer(basis.nextAuthorSequence)};
		}
		if (present.includes("fenceHorizon")) {
			if (typeof options.fenceHorizon !== "boolean") throw new TypeError("malformed-input");
			fenceHorizon = options.fenceHorizon;
		}
		if (present.includes("successorClosedMembershipByteLength")) {
			// Sizing of the fence horizon only: it names no close of the epoch this call appends to.
			if (!fenceHorizon) throw new TypeError("malformed-input");
			horizonMembershipByteLength = integer(options.successorClosedMembershipByteLength);
			if (horizonMembershipByteLength > LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes) throw new TypeError("retirement-fenced");
		}
		if (present.includes("closedMembershipByteLength")) {
			membershipByteLength = integer(options.closedMembershipByteLength);
			if (membershipByteLength > LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes) throw new TypeError("retirement-fenced");
		}
		if (present.includes("control")) {
			const control = options.control === null ? null : captureJournalRetirementControl(options.control);
			if (!journalRetirementMutationAllows(control, local.scope)) throw new TypeError("retirement-fenced");
			if (control?.drain != null) {
				const drain = control.drain;
				if (
					control.active !== null ||
					drain.cursor !== journalRetirementDrainItemCount(drain.plan) ||
					drain.residualImageDigest !== capturedImage.imageDigest
				)
					throw new TypeError("retirement-stale");
				completedScopes = drain.plan.prefixes.map((prefix) => prefix.scope);
				for (const retired of drain.plan.retiredEmptyHeaders ?? []) {
					const key = [retired.scope.objectId, retired.scope.epoch, retired.scope.anchorDigest];
					if (frames.some(frame => equalNative(frame.key.slice(0, 3), key))) throw new TypeError("retirement-stale");
				}
				for (const prefix of drain.plan.prefixes) {
					const key = [prefix.scope.objectId, prefix.scope.epoch, prefix.scope.anchorDigest];
					const headers = frames.filter((frame) => frame.table === "scopes" && equalNative(frame.key, key));
					if (
						headers.length !== 1 ||
						frames.some((frame) => frame.table !== "scopes" && equalNative(frame.key.slice(0, 3), key))
					)
						throw new TypeError("retirement-stale");
					const row = headers[0]?.row as Record<string, unknown>;
					if (
						row[Object.hasOwn(row, "object_id") ? "next_journal_sequence" : "nextJournalSequence"] !==
						prefix.highWatermark
					)
						throw new TypeError("retirement-stale");
				}
			}
		}
	}
	const currentKey = [local.scope.objectId, local.scope.epoch, local.scope.anchorDigest];
	const selected = frames.findIndex((f) => f.table === "scopes" && equalNative(f.key, currentKey));
	const header = frames[selected];
	if (header === undefined || typeof header.row !== "object" || header.row === null)
		throw new TypeError("not-installed");
	const sql = Object.hasOwn(header.row, "object_id");
	const membershipField = sql ? "closed_membership_bytes" : "closedMembershipBytes";
	const hasMembership = Object.hasOwn(header.row, membershipField);
	const h = record(header.row, [
		...(sql
			? [
					"object_id",
					"epoch",
					"anchor_digest",
					"next_journal_sequence",
					"exact_anchor_preimage",
					"detached_anchor_signature",
					"parameters_digest",
					"exact_parameters_carrier",
				]
			: [
					"objectId",
					"epoch",
					"anchorDigest",
					"nextJournalSequence",
					"exactCanonicalAnchorPreimageBytes",
					"detachedAnchorSignature",
					"parametersDigest",
					"exactCanonicalParametersCarrierBytes",
				]),
		...(hasMembership ? [membershipField] : []),
	]);
	if (
		hasMembership &&
		(!(h[membershipField] instanceof Uint8Array) ||
			(h[membershipField] as Uint8Array).byteLength === 0 ||
			(h[membershipField] as Uint8Array).byteLength > LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes)
	)
		throw new TypeError("malformed-input");
	if (hasMembership && membershipByteLength > 0) throw new TypeError("evidence-conflict");
	const ordinal = integer(h[sql ? "next_journal_sequence" : "nextJournalSequence"]);
	if (
		ordinal === Number.MAX_SAFE_INTEGER ||
		frames.some(
			(f) =>
				f.table !== "scopes" &&
				equalNative(f.key.slice(0, 3), currentKey) &&
				((sql ? (f.row as Record<string, unknown>).vertex_digest : (f.row as Record<string, unknown>).vertexDigest) ===
					local.vertexDigest ||
				(localIssued && (sql ? (f.row as Record<string, unknown>).local_author : (f.row as Record<string, unknown>).localAuthor) ===
						local.author &&
						(sql
							? (f.row as Record<string, unknown>).local_author_sequence
							: (f.row as Record<string, unknown>).localAuthorSequence) === local.authorSequence))
		)
	)
		throw new TypeError("malformed-input");
	const table = sql ? "accepted_entries" : "acceptedEntries";
	if (frames.some((f) => f.table !== "scopes" && f.table !== table)) throw new TypeError("malformed-input");
	const localRow = (author: string, authorSequence: number, vertexDigest: string): Record<string, unknown> => sql
		? {
				object_id: local.scope.objectId,
				epoch: local.scope.epoch,
				anchor_digest: local.scope.anchorDigest,
				journal_sequence: ordinal,
				source_kind: "local-issued",
				vertex_digest: vertexDigest,
				received_preimage: null,
				received_signature: null,
				local_author: author,
				local_author_sequence: authorSequence,
			}
		: {
				objectId: local.scope.objectId,
				epoch: local.scope.epoch,
				anchorDigest: local.scope.anchorDigest,
				journalSequence: ordinal,
				sourceKind: "local-issued",
				vertexDigest,
				localAuthor: author,
				localAuthorSequence: authorSequence,
			};
	const row = localIssued ? localRow(local.author, local.authorSequence, local.vertexDigest)
		: sql ? {object_id: local.scope.objectId, epoch: local.scope.epoch, anchor_digest: local.scope.anchorDigest,
			journal_sequence: ordinal, source_kind: "received", vertex_digest: local.vertexDigest,
			received_preimage: local.exactCanonicalPreimageBytes, received_signature: local.detachedSignature,
			local_author: null, local_author_sequence: null}
		: {objectId: local.scope.objectId, epoch: local.scope.epoch, anchorDigest: local.scope.anchorDigest,
			journalSequence: ordinal, sourceKind: "received", vertexDigest: local.vertexDigest,
			exactCanonicalPreimageBytes: local.exactCanonicalPreimageBytes, detachedSignature: local.detachedSignature};
	const updated: Pick<NativeFrame, "table" | "key" | "row">[] = frames.map((f, i) => {
		if (i === selected)
			return { ...f, row: { ...h, [sql ? "next_journal_sequence" : "nextJournalSequence"]: ordinal + 1 } };
		if (
			f.table === "scopes" &&
			completedScopes.some((scope) => equalNative(f.key, [scope.objectId, scope.epoch, scope.anchorDigest]))
		) {
			const row = { ...(f.row as Record<string, unknown>) };
			delete row[Object.hasOwn(row, "object_id") ? "closed_membership_bytes" : "closedMembershipBytes"];
			return { ...f, row };
		}
		return f;
	});
	updated.push({ table, key: [...currentKey, ordinal], row });
	let lastAuthorSequence = localIssuer === undefined ? -1 : localIssuer.nextAuthorSequence - 1;
	let nextOrdinal = ordinal + 1;
	for (const input of dense(currentContinuationAppends, LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows) as readonly unknown[]) {
		const capturedContinuation = captureLiveJournalInput("append", input);
		if (!capturedContinuation.ok) throw new TypeError(capturedContinuation.kind);
		const continuation = capturedContinuation.value;
		if (
			!("sourceKind" in continuation) ||
			continuation.sourceKind !== "local-issued" ||
			localIssuer === undefined || continuation.author !== localIssuer.author ||
			!equalNative(continuation.scope, local.scope) ||
			lastAuthorSequence === Number.MAX_SAFE_INTEGER ||
			continuation.authorSequence !== lastAuthorSequence + 1 ||
			nextOrdinal === Number.MAX_SAFE_INTEGER ||
			updated.some(
				(frame) =>
					frame.table !== "scopes" &&
					equalNative(frame.key.slice(0, 3), currentKey) &&
					((sql
						? (frame.row as Record<string, unknown>).vertex_digest
						: (frame.row as Record<string, unknown>).vertexDigest) === continuation.vertexDigest ||
						((sql
							? (frame.row as Record<string, unknown>).local_author
							: (frame.row as Record<string, unknown>).localAuthor) === continuation.author &&
							(sql
								? (frame.row as Record<string, unknown>).local_author_sequence
								: (frame.row as Record<string, unknown>).localAuthorSequence) === continuation.authorSequence))
			)
		)
			throw new TypeError("malformed-input");
		const continuationRow = {...localRow(continuation.author, continuation.authorSequence, continuation.vertexDigest),
			[sql ? "journal_sequence" : "journalSequence"]: nextOrdinal};
		updated.push({ table, key: [...currentKey, nextOrdinal], row: continuationRow });
		nextOrdinal++;
		lastAuthorSequence = continuation.authorSequence;
	}
	updated[selected] = {
		...header,
		row: { ...h, [sql ? "next_journal_sequence" : "nextJournalSequence"]: nextOrdinal },
	};
	updated.sort(compareFrameKeys);
	const afterLocal = futureWidths(updated, undefined, undefined, measurements);
	if (membershipByteLength > 0) {
		// Structural BYTES width only. No authenticated carrier, record or digest is
		// fabricated or returned; the close owner must supply actual canonical bytes.
		const index = updated.findIndex((frame) => frame.table === "scopes" && equalNative(frame.key, currentKey));
		const current = updated[index];
		if (current === undefined) throw new TypeError("not-installed");
		updated[index] = {
			...current,
			row: { ...(current.row as Record<string, unknown>), [membershipField]: new Uint8Array(membershipByteLength) },
		};
		futureWidths(updated, undefined, undefined, measurements);
	}
	const successor = captureLiveJournalUnsignedSuccessorInput(unsignedSuccessorInstall);
	if (!successor.ok) throw new TypeError(successor.kind);
	const s = successor.value.stored,
		key = [s.scope.objectId, s.scope.epoch, s.scope.anchorDigest];
	if (
		s.scope.objectId !== local.scope.objectId ||
		s.scope.epoch !== local.scope.epoch + 1 ||
		frames.some((f) => f.table === "scopes" && equalNative(f.key, key))
	)
		throw new TypeError("malformed-input");
	const scopeRow = journalUnsignedSuccessorHeaderFields({sql, scope: s.scope,
		exactCanonicalAnchorPreimageBytes: s.exactCanonicalAnchorPreimageBytes,
		parametersDigest: s.parametersDigest, exactCanonicalParametersCarrierBytes: s.exactCanonicalParametersCarrierBytes});
	const added = { table: "scopes", key, row: scopeRow };
	updated.push(added);
	updated.sort(compareFrameKeys);
	const afterSuccessor = futureWidths(updated, updated.indexOf(added), undefined, measurements);
	if (successorLocalAppendForSizing === undefined) return Object.freeze({ afterLocal, afterSuccessor });
	const futureLocal = record(successorLocalAppendForSizing, ["author", "authorSequence"]);
	if (
		localIssuer === undefined ||
		lastAuthorSequence === Number.MAX_SAFE_INTEGER ||
		futureLocal.author !== localIssuer.author ||
		integer(futureLocal.authorSequence) !== lastAuthorSequence + 1
	)
		throw new TypeError("malformed-input");
	// The future successor scope is genuinely empty in this original path. Share
	// the complete local native row shape above, removing only the unknown digest
	// leaf for structural sizing. This partial tree never enters a native append.
	const successorRow: Record<string, unknown> = sql
		? {
				...localRow(String(futureLocal.author), Number(futureLocal.authorSequence), local.vertexDigest),
				object_id: s.scope.objectId,
				epoch: s.scope.epoch,
				anchor_digest: s.scope.anchorDigest,
				journal_sequence: 0,
				local_author_sequence: futureLocal.authorSequence,
			}
		: {
				...localRow(String(futureLocal.author), Number(futureLocal.authorSequence), local.vertexDigest),
				objectId: s.scope.objectId,
				epoch: s.scope.epoch,
				anchorDigest: s.scope.anchorDigest,
				journalSequence: 0,
				localAuthorSequence: futureLocal.authorSequence,
			};
	delete successorRow[sql ? "vertex_digest" : "vertexDigest"];
	const successorEntry = { table, key: [...key, 0], row: successorRow };
	const finalHeader = {
		...added,
		row: { ...scopeRow, [sql ? "next_journal_sequence" : "nextJournalSequence"]: 1 },
	};
	updated[updated.indexOf(added)] = finalHeader;
	updated.push(successorEntry);
	updated.sort(compareFrameKeys);
	const afterSuccessorLocal = futureWidths(updated, updated.indexOf(finalHeader), updated.indexOf(successorEntry), measurements);
	if (!fenceHorizon) return Object.freeze({ afterLocal, afterSuccessor, afterSuccessorLocal });
	// The next successor has the same structural anchor and parameters carriers as this one (an epoch-chain
	// anchor's fields have fixed widths), one epoch on; a wider epoch integer widens its preimage by as much.
	if (s.scope.epoch >= Number.MAX_SAFE_INTEGER - 1 || integer(futureLocal.authorSequence) === Number.MAX_SAFE_INTEGER)
		throw new TypeError("malformed-input");
	const nextScope = { ...s.scope, epoch: s.scope.epoch + 1 };
	const epochGrowth = varUintWidth(nextScope.epoch) - varUintWidth(s.scope.epoch);
	const nextPreimage = new Uint8Array(s.exactCanonicalAnchorPreimageBytes.byteLength + epochGrowth);
	const nextKey = [nextScope.objectId, nextScope.epoch, nextScope.anchorDigest];
	const nextHeaderRow = journalUnsignedSuccessorHeaderFields({sql, scope: nextScope,
		exactCanonicalAnchorPreimageBytes: nextPreimage, parametersDigest: s.parametersDigest,
		exactCanonicalParametersCarrierBytes: s.exactCanonicalParametersCarrierBytes});
	const nextHeader = { table: "scopes", key: nextKey, row: nextHeaderRow };
	// The successor epoch closes before the next fence acquires: its header then carries that close's membership row.
	const closedHeader = horizonMembershipByteLength === 0 ? finalHeader : { ...finalHeader,
		row: { ...finalHeader.row, [membershipField]: new Uint8Array(horizonMembershipByteLength) } };
	const closedUpdated = updated.map(entry => entry === finalHeader ? closedHeader : entry);
	const horizon = [...closedUpdated, nextHeader].sort(compareFrameKeys);
	const signed = [horizon.indexOf(closedHeader), horizon.indexOf(nextHeader)];
	const horizonSuccessor = futureWidths(horizon, signed, horizon.indexOf(successorEntry), measurements);
	const nextEntryRow: Record<string, unknown> = { ...successorRow,
		epoch: nextScope.epoch,
		[sql ? "local_author_sequence" : "localAuthorSequence"]: integer(futureLocal.authorSequence) + 1 };
	const nextEntry = { table, key: [...nextKey, 0], row: nextEntryRow };
	const nextFinalHeader = { ...nextHeader, row: { ...nextHeaderRow, [sql ? "next_journal_sequence" : "nextJournalSequence"]: 1 } };
	const horizonLocal = [...closedUpdated, nextFinalHeader, nextEntry].sort(compareFrameKeys);
	const horizonSuccessorLocal = futureWidths(horizonLocal, [horizonLocal.indexOf(closedHeader), horizonLocal.indexOf(nextFinalHeader)],
		[horizonLocal.indexOf(successorEntry), horizonLocal.indexOf(nextEntry)], measurements);
	return Object.freeze({ afterLocal, afterSuccessor, afterSuccessorLocal,
		fenceHorizon: Object.freeze({ afterSuccessor: horizonSuccessor, afterSuccessorLocal: horizonSuccessorLocal }) });
}

/**
 * Positive resource-only widening of an ORIGINAL complete native phase for a
 * finite current-epoch row rectangle. Source shape comes from its genuine
 * addressed header (SQLite explicit NULLs versus browser omitted fields).
 * It grants no source authentication, nominal forecast, append, retirement,
 * equality credit, or proof allowance. All original PRE remains present.
 *
 * New received and local-issued alternatives are measured as complete row
 * shapes; their larger complete width is used, not independent field maxima.
 * Every preimage/signature/digest/author is an opaque encoded-width leaf. No
 * fake bytes or native row/key/identity are constructed. New shapes have at
 * most eleven scalar fields, below original row item/depth limits; full PRE
 * goes through its unchanged complete frame/charge/RAW validations first.
 */
function journalOrdinaryFinishingCapacityProjection(input: Readonly<{
	actualCanonicalRows: readonly Uint8Array[];
	currentScope: LiveJournalScope;
	originalWidths: JournalFutureNativeWidths;
	maxAdditionalCurrentRows: number;
	maxCanonicalPreimageByteLength: number;
	maxCanonicalAuthorByteLength: number;
	maxClosedMembershipByteLength: number;
	futureRows?: JournalOrdinaryFutureRows;
}>, measurements?: FutureWidthMeasurements): Readonly<{
	scopeCount: number;
	rowCount: number;
	canonicalRowByteLengthsTotal: number;
	canonicalRowsBytes: number;
	nativeImageBytes: number;
	additionalFrameByteLength: number;
	additionalNativeRowByteLength: number;
}> {
	const fields = record(input, ["actualCanonicalRows", "currentScope", "originalWidths",
		"maxAdditionalCurrentRows", "maxCanonicalPreimageByteLength", "maxCanonicalAuthorByteLength",
		"maxClosedMembershipByteLength", ...(Object.hasOwn(input, "futureRows") ? ["futureRows"] : [])]);
	const selected = record(fields.currentScope, ["objectId", "epoch", "anchorDigest"]);
	const objectId = captureJournalRetirementObject({ objectId: selected.objectId });
	const current = scope(selected, objectId), limit = LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes;
	const count = integer(fields.maxAdditionalCurrentRows), preimage = integer(fields.maxCanonicalPreimageByteLength),
		author = integer(fields.maxCanonicalAuthorByteLength), membership = integer(fields.maxClosedMembershipByteLength);
	if (count > LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows || preimage < 1 || preimage > limit ||
		author < 3 || author > limit || membership > limit) throw new TypeError("malformed-input");
	const frames = decodeNativeFrames(dense(fields.actualCanonicalRows,
		LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows * 2) as readonly Uint8Array[], measurements);
	// Any removal, reorder or byte change takes the ORIGINAL full validation
	// path, including RAW image depth/items. No monotone-count premise is used.
	const pre = measurements?.sourceUnchanged === true && measurements.sourceWidths !== undefined
		? measurements.sourceWidths : futureWidths(frames);
	const header = frames.find(frame => frame.table === "scopes" &&
		equalNative(frame.key, [current.objectId, current.epoch, current.anchorDigest]));
	if (header === undefined || header.row === null || typeof header.row !== "object")
		throw new TypeError("not-installed");
	const sql = Object.hasOwn(header.row, "object_id"), table = sql ? "accepted_entries" : "acceptedEntries";
	if (frames.some(frame => frame.table !== "scopes" && frame.table !== table))
		throw new TypeError("malformed-input");
	const ordinal = integer((header.row as Record<string, unknown>)[sql ? "next_journal_sequence" : "nextJournalSequence"]);
	if (ordinal > Number.MAX_SAFE_INTEGER - count - 2) throw new TypeError("retirement-exhausted");
	const original = record(fields.originalWidths, ["scopeCount", "rowCount", "canonicalRowBytes",
		"canonicalRowsBytes", "nativeImageBytes"]);
	const originalScopes = integer(original.scopeCount), originalRows = integer(original.rowCount),
		originalCanonical = integer(original.canonicalRowsBytes), originalNative = integer(original.nativeImageBytes);
	const lengths = dense(original.canonicalRowBytes, LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows * 2) as readonly number[];
	if (originalScopes < pre.scopeCount || originalScopes > pre.scopeCount + 1 ||
		originalRows < pre.rowCount || originalRows > pre.rowCount + 2 ||
		lengths.length !== originalScopes + originalRows || originalCanonical > limit || originalNative > limit ||
		lengths.some(width => !Number.isSafeInteger(width) || width < 1 || width > limit))
		throw new TypeError("malformed-input");
	return journalOrdinaryFinishingCapacityFromGeometry({current, sql, ordinal,
		pre: {scopeCount: pre.scopeCount, rowCount: pre.rowCount, canonicalRowsBytes: pre.canonicalRowsBytes,
			nativeImageBytes: pre.nativeImageBytes, canonicalRowByteLengthsTotal: pre.canonicalRowBytes.reduce((sum, width) => sum + width, 0)},
		original: {scopeCount: originalScopes, rowCount: originalRows, canonicalRowsBytes: originalCanonical,
			nativeImageBytes: originalNative, canonicalRowByteLengthsTotal: lengths.reduce((sum, width) => sum + width, 0)},
		count, preimage, author, membership, ...(Object.hasOwn(fields, "futureRows") ? {futureRows: fields.futureRows as JournalOrdinaryFutureRows} : {})});
}

interface JournalPhysicalWidths {
	readonly scopeCount: number; readonly rowCount: number; readonly canonicalRowByteLengthsTotal: number;
	readonly canonicalRowsBytes: number; readonly nativeImageBytes: number;
}

/** Pure prospective ordinary-row geometry. Each received leaf also obeys the
 * enclosing maximum PRE size. The admission owner independently enforces
 * these totals; no row, reservation, source authority or equality is supplied. */
export interface JournalOrdinaryFutureRows {
	readonly localCount: number;
	readonly receivedCount: number;
	readonly receivedPreimageBytes: number;
}

/** One original row rectangle, shared by complete reads and prepared numerical
 * geometry. Neither input carries native authority, equality credit or bytes. */
function journalOrdinaryFinishingCapacityFromGeometry(input: Readonly<{
	current: LiveJournalScope; sql: boolean; ordinal: number;
	pre: JournalPhysicalWidths; original: JournalPhysicalWidths;
	count: number; preimage: number; author: number; membership: number;
	futureRows?: JournalOrdinaryFutureRows;
}>) {
	const {current, sql, ordinal, pre, original, count, preimage, author, membership} = input;
	const limit = LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes, table = sql ? "accepted_entries" : "acceptedEntries";
	if (![count, preimage, author, membership, ordinal].every(Number.isSafeInteger) || count < 0 ||
		count > LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows || preimage < 1 || preimage > limit || author < 3 || author > limit ||
		membership < 0 || membership > limit || ordinal < 0 || ordinal > Number.MAX_SAFE_INTEGER - count - 2)
		throw new TypeError("malformed-input");
	const originalScopes = original.scopeCount, originalRows = original.rowCount,
		originalCanonical = original.canonicalRowsBytes, originalNative = original.nativeImageBytes;
	const bytesWidth = (length: number): number => 1 + varUintWidth(length) + length;
	const integerWidth = encodeCanonical(Number.MAX_SAFE_INTEGER).byteLength,
		digestWidth = 1 + varUintWidth(64) + 64, preimageWidth = bytesWidth(preimage), signatureWidth = bytesWidth(64);
	const recordWidth = (known: Readonly<Record<string, unknown>>, unknown: Readonly<Record<string, number>>): number => {
		const knownKeys = Object.keys(known), unknownKeys = Object.keys(unknown);
		if (unknownKeys.some(key => knownKeys.includes(key))) throw new TypeError("malformed-input");
		let width = encodeNativeImagePart(known, { maxBytes: limit, maxItems: 128, maxDepth: 14 }).byteLength -
			varUintWidth(knownKeys.length) + varUintWidth(knownKeys.length + unknownKeys.length);
		for (const key of unknownKeys) {
			const length = unknown[key];
			if (length === undefined || !Number.isSafeInteger(length) || length < 1 || length > limit)
				throw new TypeError("malformed-input");
			width += encodeCanonical(key).byteLength + length;
		}
		if (!Number.isSafeInteger(width) || width > limit) throw new TypeError("retirement-fenced");
		return width;
	};
	const context = sql ? { object_id: current.objectId, epoch: current.epoch, anchor_digest: current.anchorDigest }
		: { objectId: current.objectId, epoch: current.epoch, anchorDigest: current.anchorDigest };
	const received = sql ? recordWidth({ ...context, source_kind: "received", local_author: null, local_author_sequence: null }, {
		journal_sequence: integerWidth, vertex_digest: digestWidth, received_preimage: preimageWidth, received_signature: signatureWidth,
	}) : recordWidth({ ...context, sourceKind: "received" }, {
		journalSequence: integerWidth, vertexDigest: digestWidth, exactCanonicalPreimageBytes: preimageWidth, detachedSignature: signatureWidth,
	});
	const local = sql ? recordWidth({ ...context, source_kind: "local-issued", received_preimage: null, received_signature: null }, {
		journal_sequence: integerWidth, vertex_digest: digestWidth, local_author: author, local_author_sequence: integerWidth,
	}) : recordWidth({ ...context, sourceKind: "local-issued" }, {
		journalSequence: integerWidth, vertexDigest: digestWidth, localAuthor: author, localAuthorSequence: integerWidth,
	});
	const rowWidth = Math.max(received, local);
	let futureRows: JournalOrdinaryFutureRows | undefined;
	if (Object.hasOwn(input, "futureRows")) {
		const value = record(input.futureRows, ["localCount", "receivedCount", "receivedPreimageBytes"]);
		const localCount = value.localCount as number, receivedCount = value.receivedCount as number,
			receivedPreimageBytes = value.receivedPreimageBytes as number;
		if (![localCount, receivedCount, receivedPreimageBytes].every(value => Number.isSafeInteger(value) && value >= 0) ||
			localCount + receivedCount !== count || receivedPreimageBytes < receivedCount ||
			receivedPreimageBytes > receivedCount * preimage) throw new TypeError("malformed-input");
		futureRows = Object.freeze({localCount, receivedCount, receivedPreimageBytes});
	}
	const keyWidth = 1 + varUintWidth(4) + encodeCanonical(current.objectId).byteLength +
		encodeCanonical(current.epoch).byteLength + encodeCanonical(current.anchorDigest).byteLength + integerWidth;
	const frameWidth = 1 + varUintWidth(3) + encodeCanonical(table).byteLength + keyWidth + rowWidth;
	if (frameWidth > limit) throw new TypeError("retirement-fenced");
	// Keep even an old SQL NULL/membership field and reserve its complete new
	// BYTES field again. This is a positive width bound, never a native overwrite
	// model or byte identity. At most one header changes. Header column counts
	// remain <128; only its enclosing BYTES frame-length prefix can widen.
	const membershipField = membership === 0 ? 0 : encodeCanonical(sql ? "closed_membership_bytes" : "closedMembershipBytes").byteLength +
		bytesWidth(membership);
	const headerCounterGrowth = integerWidth - encodeCanonical(ordinal).byteLength;
	const headerGrowth = membershipField + headerCounterGrowth;
	const frameLengthPrefixGrowth = headerGrowth === 0 ? 0 : varUintWidth(limit) - 1;
	const scopes = originalScopes, rows = originalRows + count;
	if (!journalRetirementImageCountsFit(scopes, rows)) throw new TypeError("retirement-fenced");
	// originalWidths already contains the real candidate/fence rows. Positively
	// widen those complete new frames too, without inventing another row/count or
	// asserting byte equality between their original and unknown field versions.
	const newFrameOccurrences = originalRows - pre.rowCount + count;
	const frameOverhead = frameWidth - rowWidth;
	// Complete old/postimage rows remain in their original positive overlap.
	// Only the explicitly declared NEW ordinary rows use the joint bound. Every
	// received PRE and enclosing BYTES header is still charged. Maximum headers
	// at each occurrence dominate all distributions across the aggregate budget.
	const extraFrames = originalRows - pre.rowCount;
	if (futureRows !== undefined && (!Number.isSafeInteger(extraFrames) || extraFrames < 0))
		throw new TypeError("malformed-input");
	const futureNativeBytes = futureRows === undefined ? count * rowWidth :
		futureRows.localCount * local + futureRows.receivedCount * (received - preimage) + futureRows.receivedPreimageBytes;
	const futureFrameBytes = futureNativeBytes + count * frameOverhead;
	const futureEncodedFrames = futureRows === undefined ? count * bytesWidth(frameWidth) : futureFrameBytes +
		futureRows.localCount * (1 + varUintWidth(frameOverhead + local)) +
		futureRows.receivedCount * (1 + varUintWidth(frameOverhead + received));
	const canonicalRowByteLengthsTotal = Math.max(original.canonicalRowByteLengthsTotal,
		pre.canonicalRowByteLengthsTotal) + (futureRows === undefined ? newFrameOccurrences * frameWidth : extraFrames * frameWidth + futureFrameBytes) + headerGrowth;
	const canonicalRowsBytes = Math.max(originalCanonical, pre.canonicalRowsBytes) + (futureRows === undefined
		? newFrameOccurrences * bytesWidth(frameWidth) : extraFrames * bytesWidth(frameWidth) + futureEncodedFrames) +
		headerGrowth + frameLengthPrefixGrowth + varUintWidth(scopes + rows) - varUintWidth(originalScopes + originalRows);
	const nativeImageBytes = Math.max(originalNative, pre.nativeImageBytes) + (futureRows === undefined
		? newFrameOccurrences * rowWidth : extraFrames * rowWidth + futureNativeBytes) + headerGrowth +
		varUintWidth(rows) - varUintWidth(originalRows);
	if ([canonicalRowByteLengthsTotal, canonicalRowsBytes, nativeImageBytes].some(width =>
		!Number.isSafeInteger(width) || width > limit)) throw new TypeError("retirement-fenced");
	return Object.freeze({ scopeCount: scopes, rowCount: rows, canonicalRowByteLengthsTotal,
		canonicalRowsBytes, nativeImageBytes, additionalFrameByteLength: frameWidth,
		additionalNativeRowByteLength: rowWidth });
}

/** Existing numerical API retains its exact original five-field result. The
 * SAME private row projection also supplies the complete new-frame cost to the
 * no-forecast owner below, without subtraction or a second row schema. */
export function journalOrdinaryFinishingCapacityWidths(input: Parameters<typeof journalOrdinaryFinishingCapacityProjection>[0]) {
	const {additionalFrameByteLength: _resourceOnly, additionalNativeRowByteLength: _nativeResourceOnly,
		...result} = journalOrdinaryFinishingCapacityProjection(input);
	return Object.freeze(result);
}

/** Original capacity without a successor/prepared-close observation.
 * A complete new signed header, candidate and optional successor fence are scalar schema costs,
 * not a native header, post-adoption census or authenticated membership. The
 * complete actual PRE frames are validated by the SAME native codec first.
 * Actual producer/authority must still independently enforce this rectangle. */
export interface JournalOrdinarySchemaFinishingCapacityInput {
	actualCanonicalRows: readonly Uint8Array[]; currentScope: LiveJournalScope;
	canonicalPreimageByteLength: number; canonicalAuthorByteLength: number;
	successorAnchorByteLength: number; parametersByteLength: number;
	closedMembershipByteLength: number;
	/** Finite new current rows only; existing heterogeneous frames stay exact.
	 * This numerical rectangle grants no append or admission authority. */
	maxAdditionalCurrentRows?: number;
	/** Optional mixed-source aggregate window, not a new native validity rule. */
	futureRows?: JournalOrdinaryFutureRows;
	successorFenceCount?: 0 | 1;
	successorFencePreimageByteLength?: number;
}
export function journalOrdinarySchemaFinishingCapacityWidths(input: Readonly<JournalOrdinarySchemaFinishingCapacityInput>) {
	const limit = LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes;
	const selected = scope(record(input.currentScope, ["objectId", "epoch", "anchorDigest"]), input.currentScope.objectId);
	const fenceCount = input.successorFenceCount ?? 0, fencePreimage = input.successorFencePreimageByteLength ?? 0;
	const additionalCurrentRows = input.maxAdditionalCurrentRows ?? 1;
	if (!Number.isSafeInteger(additionalCurrentRows) || additionalCurrentRows < 0 ||
		additionalCurrentRows > LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows) throw new TypeError("malformed-input");
	if (!Number.isSafeInteger(input.canonicalPreimageByteLength) || input.canonicalPreimageByteLength < 1 ||
		input.canonicalPreimageByteLength > limit || (fenceCount !== 0 && fenceCount !== 1) || !Number.isSafeInteger(fencePreimage) ||
		(fenceCount === 0 ? fencePreimage !== 0 : fencePreimage < 1 || fencePreimage > limit))
		throw new TypeError("malformed-input");
	if (selected.epoch === Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(input.successorAnchorByteLength) ||
		input.successorAnchorByteLength < 1 || input.successorAnchorByteLength > AHE_BOUNDED_READ_LIMITS.maxBlobBytes ||
		!Number.isSafeInteger(input.parametersByteLength) || input.parametersByteLength < 1 ||
		input.parametersByteLength > AHE_BOUNDED_READ_LIMITS.maxBlobBytes) throw new TypeError("malformed-input");
	const futureDescriptor = Object.getOwnPropertyDescriptor(input, "futureRows");
	if (futureDescriptor !== undefined && (!("value" in futureDescriptor) || !futureDescriptor.enumerable))
		throw new TypeError("malformed-input");
	const measurements: FutureWidthMeasurements = {frames: new Map(), sourceValidated: false};
	const frames = decodeNativeFrames(dense(input.actualCanonicalRows, LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows * 2) as readonly Uint8Array[], measurements);
	const actual = futureWidths(frames, undefined, undefined, measurements);
	measurements.sourceWidths = actual;
	const header = frames.find(frame => frame.table === "scopes" &&
		equalNative(frame.key, [selected.objectId, selected.epoch, selected.anchorDigest]));
	if (header === undefined || header.row === null || typeof header.row !== "object") throw new TypeError("not-installed");
	const sql = Object.hasOwn(header.row, "object_id");
	return journalOrdinarySchemaCapacityFromGeometry(input, selected, {
		scopeCount: actual.scopeCount, rowCount: actual.rowCount,
		canonicalRowByteLengthsTotal: actual.canonicalRowBytes.reduce((sum, width) => sum + width, 0),
		canonicalRowsBytes: actual.canonicalRowsBytes, nativeImageBytes: actual.nativeImageBytes,
	}, sql, (original, rectangle) => journalOrdinaryFinishingCapacityProjection({actualCanonicalRows: input.actualCanonicalRows,
		currentScope: selected, originalWidths: {scopeCount: original.scopeCount, rowCount: original.rowCount,
			canonicalRowsBytes: original.canonicalRowsBytes, nativeImageBytes: original.nativeImageBytes,
			canonicalRowBytes: [...actual.canonicalRowBytes, original.canonicalRowByteLengthsTotal -
				actual.canonicalRowBytes.reduce((sum, width) => sum + width, 0)]},
		maxAdditionalCurrentRows: rectangle.count, maxCanonicalPreimageByteLength: rectangle.preimage,
		maxCanonicalAuthorByteLength: rectangle.author, maxClosedMembershipByteLength: rectangle.membership,
		...(Object.hasOwn(rectangle, "futureRows") ? {futureRows: rectangle.futureRows!} : {})}, measurements));
}

/** Original successor/header/fence schema, independent of how validated
 * current geometry was obtained. The public complete-read path retains its
 * second defensive capture; the prepared path owns detached primitive DATA. */
function journalOrdinarySchemaCapacityFromGeometry(
	input: Readonly<Omit<JournalOrdinarySchemaFinishingCapacityInput, "actualCanonicalRows" | "currentScope">>,
	selected: LiveJournalScope, actual: JournalPhysicalWidths, sql: boolean,
	project: (original: JournalPhysicalWidths, rectangle: Readonly<{count: number; preimage: number; author: number; membership: number;
		futureRows?: JournalOrdinaryFutureRows}>) =>
		ReturnType<typeof journalOrdinaryFinishingCapacityFromGeometry>
) {
	const limit = LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes,
		fenceCount = input.successorFenceCount ?? 0, fencePreimage = input.successorFencePreimageByteLength ?? 0,
		additionalCurrentRows = input.maxAdditionalCurrentRows ?? 1;
	if (!Number.isSafeInteger(additionalCurrentRows) || additionalCurrentRows < 0 || additionalCurrentRows > LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows ||
		!Number.isSafeInteger(input.canonicalPreimageByteLength) || input.canonicalPreimageByteLength < 1 || input.canonicalPreimageByteLength > limit ||
		(fenceCount !== 0 && fenceCount !== 1) || !Number.isSafeInteger(fencePreimage) ||
		(fenceCount === 0 ? fencePreimage !== 0 : fencePreimage < 1 || fencePreimage > limit) ||
		selected.epoch === Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(input.successorAnchorByteLength) ||
		input.successorAnchorByteLength < 1 || input.successorAnchorByteLength > AHE_BOUNDED_READ_LIMITS.maxBlobBytes ||
		!Number.isSafeInteger(input.parametersByteLength) || input.parametersByteLength < 1 ||
		input.parametersByteLength > AHE_BOUNDED_READ_LIMITS.maxBlobBytes) throw new TypeError("malformed-input");
	const futureDescriptor = Object.getOwnPropertyDescriptor(input, "futureRows");
	if (futureDescriptor !== undefined && (!("value" in futureDescriptor) || !futureDescriptor.enumerable))
		throw new TypeError("malformed-input");
	const limits = {maxBytes: limit, maxItems: 65_536, maxDepth: 32};
	const leaf = (value: null | boolean | number | string) => canonicalPrimitiveResourceForSizing(value, limits);
	const bytes = (length: number) => canonicalBytesResourceForSizing(length, limits);
	const tuple = (children: readonly CanonicalResourceFootprint[]) => canonicalArrayResourcesForSizing(children, limits);
	const digest = bytes(64), epoch = leaf(Number.MAX_SAFE_INTEGER);
	const unsigned = journalUnsignedSuccessorHeaderFields({sql,
		scope: {objectId: selected.objectId, epoch, anchorDigest: digest},
		exactCanonicalAnchorPreimageBytes: bytes(input.successorAnchorByteLength), parametersDigest: digest,
		exactCanonicalParametersCarrierBytes: bytes(input.parametersByteLength)});
	const row = canonicalRecordResourceForSizing({...unsigned,
		[sql ? "detached_anchor_signature" : "detachedAnchorSignature"]: bytes(64)}, limits);
	const frame = tuple([leaf("scopes"), tuple([leaf(selected.objectId), epoch, digest]), row]);
	const originalWidths = Object.freeze({scopeCount: actual.scopeCount + 1, rowCount: actual.rowCount,
		canonicalRowByteLengthsTotal: actual.canonicalRowByteLengthsTotal + frame.byteLength,
		canonicalRowsBytes: actual.canonicalRowsBytes + bytes(frame.byteLength).byteLength +
			varUintWidth(actual.scopeCount + actual.rowCount + 1) - varUintWidth(actual.scopeCount + actual.rowCount),
		nativeImageBytes: actual.nativeImageBytes + row.byteLength +
			varUintWidth(actual.scopeCount + 1) - varUintWidth(actual.scopeCount)});
	const projected = project(originalWidths, {count: additionalCurrentRows,
		preimage: Math.max(input.canonicalPreimageByteLength, fencePreimage), author: input.canonicalAuthorByteLength,
		membership: input.closedMembershipByteLength, ...(futureDescriptor === undefined ? {} : {futureRows: futureDescriptor.value as JournalOrdinaryFutureRows})});
	const {additionalNativeRowByteLength, ...result} = projected;
	// Reuse the SAME complete local/received native row schema. Only the epoch
	// changes at this addressed successor; widen its occurrences in BOTH row and
	// key to the original nonnegative-safe-integer domain. The anchor is already
	// a fixed-width digest. The fresh empty header advances 0→1, equal encoded
	// integer widths; no header or PRE bytes are subtracted.
	const epochGrowth = leaf(Number.MAX_SAFE_INTEGER).byteLength - leaf(selected.epoch).byteLength;
	const successorFenceFrameByteLength = fenceCount === 0 ? 0 : result.additionalFrameByteLength + 2 * epochGrowth;
	if (fenceCount === 1) {
		const priorCount = result.scopeCount + result.rowCount, priorRows = result.rowCount;
		result.rowCount++;
		result.canonicalRowByteLengthsTotal += successorFenceFrameByteLength;
		result.canonicalRowsBytes += bytes(successorFenceFrameByteLength).byteLength +
			varUintWidth(priorCount + 1) - varUintWidth(priorCount);
		result.nativeImageBytes += additionalNativeRowByteLength + epochGrowth +
			varUintWidth(priorRows + 1) - varUintWidth(priorRows);
		if (!journalRetirementImageCountsFit(result.scopeCount, result.rowCount) ||
			[result.canonicalRowByteLengthsTotal, result.canonicalRowsBytes, result.nativeImageBytes,
				successorFenceFrameByteLength].some(width => !Number.isSafeInteger(width) || width > limit))
			throw new TypeError("retirement-fenced");
	}
	// canonicalRows is the original ARRAY of complete encoded BYTES frames,
	// not the expanded RAW native SQL/IndexedDB image used by its own hash codec.
	const count = result.scopeCount + result.rowCount;
	const canonicalRows = Object.freeze({byteLength: result.canonicalRowsBytes, items: 1 + count * 2, maxDepth: 1});
	if (!Number.isSafeInteger(canonicalRows.items) || canonicalRows.items > 65_536) throw new TypeError("retirement-fenced");
	return Object.freeze({...result, canonicalRows, newHeaderRow: row, newHeaderFrame: frame,
		successorFenceFrameByteLength});
}

export interface JournalOrdinaryPhysicalGeometry {
	readonly scopeCount: number; readonly rowCount: number; readonly canonicalRowByteLengthsTotal: number;
	readonly canonicalRows: CanonicalResourceFootprint; readonly nativeImageBytes: number;
	/** Complete top-batch descriptor ARRAY for captured non-genesis headers
	 * only. The current HWM is widened through its original integer field;
	 * accepted PRE rows and hypothetical successor headers never become OLD
	 * header payloads. Numerical DATA, not classification/deletion authority. */
	readonly headerDrain: Readonly<{count: number; descriptors: CanonicalResourceFootprint}>;
	readonly currentHeader: Readonly<{ordinal: number; parametersByteLength: number; sql: boolean}>;
	readonly groups: readonly Readonly<{scope: LiveJournalScope; count: number; receivedCount: number;
		receivedCanonicalPayloadSum: number; pageable: boolean}>[];
}
/** Current-epoch append geometry only. Counts and raw PRE budgets are numerical
 * premises independently enforced by the caller, never native authority. */
export interface JournalOrdinaryCurrentAppendCapacityInput {
	readonly maxAdditionalCurrentRows: number;
	readonly canonicalPreimageByteLength: number;
	readonly canonicalAuthorByteLength: number;
	readonly futureRows?: JournalOrdinaryFutureRows;
}
export interface JournalOrdinaryFinishingCapacityProjection {
	readonly snapshot: JournalOrdinaryPhysicalGeometry;
	quoteCurrent(input: JournalOrdinaryCurrentAppendCapacityInput): Readonly<ReturnType<typeof journalOrdinaryFinishingCapacityFromGeometry> & {
		canonicalRows: CanonicalResourceFootprint;
	}>;
	quote(input: Readonly<Omit<JournalOrdinarySchemaFinishingCapacityInput, "actualCanonicalRows" | "currentScope">>):
		ReturnType<typeof journalOrdinarySchemaCapacityFromGeometry>;
	advance(input: Readonly<{exactCanonicalHeaderFrameBytes: Uint8Array; exactCanonicalAcceptedFrameBytes: Uint8Array}>):
		JournalOrdinaryFinishingCapacityProjection;
}

/** Retains numerical DATA from one complete original validation, never rows,
 * PRE, a native image, a proof book or admission authority. The caller must
 * independently bind each use/update to genuine fresh native/source currency.
 * An old/copyable projector cannot authenticate replay, delivery or deletion.
 * Retention is one primitive cell plus at most maxRows scope summaries. */
export function prepareJournalOrdinaryFinishingCapacityProjection(input: Readonly<{
	actualCanonicalRows: readonly Uint8Array[]; currentScope: LiveJournalScope;
}>): JournalOrdinaryFinishingCapacityProjection {
	const selected = scope(record(input.currentScope, ["objectId", "epoch", "anchorDigest"]), input.currentScope.objectId);
	const measurements: FutureWidthMeasurements = {frames: new Map(), sourceValidated: false};
	const frames = decodeNativeFrames(dense(input.actualCanonicalRows,
		LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows * 2) as readonly Uint8Array[], measurements);
	const actual = futureWidths(frames, undefined, undefined, measurements);
	const key = JSON.stringify([selected.objectId, selected.epoch, selected.anchorDigest]);
	const headers = frames.filter(frame => frame.table === "scopes" && JSON.stringify(frame.key) === key);
	if (headers.length !== 1) throw new TypeError("not-installed");
	const header = headers[0]!, sql = Object.hasOwn(header.row as object, "object_id");
	const table = sql ? "accepted_entries" : "acceptedEntries", ordinalKey = sql ? "next_journal_sequence" : "nextJournalSequence";
	const ordinal = integer((header.row as Record<string, unknown>)[ordinalKey]);
	const parameters = (header.row as Record<string, unknown>)[sql ? "exact_parameters_carrier" : "exactCanonicalParametersCarrierBytes"];
	if (!(parameters instanceof Uint8Array)) throw new TypeError("malformed-input");
	const groups = new Map<string, {scope: LiveJournalScope; count: number; receivedCount: number; receivedCanonicalPayloadSum: number; pageable: boolean}>();
	const seen = new Set<string>();
	for (const frame of frames) {
		const address = JSON.stringify(frame.key);
		if (seen.has(frame.table + address) || (frame.table !== "scopes" && frame.table !== table)) throw new TypeError("malformed-input");
		seen.add(frame.table + address);
		const frameScope = scope({objectId: frame.key[0], epoch: frame.key[1], anchorDigest: frame.key[2]}, selected.objectId);
		if (frame.row === null || typeof frame.row !== "object" || Array.isArray(frame.row)) throw new TypeError("malformed-input");
		const row = frame.row as Record<string, unknown>;
		if (row[sql ? "object_id" : "objectId"] !== frameScope.objectId || row.epoch !== frameScope.epoch ||
			row[sql ? "anchor_digest" : "anchorDigest"] !== frameScope.anchorDigest) throw new TypeError("malformed-input");
		if (frame.table === "scopes") integer(row[ordinalKey]);
		else if (integer(row[sql ? "journal_sequence" : "journalSequence"]) !== frame.key[3]) throw new TypeError("malformed-input");
		const groupKey = JSON.stringify(frame.key.slice(0, 3));
		const group = groups.get(groupKey) ?? {scope: frameScope, count: 0, receivedCount: 0, receivedCanonicalPayloadSum: 0, pageable: true};
		groups.set(groupKey, group);
		if (frame.table === "scopes") continue;
		const kind = (frame.row as Record<string, unknown>)[sql ? "source_kind" : "sourceKind"];
		if (kind !== "received" && kind !== "local-issued") throw new TypeError("malformed-input");
		group.count++;
		if (kind === "received") {group.receivedCount++; group.receivedCanonicalPayloadSum += 1 + varUintWidth(frame.bytes.byteLength) + frame.bytes.byteLength; group.pageable = false;}
	}
	for (const group of groups.values()) if (!seen.has("scopes" + JSON.stringify([
		group.scope.objectId, group.scope.epoch, group.scope.anchorDigest]))) throw new TypeError("not-installed");
	const headerMeasure = measurements.frames.get(header)!;
	const core = {...header.row as Record<string, unknown>}; delete core[ordinalKey];
	const identity = Array.from(hashDomain("ts-drp/journal-sizing-header/v1", encodeCanonical(core)), byte => byte.toString(16).padStart(2, "0")).join("");
	const physical: JournalPhysicalWidths = Object.freeze({scopeCount: actual.scopeCount, rowCount: actual.rowCount,
		canonicalRowByteLengthsTotal: actual.canonicalRowBytes.reduce((sum, width) => sum + width, 0),
		canonicalRowsBytes: actual.canonicalRowsBytes, nativeImageBytes: actual.nativeImageBytes});
	const resourceLimits = {maxBytes: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes, maxItems: 65_536, maxDepth: 32};
	const primitive = (value: string | number) => canonicalPrimitiveResourceForSizing(value, resourceLimits);
	const headerDescriptors = frames.filter(frame => frame.table === "scopes" && frame.key[1] !== 0).map(frame => {
		const counterGrowth = frame !== header ? 0 : encodeCanonical(Number.MAX_SAFE_INTEGER).byteLength - encodeCanonical(ordinal).byteLength;
		const descriptorScope = canonicalRecordResourceForSizing({objectId: primitive(String(frame.key[0])),
			epoch: primitive(Number(frame.key[1])), anchorDigest: primitive(String(frame.key[2]))}, resourceLimits);
		return canonicalRecordResourceForSizing({scope: descriptorScope,
			exactCanonicalNativeFrameBytes: canonicalBytesResourceForSizing(measurements.frames.get(frame)!.canonical! + counterGrowth,
				resourceLimits)}, resourceLimits);
	}).sort((a, b) => b.byteLength - a.byteLength).slice(0, LIVE_JOURNAL_RETIREMENT_BATCH_ROWS);
	const headerDrain = Object.freeze({count: headerDescriptors.length,
		descriptors: canonicalArrayResourcesForSizing(headerDescriptors, resourceLimits)});
	return createJournalOrdinaryProjectionCell(selected, sql, physical, ordinal, parameters.byteLength,
		headerMeasure.canonical!, headerMeasure.raw!, headerMeasure.charged!,
		[...measurements.frames.values()].reduce((sum, value) => sum + value.charged!, 0), identity,
		Object.freeze([...groups.values()].map(group => Object.freeze(group))), headerDrain);
}

/** No old byte vectors are captured by this closure. A new cell is installed
 * only by its caller's native-plus-graph accepted-effect boundary; refusal,
 * retry and uncertain outcomes must not advance it. */
function createJournalOrdinaryProjectionCell(selected: LiveJournalScope, sql: boolean, physical: JournalPhysicalWidths,
	ordinal: number, parametersByteLength: number, headerFrameBytes: number,
	headerRawBytes: number, headerChargedBytes: number, chargedBytes: number, headerIdentity: string,
	groups: JournalOrdinaryPhysicalGeometry["groups"], headerDrain: JournalOrdinaryPhysicalGeometry["headerDrain"]): JournalOrdinaryFinishingCapacityProjection {
	const snapshot: JournalOrdinaryPhysicalGeometry = Object.freeze({...physical,
		canonicalRows: Object.freeze({byteLength: physical.canonicalRowsBytes,
			items: 1 + 2 * (physical.scopeCount + physical.rowCount), maxDepth: 1}),
		currentHeader: Object.freeze({ordinal, parametersByteLength, sql}), groups, headerDrain});
	return Object.freeze({snapshot,
		quoteCurrent: (input: JournalOrdinaryCurrentAppendCapacityInput) => {
			const captured = record(input, ["maxAdditionalCurrentRows", "canonicalPreimageByteLength", "canonicalAuthorByteLength",
				...(Object.hasOwn(input, "futureRows") ? ["futureRows"] : [])]);
			// Use the SAME complete row schema with no prospective postimage:
			// every OLD row remains exact, NEW rows carry their complete fields,
			// and only the current header counter may widen. Its safe-integer and
			// enclosing BYTES prefix maxima positively bound every admitted prefix.
			// Close membership, successor header and fence belong to quote(), not I.
			const projected = journalOrdinaryFinishingCapacityFromGeometry({current: selected, sql, ordinal,
				pre: physical, original: physical, count: integer(captured.maxAdditionalCurrentRows),
				preimage: integer(captured.canonicalPreimageByteLength), author: integer(captured.canonicalAuthorByteLength), membership: 0,
				...(Object.hasOwn(captured, "futureRows") ? {futureRows: captured.futureRows as JournalOrdinaryFutureRows} : {})});
			const items = 1 + 2 * (projected.scopeCount + projected.rowCount);
			if (!Number.isSafeInteger(items) || items > 65_536) throw new TypeError("retirement-fenced");
			return Object.freeze({...projected, canonicalRows: Object.freeze({byteLength: projected.canonicalRowsBytes, items, maxDepth: 1})});
		},
		quote: (input: Readonly<Omit<JournalOrdinarySchemaFinishingCapacityInput, "actualCanonicalRows" | "currentScope">>) =>
			journalOrdinarySchemaCapacityFromGeometry(input, selected, physical, sql, (original, rectangle) =>
				journalOrdinaryFinishingCapacityFromGeometry({current: selected, sql, ordinal, pre: physical, original, ...rectangle})),
		advance: (input: Readonly<{exactCanonicalHeaderFrameBytes: Uint8Array; exactCanonicalAcceptedFrameBytes: Uint8Array}>) => {
			const captured = record(input, ["exactCanonicalHeaderFrameBytes", "exactCanonicalAcceptedFrameBytes"]);
			const measurements: FutureWidthMeasurements = {frames: new Map(), sourceValidated: false};
			const frames = decodeNativeFrames([captured.exactCanonicalHeaderFrameBytes, captured.exactCanonicalAcceptedFrameBytes] as Uint8Array[], measurements);
			const [header, entry] = frames;
			if (header === undefined || entry === undefined || ordinal === Number.MAX_SAFE_INTEGER || header.table !== "scopes" ||
				entry.table !== (sql ? "accepted_entries" : "acceptedEntries") ||
				!equalNative(header.key, [selected.objectId, selected.epoch, selected.anchorDigest]) ||
				!equalNative(entry.key, [selected.objectId, selected.epoch, selected.anchorDigest, ordinal])) throw new TypeError("malformed-input");
			const headerRow = header.row as Record<string, unknown>, row = entry.row as Record<string, unknown>;
			const ordinalKey = sql ? "next_journal_sequence" : "nextJournalSequence";
			if (integer(headerRow[ordinalKey]) !== ordinal + 1 || row[sql ? "object_id" : "objectId"] !== selected.objectId ||
				row.epoch !== selected.epoch || row[sql ? "anchor_digest" : "anchorDigest"] !== selected.anchorDigest ||
				integer(row[sql ? "journal_sequence" : "journalSequence"]) !== ordinal) throw new TypeError("malformed-input");
			const core = {...headerRow}; delete core[ordinalKey];
			const identity = Array.from(hashDomain("ts-drp/journal-sizing-header/v1", encodeCanonical(core)), byte => byte.toString(16).padStart(2, "0")).join("");
			if (identity !== headerIdentity) throw new TypeError("retirement-stale");
			const kind = row[sql ? "source_kind" : "sourceKind"];
			if (kind !== "local-issued" && kind !== "received") throw new TypeError("malformed-input");
			record(row, sql ? ["object_id", "epoch", "anchor_digest", "journal_sequence", "source_kind", "vertex_digest",
				"received_preimage", "received_signature", "local_author", "local_author_sequence"] :
				["objectId", "epoch", "anchorDigest", "journalSequence", "sourceKind", "vertexDigest",
					...(kind === "received" ? ["exactCanonicalPreimageBytes", "detachedSignature"] : ["localAuthor", "localAuthorSequence"])]);
			digest(row[sql ? "vertex_digest" : "vertexDigest"]);
			if (kind === "received") {
				const preimage = row[sql ? "received_preimage" : "exactCanonicalPreimageBytes"],
					signature = row[sql ? "received_signature" : "detachedSignature"];
				if (!(preimage instanceof Uint8Array) || preimage.byteLength < 1 || !(signature instanceof Uint8Array) || signature.byteLength !== 64 ||
					(sql && (row.local_author !== null || row.local_author_sequence !== null))) throw new TypeError("malformed-input");
			} else {
				const author = row[sql ? "local_author" : "localAuthor"];
				if (typeof author !== "string" || author.length === 0 || (sql && (row.received_preimage !== null || row.received_signature !== null)))
					throw new TypeError("malformed-input");
				integer(row[sql ? "local_author_sequence" : "localAuthorSequence"]);
			}
			futureWidths(frames, undefined, undefined, measurements);
			const nextHeader = measurements.frames.get(header)!, added = measurements.frames.get(entry)!;
			const bytes = (length: number) => 1 + varUintWidth(length) + length;
			const rowCount = physical.rowCount + 1, total = physical.scopeCount + physical.rowCount;
			const next: JournalPhysicalWidths = Object.freeze({scopeCount: physical.scopeCount, rowCount,
				canonicalRowByteLengthsTotal: physical.canonicalRowByteLengthsTotal - headerFrameBytes + nextHeader.canonical! + added.canonical!,
				canonicalRowsBytes: physical.canonicalRowsBytes - bytes(headerFrameBytes) + bytes(nextHeader.canonical!) + bytes(added.canonical!) + varUintWidth(total + 1) - varUintWidth(total),
				nativeImageBytes: physical.nativeImageBytes - headerRawBytes + nextHeader.raw! + added.raw! + varUintWidth(rowCount) - varUintWidth(physical.rowCount)});
			// Scope-only NULL elision was normalized by the original frame codec.
			const nextCharged = chargedBytes - headerChargedBytes + nextHeader.charged! + added.charged!;
			const limit = LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes;
			if (!journalRetirementImageCountsFit(next.scopeCount, next.rowCount) || nextCharged > limit ||
				[next.canonicalRowByteLengthsTotal, next.canonicalRowsBytes, next.nativeImageBytes].some(value => !Number.isSafeInteger(value) || value < 1 || value > limit) ||
				1 + 2 * (next.scopeCount + next.rowCount) > 65_536) throw new TypeError("retirement-fenced");
			const updated = groups.map(group => group.scope.epoch !== selected.epoch || group.scope.anchorDigest !== selected.anchorDigest ? group : Object.freeze({...group,
				count: group.count + 1, receivedCount: group.receivedCount + (kind === "received" ? 1 : 0),
				receivedCanonicalPayloadSum: group.receivedCanonicalPayloadSum + (kind === "received" ? bytes(added.canonical!) : 0),
				pageable: group.pageable && kind !== "received"}));
			return createJournalOrdinaryProjectionCell(selected, sql, next, ordinal + 1, parametersByteLength,
				nextHeader.canonical!, nextHeader.raw!, nextHeader.charged!, nextCharged,
				headerIdentity, Object.freeze(updated), headerDrain);
		},
	});
}

function decodeNativeFrames(frames: readonly Uint8Array[], measurements?: FutureWidthMeasurements): readonly NativeFrame[] {
	const prior = measurements?.sourceFrames;
	let unchanged = prior !== undefined && prior.length === frames.length;
	const result = frames.map((bytes, index) => {
		// Copy at EACH original decode point: a getter/iterator can change the
		// borrowed bytes or return a different vector between the two captures.
		const input = measurements === undefined ? bytes : new Uint8Array(bytes);
		const old = prior?.[index], oldInput = old === undefined ? undefined : measurements?.frames.get(old)?.input;
		let same = oldInput !== undefined && input.byteLength === oldInput.byteLength;
		if (same) for (let offset = 0; offset < input.byteLength; offset++) if (input[offset] !== oldInput![offset]) {same = false; break;}
		if (same) return old!;
		unchanged = false;
		const decoded = decodeCanonical(input, {
			maxBytes: LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes,
			maxItems: 144,
			maxDepth: 17,
		});
		if (
			!Array.isArray(decoded) ||
			decoded.length !== 3 ||
			typeof decoded[0] !== "string" ||
			!Array.isArray(decoded[1]) ||
			!(
				(decoded[0] === "scopes" && decoded[1].length === 3) ||
				((decoded[0] === "accepted_entries" || decoded[0] === "acceptedEntries") && decoded[1].length === 4)
			)
		)
			throw new TypeError("malformed-input");
		const frame = { bytes, table: decoded[0], key: decoded[1], row: decoded[2] };
		if (measurements !== undefined) measurements.frames.set(frame, {input});
		return frame;
	});
	if (measurements !== undefined) {
		measurements.sourceFrames ??= result;
		measurements.sourceUnchanged = unchanged;
	}
	return result;
}
function matchesDrainKey(frame: NativeFrame, selected: JournalRetirementDrainItem): boolean {
	if (!("row" in selected)) return frame.table === "scopes" && equalNative(frame.key,
		[selected.scope.objectId, selected.scope.epoch, selected.scope.anchorDigest]);
	return (
		frame.key.length === 4 &&
		equalNative(frame.key, [
			selected.scope.objectId,
			selected.scope.epoch,
			selected.scope.anchorDigest,
			selected.row.journalSequence,
		])
	);
}
/** One freshly decoded bounded native image owns its address multiplicities.
 * Canonical key bytes preserve matchesDrainKey's original equality, including
 * both native detail spellings. Buckets retain duplicates; an address is never
 * evidence of a unique/full-frame match. Nothing survives this invocation. */
function indexNativeDrainFrames(
	frames: readonly NativeFrame[],
	selected: readonly JournalRetirementDrainItem[]
): Readonly<{
	find(item: JournalRetirementDrainItem): readonly NativeFrame[];
	hasRows(scope: LiveJournalScope): boolean;
}> {
	const wantsRows = selected.some(item => "row" in item),
		wantsHeaders = selected.some(item => !("row" in item));
	const identity = (key: readonly unknown[], header: boolean): string =>
		`${header ? "h" : "r"}:${encodeCanonical(key).join(",")}`;
	const scopeKey = (scope: LiveJournalScope): readonly unknown[] =>
		[scope.objectId, scope.epoch, scope.anchorDigest];
	const byKey = new Map<string, NativeFrame[]>();
	for (const frame of frames) {
		const header = frame.table === "scopes";
		if (header ? !wantsHeaders : !wantsRows || frame.key.length !== 4) continue;
		const key = identity(frame.key, header), prior = byKey.get(key);
		if (prior === undefined) byKey.set(key, [frame]);
		else prior.push(frame);
	}
	return Object.freeze({
		find(item: JournalRetirementDrainItem): readonly NativeFrame[] {
			const header = !("row" in item), key = header
				? scopeKey(item.scope)
				: [...scopeKey(item.scope), item.row.journalSequence];
			return byKey.get(identity(key, header)) ?? [];
		},
		// Retain the original conditional child check. Header-only reconstruction
		// must not encode otherwise unused detail prefixes; no eager extra parse
		// or changed malformed-input boundary is introduced by the row index.
		hasRows(scope: LiveJournalScope): boolean {
			return frames.some(frame => frame.table !== "scopes" && equalNative(frame.key.slice(0, 3), scopeKey(scope)));
		},
	});
}
function captureEmptyHeaderFrame(selected: LiveJournalScope, value: unknown): Uint8Array {
	const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
	const get = (key: string) => Object.getOwnPropertyDescriptor(typed, key)?.get;
	const length = get("byteLength")?.call(value) as unknown;
	const offset = get("byteOffset")?.call(value) as unknown;
	const buffer = get("buffer")?.call(value) as unknown;
	const kind = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)?.get?.call(value) as unknown;
	if (kind !== "Uint8Array" || typeof length !== "number" || length <= 0 || length > LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes ||
		typeof offset !== "number" || !(buffer instanceof ArrayBuffer)) throw new TypeError("malformed-input");
	const bytes = new Uint8Array(new Uint8Array(buffer, offset, length));
	const frame = decodeNativeFrames([bytes])[0];
	if (frame === undefined || frame.table !== "scopes" ||
		!equalNative(frame.key, [selected.objectId, selected.epoch, selected.anchorDigest]) ||
		!equalNative(bytes, journalRetirementCanonicalRow(frame.table, frame.key, frame.row))) throw new TypeError("malformed-input");
	const sql = frame.row !== null && typeof frame.row === "object" && Object.hasOwn(frame.row, "object_id");
	const membership = sql ? "closed_membership_bytes" : "closedMembershipBytes";
	const row = record(frame.row, [...(sql ? ["object_id", "epoch", "anchor_digest", "next_journal_sequence", "exact_anchor_preimage", "detached_anchor_signature", "parameters_digest", "exact_parameters_carrier"]
		: ["objectId", "epoch", "anchorDigest", "nextJournalSequence", "exactCanonicalAnchorPreimageBytes", "detachedAnchorSignature", "parametersDigest", "exactCanonicalParametersCarrierBytes"]),
		...(Object.hasOwn(frame.row as object, membership) ? [membership] : [])]);
	if (row[sql ? "object_id" : "objectId"] !== selected.objectId || row.epoch !== selected.epoch ||
		row[sql ? "anchor_digest" : "anchorDigest"] !== selected.anchorDigest) throw new TypeError("malformed-input");
	integer(row[sql ? "next_journal_sequence" : "nextJournalSequence"]);
	const captured = captureLiveJournalInput("installEpochAnchor", { objectId: selected.objectId,
		exactCanonicalAnchorPreimageBytes: row[sql ? "exact_anchor_preimage" : "exactCanonicalAnchorPreimageBytes"],
		detachedAnchorSignature: row[sql ? "detached_anchor_signature" : "detachedAnchorSignature"],
		exactCanonicalParametersCarrierBytes: row[sql ? "exact_parameters_carrier" : "exactCanonicalParametersCarrierBytes"] });
	if (!captured.ok || !("stored" in captured.value) || !equalNative(captured.value.stored.scope, selected) ||
		captured.value.parametersDigest !== row[sql ? "parameters_digest" : "parametersDigest"]) throw new TypeError("malformed-input");
	return bytes;
}
/** Closed structural restoration capture, not signature or closed-set verification. */
function captureReceivedDrainFrame(selected: JournalRetirementDrainRow, value: unknown): Uint8Array {
	const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
	const get = (key: string) => Object.getOwnPropertyDescriptor(typed, key)?.get;
	const length = get("byteLength")?.call(value) as unknown;
	const offset = get("byteOffset")?.call(value) as unknown;
	const buffer = get("buffer")?.call(value) as unknown;
	const kind = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)?.get?.call(value) as unknown;
	if (
		kind !== "Uint8Array" ||
		typeof length !== "number" ||
		length <= 0 ||
		length > LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes ||
		typeof offset !== "number" ||
		!(buffer instanceof ArrayBuffer)
	)
		throw new TypeError("malformed-input");
	// Native ArrayBuffer access refuses shared/detached storage; copy no caller iterator.
	Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get?.call(buffer);
	const bytes = new Uint8Array(new Uint8Array(buffer, offset, length));
	const frame = decodeNativeFrames([bytes])[0];
	if (
		frame === undefined ||
		!matchesDrainKey(frame, selected) ||
		journalRetirementFrameDigest(bytes) !== selected.row.nativeFrameDigest
	)
		throw new TypeError("malformed-input");
	const sql = frame.table === "accepted_entries";
	if (!sql && frame.table !== "acceptedEntries") throw new TypeError("malformed-input");
	const row = record(
		frame.row,
		sql
			? [
					"object_id",
					"epoch",
					"anchor_digest",
					"journal_sequence",
					"source_kind",
					"vertex_digest",
					"received_preimage",
					"received_signature",
					"local_author",
					"local_author_sequence",
				]
			: [
					"objectId",
					"epoch",
					"anchorDigest",
					"journalSequence",
					"sourceKind",
					"vertexDigest",
					"exactCanonicalPreimageBytes",
					"detachedSignature",
				]
	);
	if (
		row[sql ? "object_id" : "objectId"] !== selected.scope.objectId ||
		row.epoch !== selected.scope.epoch ||
		row[sql ? "anchor_digest" : "anchorDigest"] !== selected.scope.anchorDigest ||
		row[sql ? "journal_sequence" : "journalSequence"] !== selected.row.journalSequence ||
		row[sql ? "source_kind" : "sourceKind"] !== "received" ||
		row[sql ? "vertex_digest" : "vertexDigest"] !== selected.row.vertexDigest ||
		(sql && (row.local_author !== null || row.local_author_sequence !== null))
	)
		throw new TypeError("malformed-input");
	const captured = captureLiveJournalInput("append", {
		scope: selected.scope,
		sourceKind: "received",
		vertexDigest: selected.row.vertexDigest,
		exactCanonicalPreimageBytes: row[sql ? "received_preimage" : "exactCanonicalPreimageBytes"],
		detachedSignature: row[sql ? "received_signature" : "detachedSignature"],
	});
	if (
		!captured.ok ||
		!captureLiveJournalInput("received", captured.value).ok ||
		!equalNative(bytes, journalRetirementCanonicalRow(frame.table, frame.key, frame.row))
	)
		throw new TypeError("malformed-input");
	return bytes;
}
function matchesDrainFrame(frame: NativeFrame, selected: JournalRetirementDrainItem): boolean {
	if (!("row" in selected)) return matchesDrainKey(frame, selected) && equalNative(frame.bytes, selected.exactCanonicalNativeFrameBytes);
	return (
		matchesDrainKey(frame, selected) &&
		journalRetirementFrameDigest(frame.bytes) === selected.row.nativeFrameDigest &&
		(selected.row.exactCanonicalNativeFrameBytes === undefined ||
			equalNative(frame.bytes, selected.row.exactCanonicalNativeFrameBytes))
	);
}
function imageOfFrames(frames: readonly NativeFrame[]): LiveJournalRetirementImage {
	const scopeCount = frames.reduce((sum, frame) => sum + Number(frame.table === "scopes"), 0);
	if (!journalRetirementImageCountsFit(scopeCount, frames.length - scopeCount)) throw new TypeError("retirement-fenced");
	// These are this invocation's private canonical-decoder outputs, not public
	// mutable row objects. The existing bounded capture charges each row before
	// assembling the exact image, reusing its encoded syntax instead of encoding
	// every row again. No input, signature or currency fact survives this call.
	const capture = createJournalRetirementImageCapture();
	try {
		for (const frame of frames)
			// Without a frame key this tag only selects the image's rows vector;
			// browser acceptedEntries rows keep their original schema and NULLs.
			capture.append(frame.table === "scopes" ? "scopes" : "accepted_entries", frame.row);
		return capture.finish();
	} finally { capture.release(); }
}
function compareFrameKeys(left: Pick<NativeFrame, "table" | "key">, right: Pick<NativeFrame, "table" | "key">): number {
	if (left.table === "scopes" && right.table !== "scopes") return -1;
	if (left.table !== "scopes" && right.table === "scopes") return 1;
	for (let index = 0; index < left.key.length; index++) {
		const a = left.key[index],
			b = right.key[index];
		if (a === b) continue;
		if (typeof a === "number" && typeof b === "number") return a - b;
		if (typeof a === "string" && typeof b === "string") return a < b ? -1 : 1;
		throw new TypeError("malformed-input");
	}
	return 0;
}
/** Work counts of the drain-source reconstruction in this process: full derivations of the
 * original image (decode every frame, rebuild every retired row, re-encode and compare) and
 * verified reuses of an earlier derivation. Measurement only. */
export interface JournalRetirementDrainSourceCounts {
	readonly derivations: number;
	readonly reuses: number;
}
const drainSourceWork = { derivations: 0, reuses: 0 };
/** @returns This process's drain-source reconstruction work counts so far. */
export function journalRetirementDrainSourceCounts(): JournalRetirementDrainSourceCounts {
	return Object.freeze({ ...drainSourceWork });
}
/** Reconstructs original local metadata through the adapter codec and received
 * detail through its exact captured native frame. Consumers still own protocol reauthentication.
 * A finished checkpoint with newer legitimate work is not an old-source view. */
export function reconstructJournalRetirementDrainSource(
	control: LiveJournalRetirementControl | null,
	image: LiveJournalRetirementImage,
	frames: readonly Uint8Array[],
	reconstructLocal: (selected: JournalRetirementDrainRow) => Uint8Array
): LiveJournalRetirementDrainSource | undefined {
	const state = control?.drain;
	if (state == null || control === null) return undefined;
	const base = state.plan.baseControl,
		rows = drainItems(state.plan),
		finished = state.cursor === rows.length;
	const current =
		control.active === null &&
		control.sequence === base.sequence &&
		control.revision === base.revision + 1 + state.batches &&
		equalNative(control.completed, base.completed) &&
		image.imageDigest === state.residualImageDigest;
	if (!current) {
		if (finished) return undefined;
		throw new TypeError("retirement-stale");
	}
	drainSourceWork.derivations++;
	const actual = decodeNativeFrames(frames),
		original = [...actual], indexByKey = indexNativeDrainFrames(actual, rows);
	for (const [index, selected] of rows.entries()) {
		const found = indexByKey.find(selected);
		if (index < state.cursor) {
			if (found.length !== 0) throw new TypeError("retirement-stale");
			const bytes = "row" in selected
				? selected.row.exactCanonicalNativeFrameBytes?.slice() ?? reconstructLocal(selected)
				: selected.exactCanonicalNativeFrameBytes.slice(),
				reconstructed = decodeNativeFrames([bytes])[0];
			if (reconstructed === undefined || !matchesDrainFrame(reconstructed, selected))
				throw new TypeError("retirement-stale");
			original.push(reconstructed);
		} else if (found.length !== 1 || found[0] === undefined || !matchesDrainFrame(found[0], selected))
			throw new TypeError("retirement-stale");
	}
	original.sort(compareFrameKeys);
	const originalImage = imageOfFrames(original);
	if (!equalNative(originalImage, state.plan.sourceImage)) throw new TypeError("retirement-stale");
	return Object.freeze({
		control: captureJournalRetirementControl(base),
		image: originalImage,
		canonicalRows: Object.freeze(original.map((frame) => frame.bytes.slice())),
	});
}
/** Detach only mutable leaves of this owner's already captured, deeply frozen
 * control. No result is retained across native reads or used as authorization.
 * The base control cannot contain a nested drain; all other shared leaves are
 * frozen primitive-only structures established by the original capture. */
function detachCapturedJournalRetirementControl(own: LiveJournalRetirementControl): LiveJournalRetirementControl {
	if (own.drain == null) return own;
	const state = own.drain, plan = state.plan;
	return Object.freeze({
		...own,
		drain: Object.freeze({
			...state,
			plan: Object.freeze({
				...plan,
				prefixes: Object.freeze(plan.prefixes.map(prefix => Object.freeze({
					...prefix,
					rows: Object.freeze(prefix.rows.map(row => row.exactCanonicalNativeFrameBytes === undefined
						? row : Object.freeze({...row, exactCanonicalNativeFrameBytes: row.exactCanonicalNativeFrameBytes.slice()}))),
				}))),
				...(plan.retiredEmptyHeaders === undefined ? {} : {
					retiredEmptyHeaders: Object.freeze(plan.retiredEmptyHeaders.map(header => Object.freeze({
						...header, exactCanonicalNativeFrameBytes: header.exactCanonicalNativeFrameBytes.slice(),
					}))),
				}),
			}),
		}),
	});
}
/**
 * Creates one-use native CAS custody with joined release and detached public fields.
 * @param control - Actual native control preimage.
 * @param image - Complete bounded native image commitment.
 * @param compare - The owning adapter's exact native image/control CAS.
 * @param frames - Exact canonical rows from that same native capture, scopes before entries.
 * @returns The mechanical control read; never protocol eligibility.
 */
export function createJournalRetirementControlRead(
	control: LiveJournalRetirementControl,
	image: LiveJournalRetirementImage,
	compare: (
		next: LiveJournalRetirementControl,
		deletions: readonly JournalRetirementDrainItem[] | undefined,
		nextCarriers: Readonly<{controlBytes: Uint8Array; planBytes?: Uint8Array}>
	) => Promise<LiveJournalRetirementResult<LiveJournalRetirementControl>>,
	frames: readonly Uint8Array[],
	drainSource?: LiveJournalRetirementDrainSource
): LiveJournalRetirementControlRead {
	return createCapturedJournalRetirementControlRead(captureJournalRetirementControl(control), image, compare, frames, drainSource);
}
function createCapturedJournalRetirementControlRead(
	own: LiveJournalRetirementControl,
	image: LiveJournalRetirementImage,
	compare: Parameters<typeof createJournalRetirementControlRead>[2],
	frames: readonly Uint8Array[],
	drainSource?: LiveJournalRetirementDrainSource,
	planSyntax?: CapturedNativePlanSyntax
): LiveJournalRetirementControlRead {
	const native = encodeCapturedJournalRetirementNativeCarriers(own, planSyntax);
	// A caller may retain an ended public view indefinitely. It must not keep
	// this store's extra encoded-plan copy alive after eviction/release. The view
	// already owns its isolated logical control; encoding can fall back to that
	// validated representation if the original syntax owner has evicted its cell.
	const syntaxReference = planSyntax === undefined ? undefined : new WeakRef(planSyntax);
	if (frames.length !== image.scopeCount + image.rowCount) throw new TypeError("retirement-fenced");
	let frameCharge = 0;
	const exactRows = frames.map((frame) => {
		frameCharge += frame.byteLength;
		if (frameCharge > LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes) throw new TypeError("retirement-fenced");
		return frame.slice();
	});
	let used = false,
		released = false;
	let pending: Promise<LiveJournalRetirementResult<LiveJournalRetirementControl>> | undefined;
	const change = (
		receiver: unknown,
		transition: () => LiveJournalRetirementControl,
		deletions?: readonly JournalRetirementDrainItem[]
	): Promise<LiveJournalRetirementResult<LiveJournalRetirementControl>> => {
		if (receiver !== view) return Promise.resolve(fail("malformed-input"));
		if (used || released) return Promise.resolve(fail("retirement-released"));
		let next: LiveJournalRetirementControl;
		let nextCarriers: Readonly<{controlBytes: Uint8Array; planBytes?: Uint8Array}>;
		try {
			next = transition();
			// The transition returned this private owner's validated postimage.
			// Capture its carriers once before the native attempt; adapters may use
			// those exact bytes for writing and independent readback comparison.
			// They must still capture/check every freshly read native pre/postimage.
			nextCarriers = encodeCapturedJournalRetirementNativeCarriers(next, syntaxReference?.deref());
		} catch (error) {
			const message = error instanceof Error ? error.message : "malformed-input";
			return Promise.resolve(
				fail(message === "retirement-transition" || message === "retirement-exhausted" ? message : "malformed-input")
			);
		}
		used = true; // A genuine native attempt consumes even a busy/uncertain result.
		// Even an adapter callback receives detached mutable leaves, never the
		// codec's retained plan. It cannot poison later exact-byte syntax reuse.
		const exposedNext = detachCapturedJournalRetirementControl(next);
		const exposedDeletions = deletions?.map(selected => "row" in selected ? Object.freeze({
			...selected, row: selected.row.exactCanonicalNativeFrameBytes === undefined ? selected.row : Object.freeze({
				...selected.row, exactCanonicalNativeFrameBytes: selected.row.exactCanonicalNativeFrameBytes.slice(),
			}),
		}) : Object.freeze({...selected, exactCanonicalNativeFrameBytes: selected.exactCanonicalNativeFrameBytes.slice()}));
		pending = Promise.resolve().then(() => compare(exposedNext, exposedDeletions, nextCarriers));
		return pending;
	};
	const view: LiveJournalRetirementControlRead = Object.freeze({
		control: detachCapturedJournalRetirementControl(own),
		exactCanonicalControlCarriers: Object.freeze([
			native.controlBytes,
			...(native.planBytes === undefined ? [] : [native.planBytes]),
		]),
		image: Object.freeze({ ...image }),
		...(drainSource === undefined
			? {}
			: {
					drainSource: Object.freeze({
						control: captureJournalRetirementControl(drainSource.control),
						image: Object.freeze({ ...drainSource.image }),
						canonicalRows: Object.freeze(drainSource.canonicalRows.map((bytes) => bytes.slice())),
					}),
				}),
		domainDigest: Array.from(
			hashDomain(
				"ts-drp/live-journal-retirement-domain/v1",
				encodeCanonical({
					controlBytes: native.controlBytes,
					planBytes: native.planBytes ?? null,
					image,
				})
			),
			(b) => b.toString(16).padStart(2, "0")
		).join(""),
		readExactCanonicalRows: function () {
			if (this !== view) throw new TypeError("malformed-input");
			if (used || released) throw new TypeError("retirement-released");
			return Object.freeze(exactRows.map((frame) => frame.slice()));
		},
		prepareFence: function (input: LiveJournalRetirementPreparation) {
			return change(this, () => {
				const preparation = captureJournalRetirementPreparation(input, own.objectId);
				if (
					own.active !== null ||
					(own.completed !== null && !frontierAdvanceAllowed(own.completed, preparation)) ||
					(own.drain != null && own.drain.cursor !== journalRetirementDrainItemCount(own.drain.plan))
				)
					throw new TypeError("retirement-transition");
				if (own.sequence === Number.MAX_SAFE_INTEGER) throw new TypeError("retirement-exhausted");
				return captureJournalRetirementControl({
					...advanceJournalRetirementControl(own),
					sequence: own.sequence + 1,
					active: { sequence: own.sequence + 1, preparation },
				});
			});
		},
		abortPrepared: function () {
			return change(this, () => {
				if (own.active === null) throw new TypeError("retirement-transition");
				return captureJournalRetirementControl({ ...advanceJournalRetirementControl(own), active: null });
			});
		},
		commitPrepared: function () {
			return change(this, () => {
				if (own.active === null) throw new TypeError("retirement-transition");
				return captureJournalRetirementControl({
					...advanceJournalRetirementControl(own),
					completed: own.active.preparation,
					active: null,
					...(own.kind === "v3-live-journal-retirement-control-2" ? { drain: null } : {}),
				});
			});
		},
		beginDrain: function (input: LiveJournalRetirementDrainPlan) {
			return change(this, () => {
				const observeRefusal = (site: string, details: object = {}): void => {
					try {const observer = Reflect.get(globalThis, "__warmProofEvent");
						if (typeof observer === "function") observer({kind: "native-journal-drain-refused", site,
							throughEpoch: own.completed?.throughEpoch, revision: own.revision, ...details});
					} catch { /* Diagnostics never alter native refusal or authority. */ }
				};
				let plan: LiveJournalRetirementDrainPlan;
				try {plan = captureJournalRetirementDrainPlan(input);}
				catch (error) {observeRefusal("plan-capture"); throw error;}
				if (
					own.active !== null ||
					own.completed === null ||
					own.drain != null ||
					!equalNative(plan.baseControl, own) ||
					!equalNative(plan.sourceImage, image)
				)
					{observeRefusal("source-control-image"); throw new TypeError("retirement-transition");}
				const actual = decodeNativeFrames(exactRows), items = drainItems(plan),
					indexByKey = indexNativeDrainFrames(actual, items);
				for (const selected of items) {
					const found = indexByKey.find(selected);
					if (found.length !== 1 || found[0] === undefined || !matchesDrainFrame(found[0], selected))
						{observeRefusal("native-frame-correspondence", {epoch: selected.scope.epoch,
							itemKind: "row" in selected ? "row" : "header", found: found.length,
							expectedScope: selected.scope,
							directMatches: actual.filter(frame => matchesDrainKey(frame, selected)).length,
							nativeHeaderKeys: actual.filter(frame => frame.table === "scopes").slice(0, 16).map(frame => frame.key),
							expectedDigest: "row" in selected ? selected.row.nativeFrameDigest : journalRetirementFrameDigest(selected.exactCanonicalNativeFrameBytes),
							actualDigests: found.map(frame => journalRetirementFrameDigest(frame.bytes)),
							sequence: "row" in selected ? selected.row.journalSequence : null});
							throw new TypeError("retirement-transition");}
					if (!("row" in selected) && indexByKey.hasRows(selected.scope)) {
						observeRefusal("nonempty-header"); throw new TypeError("retirement-transition");
					}
				}
				return captureJournalRetirementControlWithPlan({
					...advanceJournalRetirementControl(own),
					kind: "v3-live-journal-retirement-control-2",
					drain: { plan, cursor: 0, batches: 0, residualImageDigest: image.imageDigest },
				}, plan);
			});
		},
		drainBatch: function () {
			const state = own.drain;
			const deletions =
				state == null
					? []
					: drainItems(state.plan).slice(state.cursor, state.cursor + LIVE_JOURNAL_RETIREMENT_BATCH_ROWS);
			return change(
				this,
				() => {
					if (
						state == null ||
						own.active !== null ||
						deletions.length === 0 ||
						image.imageDigest !== state.residualImageDigest
					)
						throw new TypeError("retirement-transition");
					const actual = decodeNativeFrames(exactRows), indexByKey = indexNativeDrainFrames(actual, deletions),
						removed = new Set<NativeFrame>();
					for (const selected of deletions) {
						const found = indexByKey.find(selected);
						if (found.length !== 1 || found[0] === undefined || !matchesDrainFrame(found[0], selected))
							throw new TypeError("retirement-transition");
						if (!("row" in selected) && indexByKey.hasRows(selected.scope)) throw new TypeError("retirement-transition");
						removed.add(found[0]);
					}
					const remaining = actual.filter((frame) => !removed.has(frame));
					const postimage = imageOfFrames(remaining);
					if (own.revision === Number.MAX_SAFE_INTEGER) throw new TypeError("retirement-exhausted");
					// Validate the atomic cursor/revision postimage, never an impossible
					// intermediate revision with the prior unfinished cursor.
					return captureJournalRetirementControlWithPlan({
						...own,
						revision: own.revision + 1,
						drain: {
							...state,
							cursor: state.cursor + deletions.length,
							batches: state.batches + 1,
							residualImageDigest: postimage.imageDigest,
						},
					}, state.plan);
				},
				deletions
			);
		},
		acknowledgeCompletedDrain: function () {
			return change(this, () => {
				const state = own.drain;
				if (own.active !== null || own.completed === null || state == null ||
					state.cursor !== journalRetirementDrainItemCount(state.plan) ||
					image.imageDigest !== state.residualImageDigest)
					throw new TypeError("retirement-transition");
				// The SAME compact delta already used by a subsequent genuine append,
				// without inventing an operation or changing any data/header bytes.
				return advanceCapturedJournalRetirementMutationControl(own);
			});
		},
		release: async () => {
			released = true;
			if (pending !== undefined)
				await pending.then(
					() => undefined,
					() => undefined
				);
		},
	});
	return view;
}
