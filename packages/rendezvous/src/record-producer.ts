import { DEFAULT_RECORD_LIMITS, type DrpCapability, type RecordSigner, type SignedDrpRecordV1 } from "./record.js";

export interface SequenceStore {
	load(): Promise<number>;
	/** Atomically persists `next` and MUST reject when `next` is <= the currently stored sequence. */
	save(next: number): Promise<void>;
}

/** Process-local monotonic sequence storage for runtimes without persistence. */
export class InMemorySequenceStore implements SequenceStore {
	#sequence: number;

	/** @param initialSequence - Last sequence durably consumed by this identity. */
	constructor(initialSequence = 0) {
		validateSequence(initialSequence);
		this.#sequence = initialSequence;
	}

	/** @returns The last consumed sequence. */
	load(): Promise<number> {
		return Promise.resolve(this.#sequence);
	}

	/**
	 * Persists a sequence without permitting rollback.
	 * @param next - Strictly greater sequence to persist atomically.
	 * @returns A promise that resolves only after the sequence is stored.
	 */
	save(next: number): Promise<void> {
		validateSequence(next);
		if (next <= this.#sequence) throw new Error("sequence store requires a strictly increasing value");
		this.#sequence = next;
		return Promise.resolve();
	}
}

export interface RecordProducerOptions {
	addressSource(): readonly string[];
	capabilitySource(): readonly DrpCapability[];
	clock?(): number;
	readonly namespace: string;
	readonly peerId: string;
	readonly sequenceStore: SequenceStore;
	readonly signer: Pick<RecordSigner, "sign">;
	readonly ttlMs: number;
}

export interface RecordProducer {
	current(): Promise<SignedDrpRecordV1>;
	refresh(): Promise<SignedDrpRecordV1>;
	retire(): Promise<SignedDrpRecordV1>;
}

/**
 * Creates one serialized, live-input signed-record producer.
 * @param options - Live record inputs, signer, sequence owner, and TTL.
 * @returns A producer with cached current and strictly advancing refresh operations.
 */
export function createRecordProducer(options: RecordProducerOptions): RecordProducer {
	if (
		!Number.isSafeInteger(options.ttlMs) ||
		options.ttlMs < DEFAULT_RECORD_LIMITS.minTtlMs ||
		options.ttlMs > DEFAULT_RECORD_LIMITS.maxTtlMs
	) {
		throw new Error(
			`ttlMs must be an integer within ${DEFAULT_RECORD_LIMITS.minTtlMs}..${DEFAULT_RECORD_LIMITS.maxTtlMs}`
		);
	}
	const clock = options.clock ?? Date.now;
	let loadedSequence: Promise<number> | undefined;
	let currentRecord: SignedDrpRecordV1 | undefined;
	let currentPromise: Promise<SignedDrpRecordV1> | undefined;
	let queue: Promise<void> = Promise.resolve();

	const loadSequence = async (): Promise<number> => {
		loadedSequence ??= options.sequenceStore.load().then((value) => {
			validateSequence(value);
			return value;
		});
		return loadedSequence;
	};

	const produce = async (retiring = false): Promise<SignedDrpRecordV1> => {
		const prior = await loadSequence();
		const next = prior + 1;
		validateSequence(next);
		try {
			await options.sequenceStore.save(next);
		} catch (error) {
			// Another producer may have advanced the shared store after our load.
			loadedSequence = undefined;
			throw error;
		}
		loadedSequence = Promise.resolve(next);
		const nowMs = clock();
		const expiresAtMs = retiring ? nowMs + 5_000 : nowMs + options.ttlMs;
		const issuedAtMs = retiring ? expiresAtMs - DEFAULT_RECORD_LIMITS.minTtlMs : nowMs;
		if (!Number.isSafeInteger(issuedAtMs) || !Number.isSafeInteger(expiresAtMs)) {
			throw new Error("record clock and expiry must be safe integers");
		}
		const record = await options.signer.sign({
			addresses: options.addressSource(),
			capabilities: options.capabilitySource(),
			expiresAtMs,
			issuedAtMs,
			namespace: options.namespace,
			sequence: next,
		});
		if (record.peerId !== options.peerId) throw new Error("record signer identity does not match configured peerId");
		currentRecord = record;
		return record;
	};

	const serializedProduce = (retiring = false): Promise<SignedDrpRecordV1> => {
		const result = queue.then(
			() => produce(retiring),
			() => produce(retiring)
		);
		queue = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	};

	return {
		current: (): Promise<SignedDrpRecordV1> => {
			if (currentRecord !== undefined) return Promise.resolve(currentRecord);
			currentPromise ??= serializedProduce().finally(() => {
				currentPromise = undefined;
			});
			return currentPromise;
		},
		refresh: serializedProduce,
		retire: (): Promise<SignedDrpRecordV1> => serializedProduce(true),
	};
}

function validateSequence(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("sequence must be a non-negative safe integer");
}
