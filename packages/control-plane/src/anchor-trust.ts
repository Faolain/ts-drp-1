import {
	type CurrentAnchorTrust,
	installCreatorAnchorTrustRoot,
	type InstallCreatorAnchorTrustRootInput,
	type InstallCreatorAnchorTrustRootResult,
	isAnchorTrustStateRecordBytes,
	openCurrentAnchorTrust,
	type OpenCurrentAnchorTrustResult,
} from "@ts-drp/protocol-v3";
import {
	type AheDurableStore,
	type BlobDigest,
	digestBlob,
	type ExpectedHead,
	type GenerationId,
	type GenerationRef,
	parseGenerationId,
	type PresentHead,
	type StorageObjectId,
} from "@ts-drp/storage";

const DIGEST_HEX = /^[0-9a-f]{64}$/u;
const MAX_SCANNABLE_BYTES = 8192;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BUFFER_GETTER = Reflect.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Reflect.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;

export type TrustClosureRejection =
	| "malformed-input"
	| "closure-invalid"
	| "candidate-invalid"
	| "candidate-not-in-closure"
	| "candidate-duplicate"
	| "candidate-not-scannable"
	| "candidate-missing"
	| "candidate-length-mismatch"
	| "candidate-digest-mismatch"
	| "trust-state-missing"
	| "trust-state-ambiguous";

export type DetachedClosureCandidate = Readonly<{
	bytes: Uint8Array;
	ref: GenerationRef;
}>;

export type InspectTrustClosureInput = Readonly<{
	candidates: readonly DetachedClosureCandidate[];
	closure: readonly GenerationRef[];
}>;

export type InspectTrustClosureResult =
	| Readonly<{ ok: false; reason: TrustClosureRejection }>
	| Readonly<{
			exactCanonicalTrustStateRecordBytes: Uint8Array;
			ok: true;
			trustRef: GenerationRef;
	  }>;

export type AssertTrustPreservedInput = Readonly<{
	candidates: readonly DetachedClosureCandidate[];
	closure: readonly GenerationRef[];
	expectedTrustRef: GenerationRef;
}>;

export type AssertTrustPreservedResult =
	| Readonly<{ ok: false; reason: TrustClosureRejection | "trust-ref-not-preserved" }>
	| Readonly<{
			exactCanonicalTrustStateRecordBytes: Uint8Array;
			ok: true;
			trustRef: GenerationRef;
	  }>;

export type InstallCreatorAnchorTrustRootFailureReason = Extract<
	InstallCreatorAnchorTrustRootResult,
	{ readonly ok: false }
>["reason"];

export type OpenCurrentAnchorTrustFailureReason = Extract<
	OpenCurrentAnchorTrustResult,
	{ readonly ok: false }
>["reason"];

export type InstallCurrentAnchorTrustResult =
	| Readonly<{ head: PresentHead; ok: true; trust: CurrentAnchorTrust; trustRef: GenerationRef }>
	| Readonly<{ ok: false; reason: "already-installed" | "store-failed" | "trust-state-conflict" }>
	| Readonly<{
			cause: InstallCreatorAnchorTrustRootFailureReason;
			ok: false;
			reason: "genesis-rejected";
	  }>
	| Readonly<{ cause: TrustClosureRejection; ok: false; reason: "closure-rejected" }>
	| Readonly<{ cause: OpenCurrentAnchorTrustFailureReason; ok: false; reason: "trust-rejected" }>;

export type OpenDurableCurrentAnchorTrustResult =
	| Readonly<{ head: PresentHead; ok: true; trust: CurrentAnchorTrust; trustRef: GenerationRef }>
	| Readonly<{ ok: false; reason: "not-installed" | "store-failed" | "trust-state-unreadable" }>
	| Readonly<{ cause: TrustClosureRejection; ok: false; reason: "closure-rejected" }>
	| Readonly<{ cause: OpenCurrentAnchorTrustFailureReason; ok: false; reason: "trust-rejected" }>;

export type CurrentAnchorTrustStoreOptions = Readonly<{
	objectId: StorageObjectId;
	pinnedGenesisAnchorDigest: string;
	store: AheDurableStore;
}>;

export type CurrentAnchorTrustStore = Readonly<{
	install(input: InstallCreatorAnchorTrustRootInput): Promise<InstallCurrentAnchorTrustResult>;
	open(): Promise<OpenDurableCurrentAnchorTrustResult>;
}>;

type CopiedCandidate = Readonly<{ bytes: Uint8Array; ref: GenerationRef }>;

type OpenedStoredTrust = Readonly<{
	bytes: Uint8Array;
	head: PresentHead;
	trust: CurrentAnchorTrust;
	trustRef: GenerationRef;
}>;

type OpenedStoredTrustResult =
	| Readonly<{ ok: true; value: OpenedStoredTrust }>
	| Readonly<{ ok: false; reason: "trust-state-unreadable" }>
	| Readonly<{ cause: TrustClosureRejection; ok: false; reason: "closure-rejected" }>
	| Readonly<{ cause: OpenCurrentAnchorTrustFailureReason; ok: false; reason: "trust-rejected" }>;

type StoreResultSnapshot = Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; reason: string }>;

function failure<Reason extends string>(reason: Reason): Readonly<{ ok: false; reason: Reason }> {
	return Object.freeze({ ok: false as const, reason });
}

function causedFailure<Reason extends string, Cause extends string>(
	reason: Reason,
	cause: Cause
): Readonly<{ cause: Cause; ok: false; reason: Reason }> {
	return Object.freeze({ cause, ok: false as const, reason });
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null;
}

function snapshotClosedRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
	if (!isRecord(value) || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length) return undefined;
	const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	for (const key of keys) {
		const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return undefined;
		result[key] = descriptor.value;
	}
	return result;
}

function copyDetachedBytes(value: unknown): Uint8Array | undefined {
	try {
		if (
			!(value instanceof Uint8Array) ||
			TYPED_ARRAY_BUFFER_GETTER === undefined ||
			TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
		)
			return undefined;
		const buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []) as ArrayBufferLike;
		const byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []) as number;
		if (typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer) return undefined;
		if (!Number.isSafeInteger(byteLength) || byteLength < 0) return undefined;
		const copied = new Uint8Array(byteLength);
		for (let index = 0; index < byteLength; index += 1) {
			const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
			if (
				descriptor === undefined ||
				!("value" in descriptor) ||
				!Number.isInteger(descriptor.value) ||
				(descriptor.value as number) < 0 ||
				(descriptor.value as number) > 255
			)
				return undefined;
			copied[index] = descriptor.value as number;
		}
		return copied;
	} catch {
		return undefined;
	}
}

function snapshotDenseArray(value: unknown): readonly unknown[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
	if (
		lengthDescriptor === undefined ||
		!("value" in lengthDescriptor) ||
		!Number.isSafeInteger(lengthDescriptor.value) ||
		(lengthDescriptor.value as number) < 0
	)
		return undefined;
	const entries: unknown[] = [];
	for (let index = 0; index < (lengthDescriptor.value as number); index += 1) {
		const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
		if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return undefined;
		entries.push(descriptor.value);
	}
	return entries;
}

function copyRef(value: unknown): GenerationRef | undefined {
	const record = snapshotClosedRecord(value, ["byteLength", "digest"]);
	if (
		record === undefined ||
		!Number.isSafeInteger(record.byteLength) ||
		(record.byteLength as number) < 0 ||
		typeof record.digest !== "string" ||
		!DIGEST_HEX.test(record.digest)
	)
		return undefined;
	return Object.freeze({
		byteLength: record.byteLength as number,
		digest: record.digest as BlobDigest,
	});
}

function snapshotStoreResult(value: unknown): StoreResultSnapshot | undefined {
	if (!isRecord(value)) return undefined;
	const okDescriptor = Reflect.getOwnPropertyDescriptor(value, "ok");
	if (
		okDescriptor === undefined ||
		okDescriptor.enumerable !== true ||
		!("value" in okDescriptor) ||
		typeof okDescriptor.value !== "boolean"
	)
		return undefined;
	if (okDescriptor.value) {
		const record = snapshotClosedRecord(value, ["ok", "value"]);
		return record === undefined ? undefined : Object.freeze({ ok: true as const, value: record.value });
	}
	const reasonDescriptor = Reflect.getOwnPropertyDescriptor(value, "reason");
	if (
		reasonDescriptor === undefined ||
		reasonDescriptor.enumerable !== true ||
		!("value" in reasonDescriptor) ||
		typeof reasonDescriptor.value !== "string"
	)
		return undefined;
	return Object.freeze({ ok: false as const, reason: reasonDescriptor.value });
}

function snapshotPresentHead(value: unknown): PresentHead | undefined {
	const record = snapshotClosedRecord(value, ["closureDigest", "generationId", "kind", "objectId", "revision"]);
	if (
		record === undefined ||
		record.kind !== "present" ||
		typeof record.objectId !== "string" ||
		typeof record.generationId !== "string" ||
		!DIGEST_HEX.test(record.generationId) ||
		typeof record.closureDigest !== "string" ||
		!DIGEST_HEX.test(record.closureDigest) ||
		!Number.isSafeInteger(record.revision) ||
		(record.revision as number) <= 0
	)
		return undefined;
	return Object.freeze({
		closureDigest: record.closureDigest as PresentHead["closureDigest"],
		generationId: record.generationId as GenerationId,
		kind: "present" as const,
		objectId: record.objectId as StorageObjectId,
		revision: record.revision as PresentHead["revision"],
	});
}

function snapshotExpectedHead(value: unknown, objectId: StorageObjectId): ExpectedHead | undefined {
	const kindDescriptor = isRecord(value) ? Reflect.getOwnPropertyDescriptor(value, "kind") : undefined;
	if (kindDescriptor === undefined || !("value" in kindDescriptor)) return undefined;
	if (kindDescriptor.value === "none") {
		const record = snapshotClosedRecord(value, ["kind", "objectId"]);
		return record?.objectId === objectId ? Object.freeze({ kind: "none" as const, objectId }) : undefined;
	}
	const present = snapshotPresentHead(value);
	return present?.objectId === objectId ? present : undefined;
}

function sameExpectedHead(left: ExpectedHead, right: ExpectedHead): boolean {
	return left.kind === "none"
		? right.kind === "none" && left.objectId === right.objectId
		: right.kind === "present" && sameHead(left, right);
}

function sameClosure(left: readonly GenerationRef[], right: readonly GenerationRef[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (!sameRef(left[index] as GenerationRef, right[index] as GenerationRef)) return false;
	}
	return true;
}

function snapshotGenerationRecord(
	value: unknown,
	expected: Readonly<{
		baseExpectedHead?: ExpectedHead;
		closure?: readonly GenerationRef[];
		generationId: GenerationId;
		objectId: StorageObjectId;
		state: "Adopted" | "Complete" | "Staged";
	}>
): Readonly<{ closure: readonly GenerationRef[]; closureDigest: string }> | undefined {
	const record = snapshotClosedRecord(value, [
		"baseExpectedHead",
		"closure",
		"closureDigest",
		"generationId",
		"objectId",
		"state",
	]);
	if (
		record === undefined ||
		record.objectId !== expected.objectId ||
		record.generationId !== expected.generationId ||
		record.state !== expected.state ||
		typeof record.closureDigest !== "string" ||
		!DIGEST_HEX.test(record.closureDigest)
	)
		return undefined;
	const baseExpectedHead = snapshotExpectedHead(record.baseExpectedHead, expected.objectId);
	const closure = copyClosure(record.closure);
	if (
		baseExpectedHead === undefined ||
		closure === undefined ||
		(expected.baseExpectedHead !== undefined && !sameExpectedHead(baseExpectedHead, expected.baseExpectedHead)) ||
		(expected.closure !== undefined && !sameClosure(closure, expected.closure))
	)
		return undefined;
	return Object.freeze({ closure, closureDigest: record.closureDigest });
}

function snapshotStrictDurability(store: AheDurableStore): boolean {
	try {
		const descriptor = Reflect.getOwnPropertyDescriptor(store, "capabilities");
		if (descriptor === undefined || !("value" in descriptor)) return false;
		const record = snapshotClosedRecord(descriptor.value, ["durability", "signingEligibility"]);
		return record?.durability === "strict" && record.signingEligibility === "backend-capability-required";
	} catch {
		return false;
	}
}

function sameRef(left: GenerationRef, right: GenerationRef): boolean {
	return left.byteLength === right.byteLength && left.digest === right.digest;
}

function copyClosure(value: unknown): readonly GenerationRef[] | undefined {
	const entries = snapshotDenseArray(value);
	if (entries === undefined || entries.length === 0) return undefined;
	const closure: GenerationRef[] = [];
	let previousDigest: string | undefined;
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		const ref = copyRef(entry);
		if (ref === undefined || (previousDigest !== undefined && previousDigest >= ref.digest)) return undefined;
		closure.push(ref);
		previousDigest = ref.digest;
	}
	return Object.freeze(closure);
}

function copyCandidates(value: unknown): readonly CopiedCandidate[] | undefined {
	const entries = snapshotDenseArray(value);
	if (entries === undefined) return undefined;
	const candidates: CopiedCandidate[] = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		const record = snapshotClosedRecord(entry, ["bytes", "ref"]);
		const ref = record === undefined ? undefined : copyRef(record.ref);
		if (record === undefined || !(record.bytes instanceof Uint8Array) || ref === undefined) return undefined;
		const bytes = copyDetachedBytes(record.bytes);
		if (bytes === undefined) return undefined;
		candidates.push(Object.freeze({ bytes, ref }));
	}
	return Object.freeze(candidates);
}

function inspectCopiedClosure(
	closure: readonly GenerationRef[],
	candidates: readonly CopiedCandidate[]
): InspectTrustClosureResult {
	const closureByDigest = new Map(closure.map((ref) => [ref.digest, ref]));
	const candidatesByDigest = new Map<string, CopiedCandidate>();
	for (const candidate of candidates) {
		const closureRef = closureByDigest.get(candidate.ref.digest);
		if (closureRef === undefined || !sameRef(closureRef, candidate.ref)) return failure("candidate-not-in-closure");
		if (candidatesByDigest.has(candidate.ref.digest)) return failure("candidate-duplicate");
		candidatesByDigest.set(candidate.ref.digest, candidate);
	}
	for (const candidate of candidates) {
		if (candidate.ref.byteLength > MAX_SCANNABLE_BYTES) return failure("candidate-not-scannable");
	}
	for (const ref of closure) {
		if (ref.byteLength <= MAX_SCANNABLE_BYTES && !candidatesByDigest.has(ref.digest))
			return failure("candidate-missing");
	}
	for (const candidate of candidates) {
		if (candidate.bytes.byteLength !== candidate.ref.byteLength) return failure("candidate-length-mismatch");
	}
	for (const candidate of candidates) {
		const digest = digestBlob(candidate.bytes);
		if (!digest.ok || digest.value !== candidate.ref.digest) return failure("candidate-digest-mismatch");
	}
	const trustCandidates = candidates.filter(({ bytes }) => isAnchorTrustStateRecordBytes(bytes));
	if (trustCandidates.length === 0) return failure("trust-state-missing");
	if (trustCandidates.length !== 1) return failure("trust-state-ambiguous");
	const selected = trustCandidates[0] as CopiedCandidate;
	return Object.freeze({
		exactCanonicalTrustStateRecordBytes: selected.bytes,
		ok: true as const,
		trustRef: selected.ref,
	});
}

/**
 * Inspects a detached closure without interpreting trust-record fields or object identity.
 * @param input - Exact closure references and their detached scannable candidates.
 * @returns The unique trust-state bytes and reference, or the first closed rejection.
 */
export function inspectTrustClosure(input: InspectTrustClosureInput): InspectTrustClosureResult {
	try {
		const record = snapshotClosedRecord(input, ["candidates", "closure"]);
		if (record === undefined) return failure("malformed-input");
		const closure = copyClosure(record.closure);
		if (closure === undefined) return failure("closure-invalid");
		const candidates = copyCandidates(record.candidates);
		if (candidates === undefined) return failure("candidate-invalid");
		return inspectCopiedClosure(closure, candidates);
	} catch {
		return failure("malformed-input");
	}
}

/**
 * Establishes that a previously selected trust reference survives a proposed detached closure.
 * @param input - Proposed closure data and the previously selected trust reference.
 * @returns The preserved trust-state bytes and reference, or the first closed rejection.
 */
export function assertTrustPreserved(input: AssertTrustPreservedInput): AssertTrustPreservedResult {
	try {
		const record = snapshotClosedRecord(input, ["candidates", "closure", "expectedTrustRef"]);
		if (record === undefined) return failure("malformed-input");
		const expectedTrustRef = copyRef(record.expectedTrustRef);
		if (expectedTrustRef === undefined) return failure("malformed-input");
		const inspected = inspectTrustClosure({ candidates: record.candidates as never, closure: record.closure as never });
		if (!inspected.ok) return inspected;
		if (!sameRef(inspected.trustRef, expectedTrustRef)) return failure("trust-ref-not-preserved");
		return inspected;
	} catch {
		return failure("malformed-input");
	}
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function sameHead(left: PresentHead, right: PresentHead): boolean {
	return (
		left.closureDigest === right.closureDigest &&
		left.generationId === right.generationId &&
		left.objectId === right.objectId &&
		left.revision === right.revision
	);
}

function snapshotActiveRecovery(
	value: unknown,
	expectedHead: PresentHead
): Readonly<{ head: PresentHead; references: readonly GenerationRef[] }> | undefined {
	const result = snapshotStoreResult(value);
	if (result === undefined || !result.ok) return undefined;
	const active = snapshotClosedRecord(result.value, [
		"adoptedGeneration",
		"head",
		"kind",
		"recomputedClosureDigest",
		"references",
	]);
	if (active === undefined || active.kind !== "active") return undefined;
	const head = snapshotPresentHead(active.head);
	const references = copyClosure(active.references);
	if (
		head === undefined ||
		references === undefined ||
		!sameHead(head, expectedHead) ||
		active.recomputedClosureDigest !== head.closureDigest
	)
		return undefined;
	const adopted = snapshotGenerationRecord(active.adoptedGeneration, {
		closure: references,
		generationId: head.generationId,
		objectId: head.objectId,
		state: "Adopted",
	});
	if (adopted === undefined || adopted.closureDigest !== head.closureDigest) return undefined;
	return Object.freeze({ head, references });
}

function snapshotLoadedBlob(value: unknown): Uint8Array | undefined {
	const result = snapshotStoreResult(value);
	return result?.ok === true ? copyDetachedBytes(result.value) : undefined;
}

function successfulOpen(value: OpenedStoredTrust): OpenDurableCurrentAnchorTrustResult {
	return Object.freeze({
		head: Object.freeze({ ...value.head }),
		ok: true as const,
		trust: value.trust,
		trustRef: Object.freeze({ ...value.trustRef }),
	});
}

function freshGenerationId(): GenerationId | undefined {
	try {
		const bytes = new Uint8Array(32);
		globalThis.crypto.getRandomValues(bytes);
		const text = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
		const parsed = parseGenerationId(text);
		return parsed.ok ? parsed.value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Creates the sole durable owner for creator current-anchor trust.
 * @param options - Fixed storage owner, genesis pin, and strict durable AHE store.
 * @returns The immutable install/open authority for the fixed object.
 */
export function createCurrentAnchorTrustStore(options: CurrentAnchorTrustStoreOptions): CurrentAnchorTrustStore {
	const objectId = options.objectId;
	const pinnedGenesisAnchorDigest = options.pinnedGenesisAnchorDigest;
	const store = options.store;

	const openAtHead = async (expectedHead: PresentHead): Promise<OpenedStoredTrustResult> => {
		try {
			const recovered = snapshotActiveRecovery(await store.recoverActiveGeneration(objectId), expectedHead);
			if (recovered === undefined) return failure("trust-state-unreadable");
			const candidates: DetachedClosureCandidate[] = [];
			for (let index = 0; index < recovered.references.length; index += 1) {
				const ref = recovered.references[index] as GenerationRef;
				if (ref.byteLength > MAX_SCANNABLE_BYTES) continue;
				const bytes = snapshotLoadedBlob(await store.getBlob(ref.digest));
				if (bytes === undefined) return failure("trust-state-unreadable");
				candidates.push(Object.freeze({ bytes, ref }));
			}
			const inspected = inspectTrustClosure({ candidates, closure: recovered.references });
			if (!inspected.ok) return causedFailure("closure-rejected", inspected.reason);
			const opened = openCurrentAnchorTrust({
				exactCanonicalTrustStateRecordBytes: inspected.exactCanonicalTrustStateRecordBytes,
				expectedObjectId: objectId,
				pinnedGenesisAnchorDigest,
			});
			if (!opened.ok) return causedFailure("trust-rejected", opened.reason);
			return Object.freeze({
				ok: true as const,
				value: Object.freeze({
					bytes: inspected.exactCanonicalTrustStateRecordBytes,
					head: recovered.head,
					trust: opened.trust,
					trustRef: inspected.trustRef,
				}),
			});
		} catch {
			return failure("trust-state-unreadable");
		}
	};

	const open = async (): Promise<OpenDurableCurrentAnchorTrustResult> => {
		if (!snapshotStrictDurability(store)) return failure("store-failed");
		try {
			const read = snapshotStoreResult(await store.readHead(objectId));
			if (read === undefined || !read.ok) return failure("store-failed");
			const head = snapshotExpectedHead(read.value, objectId);
			if (head === undefined) return failure("store-failed");
			if (head.kind === "none") return failure("not-installed");
			const opened = await openAtHead(head);
			return opened.ok ? successfulOpen(opened.value) : opened;
		} catch {
			return failure("store-failed");
		}
	};

	const install = async (input: InstallCreatorAnchorTrustRootInput): Promise<InstallCurrentAnchorTrustResult> => {
		const installed = installCreatorAnchorTrustRoot(input);
		if (!installed.ok) return causedFailure("genesis-rejected", installed.reason);
		const openedFresh = openCurrentAnchorTrust({
			exactCanonicalTrustStateRecordBytes: installed.exactCanonicalTrustStateRecordBytes,
			expectedObjectId: objectId,
			pinnedGenesisAnchorDigest,
		});
		if (!openedFresh.ok) return causedFailure("trust-rejected", openedFresh.reason);
		const exactBytes = new Uint8Array(installed.exactCanonicalTrustStateRecordBytes);
		const digest = digestBlob(exactBytes);
		if (!digest.ok) return failure("store-failed");
		const trustRef = Object.freeze({ byteLength: exactBytes.byteLength, digest: digest.value });
		const inspected = inspectTrustClosure({ candidates: [{ bytes: exactBytes, ref: trustRef }], closure: [trustRef] });
		if (!inspected.ok) return causedFailure("closure-rejected", inspected.reason);
		if (!snapshotStrictDurability(store)) return failure("store-failed");

		try {
			const read = snapshotStoreResult(await store.readHead(objectId));
			if (read === undefined || !read.ok) return failure("store-failed");
			const head = snapshotExpectedHead(read.value, objectId);
			if (head === undefined) return failure("store-failed");
			if (head.kind === "present") {
				const existing = await openAtHead(head);
				if (!existing.ok) return existing.reason === "trust-state-unreadable" ? failure("store-failed") : existing;
				return sameBytes(existing.value.bytes, exactBytes)
					? failure("already-installed")
					: failure("trust-state-conflict");
			}
		} catch {
			return failure("store-failed");
		}

		const generationId = freshGenerationId();
		if (generationId === undefined) return failure("store-failed");
		const baseExpectedHead: ExpectedHead = Object.freeze({ kind: "none", objectId });
		try {
			const begun = snapshotStoreResult(
				await store.beginGeneration({
					baseExpectedHead,
					closure: [trustRef],
					generationId,
					objectId,
				})
			);
			const begunRecord =
				begun?.ok === true
					? snapshotGenerationRecord(begun.value, {
							baseExpectedHead,
							closure: [trustRef],
							generationId,
							objectId,
							state: "Staged",
						})
					: undefined;
			if (begunRecord === undefined) return failure("store-failed");
			const cached = snapshotStoreResult(
				await store.putCachedBlob({ bytes: exactBytes, digest: trustRef.digest, generationId, objectId })
			);
			const cachedValue = cached?.ok === true ? snapshotClosedRecord(cached.value, ["inserted"]) : undefined;
			if (cachedValue === undefined || typeof cachedValue.inserted !== "boolean") return failure("store-failed");
			const promoted = snapshotStoreResult(
				await store.promoteReference({ digest: trustRef.digest, generationId, objectId })
			);
			if (promoted?.ok !== true || promoted.value !== undefined) return failure("store-failed");
			const completed = snapshotStoreResult(await store.completeGeneration({ generationId, objectId }));
			const completedRecord =
				completed?.ok === true
					? snapshotGenerationRecord(completed.value, {
							baseExpectedHead,
							closure: [trustRef],
							generationId,
							objectId,
							state: "Complete",
						})
					: undefined;
			if (completedRecord === undefined || completedRecord.closureDigest !== begunRecord.closureDigest)
				return failure("store-failed");
			const swapped = snapshotStoreResult(
				await store.swapHead({ expectedHead: baseExpectedHead, generationId, objectId })
			);
			if (swapped?.ok === true) {
				const swapValue = snapshotClosedRecord(swapped.value, ["head", "supersededGenerationId"]);
				const head = swapValue === undefined ? undefined : snapshotPresentHead(swapValue.head);
				if (
					head === undefined ||
					head.objectId !== objectId ||
					head.generationId !== generationId ||
					head.closureDigest !== completedRecord.closureDigest ||
					swapValue?.supersededGenerationId !== null
				)
					return failure("store-failed");
				return Object.freeze({
					head,
					ok: true as const,
					trust: openedFresh.trust,
					trustRef: Object.freeze({ ...trustRef }),
				});
			}
			if (swapped?.reason !== "HEAD_CONFLICT") return failure("store-failed");
		} catch {
			return failure("store-failed");
		}

		try {
			const winnerRead = snapshotStoreResult(await store.readHead(objectId));
			if (winnerRead === undefined || !winnerRead.ok) return failure("store-failed");
			const winnerHead = snapshotExpectedHead(winnerRead.value, objectId);
			if (winnerHead?.kind !== "present") return failure("store-failed");
			const winner = await openAtHead(winnerHead);
			if (!winner.ok) return winner.reason === "trust-state-unreadable" ? failure("store-failed") : winner;
			return sameBytes(winner.value.bytes, exactBytes) ? failure("already-installed") : failure("trust-state-conflict");
		} catch {
			return failure("store-failed");
		}
	};

	return Object.freeze({ install, open });
}
