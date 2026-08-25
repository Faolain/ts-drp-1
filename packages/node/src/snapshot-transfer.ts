import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import {
	type SnapshotVerificationReceipt,
	verifySnapshotStreamWithReceipt,
} from "@ts-drp/compaction/snapshot-quarantine-receipt";
import type { MessageQueueManager } from "@ts-drp/message-queue";
import type { SnapshotChunkProtocolPort, SnapshotChunkProtocolStream } from "@ts-drp/network/snapshot-transfer";
import {
	decodeSnapshotManifest,
	type SnapshotChunkDescriptor,
	snapshotChunkDigest,
} from "@ts-drp/protocol-v3/snapshot-transfer";
import type { SnapshotQuarantineScope, VerifiedSnapshotQuarantineReference } from "@ts-drp/storage/snapshot-transfer";
import type { DRPNetworkNode, Message } from "@ts-drp/types";

import {
	claimRecoveredV3LiveAuthority,
	discardRecoveredV3LiveAuthorityClaim,
	type RecoveredV3LiveAuthorityClaim,
	restoreRecoveredV3LiveAuthority,
} from "./v3-live-recovered-authority.js";
import {
	activateV3LivePlane,
	bindV3BlueprintLivePlane,
	type RecoveredV3Live,
	type V3AdmittedVertexSink,
} from "./v3-live.js";

export const SNAPSHOT_PULL_INACTIVITY_MS = 10_000 as const;
export const SNAPSHOT_PULL_TOTAL_MS = 120_000 as const;
export const SNAPSHOT_PULL_MAX_ATTEMPTS = 3 as const;
export const SNAPSHOT_PULL_MAX_OUTSTANDING = 4 as const;
export const SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS = 4 as const;

const MAX_BODY_BYTES = 131_072;
const MAX_MANIFEST_BYTES = 212_387;
const MAX_SNAPSHOT_BYTES = 268_435_456;
const PROFILE = Object.freeze({
	maxManifestBytes: MAX_MANIFEST_BYTES as 212_387,
	maxSnapshotBytes: MAX_SNAPSHOT_BYTES as 268_435_456,
	snapshotChunkBytes: MAX_BODY_BYTES as 131_072,
});
const MANIFEST_REQUEST_FIELDS = ["kind", "manifestDigest", "version"] as const;
const MANIFEST_RESPONSE_FIELDS = ["exactCanonicalManifestBytes", "kind", "manifestDigest", "version"] as const;
const CHUNK_REQUEST_FIELDS = ["descriptors", "kind", "manifestDigest", "version"] as const;
const REQUEST_DESCRIPTOR_FIELDS = ["digest", "index"] as const;
const CHUNK_RESPONSE_FIELDS = ["byteLength", "digest", "index", "kind", "manifestDigest", "version"] as const;
const activeScopePeers = new Set<string>();
let activeSessionCount = 0;

export type SnapshotPullFailureCode =
	| "aborted"
	| "authorization-rejected"
	| "body-budget-exceeded"
	| "chunk-invalid"
	| "connection-unavailable"
	| "inactivity-timeout"
	| "manifest-invalid"
	| "protocol-violation"
	| "quarantine-failed"
	| "session-capacity"
	| "total-timeout"
	| "transfer-exhausted";

export interface SnapshotPeerAuthorization {
	authorForPeer(peerId: string): string | undefined;
	isAuthorizedAuthor(author: string): boolean;
}

export interface SnapshotTransferStats {
	readonly attemptedPeers: readonly string[];
	readonly exactReceivedBytes: number;
	readonly fetchedIndices: readonly number[];
	readonly reusedIndices: readonly number[];
}

export type VerifiedSnapshotTransfer = Readonly<Record<never, never>>;

export interface SnapshotTransferResult {
	readonly reference: Readonly<{
		readonly chunkCount: number;
		readonly exactByteLength: number;
		readonly scope: Readonly<{
			readonly anchor: string;
			readonly epoch: number;
			readonly manifestDigest: string;
			readonly objectId: string;
		}>;
	}>;
	readonly stats: SnapshotTransferStats;
	readonly verified: VerifiedSnapshotTransfer;
}

export interface SnapshotActivationResult {
	readonly blueprint: object;
	readonly plane: object;
	readonly reference: SnapshotTransferResult["reference"];
}

export interface V3SnapshotTransferOwner {
	activateSmallSnapshot(
		input: Readonly<{
			readonly expectedApplicationStateDigest: string;
			readonly expectedPayloadDigest: string;
			readonly transfer: VerifiedSnapshotTransfer;
		}>
	): SnapshotActivationResult;
	close(): Promise<void>;
	receive(
		input: Readonly<{
			readonly authorization: SnapshotPeerAuthorization;
			readonly capability: object;
			readonly descriptors: readonly SnapshotChunkDescriptor[];
			readonly exactCanonicalManifestBytes: Uint8Array;
			readonly expectedManifestDigest: string;
			readonly messageQueueManager: MessageQueueManager<Message>;
			readonly networkNode: DRPNetworkNode;
			onAdmittedVertex(...arguments_: readonly unknown[]): unknown;
			readonly peers: readonly string[];
			readonly quarantine: SnapshotQuarantineScope<object>;
			readonly signal?: AbortSignal;
		}>
	): Promise<SnapshotTransferResult>;
	serve(
		input: Readonly<{
			readonly authorization: SnapshotPeerAuthorization;
			readonly descriptors: readonly SnapshotChunkDescriptor[];
			readonly exactCanonicalManifestBytes: Uint8Array;
			readonly quarantine: SnapshotQuarantineScope<object>;
		}>
	): () => void;
}

interface CapturedAuthorization {
	authorForPeer(peerId: string): string | undefined;
	isAuthorizedAuthor(author: string): boolean;
}

interface TransferRecord {
	readonly claim: RecoveredV3LiveAuthorityClaim;
	readonly exactCanonicalPayloadBytes: Uint8Array | undefined;
	readonly messageQueueManager: MessageQueueManager<Message>;
	readonly networkNode: DRPNetworkNode;
	readonly onAdmittedVertex: V3AdmittedVertexSink;
	readonly owner: object;
	readonly reference: VerifiedSnapshotQuarantineReference;
}

class SnapshotPullError extends Error {
	readonly code: SnapshotPullFailureCode;

	constructor(code: SnapshotPullFailureCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.code = code;
	}
}

const transfers = new WeakMap<VerifiedSnapshotTransfer, TransferRecord>();
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectPrototype = Object.prototype;
const ReflectApply = Reflect.apply;
const ReflectOwnKeys = Reflect.ownKeys;
const Uint8ArrayConstructor = Uint8Array;
const Uint8ArrayPrototype = Uint8Array.prototype;
const Uint8ArraySet = Uint8Array.prototype.set;
const ArrayBufferPrototype = ArrayBuffer.prototype;
const ArrayBufferByteLengthGetter = ObjectGetOwnPropertyDescriptor(ArrayBufferPrototype, "byteLength")?.get;
const ArrayBufferResizableGetter = ObjectGetOwnPropertyDescriptor(ArrayBufferPrototype, "resizable")?.get;
const TypedArrayPrototype = ObjectGetPrototypeOf(Uint8ArrayPrototype) as object;
const TypedArrayBufferGetter = ObjectGetOwnPropertyDescriptor(TypedArrayPrototype, "buffer")?.get;
const TypedArrayByteLengthGetter = ObjectGetOwnPropertyDescriptor(TypedArrayPrototype, "byteLength")?.get;
const TypedArrayByteOffsetGetter = ObjectGetOwnPropertyDescriptor(TypedArrayPrototype, "byteOffset")?.get;

function failure(code: SnapshotPullFailureCode, message: string, cause?: unknown): SnapshotPullError {
	return new SnapshotPullError(code, message, cause);
}

function copyExactBytes(input: Uint8Array, name: string, maxBytes: number): Uint8Array {
	try {
		if (ObjectGetPrototypeOf(input) !== Uint8ArrayPrototype) throw new TypeError(`${name} is not a Uint8Array`);
		const byteLength = ReflectApply(TypedArrayByteLengthGetter as (this: Uint8Array) => number, input, []) as number;
		const byteOffset = ReflectApply(TypedArrayByteOffsetGetter as (this: Uint8Array) => number, input, []) as number;
		const buffer = ReflectApply(
			TypedArrayBufferGetter as (this: Uint8Array) => ArrayBufferLike,
			input,
			[]
		) as ArrayBufferLike;
		if (ObjectGetPrototypeOf(buffer) !== ArrayBufferPrototype) throw new TypeError(`${name} is shared`);
		const bufferByteLength = ReflectApply(
			ArrayBufferByteLengthGetter as (this: ArrayBuffer) => number,
			buffer,
			[]
		) as number;
		const resizable =
			ArrayBufferResizableGetter === undefined
				? false
				: (ReflectApply(ArrayBufferResizableGetter as (this: ArrayBuffer) => boolean, buffer, []) as boolean);
		if (byteLength === 0 || byteOffset !== 0 || byteLength !== bufferByteLength || byteLength > maxBytes || resizable) {
			throw new TypeError(`${name} is not an exact bounded carrier`);
		}
		const copy = new Uint8ArrayConstructor(byteLength);
		ReflectApply(Uint8ArraySet, copy, [input]);
		return copy;
	} catch (error) {
		throw failure("manifest-invalid", `${name} is invalid`, error);
	}
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
	return true;
}

function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const prototype = ObjectGetPrototypeOf(value);
	if (prototype !== null && prototype !== ObjectPrototype) return undefined;
	const keys = ReflectOwnKeys(value);
	if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) {
		return undefined;
	}
	return value as Readonly<Record<string, unknown>>;
}

function decodeRecord(bytes: Uint8Array, maxBytes: number): Readonly<Record<string, unknown>> | undefined {
	try {
		const decoded = decodeCanonical(bytes, { maxBytes });
		const encoded = encodeCanonical(decoded, { maxBytes });
		return sameBytes(bytes, encoded) && decoded !== null && typeof decoded === "object"
			? (decoded as Readonly<Record<string, unknown>>)
			: undefined;
	} catch {
		return undefined;
	}
}

function captureAuthorization(value: SnapshotPeerAuthorization): CapturedAuthorization {
	if (value === null || typeof value !== "object") throw failure("authorization-rejected", "authorization is invalid");
	const authorForPeer = value.authorForPeer;
	const isAuthorizedAuthor = value.isAuthorizedAuthor;
	if (typeof authorForPeer !== "function" || typeof isAuthorizedAuthor !== "function") {
		throw failure("authorization-rejected", "authorization is invalid");
	}
	return Object.freeze({
		authorForPeer: (peerId: string): string | undefined =>
			ReflectApply(authorForPeer, value, [peerId]) as string | undefined,
		isAuthorizedAuthor: (author: string): boolean => ReflectApply(isAuthorizedAuthor, value, [author]) === true,
	});
}

function capturePeers(value: readonly string[]): readonly string[] {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.some((peer) => typeof peer !== "string" || peer.length === 0)
	) {
		throw failure("connection-unavailable", "snapshot peers are invalid");
	}
	return Object.freeze([...new Set(value)]);
}

function sameDescriptor(left: SnapshotChunkDescriptor, right: SnapshotChunkDescriptor): boolean {
	return left.index === right.index && left.byteLength === right.byteLength && left.digest === right.digest;
}

function nestedFailureCode(error: unknown): SnapshotPullFailureCode | undefined {
	let current = error;
	let firstCode: SnapshotPullFailureCode | undefined;
	for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth += 1) {
		const code = Reflect.get(current, "code");
		if (
			typeof code === "string" &&
			[
				"aborted",
				"authorization-rejected",
				"body-budget-exceeded",
				"chunk-invalid",
				"connection-unavailable",
				"inactivity-timeout",
				"manifest-invalid",
				"protocol-violation",
				"quarantine-failed",
				"session-capacity",
				"total-timeout",
				"transfer-exhausted",
			].includes(code)
		) {
			if (code === "total-timeout") return "total-timeout";
			firstCode ??= code as SnapshotPullFailureCode;
		}
		current = Reflect.get(current, "cause");
	}
	return firstCode;
}

function sessionKey(scope: SnapshotQuarantineScope<object>["scope"], peerId: string): string {
	return `${scope.objectId}\u0000${scope.epoch}\u0000${scope.anchor}\u0000${scope.manifestDigest}\u0000${peerId}`;
}

function throwIfAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	const reasonCode = nestedFailureCode(signal.reason);
	throw failure(
		reasonCode === "total-timeout" ? "total-timeout" : "aborted",
		"snapshot transfer was aborted",
		signal.reason
	);
}

function linkedController(
	parent: AbortSignal,
	timeoutMs: number,
	timeoutCode: SnapshotPullFailureCode
): {
	readonly controller: AbortController;
	dispose(): void;
} {
	const controller = new AbortController();
	const onAbort = (): void => controller.abort(parent.reason);
	if (parent.aborted) onAbort();
	else parent.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(failure(timeoutCode, "snapshot transfer timed out")), timeoutMs);
	return Object.freeze({
		controller,
		dispose: (): void => {
			clearTimeout(timer);
			parent.removeEventListener("abort", onAbort);
		},
	});
}

async function readFrame(
	stream: SnapshotChunkProtocolStream,
	maxBytes: number,
	totalSignal: AbortSignal
): Promise<Uint8Array> {
	const linked = linkedController(totalSignal, SNAPSHOT_PULL_INACTIVITY_MS, "inactivity-timeout");
	try {
		return await stream.read(maxBytes, { signal: linked.controller.signal });
	} catch (error) {
		const code = nestedFailureCode(linked.controller.signal.reason) ?? nestedFailureCode(error);
		if (code === "total-timeout" || code === "aborted") throwIfAborted(totalSignal);
		if (code === "inactivity-timeout") throw failure("inactivity-timeout", "snapshot peer was inactive", error);
		throw error;
	} finally {
		linked.dispose();
	}
}

function selectAuthorizedPeers(
	requested: readonly string[],
	connected: readonly string[],
	authorization: CapturedAuthorization
): readonly string[] {
	const connectedSet = new Set(connected);
	let connectedButUnauthorized = false;
	const selected = requested.filter((peerId) => {
		if (!connectedSet.has(peerId)) return false;
		const author = authorization.authorForPeer(peerId);
		const authorized = typeof author === "string" && authorization.isAuthorizedAuthor(author);
		if (!authorized) connectedButUnauthorized = true;
		return authorized;
	});
	if (selected.length === 0) {
		throw failure(
			connectedButUnauthorized ? "authorization-rejected" : "connection-unavailable",
			"no connected authorized snapshot peer is available"
		);
	}
	return Object.freeze(selected);
}

/** Creates one bounded snapshot pull and serving owner. */
export function createV3SnapshotTransferOwner(
	input: Readonly<{ readonly transport: SnapshotChunkProtocolPort }>
): V3SnapshotTransferOwner {
	const transport = input.transport;
	if (transport === null || typeof transport !== "object") throw new TypeError("snapshot transport is invalid");
	const connectedPeers = transport.connectedPeers.bind(transport);
	const open = transport.open.bind(transport);
	const installServer = transport.serve.bind(transport);
	const closeTransport = transport.close.bind(transport);
	const ownerIdentity = Object.freeze({});
	const ownerControllers = new Set<AbortController>();
	const ownerTransfers = new Set<VerifiedSnapshotTransfer>();
	let closed = false;
	let stopServing: (() => void) | undefined;

	const receive: V3SnapshotTransferOwner["receive"] = async (rawInput) => {
		if (closed) throw failure("aborted", "snapshot transfer owner is closed");
		const manifestCarrier = copyExactBytes(
			rawInput.exactCanonicalManifestBytes,
			"snapshot manifest",
			MAX_MANIFEST_BYTES
		);
		const expectedManifestDigest = rawInput.expectedManifestDigest;
		if (typeof expectedManifestDigest !== "string" || !/^[0-9a-f]{64}$/u.test(expectedManifestDigest)) {
			throw failure("manifest-invalid", "snapshot manifest digest is invalid");
		}
		let decoded: ReturnType<typeof decodeSnapshotManifest>;
		try {
			decoded = decodeSnapshotManifest({
				exactCanonicalManifestBytes: manifestCarrier,
				expectedManifestDigest,
				profile: PROFILE,
			});
		} catch (error) {
			throw failure("manifest-invalid", "snapshot manifest is invalid", error);
		}
		if (
			!Array.isArray(rawInput.descriptors) ||
			rawInput.descriptors.length !== decoded.chunks.length ||
			rawInput.descriptors.some(
				(descriptor, index) => !sameDescriptor(descriptor, decoded.chunks[index] as SnapshotChunkDescriptor)
			)
		) {
			throw failure("manifest-invalid", "snapshot descriptors do not match the manifest");
		}
		const peers = capturePeers(rawInput.peers);
		const authorization = captureAuthorization(rawInput.authorization);
		const quarantine = rawInput.quarantine as SnapshotQuarantineScope<SnapshotVerificationReceipt>;
		const messageQueueManager = rawInput.messageQueueManager;
		const networkNode = rawInput.networkNode;
		const onAdmittedVertex = rawInput.onAdmittedVertex as V3AdmittedVertexSink;
		const total = linkedController(
			rawInput.signal ?? new AbortController().signal,
			SNAPSHOT_PULL_TOTAL_MS,
			"total-timeout"
		);
		ownerControllers.add(total.controller);
		let reservedKeys: readonly string[] = [];
		let sessionReserved = false;
		let claim: RecoveredV3LiveAuthorityClaim | undefined;
		try {
			throwIfAborted(total.controller.signal);
			const candidates = selectAuthorizedPeers(peers, connectedPeers(), authorization);
			reservedKeys = candidates.map((peerId) => sessionKey(quarantine.scope, peerId));
			if (
				activeSessionCount >= SNAPSHOT_PULL_MAX_GLOBAL_SESSIONS ||
				reservedKeys.some((key) => activeScopePeers.has(key))
			) {
				throw failure("session-capacity", "snapshot transfer session capacity is exhausted");
			}
			claim = claimRecoveredV3LiveAuthority(rawInput.capability);
			if (claim === undefined) throw failure("authorization-rejected", "recovered snapshot authority is unavailable");
			activeSessionCount += 1;
			for (const key of reservedKeys) activeScopePeers.add(key);
			sessionReserved = true;
			const attemptedPeers: string[] = [];
			const failedPeers = new Set<string>();
			const validatedPeers = new Set<string>();
			let exactReceivedBytes = 0;
			const ensureManifest = async (peerId: string): Promise<void> => {
				if (validatedPeers.has(peerId)) return;
				const stream = await open(peerId, { signal: total.controller.signal });
				try {
					await stream.write(
						encodeCanonical({ kind: "snapshot-manifest-request", manifestDigest: expectedManifestDigest, version: 1 }),
						{ signal: total.controller.signal }
					);
					const responseBytes = await readFrame(stream, MAX_MANIFEST_BYTES, total.controller.signal);
					const response = exactRecord(decodeRecord(responseBytes, MAX_MANIFEST_BYTES), MANIFEST_RESPONSE_FIELDS);
					if (
						response === undefined ||
						response.kind !== "snapshot-manifest-response" ||
						response.version !== 1 ||
						response.manifestDigest !== expectedManifestDigest ||
						!(response.exactCanonicalManifestBytes instanceof Uint8Array) ||
						!sameBytes(response.exactCanonicalManifestBytes, manifestCarrier)
					) {
						throw failure("manifest-invalid", "snapshot peer returned a foreign manifest");
					}
					validatedPeers.add(peerId);
				} finally {
					await stream.close().catch(() => undefined);
				}
			};
			const readChunk = async (descriptor: SnapshotChunkDescriptor): Promise<Uint8Array | undefined> => {
				const attemptErrors: unknown[] = [];
				for (let attempt = 0; attempt < SNAPSHOT_PULL_MAX_ATTEMPTS; attempt += 1) {
					throwIfAborted(total.controller.signal);
					const preferred = candidates.filter((peerId) => !failedPeers.has(peerId));
					const pool = preferred.length === 0 ? candidates : preferred;
					const peerId = pool[attempt % pool.length] as string;
					if (!attemptedPeers.includes(peerId)) attemptedPeers.push(peerId);
					let stream: SnapshotChunkProtocolStream | undefined;
					try {
						await ensureManifest(peerId);
						stream = await open(peerId, { signal: total.controller.signal });
						await stream.write(
							encodeCanonical({
								descriptors: [{ digest: descriptor.digest, index: descriptor.index }],
								kind: "snapshot-chunk-request",
								manifestDigest: expectedManifestDigest,
								version: 1,
							}),
							{ signal: total.controller.signal }
						);
						const controlBytes = await readFrame(stream, MAX_MANIFEST_BYTES, total.controller.signal);
						const control = exactRecord(decodeRecord(controlBytes, MAX_MANIFEST_BYTES), CHUNK_RESPONSE_FIELDS);
						if (
							control === undefined ||
							control.kind !== "snapshot-chunk-response" ||
							control.version !== 1 ||
							control.manifestDigest !== expectedManifestDigest ||
							control.index !== descriptor.index ||
							control.digest !== descriptor.digest ||
							control.byteLength !== descriptor.byteLength
						) {
							throw failure("protocol-violation", "snapshot chunk control does not match its request");
						}
						const body = await readFrame(stream, MAX_BODY_BYTES, total.controller.signal);
						exactReceivedBytes += body.byteLength;
						if (exactReceivedBytes > MAX_SNAPSHOT_BYTES) {
							throw failure("body-budget-exceeded", "snapshot response body budget is exhausted");
						}
						if (
							body.byteLength !== descriptor.byteLength ||
							snapshotChunkDigest(descriptor.index, body) !== descriptor.digest
						) {
							throw failure("chunk-invalid", "snapshot response body is invalid");
						}
						return body;
					} catch (error) {
						attemptErrors.push(error);
						const code = nestedFailureCode(error);
						if (code === "aborted" || code === "total-timeout" || code === "body-budget-exceeded") throw error;
						failedPeers.add(peerId);
						stream?.abort(error instanceof Error ? error : undefined);
					} finally {
						await stream?.close().catch(() => undefined);
					}
				}
				throw failure(
					"transfer-exhausted",
					"snapshot descriptor attempts were exhausted",
					new AggregateError(attemptErrors, "snapshot descriptor attempts failed")
				);
			};
			const missingBefore = await quarantine.missingIndices({ signal: total.controller.signal });
			const verified = verifySnapshotStreamWithReceipt({
				exactCanonicalManifestBytes: manifestCarrier,
				expectedManifestDigest,
				expectedScope: quarantine.scope,
				profile: PROFILE,
				quarantine: quarantine.verificationQuarantine,
				signal: total.controller.signal,
				source: Object.freeze({ read: (descriptor: SnapshotChunkDescriptor) => readChunk(descriptor) }),
			});
			let reference: VerifiedSnapshotQuarantineReference;
			try {
				reference = await quarantine.complete(await verified.receipt, { signal: total.controller.signal });
			} catch (error) {
				const code = nestedFailureCode(error);
				if (code !== undefined) throw failure(code, "snapshot verification failed", error);
				throw failure("quarantine-failed", "snapshot quarantine completion failed", error);
			}
			const fetched = decoded.chunks.map(({ index }) => index).filter((index) => missingBefore.includes(index));
			const reused = decoded.chunks.map(({ index }) => index).filter((index) => !missingBefore.includes(index));
			let exactCanonicalPayloadBytes: Uint8Array | undefined;
			if (decoded.chunks.length === 1 && decoded.chunks[0]?.byteLength === reference.exactByteLength) {
				const port = quarantine.verificationQuarantine.open(total.controller.signal);
				try {
					const body = await port.read(decoded.chunks[0]);
					exactCanonicalPayloadBytes = body === undefined ? undefined : new Uint8Array(body);
				} finally {
					await port.discard();
				}
			}
			const token: VerifiedSnapshotTransfer = Object.freeze({});
			transfers.set(
				token,
				Object.freeze({
					claim,
					exactCanonicalPayloadBytes,
					messageQueueManager,
					networkNode,
					onAdmittedVertex,
					owner: ownerIdentity,
					reference,
				})
			);
			ownerTransfers.add(token);
			return Object.freeze({
				reference,
				stats: Object.freeze({
					attemptedPeers: Object.freeze(attemptedPeers),
					exactReceivedBytes,
					fetchedIndices: Object.freeze(fetched),
					reusedIndices: Object.freeze(reused),
				}),
				verified: token,
			});
		} catch (error) {
			if (claim !== undefined) discardRecoveredV3LiveAuthorityClaim(claim);
			const code = nestedFailureCode(error);
			if (error instanceof SnapshotPullError) throw error;
			throw failure(code ?? "transfer-exhausted", "snapshot transfer failed", error);
		} finally {
			if (sessionReserved) {
				activeSessionCount -= 1;
				for (const key of reservedKeys) activeScopePeers.delete(key);
			}
			ownerControllers.delete(total.controller);
			total.dispose();
		}
	};

	const serve: V3SnapshotTransferOwner["serve"] = (rawInput) => {
		if (closed || stopServing !== undefined) throw new TypeError("snapshot serving owner is unavailable");
		const manifestCarrier = copyExactBytes(
			rawInput.exactCanonicalManifestBytes,
			"snapshot manifest",
			MAX_MANIFEST_BYTES
		);
		const decoded = decodeSnapshotManifest({
			exactCanonicalManifestBytes: manifestCarrier,
			expectedManifestDigest: rawInput.quarantine.scope.manifestDigest,
			profile: PROFILE,
		});
		if (
			rawInput.descriptors.length !== decoded.chunks.length ||
			rawInput.descriptors.some(
				(descriptor, index) => !sameDescriptor(descriptor, decoded.chunks[index] as SnapshotChunkDescriptor)
			)
		) {
			throw failure("manifest-invalid", "snapshot serving descriptors are invalid");
		}
		const authorization = captureAuthorization(rawInput.authorization);
		const quarantine = rawInput.quarantine;
		const installed = installServer(async (stream) => {
			try {
				const author = authorization.authorForPeer(stream.peerId);
				if (typeof author !== "string" || !authorization.isAuthorizedAuthor(author)) {
					throw failure("authorization-rejected", "snapshot peer is not authorized");
				}
				const status = await quarantine.status();
				if (status.kind !== "verified" || status.missingIndices.length !== 0) {
					throw failure("quarantine-failed", "snapshot scope is not verified");
				}
				const requestBytes = await readFrame(stream, MAX_MANIFEST_BYTES, new AbortController().signal);
				const request = decodeRecord(requestBytes, MAX_MANIFEST_BYTES);
				const manifestRequest = exactRecord(request, MANIFEST_REQUEST_FIELDS);
				if (manifestRequest !== undefined) {
					if (
						manifestRequest.kind !== "snapshot-manifest-request" ||
						manifestRequest.version !== 1 ||
						manifestRequest.manifestDigest !== decoded.manifestDigest
					) {
						throw failure("manifest-invalid", "snapshot manifest request is invalid");
					}
					await stream.write(
						encodeCanonical({
							exactCanonicalManifestBytes: manifestCarrier,
							kind: "snapshot-manifest-response",
							manifestDigest: decoded.manifestDigest,
							version: 1,
						}),
						{ signal: new AbortController().signal }
					);
					await stream.close();
					return;
				}
				const chunkRequest = exactRecord(request, CHUNK_REQUEST_FIELDS);
				if (
					chunkRequest === undefined ||
					chunkRequest.kind !== "snapshot-chunk-request" ||
					chunkRequest.version !== 1 ||
					!Array.isArray(chunkRequest.descriptors) ||
					chunkRequest.descriptors.length === 0 ||
					chunkRequest.descriptors.length > SNAPSHOT_PULL_MAX_OUTSTANDING
				) {
					throw failure("protocol-violation", "snapshot chunk request is invalid");
				}
				if (chunkRequest.manifestDigest !== decoded.manifestDigest) {
					throw failure("manifest-invalid", "snapshot chunk request names a foreign manifest");
				}
				let previous = -1;
				const requested: SnapshotChunkDescriptor[] = [];
				for (const value of chunkRequest.descriptors) {
					const record = exactRecord(value, REQUEST_DESCRIPTOR_FIELDS);
					if (
						record === undefined ||
						typeof record.index !== "number" ||
						!Number.isSafeInteger(record.index) ||
						record.index <= previous ||
						typeof record.digest !== "string"
					) {
						throw failure("protocol-violation", "snapshot request descriptors are invalid");
					}
					const descriptor = decoded.chunks[record.index];
					if (descriptor === undefined || descriptor.digest !== record.digest) {
						throw failure("protocol-violation", "snapshot request descriptor is foreign");
					}
					previous = descriptor.index;
					requested.push(descriptor);
				}
				const port = quarantine.verificationQuarantine.open(new AbortController().signal);
				try {
					for (const descriptor of requested) {
						const bytes = await port.read(descriptor);
						if (bytes === undefined) throw failure("quarantine-failed", "verified snapshot chunk is absent");
						await stream.write(
							encodeCanonical({
								byteLength: descriptor.byteLength,
								digest: descriptor.digest,
								index: descriptor.index,
								kind: "snapshot-chunk-response",
								manifestDigest: decoded.manifestDigest,
								version: 1,
							}),
							{ signal: new AbortController().signal }
						);
						await stream.write(bytes, { signal: new AbortController().signal });
					}
				} finally {
					await port.discard();
				}
				await stream.close();
			} catch (error) {
				const code = nestedFailureCode(error) ?? "protocol-violation";
				stream.abort(failure(code, "snapshot serving request was rejected", error));
			}
		});
		stopServing = (): void => {
			installed();
			stopServing = undefined;
		};
		return stopServing;
	};

	return Object.freeze({
		activateSmallSnapshot: (
			input: Parameters<V3SnapshotTransferOwner["activateSmallSnapshot"]>[0]
		): SnapshotActivationResult => {
			const record = transfers.get(input.transfer);
			if (record === undefined || record.owner !== ownerIdentity) {
				throw failure("authorization-rejected", "verified snapshot transfer is unavailable");
			}
			transfers.delete(input.transfer);
			ownerTransfers.delete(input.transfer);
			const capability = restoreRecoveredV3LiveAuthority(record.claim) as RecoveredV3Live | undefined;
			if (capability === undefined || record.exactCanonicalPayloadBytes === undefined) {
				throw failure("quarantine-failed", "verified snapshot payload is not materializable");
			}
			const activation = activateV3LivePlane({
				capability,
				exactCanonicalPayloadBytes: record.exactCanonicalPayloadBytes,
				expectedApplicationStateDigest: input.expectedApplicationStateDigest,
				expectedPayloadDigest: input.expectedPayloadDigest,
				messageQueueManager: record.messageQueueManager,
				networkNode: record.networkNode,
				onAdmittedVertex: record.onAdmittedVertex,
			});
			if (!activation.ok) throw failure("authorization-rejected", "snapshot activation was rejected");
			const blueprint = bindV3BlueprintLivePlane({ plane: activation.handle });
			if (!blueprint.ok) {
				activation.handle.deactivate();
				throw failure("authorization-rejected", "snapshot blueprint binding was rejected");
			}
			return Object.freeze({ blueprint: blueprint.handle, plane: activation.handle, reference: record.reference });
		},
		close: async (): Promise<void> => {
			if (closed) return;
			closed = true;
			stopServing?.();
			for (const controller of ownerControllers) controller.abort(failure("aborted", "snapshot owner closed"));
			ownerControllers.clear();
			for (const token of ownerTransfers) {
				const record = transfers.get(token);
				if (record !== undefined) discardRecoveredV3LiveAuthorityClaim(record.claim);
				transfers.delete(token);
			}
			ownerTransfers.clear();
			await closeTransport();
		},
		receive,
		serve,
	});
}
