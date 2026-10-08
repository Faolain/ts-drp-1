import { ed25519 } from "@noble/curves/ed25519.js";
import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";

export const OUTCOME_COMMIT_MAX_PAYLOAD_BYTES = 8_192;
export const OUTCOME_COMMIT_MAX_PROOF_BYTES = 32_768;

const INTENT_DOMAIN = "ts-drp/outcome-intent/v1";
const PAYLOAD_DOMAIN = "ts-drp/outcome-payload/v1";
const DIGEST = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/u;
const OBJECT_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const INTENT_KEYS = [
	"aclDigest",
	"anchorDigest",
	"clientOperationId",
	"counterparties",
	"epoch",
	"kind",
	"objectId",
	"outcomeKind",
	"payloadDigest",
	"version",
] as const;
const PREPARE_KEYS = [
	"aclDigest",
	"anchorDigest",
	"clientOperationId",
	"counterparties",
	"epoch",
	"exactCanonicalPayloadBytes",
	"objectId",
	"outcomeKind",
] as const;
const PREPARED_KEYS = [
	"exactCanonicalIntentBytes",
	"exactCanonicalPayloadBytes",
	"intent",
	"intentDigest",
	"registeredDigest",
] as const;
const APPROVAL_KEYS = ["signature", "signer"] as const;
const OPERATION_KEYS = [
	"action",
	"approvals",
	"clientOperationId",
	"exactCanonicalIntentBytes",
	"exactCanonicalPayloadBytes",
] as const;
const ADMISSION_OPERATION_KEYS = ["action", "proof"] as const;
const ADMISSION_POLICY_KEYS = ["aclDigest", "anchorDigest", "epoch", "maxEntries", "objectId"] as const;
const VERIFY_KEYS = [
	"expectedAclDigest",
	"expectedAnchorDigest",
	"expectedEpoch",
	"expectedObjectId",
	"operation",
] as const;

const INTRINSIC_ARRAY_BUFFER = ArrayBuffer;
const INTRINSIC_ARRAY_BUFFER_PROTOTYPE = ArrayBuffer.prototype;
const INTRINSIC_ARRAY_BUFFER_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
	INTRINSIC_ARRAY_BUFFER_PROTOTYPE,
	"byteLength"
)?.get as (this: ArrayBuffer) => number;
const INTRINSIC_ARRAY_BUFFER_RESIZABLE = Object.getOwnPropertyDescriptor(INTRINSIC_ARRAY_BUFFER_PROTOTYPE, "resizable")
	?.get as ((this: ArrayBuffer) => boolean) | undefined;
const INTRINSIC_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const INTRINSIC_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const INTRINSIC_REFLECT_APPLY = Reflect.apply;
const INTRINSIC_UINT8_ARRAY = Uint8Array;
const INTRINSIC_UINT8_ARRAY_PROTOTYPE = Uint8Array.prototype;
const INTRINSIC_UINT8_ARRAY_SET = Uint8Array.prototype.set;
const INTRINSIC_TYPED_ARRAY_PROTOTYPE = INTRINSIC_GET_PROTOTYPE_OF(INTRINSIC_UINT8_ARRAY_PROTOTYPE) as object;
const INTRINSIC_TYPED_ARRAY_BUFFER = INTRINSIC_GET_OWN_PROPERTY_DESCRIPTOR(INTRINSIC_TYPED_ARRAY_PROTOTYPE, "buffer")
	?.get as (this: Uint8Array) => ArrayBufferLike;
const INTRINSIC_TYPED_ARRAY_BYTE_LENGTH = INTRINSIC_GET_OWN_PROPERTY_DESCRIPTOR(
	INTRINSIC_TYPED_ARRAY_PROTOTYPE,
	"byteLength"
)?.get as (this: Uint8Array) => number;
const INTRINSIC_TYPED_ARRAY_BYTE_OFFSET = INTRINSIC_GET_OWN_PROPERTY_DESCRIPTOR(
	INTRINSIC_TYPED_ARRAY_PROTOTYPE,
	"byteOffset"
)?.get as (this: Uint8Array) => number;

export interface OutcomeIntent {
	readonly aclDigest: string;
	readonly anchorDigest: string;
	readonly clientOperationId: string;
	readonly counterparties: readonly string[];
	readonly epoch: number;
	readonly kind: "ts-drp-outcome-intent";
	readonly objectId: string;
	readonly outcomeKind: string;
	readonly payloadDigest: string;
	readonly version: 1;
}

export interface PreparedOutcomeIntent {
	readonly exactCanonicalIntentBytes: Uint8Array;
	readonly exactCanonicalPayloadBytes: Uint8Array;
	readonly intent: OutcomeIntent;
	readonly intentDigest: string;
	readonly registeredDigest: Uint8Array;
}

export interface OutcomeApproval {
	readonly signature: Uint8Array;
	readonly signer: string;
}

export interface OutcomeCommitOperation {
	readonly action: "commit-outcome-v1";
	readonly approvals: readonly OutcomeApproval[];
	readonly clientOperationId: string;
	readonly exactCanonicalIntentBytes: Uint8Array;
	readonly exactCanonicalPayloadBytes: Uint8Array;
}

export interface OutcomeCommitAdmissionOperation extends Readonly<Record<string, unknown>> {
	readonly action: "commit-outcome-v1";
	readonly proof: OutcomeCommitOperation;
}

export type OutcomeCommitAdmissionReservation =
	| Readonly<{ readonly kind: "fresh"; commit(): "committed"; release(): void }>
	| Readonly<{ readonly kind: "duplicate" | "conflict" | "rejected" }>;

export interface OutcomeCommitAdmissionPolicy {
	readonly size: number;
	reserve(operation: Readonly<Record<string, unknown>>): OutcomeCommitAdmissionReservation;
}

export interface VerifiedOutcomeCommit {
	readonly clientOperationId: string;
	readonly intentDigest: string;
	readonly operation: OutcomeCommitOperation;
}

export interface OutcomeCommitRegistry {
	readonly size: number;
	classify(value: VerifiedOutcomeCommit): "conflict" | "duplicate" | "fresh" | "full";
	commit(value: VerifiedOutcomeCommit): "committed" | "conflict" | "duplicate" | "full";
}

export type OutcomeCommitVerificationResult =
	| Readonly<{
			readonly ok: false;
			readonly reason:
				| "approval-mismatch"
				| "context-mismatch"
				| "malformed-proof"
				| "payload-mismatch"
				| "proof-too-large";
	  }>
	| Readonly<{ readonly ok: true; readonly verified: VerifiedOutcomeCommit }>;

interface VerifiedState {
	readonly clientOperationId: string;
	readonly intentDigest: string;
}

const verifiedStates = new WeakMap<VerifiedOutcomeCommit, VerifiedState>();

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytes(value: string): Uint8Array {
	return Uint8Array.from(value.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const prototype = INTRINSIC_GET_PROTOTYPE_OF(value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	const actualKeys = Reflect.ownKeys(value);
	if (actualKeys.length !== keys.length || actualKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
		return undefined;
	}
	const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	for (const key of keys) {
		const descriptor = INTRINSIC_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
		if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
		result[key] = descriptor.value;
	}
	return result;
}

function exactDenseArray(value: unknown): readonly unknown[] | undefined {
	if (!Array.isArray(value) || INTRINSIC_GET_PROTOTYPE_OF(value) !== Array.prototype) return undefined;
	for (let index = 0; index < value.length; index += 1) {
		const descriptor = INTRINSIC_GET_OWN_PROPERTY_DESCRIPTOR(value, String(index));
		if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
	}
	return value;
}

function strictBytes(value: unknown): Uint8Array | undefined {
	try {
		if (INTRINSIC_GET_PROTOTYPE_OF(value) !== INTRINSIC_UINT8_ARRAY_PROTOTYPE) return undefined;
		const byteLength = INTRINSIC_REFLECT_APPLY(INTRINSIC_TYPED_ARRAY_BYTE_LENGTH, value, []);
		const byteOffset = INTRINSIC_REFLECT_APPLY(INTRINSIC_TYPED_ARRAY_BYTE_OFFSET, value, []);
		const buffer = INTRINSIC_REFLECT_APPLY(INTRINSIC_TYPED_ARRAY_BUFFER, value, []);
		if (
			INTRINSIC_GET_PROTOTYPE_OF(buffer) !== INTRINSIC_ARRAY_BUFFER_PROTOTYPE ||
			byteOffset !== 0 ||
			INTRINSIC_REFLECT_APPLY(INTRINSIC_ARRAY_BUFFER_BYTE_LENGTH, buffer, []) !== byteLength ||
			(INTRINSIC_ARRAY_BUFFER_RESIZABLE !== undefined &&
				INTRINSIC_REFLECT_APPLY(INTRINSIC_ARRAY_BUFFER_RESIZABLE, buffer, []))
		) {
			return undefined;
		}
		const copy = new INTRINSIC_UINT8_ARRAY(byteLength);
		INTRINSIC_REFLECT_APPLY(INTRINSIC_UINT8_ARRAY_SET, copy, [value]);
		return copy;
	} catch {
		return undefined;
	}
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return compareBytes(left, right) === 0;
}

function canonicalPayload(value: unknown): Uint8Array | undefined {
	const copy = strictBytes(value);
	if (copy === undefined || copy.byteLength > OUTCOME_COMMIT_MAX_PAYLOAD_BYTES) return undefined;
	try {
		const decoded = decodeCanonical(copy, {
			maxBytes: OUTCOME_COMMIT_MAX_PAYLOAD_BYTES,
			maxDepth: 32,
			maxItems: 4_096,
		});
		return sameBytes(
			copy,
			encodeCanonical(decoded, {
				maxBytes: OUTCOME_COMMIT_MAX_PAYLOAD_BYTES,
				maxDepth: 32,
				maxItems: 4_096,
			})
		)
			? copy
			: undefined;
	} catch {
		return undefined;
	}
}

function counterparties(value: unknown, requireSorted: boolean): readonly string[] | undefined {
	const values = exactDenseArray(value);
	if (
		values === undefined ||
		values.length !== 2 ||
		values.some((entry) => typeof entry !== "string" || !DIGEST.test(entry))
	) {
		return undefined;
	}
	const sorted = [...(values as readonly string[])].sort(compareText);
	if (sorted[0] === sorted[1]) return undefined;
	if (requireSorted && (values[0] !== sorted[0] || values[1] !== sorted[1])) return undefined;
	return Object.freeze(sorted);
}

function copyIntent(value: unknown): OutcomeIntent | undefined {
	const record = exactRecord(value, INTENT_KEYS);
	const selectedCounterparties = counterparties(record?.counterparties, true);
	if (
		record === undefined ||
		record.kind !== "ts-drp-outcome-intent" ||
		record.version !== 1 ||
		typeof record.objectId !== "string" ||
		!OBJECT_ID.test(record.objectId) ||
		!Number.isSafeInteger(record.epoch) ||
		(record.epoch as number) < 0 ||
		(record.epoch as number) > 0xffff_ffff ||
		typeof record.anchorDigest !== "string" ||
		!DIGEST.test(record.anchorDigest) ||
		typeof record.aclDigest !== "string" ||
		!DIGEST.test(record.aclDigest) ||
		typeof record.outcomeKind !== "string" ||
		!IDENTIFIER.test(record.outcomeKind) ||
		typeof record.clientOperationId !== "string" ||
		!IDENTIFIER.test(record.clientOperationId) ||
		typeof record.payloadDigest !== "string" ||
		!DIGEST.test(record.payloadDigest) ||
		selectedCounterparties === undefined
	) {
		return undefined;
	}
	return Object.freeze({
		aclDigest: record.aclDigest,
		anchorDigest: record.anchorDigest,
		clientOperationId: record.clientOperationId,
		counterparties: selectedCounterparties,
		epoch: record.epoch as number,
		kind: "ts-drp-outcome-intent" as const,
		objectId: record.objectId,
		outcomeKind: record.outcomeKind,
		payloadDigest: record.payloadDigest,
		version: 1 as const,
	});
}

function openIntent(value: unknown):
	| Readonly<{
			readonly bytes: Uint8Array;
			readonly digest: Uint8Array;
			readonly intent: OutcomeIntent;
	  }>
	| undefined {
	const intentBytes = strictBytes(value);
	if (intentBytes === undefined || intentBytes.byteLength > 4_096) return undefined;
	try {
		const decoded = decodeCanonical(intentBytes, { maxBytes: 4_096, maxDepth: 8, maxItems: 64 });
		const intent = copyIntent(decoded);
		if (
			intent === undefined ||
			!sameBytes(intentBytes, encodeCanonical(intent, { maxBytes: 4_096, maxDepth: 8, maxItems: 64 }))
		) {
			return undefined;
		}
		return Object.freeze({ bytes: intentBytes, digest: hashDomain(INTENT_DOMAIN, intentBytes), intent });
	} catch {
		return undefined;
	}
}

function copyApproval(value: unknown): OutcomeApproval | undefined {
	const record = exactRecord(value, APPROVAL_KEYS);
	const signature = strictBytes(record?.signature);
	if (
		record === undefined ||
		typeof record.signer !== "string" ||
		!DIGEST.test(record.signer) ||
		signature === undefined ||
		signature.byteLength !== 64
	) {
		return undefined;
	}
	return Object.freeze({ signature, signer: record.signer });
}

function copyApprovals(value: unknown, requireSorted: boolean): readonly OutcomeApproval[] | undefined {
	const values = exactDenseArray(value);
	if (values === undefined || values.length !== 2) return undefined;
	const copies = values.map(copyApproval);
	if (copies.some((entry) => entry === undefined)) return undefined;
	const approvals = copies as OutcomeApproval[];
	const sorted = [...approvals].sort((left, right) => compareText(left.signer, right.signer));
	if (sorted[0]?.signer === sorted[1]?.signer) return undefined;
	if (requireSorted && (approvals[0]?.signer !== sorted[0]?.signer || approvals[1]?.signer !== sorted[1]?.signer)) {
		return undefined;
	}
	return Object.freeze(sorted);
}

function detachedOperation(
	intentBytes: Uint8Array,
	payloadBytes: Uint8Array,
	clientOperationId: string,
	approvals: readonly OutcomeApproval[]
): OutcomeCommitOperation {
	return Object.freeze({
		action: "commit-outcome-v1" as const,
		approvals: Object.freeze(
			approvals.map(({ signature, signer }) => Object.freeze({ signature: new Uint8Array(signature), signer }))
		),
		clientOperationId,
		exactCanonicalIntentBytes: new Uint8Array(intentBytes),
		exactCanonicalPayloadBytes: new Uint8Array(payloadBytes),
	});
}

function copiedOperation(value: unknown): OutcomeCommitOperation | undefined {
	const operation = exactRecord(value, OPERATION_KEYS);
	const approvals = copyApprovals(operation?.approvals, false);
	const intentBytes = strictBytes(operation?.exactCanonicalIntentBytes);
	const payloadBytes = strictBytes(operation?.exactCanonicalPayloadBytes);
	if (
		operation === undefined ||
		operation.action !== "commit-outcome-v1" ||
		approvals === undefined ||
		intentBytes === undefined ||
		payloadBytes === undefined ||
		typeof operation.clientOperationId !== "string" ||
		!IDENTIFIER.test(operation.clientOperationId)
	) {
		return undefined;
	}
	return detachedOperation(intentBytes, payloadBytes, operation.clientOperationId, approvals);
}

function admissionProof(value: unknown): OutcomeCommitOperation | undefined {
	const direct = copiedOperation(value);
	if (direct !== undefined) return direct;
	const carrier = exactRecord(value, ADMISSION_OPERATION_KEYS);
	return carrier?.action === "commit-outcome-v1" ? copiedOperation(carrier.proof) : undefined;
}

function validApprovalSignatures(approvals: readonly OutcomeApproval[], digest: Uint8Array): boolean {
	return approvals.every(({ signature, signer }) => {
		try {
			return ed25519.verify(signature, digest, bytes(signer), { zip215: false });
		} catch {
			return false;
		}
	});
}

function validApprovals(approvals: readonly OutcomeApproval[], intent: OutcomeIntent, digest: Uint8Array): boolean {
	return (
		approvals.every(({ signer }, index) => signer === intent.counterparties[index]) &&
		validApprovalSignatures(approvals, digest)
	);
}

/** Prepare one exact domain-separated two-party outcome intent. */
export function prepareOutcomeIntent(
	input: Readonly<{
		readonly aclDigest: string;
		readonly anchorDigest: string;
		readonly clientOperationId: string;
		readonly counterparties: readonly string[];
		readonly epoch: number;
		readonly exactCanonicalPayloadBytes: Uint8Array;
		readonly objectId: string;
		readonly outcomeKind: string;
	}>
): PreparedOutcomeIntent {
	const record = exactRecord(input, PREPARE_KEYS);
	const selectedCounterparties = counterparties(record?.counterparties, false);
	const payload = canonicalPayload(record?.exactCanonicalPayloadBytes);
	if (
		record === undefined ||
		selectedCounterparties === undefined ||
		payload === undefined ||
		typeof record.objectId !== "string" ||
		!OBJECT_ID.test(record.objectId) ||
		!Number.isSafeInteger(record.epoch) ||
		(record.epoch as number) < 0 ||
		(record.epoch as number) > 0xffff_ffff ||
		typeof record.anchorDigest !== "string" ||
		!DIGEST.test(record.anchorDigest) ||
		typeof record.aclDigest !== "string" ||
		!DIGEST.test(record.aclDigest) ||
		typeof record.outcomeKind !== "string" ||
		!IDENTIFIER.test(record.outcomeKind) ||
		typeof record.clientOperationId !== "string" ||
		!IDENTIFIER.test(record.clientOperationId)
	) {
		throw new TypeError(
			selectedCounterparties === undefined
				? "outcome counterparties must contain exactly two distinct authors"
				: payload === undefined
					? "outcome payload must be exact canonical bytes within its limit"
					: "outcome intent input is malformed"
		);
	}
	const intent = Object.freeze({
		aclDigest: record.aclDigest,
		anchorDigest: record.anchorDigest,
		clientOperationId: record.clientOperationId,
		counterparties: selectedCounterparties,
		epoch: record.epoch as number,
		kind: "ts-drp-outcome-intent" as const,
		objectId: record.objectId,
		outcomeKind: record.outcomeKind,
		payloadDigest: hex(hashDomain(PAYLOAD_DOMAIN, payload)),
		version: 1 as const,
	});
	const exactCanonicalIntentBytes = encodeCanonical(intent, { maxBytes: 4_096, maxDepth: 8, maxItems: 64 });
	const registeredDigest = hashDomain(INTENT_DOMAIN, exactCanonicalIntentBytes);
	return Object.freeze({
		exactCanonicalIntentBytes: new Uint8Array(exactCanonicalIntentBytes),
		exactCanonicalPayloadBytes: new Uint8Array(payload),
		intent,
		intentDigest: hex(registeredDigest),
		registeredDigest: new Uint8Array(registeredDigest),
	});
}

/** Construct one detached operation only after both exact approvals verify. */
export function createOutcomeCommitOperation(
	input: Readonly<{
		readonly approvals: readonly OutcomeApproval[];
		readonly prepared: PreparedOutcomeIntent;
	}>
): OutcomeCommitOperation {
	const record = exactRecord(input, ["approvals", "prepared"]);
	const prepared = exactRecord(record?.prepared, PREPARED_KEYS);
	const opened = openIntent(prepared?.exactCanonicalIntentBytes);
	const payload = canonicalPayload(prepared?.exactCanonicalPayloadBytes);
	const approvals = copyApprovals(record?.approvals, false);
	const registeredDigest = strictBytes(prepared?.registeredDigest);
	if (
		record === undefined ||
		prepared === undefined ||
		opened === undefined ||
		payload === undefined ||
		approvals === undefined ||
		registeredDigest === undefined ||
		registeredDigest.byteLength !== 32 ||
		prepared.intentDigest !== hex(opened.digest) ||
		!sameBytes(registeredDigest, opened.digest) ||
		copyIntent(prepared.intent) === undefined ||
		!sameBytes(encodeCanonical(prepared.intent), opened.bytes) ||
		opened.intent.payloadDigest !== hex(hashDomain(PAYLOAD_DOMAIN, payload)) ||
		!validApprovals(approvals, opened.intent, opened.digest)
	) {
		throw new TypeError("outcome approvals or prepared intent are invalid");
	}
	return detachedOperation(opened.bytes, payload, opened.intent.clientOperationId, approvals);
}

/** Wrap one verified-shape proof in the blueprint's canonical-object operation carrier. */
export function createOutcomeCommitAdmissionOperation(
	operation: OutcomeCommitOperation
): OutcomeCommitAdmissionOperation {
	const proof = copiedOperation(operation);
	if (proof === undefined) throw new TypeError("outcome admission operation is invalid");
	return Object.freeze({ action: "commit-outcome-v1" as const, proof });
}

function rejected(
	reason: Exclude<OutcomeCommitVerificationResult, { readonly ok: true }>["reason"]
): OutcomeCommitVerificationResult {
	return Object.freeze({ ok: false as const, reason });
}

/** Verify one wire-shaped outcome operation against current authenticated room context. */
export function verifyOutcomeCommitOperation(
	input: Readonly<{
		readonly expectedAclDigest: string;
		readonly expectedAnchorDigest: string;
		readonly expectedEpoch: number;
		readonly expectedObjectId: string;
		readonly operation: OutcomeCommitOperation;
	}>
): OutcomeCommitVerificationResult {
	const record = exactRecord(input, VERIFY_KEYS);
	const operation = exactRecord(record?.operation, OPERATION_KEYS);
	const intentBytes = strictBytes(operation?.exactCanonicalIntentBytes);
	const payloadBytes = strictBytes(operation?.exactCanonicalPayloadBytes);
	if (record === undefined || operation === undefined || intentBytes === undefined || payloadBytes === undefined) {
		return rejected("malformed-proof");
	}
	const approvalValues = exactDenseArray(operation.approvals);
	const approvals = copyApprovals(operation.approvals, false);
	const proofBytes = intentBytes.byteLength + payloadBytes.byteLength + (approvals?.length ?? 0) * 96;
	if (proofBytes > OUTCOME_COMMIT_MAX_PROOF_BYTES) return rejected("proof-too-large");
	if (payloadBytes.byteLength > OUTCOME_COMMIT_MAX_PAYLOAD_BYTES) return rejected("payload-mismatch");
	const opened = openIntent(intentBytes);
	const payload = canonicalPayload(payloadBytes);
	if (
		opened === undefined ||
		operation.action !== "commit-outcome-v1" ||
		typeof operation.clientOperationId !== "string" ||
		operation.clientOperationId !== opened.intent.clientOperationId
	) {
		return rejected("malformed-proof");
	}
	if (approvals === undefined) return rejected("approval-mismatch");
	if (payload === undefined || opened.intent.payloadDigest !== hex(hashDomain(PAYLOAD_DOMAIN, payload))) {
		return rejected("payload-mismatch");
	}
	if (
		record.expectedAclDigest !== opened.intent.aclDigest ||
		record.expectedAnchorDigest !== opened.intent.anchorDigest ||
		record.expectedEpoch !== opened.intent.epoch ||
		record.expectedObjectId !== opened.intent.objectId
	) {
		return rejected("context-mismatch");
	}
	const firstApproval = exactRecord(approvalValues?.[0], APPROVAL_KEYS);
	const secondApproval = exactRecord(approvalValues?.[1], APPROVAL_KEYS);
	const approvalRosterMatches = approvals.every(({ signer }, index) => signer === opened.intent.counterparties[index]);
	if (!validApprovalSignatures(approvals, opened.digest)) return rejected("approval-mismatch");
	if (
		approvalRosterMatches &&
		(firstApproval?.signer !== approvals[0]?.signer || secondApproval?.signer !== approvals[1]?.signer)
	) {
		return rejected("malformed-proof");
	}
	if (!approvalRosterMatches) return rejected("approval-mismatch");
	const detached = detachedOperation(opened.bytes, payload, opened.intent.clientOperationId, approvals);
	const verified = Object.freeze({
		clientOperationId: opened.intent.clientOperationId,
		intentDigest: hex(opened.digest),
		operation: detached,
	});
	verifiedStates.set(
		verified,
		Object.freeze({ clientOperationId: verified.clientOperationId, intentDigest: verified.intentDigest })
	);
	return Object.freeze({ ok: true as const, verified });
}

/** Verify either the public proof or its durable blueprint carrier against one authenticated room context. */
export function verifyOutcomeCommitAdmissionOperation(
	input: Readonly<{
		readonly expectedAclDigest: string;
		readonly expectedAnchorDigest: string;
		readonly expectedEpoch: number;
		readonly expectedObjectId: string;
		readonly operation: Readonly<Record<string, unknown>>;
	}>
): OutcomeCommitVerificationResult {
	const record = exactRecord(input, VERIFY_KEYS);
	const proof = admissionProof(record?.operation);
	if (record === undefined || proof === undefined) return rejected("malformed-proof");
	return verifyOutcomeCommitOperation({
		expectedAclDigest: record.expectedAclDigest as string,
		expectedAnchorDigest: record.expectedAnchorDigest as string,
		expectedEpoch: record.expectedEpoch as number,
		expectedObjectId: record.expectedObjectId as string,
		operation: proof,
	});
}

/** Create the bounded replay/conflict owner used by later pre-journal admission. */
export function createOutcomeCommitRegistry(input: Readonly<{ readonly maxEntries: number }>): OutcomeCommitRegistry {
	const record = exactRecord(input, ["maxEntries"]);
	if (
		record === undefined ||
		!Number.isSafeInteger(record.maxEntries) ||
		(record.maxEntries as number) < 1 ||
		(record.maxEntries as number) > 8_192
	) {
		throw new TypeError("outcome registry maxEntries is invalid");
	}
	const maxEntries = record.maxEntries as number;
	const entries = new Map<string, string>();
	const classify = (value: VerifiedOutcomeCommit): "conflict" | "duplicate" | "fresh" | "full" => {
		const state = verifiedStates.get(value);
		if (state === undefined) throw new TypeError("outcome registry requires a verified commit");
		const existing = entries.get(state.clientOperationId);
		if (existing !== undefined) return existing === state.intentDigest ? "duplicate" : "conflict";
		return entries.size >= maxEntries ? "full" : "fresh";
	};
	return Object.freeze({
		get size(): number {
			return entries.size;
		},
		classify,
		commit(value: VerifiedOutcomeCommit): "committed" | "conflict" | "duplicate" | "full" {
			const result = classify(value);
			if (result !== "fresh") return result;
			const state = verifiedStates.get(value);
			if (state === undefined) throw new TypeError("outcome registry requires a verified commit");
			entries.set(state.clientOperationId, state.intentDigest);
			return "committed";
		},
	});
}

/** Create one fresh replay/conflict policy bound to an authenticated room context. */
export function createOutcomeCommitAdmissionPolicy(
	input: Readonly<{
		readonly aclDigest: string;
		readonly anchorDigest: string;
		readonly epoch: number;
		readonly maxEntries: number;
		readonly objectId: string;
	}>
): OutcomeCommitAdmissionPolicy {
	const record = exactRecord(input, ADMISSION_POLICY_KEYS);
	if (
		record === undefined ||
		typeof record.aclDigest !== "string" ||
		!DIGEST.test(record.aclDigest) ||
		typeof record.anchorDigest !== "string" ||
		!DIGEST.test(record.anchorDigest) ||
		!Number.isSafeInteger(record.epoch) ||
		(record.epoch as number) < 0 ||
		(record.epoch as number) > 0xffff_ffff ||
		typeof record.objectId !== "string" ||
		!OBJECT_ID.test(record.objectId)
	) {
		throw new TypeError("outcome admission policy context is invalid");
	}
	const registry = createOutcomeCommitRegistry({ maxEntries: record.maxEntries as number });
	const ordinaryReservation = (): Extract<OutcomeCommitAdmissionReservation, { readonly kind: "fresh" }> => {
		let active = true;
		return Object.freeze({
			commit(): "committed" {
				if (!active) throw new TypeError("outcome admission reservation was already consumed");
				active = false;
				return "committed";
			},
			kind: "fresh" as const,
			release(): void {
				active = false;
			},
		});
	};
	return Object.freeze({
		get size(): number {
			return registry.size;
		},
		reserve(operation: Readonly<Record<string, unknown>>): OutcomeCommitAdmissionReservation {
			const action = Reflect.get(operation, "action");
			if (action === "applicationBatch") {
				const batch = Reflect.get(operation, "batch");
				const entries = batch !== null && typeof batch === "object" ? Reflect.get(batch, "entries") : undefined;
				if (
					Array.isArray(entries) &&
					entries.some((entry) => {
						const child = entry !== null && typeof entry === "object" ? Reflect.get(entry, "operation") : undefined;
						return child !== null && typeof child === "object" && Reflect.get(child, "action") === "commit-outcome-v1";
					})
				) {
					return Object.freeze({ kind: "rejected" as const });
				}
				return ordinaryReservation();
			}
			if (action !== "commit-outcome-v1") return ordinaryReservation();
			const verified = verifyOutcomeCommitAdmissionOperation({
				expectedAclDigest: record.aclDigest as string,
				expectedAnchorDigest: record.anchorDigest as string,
				expectedEpoch: record.epoch as number,
				expectedObjectId: record.objectId as string,
				operation,
			});
			if (!verified.ok) return Object.freeze({ kind: "rejected" as const });
			const classification = registry.classify(verified.verified);
			if (classification === "duplicate" || classification === "conflict") {
				return Object.freeze({ kind: classification });
			}
			if (classification !== "fresh") return Object.freeze({ kind: "rejected" as const });
			let active = true;
			return Object.freeze({
				commit(): "committed" {
					if (!active) throw new TypeError("outcome admission reservation was already consumed");
					const committed = registry.commit(verified.verified);
					if (committed !== "committed") throw new TypeError("outcome admission registry changed during commit");
					active = false;
					return committed;
				},
				kind: "fresh" as const,
				release(): void {
					active = false;
				},
			});
		},
	});
}
