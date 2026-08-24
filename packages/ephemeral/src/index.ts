export type EphemeralDeliveryClass = "reliable-unordered" | "unreliable-sequenced" | "unreliable-unordered";

export interface EphemeralPublishInput {
	readonly class: EphemeralDeliveryClass;
	readonly key: string | null;
	readonly payload: Uint8Array;
}

export interface EphemeralFrame extends EphemeralPublishInput {
	readonly sequence: number;
}

export interface DeliveredEphemeralFrame extends EphemeralFrame {
	readonly sender: string;
}

export interface EphemeralStats {
	readonly authorityMismatch: number;
	readonly delivered: number;
	readonly dropped: number;
	readonly localSequencedKeys: number;
	readonly malformed: number;
	readonly overLimit: number;
	readonly published: number;
	readonly rateLimited: number;
	readonly received: number;
	readonly remoteSequencedKeys: number;
	readonly sequencedKeys: number;
	readonly sequencedSenders: number;
	readonly stale: number;
	readonly subscriberFailures: number;
	readonly unauthorized: number;
	readonly writerBuckets: number;
}

export interface EphemeralChannelOptions {
	readonly maxMessageBytes: number;
	readonly maxSequencedKeys: number;
	readonly maxSequencedSenders: number;
}

export interface EphemeralIngress {
	readonly bytes: Uint8Array;
	readonly sender: string;
}

export interface EphemeralTransportSendInput {
	readonly bytes: Uint8Array;
	readonly class: EphemeralDeliveryClass;
	readonly recipients: "all" | readonly string[];
	readonly signal?: AbortSignal;
}

export interface EphemeralTransportPort {
	readonly localPeerId: string;
	authorizedPeers(): readonly string[];
	isAuthorized(sender: string): boolean;
	maxEnvelopeBytes(deliveryClass: EphemeralDeliveryClass): number;
	onMessage(listener: (ingress: EphemeralIngress) => void): () => void;
	send(input: EphemeralTransportSendInput): Promise<boolean>;
	close?(): void;
	restartUnreliable?(): Promise<void>;
}

export interface EphemeralChannel {
	authorizedPeers(): readonly string[];
	close(): void;
	publish(input: EphemeralPublishInput): Promise<boolean>;
	resetReliable(): Promise<void>;
	restartUnreliable(): Promise<void>;
	stats(): EphemeralStats;
	subscribe(listener: (frame: DeliveredEphemeralFrame) => void): () => void;
}

const CLASS_TO_CODE = {
	"reliable-unordered": 3,
	"unreliable-sequenced": 2,
	"unreliable-unordered": 1,
} as const;
const CODE_TO_CLASS = new Map<number, EphemeralDeliveryClass>(
	Object.entries(CLASS_TO_CODE).map(([name, code]) => [code, name as EphemeralDeliveryClass])
);
const FRAME_VERSION = 1;
const AUTHORITY_FRAME_VERSION = 2;
const HEADER_BYTES = 16;
const AUTHORITY_HEADER_BYTES = 73;
const KEY_BYTES_LIMIT = 128;
const MESSAGE_BYTES_LIMIT = 65_536;
const SEQUENCED_KEYS_LIMIT = 4_096;
const QUEUE_CAPACITY = 256;
const UNRELIABLE_QUEUE_RESERVE = 32;
const RELIABLE_ATTEMPTS = 8;
const RECEIVE_BYTE_CAPACITY = 1_048_576;
const RECEIVE_MESSAGE_CAPACITY = 120;
const RECEIVE_REFILL_MS = 1_000;
const WRITER_BUCKET_CAPACITY = 128;
const WRITER_BUCKET_IDLE_MS = 60_000;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

interface MutableStats {
	authorityMismatch: number;
	delivered: number;
	dropped: number;
	malformed: number;
	overLimit: number;
	published: number;
	rateLimited: number;
	received: number;
	stale: number;
	subscriberFailures: number;
	unauthorized: number;
}

interface QueueEntry {
	readonly encoded: Uint8Array;
	readonly frame: EphemeralFrame;
	readonly reliable: boolean;
	resolve(accepted: boolean): void;
}

interface EphemeralAuthorityContext {
	readonly aclDigest: string;
	readonly anchorDigest: string;
	readonly epoch: number;
	readonly objectId: string;
}

interface AuthorityBoundTransportPort extends EphemeralTransportPort {
	authorForPeer(peerId: string): string | undefined;
	currentAuthority(): EphemeralAuthorityContext | undefined;
	isCurrentWriter(author: string): boolean;
	onPeerDisconnect(listener: (peerId: string) => void): () => void;
}

interface ReceiveBucket {
	byteTokens: number;
	lastRefill: number;
	lastSeen: number;
	messageTokens: number;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isDeliveryClass(value: unknown): value is EphemeralDeliveryClass {
	return typeof value === "string" && Object.hasOwn(CLASS_TO_CODE, value);
}

function requireSafePositive(value: unknown, maximum: number, name: string): number {
	if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1 || value > maximum) {
		throw new TypeError(`${name} must be a positive safe integer no greater than ${maximum}`);
	}
	return value;
}

function keyBytes(key: string): Uint8Array {
	const bytes = encoder.encode(key);
	if (key.length === 0 || bytes.byteLength > KEY_BYTES_LIMIT) throw new TypeError("sequenced key differs");
	return bytes;
}

function validateFrame(frame: EphemeralFrame): Uint8Array {
	if (!exactKeys(frame, ["class", "key", "payload", "sequence"])) throw new TypeError("ephemeral frame shape differs");
	if (!isDeliveryClass(frame.class) || !(frame.payload instanceof Uint8Array)) {
		throw new TypeError("ephemeral frame type differs");
	}
	if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0) throw new TypeError("ephemeral sequence differs");
	if (frame.class === "unreliable-sequenced") {
		if (typeof frame.key !== "string" || frame.sequence < 1) throw new TypeError("sequenced frame differs");
		return keyBytes(frame.key);
	}
	if (frame.key !== null || frame.sequence !== 0) throw new TypeError("unordered frame differs");
	return new Uint8Array();
}

/**
 * Encode the sole canonical version-1 ephemeral frame.
 * @param frame Closed frame value.
 * @returns Canonical detached bytes.
 */
export function encodeEphemeralFrame(frame: EphemeralFrame): Uint8Array {
	const key = validateFrame(frame);
	const output = new Uint8Array(HEADER_BYTES + key.byteLength + frame.payload.byteLength);
	const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
	view.setUint8(0, FRAME_VERSION);
	view.setUint8(1, CLASS_TO_CODE[frame.class]);
	view.setUint16(2, key.byteLength, false);
	view.setUint32(4, Math.floor(frame.sequence / 0x1_0000_0000), false);
	view.setUint32(8, frame.sequence >>> 0, false);
	view.setUint32(12, frame.payload.byteLength, false);
	output.set(key, HEADER_BYTES);
	output.set(frame.payload, HEADER_BYTES + key.byteLength);
	return output;
}

/**
 * Decode only the canonical version-1 ephemeral frame.
 * @param bytes Candidate canonical bytes.
 * @returns A detached decoded frame.
 */
export function decodeEphemeralFrame(bytes: Uint8Array): EphemeralFrame {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength < HEADER_BYTES)
		throw new TypeError("ephemeral frame bytes differ");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint8(0) !== FRAME_VERSION) throw new TypeError("ephemeral frame version differs");
	const deliveryClass = CODE_TO_CLASS.get(view.getUint8(1));
	if (deliveryClass === undefined) throw new TypeError("ephemeral delivery class differs");
	const keyLength = view.getUint16(2, false);
	const sequence = view.getUint32(4, false) * 0x1_0000_0000 + view.getUint32(8, false);
	const payloadLength = view.getUint32(12, false);
	if (!Number.isSafeInteger(sequence) || bytes.byteLength !== HEADER_BYTES + keyLength + payloadLength) {
		throw new TypeError("ephemeral frame length differs");
	}
	const keySlice = bytes.subarray(HEADER_BYTES, HEADER_BYTES + keyLength);
	let key: string | null = null;
	if (keyLength > 0) {
		if (keyLength > KEY_BYTES_LIMIT) throw new TypeError("ephemeral key length differs");
		key = decoder.decode(keySlice);
		if (key.length === 0 || !sameBytes(encoder.encode(key), keySlice))
			throw new TypeError("ephemeral key bytes differ");
	}
	const frame: EphemeralFrame = {
		class: deliveryClass,
		key,
		payload: bytes.slice(HEADER_BYTES + keyLength),
		sequence,
	};
	validateFrame(frame);
	return frame;
}

/**
 * Inspect the delivery class carried by a canonical ephemeral frame or authority envelope.
 * Malformed inputs remain the channel decoder's responsibility and therefore return undefined.
 * @param bytes Candidate transport bytes.
 * @returns The canonical delivery class, or undefined when the bytes are not a valid frame.
 */
export function inspectEphemeralDeliveryClass(bytes: Uint8Array): EphemeralDeliveryClass | undefined {
	try {
		if (bytes[0] === FRAME_VERSION) return decodeEphemeralFrame(bytes).class;
		if (bytes[0] === AUTHORITY_FRAME_VERSION && bytes.byteLength > AUTHORITY_HEADER_BYTES) {
			return decodeEphemeralFrame(bytes.subarray(AUTHORITY_HEADER_BYTES)).class;
		}
	} catch {
		// Preserve malformed-frame accounting in the channel's single canonical decoder.
	}
	return undefined;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function authorityBoundPort(port: EphemeralTransportPort): AuthorityBoundTransportPort | undefined {
	const candidate = port as Partial<AuthorityBoundTransportPort>;
	const members = [
		candidate.authorForPeer,
		candidate.currentAuthority,
		candidate.isCurrentWriter,
		candidate.onPeerDisconnect,
	];
	if (members.every((member) => member === undefined)) return undefined;
	if (members.some((member) => typeof member !== "function")) {
		throw new TypeError("ephemeral authority transport differs");
	}
	return candidate as AuthorityBoundTransportPort;
}

function hexBytes(value: unknown): Uint8Array | undefined {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) return undefined;
	const bytes = new Uint8Array(32);
	for (let index = 0; index < bytes.byteLength; index += 1) {
		const parsed = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
		if (!Number.isSafeInteger(parsed)) return undefined;
		bytes[index] = parsed;
	}
	return bytes;
}

function authoritySnapshot(value: unknown): EphemeralAuthorityContext | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Partial<EphemeralAuthorityContext>;
	const anchorDigest = hexBytes(candidate.anchorDigest);
	const aclDigest = hexBytes(candidate.aclDigest);
	if (
		anchorDigest === undefined ||
		aclDigest === undefined ||
		typeof candidate.objectId !== "string" ||
		candidate.objectId.length === 0 ||
		typeof candidate.epoch !== "number" ||
		!Number.isSafeInteger(candidate.epoch) ||
		candidate.epoch < 0
	) {
		return undefined;
	}
	return Object.freeze({
		aclDigest: candidate.aclDigest as string,
		anchorDigest: candidate.anchorDigest as string,
		epoch: candidate.epoch,
		objectId: candidate.objectId,
	});
}

function sameAuthority(left: EphemeralAuthorityContext, right: EphemeralAuthorityContext): boolean {
	return (
		left.aclDigest === right.aclDigest &&
		left.anchorDigest === right.anchorDigest &&
		left.epoch === right.epoch &&
		left.objectId === right.objectId
	);
}

function encodeAuthorityFrame(frame: EphemeralFrame, authority: EphemeralAuthorityContext): Uint8Array {
	const inner = encodeEphemeralFrame(frame);
	const anchorDigest = hexBytes(authority.anchorDigest);
	const aclDigest = hexBytes(authority.aclDigest);
	if (anchorDigest === undefined || aclDigest === undefined || !Number.isSafeInteger(authority.epoch)) {
		throw new TypeError("ephemeral authority differs");
	}
	const output = new Uint8Array(AUTHORITY_HEADER_BYTES + inner.byteLength);
	const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
	view.setUint8(0, AUTHORITY_FRAME_VERSION);
	view.setUint32(1, Math.floor(authority.epoch / 0x1_0000_0000), false);
	view.setUint32(5, authority.epoch >>> 0, false);
	output.set(anchorDigest, 9);
	output.set(aclDigest, 41);
	output.set(inner, AUTHORITY_HEADER_BYTES);
	return output;
}

function decodeAuthorityFrame(
	bytes: Uint8Array,
	authority: EphemeralAuthorityContext
): { readonly contextMatches: boolean; readonly frame: EphemeralFrame } {
	if (bytes.byteLength <= AUTHORITY_HEADER_BYTES || bytes[0] !== AUTHORITY_FRAME_VERSION) {
		throw new TypeError("ephemeral authority frame differs");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const epoch = view.getUint32(1, false) * 0x1_0000_0000 + view.getUint32(5, false);
	if (!Number.isSafeInteger(epoch)) throw new TypeError("ephemeral authority epoch differs");
	const expectedAnchor = hexBytes(authority.anchorDigest);
	const expectedAcl = hexBytes(authority.aclDigest);
	if (expectedAnchor === undefined || expectedAcl === undefined) throw new TypeError("ephemeral authority differs");
	return {
		contextMatches:
			epoch === authority.epoch &&
			sameBytes(bytes.subarray(9, 41), expectedAnchor) &&
			sameBytes(bytes.subarray(41, AUTHORITY_HEADER_BYTES), expectedAcl),
		frame: decodeEphemeralFrame(bytes.subarray(AUTHORITY_HEADER_BYTES)),
	};
}

function newReceiveBucket(now: number): ReceiveBucket {
	return {
		byteTokens: RECEIVE_BYTE_CAPACITY,
		lastRefill: now,
		lastSeen: now,
		messageTokens: RECEIVE_MESSAGE_CAPACITY,
	};
}

function monotonicNow(): number {
	return globalThis.performance.now();
}

function chargeReceiveBucket(bucket: ReceiveBucket, byteLength: number, now: number): boolean {
	const intervals = Math.floor(Math.max(0, now - bucket.lastRefill) / RECEIVE_REFILL_MS);
	if (intervals > 0) {
		bucket.messageTokens = Math.min(
			RECEIVE_MESSAGE_CAPACITY,
			bucket.messageTokens + intervals * RECEIVE_MESSAGE_CAPACITY
		);
		bucket.byteTokens = Math.min(RECEIVE_BYTE_CAPACITY, bucket.byteTokens + intervals * RECEIVE_BYTE_CAPACITY);
		bucket.lastRefill += intervals * RECEIVE_REFILL_MS;
	}
	bucket.lastSeen = now;
	if (bucket.messageTokens < 1 || bucket.byteTokens < byteLength) return false;
	bucket.messageTokens -= 1;
	bucket.byteTokens -= byteLength;
	return true;
}

/**
 * Create the shared bounded channel used by controlled tests and the node adapter.
 * @param port Private authenticated transport port.
 * @param options Closed resource limits.
 * @returns One isolated ephemeral channel.
 */
export function createEphemeralChannel(
	port: EphemeralTransportPort,
	options: EphemeralChannelOptions
): EphemeralChannel {
	if (!exactKeys(options, ["maxMessageBytes", "maxSequencedKeys", "maxSequencedSenders"])) {
		throw new TypeError("ephemeral options differ");
	}
	const maxMessageBytes = requireSafePositive(options.maxMessageBytes, MESSAGE_BYTES_LIMIT, "maxMessageBytes");
	const maxSequencedKeys = requireSafePositive(options.maxSequencedKeys, SEQUENCED_KEYS_LIMIT, "maxSequencedKeys");
	const maxSequencedSenders = requireSafePositive(
		options.maxSequencedSenders,
		SEQUENCED_KEYS_LIMIT - 1,
		"maxSequencedSenders"
	);
	if ((maxSequencedSenders + 1) * maxSequencedKeys > SEQUENCED_KEYS_LIMIT) {
		throw new TypeError("ephemeral sequenced allocation exceeds the retained-entry limit");
	}
	if (typeof port.maxEnvelopeBytes !== "function" || typeof port.send !== "function")
		throw new TypeError("ephemeral transport differs");
	const v3Port = authorityBoundPort(port);
	let installedAuthority = v3Port === undefined ? undefined : authoritySnapshot(v3Port.currentAuthority());
	if (v3Port !== undefined && installedAuthority === undefined) {
		throw new TypeError("ephemeral authority differs");
	}

	let closed = false;
	let drainingReliable = false;
	let drainingUnreliable = false;
	let reliableGeneration = 0;
	let reliableTransportController = new AbortController();
	const unreliableTransportController = new AbortController();
	let activeEntries = 0;
	let nextSequence = 1;
	const reliableIdleWaiters = new Set<() => void>();
	let resolveClosed: (() => void) | undefined;
	let resolveQueueSpace: (() => void) | undefined;
	const closedResult = new Promise<false>((resolve) => {
		resolveClosed = (): void => resolve(false);
	});
	let queueSpace = new Promise<void>((resolve) => {
		resolveQueueSpace = resolve;
	});
	const reliableQueue: QueueEntry[] = [];
	const unreliableQueue: QueueEntry[] = [];
	const retainedEntryCount = (): number => activeEntries + reliableQueue.length + unreliableQueue.length;
	const localSequencedKeys = new Set<string>();
	const remoteWatermarks = new Map<string, Map<string, number>>();
	const writerBuckets = new Map<string, ReceiveBucket>();
	const deleteWriterBucket = (author: string): void => {
		writerBuckets.delete(author);
	};
	const clearWriterBuckets = (): void => {
		writerBuckets.clear();
	};
	let rejectedBucket = newReceiveBucket(monotonicNow());
	const subscribers = new Set<(frame: DeliveredEphemeralFrame) => void>();
	const counters: MutableStats = {
		authorityMismatch: 0,
		delivered: 0,
		dropped: 0,
		malformed: 0,
		overLimit: 0,
		published: 0,
		rateLimited: 0,
		received: 0,
		stale: 0,
		subscriberFailures: 0,
		unauthorized: 0,
	};

	const unsubscribe = port.onMessage(({ bytes, sender }) => {
		if (closed) return;
		counters.received += 1;
		let authority: EphemeralAuthorityContext | undefined;
		if (v3Port !== undefined) {
			authority = authoritySnapshot(v3Port.currentAuthority());
			if (authority === undefined) {
				counters.authorityMismatch += 1;
				return;
			}
			if (installedAuthority === undefined || !sameAuthority(installedAuthority, authority)) {
				installedAuthority = authority;
				remoteWatermarks.clear();
				clearWriterBuckets();
				rejectedBucket = newReceiveBucket(monotonicNow());
			}
			const now = monotonicNow();
			const author = v3Port.authorForPeer(sender);
			if (author === undefined || !v3Port.isCurrentWriter(author)) {
				if (author !== undefined) deleteWriterBucket(author);
				if (!chargeReceiveBucket(rejectedBucket, bytes.byteLength, now)) {
					counters.rateLimited += 1;
					return;
				}
				counters.authorityMismatch += 1;
				counters.unauthorized += 1;
				return;
			}
			let bucket = writerBuckets.get(author);
			if (bucket !== undefined && now - bucket.lastSeen >= WRITER_BUCKET_IDLE_MS) {
				deleteWriterBucket(author);
				bucket = undefined;
			}
			if (bucket === undefined) {
				for (const [retainedAuthor, retained] of writerBuckets) {
					if (now - retained.lastSeen >= WRITER_BUCKET_IDLE_MS || !v3Port.isCurrentWriter(retainedAuthor)) {
						deleteWriterBucket(retainedAuthor);
					}
				}
				if (writerBuckets.size >= WRITER_BUCKET_CAPACITY) {
					counters.rateLimited += 1;
					return;
				}
				bucket = newReceiveBucket(now);
				writerBuckets.set(author, bucket);
			}
			const charged = chargeReceiveBucket(bucket, bytes.byteLength, now);
			if (!charged) {
				counters.rateLimited += 1;
				return;
			}
		}
		if (bytes.byteLength > maxMessageBytes) {
			counters.overLimit += 1;
			return;
		}
		let frame: EphemeralFrame;
		try {
			if (v3Port === undefined) {
				frame = decodeEphemeralFrame(bytes);
			} else {
				if (authority === undefined) throw new TypeError("ephemeral authority differs");
				const decoded = decodeAuthorityFrame(bytes, authority);
				if (!decoded.contextMatches) {
					counters.authorityMismatch += 1;
					return;
				}
				frame = decoded.frame;
			}
		} catch {
			counters.malformed += 1;
			return;
		}
		if (v3Port === undefined && !port.isAuthorized(sender)) {
			counters.unauthorized += 1;
			return;
		}
		if (frame.class === "unreliable-sequenced") {
			if (frame.key === null) {
				counters.malformed += 1;
				return;
			}
			let senderWatermarks = remoteWatermarks.get(sender);
			const previous = senderWatermarks?.get(frame.key);
			if (previous !== undefined && frame.sequence <= previous) {
				counters.stale += 1;
				return;
			}
			if (previous === undefined) {
				if (senderWatermarks === undefined) {
					if (remoteWatermarks.size >= maxSequencedSenders) {
						counters.overLimit += 1;
						return;
					}
					senderWatermarks = new Map();
					remoteWatermarks.set(sender, senderWatermarks);
				}
				if (senderWatermarks.size >= maxSequencedKeys) {
					counters.overLimit += 1;
					return;
				}
			}
			if (senderWatermarks === undefined) {
				counters.malformed += 1;
				return;
			}
			senderWatermarks.set(frame.key, frame.sequence);
		}
		if (subscribers.size === 0) return;
		counters.delivered += 1;
		for (const subscriber of subscribers) {
			try {
				subscriber({ ...frame, payload: frame.payload.slice(), sender });
			} catch {
				counters.subscriberFailures += 1;
			}
		}
	});
	const unsubscribePeerDisconnect =
		v3Port?.onPeerDisconnect((peerId) => {
			try {
				const author = v3Port.authorForPeer(peerId);
				if (
					author !== undefined &&
					!v3Port
						.authorizedPeers()
						.some((candidate) => candidate !== peerId && v3Port.authorForPeer(candidate) === author)
				) {
					deleteWriterBucket(author);
				}
			} catch {
				// Uncertain roster evidence cannot grant fresh receive capacity.
			}
		}) ?? ((): void => undefined);

	const drain = async (reliable: boolean): Promise<void> => {
		if ((reliable ? drainingReliable : drainingUnreliable) || closed) return;
		if (reliable) drainingReliable = true;
		else drainingUnreliable = true;
		const queue = reliable ? reliableQueue : unreliableQueue;
		try {
			while (!closed) {
				const entry = queue.shift();
				if (entry === undefined) break;
				activeEntries += 1;
				let accepted = false;
				const entrySignal = reliable ? reliableTransportController.signal : unreliableTransportController.signal;
				const attempts = entry.reliable ? RELIABLE_ATTEMPTS : 1;
				for (let attempt = 0; attempt < attempts && !closed && !entrySignal.aborted; attempt += 1) {
					let resolveAborted!: (value: false) => void;
					const aborted = new Promise<false>((resolve) => {
						resolveAborted = resolve;
					});
					const onAbort = (): void => resolveAborted(false);
					entrySignal.addEventListener("abort", onAbort, { once: true });
					try {
						accepted = await Promise.race([
							port.send({
								bytes: entry.encoded.slice(),
								class: entry.frame.class,
								recipients: "all",
								signal: entrySignal,
							}),
							closedResult,
							aborted,
						]);
					} catch {
						accepted = false;
					} finally {
						entrySignal.removeEventListener("abort", onAbort);
					}
					if (accepted) break;
				}
				if (accepted) counters.published += 1;
				else if (!entry.reliable) counters.dropped += 1;
				entry.resolve(accepted);
				activeEntries -= 1;
				resolveQueueSpace?.();
				queueSpace = new Promise<void>((resolve) => {
					resolveQueueSpace = resolve;
				});
			}
		} finally {
			if (reliable) {
				drainingReliable = false;
				for (const resolve of reliableIdleWaiters) resolve();
				reliableIdleWaiters.clear();
			} else drainingUnreliable = false;
			if (!closed && queue.length > 0) void drain(reliable);
		}
	};

	const publish = (input: EphemeralPublishInput): Promise<boolean> => {
		if (closed) return Promise.resolve(false);
		if (
			!exactKeys(input, ["class", "key", "payload"]) ||
			!isDeliveryClass(input.class) ||
			!(input.payload instanceof Uint8Array)
		) {
			throw new TypeError("ephemeral publication differs");
		}
		let sequence = 0;
		if (input.class === "unreliable-sequenced") {
			if (typeof input.key !== "string") throw new TypeError("sequenced publication key differs");
			let encodedKey: Uint8Array;
			try {
				encodedKey = keyBytes(input.key);
			} catch {
				counters.overLimit += 1;
				return Promise.resolve(false);
			}
			void encodedKey;
			if (!localSequencedKeys.has(input.key)) {
				if (localSequencedKeys.size >= maxSequencedKeys) {
					counters.overLimit += 1;
					return Promise.resolve(false);
				}
			}
			sequence = nextSequence;
			nextSequence += 1;
			if (!Number.isSafeInteger(nextSequence)) throw new RangeError("ephemeral sequence exhausted");
		} else if (input.key !== null) {
			throw new TypeError("unordered publication key differs");
		}
		const frame: EphemeralFrame = { ...input, payload: input.payload.slice(), sequence };
		let encoded: Uint8Array;
		if (v3Port === undefined) {
			encoded = encodeEphemeralFrame(frame);
		} else {
			const authority = authoritySnapshot(v3Port.currentAuthority());
			if (authority === undefined) return Promise.resolve(false);
			if (installedAuthority === undefined || !sameAuthority(installedAuthority, authority)) {
				installedAuthority = authority;
				remoteWatermarks.clear();
				clearWriterBuckets();
				rejectedBucket = newReceiveBucket(monotonicNow());
			}
			encoded = encodeAuthorityFrame(frame, authority);
		}
		const encodedSize = encoded.byteLength;
		if (encodedSize > maxMessageBytes) {
			counters.overLimit += 1;
			return Promise.resolve(false);
		}
		let classEnvelopeBytes: number;
		try {
			classEnvelopeBytes = port.maxEnvelopeBytes(frame.class);
		} catch {
			classEnvelopeBytes = 0;
		}
		if (!Number.isSafeInteger(classEnvelopeBytes) || classEnvelopeBytes < 1 || encodedSize > classEnvelopeBytes) {
			counters.overLimit += 1;
			return Promise.resolve(false);
		}
		if (frame.class === "unreliable-sequenced" && frame.key !== null) {
			localSequencedKeys.add(frame.key);
		}
		const enqueue = (): Promise<boolean> =>
			new Promise((resolve) => {
				const reliable = frame.class === "reliable-unordered";
				(reliable ? reliableQueue : unreliableQueue).push({ encoded, frame, reliable, resolve });
				void drain(reliable);
			});
		if (frame.class === "reliable-unordered") {
			return (async (): Promise<boolean> => {
				const generation = reliableGeneration;
				while (
					!closed &&
					generation === reliableGeneration &&
					retainedEntryCount() >= QUEUE_CAPACITY - UNRELIABLE_QUEUE_RESERVE
				) {
					await Promise.race([queueSpace, closedResult]);
				}
				return closed || generation !== reliableGeneration ? false : enqueue();
			})();
		}
		return new Promise((resolve) => {
			if (retainedEntryCount() >= QUEUE_CAPACITY) {
				if (frame.class === "unreliable-sequenced") {
					const existingIndex = unreliableQueue.findIndex(
						(entry) => entry.frame.class === "unreliable-sequenced" && entry.frame.key === frame.key
					);
					if (existingIndex >= 0) {
						const [replaced] = unreliableQueue.splice(existingIndex, 1, {
							encoded,
							frame,
							reliable: false,
							resolve,
						});
						replaced?.resolve(false);
						counters.dropped += 1;
						return;
					}
				}
				counters.dropped += 1;
				resolve(false);
				return;
			}
			unreliableQueue.push({ encoded, frame, reliable: false, resolve });
			void drain(false);
		});
	};
	const resetReliable = async (): Promise<void> => {
		reliableGeneration += 1;
		reliableTransportController.abort(new Error("ephemeral reliable drain reset"));
		reliableTransportController = new AbortController();
		for (const entry of reliableQueue.splice(0)) entry.resolve(false);
		resolveQueueSpace?.();
		if (drainingReliable) {
			await new Promise<void>((resolve) => {
				reliableIdleWaiters.add(resolve);
			});
		}
	};

	return {
		authorizedPeers: (): readonly string[] => [...port.authorizedPeers()],
		close: (): void => {
			if (closed) return;
			closed = true;
			void resetReliable();
			unreliableTransportController.abort(new Error("ephemeral channel closed"));
			resolveClosed?.();
			unsubscribe();
			unsubscribePeerDisconnect();
			for (const entry of reliableQueue.splice(0)) entry.resolve(false);
			for (const entry of unreliableQueue.splice(0)) entry.resolve(false);
			localSequencedKeys.clear();
			remoteWatermarks.clear();
			clearWriterBuckets();
			subscribers.clear();
			try {
				port.close?.();
			} catch {
				// Local transport teardown cannot revive a closed channel.
			}
		},
		publish,
		resetReliable: (): Promise<void> => {
			return closed ? Promise.resolve() : resetReliable();
		},
		restartUnreliable: (): Promise<void> => {
			return closed ? Promise.resolve() : (port.restartUnreliable?.() ?? Promise.resolve());
		},
		stats: (): EphemeralStats => {
			let remoteSequencedKeys = 0;
			for (const watermarks of remoteWatermarks.values()) remoteSequencedKeys += watermarks.size;
			return Object.freeze({
				...counters,
				localSequencedKeys: localSequencedKeys.size,
				remoteSequencedKeys,
				sequencedKeys: localSequencedKeys.size + remoteSequencedKeys,
				sequencedSenders: remoteWatermarks.size,
				writerBuckets: writerBuckets.size,
			});
		},
		subscribe: (listener): (() => void) => {
			if (closed) return (): void => undefined;
			subscribers.add(listener);
			return (): void => {
				subscribers.delete(listener);
			};
		},
	};
}
