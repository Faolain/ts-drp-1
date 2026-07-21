import { createDnsResolver } from "./dns-resolver.js";
import { reconcileValidatedRecords } from "./reconciliation.js";
import { type AdmissionMode, RecordValidator, type SignedDrpRecordV1 } from "./record.js";
import type { ValidatedDrpRecord } from "./registry.js";

/** Durable, public-only representation of one authenticated peer record. */
export interface StoredPeerRecord extends ValidatedDrpRecord {
	/** Client-observed insertion or refresh time. This is ordering metadata, never an expiry authority. */
	readonly cachedAtMs: number;
}

/** Runtime-specific persistence seam for the authenticated-peer cache. */
export interface PeerCacheStore {
	load(): Promise<readonly StoredPeerRecord[]>;
	save(records: readonly StoredPeerRecord[]): Promise<void>;
}

export interface PeerCache {
	/** Revalidates and inserts an authenticated record, refreshing its LRU position on an accepted update. */
	put(record: ValidatedDrpRecord | SignedDrpRecordV1): Promise<void>;
	/** Returns fresh, authenticated records for one namespace in LRU order. */
	list(namespace: string, signal: AbortSignal): Promise<readonly ValidatedDrpRecord[]>;
	/** Revalidates storage and durably removes expired, invalid, duplicate, and excess records. */
	prune(): Promise<void>;
}

export interface PeerCacheOptions {
	clock?(): number;
	readonly max: number;
	onPersistenceError?(event: PeerCachePersistenceErrorEvent): void;
	readonly store: PeerCacheStore;
	/** Optional policy-identical validator owner for callers with a configured resolver. */
	validatorFactory?(): RecordValidator;
}

/** Sanitized persistence failure telemetry; adapter errors and record material are intentionally absent. */
export interface PeerCachePersistenceErrorEvent {
	readonly kind: "peer-cache-persistence";
	readonly operation: "load" | "save";
	readonly outcome: "failed";
}

/** In-process store useful for ephemeral clients and deterministic tests. */
export class InMemoryPeerCacheStore implements PeerCacheStore {
	#records: readonly StoredPeerRecord[];

	/** @param initial - Initial authenticated record snapshot. */
	constructor(initial: readonly StoredPeerRecord[] = []) {
		this.#records = [...initial];
	}

	/** @returns A copy of the in-memory record snapshot. */
	load(): Promise<readonly StoredPeerRecord[]> {
		return Promise.resolve([...this.#records]);
	}

	/**
	 * @param records - Replacement authenticated record snapshot.
	 * @returns Completion after the snapshot is replaced.
	 */
	save(records: readonly StoredPeerRecord[]): Promise<void> {
		this.#records = [...records];
		return Promise.resolve();
	}
}

/**
 * Creates a bounded authenticated-peer cache. Persistent state is treated as
 * untrusted on every operation: records are signature/address/freshness
 * validated and reconciled before they can be returned or written back.
 * @param options - Cache bound, store, clock, validator, and sanitized failure sink.
 * @returns A serialized best-effort authenticated peer cache.
 */
export function createPeerCache(options: PeerCacheOptions): PeerCache {
	const maximum = boundedMaximum(options.max);
	const clock = options.clock ?? Date.now;
	const validatorFactory =
		options.validatorFactory ??
		((): RecordValidator =>
			new RecordValidator({
				now: clock,
				resolver: createDnsResolver(),
			}));
	let operationTail: Promise<void> = Promise.resolve();
	let memoryRecords: readonly StoredPeerRecord[] = [];
	let persistenceDirty = false;

	const reportPersistenceError = (operation: PeerCachePersistenceErrorEvent["operation"]): void => {
		try {
			options.onPersistenceError?.({ kind: "peer-cache-persistence", operation, outcome: "failed" });
		} catch {
			// Cache telemetry must not change cache behavior.
		}
	};

	const loadBestEffort = async (): Promise<readonly StoredPeerRecord[]> => {
		if (persistenceDirty) return memoryRecords;
		try {
			memoryRecords = [...(await options.store.load())];
		} catch {
			reportPersistenceError("load");
		}
		return memoryRecords;
	};

	const saveBestEffort = async (records: readonly StoredPeerRecord[]): Promise<void> => {
		memoryRecords = [...records];
		try {
			await options.store.save(memoryRecords);
			persistenceDirty = false;
		} catch {
			persistenceDirty = true;
			reportPersistenceError("save");
		}
	};

	const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
		const prior = operationTail;
		let release = (): void => undefined;
		operationTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await prior;
		try {
			return await operation();
		} finally {
			release();
		}
	};

	const normalize = async (signal: AbortSignal): Promise<readonly StoredPeerRecord[]> => {
		signal.throwIfAborted();
		const loaded: readonly unknown[] = await loadBestEffort();
		signal.throwIfAborted();
		const candidates = loaded.slice(-maximum);
		const checked: Array<{ readonly stored: StoredPeerRecord; readonly validated: ValidatedDrpRecord }> = [];
		for (const candidate of candidates) {
			signal.throwIfAborted();
			const envelope = parseStoredEnvelope(candidate);
			if (envelope === undefined || envelope.record.expiresAtMs <= clock()) continue;
			const validated = await validateRecord(
				envelope.record,
				envelope.admissionMode,
				envelope.sourceEndpointId,
				signal,
				validatorFactory
			);
			if (validated !== undefined && validated.record.expiresAtMs > clock()) {
				checked.push({
					stored: { ...validated, cachedAtMs: envelope.cachedAtMs },
					validated,
				});
			}
		}
		return reconcileInLruOrder(checked, clock(), maximum);
	};

	return {
		list: (namespace, signal) =>
			exclusive(async (): Promise<readonly ValidatedDrpRecord[]> => {
				signal.throwIfAborted();
				const normalized = await normalize(signal);
				await saveBestEffort(normalized);
				signal.throwIfAborted();
				return normalized
					.filter(({ record }) => record.namespace === namespace && record.expiresAtMs > clock())
					.map(({ cachedAtMs: _cachedAtMs, ...record }) => record);
			}),
		prune: () =>
			exclusive(async (): Promise<void> => {
				const normalized = await normalize(new AbortController().signal);
				await saveBestEffort(normalized);
			}),
		put: (input) =>
			exclusive(async (): Promise<void> => {
				const signal = new AbortController().signal;
				const candidate = parsePutEnvelope(input);
				if (candidate === undefined || candidate.record.expiresAtMs <= clock()) {
					throw new Error("peer cache requires a fresh authenticated signed record");
				}
				const validated = await validateRecord(
					candidate.record,
					candidate.admissionMode,
					candidate.sourceEndpointId,
					signal,
					validatorFactory
				);
				if (validated === undefined || validated.record.expiresAtMs <= clock()) {
					throw new Error("peer cache rejected unauthenticated or expired signed record");
				}

				const existing = await normalize(signal);
				const cachedAtMs = clock();
				const combined = [
					...existing.map((stored) => ({ stored, validated: withoutCachedAt(stored) })),
					{ stored: { ...validated, cachedAtMs }, validated },
				];
				const reconciled = reconcileInLruOrder(combined, cachedAtMs, maximum);
				await saveBestEffort(reconciled);
			}),
	};
}

function reconcileInLruOrder(
	candidates: readonly { readonly stored: StoredPeerRecord; readonly validated: ValidatedDrpRecord }[],
	now: number,
	maximum: number
): readonly StoredPeerRecord[] {
	const byNamespace = new Map<string, ValidatedDrpRecord[]>();
	for (const { validated } of candidates) {
		const records = byNamespace.get(validated.record.namespace) ?? [];
		records.push(validated);
		byNamespace.set(validated.record.namespace, records);
	}
	const survivors = new Set<string>();
	for (const records of byNamespace.values()) {
		for (const record of reconcileValidatedRecords([records], {
			maxRecords: Math.max(1, candidates.length),
			now,
		})) {
			survivors.add(recordIdentity(record));
		}
	}
	const emitted = new Set<string>();
	const inLruOrder: StoredPeerRecord[] = [];
	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		const candidate = candidates[index];
		if (candidate === undefined) continue;
		const identity = recordIdentity(candidate.validated);
		if (!survivors.has(identity) || emitted.has(identity)) continue;
		emitted.add(identity);
		inLruOrder.unshift(candidate.stored);
	}
	return inLruOrder.slice(-maximum);
}

function recordIdentity(record: ValidatedDrpRecord): string {
	return JSON.stringify(record.record);
}

async function validateRecord(
	record: SignedDrpRecordV1,
	admissionMode: AdmissionMode,
	sourceEndpointId: string,
	signal: AbortSignal,
	validatorFactory: () => RecordValidator
): Promise<ValidatedDrpRecord | undefined> {
	const result = await validatorFactory().validate(record, {
		admission: { accepted: true, mode: admissionMode },
		expectedNamespace: record.namespace,
		signal,
	});
	if (!result.accepted) return;
	return {
		admissionMode: result.admissionMode,
		record: result.record,
		sourceEndpointId,
	};
}

function parsePutEnvelope(
	input: ValidatedDrpRecord | SignedDrpRecordV1
):
	| { readonly admissionMode: AdmissionMode; readonly record: SignedDrpRecordV1; readonly sourceEndpointId: string }
	| undefined {
	if (isObject(input) && "record" in input) {
		if (
			!isAdmissionMode(input.admissionMode) ||
			typeof input.sourceEndpointId !== "string" ||
			!isObject(input.record)
		) {
			return;
		}
		return {
			admissionMode: input.admissionMode,
			record: input.record as unknown as SignedDrpRecordV1,
			sourceEndpointId: input.sourceEndpointId,
		};
	}
	return isObject(input)
		? {
				admissionMode: "invite",
				record: input as unknown as SignedDrpRecordV1,
				sourceEndpointId: "authenticated-session",
			}
		: undefined;
}

function parseStoredEnvelope(value: unknown): StoredPeerRecord | undefined {
	if (
		!isObject(value) ||
		!isAdmissionMode(value.admissionMode) ||
		!Number.isSafeInteger(value.cachedAtMs) ||
		(value.cachedAtMs as number) < 0 ||
		typeof value.sourceEndpointId !== "string" ||
		!isObject(value.record) ||
		typeof value.record.namespace !== "string" ||
		!Number.isSafeInteger(value.record.expiresAtMs)
	) {
		return;
	}
	return value as unknown as StoredPeerRecord;
}

function withoutCachedAt({ cachedAtMs: _cachedAtMs, ...record }: StoredPeerRecord): ValidatedDrpRecord {
	return record;
}

function isAdmissionMode(value: unknown): value is AdmissionMode {
	return value === "open" || value === "invite" || value === "allowlist" || value === "proof-of-work";
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function boundedMaximum(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > 4_096) {
		throw new Error("peer cache max must be an integer within 1..4096");
	}
	return value;
}
