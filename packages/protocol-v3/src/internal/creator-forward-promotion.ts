/** Shared closed promotion shape and intrinsic carrier capture; none of these facts grant authority. */
const digest = /^[0-9a-f]{64}$/u;
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const tagGetter = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const lengthGetter = Object.getOwnPropertyDescriptor(typed, "byteLength")!.get!;
const offsetGetter = Object.getOwnPropertyDescriptor(typed, "byteOffset")!.get!;
const bufferGetter = Object.getOwnPropertyDescriptor(typed, "buffer")!.get!;
const bufferLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
const set = Uint8Array.prototype.set;

export function capturePromotionRecord(
	value: unknown,
	fields: readonly string[]
): Readonly<Record<string, unknown>> | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key)))
		return undefined;
	const result: Record<string, unknown> = Object.create(null);
	for (const field of fields) {
		const descriptor = Object.getOwnPropertyDescriptor(value, field);
		if (descriptor?.enumerable !== true || !("value" in descriptor)) return undefined;
		result[field] = descriptor.value;
	}
	return Object.freeze(result);
}

export function capturePromotionArray(value: unknown, maximum: number): readonly unknown[] | undefined {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
	const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (!Number.isSafeInteger(length) || length < 0 || length > maximum || Reflect.ownKeys(value).length !== length + 1)
		return undefined;
	const result: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (descriptor?.enumerable !== true || !("value" in descriptor)) return undefined;
		result.push(descriptor.value);
	}
	return Object.freeze(result);
}

export function promotionByteLength(value: unknown, maximum: number): number | undefined {
	try {
		if (
			Object.getPrototypeOf(value) !== Uint8Array.prototype ||
			Reflect.apply(tagGetter, value, []) !== "Uint8Array"
		)
			return undefined;
		const length = Reflect.apply(lengthGetter, value, []) as number;
		const offset = Reflect.apply(offsetGetter, value, []) as number;
		const buffer = Reflect.apply(bufferGetter, value, []);
		if (Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) return undefined;
		if (
			Reflect.apply(bufferLengthGetter, buffer, []) !== length ||
			offset !== 0 ||
			length < 1 ||
			length > maximum ||
			(resizableGetter !== undefined && Reflect.apply(resizableGetter, buffer, []))
		)
			return undefined;
		return length;
	} catch {
		return undefined;
	}
}

export function capturePromotionBytes(
	value: unknown,
	maximum: number,
	charge?: (bytes: Uint8Array) => boolean
): Uint8Array | undefined {
	const length = promotionByteLength(value, maximum);
	if (length === undefined) return undefined;
	const result = new Uint8Array(length);
	Reflect.apply(set, result, [value]);
	// Consumers/accounting see detached intrinsic bytes, never caller shadows or mutable backing.
	return charge === undefined || charge(result) ? result : undefined;
}

export interface PromotionRef {
	readonly digest: string;
	readonly byteLength: number;
}
export type PromotionControlRef = readonly [string, PromotionRef];
export interface PromotionSource {
	readonly closedEpoch: number;
	readonly closedAnchorDigest: string;
	readonly successorEpoch: number;
	readonly successorAnchorDigest: string;
	readonly cutValueDigest: string;
	readonly cutRef: PromotionRef;
	readonly commitQcRef: PromotionRef;
	readonly manifestRef: PromotionRef;
	readonly payloadDigest: string;
	readonly stateDigest: string;
	readonly closedAclDigest: string;
	readonly snapshotAclDigest: string;
	readonly checkpointRepresentation: "settlement" | "aggregate-retirement" | "retirement-only";
	readonly checkpointRefs: readonly PromotionControlRef[];
}
export interface ForwardPromotion {
	readonly kind: "forward-historical-promotion";
	readonly version: 1;
	readonly genesisAnchorDigest: string;
	readonly source: PromotionSource;
	readonly roles: Readonly<{
		selectedSourceCutDigest: string;
		retainedSources: readonly PromotionSource[];
		currentControlRefs: readonly PromotionControlRef[];
		frontiers: readonly (readonly (string | number | null)[])[] | null;
	}>;
	readonly authorizedSuccessorAclDigest: string;
}
const retirementKind = "drp-creator-issuance-retirement-state";
const aggregateKind = "drp-creator-author-issuance-frontiers-state";
const settlementKind = "drp-creator-author-settlement-state";

function integer(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function capturePromotionRef(value: unknown, maximum = 65_536): PromotionRef | undefined {
	const ref = capturePromotionRecord(value, ["digest", "byteLength"]);
	return ref !== undefined &&
		typeof ref.digest === "string" &&
		digest.test(ref.digest) &&
		integer(ref.byteLength) &&
		ref.byteLength > 0 &&
		ref.byteLength <= maximum
		? Object.freeze({ digest: ref.digest, byteLength: ref.byteLength })
		: undefined;
}
function controls(value: unknown, representation?: string): readonly PromotionControlRef[] | undefined {
	const entries = capturePromotionArray(value, 2);
	if (entries === undefined) return undefined;
	const result: PromotionControlRef[] = [];
	for (const entry of entries) {
		const tuple = capturePromotionArray(entry, 2),
			ref = tuple === undefined ? undefined : capturePromotionRef(tuple[1]);
		if (tuple?.length !== 2 || typeof tuple[0] !== "string" || ref === undefined) return undefined;
		result.push(Object.freeze([tuple[0], ref]));
	}
	const kinds = result.map(([kind]) => kind).join(",");
	const expected =
		representation === "settlement"
			? settlementKind
			: representation === "retirement-only"
				? retirementKind
				: `${retirementKind},${aggregateKind}`;
	if (
		representation === undefined
			? ![settlementKind, retirementKind, `${retirementKind},${aggregateKind}`].includes(kinds)
			: kinds !== expected
	)
		return undefined;
	return Object.freeze(result);
}
function source(value: unknown): PromotionSource | undefined {
	const s = capturePromotionRecord(value, [
		"closedEpoch",
		"closedAnchorDigest",
		"successorEpoch",
		"successorAnchorDigest",
		"cutValueDigest",
		"cutRef",
		"commitQcRef",
		"manifestRef",
		"payloadDigest",
		"stateDigest",
		"closedAclDigest",
		"snapshotAclDigest",
		"checkpointRepresentation",
		"checkpointRefs",
	]);
	if (
		s === undefined ||
		!integer(s.closedEpoch) ||
		!integer(s.successorEpoch) ||
		s.successorEpoch !== s.closedEpoch + 1 ||
		typeof s.checkpointRepresentation !== "string" ||
		!["settlement", "aggregate-retirement", "retirement-only"].includes(s.checkpointRepresentation)
	)
		return undefined;
	for (const key of [
		"closedAnchorDigest",
		"successorAnchorDigest",
		"cutValueDigest",
		"payloadDigest",
		"stateDigest",
		"closedAclDigest",
		"snapshotAclDigest",
	])
		if (typeof s[key] !== "string" || !digest.test(s[key] as string)) return undefined;
	const cutRef = capturePromotionRef(s.cutRef),
		commitQcRef = capturePromotionRef(s.commitQcRef),
		manifestRef = capturePromotionRef(s.manifestRef, 212_387);
	const checkpointRefs = controls(s.checkpointRefs, s.checkpointRepresentation);
	return cutRef === undefined || commitQcRef === undefined || manifestRef === undefined || checkpointRefs === undefined
		? undefined
		: (Object.freeze({ ...s, cutRef, commitQcRef, manifestRef, checkpointRefs }) as unknown as PromotionSource);
}
export function captureForwardPromotion(value: unknown): ForwardPromotion | undefined {
	const p = capturePromotionRecord(value, [
		"kind",
		"version",
		"genesisAnchorDigest",
		"source",
		"roles",
		"authorizedSuccessorAclDigest",
	]);
	if (
		p?.kind !== "forward-historical-promotion" ||
		p.version !== 1 ||
		typeof p.genesisAnchorDigest !== "string" ||
		!digest.test(p.genesisAnchorDigest) ||
		typeof p.authorizedSuccessorAclDigest !== "string" ||
		!digest.test(p.authorizedSuccessorAclDigest)
	)
		return undefined;
	const selected = source(p.source),
		roles = capturePromotionRecord(p.roles, [
			"selectedSourceCutDigest",
			"retainedSources",
			"currentControlRefs",
			"frontiers",
		]);
	const retained = capturePromotionArray(roles?.retainedSources, 1),
		currentControlRefs = controls(roles?.currentControlRefs);
	if (
		selected === undefined ||
		roles === undefined ||
		roles.selectedSourceCutDigest !== selected.cutValueDigest ||
		retained === undefined ||
		currentControlRefs === undefined
	)
		return undefined;
	const retainedSources = retained.map(source);
	if (retainedSources.some((s) => s === undefined || s.cutValueDigest === selected.cutValueDigest)) return undefined;
	let frontiers: ForwardPromotion["roles"]["frontiers"] = null;
	if (roles.frontiers !== null) {
		const settlement = currentControlRefs[0]?.[0] === settlementKind;
		const vector = capturePromotionArray(roles.frontiers, settlement ? 256 : 64);
		if (vector === undefined) return undefined;
		const output: (readonly (string | number | null)[])[] = [];
		let previous = "";
		for (const entry of vector) {
			const tuple = capturePromotionArray(entry, settlement ? 3 : 2);
			if (
				tuple?.length !== (settlement ? 3 : 2) ||
				typeof tuple[0] !== "string" ||
				!digest.test(tuple[0]) ||
				tuple[0] <= previous ||
				(settlement && !integer(tuple[1])) ||
				(tuple.at(-1) !== null && !integer(tuple.at(-1)))
			)
				return undefined;
			previous = tuple[0];
			output.push(tuple as readonly (string | number | null)[]);
		}
		frontiers = Object.freeze(output);
	}
	return Object.freeze({
		...p,
		source: selected,
		roles: Object.freeze({
			selectedSourceCutDigest: selected.cutValueDigest,
			retainedSources: Object.freeze(retainedSources as PromotionSource[]),
			currentControlRefs,
			frontiers,
		}),
	}) as ForwardPromotion;
}

/** The one ordinary/promotion successor state equation. Callers validate the whole Cut first. */
export function creatorCutEffectiveState(cut: Readonly<Record<string, unknown>>): unknown {
	return Object.hasOwn(cut, "forwardPromotion")
		? captureForwardPromotion(cut.forwardPromotion)?.source.stateDigest
		: cut.stateDigest;
}
