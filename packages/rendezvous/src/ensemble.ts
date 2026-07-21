import { type AddressPolicy, type Resolver } from "./address-policy.js";
import { type PeerCache } from "./peer-cache.js";
import { reconcileValidatedRecords } from "./reconciliation.js";
import { type AdmissionMode, RecordValidator, type SignedDrpRecordV1 } from "./record.js";
import {
	type AdmissionCredential,
	type ClientRegistrationReceipt,
	RegistryClient,
	type RegistryEndpoint,
	type RendezvousDirectory,
	type ValidatedDrpRecord,
} from "./registry.js";

export interface RendezvousBackendDescriptor {
	readonly directory: RendezvousDirectory;
	readonly id: string;
	readonly kind: "dht-anchor" | "http-registry";
}

export interface AnchorRecordResolution {
	/** Untrusted resolver output; the ensemble revalidates every envelope and signed record before use. */
	readonly records: readonly unknown[];
}

export interface AnchorRecordResolver {
	/** Resolves untrusted records that the ensemble will revalidate for signature, namespace, and address safety. */
	resolve(namespace: string, signal: AbortSignal, maxResults?: number): Promise<AnchorRecordResolution>;
}

export interface RendezvousEnsembleLimits {
	readonly maxRecordsPerSource?: number;
	readonly timeoutMs?: number;
}

export interface BootstrapDirectory {
	discover(namespace: string, signal: AbortSignal): Promise<readonly ValidatedDrpRecord[]>;
}

export interface RendezvousEnsembleOptions {
	readonly addressPolicy: { readonly policy: AddressPolicy; readonly resolver: Resolver };
	readonly anchors?: { readonly resolver: AnchorRecordResolver };
	readonly cache?: PeerCache;
	readonly invite?: BootstrapDirectory;
	readonly limits?: RendezvousEnsembleLimits;
	readonly peerExchange?: BootstrapDirectory;
	readonly registries?: RendezvousDirectory | readonly RegistryEndpoint[];
	/** Creates identically configured validators for every untrusted bootstrap ingress. */
	validatorFactory?(): RecordValidator;
}

export interface AddressFilteredDrpRecord extends ValidatedDrpRecord {
	readonly acceptedAddresses: readonly string[];
}

export interface RendezvousEnsembleTrace {
	readonly policyRejectedAddressCount: number;
	readonly recordRejectedCount: number;
	readonly sources: ReadonlyArray<{
		readonly id: BootstrapSourceId;
		readonly status: "empty" | "failed" | "succeeded";
	}>;
}

export interface RendezvousEnsemble extends RendezvousDirectory {
	bootstrap(namespace: string, signal: AbortSignal): AsyncIterable<AddressFilteredDrpRecord>;
	readonly lastTrace: RendezvousEnsembleTrace | undefined;
}

export type BootstrapSourceId = "cache" | "dht-anchor" | "invite" | "peer-exchange" | "registries";

/** Typed terminal for an ensemble operation with no healthy source. */
export class RendezvousExhaustedError extends Error {
	readonly failedSourceIds: readonly BootstrapSourceId[];
	readonly operation: "bootstrap" | "discover" | "register";

	/**
	 * @param operation - Exhausted ensemble operation.
	 * @param failedSourceIds - Sanitized source categories.
	 */
	constructor(operation: "bootstrap" | "discover" | "register", failedSourceIds: readonly BootstrapSourceId[]) {
		super(`all rendezvous sources failed ${operation}`);
		this.name = "RendezvousExhaustedError";
		this.operation = operation;
		this.failedSourceIds = Object.freeze([...failedSourceIds]);
	}
}

/**
 * Composes registry and signed-record anchor owners behind one bounded directory.
 * @param options - Registry, anchor, validation, address-policy, and bound owners.
 * @returns A bounded rendezvous directory with its latest sanitized trace.
 */
export function createRendezvousEnsemble(options: RendezvousEnsembleOptions): RendezvousEnsemble {
	const maximum = boundedInteger(options.limits?.maxRecordsPerSource ?? 64, 1, 256, "maxRecordsPerSource");
	const timeoutMs = boundedInteger(options.limits?.timeoutMs ?? 4_000, 1, 30_000, "timeoutMs");
	const validatorFactory =
		options.validatorFactory ??
		((): RecordValidator => new RecordValidator({ resolver: options.addressPolicy.resolver }));
	const registries = normalizeRegistries(options.registries, maximum, timeoutMs, validatorFactory);
	if (
		registries === undefined &&
		options.anchors === undefined &&
		options.cache === undefined &&
		options.invite === undefined &&
		options.peerExchange === undefined
	) {
		throw new Error("rendezvous ensemble requires at least one source");
	}
	let lastTrace: RendezvousEnsembleTrace | undefined;

	return {
		bootstrap: async function* (namespace: string, signal: AbortSignal): AsyncIterable<AddressFilteredDrpRecord> {
			const deadline = operationDeadline(signal, timeoutMs);
			try {
				const initialTasks: Array<Promise<SourceResult>> = [];
				if (registries !== undefined) {
					initialTasks.push(
						runValidatedDirectorySource("registries", registries, namespace, maximum, deadline.signal, validatorFactory)
					);
				}
				if (options.anchors !== undefined) {
					initialTasks.push(
						runAnchorSource(options.anchors.resolver, namespace, maximum, deadline.signal, validatorFactory)
					);
				}
				if (options.invite !== undefined) {
					initialTasks.push(
						runValidatedDirectorySource("invite", options.invite, namespace, maximum, deadline.signal, validatorFactory)
					);
				}

				const results: SourceResult[] = [];
				const emitted = new Map<string, number>();
				if (options.cache !== undefined) {
					const cached = await runCacheSource(options.cache, namespace, maximum, deadline.signal);
					results.push(cached);
					const filtered = await filterAddresses(
						reconcileValidatedRecords([cached.records], { maxRecords: maximum }),
						options.addressPolicy,
						deadline.signal
					);
					for (const candidate of filtered.records) {
						emitted.set(candidate.record.peerId, candidate.record.sequence);
						yield candidate;
					}
				}

				results.push(...(await Promise.all(initialTasks)));
				if (options.peerExchange !== undefined) {
					results.push(
						await runValidatedDirectorySource(
							"peer-exchange",
							options.peerExchange,
							namespace,
							maximum,
							deadline.signal,
							validatorFactory
						)
					);
				}

				const nonCacheResults = results.filter(({ id }) => id !== "cache");
				const failedSourceIds = nonCacheResults.filter(({ status }) => status === "failed").map(({ id }) => id);
				const networkRecords = reconcileValidatedRecords(
					nonCacheResults.filter(({ status }) => status !== "failed").map(({ records }) => records),
					{ maxRecords: maximum }
				);
				const filtered = await filterAddresses(networkRecords, options.addressPolicy, deadline.signal);
				for (const candidate of filtered.records) {
					if (options.cache !== undefined) {
						try {
							await raceWithSignal(options.cache.put(candidate), deadline.signal);
						} catch {
							// Persistence is an availability optimization and cannot suppress a valid bootstrap result.
						}
					}
					const priorSequence = emitted.get(candidate.record.peerId);
					if (priorSequence !== undefined && priorSequence >= candidate.record.sequence) continue;
					emitted.set(candidate.record.peerId, candidate.record.sequence);
					yield candidate;
				}

				lastTrace = traceFor(results, filtered.policyRejectedAddressCount);
				if (emitted.size === 0 && nonCacheResults.length > 0 && failedSourceIds.length === nonCacheResults.length) {
					throw new RendezvousExhaustedError("bootstrap", failedSourceIds);
				}
			} finally {
				deadline.cleanup();
			}
		},
		get lastTrace(): RendezvousEnsembleTrace | undefined {
			return lastTrace;
		},
		register: (
			record: SignedDrpRecordV1,
			signal: AbortSignal,
			credential?: AdmissionCredential
		): Promise<ClientRegistrationReceipt> => {
			if (registries === undefined) {
				return Promise.reject(new RendezvousExhaustedError("register", ["registries"]));
			}
			return registries.register(record, signal, credential);
		},
		discover: async (namespace: string, signal: AbortSignal): Promise<readonly AddressFilteredDrpRecord[]> => {
			const deadline = operationDeadline(signal, timeoutMs);
			try {
				const tasks: Array<Promise<SourceResult>> = [];
				if (registries !== undefined) {
					tasks.push(
						runSource("registries", maximum, deadline.signal, () => registries.discover(namespace, deadline.signal))
					);
				}
				if (options.anchors !== undefined) {
					tasks.push(runAnchorSource(options.anchors.resolver, namespace, maximum, deadline.signal, validatorFactory));
				}
				const results = await Promise.all(tasks);
				const sources = results.map(({ id, status }) => ({ id, status }));
				const failedSourceIds = results.filter(({ status }) => status === "failed").map(({ id }) => id);
				if (failedSourceIds.length === results.length) {
					lastTrace = Object.freeze({
						policyRejectedAddressCount: 0,
						recordRejectedCount: results.reduce((count, result) => count + result.recordRejectedCount, 0),
						sources: Object.freeze(sources),
					});
					throw new RendezvousExhaustedError("discover", failedSourceIds);
				}
				const reconciled = reconcileValidatedRecords(
					results.filter(({ status }) => status !== "failed").map(({ records }) => records)
				);
				let policyRejectedAddressCount = 0;
				const filtered = await filterAddresses(reconciled, options.addressPolicy, deadline.signal);
				policyRejectedAddressCount = filtered.policyRejectedAddressCount;
				lastTrace = Object.freeze({
					policyRejectedAddressCount,
					recordRejectedCount: results.reduce((count, result) => count + result.recordRejectedCount, 0),
					sources: Object.freeze(sources),
				});
				return filtered.records;
			} finally {
				deadline.cleanup();
			}
		},
	};
}

interface SourceResult {
	readonly id: BootstrapSourceId;
	readonly records: readonly ValidatedDrpRecord[];
	readonly recordRejectedCount: number;
	readonly status: "empty" | "failed" | "succeeded";
}

async function runCacheSource(
	cache: PeerCache,
	namespace: string,
	maximum: number,
	signal: AbortSignal
): Promise<SourceResult> {
	try {
		const records = await raceWithSignal(cache.list(namespace, signal), signal);
		if (records.length > maximum) throw new Error("source record cap exceeded");
		return sourceResult("cache", records, 0);
	} catch {
		return { id: "cache", records: [], recordRejectedCount: 0, status: "failed" };
	}
}

async function runValidatedDirectorySource(
	id: Extract<BootstrapSourceId, "invite" | "peer-exchange" | "registries">,
	directory: BootstrapDirectory,
	namespace: string,
	maximum: number,
	signal: AbortSignal,
	validatorFactory: () => RecordValidator
): Promise<SourceResult> {
	try {
		const candidates = await raceWithSignal(directory.discover(namespace, signal), signal);
		if (candidates.length > maximum) throw new Error("source record cap exceeded");
		const validator = validatorFactory();
		const records: ValidatedDrpRecord[] = [];
		let recordRejectedCount = 0;
		for (const candidate of candidates) {
			const checked = await validator.validate(candidate.record, {
				admission: { accepted: true, mode: candidate.admissionMode },
				expectedNamespace: namespace,
				signal,
			});
			if (!checked.accepted) {
				recordRejectedCount += 1;
				continue;
			}
			records.push({
				admissionMode: checked.admissionMode,
				record: checked.record,
				sourceEndpointId: candidate.sourceEndpointId,
			});
		}
		return sourceResult(id, records, recordRejectedCount);
	} catch {
		return { id, records: [], recordRejectedCount: 0, status: "failed" };
	}
}

async function runSource(
	id: SourceResult["id"],
	maximum: number,
	signal: AbortSignal,
	operation: () => Promise<readonly ValidatedDrpRecord[]>
): Promise<SourceResult> {
	try {
		const records = await raceWithSignal(operation(), signal);
		if (records.length > maximum) throw new Error("source record cap exceeded");
		return { id, records, recordRejectedCount: 0, status: records.length === 0 ? "empty" : "succeeded" };
	} catch {
		return { id, records: [], recordRejectedCount: 0, status: "failed" };
	}
}

async function runAnchorSource(
	resolver: AnchorRecordResolver,
	namespace: string,
	maximum: number,
	signal: AbortSignal,
	validatorFactory: () => RecordValidator
): Promise<SourceResult> {
	try {
		const resolution = await raceWithSignal(resolver.resolve(namespace, signal, maximum), signal);
		if (resolution.records.length > maximum) throw new Error("source record cap exceeded");
		const validator = validatorFactory();
		const records: ValidatedDrpRecord[] = [];
		let recordRejectedCount = 0;
		for (const candidate of resolution.records) {
			const envelope = parseAnchorEnvelope(candidate);
			if (envelope === undefined) {
				recordRejectedCount += 1;
				continue;
			}
			const checked = await validator.validate(envelope.record, {
				admission: { accepted: true, mode: envelope.admissionMode },
				expectedNamespace: namespace,
				signal,
			});
			if (!checked.accepted) {
				recordRejectedCount += 1;
				continue;
			}
			records.push({
				admissionMode: checked.admissionMode,
				record: checked.record,
				sourceEndpointId: "dht-anchor",
			});
		}
		return {
			id: "dht-anchor",
			records,
			recordRejectedCount,
			status: records.length === 0 ? "empty" : "succeeded",
		};
	} catch {
		return { id: "dht-anchor", records: [], recordRejectedCount: 0, status: "failed" };
	}
}

function sourceResult(
	id: BootstrapSourceId,
	records: readonly ValidatedDrpRecord[],
	recordRejectedCount: number
): SourceResult {
	return {
		id,
		records,
		recordRejectedCount,
		status: records.length === 0 ? "empty" : "succeeded",
	};
}

async function filterAddresses(
	records: readonly ValidatedDrpRecord[],
	addressPolicy: RendezvousEnsembleOptions["addressPolicy"],
	signal: AbortSignal
): Promise<{ readonly policyRejectedAddressCount: number; readonly records: readonly AddressFilteredDrpRecord[] }> {
	let policyRejectedAddressCount = 0;
	const filtered: AddressFilteredDrpRecord[] = [];
	for (const candidate of records) {
		const acceptedAddresses: string[] = [];
		for (const address of candidate.record.addresses) {
			try {
				const decision = await addressPolicy.policy.evaluate(address, addressPolicy.resolver, signal);
				if (decision.dialable) acceptedAddresses.push(address);
				else policyRejectedAddressCount += 1;
			} catch {
				policyRejectedAddressCount += 1;
			}
		}
		if (acceptedAddresses.length > 0) filtered.push({ ...candidate, acceptedAddresses });
	}
	return { policyRejectedAddressCount, records: filtered };
}

function traceFor(results: readonly SourceResult[], policyRejectedAddressCount: number): RendezvousEnsembleTrace {
	return Object.freeze({
		policyRejectedAddressCount,
		recordRejectedCount: results.reduce((count, result) => count + result.recordRejectedCount, 0),
		sources: Object.freeze(results.map(({ id, status }) => ({ id, status }))),
	});
}

function parseAnchorEnvelope(
	value: unknown
): { readonly admissionMode: AdmissionMode; readonly record: unknown } | undefined {
	if (typeof value !== "object" || value === null || !("admissionMode" in value) || !("record" in value)) return;
	const admissionMode = value.admissionMode;
	if (
		admissionMode !== "open" &&
		admissionMode !== "invite" &&
		admissionMode !== "allowlist" &&
		admissionMode !== "proof-of-work"
	) {
		return;
	}
	return { admissionMode, record: value.record };
}

function normalizeRegistries(
	input: RendezvousEnsembleOptions["registries"],
	maximum: number,
	timeoutMs: number,
	validatorFactory: () => RecordValidator
): RendezvousDirectory | undefined {
	if (input === undefined) return undefined;
	if (!Array.isArray(input)) return input as RendezvousDirectory;
	return new RegistryClient({
		backoffMs: 0,
		clientId: "rendezvous-client",
		endpoints: input,
		limits: { maxEndpoints: 8, maxResponseRecords: maximum },
		timeoutMs,
		validatorFactory,
	});
}

interface OperationDeadline {
	readonly signal: AbortSignal;
	cleanup(): void;
}

function operationDeadline(parent: AbortSignal, timeoutMs: number): OperationDeadline {
	parent.throwIfAborted();
	const controller = new AbortController();
	const abortFromParent = (): void => controller.abort(parent.reason);
	parent.addEventListener("abort", abortFromParent, { once: true });
	const timeout = setTimeout(() => controller.abort(new Error("rendezvous operation timed out")), timeoutMs);
	return {
		cleanup: (): void => {
			clearTimeout(timeout);
			parent.removeEventListener("abort", abortFromParent);
			if (!controller.signal.aborted) controller.abort(new Error("rendezvous operation complete"));
		},
		signal: controller.signal,
	};
}

function raceWithSignal<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
	return new Promise((resolve, reject) => {
		const fail = (): void => reject(signal.reason ?? new Error("rendezvous operation aborted"));
		if (signal.aborted) {
			fail();
			return;
		}
		signal.addEventListener("abort", fail, { once: true });
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", fail));
	});
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be an integer within ${minimum}..${maximum}`);
	}
	return value;
}
