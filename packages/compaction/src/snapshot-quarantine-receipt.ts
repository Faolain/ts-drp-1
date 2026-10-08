import { decodeSnapshotManifest, type SnapshotChunkDescriptor } from "@ts-drp/protocol-v3/snapshot-transfer";

import { copyExactByteCarrier } from "./exact-byte-carrier.js";
import {
	type SnapshotQuarantinePort,
	type SnapshotStreamCompletion,
	type VerifiedSnapshotStream,
	verifySnapshotStream,
} from "./snapshot-stream.js";

export interface SnapshotQuarantineScopeKey {
	readonly anchor: string;
	readonly epoch: number;
	readonly manifestDigest: string;
	readonly objectId: string;
}

export interface SnapshotVerificationQuarantine {
	open(signal: AbortSignal): SnapshotQuarantinePort;
}

export type SnapshotVerificationReceipt = Readonly<Record<never, never>>;

export interface ReceiptVerifiedSnapshotStream extends AsyncIterable<Uint8Array> {
	readonly completion: Promise<SnapshotStreamCompletion>;
	readonly receipt: Promise<SnapshotVerificationReceipt>;
}

export type VerifySnapshotStreamWithReceiptInput = Readonly<{
	readonly exactCanonicalManifestBytes: Uint8Array;
	readonly expectedManifestDigest: string;
	readonly expectedScope: SnapshotQuarantineScopeKey;
	readonly profile: Readonly<{
		readonly maxManifestBytes: 212_387;
		readonly maxSnapshotBytes: 268_435_456;
		readonly snapshotChunkBytes: 131_072;
	}>;
	readonly quarantine: SnapshotVerificationQuarantine;
	readonly signal?: AbortSignal;
	readonly source: Readonly<{
		read(
			descriptor: SnapshotChunkDescriptor,
			options: Readonly<{ readonly signal: AbortSignal }>
		): Promise<Uint8Array | undefined>;
	}>;
}>;

type ReceiptRecord = Readonly<{
	readonly completion: SnapshotStreamCompletion;
	readonly quarantine: SnapshotVerificationQuarantine;
	readonly scope: SnapshotQuarantineScopeKey;
}>;

const MAX_MANIFEST_BYTES = 212_387 as const;
const receipts = new WeakMap<SnapshotVerificationReceipt, ReceiptRecord>();
const intrinsicReflectApply = Reflect.apply;

class ReceiptError extends Error {
	readonly code = "receipt-invalid" as const;
}

function invalidReceipt(): never {
	throw new ReceiptError("snapshot verification receipt is invalid");
}

function closedRecord(value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> {
	if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
	const actual = Reflect.ownKeys(value);
	return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function captureScope(value: unknown): SnapshotQuarantineScopeKey {
	if (!closedRecord(value, ["anchor", "epoch", "manifestDigest", "objectId"])) invalidReceipt();
	const { anchor, epoch, manifestDigest, objectId } = value;
	if (
		typeof anchor !== "string" ||
		!/^[0-9a-f]{64}$/u.test(anchor) ||
		typeof epoch !== "number" ||
		!Number.isSafeInteger(epoch) ||
		epoch < 0 ||
		typeof manifestDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(manifestDigest) ||
		typeof objectId !== "string" ||
		objectId.length === 0
	) {
		invalidReceipt();
	}
	return Object.freeze({ anchor, epoch, manifestDigest, objectId });
}

function captureProfile(value: unknown): VerifySnapshotStreamWithReceiptInput["profile"] {
	if (!closedRecord(value, ["maxManifestBytes", "maxSnapshotBytes", "snapshotChunkBytes"])) invalidReceipt();
	if (
		value.maxManifestBytes !== MAX_MANIFEST_BYTES ||
		value.maxSnapshotBytes !== 268_435_456 ||
		value.snapshotChunkBytes !== 131_072
	) {
		invalidReceipt();
	}
	return Object.freeze({
		maxManifestBytes: MAX_MANIFEST_BYTES,
		maxSnapshotBytes: 268_435_456,
		snapshotChunkBytes: 131_072,
	});
}

function sameScope(left: SnapshotQuarantineScopeKey, right: SnapshotQuarantineScopeKey): boolean {
	return (
		left.anchor === right.anchor &&
		left.epoch === right.epoch &&
		left.manifestDigest === right.manifestDigest &&
		left.objectId === right.objectId
	);
}

function captureMethod<Arguments extends readonly unknown[], Result>(
	receiver: object,
	method: (...arguments_: Arguments) => Result
): (...arguments_: Arguments) => Result {
	if (typeof method !== "function") invalidReceipt();
	return (...arguments_: Arguments): Result => intrinsicReflectApply(method, receiver, arguments_) as Result;
}

function abortFailure(signal: AbortSignal): never {
	const error = new Error("snapshot verification was aborted", { cause: signal.reason });
	Object.defineProperty(error, "code", { enumerable: true, value: "aborted" });
	throw error;
}

/**
 * Verifies through the signed 4c-a owner and mints one private terminal receipt.
 * @param input - Exact manifest, scope, quarantine and genuine chunk source.
 * @returns Receipt-gated verified stream.
 */
export function verifySnapshotStreamWithReceipt(
	input: VerifySnapshotStreamWithReceiptInput
): ReceiptVerifiedSnapshotStream {
	if (input === null || typeof input !== "object") invalidReceipt();
	const inputFields = [
		"exactCanonicalManifestBytes",
		"expectedManifestDigest",
		"expectedScope",
		"profile",
		"quarantine",
		"source",
	];
	if (Reflect.has(input, "signal")) inputFields.push("signal");
	if (!closedRecord(input, inputFields)) {
		invalidReceipt();
	}
	const scope = captureScope(input.expectedScope);
	const profile = captureProfile(input.profile);
	const exactCanonicalManifestBytes = copyExactByteCarrier(input.exactCanonicalManifestBytes, "snapshot manifest", {
		maxBytes: MAX_MANIFEST_BYTES,
	});
	const decoded = decodeSnapshotManifest({
		exactCanonicalManifestBytes,
		expectedManifestDigest: input.expectedManifestDigest,
		profile,
	});
	if (
		decoded.manifest.anchor !== scope.anchor ||
		decoded.manifest.epoch !== scope.epoch ||
		decoded.manifest.objectId !== scope.objectId ||
		decoded.manifestDigest !== scope.manifestDigest
	) {
		invalidReceipt();
	}
	const quarantine = input.quarantine;
	if (quarantine === null || typeof quarantine !== "object") invalidReceipt();
	const open = captureMethod(quarantine, quarantine.open);
	const controller = new AbortController();
	const forwardAbort = (): void => controller.abort(input.signal?.reason);
	if (input.signal?.aborted === true) forwardAbort();
	else input.signal?.addEventListener("abort", forwardAbort, { once: true });
	const durablePort = open(controller.signal);
	const discard = captureMethod(durablePort, durablePort.discard);
	const read = captureMethod(durablePort, durablePort.read);
	const write = captureMethod(durablePort, durablePort.write);
	const checkedPort: SnapshotQuarantinePort = Object.freeze({
		discard,
		read: (descriptor: SnapshotChunkDescriptor) => {
			if (controller.signal.aborted) abortFailure(controller.signal);
			return read(descriptor);
		},
		write: (descriptor: SnapshotChunkDescriptor, exactBytes: Uint8Array) => {
			if (controller.signal.aborted) abortFailure(controller.signal);
			return write(descriptor, exactBytes);
		},
	});
	const verified: VerifiedSnapshotStream = verifySnapshotStream({
		exactCanonicalManifestBytes,
		expectedManifestDigest: scope.manifestDigest,
		profile,
		quarantine: checkedPort,
		signal: controller.signal,
		source: input.source,
	});
	const receipt = verified.completion.then((completion) => {
		const token: SnapshotVerificationReceipt = Object.freeze({});
		receipts.set(token, Object.freeze({ completion: Object.freeze({ ...completion }), quarantine, scope }));
		return token;
	});
	const cleanup = (): void => input.signal?.removeEventListener("abort", forwardAbort);
	void receipt.then(cleanup, cleanup);
	return Object.freeze({
		completion: verified.completion,
		receipt,
		[Symbol.asyncIterator]: () => verified[Symbol.asyncIterator](),
	});
}

/**
 * Consumes one exact private receipt before returning its detached completion.
 * @param input - Exact receipt, scope and quarantine identity.
 * @returns Detached terminal verification completion.
 */
export function consumeSnapshotVerificationReceipt(
	input: Readonly<{
		readonly expectedScope: SnapshotQuarantineScopeKey;
		readonly quarantine: SnapshotVerificationQuarantine;
		readonly receipt: SnapshotVerificationReceipt;
	}>
): SnapshotStreamCompletion {
	if (!closedRecord(input, ["expectedScope", "quarantine", "receipt"])) invalidReceipt();
	const record = receipts.get(input.receipt);
	if (record === undefined) invalidReceipt();
	const scope = captureScope(input.expectedScope);
	if (record.quarantine !== input.quarantine || !sameScope(record.scope, scope)) invalidReceipt();
	receipts.delete(input.receipt);
	return Object.freeze({ ...record.completion });
}
