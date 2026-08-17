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
	readonly delivered: number;
	readonly dropped: number;
	readonly malformed: number;
	readonly overLimit: number;
	readonly published: number;
	readonly received: number;
	readonly sequencedKeys: number;
	readonly stale: number;
	readonly subscriberFailures: number;
	readonly unauthorized: number;
}

export interface EphemeralChannelOptions {
	readonly maxMessageBytes: number;
	readonly maxSequencedKeys: number;
}

export interface EphemeralIngress {
	readonly bytes: Uint8Array;
	readonly sender: string;
}

export interface EphemeralTransportPort {
	readonly localPeerId: string;
	readonly maxEnvelopeBytes: number;
	isAuthorized(sender: string): boolean;
	onMessage(listener: (ingress: EphemeralIngress) => void): () => void;
	send(bytes: Uint8Array): Promise<boolean>;
	close?(): void;
}

export interface EphemeralChannel {
	close(): void;
	publish(input: EphemeralPublishInput): Promise<boolean>;
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
const HEADER_BYTES = 16;
const KEY_BYTES_LIMIT = 128;
const MESSAGE_BYTES_LIMIT = 65_536;
const SEQUENCED_KEYS_LIMIT = 4_096;
const QUEUE_CAPACITY = 256;
const RELIABLE_ATTEMPTS = 8;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

interface MutableStats {
	delivered: number;
	dropped: number;
	malformed: number;
	overLimit: number;
	published: number;
	received: number;
	stale: number;
	subscriberFailures: number;
	unauthorized: number;
}

interface QueueEntry {
	readonly frame: EphemeralFrame;
	readonly reliable: boolean;
	resolve(accepted: boolean): void;
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

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function senderKey(sender: string, key: string): string {
	return `${sender.length}:${sender}${key}`;
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
	if (!exactKeys(options, ["maxMessageBytes", "maxSequencedKeys"])) throw new TypeError("ephemeral options differ");
	const maxMessageBytes = requireSafePositive(options.maxMessageBytes, MESSAGE_BYTES_LIMIT, "maxMessageBytes");
	const maxSequencedKeys = requireSafePositive(options.maxSequencedKeys, SEQUENCED_KEYS_LIMIT, "maxSequencedKeys");
	if (!Number.isSafeInteger(port.maxEnvelopeBytes) || port.maxEnvelopeBytes < maxMessageBytes) {
		throw new TypeError("transport envelope is smaller than the configured ephemeral frame limit");
	}

	let closed = false;
	let draining = false;
	let nextSequence = 1;
	let resolveClosed: (() => void) | undefined;
	let resolveQueueSpace: (() => void) | undefined;
	const closedResult = new Promise<false>((resolve) => {
		resolveClosed = (): void => resolve(false);
	});
	let queueSpace = new Promise<void>((resolve) => {
		resolveQueueSpace = resolve;
	});
	const queue: QueueEntry[] = [];
	const trackedKeys = new Set<string>();
	const watermarks = new Map<string, number>();
	const subscribers = new Set<(frame: DeliveredEphemeralFrame) => void>();
	const counters: MutableStats = {
		delivered: 0,
		dropped: 0,
		malformed: 0,
		overLimit: 0,
		published: 0,
		received: 0,
		stale: 0,
		subscriberFailures: 0,
		unauthorized: 0,
	};

	const unsubscribe = port.onMessage(({ bytes, sender }) => {
		if (closed) return;
		counters.received += 1;
		if (bytes.byteLength > maxMessageBytes) {
			counters.overLimit += 1;
			return;
		}
		let frame: EphemeralFrame;
		try {
			frame = decodeEphemeralFrame(bytes);
		} catch {
			counters.malformed += 1;
			return;
		}
		if (!port.isAuthorized(sender)) {
			counters.unauthorized += 1;
			return;
		}
		if (frame.class === "unreliable-sequenced") {
			if (frame.key === null) {
				counters.malformed += 1;
				return;
			}
			const watermarkKey = senderKey(sender, frame.key);
			const previous = watermarks.get(watermarkKey);
			if (previous !== undefined && frame.sequence <= previous) {
				counters.stale += 1;
				return;
			}
			if (previous === undefined && trackedKeys.size >= maxSequencedKeys) {
				counters.overLimit += 1;
				return;
			}
			trackedKeys.add(watermarkKey);
			watermarks.set(watermarkKey, frame.sequence);
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

	const drain = async (): Promise<void> => {
		if (draining || closed) return;
		draining = true;
		try {
			while (!closed) {
				const entry = queue.shift();
				if (entry === undefined) break;
				resolveQueueSpace?.();
				queueSpace = new Promise<void>((resolve) => {
					resolveQueueSpace = resolve;
				});
				const encoded = encodeEphemeralFrame(entry.frame);
				let accepted = false;
				const attempts = entry.reliable ? RELIABLE_ATTEMPTS : 1;
				for (let attempt = 0; attempt < attempts && !closed; attempt += 1) {
					try {
						accepted = await Promise.race([port.send(encoded), closedResult]);
					} catch {
						accepted = false;
					}
					if (accepted) break;
				}
				if (accepted) counters.published += 1;
				else if (!entry.reliable) counters.dropped += 1;
				entry.resolve(accepted);
			}
		} finally {
			draining = false;
			if (!closed && queue.length > 0) void drain();
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
			const trackingKey = senderKey(port.localPeerId, input.key);
			if (!trackedKeys.has(trackingKey)) {
				if (trackedKeys.size >= maxSequencedKeys) {
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
		const encodedSize = encodeEphemeralFrame(frame).byteLength;
		if (encodedSize > maxMessageBytes) {
			counters.overLimit += 1;
			return Promise.resolve(false);
		}
		if (frame.class === "unreliable-sequenced" && frame.key !== null) {
			trackedKeys.add(senderKey(port.localPeerId, frame.key));
		}
		const enqueue = (): Promise<boolean> =>
			new Promise((resolve) => {
				queue.push({ frame, reliable: frame.class === "reliable-unordered", resolve });
				void drain();
			});
		if (frame.class === "reliable-unordered") {
			return (async (): Promise<boolean> => {
				while (!closed && queue.length >= QUEUE_CAPACITY) {
					await Promise.race([queueSpace, closedResult]);
				}
				return closed ? false : enqueue();
			})();
		}
		return new Promise((resolve) => {
			if (queue.length >= QUEUE_CAPACITY) {
				if (frame.class === "unreliable-sequenced") {
					const existingIndex = queue.findIndex(
						(entry) => entry.frame.class === "unreliable-sequenced" && entry.frame.key === frame.key
					);
					if (existingIndex >= 0) {
						const [replaced] = queue.splice(existingIndex, 1, { frame, reliable: false, resolve });
						replaced?.resolve(false);
						counters.dropped += 1;
						return;
					}
				}
				counters.dropped += 1;
				resolve(false);
				return;
			}
			queue.push({ frame, reliable: false, resolve });
			void drain();
		});
	};

	return {
		close: (): void => {
			if (closed) return;
			closed = true;
			resolveClosed?.();
			unsubscribe();
			for (const entry of queue.splice(0)) entry.resolve(false);
			trackedKeys.clear();
			watermarks.clear();
			subscribers.clear();
			try {
				port.close?.();
			} catch {
				// Local transport teardown cannot revive a closed channel.
			}
		},
		publish,
		stats: (): EphemeralStats => Object.freeze({ ...counters, sequencedKeys: trackedKeys.size }),
		subscribe: (listener): (() => void) => {
			if (closed) return (): void => undefined;
			subscribers.add(listener);
			return (): void => {
				subscribers.delete(listener);
			};
		},
	};
}
