import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";

import {
	applySettlementPlanEffect,
	assertDurableIssueScope,
	compareDurableIssuanceCompoundKeys,
	copyDurableIssuanceBytes,
	copyDurableIssueScope,
	copySettlementPlan,
	settlementSourceContextsForEntries,
	copySettlementPlanEffect,
	createDurableIssuanceFailure,
	DurableIssuanceInvalidArgumentError,
	isClosedDurableIssuanceRecord,
	isValidDurableAuthorSequence,
	isValidDurableScopeField,
	settlementReplacementLastLogicalTimeFromPreimage,
} from "./contract.js";
import { durablePreimageHeader } from "./preimage-header.js";
import {
	type DurableIssueCommit,
	type DurableIssueScope,
	type DurableIssueSignContext,
	type DurableLineage,
	SETTLEMENT_REPLACEMENT_DIGEST_LIMITS,
	type SettlementPlan,
} from "./types.js";
import {
	detachIssuanceVerifiedValue,
	issuanceExactBytesEqual,
	IssuanceVerifiedOnceBytes,
	type IssuanceVerifiedOnceCounts,
} from "./verified-once.js";

// Reuse the issuance owner's existing finite canonical envelope. Not protocol eligibility.
export const ISSUANCE_RETIREMENT_LIMITS = Object.freeze({
	maxRows: SETTLEMENT_REPLACEMENT_DIGEST_LIMITS.maxItems,
	maxBytes: SETTLEMENT_REPLACEMENT_DIGEST_LIMITS.maxBytes,
});
export interface DurableIssuanceRetirementHole {
	readonly author: string;
	readonly authorSequence: number;
	readonly digest: string;
}
export interface DurableIssuanceRetirementPreparation {
	readonly decisionDigest: string;
	readonly sourceProofDigest: string;
	readonly throughEpoch: number;
	readonly protectedRecords: readonly DurableIssuanceRetirementHole[];
	/** Bounded exact native image delta. This is recovery custody, never eligibility. */
	readonly planRewrite?: DurableIssuanceRetirementPlanRewrite;
}
export interface DurableIssuanceRetirementPlanRewrite {
	readonly kind: "v3-issuance-retirement-plan-rewrite-1";
	readonly sourceImageDigest: string;
	readonly targetImageDigest: string;
	readonly plans: readonly Readonly<{ before: Uint8Array; after: Uint8Array }>[];
}
export interface DurableIssuanceRetirementControl {
	readonly kind: "v3-issuance-retirement-control-1";
	readonly objectId: string;
	readonly incarnation: string;
	readonly revision: number;
	readonly sequence: number;
	readonly active: Readonly<{ sequence: number; preparation: DurableIssuanceRetirementPreparation }> | null;
	readonly completed: DurableIssuanceRetirementPreparation | null;
}
export interface DurableIssuanceRetirementImage {
	readonly imageDigest: string;
	readonly logicalBytes: number;
	readonly lineageCount: number;
	readonly issuedCount: number;
	readonly outboxCount: number;
	readonly planCount: number;
}
export interface IssuanceRetirementRows {
	readonly lineages: readonly Readonly<
		DurableIssueScope & { next: number; exhausted: boolean; prunedThroughAuthorSequence: number | null;
			pendingUnsigned?: DurableIssuancePendingUnsignedIntent }
	>[];
	readonly issued: readonly Readonly<
		DurableIssueScope & {
			authorSequence: number;
			canonicalPreimageBytes: Uint8Array;
			digest: Uint8Array;
			signature: Uint8Array;
		}
	>[];
	readonly outbox: readonly Readonly<
		DurableIssueScope & { authorSequence: number; digest: Uint8Array; publishState: "pending" | "published" }
	>[];
	readonly plans: readonly SettlementPlan[];
}

/** Mechanical, bounded custody of one selected ordinal; never signing authority. */
export interface DurableIssuancePendingUnsignedIntent {
	readonly kind: "v3-issuance-pending-unsigned-1";
	readonly incarnation: string;
	readonly authorSequence: number;
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly phase: "reserved" | "entered";
	readonly planEffect?: NonNullable<DurableIssueCommit["planEffect"]>;
	readonly exactCanonicalPlanBytes?: Uint8Array;
}

/** Validates stored original unsigned custody, without granting crypto eligibility. */
export function captureIssuancePendingUnsignedIntent(
	input: unknown, scope: DurableIssueScope
): DurableIssuancePendingUnsignedIntent {
	if (input === null || typeof input !== "object") throw invalid();
	const hasEffect = Object.hasOwn(input, "planEffect");
	if (!isClosedDurableIssuanceRecord(input, ["kind", "incarnation", "authorSequence", "canonicalPreimageBytes", "digest", "phase",
		...(hasEffect ? ["planEffect", "exactCanonicalPlanBytes"] : [])]) ||
		input.kind !== "v3-issuance-pending-unsigned-1" || typeof input.incarnation !== "string" ||
		!/^[0-9a-f]{64}$/u.test(input.incarnation) || (input.phase !== "reserved" && input.phase !== "entered")) throw invalid();
	const captured = captureIssuanceNativeSignInput({ scope, exactCanonicalUnsignedVertexBytes: input.canonicalPreimageBytes });
	if (captured.sequence !== input.authorSequence || !(input.digest instanceof Uint8Array) ||
		!issuanceRetirementBytesEqual(captured.digest, input.digest)) throw invalid();
	const planEffect = hasEffect ? copySettlementPlanEffect(input.planEffect) : undefined;
	const planBytes = hasEffect && input.exactCanonicalPlanBytes instanceof Uint8Array ? new Uint8Array(input.exactCanonicalPlanBytes) : undefined;
	if (hasEffect && (planEffect === undefined || planBytes === undefined || planBytes.byteLength === 0 ||
		planBytes.byteLength > ISSUANCE_RETIREMENT_LIMITS.maxBytes)) throw invalid();
	if (planBytes !== undefined) {
		const plan = copySettlementPlan(decodeCanonical(planBytes), scope);
		if (plan === undefined || !issuanceRetirementBytesEqual(encodeCanonical(plan), planBytes)) throw invalid();
	}
	const detached: DurableIssuancePendingUnsignedIntent = { kind: "v3-issuance-pending-unsigned-1", incarnation: input.incarnation,
		authorSequence: captured.sequence, canonicalPreimageBytes: captured.bytes, digest: captured.digest, phase: input.phase,
		...(planEffect === undefined ? {} : {planEffect, exactCanonicalPlanBytes: planBytes!}) };
	encodeCanonical(detached, {maxBytes: ISSUANCE_RETIREMENT_LIMITS.maxBytes, maxDepth: 16, maxItems: ISSUANCE_RETIREMENT_LIMITS.maxRows * 32});
	return Object.freeze(detached);
}

/** The unsigned fields of the original pending-intent codec, not an admission. */
export type IssuanceUnsignedProspectiveIntent = Omit<DurableIssuancePendingUnsignedIntent, "incarnation" | "phase">;

export interface IssuanceUnsignedPhaseWidths {
	readonly rowCount: number;
	readonly canonicalRowsBytes: number;
	readonly canonicalRowBytes: readonly number[];
	readonly encodedControlBytes: number;
	readonly nativeCensusBytes: number;
}

/** A numerical alternative for retaining accepted source work after a future
 * authenticated checkpoint. This is not a plan, source proof or disposition. */
export interface IssuanceSourceCustodyGeometry {
	readonly maxContextByteLength: number;
	readonly maxCompletionByteLength: number;
	readonly maxCompletionMemberByteLength: number;
	readonly maxExpiryByteLength: number;
	readonly maxNativeReadByteLength: number;
}

export const CANONICAL_SETTLEMENT_PLAN_STORAGE_KIND = "canonical-settlement-plan-1";
/** Exact ASCII JSON/base64 width used by the native whole-plan carrier. */
export function issuanceCanonicalSettlementPlanStorageByteLength(canonicalByteLength: number): number {
	if (!Number.isSafeInteger(canonicalByteLength) || canonicalByteLength < 1 ||
		canonicalByteLength > ISSUANCE_RETIREMENT_LIMITS.maxBytes) throw invalid();
	return JSON.stringify({kind: CANONICAL_SETTLEMENT_PLAN_STORAGE_KIND, bytes: ""}).length +
		4 * Math.ceil(canonicalByteLength / 3);
}

/** Original legacy native plan entries representation, shared with SQLite. */
export function issuanceLegacySettlementPlanEntriesJson(plan: SettlementPlan): string {
	return JSON.stringify(
		plan.entries.map((entry) => ({
			disposition: entry.disposition,
			...(entry.sourceObjectId === undefined ? {} : { sourceObjectId: entry.sourceObjectId }),
			...(entry.transformRefusal===undefined?{}:{transformRefusal:{...entry.transformRefusal,proposedIntentDigest:[...entry.transformRefusal.proposedIntentDigest]}}),
			...(entry.inheritance === undefined
				? {}
				: {
						inheritance: {
							...entry.inheritance,
							targetVertexDigest: [...entry.inheritance.targetVertexDigest],
						},
					}),
			...(entry.replacementProgress === undefined
				? {}
				: {
						replacementProgress: {
							chunks: entry.replacementProgress.chunks.map((chunk) => ({ ...chunk })),
							intentCount: entry.replacementProgress.intentCount,
							intentDigest: [...entry.replacementProgress.intentDigest],
							version: 1,
						},
					}),
			replacementSequence: entry.replacementSequence,
			sourceDigest: [...entry.sourceDigest],
			sourceSequence: entry.sourceSequence,
		}))
	);
}

export function issuanceSettlementPlanStorageByteLength(plan: SettlementPlan): number {
	return plan.sourceContexts === undefined && plan.handBacks === undefined
		? new TextEncoder().encode(issuanceLegacySettlementPlanEntriesJson(plan)).byteLength
		: issuanceCanonicalSettlementPlanStorageByteLength(encodeCanonical(plan, unsignedEncodingLimits).byteLength);
}

/** Source-context and entry fields are sized by the original plan codec. Every
 * existing entry/context remains whole. One future current-epoch context and
 * every potentially unresolved own row and its terminal receipt are charged without inventing bytes. */
export function issuanceSourceCustodyPlanResourceForSizing(scope: DurableIssueScope, prior: SettlementPlan | null,
	maxSourceCount: number, geometry: IssuanceSourceCustodyGeometry): Readonly<{
		byteLength: number; items: number; maxDepth: number; nativeStorageByteLength: number;
	}> {
	assertDurableIssueScope(scope);
	const captured = prior === null ? null : copySettlementPlan(prior, scope);
	if (captured === undefined || !isClosedDurableIssuanceRecord(geometry, ["maxContextByteLength", "maxCompletionByteLength", "maxCompletionMemberByteLength", "maxExpiryByteLength", "maxNativeReadByteLength"]) ||
		!Number.isSafeInteger(maxSourceCount) || maxSourceCount < 0 || maxSourceCount > ISSUANCE_RETIREMENT_LIMITS.maxRows ||
		!Number.isSafeInteger(geometry.maxContextByteLength) || geometry.maxContextByteLength < 1 ||
		!Number.isSafeInteger(geometry.maxCompletionByteLength) || geometry.maxCompletionByteLength < 1 ||
		!Number.isSafeInteger(geometry.maxCompletionMemberByteLength) || geometry.maxCompletionMemberByteLength < 1 ||
		!Number.isSafeInteger(geometry.maxExpiryByteLength) || geometry.maxExpiryByteLength < 1 ||
		!Number.isSafeInteger(geometry.maxNativeReadByteLength) || geometry.maxNativeReadByteLength < 1 ||
		geometry.maxNativeReadByteLength > ISSUANCE_RETIREMENT_LIMITS.maxBytes ||
		geometry.maxContextByteLength + geometry.maxCompletionByteLength > geometry.maxNativeReadByteLength) throw invalid();
	const bytesWidth = (length: number) => 1 + unsignedVaruintWidth(length) + length;
	const digest = bytesWidth(32), integer = encodeCanonical(Number.MAX_SAFE_INTEGER).byteLength;
	const leaf = Object.freeze({items: 1, maxDepth: 0});
	const originalEntries = captured?.entries ?? [];
	if (originalEntries.length + maxSourceCount > ISSUANCE_RETIREMENT_LIMITS.maxRows) throw invalid();
	// An existing entry still without a resolution may later be resolved from the settlement
	// frontier: charge it as expire with the frontier kind too, keeping the wider form.
	const originalEntryForms = (entry: SettlementPlan["entries"][number]) => {
		const {sourceContextDigest: _context, sourceResolutionDigest: _resolution, ...fields} = entry;
		return entry.sourceResolutionDigest !== undefined || entry.sourceContextDigest === undefined ? [fields]
			: [fields, {...fields, disposition: "expire", sourceResolutionKind: "frontier"}];
	};
	const entryWidths = originalEntries.map(entry => Math.max(...originalEntryForms(entry).map(fields =>
		unsignedRecordWidth(fields, {sourceContextDigest: digest, sourceResolutionDigest: digest}))));
	const entryShapes = originalEntries.map(entry => {
		const shapes = originalEntryForms(entry).map(fields => unsignedRecordShape(fields, {sourceContextDigest: leaf, sourceResolutionDigest: leaf}));
		return Object.freeze({items: Math.max(...shapes.map(shape => shape.items)), maxDepth: Math.max(...shapes.map(shape => shape.maxDepth))});
	});
	// A potential row ends either in manual review or resolved from the settlement frontier
	// (expire plus the frontier kind); the wider alternative is charged.
	const entryAlternatives = [{disposition: "manual-review", replacementSequence: null},
		{disposition: "expire", replacementSequence: null, sourceResolutionKind: "frontier"}];
	const entryWidth = Math.max(...entryAlternatives.map(entryFields => unsignedRecordWidth(entryFields,
		{sourceSequence: integer, sourceDigest: digest, sourceContextDigest: digest, sourceResolutionDigest: digest})));
	const entryAlternativeShapes = entryAlternatives.map(entryFields => unsignedRecordShape(entryFields,
		{sourceSequence: leaf, sourceDigest: leaf, sourceContextDigest: leaf, sourceResolutionDigest: leaf}));
	const entryShape = Object.freeze({items: Math.max(...entryAlternativeShapes.map(shape => shape.items)),
		maxDepth: Math.max(...entryAlternativeShapes.map(shape => shape.maxDepth))});
	// Potential rows need not be current APPs. Counting all of them is a positive
	// bound only; actual retention must still authenticate and classify each row.
	for (let index = 0; index < maxSourceCount; index++) { entryWidths.push(entryWidth); entryShapes.push(entryShape); }
	const contexts = captured?.sourceContexts ?? [];
	const contextWidths = contexts.map(context => encodeCanonical(context, unsignedEncodingLimits).byteLength);
	const contextShape = unsignedRecordShape({}, {digest: leaf, exactCanonicalContextBytes: leaf});
	const contextShapes = [...contexts.map(unsignedCanonicalShape)];
	const expiryCount = maxSourceCount + originalEntries.filter(entry => entry.sourceResolutionDigest === undefined &&
		entry.disposition !== "expire" && entry.disposition !== "inherited" && entry.replacementSequence === null).length;
	const additionalContexts = [geometry.maxContextByteLength, geometry.maxCompletionByteLength +
		(maxSourceCount + originalEntries.length) * geometry.maxCompletionMemberByteLength,
		...Array.from({length: expiryCount}, () => geometry.maxExpiryByteLength)];
	for (const length of additionalContexts) {
		contextWidths.push(unsignedRecordWidth({}, {digest, exactCanonicalContextBytes: bytesWidth(length)}));
		contextShapes.push(contextShape);
	}
	if (contexts.reduce((sum, context) => sum + context.exactCanonicalContextBytes.byteLength, 0) +
		additionalContexts.reduce((sum, length) => sum + length, 0) > SETTLEMENT_REPLACEMENT_DIGEST_LIMITS.maxBytes)
		throw issuanceRetirementRefusal("source custody contexts exceed original plan bound");
	// Hand-back records already in the plan are charged exactly. Records a later frontier resolution adds
	// are bounded by SETTLEMENT_HAND_BACK_LIMITS (contract), far below the native read bound; reserving
	// that cap here for every author made each creator close quote exceed its prospective census.
	const existingHandBacks = captured?.handBacks;
	const handBacks = existingHandBacks === undefined ? undefined : {
		width: encodeCanonical(existingHandBacks, unsignedEncodingLimits).byteLength,
		shape: unsignedCanonicalShape(existingHandBacks),
	};
	const byteLength = unsignedRecordWidth({scope}, {revision: integer, fenceSequence: integer,
		entries: unsignedArrayWidth(entryWidths), sourceContexts: unsignedArrayWidth(contextWidths),
		...(handBacks === undefined ? {} : {handBacks: handBacks.width})});
	const shape = unsignedRecordShape({scope}, {revision: leaf, fenceSequence: leaf,
		entries: unsignedArrayShape(entryShapes), sourceContexts: unsignedArrayShape(contextShapes),
		...(handBacks === undefined ? {} : {handBacks: handBacks.shape})});
	const nativeStorageByteLength = issuanceCanonicalSettlementPlanStorageByteLength(byteLength);
	if (byteLength > geometry.maxNativeReadByteLength || nativeStorageByteLength > geometry.maxNativeReadByteLength)
		throw issuanceRetirementRefusal("source custody plan exceeds original native read bound");
	return Object.freeze({byteLength, ...shape, nativeStorageByteLength});
}

function sourceCustodyPlanWidths(plans: readonly SettlementPlan[], scope: DurableIssueScope, sourceCount: number,
	geometry: IssuanceSourceCustodyGeometry | undefined, nativeMaterialWithoutPlans: number): Readonly<{
		widths: readonly number[]; shapes: readonly IssuanceUnsignedCanonicalShape[];
	}> {
	if (geometry === undefined) return {widths: plans.map(plan => encodeCanonical(plan, unsignedEncodingLimits).byteLength),
		shapes: plans.map(unsignedCanonicalShape)};
	const own = plans.find(plan => plan.scope.objectId === scope.objectId && plan.scope.author === scope.author);
	const resource = issuanceSourceCustodyPlanResourceForSizing(scope, own ?? null, sourceCount, geometry);
	const widths = plans.map(plan => plan === own ? resource.byteLength : encodeCanonical(plan, unsignedEncodingLimits).byteLength);
	const shapes = plans.map(plan => plan === own ? resource : unsignedCanonicalShape(plan));
	if (own === undefined) { widths.push(resource.byteLength); shapes.push(resource); }
	const nativeStorage = nativeMaterialWithoutPlans + resource.nativeStorageByteLength +
		plans.filter(plan => plan !== own).reduce((total, plan) => total + issuanceSettlementPlanStorageByteLength(plan), 0);
	if (!Number.isSafeInteger(nativeStorage) || nativeStorage > geometry.maxNativeReadByteLength)
		throw issuanceRetirementRefusal("source custody native material exceeds original read bound");
	return {widths, shapes};
}

function checkSourceCustodyNativeWidths(widths: IssuanceUnsignedPhaseWidths,
	geometry: IssuanceSourceCustodyGeometry | undefined): IssuanceUnsignedPhaseWidths {
	if (geometry !== undefined && widths.canonicalRowsBytes > geometry.maxNativeReadByteLength)
		throw issuanceRetirementRefusal("source custody canonical census exceeds original read bound");
	return widths;
}

type UnsignedFinalRows = Omit<IssuanceRetirementRows, "issued"> & {
	readonly issued: readonly Omit<IssuanceRetirementRows["issued"][number], "signature">[];
};
function unsignedFinalRows(
	rows: IssuanceRetirementRows | UnsignedFinalRows,
	scope: DurableIssueScope,
	pending: Pick<
		DurableIssuancePendingUnsignedIntent,
		"authorSequence" | "canonicalPreimageBytes" | "digest" | "planEffect" | "exactCanonicalPlanBytes"
	>
): UnsignedFinalRows {
	const current = rows.lineages.find((l) => l.author === scope.author && l.objectId === scope.objectId);
	if (current === undefined || current.next !== pending.authorSequence || current.exhausted)
		throw issuanceRetirementRefusal("unsigned postimage lineage changed");
	const { pendingUnsigned: _pending, ...rest } = current;
	const lineages = rows.lineages.map((l) =>
		l === current
			? {
					...rest,
					exhausted: pending.authorSequence === Number.MAX_SAFE_INTEGER,
					next:
						pending.authorSequence === Number.MAX_SAFE_INTEGER ? pending.authorSequence : pending.authorSequence + 1,
				}
			: l
	);
	let plans = rows.plans;
	if (pending.planEffect !== undefined) {
		const plan = plans.find((p) => p.scope.author === scope.author && p.scope.objectId === scope.objectId);
		if (
			plan === undefined ||
			pending.exactCanonicalPlanBytes === undefined ||
			!issuanceRetirementBytesEqual(encodeCanonical(plan), pending.exactCanonicalPlanBytes)
		)
			throw issuanceRetirementRefusal("unsigned settlement context changed");
		const updated = applySettlementPlanEffect(
			plan,
			pending.planEffect,
			pending.authorSequence,
			settlementReplacementLastLogicalTimeFromPreimage(pending.canonicalPreimageBytes)
		);
		plans = plans.map((p) => (p === plan ? updated : p));
	}
	const unsignedRow = {
		...scope,
		authorSequence: pending.authorSequence,
		canonicalPreimageBytes: pending.canonicalPreimageBytes,
		digest: pending.digest,
	};
	const outbox = {
		...scope,
		authorSequence: pending.authorSequence,
		digest: pending.digest,
		publishState: "pending" as const,
	};
	return { lineages, issued: [...rows.issued, unsignedRow], outbox: [...rows.outbox, outbox], plans };
}

const unsignedEncodingLimits = Object.freeze({
	maxBytes: ISSUANCE_RETIREMENT_LIMITS.maxBytes,
	maxDepth: 16,
	maxItems: ISSUANCE_RETIREMENT_LIMITS.maxRows * 128,
});
interface IssuanceUnsignedCanonicalShape {
	readonly items: number;
	readonly maxDepth: number;
}
/** Encoded BYTES is one scalar node, including preimages and exact plans.
 * Decoded native ARRAY/RECORD fields keep all keys and children. */
function unsignedCanonicalShape(value: unknown): IssuanceUnsignedCanonicalShape {
	if (Array.isArray(value)) return unsignedArrayShape(value.map(unsignedCanonicalShape));
	if (value !== null && typeof value === "object" && !(value instanceof Uint8Array))
		return unsignedRecordShape({}, Object.fromEntries(Object.entries(value).map(([key, child]) =>
			[key, unsignedCanonicalShape(child)])));
	return Object.freeze({ items: 1, maxDepth: 0 });
}
function unsignedArrayShape(children: readonly IssuanceUnsignedCanonicalShape[]): IssuanceUnsignedCanonicalShape {
	// The decoder charges collection edges, then each recursively decoded node.
	const items = 1 + children.length + children.reduce((sum, child) => sum + child.items, 0);
	const maxDepth = children.length === 0 ? 0 : 1 + children.reduce((deepest, child) => Math.max(deepest, child.maxDepth), 0);
	if (!Number.isSafeInteger(items) || items > unsignedEncodingLimits.maxItems || maxDepth > unsignedEncodingLimits.maxDepth)
		throw invalid();
	return Object.freeze({ items, maxDepth });
}
function unsignedRecordShape(known: Readonly<Record<string, unknown>>,
	unknown: Readonly<Record<string, IssuanceUnsignedCanonicalShape>>): IssuanceUnsignedCanonicalShape {
	if (Object.keys(unknown).some(key => Object.hasOwn(known, key))) throw invalid();
	const children = [...Object.values(known).map(unsignedCanonicalShape), ...Object.values(unknown)];
	const items = 1 + children.reduce((sum, child) => sum + 3 + child.items, 0);
	const maxDepth = children.length === 0 ? 0 : 1 + children.reduce((deepest, child) => Math.max(deepest, child.maxDepth), 0);
	if (!Number.isSafeInteger(items) || items > unsignedEncodingLimits.maxItems || maxDepth > unsignedEncodingLimits.maxDepth)
		throw invalid();
	return Object.freeze({ items, maxDepth });
}
function unsignedVaruintWidth(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) throw invalid();
	let width = 1;
	for (let rest = value; rest >= 128; rest = Math.floor(rest / 128)) width++;
	return width;
}
function unsignedRecordWidth(
	known: Readonly<Record<string, unknown>>,
	unknown: Readonly<Record<string, number>>
): number {
	const keys = Object.keys(known),
		extra = Object.keys(unknown);
	if (extra.some((key) => keys.includes(key))) throw invalid();
	let width =
		encodeCanonical(known, unsignedEncodingLimits).byteLength -
		unsignedVaruintWidth(keys.length) +
		unsignedVaruintWidth(keys.length + extra.length);
	for (const key of extra) {
		const length = unknown[key];
		if (length === undefined || !Number.isSafeInteger(length) || length < 0) throw invalid();
		width += encodeCanonical(key).byteLength + length;
	}
	if (!Number.isSafeInteger(width) || width > ISSUANCE_RETIREMENT_LIMITS.maxBytes)
		throw issuanceRetirementRefusal("unsigned postimage exceeds byte bound");
	return width;
}
function unsignedArrayWidth(widths: readonly number[]): number {
	return 1 + unsignedVaruintWidth(widths.length) + widths.reduce((sum, width) => sum + width, 0);
}

function unsignedNativeControlWidth(
	control: DurableIssuanceRetirementControl | null,
	objectId: string,
	delta: number
): number {
	const original = control === null ? null : captureIssuanceRetirementControl(control);
	if (original !== null && original.objectId !== objectId) throw invalid();
	const known = original ?? {
		kind: "v3-issuance-retirement-control-1",
		objectId,
		revision: 0,
		sequence: 0,
		active: null,
		completed: null,
	};
	if (!Number.isSafeInteger(delta) || delta < 0 || known.revision > Number.MAX_SAFE_INTEGER - delta)
		throw issuanceRetirementRefusal("issuance retirement revision exhausted");
	const projected = { ...known, revision: known.revision + delta };
	return original === null
		? unsignedRecordWidth(projected, { incarnation: 1 + unsignedVaruintWidth(64) + 64 })
		: encodeIssuanceRetirementControl(projected as DurableIssuanceRetirementControl).byteLength;
}

function unsignedNativeImageWidth(
	canonicalRowsBytes: number,
	lineageCount: number,
	issuedCount: number,
	outboxCount: number,
	planCount: number
): number {
	return unsignedRecordWidth(
		{ logicalBytes: canonicalRowsBytes, lineageCount, issuedCount, outboxCount, planCount },
		{ imageDigest: 1 + unsignedVaruintWidth(64) + 64 }
	);
}

function unsignedNativePhaseWidths(
	lineageWidths: readonly number[],
	issuedWidths: readonly number[],
	outboxWidths: readonly number[],
	planWidths: readonly number[],
	encodedControlBytes: number
): IssuanceUnsignedPhaseWidths {
	const canonicalRowBytes = [...lineageWidths, ...issuedWidths, ...outboxWidths, ...planWidths];
	const rowCount = canonicalRowBytes.length;
	if (rowCount > ISSUANCE_RETIREMENT_LIMITS.maxRows)
		throw issuanceRetirementRefusal("unsigned postimage exceeds row bound");
	const canonicalRowsBytes = unsignedRecordWidth(
		{},
		{
			lineages: unsignedArrayWidth(lineageWidths),
			issued: unsignedArrayWidth(issuedWidths),
			outbox: unsignedArrayWidth(outboxWidths),
			plans: unsignedArrayWidth(planWidths),
		}
	);
	const imageWidth = unsignedNativeImageWidth(
		canonicalRowsBytes,
		lineageWidths.length,
		issuedWidths.length,
		outboxWidths.length,
		planWidths.length
	);
	const nativeCensusBytes = unsignedRecordWidth(
		{},
		{
			rows: canonicalRowsBytes,
			image: imageWidth,
			control: encodedControlBytes,
		}
	);
	return Object.freeze({
		rowCount,
		canonicalRowsBytes,
		canonicalRowBytes: Object.freeze(canonicalRowBytes),
		encodedControlBytes,
		nativeCensusBytes,
	});
}
function unsignedRowsWidth(
	rows: ReturnType<typeof unsignedFinalRows>
): Readonly<{ rowCount: number; logicalBytes: number }> {
	const rowCount = rows.lineages.length + rows.issued.length + rows.outbox.length + rows.plans.length;
	if (rowCount > ISSUANCE_RETIREMENT_LIMITS.maxRows)
		throw issuanceRetirementRefusal("unsigned postimage exceeds row bound");
	// OBJECT count5->6 stays one varuint; UNKNOWN BYTES64 has tag+varuint+64.
	const logicalBytes =
		encodeCanonical(rows, unsignedEncodingLimits).byteLength + encodeCanonical("signature").byteLength + 1 + 1 + 64;
	if (logicalBytes > ISSUANCE_RETIREMENT_LIMITS.maxBytes)
		throw issuanceRetirementRefusal("unsigned postimage exceeds byte bound");
	return Object.freeze({ logicalBytes, rowCount });
}

/**
 * Exact mechanical size of the eventual native pair and settlement effect.
 * The registered signature contributes only UNKNOWN BYTES64 width, never a
 * dummy signed row or exact-byte deduplication. Native component, not full quote.
 * @param rows - Complete normalized native rows.
 * @param scope - Original addressed lineage.
 * @param pending - Original exact pending intent.
 * @returns Native final-row encoding width and cardinality.
 */
export function issuanceUnsignedPostimageCharge(
	rows: IssuanceRetirementRows,
	scope: DurableIssueScope,
	pending: DurableIssuancePendingUnsignedIntent
): Readonly<{ logicalBytes: number; rowCount: number }> {
	return unsignedRowsWidth(unsignedFinalRows(rows, scope, pending));
}

/**
 * Sizes complete original native reserve/entered/pair census carriers.
 * Unknown born incarnation STRING64, imageDigest STRING64 and signature BYTES64
 * contribute lengths only. No placeholder identity, signature or image is made.
 * Existing native codec limits and original settlement-effect owner remain in force.
 * @param rows - Actual complete normalized native rows before this job.
 * @param scope - Original addressed lineage.
 * @param input - Captured unsigned intent fields, without a fabricated phase/incarnation.
 * @param control - Actual native control, or its actual absence before birth.
 * @returns Non-deduplicated encoded carrier widths, never a ledger or admission.
 */
export function issuanceUnsignedPostimageWidths(
	rows: IssuanceRetirementRows,
	scope: DurableIssueScope,
	input: IssuanceUnsignedProspectiveIntent,
	control: DurableIssuanceRetirementControl | null,
	sourceCustody?: IssuanceSourceCustodyGeometry
): Readonly<{
	reserved: IssuanceUnsignedPhaseWidths;
	entered: IssuanceUnsignedPhaseWidths;
	final: IssuanceUnsignedPhaseWidths;
}> {
	assertDurableIssueScope(scope);
	issuanceRetirementImage(rows, scope.objectId);
	const hasEffect = Object.hasOwn(input, "planEffect");
	if (
		!isClosedDurableIssuanceRecord(input, [
			"kind",
			"authorSequence",
			"canonicalPreimageBytes",
			"digest",
			...(hasEffect ? ["planEffect", "exactCanonicalPlanBytes"] : []),
		]) ||
		input.kind !== "v3-issuance-pending-unsigned-1"
	)
		throw invalid();
	const captured = captureIssuanceNativeSignInput({
		scope,
		exactCanonicalUnsignedVertexBytes: input.canonicalPreimageBytes,
	});
	if (
		input.authorSequence !== captured.sequence ||
		!(input.digest instanceof Uint8Array) ||
		!issuanceRetirementBytesEqual(input.digest, captured.digest)
	)
		throw invalid();
	const planEffect = hasEffect ? copySettlementPlanEffect(input.planEffect) : undefined;
	if (hasEffect && (planEffect === undefined || !(input.exactCanonicalPlanBytes instanceof Uint8Array)))
		throw invalid();
	const pending = {
		kind: "v3-issuance-pending-unsigned-1",
		authorSequence: captured.sequence,
		canonicalPreimageBytes: captured.bytes,
		digest: captured.digest,
		...(planEffect === undefined ? {} : { planEffect, exactCanonicalPlanBytes: input.exactCanonicalPlanBytes }),
	};
	const existing = rows.lineages.find((l) => l.author === scope.author);
	const inherited = existing?.pendingUnsigned;
	if (inherited !== undefined) {
		const { incarnation, phase: _phase, ...actual } = captureIssuancePendingUnsignedIntent(inherited, scope);
		if (
			control === null ||
			incarnation !== control.incarnation ||
			!issuanceRetirementBytesEqual(encodeCanonical(actual), encodeCanonical(pending))
		)
			throw invalid();
	}
	const originalControl = control === null ? null : captureIssuanceRetirementControl(control);
	if (originalControl !== null && originalControl.objectId !== scope.objectId) throw invalid();
	const initialRows =
		existing === undefined
			? {
					...rows,
					lineages: [...rows.lineages, { ...scope, next: 0, exhausted: false, prunedThroughAuthorSequence: null }],
				}
			: rows;
	const finalRows = unsignedFinalRows(initialRows, scope, pending);
	const finalSize = unsignedRowsWidth(finalRows);
	const unknown64 = 1 + unsignedVaruintWidth(64) + 64;
	const make = (phase: "reserved" | "entered" | "final"): IssuanceUnsignedPhaseWidths => {
		const actualPhase = phase === "reserved" ? (inherited?.phase ?? "reserved") : "entered";
		const intentWidth = unsignedRecordWidth(
			{ ...pending, phase: actualPhase },
			{ incarnation: originalControl === null ? unknown64 : encodeCanonical(originalControl.incarnation).byteLength }
		);
		const current = initialRows.lineages.find((l) => l.author === scope.author);
		if (current === undefined) throw invalid();
		const { pendingUnsigned: _pending, ...knownLineage } = current;
		const lineageWidths = (phase === "final" ? finalRows.lineages : initialRows.lineages).map((l) =>
			phase !== "final" && l.author === scope.author
				? unsignedRecordWidth(knownLineage, { pendingUnsigned: intentWidth })
				: encodeCanonical(l, unsignedEncodingLimits).byteLength
		);
		const issuedWidths = finalRows.issued.map((r, index) =>
			index === finalRows.issued.length - 1
				? unsignedRecordWidth(r, { signature: unknown64 })
				: encodeCanonical(r, unsignedEncodingLimits).byteLength
		);
		const selectedRows = phase === "final" ? finalRows : initialRows;
		const usedIssued =
			phase === "final" ? issuedWidths : rows.issued.map((r) => encodeCanonical(r, unsignedEncodingLimits).byteLength);
		const outboxWidths = selectedRows.outbox.map((r) => encodeCanonical(r, unsignedEncodingLimits).byteLength);
		const nativeMaterial = finalRows.issued.reduce((sum, row) => sum + row.canonicalPreimageBytes.byteLength + 96, 0) +
			(phase === "final" ? 0 : intentWidth);
		const planWidths = sourceCustodyPlanWidths(selectedRows.plans, scope,
			finalRows.issued.filter(row => row.author === scope.author && row.objectId === scope.objectId).length,
			sourceCustody, nativeMaterial).widths;
		const delta =
			(inherited === undefined ? 1 : 0) +
			(phase === "reserved" || inherited?.phase === "entered" ? 0 : 1) +
			(phase === "final" ? 1 : 0);
		const widths = unsignedNativePhaseWidths(
			lineageWidths,
			usedIssued,
			outboxWidths,
			planWidths,
			unsignedNativeControlWidth(originalControl, scope.objectId, delta)
		);
		if (sourceCustody === undefined && phase === "final" && widths.canonicalRowsBytes !== finalSize.logicalBytes) throw invalid();
		return checkSourceCustodyNativeWidths(widths, sourceCustody);
	};
	return Object.freeze({ reserved: make("reserved"), entered: make("entered"), final: make("final") });
}

/** Complete new material for the SQLite ordinary sign path after its charged
 * full entry image. That owner checks fresh same-connection currency at every
 * writer boundary and never reacquires/materializes whole history postimages.
 * The generic native census widths remain unchanged for other owners and for
 * future maintenance. This is a numerical bound, never native authorization. */
export function issuanceUnsignedOwnMaterialByteLength(
	rows: IssuanceRetirementRows, scope: DurableIssueScope, input: IssuanceUnsignedProspectiveIntent,
	control: DurableIssuanceRetirementControl | null
): number | undefined {
	if (input.planEffect !== undefined || rows.plans.length !== 0) return undefined;
	const phases = issuanceUnsignedPostimageWidths(rows, scope, input, control);
	const existing = rows.lineages.findIndex(row => row.objectId === scope.objectId && row.author === scope.author);
	const lineageCount = rows.lineages.length + Number(existing < 0);
	const lineageIndex = existing < 0 ? rows.lineages.length : existing;
	const issuedIndex = lineageCount + rows.issued.length;
	const outboxIndex = lineageCount + rows.issued.length + 1 + rows.outbox.length;
	const widths = [phases.reserved.canonicalRowBytes[lineageIndex], phases.entered.canonicalRowBytes[lineageIndex],
		phases.final.canonicalRowBytes[lineageIndex], phases.final.canonicalRowBytes[issuedIndex],
		phases.final.canonicalRowBytes[outboxIndex], phases.reserved.encodedControlBytes,
		phases.entered.encodedControlBytes, phases.final.encodedControlBytes,
		// Entry, reserve-postimage, reserved-check, entered-postimage and
		// entered-check each acquire data_version and total_changes. Their ten
		// primitive values are neither predicted nor global monotone tokens.
		10 * encodeCanonical(Number.MAX_SAFE_INTEGER).byteLength];
	if (widths.some(width => width === undefined || !Number.isSafeInteger(width) || width < 0)) return undefined;
	const total = (widths as number[]).reduce((sum, width) => sum + width, 0);
	return Number.isSafeInteger(total) ? total : undefined;
}

/**
 * Positive scalar capacity for a finite ordinary-work rectangle in this SAME
 * codec. This does not prepare an unsigned intent, merge a plan, authenticate a
 * frontier, or reserve a proof book. The caller must independently prove the
 * terminal-plan/one-successor-fence law and compare fresh native source rows.
 *
 * All original PRE rows remain in every bound. Additional known-width rows are
 * UNKNOWN occurrences, including their preimage, digest and signature leaves;
 * no signature bytes, digest, native identity or future row is constructed.
 * The complete row/count/record codec limits remain unchanged. A pending phase
 * retains the complete final-row allowance as well as its full unsigned intent:
 * this positive overlap is intentional, never identity or refund credit.
 */
export function issuanceOrdinaryFinishingCapacityWidths(input: Readonly<{
	rows: IssuanceRetirementRows;
	scope: DurableIssueScope;
	control: DurableIssuanceRetirementControl | null;
	maxAdditionalCurrentIssued: number;
	maxCanonicalPreimageByteLength: number;
	/** Current ordinary leaves may have a tighter enforced bound than a future
	 * fence. This affects only currentAdmission below, never successor widths. */
	maxOrdinaryPreimageByteLength?: number;
	/** Optional aggregate RAW PRE byte ceiling for these additional ordinary
	 * local issues, independently enforced by the admission owner. Each leaf
	 * remains bounded above by maxCanonicalPreimageByteLength. This numerical
	 * budget is not a reservation, paid proof credit or a sender estimate. */
	maxAdditionalCurrentPreimageBytes?: number;
	/** Existing NONE constructor has no successor fence or plan. */
	successorFenceCount?: 0 | 1;
	/** Fence-shaped issued/outbox pairs and custody sources reserved in the
	 * successor phases beyond the one successor fence above: the later epochs'
	 * mandatory fences that are issued while this work is still retained.
	 * Requires the one successor fence. Zero for the fence itself. */
	adoptionReserveFenceCount?: 0 | 1 | 2;
	/** Named future custody-plan alternative; leaves existing phase defaults exact. */
	sourceCustody?: IssuanceSourceCustodyGeometry;
}>): Readonly<{
	ordinaryPending: IssuanceUnsignedPhaseWidths;
	ordinaryFinal: IssuanceUnsignedPhaseWidths;
	successorPending: IssuanceUnsignedPhaseWidths;
	successorFinal: IssuanceUnsignedPhaseWidths;
	/** A current issue is INCLUDED in maxAdditionalCurrentIssued: its pending
	 * phase has N-1 committed pairs, not N pairs plus an extra intent. Only
	 * aggregate numerical widths escape; these are not candidate/native rows. */
	currentAdmission: Readonly<{
		pendingNativeCensusByteLength: number | null;
		finalNativeCensusByteLength: number;
		additionalIssuedByteLength: number;
	}>;
	nativeImageByteLength: number;
	nativeImageShape: IssuanceUnsignedCanonicalShape;
	/** Complete native ROWS expansion, under native depth16/items131072.
	 * The caller must separately enforce its whole proof's depth/item bounds. */
	canonicalRowsShape: Readonly<Record<"ordinaryPending" | "ordinaryFinal" | "successorPending" | "successorFinal",
		IssuanceUnsignedCanonicalShape>>;
	planRewriteResource?: Readonly<{byteLength: number; items: number; maxDepth: number}>;
}> {
	if (!isClosedDurableIssuanceRecord(input, ["rows", "scope", "control",
		"maxAdditionalCurrentIssued", "maxCanonicalPreimageByteLength",
		...(Object.hasOwn(input, "maxOrdinaryPreimageByteLength") ? ["maxOrdinaryPreimageByteLength"] : []),
		...(Object.hasOwn(input, "maxAdditionalCurrentPreimageBytes") ? ["maxAdditionalCurrentPreimageBytes"] : []),
		...(Object.hasOwn(input, "sourceCustody") ? ["sourceCustody"] : []),
		...(Object.hasOwn(input, "successorFenceCount") ? ["successorFenceCount"] : []),
		...(Object.hasOwn(input, "adoptionReserveFenceCount") ? ["adoptionReserveFenceCount"] : [])])) throw invalid();
	assertDurableIssueScope(input.scope);
	issuanceRetirementImage(input.rows, input.scope.objectId);
	const count = input.maxAdditionalCurrentIssued, preimage = input.maxCanonicalPreimageByteLength;
	const ordinaryPreimage = input.maxOrdinaryPreimageByteLength ?? preimage;
	const fenceCount = input.successorFenceCount ?? 1;
	const reserveCount = input.adoptionReserveFenceCount ?? 0;
	if (!Number.isSafeInteger(count) || count < 0 || count > ISSUANCE_RETIREMENT_LIMITS.maxRows ||
		!Number.isSafeInteger(preimage) || preimage < 1 || preimage > ISSUANCE_RETIREMENT_LIMITS.maxBytes ||
		!Number.isSafeInteger(ordinaryPreimage) || ordinaryPreimage < 1 || ordinaryPreimage > preimage ||
		(fenceCount !== 0 && fenceCount !== 1) || (reserveCount !== 0 && reserveCount !== 1 && reserveCount !== 2) || (reserveCount !== 0 && fenceCount !== 1))
		throw invalid();
	const aggregatePreimageBytes = Object.hasOwn(input, "maxAdditionalCurrentPreimageBytes")
		? input.maxAdditionalCurrentPreimageBytes! : count * ordinaryPreimage;
	if (!Number.isSafeInteger(aggregatePreimageBytes) || aggregatePreimageBytes < count ||
		aggregatePreimageBytes > count * ordinaryPreimage || count === 0 && aggregatePreimageBytes !== 0) throw invalid();
	const { rows, scope } = input;
	const control = input.control === null ? null : captureIssuanceRetirementControl(input.control);
	if (control !== null && (control.objectId !== scope.objectId || control.active !== null)) throw invalid();
	if (rows.lineages.some(row => row.pendingUnsigned !== undefined) || (fenceCount === 0 && rows.plans.length !== 0)) throw invalid();
	const lineage = rows.lineages.find(row => row.author === scope.author);
	if (lineage !== undefined && (lineage.exhausted || lineage.next > Number.MAX_SAFE_INTEGER - count - fenceCount - reserveCount - 1))
		throw invalid();
	const bytesWidth = (length: number): number => 1 + unsignedVaruintWidth(length) + length;
	const digestWidth = bytesWidth(32), signatureWidth = bytesWidth(64), preimageWidth = bytesWidth(preimage);
	const integerWidth = encodeCanonical(Number.MAX_SAFE_INTEGER).byteLength;
	const nativeControl = control === null ? {
		kind: "v3-issuance-retirement-control-1", objectId: scope.objectId,
		sequence: 0, active: null, completed: null,
	} : (() => { const { revision: _revision, ...fields } = control; return fields; })();
	const encodedControlBytes = unsignedRecordWidth(nativeControl, {
		revision: integerWidth, ...(control === null ? { incarnation: signatureWidth } : {}),
	});
	// Each real ordinary job has reserve/enter/commit/publication mutations;
	// a genuine successor merge/reserve/enter/commit/publication adds five. NONE
	// has no such job, plan, or added row. This is only
	// the issuer counter component; the composer still proves other owners'
	// complete finite maintenance horizons and their counter currency.
	const delta = count * 4 + (fenceCount + reserveCount) * 5 + rows.outbox.filter(row => row.publishState === "pending").length;
	if (!Number.isSafeInteger(delta) || (control !== null && control.revision > Number.MAX_SAFE_INTEGER - delta))
		throw invalid();
	// Original reserve creates the absent lineage at ordinal zero. Only its
	// field geometry is represented here; no row, reservation or ordinal exists.
	const lineageFields = lineage === undefined ? {...scope, exhausted: false, prunedThroughAuthorSequence: null} :
		(({next: _next, pendingUnsigned: _pending, ...fields}) => fields)(lineage);
	const lineageIndex = lineage === undefined ? rows.lineages.length : rows.lineages.indexOf(lineage);
	const lineageWidths = rows.lineages.map(row => row === lineage
		? unsignedRecordWidth(lineageFields, { next: integerWidth })
		: encodeCanonical(row, unsignedEncodingLimits).byteLength);
	if (lineage === undefined) lineageWidths.push(unsignedRecordWidth(lineageFields, {next: integerWidth}));
	const rowWidth = unsignedRecordWidth({ ...scope }, {
		authorSequence: integerWidth, canonicalPreimageBytes: preimageWidth,
		digest: digestWidth, signature: signatureWidth,
	});
	const outboxWidth = unsignedRecordWidth({ ...scope, publishState: "published" }, {
		authorSequence: integerWidth, digest: digestWidth,
	});
	const issued = rows.issued.map(row => encodeCanonical(row, unsignedEncodingLimits).byteLength);
	const outbox = rows.outbox.map(row => {
		const { publishState: _publish, ...fields } = row;
		return unsignedRecordWidth(fields, { publishState: encodeCanonical("published").byteLength });
	});
	// Only the SUM of these numerical widths enters the native ARRAY encoder.
	// Keep the full maximum per-BYTES tag/count header at every row, but count
	// the jointly bounded RAW payload only once. Allocation among numeric slots
	// carries no row identity or equality claim. Pending/fence overlap below is
	// deliberately still charged at its complete independent maximum.
	const payloadPerRow = count === 0 ? 0 : Math.floor(aggregatePreimageBytes / count);
	const payloadRemainder = count === 0 ? 0 : aggregatePreimageBytes % count;
	for (let index = 0; index < count; index++) {
		issued.push(rowWidth - preimage + payloadPerRow + Number(index < payloadRemainder));
		outbox.push(outboxWidth);
	}
	const intentWidth = unsignedRecordWidth({ kind: "v3-issuance-pending-unsigned-1", phase: "reserved" }, {
		authorSequence: integerWidth, canonicalPreimageBytes: preimageWidth, digest: digestWidth,
		incarnation: control === null ? signatureWidth : encodeCanonical(control.incarnation).byteLength,
	});
	const custodySourceCount = rows.issued.filter(row => row.objectId === scope.objectId && row.author === scope.author).length + count;
	const custody = sourceCustodyPlanWidths(rows.plans, scope, custodySourceCount, input.sourceCustody,
		rows.issued.reduce((sum, row) => sum + row.canonicalPreimageBytes.byteLength + 96, 0) +
		aggregatePreimageBytes + count * 96 + intentWidth);
	const plans = custody.widths;
	const pendingLineages = lineageWidths.map((width, index) => index === lineageIndex
		? unsignedRecordWidth(lineageFields, { next: integerWidth, pendingUnsigned: intentWidth }) : width);
	const ordinaryPending = unsignedNativePhaseWidths(pendingLineages, issued, outbox, plans, encodedControlBytes);
	const ordinaryFinal = unsignedNativePhaseWidths(lineageWidths, issued, outbox, plans, encodedControlBytes);
	// The genuine room constructor may reset an existing fence before the next
	// epoch. Keep the complete original entries and bound revision/fence scalar
	// widths together; no independent entry selection or terminality is inferred.
	const ownPlan = rows.plans.find(row => row.scope.author === scope.author);
	let successorPlan: ReturnType<typeof issuanceOrdinarySuccessorPlanResourceForSizing> | undefined;
	let successorPlans = plans;
	let successorIssued = issued, successorOutbox = outbox, fencePendingLineages = lineageWidths;
	if (fenceCount === 1) {
		// Absence is an original room plan birth, not a fabricated native plan.
		// Only numerical fields leave this owner; the runtime still must prove
		// the original room preview/frontier before using the one-fence domain.
		successorPlan = issuanceOrdinarySuccessorPlanResourceForSizing(scope, ownPlan ?? null);
		const custodyPlan = input.sourceCustody === undefined ? undefined :
			issuanceSourceCustodyPlanResourceForSizing(scope, ownPlan ?? null, custodySourceCount + fenceCount + reserveCount, input.sourceCustody);
		const fencePlanWidth = Math.max(successorPlan.byteLength, custodyPlan?.byteLength ?? 0);
		successorPlans = ownPlan === undefined ? [...plans, fencePlanWidth] :
			plans.map((width, index) => rows.plans[index] === ownPlan ? fencePlanWidth : width);
		// The custody alternative already contains the absent own plan slot.
		if (ownPlan === undefined && input.sourceCustody !== undefined) successorPlans = [...plans.slice(0, -1), fencePlanWidth];
		successorIssued = [...issued, rowWidth, ...Array.from({length: reserveCount}, () => rowWidth)];
		successorOutbox = [...outbox, outboxWidth, ...Array.from({length: reserveCount}, () => outboxWidth)];
		const fenceIntentWidth = unsignedRecordWidth({ kind: "v3-issuance-pending-unsigned-1", phase: "reserved",
			planEffect: { kind: "fence" } }, {
			authorSequence: integerWidth, canonicalPreimageBytes: preimageWidth, digest: digestWidth,
			incarnation: control === null ? signatureWidth : encodeCanonical(control.incarnation).byteLength,
			exactCanonicalPlanBytes: bytesWidth(fencePlanWidth),
		});
		if (input.sourceCustody !== undefined) sourceCustodyPlanWidths(rows.plans, scope,
			custodySourceCount + fenceCount + reserveCount, input.sourceCustody,
			rows.issued.reduce((sum, row) => sum + row.canonicalPreimageBytes.byteLength + 96, 0) +
			aggregatePreimageBytes + count * 96 + (1 + reserveCount) * (preimage + 96) + fenceIntentWidth);
		fencePendingLineages = lineageWidths.map((width, index) => index === lineageIndex
			? unsignedRecordWidth(lineageFields, { next: integerWidth, pendingUnsigned: fenceIntentWidth }) : width);
	}
	const successorPending = unsignedNativePhaseWidths(fencePendingLineages, successorIssued, successorOutbox,
		successorPlans, encodedControlBytes);
	const successorFinal = unsignedNativePhaseWidths(lineageWidths, successorIssued, successorOutbox,
		successorPlans, encodedControlBytes);
	// Derive item/depth growth from the SAME complete row field owners above,
	// not a per-byte estimate. Issued/outbox records cost 25+21 decoder items
	// (keys and collection edges included); their ARRAY edges add two more.
	// Intent/plan fields preserve whole correlated expansion.
	const leaf = Object.freeze({ items: 1, maxDepth: 0 });
	const rowShape = unsignedRecordShape({ ...scope }, { authorSequence: leaf,
		canonicalPreimageBytes: leaf, digest: leaf, signature: leaf });
	const outboxShape = unsignedRecordShape({ ...scope, publishState: "published" }, {
		authorSequence: leaf, digest: leaf });
	const intentShape = unsignedRecordShape({ kind: "v3-issuance-pending-unsigned-1", phase: "reserved" }, {
		authorSequence: leaf, canonicalPreimageBytes: leaf, digest: leaf, incarnation: leaf });
	const fenceIntentShape = unsignedRecordShape({ kind: "v3-issuance-pending-unsigned-1", phase: "reserved",
		planEffect: { kind: "fence" } }, { authorSequence: leaf, canonicalPreimageBytes: leaf,
		digest: leaf, incarnation: leaf, exactCanonicalPlanBytes: leaf });
	const finalLineageShapes = rows.lineages.map(row => row === lineage
		? unsignedRecordShape(lineageFields, { next: leaf }) : unsignedCanonicalShape(row));
	if (lineage === undefined) finalLineageShapes.push(unsignedRecordShape(lineageFields, {next: leaf}));
	const pendingLineageShapes = finalLineageShapes.map((shape, index) => index === lineageIndex
		? unsignedRecordShape(lineageFields, {next: leaf, pendingUnsigned: intentShape}) : shape);
	const fenceLineageShapes = finalLineageShapes.map((shape, index) => fenceCount === 1 && index === lineageIndex
		? unsignedRecordShape(lineageFields, {next: leaf, pendingUnsigned: fenceIntentShape}) : shape);
	const issuedShapes = [...rows.issued.map(unsignedCanonicalShape), ...Array.from({ length: count }, () => rowShape)];
	const outboxShapes = [...rows.outbox.map(unsignedCanonicalShape), ...Array.from({ length: count }, () => outboxShape)];
	const planShapes = custody.shapes;
	let successorPlanShapes: readonly IssuanceUnsignedCanonicalShape[] = ownPlan === undefined && successorPlan !== undefined
		? [...planShapes, successorPlan] : rows.plans.map(row => row === ownPlan && successorPlan !== undefined
			? successorPlan : unsignedCanonicalShape(row));
	if (input.sourceCustody !== undefined && fenceCount === 1) {
		const resource = issuanceSourceCustodyPlanResourceForSizing(scope, ownPlan ?? null,
			custodySourceCount + fenceCount + reserveCount, input.sourceCustody);
		successorPlanShapes = ownPlan === undefined ? [...planShapes.slice(0, -1), resource] :
			rows.plans.map(row => row === ownPlan ? resource : unsignedCanonicalShape(row));
	}
	const rowsShape = (lineages: readonly IssuanceUnsignedCanonicalShape[], successor: boolean) =>
		unsignedRecordShape({}, { lineages: unsignedArrayShape(lineages),
			issued: unsignedArrayShape(successor && fenceCount === 1 ? [...issuedShapes, rowShape,
				...Array.from({length: reserveCount}, () => rowShape)] : issuedShapes),
			outbox: unsignedArrayShape(successor && fenceCount === 1 ? [...outboxShapes, outboxShape,
				...Array.from({length: reserveCount}, () => outboxShape)] : outboxShapes),
			plans: unsignedArrayShape(successor && fenceCount === 1 ? successorPlanShapes : planShapes) });
	const canonicalRowsShape = Object.freeze({ ordinaryPending: rowsShape(pendingLineageShapes, false),
		ordinaryFinal: rowsShape(finalLineageShapes, false), successorPending: rowsShape(fenceLineageShapes, true),
		successorFinal: rowsShape(finalLineageShapes, true) });
	// Resource-only fields use full safe-integer encodings. The original image
	// constructor's actual counts may describe a different filtered/raw facade;
	// scalar magnitude is not determined by the positive row-size rectangle.
	// This bounds serialization only, without changing a row count or image law.
	const nativeImageByteLength = unsignedRecordWidth({}, {logicalBytes: integerWidth,
		lineageCount: integerWidth, issuedCount: integerWidth, outboxCount: integerWidth,
		planCount: integerWidth, imageDigest: bytesWidth(64)});
	const nativeImageShape = unsignedRecordShape({}, {logicalBytes: leaf, lineageCount: leaf,
		issuedCount: leaf, outboxCount: leaf, planCount: leaf, imageDigest: leaf});
	const withImageCapacity = (phase: IssuanceUnsignedPhaseWidths): IssuanceUnsignedPhaseWidths => checkSourceCustodyNativeWidths(Object.freeze({...phase,
		nativeCensusBytes: unsignedRecordWidth({}, {rows: phase.canonicalRowsBytes,
			image: nativeImageByteLength, control: phase.encodedControlBytes})}), input.sourceCustody);
	// SQLite's committed image contains either the current unsigned intent OR
	// its issued/outbox pair: commitCandidate clears pending and inserts both in
	// one transaction. Older pairs remain complete. This is ONE image's geometry,
	// not credit against independently charged pre/post observations.
	const ordinaryRowOverhead = rowWidth - preimageWidth + bytesWidth(ordinaryPreimage) - ordinaryPreimage;
	const ordinaryIntentOverhead = intentWidth - preimageWidth + bytesWidth(ordinaryPreimage) - ordinaryPreimage;
	const oldIssued = issued.slice(0, rows.issued.length), oldOutbox = outbox.slice(0, rows.outbox.length);
	const currentIssued = [...oldIssued, ...Array.from({length: count}, (_, index) =>
		ordinaryRowOverhead + payloadPerRow + Number(index < payloadRemainder))];
	const currentFinal = withImageCapacity(unsignedNativePhaseWidths(lineageWidths, currentIssued,
		[...oldOutbox, ...Array.from({length: count}, () => outboxWidth)], plans, encodedControlBytes));
	let pendingNativeCensusByteLength: number | null = null;
	if (count > 0) {
		// RAW PRE is jointly bounded across N slots (N-1 pairs and one intent).
		// Numerical allocation has no identity meaning: every BYTES header keeps
		// its maximum width and only their SUM enters the complete schema codec.
		const intentPayload = payloadPerRow + Number(count - 1 < payloadRemainder);
		const currentPendingLineages = lineageWidths.map((width, index) => index === lineageIndex
			? unsignedRecordWidth(lineageFields, {next: integerWidth,
				pendingUnsigned: ordinaryIntentOverhead + intentPayload}) : width);
		pendingNativeCensusByteLength = withImageCapacity(unsignedNativePhaseWidths(currentPendingLineages,
			currentIssued.slice(0, currentIssued.length - 1),
			[...oldOutbox, ...Array.from({length: count - 1}, () => outboxWidth)], plans, encodedControlBytes)).nativeCensusBytes;
	}
	const currentAdmission = Object.freeze({pendingNativeCensusByteLength,
		finalNativeCensusByteLength: currentFinal.nativeCensusBytes,
		additionalIssuedByteLength: count * ordinaryRowOverhead + aggregatePreimageBytes});
	const planRewriteResource = issuanceRetirementPlanRewriteResourceForSizing(rows.plans,
		input.sourceCustody === undefined ? undefined : {scope, maxSourceCount: custodySourceCount + fenceCount + reserveCount, geometry: input.sourceCustody});
	return Object.freeze({ordinaryPending: withImageCapacity(ordinaryPending), ordinaryFinal: withImageCapacity(ordinaryFinal),
		successorPending: withImageCapacity(successorPending), successorFinal: withImageCapacity(successorFinal),
		currentAdmission, canonicalRowsShape, nativeImageByteLength, nativeImageShape,
		...(planRewriteResource === undefined ? {} : {planRewriteResource})});
}

/** Candidate-free numerical projection of the ORIGINAL sources=[] successor
 * merge: absent prior plan starts with empty entries; existing entries survive
 * byte-for-byte. This emits no plan, pending intent, native row or capability.
 * The caller independently establishes terminality, frontier and preview
 * currency through the actual room/native owner. The full unsigned successor
 * constructor deliberately remains an independent oracle.
 */
export function issuanceOrdinarySuccessorPlanResourceForSizing(scope: DurableIssueScope,
	prior: SettlementPlan | null): Readonly<{byteLength: number; items: number; maxDepth: number}> {
	assertDurableIssueScope(scope);
	const captured = prior === null ? null : copySettlementPlan(prior, scope);
	if (captured === undefined || captured !== null && captured.revision >
		Number.MAX_SAFE_INTEGER - (captured.fenceSequence === null ? 1 : 2)) throw invalid();
	// These are the same original plan fields, with only the two finite scalar
	// slots widened. An empty array is schema geometry, never an installed plan.
	const fields = captured === null ? {scope: copyDurableIssueScope(scope), entries: []} :
		(({revision: _revision, fenceSequence: _fence, ...rest}) => rest)(captured);
	const integerWidth = encodeCanonical(Number.MAX_SAFE_INTEGER).byteLength;
	const shape = unsignedRecordShape(fields, {revision: {items: 1, maxDepth: 0}, fenceSequence: {items: 1, maxDepth: 0}});
	return Object.freeze({byteLength: unsignedRecordWidth(fields, {revision: integerWidth, fenceSequence: integerWidth}),
		items: shape.items, maxDepth: shape.maxDepth});
}

/** Numerical capacity of any entry-removal rewrite of these original plans.
 * Both byte leaves use the original complete plan with a widened revision. No
 * target plan, authority, digest or receipt is fabricated by this projection. */
export function issuanceRetirementPlanRewriteResourceForSizing(plans: readonly SettlementPlan[],
	sourceCustody?: Readonly<{scope: DurableIssueScope; maxSourceCount: number; geometry: IssuanceSourceCustodyGeometry}>):
	Readonly<{byteLength: number; items: number; maxDepth: number}> | undefined {
	const own = sourceCustody === undefined ? undefined : plans.find(plan =>
		plan.scope.objectId === sourceCustody.scope.objectId && plan.scope.author === sourceCustody.scope.author);
	const lengths = plans.filter(plan => plan !== own && plan.entries.length !== 0).map(plan => {
		const captured = copySettlementPlan(plan, plan.scope);
		if (captured === undefined) throw invalid();
		const {revision: _revision, fenceSequence: _fence, ...fields} = captured;
		const integerWidth = encodeCanonical(Number.MAX_SAFE_INTEGER).byteLength;
		return unsignedRecordWidth(fields, {revision: integerWidth, fenceSequence: integerWidth});
	});
	if (sourceCustody !== undefined) lengths.push(issuanceSourceCustodyPlanResourceForSizing(sourceCustody.scope,
		own ?? null, sourceCustody.maxSourceCount, sourceCustody.geometry).byteLength);
	if (lengths.length === 0) return undefined;
	const scalar = {items: 1, maxDepth: 0};
	const pairShape = unsignedRecordShape({}, {before: scalar, after: scalar});
	const known = {kind: "v3-issuance-retirement-plan-rewrite-1", sourceImageDigest: "0".repeat(64),
		targetImageDigest: "0".repeat(64)};
	const shape = unsignedRecordShape(known, {plans: unsignedArrayShape(lengths.map(() => pairShape))});
	const width = unsignedRecordWidth(known, {plans: unsignedArrayWidth(lengths.map(length => {
		const bytes = 1 + unsignedVaruintWidth(length) + length;
		return unsignedRecordWidth({}, {before: bytes, after: bytes});
	}))});
	return Object.freeze({byteLength: width, ...shape});
}

export interface IssuanceUnsignedSuccessorFencePhaseWidths extends IssuanceUnsignedPhaseWidths {
	readonly controlRevisionDelta: number;
	readonly nativeImageBytes: number;
}

/** Original finite fence mutation counts, shared by full native widths and
 * resource-only arithmetic. No row/image, admission or paid credit is minted. */
export function issuanceUnsignedSuccessorFenceRevisionDeltas(input: Readonly<{
	hasImmediateIntent: boolean; inheritedPhase: "reserved" | "entered" | undefined;
	pendingAcknowledgementCount: number; planChanged: boolean; continuationControlRevisionDelta?: number;
}>): Readonly<{immediate: number; beforeFence: number; reserved: number; entered: number; final: number; published: number}> {
	if (typeof input.hasImmediateIntent !== "boolean" || typeof input.planChanged !== "boolean" ||
		input.inheritedPhase !== undefined && input.inheritedPhase !== "reserved" && input.inheritedPhase !== "entered" ||
		!Number.isSafeInteger(input.pendingAcknowledgementCount) || input.pendingAcknowledgementCount < 0 ||
		input.continuationControlRevisionDelta !== undefined &&
		(!Number.isSafeInteger(input.continuationControlRevisionDelta) || input.continuationControlRevisionDelta < 0)) throw invalid();
	const immediate = !input.hasImmediateIntent ? 0 : Number(input.inheritedPhase === undefined) + Number(input.inheritedPhase !== "entered") + 1;
	const beforeFence = (input.continuationControlRevisionDelta ?? input.pendingAcknowledgementCount + Number(input.hasImmediateIntent)) + Number(input.planChanged);
	if (!Number.isSafeInteger(immediate + beforeFence + 4)) throw invalid();
	return Object.freeze({immediate, beforeFence, reserved: beforeFence + 1, entered: beforeFence + 2,
		final: beforeFence + 3, published: beforeFence + 4});
}

/** Original pure room preparation for one remaining settlement job. */
export interface IssuanceUnsignedContinuationJob {
	readonly intent: IssuanceUnsignedProspectiveIntent;
	/** The original split owner writes this progress descriptor before its first chunk. */
	readonly initializeProgress?: Readonly<{ sourceSequence: number; intentCount: number; intentDigest: Uint8Array }>;
}

/**
 * Complete native widths for a finite unsigned settlement continuation. Only
 * a supplied first job is a real pending native intent. An absent first job
 * starts from the exact existing local lineage without received-work issuance
 * or ACK effects; actual subsequent local jobs still reserve publication and
 * their complete native phases. Later exact PREs remain pure
 * preparation: their signatures are missing, and charged as UNKNOWN BYTES64
 * in every native phase. These rows must never be used as authentication input.
 */
export function issuanceUnsignedContinuationWidths(
	rows: IssuanceRetirementRows,
	scope: DurableIssueScope,
	first: IssuanceUnsignedProspectiveIntent | undefined,
	control: DurableIssuanceRetirementControl | null,
	continuation: readonly IssuanceUnsignedContinuationJob[]
): Readonly<{
	finalRows: UnsignedFinalRows;
	phases: readonly Readonly<{ authorSequence: number; phase: "reserved" | "entered" | "final";
		widths: IssuanceUnsignedSuccessorFencePhaseWidths }>[];
	final: IssuanceUnsignedSuccessorFencePhaseWidths;
}> {
	if (first !== undefined) issuanceUnsignedPostimageWidths(rows, scope, first, control);
	else {
		assertDurableIssueScope(scope);
		issuanceRetirementImage(rows, scope.objectId);
		const lineage = rows.lineages.find(row => row.author === scope.author);
		if (lineage === undefined || lineage.exhausted || lineage.pendingUnsigned !== undefined) throw invalid();
		if (control !== null && captureIssuanceRetirementControl(control).objectId !== scope.objectId) throw invalid();
	}
	const initial = rows.lineages.some(row => row.author === scope.author)
		? rows : { ...rows, lineages: [...rows.lineages, { ...scope, next: 0, exhausted: false, prunedThroughAuthorSequence: null }] };
	const normalize = (value: UnsignedFinalRows): UnsignedFinalRows => ({
		lineages:[...value.lineages].sort((a,b)=>compareDurableIssuanceCompoundKeys([a.objectId,a.author,0],[b.objectId,b.author,0])),
		issued:[...value.issued].sort((a,b)=>compareDurableIssuanceCompoundKeys([a.objectId,a.author,a.authorSequence],[b.objectId,b.author,b.authorSequence])),
		outbox:[...value.outbox].sort((a,b)=>compareDurableIssuanceCompoundKeys([a.objectId,a.author,a.authorSequence],[b.objectId,b.author,b.authorSequence])),
		plans:[...value.plans].sort((a,b)=>compareDurableIssuanceCompoundKeys([a.scope.objectId,a.scope.author,0],[b.scope.objectId,b.scope.author,0])),
	});
	let projected = normalize(first === undefined ? initial : unsignedFinalRows(initial, scope, first));
	const inherited = rows.lineages.find(row => row.author === scope.author)?.pendingUnsigned;
	const immediateDelta = first === undefined ? 0 : (inherited === undefined ? 1 : 0) + (inherited?.phase === "entered" ? 0 : 1) + 1;
	const unknown64 = 1 + unsignedVaruintWidth(64) + 64;
	const image = (widths: IssuanceUnsignedPhaseWidths, delta: number,
		selected: UnsignedFinalRows): IssuanceUnsignedSuccessorFencePhaseWidths => Object.freeze({
		...widths, controlRevisionDelta: delta,
		nativeImageBytes: unsignedNativeImageWidth(widths.canonicalRowsBytes, selected.lineages.length,
			selected.issued.length, selected.outbox.length, selected.plans.length),
	});
	const phases: { authorSequence: number; phase: "reserved" | "entered" | "final";
		widths: IssuanceUnsignedSuccessorFencePhaseWidths }[] = [];
	const unknownSequences = new Set(first === undefined ? [] : [first.authorSequence]);
	const publicationRequired = first !== undefined || continuation.length !== 0;
	let delta = publicationRequired ? projected.outbox.filter(row => row.author === scope.author && row.publishState === "pending").length : 0;
	if (publicationRequired) projected = { ...projected, outbox: projected.outbox.map(row => row.author === scope.author
		? { ...row, publishState: "published" as const } : row) };
	const size = (selected: UnsignedFinalRows, pending: IssuanceUnsignedProspectiveIntent | undefined,
		phase: "reserved" | "entered" | "final", revisionDelta: number): IssuanceUnsignedSuccessorFencePhaseWidths => {
		const incarnation = control === null ? unknown64 : encodeCanonical(control.incarnation).byteLength;
		const pendingWidth = pending === undefined ? undefined : unsignedRecordWidth({ ...pending, phase }, { incarnation });
		const lineages = selected.lineages.map(row => row.author === scope.author && pendingWidth !== undefined
			? unsignedRecordWidth(row, { pendingUnsigned: pendingWidth }) : encodeCanonical(row, unsignedEncodingLimits).byteLength);
		const issued = selected.issued.map(row => unknownSequences.has(row.authorSequence) && row.author === scope.author
			? unsignedRecordWidth(row, { signature: unknown64 }) : encodeCanonical(row, unsignedEncodingLimits).byteLength);
		const widths = unsignedNativePhaseWidths(lineages, issued,
			selected.outbox.map(row => encodeCanonical(row, unsignedEncodingLimits).byteLength),
			selected.plans.map(row => encodeCanonical(row, unsignedEncodingLimits).byteLength),
			control === null && immediateDelta + revisionDelta === 0 ? encodeCanonical(null).byteLength :
				unsignedNativeControlWidth(control, scope.objectId, immediateDelta + revisionDelta));
		return image(widths, revisionDelta, selected);
	};
	for (const job of continuation) {
		if (phases.length >= ISSUANCE_RETIREMENT_LIMITS.maxRows * 3) throw invalid();
		if (job.initializeProgress !== undefined) {
			const progress = job.initializeProgress;
			const prior = projected.plans.find(row => row.scope.author === scope.author);
			const entry = prior?.entries.find(row => row.sourceSequence === progress.sourceSequence);
			if (prior === undefined || entry === undefined || entry.replacementSequence !== null ||
				entry.replacementProgress !== undefined || entry.disposition === "expire" || entry.disposition === "committed" || entry.disposition === "manual-review" || entry.disposition === "inherited" ||
				!Number.isSafeInteger(progress.intentCount) || progress.intentCount < 1 ||
				!(progress.intentDigest instanceof Uint8Array) || progress.intentDigest.byteLength !== 32) throw invalid();
			const next = copySettlementPlan({ ...prior, revision: prior.revision + 1,
				entries: prior.entries.map(row => row === entry ? { ...row, replacementProgress: {
					version: 1, intentCount: progress.intentCount, intentDigest: progress.intentDigest, chunks: [] } } : row) }, scope);
			if (next === undefined) throw invalid();
			projected = { ...projected, plans: projected.plans.map(row => row === prior ? next : row) };
			delta += 1;
		}
		const intent = job.intent;
		const captured = captureIssuanceNativeSignInput({ scope, exactCanonicalUnsignedVertexBytes: intent.canonicalPreimageBytes });
		if (captured.sequence !== intent.authorSequence || !issuanceRetirementBytesEqual(captured.digest, intent.digest) ||
			intent.kind !== "v3-issuance-pending-unsigned-1" || intent.planEffect?.kind !== "replacement") throw invalid();
		for (const phase of ["reserved", "entered"] as const)
			phases.push({ authorSequence: captured.sequence, phase,
				widths: size(projected, intent, phase, delta + (phase === "reserved" ? 1 : 2)) });
		projected = normalize(unsignedFinalRows(projected, scope, intent));
		unknownSequences.add(captured.sequence);
		delta += 3;
		phases.push({ authorSequence: captured.sequence, phase: "final", widths: size(projected, undefined, "final", delta) });
		projected = { ...projected, outbox: projected.outbox.map(row => row.author === scope.author &&
			row.authorSequence === captured.sequence ? { ...row, publishState: "published" as const } : row) };
		delta += 1;
	}
	return Object.freeze({ finalRows: projected, phases: Object.freeze(phases.map(row => Object.freeze(row))),
		final: size(projected, undefined, "final", delta) });
}

/**
 * Projects the ordinary successor fence after one original unsigned job, its
 * publication ACKs and the original room's merged plan. Every unknown future
 * preimage, digest, incarnation and signature contributes an encoded length,
 * never placeholder native bytes or signing/settlement authority.
 * @param rows - Complete actual native source rows before the immediate job.
 * @param scope - Original addressed lineage.
 * @param input - Genuine immediate unsigned intent, or undefined for an unchanged
 * actual local basis when the separate admitted candidate is received work.
 * @param control - Actual source control, or actual absence before original birth.
 * @param successor - Original merged successor plan and the complete future preimage length.
 * @returns Complete correlated fence job phases, before the fence's publication ACK.
 */
export function issuanceUnsignedSuccessorFenceWidths(
	rows: IssuanceRetirementRows,
	scope: DurableIssueScope,
	input: IssuanceUnsignedProspectiveIntent | undefined,
	control: DurableIssuanceRetirementControl | null,
	successor: Readonly<{ plan: SettlementPlan; canonicalPreimageByteLength: number;
		continuation?: readonly IssuanceUnsignedContinuationJob[] }>,
	sourceCustody?: IssuanceSourceCustodyGeometry
): Readonly<Record<"reserved" | "entered" | "final", IssuanceUnsignedSuccessorFencePhaseWidths>> {
	// This call preserves all existing exact source, pending identity, unsigned,
	// plan-effect and codec-limit guards before constructing width-only leaves.
	if (input !== undefined) issuanceUnsignedPostimageWidths(rows, scope, input, control);
	else issuanceUnsignedContinuationWidths(rows, scope, undefined, control, []);
	const captured = input === undefined ? undefined : captureIssuanceNativeSignInput({
		scope,
		exactCanonicalUnsignedVertexBytes: input.canonicalPreimageBytes,
	});
	const originalNext = rows.lineages.find(row => row.author === scope.author)?.next;
	const beforeSequence = captured?.sequence ?? (typeof originalNext === "number" ? originalNext - 1 : NaN);
	const plan = copySettlementPlan(successor.plan, scope);
	if (
		plan === undefined ||
		plan.fenceSequence !== null ||
		!Number.isSafeInteger(successor.canonicalPreimageByteLength) ||
		successor.canonicalPreimageByteLength <= 0 ||
		successor.canonicalPreimageByteLength > ISSUANCE_RETIREMENT_LIMITS.maxBytes ||
		!Number.isSafeInteger(beforeSequence + 1)
	)
		throw invalid();
	const existing = rows.lineages.find((l) => l.author === scope.author);
	const initialRows =
		existing === undefined
			? {
					...rows,
					lineages: [...rows.lineages, { ...scope, next: 0, exhausted: false, prunedThroughAuthorSequence: null }],
				}
			: rows;
	const continuation = successor.continuation === undefined ? undefined :
		issuanceUnsignedContinuationWidths(rows,scope,input,control,successor.continuation);
	const immediate = continuation?.finalRows ?? (input === undefined ? initialRows : unsignedFinalRows(initialRows, scope, input));
	const sequence = (successor.continuation?.at(-1)?.intent.authorSequence ?? beforeSequence) + 1;
	const selectedLineage = immediate.lineages.find((l) => l.author === scope.author);
	if (selectedLineage === undefined || selectedLineage.exhausted || selectedLineage.next !== sequence) throw invalid();
	const previousPlan = immediate.plans.find((p) => p.scope.author === scope.author);
	const planChanged =
		previousPlan === undefined || !issuanceRetirementBytesEqual(encodeCanonical(previousPlan), encodeCanonical(plan));
	const plans =
		previousPlan === undefined
			? [...immediate.plans, plan]
			: immediate.plans.map((p) => (p === previousPlan ? plan : p));
	const finalPlan = applySettlementPlanEffect(plan, { kind: "fence" }, sequence);
	const inherited = existing?.pendingUnsigned;
	const revisionDeltas = issuanceUnsignedSuccessorFenceRevisionDeltas({
		hasImmediateIntent: input !== undefined, inheritedPhase: inherited?.phase, planChanged,
		pendingAcknowledgementCount: continuation === undefined ? rows.outbox.filter(r => r.objectId === scope.objectId && r.author === scope.author && r.publishState === "pending").length : 0,
		...(continuation === undefined ? {} : {continuationControlRevisionDelta: continuation.final.controlRevisionDelta}),
	});
	const immediateDelta = revisionDeltas.immediate;
	const bytesWidth = (length: number): number => 1 + unsignedVaruintWidth(length) + length;
	const unknown64 = bytesWidth(64),
		unknown32 = bytesWidth(32);
	const originalControl = control === null ? null : captureIssuanceRetirementControl(control);
	const incarnationWidth =
		originalControl === null ? unknown64 : encodeCanonical(originalControl.incarnation).byteLength;
	const unknownPreimage = bytesWidth(successor.canonicalPreimageByteLength);
	type RowWidth = Readonly<{ key: readonly [string, string, number]; width: number }>;
	const orderedWidths = (widths: readonly RowWidth[]): number[] =>
		[...widths].sort((left, right) => compareDurableIssuanceCompoundKeys(left.key, right.key)).map((row) => row.width);
	const issuedBefore: RowWidth[] = immediate.issued.map((row, index) => ({
		key: [row.objectId, row.author, row.authorSequence],
		width:
			!("signature" in row)
				? unsignedRecordWidth(row, { signature: unknown64 })
				: encodeCanonical(row, unsignedEncodingLimits).byteLength,
	}));
	const outboxBefore: RowWidth[] = immediate.outbox.map((row) => ({
		key: [row.objectId, row.author, row.authorSequence],
		width: encodeCanonical(
			row.objectId === scope.objectId && row.author === scope.author ? { ...row, publishState: "published" } : row,
			unsignedEncodingLimits
		).byteLength,
	}));
	const make = (phase: "reserved" | "entered" | "final"): IssuanceUnsignedSuccessorFencePhaseWidths => {
		const intentWidth = unsignedRecordWidth(
			{
				kind: "v3-issuance-pending-unsigned-1",
				authorSequence: sequence,
				phase: phase === "reserved" ? "reserved" : "entered",
				planEffect: { kind: "fence" },
				exactCanonicalPlanBytes: encodeCanonical(plan),
			},
			{ incarnation: incarnationWidth, canonicalPreimageBytes: unknownPreimage, digest: unknown32 }
		);
		const lineages = [...immediate.lineages]
			.sort((left, right) =>
				compareDurableIssuanceCompoundKeys([left.objectId, left.author, 0], [right.objectId, right.author, 0])
			)
			.map((l) =>
				l === selectedLineage
					? phase === "final"
						? encodeCanonical(
								{
									...l,
									next: sequence === Number.MAX_SAFE_INTEGER ? sequence : sequence + 1,
									exhausted: sequence === Number.MAX_SAFE_INTEGER,
								},
								unsignedEncodingLimits
							).byteLength
						: unsignedRecordWidth(l, { pendingUnsigned: intentWidth })
					: encodeCanonical(l, unsignedEncodingLimits).byteLength
			);
		const issued = orderedWidths(
			phase === "final"
				? [
						...issuedBefore,
						{
							key: [scope.objectId, scope.author, sequence],
							width: unsignedRecordWidth(
								{ ...scope, authorSequence: sequence },
								{ canonicalPreimageBytes: unknownPreimage, digest: unknown32, signature: unknown64 }
							),
						},
					]
				: issuedBefore
		);
		const outbox = orderedWidths(
			phase === "final"
				? [
						...outboxBefore,
						{
							key: [scope.objectId, scope.author, sequence],
							width: unsignedRecordWidth(
								{ ...scope, authorSequence: sequence, publishState: "pending" },
								{ digest: unknown32 }
							),
						},
					]
				: outboxBefore
		);
		const phasePlans = [...plans]
			.sort((left, right) =>
				compareDurableIssuanceCompoundKeys(
					[left.scope.objectId, left.scope.author, 0],
					[right.scope.objectId, right.scope.author, 0]
				)
			)
			.map((p) => phase === "final" && p === plan ? finalPlan : p);
		const planWidths = sourceCustodyPlanWidths(phasePlans, scope,
			immediate.issued.filter(row => row.author === scope.author && row.objectId === scope.objectId).length + 1,
			sourceCustody, immediate.issued.reduce((sum, row) => sum + row.canonicalPreimageBytes.byteLength + 96, 0) +
				successor.canonicalPreimageByteLength + 96 + (phase === "final" ? 0 : intentWidth)).widths;
		const controlRevisionDelta = revisionDeltas[phase];
		const widths = unsignedNativePhaseWidths(
			lineages,
			issued,
			outbox,
			planWidths,
			unsignedNativeControlWidth(originalControl, scope.objectId, immediateDelta + controlRevisionDelta)
		);
		checkSourceCustodyNativeWidths(widths, sourceCustody);
		return Object.freeze({
			...widths,
			controlRevisionDelta,
			nativeImageBytes: unsignedNativeImageWidth(
				widths.canonicalRowsBytes,
				lineages.length,
				issued.length,
				outbox.length,
				planWidths.length
			),
		});
	};
	return Object.freeze({ reserved: make("reserved"), entered: make("entered"), final: make("final") });
}
export interface DurableIssuanceRetirementControlRead {
	readonly control: DurableIssuanceRetirementControl;
	readonly image: DurableIssuanceRetirementImage;
	readonly domainDigest: string;
	prepareFence(input: DurableIssuanceRetirementPreparation): Promise<DurableIssuanceRetirementControl>;
	abortPrepared(): Promise<DurableIssuanceRetirementControl>;
	commitPrepared(): Promise<DurableIssuanceRetirementControl>;
	release(): Promise<void>;
}

/**
 * Copies the original native job context; the currency fields grant no eligibility.
 * @param input - Original caller context captured before entering native work.
 * @returns Detached mechanical currency and settlement context, if supplied.
 */
export function captureIssuanceNativeSignContext(input: unknown): DurableIssueSignContext | undefined {
	if (input === undefined) return undefined;
	if (typeof input !== "object" || input === null) throw invalid();
	const keys = Reflect.ownKeys(input);
	const allowed = ["planEffect", "expectedIssuanceImageDigest", "expectedIssuanceControlBytes"];
	if (
		keys.some((k) => typeof k !== "string" || !allowed.includes(k)) ||
		!isClosedDurableIssuanceRecord(input, keys as string[])
	)
		throw invalid();
	const effect = input.planEffect === undefined ? undefined : copySettlementPlanEffect(input.planEffect);
	if (input.planEffect !== undefined && effect === undefined) throw invalid();
	const hasImage = Object.hasOwn(input, "expectedIssuanceImageDigest");
	const hasControl = Object.hasOwn(input, "expectedIssuanceControlBytes");
	if (hasImage !== hasControl) throw invalid();
	if (!hasImage) return Object.freeze(effect === undefined ? {} : { planEffect: effect });
	const expectedIssuanceImageDigest = digest(input.expectedIssuanceImageDigest);
	const rawControlBytes = input.expectedIssuanceControlBytes;
	let controlView: Uint8Array | null = null;
	if (rawControlBytes !== null) {
		if (!(rawControlBytes instanceof Uint8Array)) throw invalid();
		const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
		const length = (
			Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength") as { get(this: Uint8Array): number }
		).get.call(rawControlBytes);
		const buffer = (
			Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer") as { get(this: Uint8Array): ArrayBuffer }
		).get.call(rawControlBytes);
		const offset = (
			Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset") as { get(this: Uint8Array): number }
		).get.call(rawControlBytes);
		if (
			length === 0 ||
			length > ISSUANCE_RETIREMENT_LIMITS.maxBytes ||
			(typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer)
		)
			throw invalid();
		// A fixed plain view prevents caller-owned getters from running between
		// the intrinsic bound and the original detaching copy owner.
		controlView = new Uint8Array(buffer, offset, length);
	}
	const bytes = controlView === null ? null : copyDurableIssuanceBytes(controlView);
	if (bytes === undefined || (bytes !== null && bytes.byteLength > ISSUANCE_RETIREMENT_LIMITS.maxBytes))
		throw invalid();
	if (bytes !== null) {
		const control = decodeIssuanceRetirementControl(bytes);
		if (!issuanceRetirementBytesEqual(bytes, encodeIssuanceRetirementControl(control))) throw invalid();
	}
	return Object.freeze({
		...(effect === undefined ? {} : { planEffect: effect }),
		expectedIssuanceImageDigest,
		expectedIssuanceControlBytes: bytes,
	});
}

/** Captures the original serializer's exact unsigned bytes; not source/ACL authority. */
export function captureIssuanceNativeSignInput(input: unknown): Readonly<{
	scope: DurableIssueScope;
	bytes: Uint8Array;
	sequence: number;
	digest: Uint8Array;
}> {
	if (!isClosedDurableIssuanceRecord(input, ["scope", "exactCanonicalUnsignedVertexBytes"])) throw invalid();
	assertDurableIssueScope(input.scope);
	const scope = copyDurableIssueScope(input.scope);
	const raw = input.exactCanonicalUnsignedVertexBytes;
	if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > ISSUANCE_RETIREMENT_LIMITS.maxBytes)
		throw invalid();
	const bytes = new Uint8Array(raw),
		value = decodeCanonical(bytes);
	if (
		!issuanceRetirementBytesEqual(
			encodeCanonical(value, {
				maxBytes: ISSUANCE_RETIREMENT_LIMITS.maxBytes,
				maxDepth: 32,
				maxItems: ISSUANCE_RETIREMENT_LIMITS.maxRows * 128,
			}),
			bytes
		)
	)
		throw invalid();
	if (value === null || typeof value !== "object" || !("authorSequence" in value)) throw invalid();
	const sequence = Reflect.get(value, "authorSequence") as unknown;
	if (!isValidDurableAuthorSequence(sequence) || !decodeDurableIssuancePreimage(bytes, scope, sequence))
		throw invalid();
	return Object.freeze({ scope, bytes, sequence, digest: hashDomain("ts-drp/vertex/v3", bytes) });
}

/** Joins original native exclusion after the callback and preserves all failures. */
export async function joinIssuanceNativeSign<T>(
	check: () => Promise<void>,
	release: () => Promise<void>,
	sign: () => Promise<T>
): Promise<T> {
	let value: T | undefined,
		failed = false,
		primary: unknown;
	try {
		await check();
		value = await sign();
		await check();
	} catch (error) {
		failed = true;
		primary = error;
	}
	try {
		await release();
	} catch (error) {
		if (failed)
			throw new AggregateError([primary, error], "issuance native sign and release failed", { cause: primary });
		throw error;
	}
	if (failed) throw primary;
	return value as T;
}
const invalid = (): Error => new DurableIssuanceInvalidArgumentError("invalid issuance retirement input");
/**
 * Creates non-authoritative retry evidence for a refused native transition.
 * @param message - Non-authoritative diagnostic text.
 * @returns A typed non-poisoning refusal.
 */
export const issuanceRetirementRefusal = (message: string): Error =>
	createDurableIssuanceFailure("ISSUANCE_RETRY_REQUIRED", message);
const hex = /^[0-9a-f]{64}$/u;
/**
 *
 * @param bytes - Original owned digest bytes.
 * @returns The detached owner result or a typed refusal.
 */
export function issuanceRetirementHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function integer(v: unknown): number {
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw invalid();
	return v;
}
function digest(v: unknown): string {
	if (typeof v !== "string" || !hex.test(v)) throw invalid();
	return v;
}
/**
 *
 * @param input - Untrusted closed input.
 * @returns The detached owner result or a typed refusal.
 */
export function captureIssuanceRetirementObject(input: unknown): string {
	if (!isClosedDurableIssuanceRecord(input, ["objectId"]) || !isValidDurableScopeField(input.objectId)) throw invalid();
	return input.objectId;
}
function key(h: DurableIssuanceRetirementHole): string {
	return JSON.stringify([h.author, h.authorSequence, h.digest]);
}

function retirementPlanBytes(plan: SettlementPlan): Uint8Array {
	return encodeCanonical(plan, { maxBytes: ISSUANCE_RETIREMENT_LIMITS.maxBytes, maxDepth: 12,
		maxItems: ISSUANCE_RETIREMENT_LIMITS.maxRows * 32 });
}

// Verify-once memos keyed by exact canonical bytes (see verified-once.ts). Bounded
// so that a full-size (1 MiB) record still fits; entries never escape.
const VERIFIED_ONCE_LIMITS = Object.freeze({ maxEntries: 32, maxBytes: 8 * ISSUANCE_RETIREMENT_LIMITS.maxBytes });
const verifiedPlans = new IssuanceVerifiedOnceBytes<SettlementPlan>(VERIFIED_ONCE_LIMITS);
const verifiedControls = new IssuanceVerifiedOnceBytes<DurableIssuanceRetirementControl>(VERIFIED_ONCE_LIMITS);
let countsBase = { control: { verifications: 0, hits: 0 }, plan: { verifications: 0, hits: 0 } };
/**
 * Diagnostic work counts for the retirement control and embedded plan verifications.
 * @returns Full verifications and memo hits since the last reset.
 */
export function issuanceRetirementVerificationCounts(): Readonly<{
	control: IssuanceVerifiedOnceCounts; plan: IssuanceVerifiedOnceCounts;
}> {
	const control = verifiedControls.counts(), plan = verifiedPlans.counts();
	return {
		control: { verifications: control.verifications - countsBase.control.verifications, hits: control.hits - countsBase.control.hits },
		plan: { verifications: plan.verifications - countsBase.plan.verifications, hits: plan.hits - countsBase.plan.hits },
	};
}
/** Resets the diagnostic work counts and keeps every verified result. */
export function resetIssuanceRetirementVerificationCounts(): void {
	countsBase = { control: verifiedControls.counts(), plan: verifiedPlans.counts() };
}
/** Drops every verified result and resets the diagnostic work counts. Never needed for soundness. */
export function clearIssuanceRetirementVerifiedOnce(): void {
	verifiedControls.clear();
	verifiedPlans.clear();
	resetIssuanceRetirementVerificationCounts();
}

/**
 * Verifies exact canonical settlement-plan bytes at most once per byte image.
 * @param input - Untrusted plan bytes.
 * @returns `plan`, the SHARED verified plan (read it, never let it escape or mutate it),
 * and `bytes`, this call's own copy of the input, which equals `retirementPlanBytes(plan)`.
 */
function verifiedRetirementPlan(input: unknown): Readonly<{ plan: SettlementPlan; bytes: Uint8Array }> {
	const bytes = copyDurableIssuanceBytes(input);
	if (bytes === undefined || bytes.byteLength > ISSUANCE_RETIREMENT_LIMITS.maxBytes) throw invalid();
	const plan = verifiedPlans.verify(bytes, () => {
		const value = decodeCanonical(bytes);
		const hasContexts = typeof value === "object" && value !== null && Object.hasOwn(value, "sourceContexts");
		const hasHandBacks = typeof value === "object" && value !== null && Object.hasOwn(value, "handBacks");
		if (!isClosedDurableIssuanceRecord(value, ["scope", "revision", "fenceSequence", "entries",
			...(hasContexts ? ["sourceContexts"] : []), ...(hasHandBacks ? ["handBacks"] : [])])) throw invalid();
		assertDurableIssueScope(value.scope);
		const verified = copySettlementPlan(value, value.scope);
		if (verified === undefined || !issuanceRetirementBytesEqual(bytes, retirementPlanBytes(verified))) throw invalid();
		return verified;
	});
	return { plan, bytes };
}

function retirementPlanFromBytes(input: unknown): SettlementPlan {
	return detachIssuanceVerifiedValue(verifiedRetirementPlan(input).plan);
}

function captureIssuanceRetirementPlanRewrite(input: unknown): DurableIssuanceRetirementPlanRewrite {
	if (!isClosedDurableIssuanceRecord(input, ["kind", "sourceImageDigest", "targetImageDigest", "plans"]) ||
		input.kind !== "v3-issuance-retirement-plan-rewrite-1" || !Array.isArray(input.plans) ||
		Object.getPrototypeOf(input.plans) !== Array.prototype || input.plans.length === 0 ||
		input.plans.length > ISSUANCE_RETIREMENT_LIMITS.maxRows ||
		Reflect.ownKeys(input.plans).length !== input.plans.length + 1) throw invalid();
	let prior = "";
	const plans: {before: Uint8Array; after: Uint8Array}[] = [];
	for (let index = 0; index < input.plans.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(input.plans, String(index));
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable ||
			!isClosedDurableIssuanceRecord(descriptor.value, ["before", "after"])) throw invalid();
		// Read-only views of the shared verified plans; only this call's byte copies escape.
		const verifiedBefore = verifiedRetirementPlan(descriptor.value.before), before = verifiedBefore.plan;
		const verifiedAfter = verifiedRetirementPlan(descriptor.value.after), after = verifiedAfter.plan;
		const address = JSON.stringify([before.scope.objectId, before.scope.author]);
		if (address <= prior || before.scope.objectId !== after.scope.objectId || before.scope.author !== after.scope.author ||
			before.revision === Number.MAX_SAFE_INTEGER || after.revision !== before.revision + 1 ||
			after.fenceSequence !== before.fenceSequence || after.entries.length >= before.entries.length) throw invalid();
		prior = address;
		plans.push(Object.freeze({ before: verifiedBefore.bytes, after: verifiedAfter.bytes }));
	}
	return Object.freeze({ kind: "v3-issuance-retirement-plan-rewrite-1", sourceImageDigest: digest(input.sourceImageDigest),
		targetImageDigest: digest(input.targetImageDigest), plans: Object.freeze(plans) });
}
/**
 *
 * @param input - Untrusted closed input.
 * @returns The detached owner result or a typed refusal.
 */
export function captureIssuanceRetirementPreparation(input: unknown): DurableIssuanceRetirementPreparation {
	const hasRewrite = typeof input === "object" && input !== null && Object.hasOwn(input, "planRewrite");
	if (
		!isClosedDurableIssuanceRecord(input, ["decisionDigest", "sourceProofDigest", "throughEpoch", "protectedRecords",
			...(hasRewrite ? ["planRewrite"] : [])])
	)
		throw invalid();
	const records = input.protectedRecords;
	if (
		!Array.isArray(records) ||
		Object.getPrototypeOf(records) !== Array.prototype ||
		records.length > ISSUANCE_RETIREMENT_LIMITS.maxRows ||
		Reflect.ownKeys(records).length !== records.length + 1
	)
		throw invalid();
	const holes: DurableIssuanceRetirementHole[] = [];
	for (let i = 0; i < records.length; i++) {
		const d = Object.getOwnPropertyDescriptor(records, String(i));
		if (
			!d ||
			!("value" in d) ||
			!d.enumerable ||
			!isClosedDurableIssuanceRecord(d.value, ["author", "authorSequence", "digest"]) ||
			!isValidDurableScopeField(d.value.author)
		)
			throw invalid();
		const h = Object.freeze({
			author: d.value.author,
			authorSequence: integer(d.value.authorSequence),
			digest: digest(d.value.digest),
		});
		if (
			holes.some((p) => p.author === h.author && p.authorSequence === h.authorSequence) ||
			(holes[i - 1] && key(holes[i - 1] as DurableIssuanceRetirementHole) >= key(h))
		)
			throw invalid();
		holes.push(h);
	}
	const result = Object.freeze({
		decisionDigest: digest(input.decisionDigest),
		sourceProofDigest: digest(input.sourceProofDigest),
		throughEpoch: integer(input.throughEpoch),
		protectedRecords: Object.freeze(holes),
		...(hasRewrite ? { planRewrite: captureIssuanceRetirementPlanRewrite(input.planRewrite) } : {}),
	});
	encodeCanonical(result, {
		maxBytes: ISSUANCE_RETIREMENT_LIMITS.maxBytes,
		maxDepth: 9,
		maxItems: ISSUANCE_RETIREMENT_LIMITS.maxRows * 8,
	});
	return result;
}
function advanceAllowed(
	prior: DurableIssuanceRetirementPreparation,
	next: DurableIssuanceRetirementPreparation
): boolean {
	// Every newly retained old address must already be a retained hole. Newly obsolete epoch
	// holes are checked against the original canonical native row by the backend capture.
	return next.throughEpoch >= prior.throughEpoch;
}
/**
 *
 * @param value - Native complete carrier.
 * @returns The detached owner result or a typed refusal.
 */
/** Original native field owner; scalar resource slots do not authorize a control. */
export function issuanceRetirementControlFields<O, I, R, S, A, C>(input: Readonly<{
	objectId: O; incarnation: I; revision: R; sequence: S; active: A; completed: C;
}>) {
	return {kind: "v3-issuance-retirement-control-1" as const, objectId: input.objectId,
		incarnation: input.incarnation, revision: input.revision, sequence: input.sequence,
		active: input.active, completed: input.completed};
}
export function captureIssuanceRetirementControl(value: unknown): DurableIssuanceRetirementControl {
	if (
		!isClosedDurableIssuanceRecord(value, [
			"kind",
			"objectId",
			"incarnation",
			"revision",
			"sequence",
			"active",
			"completed",
		]) ||
		value.kind !== "v3-issuance-retirement-control-1"
	)
		throw invalid();
	const objectId = captureIssuanceRetirementObject({ objectId: value.objectId });
	const sequence = integer(value.sequence);
	const completed = value.completed === null ? null : captureIssuanceRetirementPreparation(value.completed);
	let active: DurableIssuanceRetirementControl["active"] = null;
	if (value.active !== null) {
		if (
			!isClosedDurableIssuanceRecord(value.active, ["sequence", "preparation"]) ||
			value.active.sequence !== sequence ||
			sequence === 0
		)
			throw invalid();
		active = Object.freeze({ sequence, preparation: captureIssuanceRetirementPreparation(value.active.preparation) });
	}
	if (active && completed && !advanceAllowed(completed, active.preparation)) throw invalid();
	return Object.freeze(issuanceRetirementControlFields({
		objectId,
		incarnation: digest(value.incarnation),
		revision: integer(value.revision),
		sequence,
		active,
		completed,
	}));
}
/**
 *
 * @param control - Actual native complete control.
 * @returns The detached owner result or a typed refusal.
 */
export function encodeIssuanceRetirementControl(control: DurableIssuanceRetirementControl): Uint8Array {
	return encodeCanonical(captureIssuanceRetirementControl(control), {
		maxBytes: ISSUANCE_RETIREMENT_LIMITS.maxBytes,
		maxDepth: 12,
		maxItems: ISSUANCE_RETIREMENT_LIMITS.maxRows * 16 + 64,
	});
}
/**
 *
 * @param value - Native complete carrier.
 * @returns The detached owner result or a typed refusal.
 */
export function decodeIssuanceRetirementControl(value: unknown): DurableIssuanceRetirementControl {
	if (
		!(value instanceof Uint8Array) ||
		value.byteLength > ISSUANCE_RETIREMENT_LIMITS.maxBytes ||
		(typeof SharedArrayBuffer !== "undefined" && value.buffer instanceof SharedArrayBuffer)
	)
		throw invalid();
	const own = new Uint8Array(value);
	return detachIssuanceRetirementControl(verifiedControls.verify(own, () => {
		const control = captureIssuanceRetirementControl(decodeCanonical(own));
		const exact = encodeIssuanceRetirementControl(control);
		if (!issuanceRetirementBytesEqual(own, exact)) throw invalid();
		return control;
	}));
}
function detachIssuanceRetirementPreparation(p: DurableIssuanceRetirementPreparation): DurableIssuanceRetirementPreparation {
	// Frozen digests and protected records are shared; only the embedded plan bytes are mutable.
	const rewrite = p.planRewrite;
	return Object.freeze({ ...p, ...(rewrite === undefined ? {} : { planRewrite: Object.freeze({ ...rewrite,
		plans: Object.freeze(rewrite.plans.map(plan => Object.freeze({ before: new Uint8Array(plan.before),
			after: new Uint8Array(plan.after) }))) }) }) });
}
/** Fresh frozen control around shared frozen leaves and freshly copied plan bytes. */
function detachIssuanceRetirementControl(control: DurableIssuanceRetirementControl): DurableIssuanceRetirementControl {
	return Object.freeze({ ...control,
		active: control.active === null ? null : Object.freeze({ ...control.active,
			preparation: detachIssuanceRetirementPreparation(control.active.preparation) }),
		completed: control.completed === null ? null : detachIssuanceRetirementPreparation(control.completed) });
}
/**
 *
 * @param a - First exact byte image.
 * @param b - Second exact byte image.
 * @returns The detached owner result or a typed refusal.
 */
export function issuanceRetirementBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	return issuanceExactBytesEqual(a, b);
}
/**
 *
 * @param control - Actual native complete control.
 * @param scope - Original issuance scope.
 * @param sequence - Original cross-epoch author ordinal.
 * @param preimage - Original canonical issued bytes.
 * @param rowDigest - Original issued-row digest.
 * @returns The detached owner result or a typed refusal.
 */
export function issuanceRetirementAllows(
	control: DurableIssuanceRetirementControl | null,
	scope: DurableIssueScope,
	sequence: number,
	preimage: Uint8Array,
	rowDigest: Uint8Array
): boolean {
	if (control === null) return true;
	const decoded = decodeDurableIssuancePreimage(preimage, scope, sequence);
	if (!decoded || control.objectId !== scope.objectId) return false;
	const allows = (p: DurableIssuanceRetirementPreparation | null): boolean =>
		p === null ||
		decoded.epoch > p.throughEpoch ||
		p.protectedRecords.some(
			(h) => h.author === scope.author && h.authorSequence === sequence && h.digest === issuanceRetirementHex(rowDigest)
		);
	return allows(control.completed) && allows(control.active?.preparation ?? null);
}
/**
 *
 * @param control - Actual native complete control.
 * @returns The detached owner result or a typed refusal.
 */
export function advanceIssuanceRetirementControl(
	control: DurableIssuanceRetirementControl
): DurableIssuanceRetirementControl {
	if (control.revision === Number.MAX_SAFE_INTEGER)
		throw issuanceRetirementRefusal("issuance retirement revision exhausted");
	return captureIssuanceRetirementControl({ ...control, revision: control.revision + 1 });
}
/**
 *
 * @param rows - Complete bounded native issuance image.
 * @param objectId - Exact addressed object.
 * @returns The detached owner result or a typed refusal.
 */
export function issuanceRetirementImage(
	rows: IssuanceRetirementRows,
	objectId: string
): DurableIssuanceRetirementImage {
	const all = [...rows.lineages, ...rows.issued, ...rows.outbox, ...rows.plans];
	if (all.length > ISSUANCE_RETIREMENT_LIMITS.maxRows)
		throw issuanceRetirementRefusal("issuance retirement census exceeds bound");
	let charge = 0;
	for (const row of all) {
		charge += encodeCanonical(row, {
			maxBytes: ISSUANCE_RETIREMENT_LIMITS.maxBytes,
			maxDepth: 16,
			maxItems: ISSUANCE_RETIREMENT_LIMITS.maxRows * 32,
		}).byteLength;
		if (charge > ISSUANCE_RETIREMENT_LIMITS.maxBytes)
			throw issuanceRetirementRefusal("issuance retirement image exceeds bound");
	}
	if (
		rows.lineages.some((l) => l.objectId !== objectId) ||
		rows.issued.some((r) => r.objectId !== objectId) ||
		rows.outbox.some((r) => r.objectId !== objectId) ||
		rows.plans.some((p) => p.scope.objectId !== objectId)
	)
		throw invalid();
	for (const l of rows.lineages) {
		if (l.pendingUnsigned !== undefined) {
			const pending = captureIssuancePendingUnsignedIntent(l.pendingUnsigned, { objectId: l.objectId, author: l.author });
			if (l.exhausted || pending.authorSequence !== l.next) throw issuanceRetirementRefusal("issuance pending ordinal differs from lineage");
		}
		const issued = rows.issued.filter((r) => r.author === l.author),
			outbox = rows.outbox.filter((r) => r.author === l.author);
		const count =
			l.next + (l.exhausted ? 1 : 0) - (l.prunedThroughAuthorSequence === null ? 0 : l.prunedThroughAuthorSequence + 1);
		if (count !== issued.length || outbox.length !== issued.length)
			throw issuanceRetirementRefusal("issuance retirement has incomplete lineage");
	}
	for (const r of rows.issued) {
		const l = rows.lineages.find((l) => l.author === r.author);
		const out = rows.outbox.find((o) => o.author === r.author && o.authorSequence === r.authorSequence);
		if (
			!l ||
			!out ||
			!durableIssuanceLineageConsumed(l, r.authorSequence) ||
			durableIssuanceAddressIsPruned(l.prunedThroughAuthorSequence, r.authorSequence) ||
			!issuanceRetirementBytesEqual(r.digest, out.digest) ||
			!decodeDurableIssuancePreimage(r.canonicalPreimageBytes, r, r.authorSequence)
		)
			throw issuanceRetirementRefusal("issuance retirement row is unclassified");
	}
	for (const p of rows.plans) {
		const lineage = rows.lineages.find((l) => l.author === p.scope.author);
		// Before its first target fence, a migrated author has a plan and no lineage here. Its
		// entries then name only sources outside this object: an external source, or an
		// inherited source whose operation the target creator imported into this object.
		if (
			!lineage &&
			!(
				p.fenceSequence === null &&
				p.entries.length > 0 &&
				p.entries.every(
					(entry) =>
						entry.replacementSequence === null &&
						(entry.replacementProgress === undefined || entry.replacementProgress.chunks.length === 0) &&
						((entry.sourceObjectId !== undefined && entry.sourceObjectId !== objectId) ||
							(entry.disposition === "inherited" &&
								entry.inheritance !== undefined &&
								entry.inheritance.targetObjectId === objectId &&
								entry.inheritance.sourceObjectId !== objectId))
				)
			)
		)
			throw issuanceRetirementRefusal("issuance retirement plan has no lineage");
		for (const entry of p.entries) {
			// This retained external identity grants neither admission nor completion.
			// Shared migration custody reopens and charges the exact original native
			// source before any irreversible target effect.
			if (entry.sourceObjectId !== undefined) {
				if (entry.sourceObjectId === objectId)
					throw issuanceRetirementRefusal("issuance external source scope is invalid");
				continue;
			}
			// An authenticated migration retains the ORIGINAL external source identity.
			// Its ordinal is not a row address in this target image (even when authors
			// and ordinals collide). The shared held census authenticates and charges
			// that source and the target record before any fence/delivery/reclamation.
			if (entry.disposition === "inherited") {
				if (
					entry.inheritance === undefined ||
					entry.inheritance.targetObjectId !== objectId ||
					entry.inheritance.sourceObjectId === objectId
				)
					throw issuanceRetirementRefusal("issuance inherited source scope is unclassified");
				continue;
			}
			const row = rows.issued.find((r) => r.author === p.scope.author && r.authorSequence === entry.sourceSequence);
			if (
				row
					? !issuanceRetirementBytesEqual(row.digest, entry.sourceDigest)
					: lineage === undefined ||
						!durableIssuanceAddressIsPruned(lineage.prunedThroughAuthorSequence, entry.sourceSequence) ||
						!settlementPlanPermitsAuthenticatedPruning(p)
			)
				throw issuanceRetirementRefusal("issuance retirement plan source is unclassified");
		}
	}
	const bytes = encodeCanonical(rows, {
		maxBytes: ISSUANCE_RETIREMENT_LIMITS.maxBytes,
		maxDepth: 16,
		maxItems: ISSUANCE_RETIREMENT_LIMITS.maxRows * 128,
	});
	return Object.freeze({
		imageDigest: issuanceRetirementHex(hashDomain("ts-drp/issuance-retirement-image/v1", bytes)),
		logicalBytes: bytes.length,
		lineageCount: rows.lineages.length,
		issuedCount: rows.issued.length,
		outboxCount: rows.outbox.length,
		planCount: rows.plans.length,
	});
}

type RetirementIssuedRow = IssuanceRetirementRows["issued"][number];

function retirementKeepsRow(control: DurableIssuanceRetirementControl | null,
	p: DurableIssuanceRetirementPreparation, row: RetirementIssuedRow): boolean {
	const epoch = decodeDurableIssuancePreimage(row.canonicalPreimageBytes, row, row.authorSequence)?.epoch;
	if (epoch === undefined) throw issuanceRetirementRefusal("issuance retirement row is unclassified");
	return issuanceRetirementAllows(control, row, row.authorSequence, row.canonicalPreimageBytes, row.digest) &&
		(epoch > p.throughEpoch || p.protectedRecords.some(hole => hole.author === row.author &&
			hole.authorSequence === row.authorSequence && hole.digest === issuanceRetirementHex(row.digest)));
}

function retirementLocalSource(plan: SettlementPlan, entry: SettlementPlan["entries"][number],
	rows: IssuanceRetirementRows): RetirementIssuedRow | undefined {
	if (entry.sourceObjectId !== undefined || entry.disposition === "inherited") return undefined;
	const row = rows.issued.find(value => value.author === plan.scope.author && value.authorSequence === entry.sourceSequence);
	if (row !== undefined && !issuanceRetirementBytesEqual(row.digest, entry.sourceDigest))
		throw issuanceRetirementRefusal("issuance retirement plan source digest changed");
	return row;
}

function retirementEntryOwnsTerminalSourceProof(entry: SettlementPlan["entries"][number]): boolean {
	return entry.sourceContextDigest !== undefined && (entry.disposition === "committed" || entry.disposition === "expire");
}

function retirementEntryIsRetained(control: DurableIssuanceRetirementControl | null,
	p: DurableIssuanceRetirementPreparation, plan: SettlementPlan, entry: SettlementPlan["entries"][number],
	rows: IssuanceRetirementRows): boolean {
	if (entry.sourceObjectId !== undefined || entry.disposition === "inherited" ||
		!settlementPlanPermitsAuthenticatedPruning({ fenceSequence: plan.fenceSequence, entries: [entry] })) return true;
	const source = retirementLocalSource(plan, entry, rows);
	return source !== undefined && retirementKeepsRow(control, p, source);
}

function retirementEntrySequences(entry: SettlementPlan["entries"][number]): readonly number[] {
	return [...(entry.replacementSequence === null ? [] : [entry.replacementSequence]),
		...(entry.replacementProgress?.chunks.map(chunk => chunk.replacementSequence) ?? [])];
}

/** Closes selected protection under the surviving plan's dependencies. The fixed point
 * matters when a replacement is itself the source of another retained entry. It never
 * resurrects a permanently retired row or grants retirement eligibility. */
export function closeIssuanceRetirementProtectedRecords(input: Readonly<{
	control: DurableIssuanceRetirementControl | null; rows: IssuanceRetirementRows;
	throughEpoch: number; protectedRecords: readonly DurableIssuanceRetirementHole[];
}>): readonly DurableIssuanceRetirementHole[] {
	const { control, rows } = input;
	const holes = new Map(input.protectedRecords.map(hole => [key(hole), hole]));
	const preparation = (): DurableIssuanceRetirementPreparation => ({decisionDigest: "0".repeat(64),
		sourceProofDigest: "0".repeat(64), throughEpoch: input.throughEpoch, protectedRecords: [...holes.values()]});
	const protect = (author: string, sequence: number): void => {
		const row = rows.issued.find(value => value.author === author && value.authorSequence === sequence);
		if (row === undefined || !issuanceRetirementAllows(control, row, sequence, row.canonicalPreimageBytes, row.digest))
			throw issuanceRetirementRefusal("issuance retirement retained plan dependency is absent or permanently retired");
		const epoch = decodeDurableIssuancePreimage(row.canonicalPreimageBytes, row, sequence)?.epoch;
		if (epoch === undefined) throw issuanceRetirementRefusal("issuance retirement dependency epoch is unclassified");
		if (epoch <= input.throughEpoch) {
			const hole = {author, authorSequence: sequence, digest: issuanceRetirementHex(row.digest)};
			holes.set(key(hole), hole);
		}
	};
	let prior: number;
	do {
		prior = holes.size;
		const p = preparation();
		// The original portable verifier still opens its exact native source and plan
		// entry. Keep those consumers until the target itself retires; an embedded
		// descriptor does not independently discharge that native verification law.
		for (const row of rows.issued) {
			if (!retirementKeepsRow(control, p, row)) continue;
			const vertex = decodeCanonical(row.canonicalPreimageBytes);
			if (typeof vertex !== "object" || vertex === null || Array.isArray(vertex) ||
				!Object.hasOwn(vertex, "settlementSource")) continue;
			const source: unknown = Reflect.get(vertex, "settlementSource");
			if (typeof source !== "object" || source === null || Array.isArray(source))
				throw issuanceRetirementRefusal("issuance portable source is malformed");
			const objectId: unknown = Reflect.get(source, "sourceObjectId"), author: unknown = Reflect.get(source, "sourceAuthor"),
				sequence: unknown = Reflect.get(source, "sourceSequence"), sourceDigest: unknown = Reflect.get(source, "sourceDigest");
			if (!isValidDurableScopeField(objectId) || author !== row.author || !isValidDurableAuthorSequence(sequence) ||
				typeof sourceDigest !== "string")
				throw issuanceRetirementRefusal("issuance portable source identity is unclassified");
			const plan = rows.plans.find(value => value.scope.author === row.author);
			if (objectId !== row.objectId) {
				// Cross-object migration owns its source through a separately held
				// native store. Its ordinal must never alias this target's lineage.
				const entry = plan?.entries.find(value => value.sourceObjectId === objectId &&
					value.sourceSequence === sequence && retirementEntrySequences(value).includes(row.authorSequence));
				if (entry === undefined || issuanceRetirementHex(entry.sourceDigest) !== sourceDigest)
					throw issuanceRetirementRefusal("issuance portable external source dependency is absent");
				continue;
			}
			if (sequence >= row.authorSequence) throw issuanceRetirementRefusal("issuance portable source order is unclassified");
			const original = rows.issued.find(value => value.author === author && value.authorSequence === sequence);
			const entry = plan?.entries.find(value => value.sourceObjectId === undefined && value.disposition !== "inherited" &&
				value.sourceSequence === sequence && retirementEntrySequences(value).includes(row.authorSequence));
			if (original === undefined || entry === undefined || issuanceRetirementHex(original.digest) !== sourceDigest ||
				!issuanceRetirementBytesEqual(entry.sourceDigest, original.digest))
				throw issuanceRetirementRefusal("issuance portable native source dependency is absent");
			protect(author, sequence);
		}
		for (const plan of rows.plans) {
			// One plan per author survives successor installs with a monotone CAS revision.
			if (plan.fenceSequence !== null) protect(plan.scope.author, plan.fenceSequence);
			for (const entry of plan.entries) {
				if (!retirementEntryIsRetained(control, p, plan, entry, rows)) continue;
				if (entry.sourceObjectId === undefined && entry.disposition !== "inherited") {
					retirementLocalSource(plan, entry, rows);
					protect(plan.scope.author, entry.sourceSequence);
				}
				for (const sequence of retirementEntrySequences(entry)) protect(plan.scope.author, sequence);
				if (plan.fenceSequence === null && entry.inheritance !== undefined) {
					const target = entry.inheritance;
					const row = rows.issued.find(value => value.objectId === target.targetObjectId &&
						value.author === target.targetAuthor && value.authorSequence === target.targetAuthorSequence);
					if (row !== undefined) {
						if (!issuanceRetirementBytesEqual(row.digest, target.targetVertexDigest))
							throw issuanceRetirementRefusal("issuance inherited target digest changed");
						protect(row.author, row.authorSequence);
					}
				}
			}
		}
	} while (holes.size !== prior);
	return captureIssuanceRetirementPreparation({...preparation(), protectedRecords:
		[...holes.values()].sort((left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0)}).protectedRecords;
}

function issuanceRetirementTargetRows(control: DurableIssuanceRetirementControl | null,
	p: DurableIssuanceRetirementPreparation, rows: IssuanceRetirementRows): IssuanceRetirementRows {
	const plans = rows.plans.map(plan => {
		// A terminal historical proof still authenticates the exact physical source
		// until the original prefix pruner removes it. Earlier protected rows can
		// delay that drain beyond this metadata transaction and later issuance.
		// Keeping these bytes is custody, not a protected source hole.
		const entries = plan.entries.filter(entry => retirementEntryIsRetained(control, p, plan, entry, rows) ||
			retirementEntryOwnsTerminalSourceProof(entry) && retirementLocalSource(plan, entry, rows) !== undefined);
		if (entries.length === plan.entries.length) return plan;
		if (plan.revision === Number.MAX_SAFE_INTEGER) throw issuanceRetirementRefusal("settlement plan revision exhausted");
		const {sourceContexts: _contexts, ...plain} = plan;
		const sourceContexts = settlementSourceContextsForEntries(plan, entries);
		return {...plain, revision: plan.revision + 1, entries, ...(sourceContexts === undefined ? {} : {sourceContexts})};
	});
	return {...rows, plans};
}

/** Constructs the exact bounded plan delta from the original selected rows. The native
 * owner independently repeats this derivation before preparation and atomic commit. */
export function issuanceRetirementPreparationWithPlanRewrite(control: DurableIssuanceRetirementControl | null,
	input: DurableIssuanceRetirementPreparation, rows: IssuanceRetirementRows): DurableIssuanceRetirementPreparation {
	const {planRewrite: _prior, ...plain} = captureIssuanceRetirementPreparation(input);
	const objectId = control?.objectId ?? rows.lineages[0]?.objectId ?? rows.plans[0]?.scope.objectId;
	if (objectId === undefined) return captureIssuanceRetirementPreparation(plain);
	const sourceImage = issuanceRetirementImage(rows, objectId);
	const target = issuanceRetirementTargetRows(control, plain, rows);
	const plans = rows.plans.flatMap((before, index) => {
		const after = target.plans[index]!;
		return after === before ? [] : [{before: retirementPlanBytes(before), after: retirementPlanBytes(after)}];
	}).sort((left, right) => {
		const a = verifiedRetirementPlan(left.before).plan.scope, b = verifiedRetirementPlan(right.before).plan.scope;
		const ka = JSON.stringify([a.objectId, a.author]), kb = JSON.stringify([b.objectId, b.author]);
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});
	if (plans.length === 0) return captureIssuanceRetirementPreparation(plain);
	return captureIssuanceRetirementPreparation({...plain, planRewrite: {
		kind: "v3-issuance-retirement-plan-rewrite-1", sourceImageDigest: sourceImage.imageDigest,
		targetImageDigest: issuanceRetirementImage(target, objectId).imageDigest, plans}});
}

/** Native commit's plan projection. Exact source/control CAS still belongs to the
 * adapter transaction; this function checks the original law and full image delta. */
export function issuanceRetirementCommitRows(control: DurableIssuanceRetirementControl,
	p: DurableIssuanceRetirementPreparation, rows: IssuanceRetirementRows): IssuanceRetirementRows {
	const expected = issuanceRetirementPreparationWithPlanRewrite(control, p, rows);
	if (!issuanceRetirementBytesEqual(encodeCanonical(expected), encodeCanonical(p)))
		throw issuanceRetirementRefusal("issuance retirement plan rewrite differs from original row law");
	return issuanceRetirementTargetRows(control, p, rows);
}

/** The one metadata transition that also changes plans is the prepared commit. */
export function issuanceRetirementTransitionRows(control: DurableIssuanceRetirementControl,
	next: DurableIssuanceRetirementControl, rows: IssuanceRetirementRows): IssuanceRetirementRows {
	if (control.active === null || next.active !== null || next.completed === null ||
		!issuanceRetirementBytesEqual(encodeCanonical(control.active.preparation), encodeCanonical(next.completed))) return rows;
	return checkedIssuanceRetirementTargetRows(control, control.active.preparation, rows);
}

/** Inverts only the exact committed target image, then repeats the forward row law.
 * Callers must also reauthenticate their source and durable coordinator commitment. */
export function reconstructIssuanceRetirementSourceRows(control: DurableIssuanceRetirementControl,
	p: DurableIssuanceRetirementPreparation, rows: IssuanceRetirementRows): IssuanceRetirementRows {
	const rewrite = p.planRewrite;
	if (rewrite === undefined) return rows;
	if (issuanceRetirementImage(rows, control.objectId).imageDigest !== rewrite.targetImageDigest)
		throw issuanceRetirementRefusal("issuance retirement rewrite target changed");
	const plans = [...rows.plans];
	for (const change of rewrite.plans) {
		const before = retirementPlanFromBytes(change.before), after = verifiedRetirementPlan(change.after).plan;
		const index = plans.findIndex(plan => plan.scope.objectId === after.scope.objectId && plan.scope.author === after.scope.author);
		if (index < 0 || !issuanceRetirementBytesEqual(retirementPlanBytes(plans[index]!), change.after))
			throw issuanceRetirementRefusal("issuance retirement rewrite plan changed");
		plans[index] = before;
	}
	const original = {...rows, plans};
	if (issuanceRetirementImage(original, control.objectId).imageDigest !== rewrite.sourceImageDigest)
		throw issuanceRetirementRefusal("issuance retirement rewrite source changed");
	const target = issuanceRetirementCommitRows(control, p, original);
	if (issuanceRetirementImage(target, control.objectId).imageDigest !== rewrite.targetImageDigest)
		throw issuanceRetirementRefusal("issuance retirement rewrite projection changed");
	return original;
}
/**
 *
 * @param control - Actual native complete control.
 * @param p - Captured mechanical checkpoint.
 * @param rows - Complete bounded native issuance image.
 */
export function assertIssuanceRetirementPreparationRows(
	control: DurableIssuanceRetirementControl,
	p: DurableIssuanceRetirementPreparation,
	rows: IssuanceRetirementRows
): void {
	checkedIssuanceRetirementTargetRows(control, p, rows);
}

/** Return the exact target whose retained dependencies were checked below.
 * Native callers supply their detached row capture and invoke this separately
 * for the expected image and the fresh transaction image. Each call repeats
 * validation and accepts no previously computed or caller-supplied target. */
function checkedIssuanceRetirementTargetRows(
	control: DurableIssuanceRetirementControl,
	p: DurableIssuanceRetirementPreparation,
	rows: IssuanceRetirementRows
): IssuanceRetirementRows {
	if (rows.lineages.some(l => l.pendingUnsigned !== undefined))
		throw issuanceRetirementRefusal("issuance entered or reserved unsigned intent is unresolved");
	const closed = closeIssuanceRetirementProtectedRecords({control, rows, throughEpoch: p.throughEpoch,
		protectedRecords: p.protectedRecords});
	if (!issuanceRetirementBytesEqual(encodeCanonical(closed), encodeCanonical(p.protectedRecords)))
		throw issuanceRetirementRefusal("issuance retirement protected records are not dependency closed");
	for (const h of p.protectedRecords) {
		const r = rows.issued.find(
			(r) =>
				r.author === h.author && r.authorSequence === h.authorSequence && issuanceRetirementHex(r.digest) === h.digest
		);
		const epoch = r && decodeDurableIssuancePreimage(r.canonicalPreimageBytes, r, r.authorSequence)?.epoch;
		if (
			epoch === undefined ||
			epoch > p.throughEpoch ||
			(control.completed &&
				epoch <= control.completed.throughEpoch &&
				!control.completed.protectedRecords.some((old) => key(old) === key(h)))
		)
			throw issuanceRetirementRefusal("issuance retirement hole is absent or permanently retired");
	}
	const proposed = { ...control, active: { sequence: control.sequence + 1, preparation: p } };
	for (const r of rows.issued) {
		const allowed = issuanceRetirementAllows(proposed, r, r.authorSequence, r.canonicalPreimageBytes, r.digest);
		const out = rows.outbox.find(
			(o) => o.author === r.author && o.authorSequence === r.authorSequence
		) as IssuanceRetirementRows["outbox"][number];
		// Signed local-author expiry terminates the exact pending source without
		// publication. Store-level exclusivity keeps it from ever publishing.
		if (!allowed && out.publishState === "pending" && !issuanceRowHasAuthenticatedExpiry(rows, r))
			throw issuanceRetirementRefusal("issuance retirement pending publication is unprotected");
	}
	const target = issuanceRetirementCommitRows(control, p, rows);
	for (const plan of target.plans) {
		const refs = plan.entries.filter((e) => e.disposition !== "inherited" && e.sourceObjectId === undefined &&
			// A retained terminal proof may describe an already retired physical
			// source. The native image still checks its exact digest/pair; it does
			// not revive that source or make it a protected dependency.
			(!retirementEntryOwnsTerminalSourceProof(e) || retirementEntryIsRetained(control, p, plan, e, rows)))
			.map((e) => e.sourceSequence);
		if (plan.fenceSequence !== null) refs.push(plan.fenceSequence);
		for (const e of plan.entries) {
			if (e.replacementSequence !== null) refs.push(e.replacementSequence);
			for (const chunk of e.replacementProgress?.chunks ?? []) refs.push(chunk.replacementSequence);
		}
		for (const seq of refs) {
			const r = rows.issued.find((r) => r.author === plan.scope.author && r.authorSequence === seq);
			if (!r || !issuanceRetirementAllows(proposed, r, seq, r.canonicalPreimageBytes, r.digest))
				throw issuanceRetirementRefusal("issuance retirement retained plan dependency is unprotected");
		}
		assertIssuancePendingInheritanceTargetsAllowed(proposed, plan, rows);
	}
	return target;
}

/**
 * Keeps locally issued target records while inherited completion is still pending.
 * Received records live in the authenticated journal, not a fabricated issuance row.
 * @param control - Actual local retirement control.
 * @param plan - Captured retained plan.
 * @param rows - Complete bounded local issuance image.
 */
function assertIssuancePendingInheritanceTargetsAllowed(
	control: DurableIssuanceRetirementControl | null,
	plan: SettlementPlan,
	rows: IssuanceRetirementRows
): void {
	if (plan.fenceSequence !== null) return;
	for (const entry of plan.entries) {
		const target = entry.inheritance;
		if (target === undefined) continue;
		const row = rows.issued.find(
			(r) =>
				r.objectId === target.targetObjectId &&
				r.author === target.targetAuthor &&
				r.authorSequence === target.targetAuthorSequence
		);
		if (
			row !== undefined &&
			(!issuanceRetirementBytesEqual(row.digest, target.targetVertexDigest) ||
				!issuanceRetirementAllows(control, row, row.authorSequence, row.canonicalPreimageBytes, row.digest))
		)
			throw issuanceRetirementRefusal("issuance inherited target dependency is unprotected");
	}
}
/**
 *
 * @param control - Actual native complete control.
 * @param plan - Original captured settlement plan.
 * @param rows - Complete bounded native issuance image.
 */
export function assertIssuanceRetirementPlanAllowed(
	control: DurableIssuanceRetirementControl | null,
	plan: SettlementPlan,
	rows: IssuanceRetirementRows
): void {
	if (rows.lineages.some(l => l.author === plan.scope.author && l.pendingUnsigned !== undefined))
		throw issuanceRetirementRefusal("settlement context has unresolved unsigned intent");
	assertIssuancePendingInheritanceTargetsAllowed(control, plan, rows);
	if (!control || (!control.active && !control.completed)) return;
	const prior = rows.plans.find(value => value.scope.objectId === plan.scope.objectId && value.scope.author === plan.scope.author);
	const unchangedTerminalProof = (entry: SettlementPlan["entries"][number]): boolean => {
		if (!retirementEntryOwnsTerminalSourceProof(entry)) return false;
		const previous = prior?.entries.find(value => value.sourceSequence === entry.sourceSequence);
		if (previous === undefined || !issuanceRetirementBytesEqual(encodeCanonical(previous), encodeCanonical(entry))) return false;
		const source = retirementLocalSource(plan, entry, rows);
		if (source === undefined) {
			const lineage = rows.lineages.find(value => value.author === plan.scope.author);
			if (lineage === undefined || !durableIssuanceAddressIsPruned(lineage.prunedThroughAuthorSequence, entry.sourceSequence)) return false;
		} else if (!rows.outbox.some(value => value.author === plan.scope.author && value.authorSequence === entry.sourceSequence &&
			issuanceRetirementBytesEqual(value.digest, entry.sourceDigest))) return false;
		return [entry.sourceContextDigest, entry.sourceResolutionDigest].every(digest => {
			if (digest === undefined) return true;
			const before = prior?.sourceContexts?.find(context => issuanceRetirementBytesEqual(context.digest, digest));
			const after = plan.sourceContexts?.find(context => issuanceRetirementBytesEqual(context.digest, digest));
			return before !== undefined && after !== undefined &&
				issuanceRetirementBytesEqual(before.exactCanonicalContextBytes, after.exactCanonicalContextBytes);
		});
	};
	// Preserve an exact already-owned terminal proof across unrelated plan/fence
	// progress. This neither admits a new reference to retired work nor permits
	// mutation of the source, completion, or their original context bytes.
	const refs = plan.entries.filter((e) => e.disposition !== "inherited" && e.sourceObjectId === undefined && !unchangedTerminalProof(e))
		.map((e) => e.sourceSequence);
	if (plan.fenceSequence !== null) refs.push(plan.fenceSequence);
	for (const e of plan.entries) {
		if (e.replacementSequence !== null) refs.push(e.replacementSequence);
		for (const c of e.replacementProgress?.chunks ?? []) refs.push(c.replacementSequence);
	}
	for (const seq of refs) {
		const row = rows.issued.find((r) => r.author === plan.scope.author && r.authorSequence === seq);
		if (!row || !issuanceRetirementAllows(control, row, seq, row.canonicalPreimageBytes, row.digest))
			throw issuanceRetirementRefusal("settlement plan references retired or absent issued work");
	}
}

/**
 * Refuses deletion of pending inherited target records across all local authors.
 * A successfully authenticated fence ends this temporary issuance dependency;
 * later journal/snapshot protection remains owned by the shared recovery closure.
 * @param plans - Complete bounded native plans for this object.
 * @param scope - Exact local pruning scope.
 * @param from - First selected ordinal.
 * @param through - Last selected ordinal.
 */
export function assertIssuanceInheritedTargetPruningAllowed(
	plans: readonly SettlementPlan[],
	scope: DurableIssueScope,
	from: number,
	through: number
): void {
	for (const plan of plans) {
		if (plan.fenceSequence !== null) continue;
		if (
			plan.entries.some(
				({ inheritance }) =>
					inheritance !== undefined &&
					inheritance.targetObjectId === scope.objectId &&
					inheritance.targetAuthor === scope.author &&
					inheritance.targetAuthorSequence >= from &&
					inheritance.targetAuthorSequence <= through
			)
		)
			throw issuanceRetirementRefusal("issuance inherited target dependency remains pending");
	}
}
/**
 *
 * @param control - Actual native complete control.
 * @param scope - Original issuance scope.
 * @param from - First inclusive original pruning ordinal.
 * @param through - Last inclusive original pruning ordinal.
 */
export function assertIssuanceRetirementPruningAllowed(
	control: DurableIssuanceRetirementControl | null,
	scope: DurableIssueScope,
	from: number,
	through: number
): void {
	for (const p of [control?.completed, control?.active?.preparation])
		if (
			p?.protectedRecords.some(
				(h) => h.author === scope.author && h.authorSequence >= from && h.authorSequence <= through
			)
		)
			throw issuanceRetirementRefusal("issuance pruning would erase a protected retirement hole");
}
/**
 *
 * @param control - Actual native complete control.
 * @param image - Bounded native image commitment.
 * @param compare - Adapter-owned native CAS and joined readback.
 * @returns The detached owner result or a typed refusal.
 */
export function createIssuanceRetirementControlRead(
	control: DurableIssuanceRetirementControl,
	image: DurableIssuanceRetirementImage,
	compare: (
		next: DurableIssuanceRetirementControl,
		p?: DurableIssuanceRetirementPreparation
	) => Promise<DurableIssuanceRetirementControl>
): DurableIssuanceRetirementControlRead {
	let used = false;
	let pending: Promise<DurableIssuanceRetirementControl> | undefined;
	const attempt = (
		next: DurableIssuanceRetirementControl,
		p?: DurableIssuanceRetirementPreparation
	): Promise<DurableIssuanceRetirementControl> => {
		if (used) return Promise.reject(issuanceRetirementRefusal("issuance retirement view released"));
		used = true;
		pending = Promise.resolve().then(() => compare(next, p));
		return pending;
	};
	const domainDigest = issuanceRetirementHex(
		hashDomain("ts-drp/issuance-retirement-domain/v1", encodeCanonical({ control, image }))
	);
	return Object.freeze({
		control,
		image,
		domainDigest,
		async prepareFence(input: DurableIssuanceRetirementPreparation) {
			const p = captureIssuanceRetirementPreparation(input);
			if (
				control.active ||
				(control.completed && !advanceAllowed(control.completed, p)) ||
				control.sequence === Number.MAX_SAFE_INTEGER
			)
				throw issuanceRetirementRefusal("issuance retirement transition refused");
			return attempt(
				captureIssuanceRetirementControl({
					...advanceIssuanceRetirementControl(control),
					sequence: control.sequence + 1,
					active: { sequence: control.sequence + 1, preparation: p },
				}),
				p
			);
		},
		async abortPrepared() {
			if (!control.active) throw issuanceRetirementRefusal("issuance retirement no prepared checkpoint");
			return attempt(captureIssuanceRetirementControl({ ...advanceIssuanceRetirementControl(control), active: null }));
		},
		async commitPrepared() {
			if (!control.active) throw issuanceRetirementRefusal("issuance retirement no prepared checkpoint");
			return attempt(
				captureIssuanceRetirementControl({
					...advanceIssuanceRetirementControl(control),
					active: null,
					completed: control.active.preparation,
				})
			);
		},
		async release() {
			used = true;
			await pending?.then(
				() => undefined,
				() => undefined
			);
		},
	});
}

type SettlementPruningEntry = Readonly<{
	readonly disposition: SettlementPlan["entries"][number]["disposition"];
	readonly inheritance?: SettlementPlan["entries"][number]["inheritance"];
	readonly replacementSequence: number | null;
	readonly sourceContextDigest?: Uint8Array;
	readonly sourceResolutionDigest?: Uint8Array;
	readonly sourceResolutionKind?: "frontier";
}>;

/**
 * Structural shape of a terminal source whose exact resolution bytes are retained:
 * a signed completion (`committed`) or a signed local-author expiry (`expire`).
 * Authentication belongs to the native census and reopen verifiers, not this test.
 * @param entry - One plan entry.
 * @returns Whether the entry carries a retained terminal resolution.
 */
export function settlementEntryHasAuthenticatedTerminalResolution(entry: SettlementPruningEntry): boolean {
	return (entry.disposition === "committed" || entry.disposition === "expire") && entry.replacementSequence === null &&
		entry.sourceContextDigest !== undefined && entry.sourceResolutionDigest !== undefined;
}

/**
 * Structural shape of signed local-author expiry (abandonment) for one exact source.
 * @param entry - One plan entry.
 * @returns Whether the entry is an `expire` carrying a retained resolution.
 */
export function settlementEntryIsAuthenticatedExpiry(entry: SettlementPruningEntry): boolean {
	return entry.disposition === "expire" && settlementEntryHasAuthenticatedTerminalResolution(entry);
}

function issuanceRowHasAuthenticatedExpiry(rows: IssuanceRetirementRows, row: RetirementIssuedRow): boolean {
	const plan = rows.plans.find(value => value.scope.objectId === row.objectId && value.scope.author === row.author);
	return plan?.entries.some(entry => entry.sourceObjectId === undefined && entry.sourceSequence === row.authorSequence &&
		issuanceRetirementBytesEqual(entry.sourceDigest, row.digest) && settlementEntryIsAuthenticatedExpiry(entry)) === true;
}

/**
 * Signed local-author expiry and publication are mutually exclusive for one source (a frontier
 * resolution excepted).
 * Plan writes pass the scope's outbox rows; publication passes its proposed row.
 * @param plan - The plan that will be (or is) durable for this scope.
 * @param rows - Outbox rows of the same scope, with their resulting publish state.
 */
export function assertSettlementExpiryPublicationExclusive(plan: Pick<SettlementPlan, "entries"> | null | undefined,
	rows: readonly Readonly<{ authorSequence: number; publishState: "pending" | "published" }>[]): void {
	for (const entry of plan?.entries ?? []) {
		// A frontier resolution may follow publication: the creator's signed frontier proved the source
		// committed or never admitted in its closed epoch, where a republication can admit nothing.
		if (entry.sourceObjectId !== undefined || !settlementEntryIsAuthenticatedExpiry(entry) ||
			entry.sourceResolutionKind === "frontier") continue;
		if (rows.some(row => row.authorSequence === entry.sourceSequence && row.publishState === "published"))
			throw issuanceRetirementRefusal("settlement source expiry and publication are exclusive");
	}
}

/**
 * Tests whether one durable settlement plan permits authenticated prefix reclamation.
 * @param plan - The transactionally observed plan, or no durable plan.
 * @returns Whether every source and mandatory fence have retained completion links.
 * A fully removed author has no Writer grant and therefore never issues a FENCE;
 * its plan permits pruning only when every entry is a retained terminal resolution.
 * This is a structural predicate: the shared migration owner must authenticate
 * inherited target references and protect their cross-object dependencies.
 */
export function settlementPlanPermitsAuthenticatedPruning(
	plan: Readonly<{
		readonly entries: readonly SettlementPruningEntry[];
		readonly fenceSequence: number | null;
	}> | null
): boolean {
	return (
		plan !== null &&
		(plan.fenceSequence !== null ||
			(plan.entries.length > 0 && plan.entries.every(settlementEntryHasAuthenticatedTerminalResolution))) &&
		plan.entries.every(
			(entry) =>
				entry.disposition === "expire" || entry.disposition === "committed" ||
				(entry.disposition === "inherited" && entry.inheritance !== undefined && entry.replacementSequence === null) ||
				(entry.disposition !== "manual-review" &&
					entry.disposition !== "inherited" &&
					entry.replacementSequence !== null)
		)
	);
}

/**
 * Compares two lineage CAS values.
 * @param left - First lineage value.
 * @param right - Second lineage value.
 * @returns Whether both lineage fields are equal.
 */
export function durableIssuanceLineagesEqual(left: DurableLineage, right: DurableLineage): boolean {
	return left.exhausted === right.exhausted && left.next === right.next;
}

/**
 * Tests whether a lineage has consumed an ordinal.
 * @param lineage - Observed durable lineage.
 * @param authorSequence - Ordinal to classify.
 * @returns Whether the lineage has consumed the ordinal.
 */
export function durableIssuanceLineageConsumed(lineage: DurableLineage, authorSequence: number): boolean {
	return lineage.next > authorSequence || (lineage.exhausted && lineage.next === authorSequence);
}

/**
 * Tests the explicit inclusive pruning-watermark relation.
 * @param watermark - Inclusive watermark or no pruning state.
 * @param authorSequence - Ordinal to classify.
 * @returns Whether the ordinal is at or below a real watermark.
 */
export function durableIssuanceAddressIsPruned(watermark: number | null, authorSequence: number): boolean {
	return watermark !== null && authorSequence <= watermark;
}

/**
 * Decodes only the closed v3 vertex fields needed by the issuance owner.
 * @param canonicalPreimageBytes - Canonical preimage bytes to decode.
 * @param scope - Expected issuance scope.
 * @param authorSequence - Expected issuance ordinal.
 * @returns The validated epoch or `undefined` for any mismatch.
 */
export function decodeDurableIssuancePreimage(
	canonicalPreimageBytes: Uint8Array,
	scope: DurableIssueScope,
	authorSequence: number
): Readonly<{ readonly epoch: number }> | undefined {
	try {
		const header = durablePreimageHeader(canonicalPreimageBytes);
		if (
			header.kind === "drp-vertex" &&
			header.protocolMajor === 3 &&
			isValidDurableAuthorSequence(header.epoch) &&
			header.authorSequence === authorSequence &&
			header.author === scope.author &&
			header.objectId === scope.objectId
		) {
			return Object.freeze({ epoch: header.epoch });
		}
		return undefined;
	} catch {
		return undefined;
	}
}
