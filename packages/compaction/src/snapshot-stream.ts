import {
	decodeSnapshotManifest,
	type SnapshotChunkDescriptor,
	snapshotChunkDigest,
	type SnapshotTransferProfile,
} from "@ts-drp/protocol-v3/snapshot-transfer";

import { createBlueprintSnapshotPayloadHashStream } from "./blueprint-snapshot.js";
import { copyExactByteCarrier } from "./exact-byte-carrier.js";

export interface SnapshotChunkSource {
	read(
		descriptor: SnapshotChunkDescriptor,
		options: Readonly<{ readonly signal: AbortSignal }>
	): Promise<Uint8Array | undefined>;
}

export interface SnapshotQuarantinePort {
	discard(): Promise<void>;
	read(descriptor: SnapshotChunkDescriptor): Promise<Uint8Array | undefined>;
	write(descriptor: SnapshotChunkDescriptor, exactBytes: Uint8Array): Promise<void>;
}

export type SnapshotStreamFailureCode =
	| "aborted"
	| "chunk-digest-mismatch"
	| "chunk-invalid-carrier"
	| "chunk-length-mismatch"
	| "chunk-missing"
	| "manifest-digest-mismatch"
	| "manifest-invalid"
	| "manifest-noncanonical"
	| "manifest-too-large"
	| "payload-digest-mismatch"
	| "quarantine-failed"
	| "source-failed";

export interface SnapshotStreamCompletion {
	readonly chunkCount: number;
	readonly exactByteLength: number;
	readonly manifestDigest: string;
	readonly payloadDigest: string;
}

export interface VerifiedSnapshotStream extends AsyncIterable<Uint8Array> {
	readonly completion: Promise<SnapshotStreamCompletion>;
}

export interface VerifySnapshotStreamInput {
	readonly exactCanonicalManifestBytes: Uint8Array;
	readonly expectedManifestDigest: string;
	readonly profile: SnapshotTransferProfile;
	readonly quarantine: SnapshotQuarantinePort;
	readonly signal?: AbortSignal;
	readonly source: SnapshotChunkSource;
}

interface VerifiedState {
	readonly chunks: readonly SnapshotChunkDescriptor[];
	readonly completion: SnapshotStreamCompletion;
}

interface CapturedVerifySnapshotStreamInput {
	readonly exactCanonicalManifestBytes: Uint8Array;
	readonly expectedManifestDigest: string;
	readonly profile: SnapshotTransferProfile;
	quarantineDiscard(): Promise<void>;
	quarantineRead(descriptor: SnapshotChunkDescriptor): Promise<Uint8Array | undefined>;
	quarantineWrite(descriptor: SnapshotChunkDescriptor, exactBytes: Uint8Array): Promise<void>;
	readonly signal: AbortSignal | undefined;
	sourceRead(
		descriptor: SnapshotChunkDescriptor,
		options: Readonly<{ readonly signal: AbortSignal }>
	): Promise<Uint8Array | undefined>;
}

const intrinsicReflectApply = Reflect.apply;

class SnapshotStreamError extends Error {
	readonly code: SnapshotStreamFailureCode;

	constructor(code: SnapshotStreamFailureCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.code = code;
	}
}

function hex(bytes: Uint8Array): string {
	let output = "";
	for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
	return output;
}

function failureCode(error: unknown): SnapshotStreamFailureCode | undefined {
	if (error === null || typeof error !== "object") return undefined;
	const code = Reflect.get(error, "code");
	return typeof code === "string" &&
		[
			"aborted",
			"chunk-digest-mismatch",
			"chunk-invalid-carrier",
			"chunk-length-mismatch",
			"chunk-missing",
			"manifest-digest-mismatch",
			"manifest-invalid",
			"manifest-noncanonical",
			"manifest-too-large",
			"payload-digest-mismatch",
			"quarantine-failed",
			"source-failed",
		].includes(code)
		? (code as SnapshotStreamFailureCode)
		: undefined;
}

function streamFailure(code: SnapshotStreamFailureCode, message: string, cause?: unknown): SnapshotStreamError {
	return new SnapshotStreamError(code, message, cause === undefined ? undefined : { cause });
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw streamFailure("aborted", "snapshot verification was aborted", signal.reason);
}

function copyChunkCarrier(descriptor: SnapshotChunkDescriptor, bytes: Uint8Array): Uint8Array {
	try {
		return copyExactByteCarrier(bytes, "snapshot chunk", { maxBytes: descriptor.byteLength });
	} catch (error) {
		throw streamFailure("chunk-invalid-carrier", "snapshot chunk carrier is invalid", error);
	}
}

function verifyChunk(descriptor: SnapshotChunkDescriptor, input: Uint8Array): Uint8Array {
	const bytes = copyChunkCarrier(descriptor, input);
	if (bytes.byteLength !== descriptor.byteLength) {
		throw streamFailure("chunk-length-mismatch", "snapshot chunk length does not match its descriptor");
	}
	if (snapshotChunkDigest(descriptor.index, bytes) !== descriptor.digest) {
		throw streamFailure("chunk-digest-mismatch", "snapshot chunk digest does not match its descriptor");
	}
	return bytes;
}

async function discardAfterFailure(discard: () => Promise<void>, error: unknown): Promise<never> {
	try {
		await discard();
	} catch (discardError) {
		throw streamFailure(
			"quarantine-failed",
			"snapshot quarantine discard failed",
			new AggregateError([error, discardError], "snapshot verification and quarantine discard both failed")
		);
	}
	if (error instanceof SnapshotStreamError || failureCode(error) !== undefined) throw error;
	throw streamFailure("source-failed", "snapshot verification failed", error);
}

async function readQuarantine(
	read: (descriptor: SnapshotChunkDescriptor) => Promise<Uint8Array | undefined>,
	descriptor: SnapshotChunkDescriptor
): Promise<Uint8Array | undefined> {
	try {
		return await read(descriptor);
	} catch (error) {
		throw streamFailure("quarantine-failed", "snapshot quarantine read failed", error);
	}
}

function captureMethod<Arguments extends readonly unknown[], Result>(
	receiver: object,
	name: string,
	method: (...arguments_: Arguments) => Result
): (...arguments_: Arguments) => Result {
	if (typeof method !== "function") throw new TypeError(`${name} must be a function`);
	return (...arguments_: Arguments): Result => intrinsicReflectApply(method, receiver, arguments_) as Result;
}

function captureInput(input: VerifySnapshotStreamInput): CapturedVerifySnapshotStreamInput {
	const exactCanonicalManifestBytes = input.exactCanonicalManifestBytes;
	const expectedManifestDigest = input.expectedManifestDigest;
	const suppliedProfile = input.profile;
	const quarantine = input.quarantine;
	const source = input.source;
	const signal = input.signal;
	const profile: SnapshotTransferProfile = Object.freeze({
		maxManifestBytes: suppliedProfile.maxManifestBytes,
		maxSnapshotBytes: suppliedProfile.maxSnapshotBytes,
		snapshotChunkBytes: suppliedProfile.snapshotChunkBytes,
	});
	const quarantineDiscard = captureMethod(quarantine, "quarantine.discard", quarantine.discard);
	const quarantineRead = captureMethod(quarantine, "quarantine.read", quarantine.read);
	const quarantineWrite = captureMethod(quarantine, "quarantine.write", quarantine.write);
	const sourceRead = captureMethod(source, "source.read", source.read);
	return Object.freeze({
		exactCanonicalManifestBytes,
		expectedManifestDigest,
		profile,
		quarantineDiscard,
		quarantineRead,
		quarantineWrite,
		signal,
		sourceRead,
	});
}

async function verifyInput(input: CapturedVerifySnapshotStreamInput, signal: AbortSignal): Promise<VerifiedState> {
	try {
		throwIfAborted(signal);
		const decoded = decodeSnapshotManifest({
			exactCanonicalManifestBytes: input.exactCanonicalManifestBytes,
			expectedManifestDigest: input.expectedManifestDigest,
			profile: input.profile,
		});
		const payloadDigest = decoded.manifest.payloadDigest;
		if (typeof payloadDigest !== "string") {
			throw streamFailure("manifest-invalid", "snapshot manifest payloadDigest is invalid");
		}
		const totalBytes = decoded.manifest.totalBytes;
		if (typeof totalBytes !== "number") {
			throw streamFailure("manifest-invalid", "snapshot manifest totalBytes is invalid");
		}
		const payloadHasher = createBlueprintSnapshotPayloadHashStream(totalBytes);
		for (const descriptor of decoded.chunks) {
			throwIfAborted(signal);
			let carrier = await readQuarantine(input.quarantineRead, descriptor);
			let fetched = false;
			if (carrier === undefined) {
				try {
					carrier = await input.sourceRead(descriptor, { signal });
				} catch (error) {
					throwIfAborted(signal);
					throw streamFailure("source-failed", "snapshot chunk source failed", error);
				}
				throwIfAborted(signal);
				if (carrier === undefined) {
					throw streamFailure("chunk-missing", "snapshot chunk source omitted a required descriptor");
				}
				fetched = true;
			}
			const bytes = verifyChunk(descriptor, carrier);
			payloadHasher.update(bytes);
			if (fetched) {
				try {
					await input.quarantineWrite(descriptor, bytes);
				} catch (error) {
					throw streamFailure("quarantine-failed", "snapshot quarantine write failed", error);
				}
				throwIfAborted(signal);
			}
		}
		throwIfAborted(signal);
		const actualPayloadDigest = hex(payloadHasher.digest());
		if (actualPayloadDigest !== payloadDigest) {
			throw streamFailure("payload-digest-mismatch", "snapshot payload digest does not match verified chunks");
		}
		return Object.freeze({
			chunks: decoded.chunks,
			completion: Object.freeze({
				chunkCount: decoded.chunks.length,
				exactByteLength: totalBytes,
				manifestDigest: decoded.manifestDigest,
				payloadDigest: actualPayloadDigest,
			}),
		});
	} catch (error) {
		return discardAfterFailure(input.quarantineDiscard, error);
	}
}

/**
 * Verifies a bounded snapshot into quarantine before exposing canonical iteration.
 * @param input
 */
export function verifySnapshotStream(input: VerifySnapshotStreamInput): VerifiedSnapshotStream {
	const captured = captureInput(input);
	const controller = new AbortController();
	const forwardAbort = (): void => controller.abort(captured.signal?.reason);
	if (captured.signal?.aborted === true) forwardAbort();
	else captured.signal?.addEventListener("abort", forwardAbort, { once: true });
	let verifiedState: VerifiedState | undefined;
	const completion = verifyInput(captured, controller.signal)
		.then((state) => {
			verifiedState = state;
			return state.completion;
		})
		.finally(() => captured.signal?.removeEventListener("abort", forwardAbort));

	return Object.freeze({
		completion,
		async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
			await completion;
			const state = verifiedState;
			if (state === undefined) throw streamFailure("source-failed", "verified snapshot state is unavailable");
			for (const descriptor of state.chunks) {
				const carrier = await readQuarantine(captured.quarantineRead, descriptor);
				if (carrier === undefined) {
					throw streamFailure("chunk-missing", "verified quarantine omitted a required chunk");
				}
				const bytes = verifyChunk(descriptor, carrier);
				yield bytes;
			}
		},
	});
}
