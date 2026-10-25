import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";

import { encodeGenerationRecordV1 } from "./codecs.js";
import { bytesEqual, copyExpectedHead, hasSharedBacking, isStorageObjectId } from "./internal/validation.js";
import { type AheReclamationInput, captureAheReclamationInput } from "./maintenance.js";
import {
	AHE_BOUNDED_READ_LIMITS,
	type ExpectedHead,
	type GenerationId,
	type GenerationRecord,
	type GenerationRef,
	type StorageObjectId,
	type StoreResult,
} from "./types.js";
import { digestBlob, digestClosure } from "./values.js";
import { ExactBytesMemo } from "./internal/exact-bytes-memo.js";

export interface AheGenerationPartition {
	readonly recordDigests: readonly string[];
	readonly identities: readonly Readonly<{ generationId: GenerationId; identityDigest: string }>[];
	readonly protectedIndices: readonly number[];
	readonly retireIndices: readonly number[];
}
/** Exact original reclamation descriptors; only the protocol producer authenticates exclusion. */
export interface AheRetirementGenerationSource {
	readonly reclamation: AheReclamationInput;
	readonly sourceImageDigest: string;
	readonly postImageDigest: string;
	readonly resumeBasisDigest: string;
	readonly generations: AheGenerationPartition;
	readonly postGenerations: AheGenerationPartition;
}
export interface AheRetirementNominee {
	readonly epoch: number;
	readonly generationId: GenerationId;
	readonly baseExpectedHead: ExpectedHead;
	readonly closureDigest: string;
	readonly permittedReferences: readonly GenerationRef[];
	readonly recordDigest: string;
}
export interface AheRetirementFutureMaterial {
	readonly objectId: StorageObjectId;
	readonly epoch: number;
	readonly generationId: GenerationId;
	readonly baseExpectedHead: ExpectedHead;
	readonly closure: readonly GenerationRef[];
	readonly blobs: readonly Readonly<{ ref: GenerationRef; bytes: Uint8Array }>[];
	/** Exact Complete row authenticated by the original receiver; not an existence grant. */
	readonly existingGenerationRecordDigest?: string;
}
export type AheRetirementNativeMutation =
	| Readonly<{
			kind: "stage" | "publish";
			material: AheRetirementFutureMaterial;
	  }>
	| Readonly<{ kind: "reclaim"; source: AheRetirementGenerationSource }>;
type FutureResolver = (
	capability: unknown,
	store: object,
	phase: "stage" | "publish"
) => AheRetirementFutureMaterial | undefined;
let futureResolver: FutureResolver | undefined;

const SNAPSHOT_SCOPES = 4;
const MAX_DOMAINS = 8;
const ALL_ROLES = 255;
export interface AheRetirementScope {
	readonly epoch: number;
	readonly anchor: string;
	readonly manifestDigest: string;
	readonly incarnationDigest: string;
}
/** Closed native-domain commitment only; neither role labels nor bytes grant protocol authority. */
export type AheRetirementDomain = readonly [number, Uint8Array, Uint8Array, number, Uint8Array, Uint8Array, number];
export interface AheRetirementPreparation {
	readonly head: ExpectedHead;
	readonly floorEpoch: number;
	readonly floorAnchor: string;
	readonly decisionDigest: string;
	readonly sourceProofDigest: string;
	readonly generationRecordDigests: readonly string[];
	readonly snapshotScopes: readonly AheRetirementScope[];
	readonly protectedIndices: readonly number[];
	readonly retireIndices: readonly number[];
	readonly domains: readonly AheRetirementDomain[];
	readonly generationSource?: AheRetirementGenerationSource;
}
export interface AheRetirementControl {
	readonly kind: "ahe-retirement-control-2" | "ahe-retirement-control-3";
	readonly objectId: StorageObjectId;
	readonly incarnation: string;
	readonly revision: number;
	readonly sequence: number;
	readonly completed: null | Readonly<{
		throughEpoch: number;
		decisionDigest: string;
		snapshotHoles: readonly AheRetirementScope[];
		generationHoles: readonly string[];
		generationIdentities?: AheGenerationPartition["identities"];
		sourceProofDigest?: string;
		/** Exact bounded participant association survives completion and realm loss. */
		domains?: readonly AheRetirementDomain[];
		generationDrain?: Readonly<{ source: AheRetirementGenerationSource; phase: "pending" | "complete" }>;
	}>;
	readonly active: null | Readonly<{ sequence: number; phase: "prepared"; preparation: AheRetirementPreparation }>;
	readonly binding?: AheGenerationPartition | null;
	readonly nominee?: AheRetirementNominee | null;
}
/** One-use joined native observation/CAS, not persistent exclusion or cross-store deletion authority. */
export interface AheRetirementControlRead {
	readonly control: AheRetirementControl;
	readonly head: ExpectedHead;
	readonly metadataBytes: number;
	/** Same-transaction bounded native image, never semantic deletion authority. */
	readonly imageDigest: string;
	prepare(input: AheRetirementPreparation): Promise<StoreResult<AheRetirementControl>>;
	prepareBound(
		input: Readonly<{ preparation: AheRetirementPreparation; generations: AheGenerationPartition }>
	): Promise<StoreResult<AheRetirementControl>>;
	commitPrepared(
		input: Readonly<{ decisionDigest: string; sourceProofDigest: string }>
	): Promise<StoreResult<AheRetirementControl>>;
	stageNominatedFutureGeneration(capability: unknown): Promise<StoreResult<AheRetirementControl>>;
	publishNominatedFutureGeneration(capability: unknown): Promise<StoreResult<AheRetirementControl>>;
	reclaimBoundedGeneration(): Promise<StoreResult<AheRetirementControl>>;
	abortPrepared(): Promise<StoreResult<AheRetirementControl>>;
	release(): Promise<void>;
}

/**
 * The original bound-control projection is shared by native writes and sizing.
 * @param control - Captured old fields, retained in the preparation.
 * @param sequence - Original next native sequence.
 * @param preparation - Actual preparation or private width-only leaf.
 * @param binding - Actual partition or private width-only leaf.
 * @returns The same complete preparation field projection.
 */
export function boundPreparedFields<P, B>(
	control: Readonly<Record<string, unknown>>,
	sequence: number,
	preparation: P,
	binding: B
): Readonly<Record<string, unknown>> {
	return {
		...control,
		kind: "ahe-retirement-control-3",
		revision: Number(control.revision) + 1,
		sequence,
		active: { sequence, phase: "prepared", preparation },
		binding,
		nominee: null,
	};
}

/**
 * Projects the original completed control without changing native guards.
 * @param control - Prepared fields.
 * @param completed - Full completion payload.
 * @returns Complete control fields.
 */
export function boundCompletedFields<C>(
	control: Readonly<Record<string, unknown>>,
	completed: C
): Readonly<Record<string, unknown>> {
	return {
		...control,
		revision: Number(control.revision) + 1,
		active: null,
		binding: null,
		completed,
	};
}

/**
 * Owns the native completion payload shape for writes and length-only sizing.
 * @param input - Original selected holes/domains and optional full generation source.
 * @returns Full completion payload fields.
 */
export function boundCompletionPayload(
	input: Readonly<{
		floorEpoch: number;
		decisionDigest: unknown;
		sourceProofDigest: unknown;
		snapshotHoles: unknown;
		generationHoles: unknown;
		generationIdentities: unknown;
		domains: unknown;
		generationSource?: unknown;
	}>
): Readonly<Record<string, unknown>> {
	return {
		throughEpoch: input.floorEpoch,
		decisionDigest: input.decisionDigest,
		sourceProofDigest: input.sourceProofDigest,
		snapshotHoles: input.snapshotHoles,
		generationHoles: input.generationHoles,
		generationIdentities: input.generationIdentities,
		domains: input.domains,
		...(input.generationSource === undefined
			? {}
			: {
					generationDrain: { source: input.generationSource, phase: "pending" },
				}),
	};
}

/**
 * Original nominated-future control field projection. Length-only callers may
 * pass opaque leaves; native callers retain their original authenticated
 * nominee capture and CAS guards before and after this pure projection.
 * @param control - Original complete control fields.
 * @param phase - Original stage or publication transition.
 * @param nominated - Original nominee fields, or a private arithmetic tree.
 * @returns Complete next field projection, not a captured native control.
 */
export function nominatedFutureControlFields<N>(
	control: Readonly<Record<string, unknown>>,
	phase: "stage" | "publish",
	nominated: N
): Readonly<Record<string, unknown>> {
	return { ...control, revision: Number(control.revision) + 1, nominee: phase === "stage" ? nominated : null };
}

/**
 * Sizes bound native control encodings without inventing future hashes or grants.
 * Numeric leaves are complete canonical widths supplied by the original proof
 * composer. This is codec arithmetic only: it cannot authenticate a source,
 * classify generations, reserve bytes, or authorize any native transition.
 * @param input - Actual old control and complete prospective nested widths.
 * @returns Whole OLD/PREPARED/COMPLETED and optional reclaimed control widths.
 */
export function readAheBoundRetirementControlWidthsForSizing(
	input: Readonly<{
		control: AheRetirementControl;
		floorEpoch: number;
		preparationByteLength: number;
		generationPartitionByteLength: number;
		snapshotHolesByteLength: number;
		generationHolesByteLength: number;
		generationIdentitiesByteLength: number;
		domainsByteLength: number;
		generationSource?: Readonly<{
			byteLength: number;
			postGenerationHolesByteLength: number;
			postGenerationIdentitiesByteLength: number;
		}>;
	}>
): Readonly<{ old: number; prepared: number; completed: number; reclaimed?: number }> {
	const control = captureAheRetirementControl(input.control);
	if (
		control.active !== null ||
		control.nominee ||
		control.completed?.generationDrain?.phase === "pending" ||
		(control.completed !== null && control.kind !== "ahe-retirement-control-3") ||
		!Number.isSafeInteger(input.floorEpoch) ||
		input.floorEpoch < 0 ||
		(control.completed !== null && input.floorEpoch < control.completed.throughEpoch) ||
		control.sequence === Number.MAX_SAFE_INTEGER ||
		control.revision > Number.MAX_SAFE_INTEGER - (input.generationSource === undefined ? 2 : 3)
	)
		throw new TypeError("AHE_BOUND_CONTROL_SIZING_UNAVAILABLE");
	// These atoms are deliberately outside the canonical domain. They can only
	// carry a length through the shared field projection, never encoded content.
	const atom = Symbol("canonical-width-only");
	const leaf = (byteLength: number): Readonly<{ [atom]: number }> => {
		if (!Number.isSafeInteger(byteLength) || byteLength < 1) throw new TypeError("invalid nested canonical width");
		return Object.freeze({ [atom]: byteLength });
	};
	const add = (parts: readonly number[]): number => {
		const n = parts.reduce((sum, part) => sum + part, 0);
		if (!Number.isSafeInteger(n)) throw new TypeError("canonical width overflow");
		return n;
	};
	const prefix = (count: number): number => {
		let width = 2;
		while (count >= 128) {
			count = Math.floor(count / 128);
			width++;
		}
		return width;
	};
	const width = (value: unknown): number => {
		if (value === null || typeof value !== "object" || value instanceof Uint8Array)
			return encodeCanonical(value, AHE_RETIREMENT_CONTROL_LIMITS).byteLength;
		if (Object.hasOwn(value, atom)) return (value as Readonly<{ [atom]: number }>)[atom];
		if (Array.isArray(value)) return add([prefix(value.length), ...value.map(width)]);
		const entries = Object.entries(value);
		return add([prefix(entries.length), ...entries.flatMap(([key, item]) => [width(key), width(item)])]);
	};
	const sequence = control.sequence + 1;
	const prepared = boundPreparedFields(
		{ ...control },
		sequence,
		leaf(input.preparationByteLength),
		leaf(input.generationPartitionByteLength)
	);
	const hashWidth = leaf(66); // canonical STRING of an unknown 64-byte ASCII digest
	const completedFields = boundCompletionPayload({
		floorEpoch: input.floorEpoch,
		decisionDigest: hashWidth,
		sourceProofDigest: hashWidth,
		snapshotHoles: leaf(input.snapshotHolesByteLength),
		generationHoles: leaf(input.generationHolesByteLength),
		generationIdentities: leaf(input.generationIdentitiesByteLength),
		domains: leaf(input.domainsByteLength),
		...(input.generationSource === undefined ? {} : { generationSource: leaf(input.generationSource.byteLength) }),
	});
	const completed = boundCompletedFields(prepared, completedFields);
	const result = {
		old: encodeAheRetirementControl(control).byteLength,
		prepared: width(prepared),
		completed: width(completed),
	};
	if (input.generationSource === undefined) return Object.freeze(result);
	const reclaimed = boundCompletedFields(completed, {
		...completedFields,
		generationHoles: leaf(input.generationSource.postGenerationHolesByteLength),
		generationIdentities: leaf(input.generationSource.postGenerationIdentitiesByteLength),
		generationDrain: { source: leaf(input.generationSource.byteLength), phase: "complete" },
	});
	return Object.freeze({ ...result, reclaimed: width(reclaimed) });
}

function fields(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object") throw new TypeError("invalid retirement record");
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) throw new TypeError("invalid retirement prototype");
	const actual = Reflect.ownKeys(value);
	if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key)))
		throw new TypeError("invalid retirement fields");
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor?.enumerable !== true || !("value" in descriptor))
			throw new TypeError("invalid retirement descriptor");
		result[key] = descriptor.value;
	}
	return result;
}
function integer(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new TypeError("invalid retirement integer");
	return value;
}
function digest(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new TypeError("invalid retirement digest");
	return value;
}
function list<T>(value: unknown, max: number, capture: (entry: unknown) => T): readonly T[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
		throw new TypeError("invalid retirement list");
	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
	if (
		lengthDescriptor === undefined ||
		!("value" in lengthDescriptor) ||
		lengthDescriptor.enumerable ||
		lengthDescriptor.configurable ||
		!Number.isSafeInteger(lengthDescriptor.value) ||
		lengthDescriptor.value < 0 ||
		lengthDescriptor.value > max
	)
		throw new TypeError("invalid retirement length");
	const length = lengthDescriptor.value as number;
	if (Reflect.ownKeys(value).length !== length + 1) throw new TypeError("invalid retirement array keys");
	const result: T[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, index);
		if (descriptor?.enumerable !== true || !("value" in descriptor)) throw new TypeError("invalid retirement entry");
		result.push(capture(descriptor.value));
	}
	return Object.freeze(result);
}
function unique<T>(entries: readonly T[], key: (entry: T) => string): readonly T[] {
	if (new Set(entries.map(key)).size !== entries.length) throw new TypeError("duplicate retirement identity");
	return entries;
}
function scope(value: unknown): AheRetirementScope {
	const r = fields(value, ["epoch", "anchor", "manifestDigest", "incarnationDigest"]);
	return Object.freeze({
		epoch: integer(r.epoch),
		anchor: digest(r.anchor),
		manifestDigest: digest(r.manifestDigest),
		incarnationDigest: digest(r.incarnationDigest),
	});
}
function scopes(value: unknown): readonly AheRetirementScope[] {
	return unique(list(value, SNAPSHOT_SCOPES, scope), (r) => `${r.epoch}:${r.anchor}:${r.manifestDigest}`);
}
function digests(value: unknown): readonly string[] {
	return unique(list(value, AHE_BOUNDED_READ_LIMITS.maxObjectGenerations, digest), (r) => r);
}

function partition(value: unknown): AheGenerationPartition {
	const r = fields(value, ["recordDigests", "identities", "protectedIndices", "retireIndices"]);
	const records = digests(r.recordDigests);
	const identities = generationIdentities(r.identities);
	if (identities.length !== records.length) throw new TypeError("incomplete generation identities");
	const indices = (v: unknown): readonly number[] =>
		unique(
			list(v, records.length, (entry) => {
				const i = integer(entry);
				if (i >= records.length) throw new TypeError("foreign generation index");
				return i;
			}),
			String
		);
	const protectedIndices = indices(r.protectedIndices),
		retireIndices = indices(r.retireIndices);
	if (
		protectedIndices.some((i) => retireIndices.includes(i)) ||
		protectedIndices.length + retireIndices.length !== records.length
	)
		throw new TypeError("incomplete generation partition");
	return Object.freeze({ recordDigests: records, identities, protectedIndices, retireIndices });
}
function generationIdentities(value: unknown): AheGenerationPartition["identities"] {
	return unique(
		list(value, AHE_BOUNDED_READ_LIMITS.maxObjectGenerations, (entry) => {
			const r = fields(entry, ["generationId", "identityDigest"]);
			return Object.freeze({
				generationId: digest(r.generationId) as GenerationId,
				identityDigest: digest(r.identityDigest),
			});
		}),
		(entry) => entry.generationId
	);
}

/**
 * Strict bounded metadata capture, never a cryptographic eligibility verifier.
 * @param value Detached native metadata.
 * @returns The exact bounded original-owner source descriptor.
 */
export function captureAheRetirementGenerationSource(value: unknown): AheRetirementGenerationSource {
	const r = fields(value, [
			"reclamation",
			"sourceImageDigest",
			"postImageDigest",
			"resumeBasisDigest",
			"generations",
			"postGenerations",
		]),
		reclamation = captureAheReclamationInput(r.reclamation),
		generations = partition(r.generations),
		postGenerations = partition(r.postGenerations),
		selected = generations.retireIndices[0];
	if (
		generations.retireIndices.length !== 1 ||
		selected === undefined ||
		reclamation.lineageFloor.deleteGenerationIds.length !== 1 ||
		reclamation.lineageFloor.deleteGenerationIds[0] !== generations.identities[selected]?.generationId ||
		reclamation.classifiedSourceGenerations?.length !== 1 ||
		postGenerations.retireIndices.length !== 0 ||
		postGenerations.identities.length !== generations.identities.length - 1 ||
		postGenerations.identities.some(
			(row) => !generations.identities.some((old, i) => i !== selected && old.generationId === row.generationId)
		)
	)
		throw new TypeError("invalid bounded generation retirement source");
	const retained = [
		reclamation.activeGenerationId,
		...reclamation.rollbackGenerationIds,
		...(reclamation.sourceGenerationIds ?? []),
		...(reclamation.independentSourceGenerations ?? []).map((row) => row.generationId),
	];
	if (
		retained.length !== generations.identities.length - 1 ||
		retained.some((id) => !generations.identities.some((row, i) => i !== selected && row.generationId === id))
	)
		throw new TypeError("incomplete bounded generation source census");
	return Object.freeze({
		reclamation,
		generations,
		postGenerations,
		sourceImageDigest: digest(r.sourceImageDigest),
		postImageDigest: digest(r.postImageDigest),
		resumeBasisDigest: digest(r.resumeBasisDigest),
	});
}
/**
 * Stable native generation identity; lifecycle changes do not erase protected scope.
 * @param record
 */
export function aheRetirementGenerationIdentity(record: GenerationRecord): string {
	const result = digestBlob(encodeGenerationRecordV1({ ...record, state: "Complete" }));
	if (!result.ok) throw new TypeError("generation identity failed");
	return result.value;
}
function references(value: unknown): readonly GenerationRef[] {
	return unique(
		list(value, AHE_BOUNDED_READ_LIMITS.maxClosureReferences, (entry) => {
			const r = fields(entry, ["digest", "byteLength"]),
				byteLength = integer(r.byteLength);
			if (byteLength === 0 || byteLength > AHE_BOUNDED_READ_LIMITS.maxBlobBytes)
				throw new TypeError("invalid nomination reference");
			return Object.freeze({ digest: digest(r.digest) as GenerationRef["digest"], byteLength });
		}),
		(r) => r.digest
	);
}
function nominee(value: unknown, objectId: StorageObjectId): AheRetirementNominee {
	const r = fields(value, [
		"epoch",
		"generationId",
		"baseExpectedHead",
		"closureDigest",
		"permittedReferences",
		"recordDigest",
	]);
	const baseExpectedHead = copyExpectedHead(r.baseExpectedHead);
	if (!baseExpectedHead || baseExpectedHead.kind !== "present" || baseExpectedHead.objectId !== objectId)
		throw new TypeError("foreign nomination head");
	const permittedReferences = references(r.permittedReferences),
		closure = digestClosure(permittedReferences);
	if (!closure.ok || closure.value !== digest(r.closureDigest)) throw new TypeError("nomination closure differs");
	return Object.freeze({
		epoch: integer(r.epoch),
		generationId: digest(r.generationId) as GenerationId,
		baseExpectedHead,
		closureDigest: digest(r.closureDigest),
		permittedReferences,
		recordDigest: digest(r.recordDigest),
	});
}

/**
 * Exact native completion list, not semantic graph authentication.
 * @param control
 * @param actual
 */
export function aheRetirementGenerationBindingMatches(
	control: AheRetirementControl,
	actual: readonly Readonly<{ generationId: GenerationId; recordDigest: string; identityDigest: string }>[]
): boolean {
	if (control.kind !== "ahe-retirement-control-3") return true;
	if (
		control.binding &&
		(JSON.stringify(control.binding.recordDigests) !== JSON.stringify(actual.map((g) => g.recordDigest)) ||
			JSON.stringify(control.binding.identities) !==
				JSON.stringify(actual.map(({ generationId, identityDigest }) => ({ generationId, identityDigest }))))
	)
		return false;
	return (control.completed?.generationIdentities ?? []).every((h) =>
		actual.some((g) => g.generationId === h.generationId && g.identityDigest === h.identityDigest)
	);
}

/**
 * Exact native transition guard; protocol eligibility is owned by the authenticated producer.
 * @param current Actual prior native control.
 * @param next Proposed atomic control postimage.
 * @param source Original bounded metadata source.
 * @param imageDigest Actual complete native image digest.
 * @param actual Actual addressed generation records.
 * @returns Whether every original native currency and postimage equation holds.
 */
export function aheRetirementReclamationMatches(
	current: AheRetirementControl,
	next: AheRetirementControl,
	source: AheRetirementGenerationSource,
	imageDigest: string,
	actual: readonly Readonly<{ generationId: GenerationId; recordDigest: string; identityDigest: string }>[]
): boolean {
	const completed = current.completed,
		drain = completed?.generationDrain;
	if (
		current.kind !== "ahe-retirement-control-3" ||
		current.active !== null ||
		current.nominee ||
		!completed ||
		!drain ||
		drain.phase !== "pending" ||
		current.revision === Number.MAX_SAFE_INTEGER ||
		imageDigest !== source.sourceImageDigest ||
		!bytesEqual(encodeCanonical(drain.source), encodeCanonical(source)) ||
		JSON.stringify(source.generations.recordDigests) !== JSON.stringify(actual.map((g) => g.recordDigest)) ||
		JSON.stringify(source.generations.identities) !==
			JSON.stringify(actual.map(({ generationId, identityDigest }) => ({ generationId, identityDigest })))
	)
		return false;
	const expected = {
		...current,
		revision: current.revision + 1,
		completed: {
			...completed,
			generationHoles: source.postGenerations.recordDigests,
			generationIdentities: source.postGenerations.identities,
			generationDrain: { source, phase: "complete" },
		},
	};
	return bytesEqual(encodeCanonical(expected), encodeCanonical(next));
}

/**
 * Constructs only the nominated original storage commands; no protocol parser or authority.
 * @param mutation
 */
export function aheRetirementNativeCommands(mutation: AheRetirementNativeMutation): readonly unknown[] {
	if (mutation.kind === "reclaim") throw new TypeError("reclamation uses the original native reclamation owner");
	const m = mutation.material,
		scope = { objectId: m.objectId, generationId: m.generationId };
	if (mutation.kind === "publish") return [{ kind: "swapHead", ...scope, expectedHead: m.baseExpectedHead }];
	return [
		{ kind: "beginGeneration", ...scope, baseExpectedHead: m.baseExpectedHead, closure: m.closure },
		...m.blobs.map((blob) => ({ kind: "putCachedBlob", ...scope, digest: blob.ref.digest, bytes: blob.bytes })),
		...m.closure.map((ref) => ({ kind: "promoteReference", ...scope, digest: ref.digest })),
		{ kind: "completeGeneration", ...scope },
	];
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const nativeBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get as (
	this: Uint8Array
) => ArrayBuffer;
const nativeLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get as (
	this: Uint8Array
) => number;
const nativeOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get as (
	this: Uint8Array
) => number;
function digestBytes(value: unknown): Uint8Array {
	if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Uint8Array.prototype)
		throw new TypeError("invalid native domain bytes");
	const carrier = value as Uint8Array;
	const length = nativeLength.call(carrier),
		buffer = nativeBuffer.call(carrier),
		offset = nativeOffset.call(carrier);
	if (length !== 32 || Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype)
		throw new TypeError("invalid native domain carrier");
	// Any extra own key (an accessor overlay, symbol or name) is refused here.
	// The intrinsic length getter above proved a genuine typed array, whose
	// indices 0..31 are always own enumerable data properties (they cannot be
	// redefined), so no per-index descriptor can fail and none is built.
	const keys = Reflect.ownKeys(carrier);
	if (keys.length !== 32) throw new TypeError("invalid native domain byte fields");
	return new Uint8Array(new Uint8Array(buffer, offset, length));
}
function domains(value: unknown): readonly AheRetirementDomain[] {
	const captured = list(value, MAX_DOMAINS, (entry): AheRetirementDomain => {
		const tuple = list(entry, 7, (item) => item);
		if (tuple.length !== 7) throw new TypeError("invalid native domain tuple");
		const roles = integer(tuple[0]);
		if (roles === 0 || roles > ALL_ROLES) throw new TypeError("invalid native domain roles");
		return Object.freeze([
			roles,
			digestBytes(tuple[1]),
			digestBytes(tuple[2]),
			integer(tuple[3]),
			digestBytes(tuple[4]),
			digestBytes(tuple[5]),
			integer(tuple[6]),
		]);
	});
	let covered = 0,
		previousLeastBit = 0;
	for (const tuple of captured) {
		const roles = tuple[0],
			leastBit = roles & -roles;
		if ((covered & roles) !== 0 || leastBit <= previousLeastBit)
			throw new TypeError("overlapping or unordered native domains");
		covered |= roles;
		previousLeastBit = leastBit;
	}
	if (covered !== ALL_ROLES) throw new TypeError("incomplete native domain partition");
	return captured;
}

/**
 * Captures data descriptors once; copied commitments are not semantic deletion authority.
 * @param value - Closed low-level preparation input.
 * @param objectId - Owning native address.
 * @returns Detached strictly captured preparation.
 */
export function captureAheRetirementPreparation(value: unknown, objectId: StorageObjectId): AheRetirementPreparation {
	const hasGenerationSource = typeof value === "object" && value !== null && Object.hasOwn(value, "generationSource");
	const r = fields(value, [
		"head",
		"floorEpoch",
		"floorAnchor",
		"decisionDigest",
		"sourceProofDigest",
		"generationRecordDigests",
		"snapshotScopes",
		"protectedIndices",
		"retireIndices",
		"domains",
		...(hasGenerationSource ? ["generationSource"] : []),
	]);
	const head = copyExpectedHead(r.head);
	if (head === undefined || head.objectId !== objectId) throw new TypeError("foreign retirement head");
	const snapshots = scopes(r.snapshotScopes);
	const indices = (v: unknown): readonly number[] =>
		unique(
			list(v, SNAPSHOT_SCOPES, (entry) => {
				const index = integer(entry);
				if (index >= snapshots.length) throw new TypeError("foreign retirement scope index");
				return index;
			}),
			String
		);
	const protectedIndices = indices(r.protectedIndices),
		retireIndices = indices(r.retireIndices);
	if (
		protectedIndices.some((i) => retireIndices.includes(i)) ||
		protectedIndices.length + retireIndices.length !== snapshots.length
	)
		throw new TypeError("incomplete retirement scope partition");
	return Object.freeze({
		head: Object.freeze(head),
		floorEpoch: integer(r.floorEpoch),
		floorAnchor: digest(r.floorAnchor),
		decisionDigest: digest(r.decisionDigest),
		sourceProofDigest: digest(r.sourceProofDigest),
		generationRecordDigests: digests(r.generationRecordDigests),
		snapshotScopes: snapshots,
		protectedIndices,
		retireIndices,
		domains: domains(r.domains),
		...(hasGenerationSource ? { generationSource: captureAheRetirementGenerationSource(r.generationSource) } : {}),
	});
}

/**
 * One native control schema: neither a generation envelope nor a wire trust record.
 * @param value - Closed native record.
 * @returns Detached validated record.
 */
export function captureAheRetirementControl(value: unknown): AheRetirementControl {
	const version =
		typeof value === "object" && value !== null ? Object.getOwnPropertyDescriptor(value, "kind")?.value : undefined;
	const modern = version === "ahe-retirement-control-3";
	const r = fields(value, [
		"kind",
		"objectId",
		"incarnation",
		"revision",
		"sequence",
		"completed",
		"active",
		...(modern ? ["binding", "nominee"] : []),
	]);
	if ((!modern && r.kind !== "ahe-retirement-control-2") || !isStorageObjectId(r.objectId))
		throw new TypeError("invalid retirement owner");
	const sequence = integer(r.sequence);
	let completed: AheRetirementControl["completed"] = null;
	if (r.completed !== null) {
		const hasDomains = modern && Object.prototype.hasOwnProperty.call(r.completed, "domains");
		const hasGenerationDrain = modern && Object.prototype.hasOwnProperty.call(r.completed, "generationDrain");
		const c = fields(r.completed, [
			"throughEpoch",
			"decisionDigest",
			"snapshotHoles",
			"generationHoles",
			...(modern ? ["sourceProofDigest", "generationIdentities"] : []),
			...(hasDomains ? ["domains"] : []),
			...(hasGenerationDrain ? ["generationDrain"] : []),
		]);
		const throughEpoch = integer(c.throughEpoch),
			snapshotHoles = scopes(c.snapshotHoles);
		if (snapshotHoles.some((h) => h.epoch > throughEpoch)) throw new TypeError("future retirement hole");
		completed = Object.freeze({
			throughEpoch,
			decisionDigest: digest(c.decisionDigest),
			snapshotHoles,
			generationHoles: digests(c.generationHoles),
			...(modern
				? {
						sourceProofDigest: digest(c.sourceProofDigest),
						generationIdentities: generationIdentities(c.generationIdentities),
						...(hasDomains ? { domains: domains(c.domains) } : {}),
						...(hasGenerationDrain
							? {
									generationDrain: ((): NonNullable<
										NonNullable<AheRetirementControl["completed"]>["generationDrain"]
									> => {
										const d = fields(c.generationDrain, ["source", "phase"]);
										if (d.phase !== "pending" && d.phase !== "complete")
											throw new TypeError("invalid generation drain phase");
										return Object.freeze({ source: captureAheRetirementGenerationSource(d.source), phase: d.phase });
									})(),
								}
							: {}),
					}
				: {}),
		});
		if (modern && completed.generationIdentities?.length !== completed.generationHoles.length)
			throw new TypeError("incomplete protected generation identities");
	}
	let active: AheRetirementControl["active"] = null;
	if (r.active !== null) {
		const a = fields(r.active, ["sequence", "phase", "preparation"]);
		if (a.phase !== "prepared" || integer(a.sequence) !== sequence || sequence === 0)
			throw new TypeError("invalid retirement phase");
		active = Object.freeze({
			phase: "prepared",
			sequence,
			preparation: captureAheRetirementPreparation(a.preparation, r.objectId),
		});
	}
	const binding = modern && r.binding !== null ? partition(r.binding) : null;
	const nominated = modern && r.nominee !== null ? nominee(r.nominee, r.objectId) : null;
	if (
		modern &&
		((active !== null) !== (binding !== null) ||
			(active !== null && nominated !== null) ||
			(nominated !== null && (completed === null || nominated.epoch <= completed.throughEpoch)))
	)
		throw new TypeError("invalid bound retirement phase");
	return Object.freeze({
		kind: modern ? "ahe-retirement-control-3" : "ahe-retirement-control-2",
		objectId: r.objectId,
		incarnation: digest(r.incarnation),
		revision: integer(r.revision),
		sequence,
		completed,
		active,
		...(modern ? { binding, nominee: nominated } : {}),
	});
}

const max = Number.MAX_SAFE_INTEGER,
	hex = "f".repeat(64),
	objectId = ("\u0800".repeat(991) + ":" + "f".repeat(32)) as StorageObjectId;
const maxScopes = Array.from({ length: SNAPSHOT_SCOPES }, (_, index) => ({
	epoch: max,
	anchor: index.toString(16).padStart(64, "f"),
	manifestDigest: hex,
	incarnationDigest: hex,
}));
const maxDigests = Array.from({ length: AHE_BOUNDED_READ_LIMITS.maxObjectGenerations }, (_, index) =>
	index.toString(16).padStart(64, "f")
);
const maximum = {
	kind: "ahe-retirement-control-2",
	objectId,
	incarnation: hex,
	revision: max,
	sequence: max,
	completed: { throughEpoch: max, decisionDigest: hex, snapshotHoles: maxScopes, generationHoles: maxDigests },
	active: {
		sequence: max,
		phase: "prepared",
		preparation: {
			head: { kind: "present", objectId, generationId: hex, closureDigest: hex, revision: max },
			floorEpoch: max,
			floorAnchor: hex,
			decisionDigest: hex,
			sourceProofDigest: hex,
			generationRecordDigests: maxDigests,
			snapshotScopes: maxScopes,
			protectedIndices: Array.from({ length: SNAPSHOT_SCOPES }, (_, index) => index),
			retireIndices: [],
			domains: Array.from({ length: MAX_DOMAINS }, (_, index) => [
				2 ** index,
				new Uint8Array(32).fill(255),
				new Uint8Array(32).fill(255),
				max,
				new Uint8Array(32).fill(255),
				new Uint8Array(32).fill(255),
				max,
			]),
		},
	},
};
function count(value: unknown): number {
	// The canonical reader charges declared collection entries before recursively
	// charging each entry (and each object key). Match that exact native codec law.
	if (value instanceof Uint8Array) return 1;
	if (Array.isArray(value)) return 1 + value.length + value.reduce((sum, entry) => sum + count(entry), 0);
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value);
		return 1 + entries.length * 2 + entries.reduce((sum, [, entry]) => sum + 1 + count(entry), 0);
	}
	return 1;
}
function depth(value: unknown): number {
	if (value instanceof Uint8Array) return 0;
	const entries = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null
			? Object.values(value)
			: [];
	return entries.length === 0 ? 0 : 1 + Math.max(...entries.map(depth));
}
/** Schema-derived ceiling, not an increase to F7/G7/U or recovery admission limits. */
const maximumRecord = captureAheRetirementControl(maximum);
export const AHE_LEGACY_RETIREMENT_CONTROL_MAX_BYTES = encodeCanonical(maximumRecord).byteLength;
const maximumModern = captureAheRetirementControl({
	...maximum,
	kind: "ahe-retirement-control-3",
	binding: {
		recordDigests: maxDigests,
		identities: maxDigests.map((generationId) => ({ generationId, identityDigest: hex })),
		protectedIndices: maxDigests.map((_, i) => i),
		retireIndices: [],
	},
	nominee: null,
	completed: {
		...maximum.completed,
		sourceProofDigest: hex,
		generationIdentities: maxDigests.map((generationId) => ({ generationId, identityDigest: hex })),
		domains: maximum.active.preparation.domains,
	},
});
const maximumReferences = maxDigests.map((d) => ({
	digest: d as GenerationRef["digest"],
	byteLength: AHE_BOUNDED_READ_LIMITS.maxBlobBytes,
}));
const maximumClosure = digestClosure(maximumReferences);
if (!maximumClosure.ok) throw new TypeError("maximum nomination closure invalid");
const maximumNominated = captureAheRetirementControl({
	...maximum,
	kind: "ahe-retirement-control-3",
	active: null,
	binding: null,
	nominee: {
		epoch: max,
		generationId: hex,
		baseExpectedHead: maximum.active.preparation.head,
		closureDigest: maximumClosure.value,
		permittedReferences: maximumReferences,
		recordDigest: hex,
	},
	completed: {
		...maximum.completed,
		throughEpoch: max - 1,
		snapshotHoles: maxScopes.map((s) => ({ ...s, epoch: max - 1 })),
		sourceProofDigest: hex,
		generationIdentities: maxDigests.map((generationId) => ({ generationId, identityDigest: hex })),
		domains: maximum.active.preparation.domains,
	},
});
const maximumGenerationSource = captureAheRetirementGenerationSource({
	reclamation: {
		objectId,
		activeGenerationId: maxDigests[0],
		availabilityPolicyDigest: "53775c5c1ee01e346f588966d6e7acb876df2bd8b2abcbe2b2591f216f7d4d9b",
		closedEpoch: max,
		expectedHead: { ...maximum.active.preparation.head, generationId: maxDigests[0] },
		rollbackGenerationIds: [maxDigests[1], maxDigests[2]],
		lineageFloor: {
			generationId: maxDigests[2],
			expectedBaseExpectedHead: maximum.active.preparation.head,
			replacementBaseExpectedHead: { kind: "none", objectId },
			deleteGenerationIds: [maxDigests[6]],
		},
		independentSourceGenerations: maxDigests.slice(3, 6).map((generationId) => ({
			objectId,
			generationId,
			baseExpectedHead: maximum.active.preparation.head,
			closure: maximumReferences,
			closureDigest: maximumClosure.value,
			state: "Superseded",
		})),
		classifiedSourceGenerations: [
			{
				objectId,
				generationId: maxDigests[6],
				baseExpectedHead: maximum.active.preparation.head,
				closure: maximumReferences,
				closureDigest: maximumClosure.value,
				state: "Superseded",
			},
		],
	},
	sourceImageDigest: hex,
	postImageDigest: hex,
	resumeBasisDigest: hex,
	generations: {
		recordDigests: maxDigests,
		identities: maximumModern.binding?.identities,
		protectedIndices: [0, 1, 2, 3, 4, 5],
		retireIndices: [6],
	},
	postGenerations: {
		recordDigests: maxDigests.slice(0, 6),
		identities: maximumModern.binding?.identities.slice(0, 6),
		protectedIndices: [0, 1, 2, 3, 4, 5],
		retireIndices: [],
	},
});
// Both prior terminal and newly prepared source coexist during the next original intent.
const maximumReclaim = captureAheRetirementControl({
	...maximumModern,
	active: {
		...maximumModern.active,
		preparation: { ...maximumModern.active?.preparation, generationSource: maximumGenerationSource },
	},
	completed: { ...maximumModern.completed, generationDrain: { source: maximumGenerationSource, phase: "complete" } },
});
export const AHE_RETIREMENT_CONTROL_LIMITS = Object.freeze({
	maxBytes: Math.max(
		encodeCanonical(maximumRecord).byteLength,
		encodeCanonical(maximumModern).byteLength,
		encodeCanonical(maximumNominated).byteLength,
		encodeCanonical(maximumReclaim).byteLength
	),
	maxItems: Math.max(count(maximumRecord), count(maximumModern), count(maximumNominated), count(maximumReclaim)),
	maxDepth: Math.max(depth(maximumRecord), depth(maximumModern), depth(maximumNominated), depth(maximumReclaim)),
});

/**
 * Encodes a detached, exact native metadata record charged by the native owner.
 * @param value - Strict native control.
 * @returns Canonical metadata bytes.
 */
export function encodeAheRetirementControl(value: AheRetirementControl): Uint8Array {
	return encodeCanonical(captureAheRetirementControl(value), AHE_RETIREMENT_CONTROL_LIMITS);
}
/**
 * Bounded native metadata decoding refuses unknown fields, versions and noncanonical bytes.
 * @param bytes - Exact addressed native metadata.
 * @returns Validated detached record or classified refusal.
 */
export function decodeAheRetirementControl(bytes: Uint8Array): StoreResult<AheRetirementControl> {
	try {
		if (!(bytes instanceof Uint8Array) || hasSharedBacking(bytes)) return { ok: false, reason: "NON_CANONICAL_RECORD" };
		if (bytes.byteLength > AHE_RETIREMENT_CONTROL_LIMITS.maxBytes) return { ok: false, reason: "READ_BUDGET_EXCEEDED" };
		const own = new Uint8Array(bytes),
			known = verifiedControls.get(own);
		// A hit is the verification of byte-identical input; each caller still
		// receives its own detached capture with fresh byte carriers.
		if (known !== undefined) return { ok: true, value: captureAheRetirementControl(known) };
		const value = captureAheRetirementControl(decodeCanonical(own, AHE_RETIREMENT_CONTROL_LIMITS));
		if (!bytesEqual(own, encodeAheRetirementControl(value))) return { ok: false, reason: "NON_CANONICAL_RECORD" };
		verifiedControls.set(own, captureAheRetirementControl(value));
		return { ok: true, value };
	} catch {
		return { ok: false, reason: "NON_CANONICAL_RECORD" };
	}
}
// Verify-once decode + canonical re-encode, keyed by exact control bytes.
const verifiedControls = new ExactBytesMemo<AheRetirementControl>(64, 2 * 1024 * 1024, AHE_RETIREMENT_CONTROL_LIMITS.maxBytes);

/**
 * Builds a one-use observation under the native store's captured CAS, without a second registry.
 * Native consumers must compare both exact metadata and genuine head in the same transaction.
 * @param control - Already validated native metadata.
 * @param head - Genuine same-transaction native head.
 * @param imageDigest - Same-transaction validated bounded native image commitment.
 * @param compare - Captured native CAS function.
 * @param nativeOwner
 * @param controlBytes - Optional exact canonical bytes of `control` already held by the native owner
 * (the verified row it was decoded from, or its own encoding); only its length is used.
 * @returns Original-instance one-use observation.
 */
export function createAheRetirementControlRead(
	control: AheRetirementControl,
	head: ExpectedHead,
	imageDigest: string,
	compare: (
		next: AheRetirementControl,
		mutation?: AheRetirementNativeMutation
	) => Promise<StoreResult<AheRetirementControl>>,
	nativeOwner?: object,
	controlBytes?: Uint8Array
): AheRetirementControlRead {
	let used = false,
		released = false;
	const ownControl = captureAheRetirementControl(control),
		ownHead = copyExpectedHead(head);
	const ownImageDigest = digest(imageDigest);
	// ownHead is a private frozen flat copy: encode it at most once and compare
	// each proposed head's canonical bytes against that held encoding.
	let ownHeadBytes: Uint8Array | undefined;
	const sameOwnHead = (other: unknown): boolean =>
		bytesEqual(encodeCanonical(other), (ownHeadBytes ??= encodeCanonical(ownHead)));
	const future = (phase: "stage" | "publish", capability: unknown): Promise<StoreResult<AheRetirementControl>> => {
		if (released || used) return Promise.resolve({ ok: false, reason: "READ_RELEASED" });
		used = true;
		try {
			if (
				ownControl.kind !== "ahe-retirement-control-3" ||
				ownControl.active !== null ||
				ownControl.completed === null ||
				ownControl.completed.generationDrain?.phase === "pending" ||
				!nativeOwner
			)
				return Promise.resolve({ ok: false, reason: "RETIREMENT_FENCED" });
			if (ownControl.revision === Number.MAX_SAFE_INTEGER)
				return Promise.resolve({ ok: false, reason: "REVISION_EXHAUSTED" });
			const original = futureResolver?.(capability, nativeOwner, phase);
			if (!original) return Promise.resolve({ ok: false, reason: "INVALID_ARGUMENT" });
			const baseExpectedHead = copyExpectedHead(original.baseExpectedHead),
				closure = references(original.closure);
			if (
				original.objectId !== ownControl.objectId ||
				!baseExpectedHead ||
				baseExpectedHead.kind !== "present" ||
				!sameOwnHead(baseExpectedHead) ||
				integer(original.epoch) <= ownControl.completed.throughEpoch
			)
				return Promise.resolve({ ok: false, reason: "READ_STALE_HEAD" });
			const generationId = digest(original.generationId) as GenerationId;
			let total = 0;
			const blobs = unique(
				list(original.blobs, AHE_BOUNDED_READ_LIMITS.maxClosureReferences, (entry) => {
					const r = fields(entry, ["ref", "bytes"]),
						ref = references([r.ref])[0];
					if (ref === undefined) throw new TypeError("missing candidate reference");
					if (
						!(r.bytes instanceof Uint8Array) ||
						hasSharedBacking(r.bytes) ||
						r.bytes.byteLength !== ref.byteLength ||
						!closure.some((c) => c.digest === ref.digest && c.byteLength === ref.byteLength)
					)
						throw new TypeError("foreign candidate bytes");
					total += r.bytes.byteLength;
					if (total > AHE_BOUNDED_READ_LIMITS.maxUnionBytes) throw new TypeError("candidate byte budget exceeded");
					const bytes = new Uint8Array(r.bytes),
						actual = digestBlob(bytes);
					if (!actual.ok || actual.value !== ref.digest) throw new TypeError("candidate digest differs");
					return { ref, bytes };
				}),
				(r) => r.ref.digest
			);
			const closureHash = digestClosure(closure);
			if (!closureHash.ok) throw new TypeError("candidate closure invalid");
			const record: GenerationRecord = {
				objectId: ownControl.objectId,
				generationId,
				baseExpectedHead,
				closure,
				closureDigest: closureHash.value,
				state: "Complete",
			};
			const recordHash = digestBlob(encodeGenerationRecordV1(record));
			if (!recordHash.ok) throw new TypeError("candidate record invalid");
			const existingGenerationRecordDigest = original.existingGenerationRecordDigest === undefined ? undefined :
				digest(original.existingGenerationRecordDigest);
			if (existingGenerationRecordDigest !== undefined &&
				(existingGenerationRecordDigest !== recordHash.value || blobs.length !== 0))
				return Promise.resolve({ok: false, reason: "INVALID_ARGUMENT"});
			const nominated = nominee(
				{
					epoch: original.epoch,
					generationId,
					baseExpectedHead,
					closureDigest: closureHash.value,
					permittedReferences: closure,
					recordDigest: recordHash.value,
				},
				ownControl.objectId
			);
			if (
				(phase === "stage" &&
					ownControl.nominee !== null &&
					!bytesEqual(encodeCanonical(ownControl.nominee), encodeCanonical(nominated))) ||
				(phase === "publish" &&
					(!ownControl.nominee || !bytesEqual(encodeCanonical(ownControl.nominee), encodeCanonical(nominated))))
			)
				return Promise.resolve({ ok: false, reason: "ILLEGAL_TRANSITION" });
			const next = captureAheRetirementControl(nominatedFutureControlFields({ ...ownControl }, phase, nominated));
			return compare(next, {
				kind: phase,
				material: {
					objectId: ownControl.objectId,
					epoch: original.epoch,
					generationId,
					baseExpectedHead,
					closure,
					blobs,
					...(existingGenerationRecordDigest === undefined ? {} : {existingGenerationRecordDigest}),
				},
			});
		} catch {
			return Promise.resolve({ ok: false, reason: "INVALID_ARGUMENT" });
		}
	};
	if (ownHead === undefined || ownHead.objectId !== ownControl.objectId)
		throw new TypeError("foreign retirement observation");
	const view: AheRetirementControlRead = Object.freeze({
		// Public typed byte carriers cannot be frozen; never expose private CAS input.
		control: captureAheRetirementControl(ownControl),
		head: Object.freeze(ownHead),
		metadataBytes: controlBytes?.byteLength ?? encodeAheRetirementControl(ownControl).byteLength,
		imageDigest: ownImageDigest,
		prepare: function (
			this: AheRetirementControlRead,
			input: AheRetirementPreparation
		): Promise<StoreResult<AheRetirementControl>> {
			if (this !== view) return Promise.resolve({ ok: false, reason: "INVALID_ARGUMENT" });
			if (released || used) return Promise.resolve({ ok: false, reason: "READ_RELEASED" });
			let next: AheRetirementControl;
			try {
				const preparation = captureAheRetirementPreparation(input, ownControl.objectId);
				if (!sameOwnHead(preparation.head))
					return Promise.resolve({ ok: false, reason: "READ_STALE_HEAD" });
				if (ownControl.active !== null || ownControl.completed !== null)
					return Promise.resolve({ ok: false, reason: "RETIREMENT_FENCED" });
				if (ownControl.revision === Number.MAX_SAFE_INTEGER || ownControl.sequence === Number.MAX_SAFE_INTEGER)
					return Promise.resolve({ ok: false, reason: "REVISION_EXHAUSTED" });
				used = true;
				const sequence = ownControl.sequence + 1;
				next = captureAheRetirementControl({
					...ownControl,
					revision: ownControl.revision + 1,
					sequence,
					active: { sequence, phase: "prepared", preparation },
				});
			} catch {
				return Promise.resolve({ ok: false, reason: "INVALID_ARGUMENT" });
			}
			return compare(next);
		},
		prepareBound: function (
			this: AheRetirementControlRead,
			input: Readonly<{ preparation: AheRetirementPreparation; generations: AheGenerationPartition }>
		): Promise<StoreResult<AheRetirementControl>> {
			if (this !== view) return Promise.resolve({ ok: false, reason: "INVALID_ARGUMENT" });
			if (released || used) return Promise.resolve({ ok: false, reason: "READ_RELEASED" });
			used = true;
			try {
				const r = fields(input, ["preparation", "generations"]),
					preparation = captureAheRetirementPreparation(r.preparation, ownControl.objectId),
					binding = partition(r.generations);
				if (
					ownControl.active !== null ||
					ownControl.nominee ||
					ownControl.completed?.generationDrain?.phase === "pending" ||
					(ownControl.completed !== null && ownControl.kind !== "ahe-retirement-control-3")
				)
					return Promise.resolve({ ok: false, reason: "RETIREMENT_FENCED" });
				if (!sameOwnHead(preparation.head))
					return Promise.resolve({ ok: false, reason: "READ_STALE_HEAD" });
				const completed = ownControl.completed;
				if (
					preparation.generationSource &&
					(preparation.generationSource.sourceImageDigest !== ownImageDigest ||
						!bytesEqual(encodeCanonical(preparation.generationSource.generations), encodeCanonical(binding)) ||
						!sameOwnHead(preparation.generationSource.reclamation.expectedHead) ||
						preparation.generationSource.reclamation.closedEpoch !== preparation.floorEpoch)
				)
					return Promise.resolve({ ok: false, reason: "READ_STALE_HEAD" });
				if (
					completed &&
					(preparation.floorEpoch < completed.throughEpoch ||
						preparation.snapshotScopes
							.filter((s, i) => preparation.protectedIndices.includes(i) && s.epoch <= completed.throughEpoch)
							.some((s) => !completed.snapshotHoles.some((h) => bytesEqual(encodeCanonical(h), encodeCanonical(s)))))
				)
					return Promise.resolve({ ok: false, reason: "RETIREMENT_FENCED" });
				if (ownControl.revision === Number.MAX_SAFE_INTEGER || ownControl.sequence === Number.MAX_SAFE_INTEGER)
					return Promise.resolve({ ok: false, reason: "REVISION_EXHAUSTED" });
				const sequence = ownControl.sequence + 1;
				return compare(
					captureAheRetirementControl(boundPreparedFields({ ...ownControl }, sequence, preparation, binding))
				);
			} catch {
				return Promise.resolve({ ok: false, reason: "INVALID_ARGUMENT" });
			}
		},
		commitPrepared: function (
			this: AheRetirementControlRead,
			input: Readonly<{ decisionDigest: string; sourceProofDigest: string }>
		): Promise<StoreResult<AheRetirementControl>> {
			if (this !== view) return Promise.resolve({ ok: false, reason: "INVALID_ARGUMENT" });
			if (released || used) return Promise.resolve({ ok: false, reason: "READ_RELEASED" });
			used = true;
			try {
				const r = fields(input, ["decisionDigest", "sourceProofDigest"]),
					p = ownControl.active?.preparation,
					b = ownControl.binding;
				if (ownControl.kind !== "ahe-retirement-control-3" || !p || !b)
					return Promise.resolve({ ok: false, reason: "RETIREMENT_FENCED" });
				if (digest(r.decisionDigest) !== p.decisionDigest || digest(r.sourceProofDigest) !== p.sourceProofDigest)
					return Promise.resolve({ ok: false, reason: "ILLEGAL_TRANSITION" });
				if (ownControl.revision === Number.MAX_SAFE_INTEGER)
					return Promise.resolve({ ok: false, reason: "REVISION_EXHAUSTED" });
				return compare(
					captureAheRetirementControl(
						boundCompletedFields(
							{ ...ownControl },
							boundCompletionPayload({
								floorEpoch: p.floorEpoch,
								decisionDigest: p.decisionDigest,
								sourceProofDigest: p.sourceProofDigest,
								snapshotHoles: p.snapshotScopes.filter((_, i) => p.protectedIndices.includes(i)),
								generationHoles: b.recordDigests.filter((_, i) => b.protectedIndices.includes(i)),
								generationIdentities: b.identities.filter((_, i) => b.protectedIndices.includes(i)),
								domains: p.domains,
								...(p.generationSource ? { generationSource: p.generationSource } : {}),
							})
						)
					)
				);
			} catch {
				return Promise.resolve({ ok: false, reason: "INVALID_ARGUMENT" });
			}
		},
		stageNominatedFutureGeneration: function (
			this: AheRetirementControlRead,
			capability: unknown
		): Promise<StoreResult<AheRetirementControl>> {
			return this === view ? future("stage", capability) : Promise.resolve({ ok: false, reason: "INVALID_ARGUMENT" });
		},
		publishNominatedFutureGeneration: function (
			this: AheRetirementControlRead,
			capability: unknown
		): Promise<StoreResult<AheRetirementControl>> {
			return this === view ? future("publish", capability) : Promise.resolve({ ok: false, reason: "INVALID_ARGUMENT" });
		},
		reclaimBoundedGeneration: function (this: AheRetirementControlRead): Promise<StoreResult<AheRetirementControl>> {
			if (this !== view) return Promise.resolve({ ok: false, reason: "INVALID_ARGUMENT" });
			if (released || used) return Promise.resolve({ ok: false, reason: "READ_RELEASED" });
			used = true;
			const completed = ownControl.completed,
				drain = completed?.generationDrain;
			if (
				ownControl.kind !== "ahe-retirement-control-3" ||
				ownControl.active !== null ||
				ownControl.nominee ||
				!completed ||
				!drain ||
				drain.phase !== "pending"
			)
				return Promise.resolve({ ok: false, reason: "RETIREMENT_FENCED" });
			if (ownControl.revision === Number.MAX_SAFE_INTEGER)
				return Promise.resolve({ ok: false, reason: "REVISION_EXHAUSTED" });
			if (
				ownImageDigest !== drain.source.sourceImageDigest ||
				!sameOwnHead(drain.source.reclamation.expectedHead)
			)
				return Promise.resolve({ ok: false, reason: "READ_STALE_ROLE_VIEW" });
			const next = captureAheRetirementControl({
				...ownControl,
				revision: ownControl.revision + 1,
				completed: {
					...completed,
					generationHoles: drain.source.postGenerations.recordDigests,
					generationIdentities: drain.source.postGenerations.identities,
					generationDrain: { source: drain.source, phase: "complete" },
				},
			});
			return compare(next, { kind: "reclaim", source: drain.source });
		},
		abortPrepared: function (this: AheRetirementControlRead): Promise<StoreResult<AheRetirementControl>> {
			if (this !== view) return Promise.resolve({ ok: false, reason: "INVALID_ARGUMENT" });
			if (released || used) return Promise.resolve({ ok: false, reason: "READ_RELEASED" });
			if (
				ownControl.active === null ||
				(ownControl.completed !== null && ownControl.kind !== "ahe-retirement-control-3")
			)
				return Promise.resolve({ ok: false, reason: "ILLEGAL_TRANSITION" });
			if (ownControl.revision === Number.MAX_SAFE_INTEGER)
				return Promise.resolve({ ok: false, reason: "REVISION_EXHAUSTED" });
			used = true;
			return compare(
				captureAheRetirementControl({
					...ownControl,
					revision: ownControl.revision + 1,
					active: null,
					...(ownControl.kind === "ahe-retirement-control-3" ? { binding: null } : {}),
				})
			);
		},
		release: () => {
			released = true;
			return Promise.resolve();
		},
	});
	return view;
}

Object.defineProperty(createAheRetirementControlRead, "installCreatorFutureGenerationResolver", {
	value: (resolver: FutureResolver): boolean => {
		if (futureResolver !== undefined || typeof resolver !== "function") return false;
		futureResolver = resolver;
		return true;
	},
});
