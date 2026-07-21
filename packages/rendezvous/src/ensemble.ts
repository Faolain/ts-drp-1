import { type AddressPolicy, type Resolver } from "./address-policy.js";
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

export interface RendezvousEnsembleOptions {
	readonly addressPolicy: { readonly policy: AddressPolicy; readonly resolver: Resolver };
	readonly anchors?: { readonly resolver: AnchorRecordResolver };
	readonly limits?: RendezvousEnsembleLimits;
	readonly registries?: RendezvousDirectory | readonly RegistryEndpoint[];
	/** Creates identically configured validators for registry and untrusted anchor ingress. */
	validatorFactory?(): RecordValidator;
}

export interface AddressFilteredDrpRecord extends ValidatedDrpRecord {
	readonly acceptedAddresses: readonly string[];
}

export interface RendezvousEnsembleTrace {
	readonly policyRejectedAddressCount: number;
	readonly recordRejectedCount: number;
	readonly sources: ReadonlyArray<{
		readonly id: "dht-anchor" | "registries";
		readonly status: "empty" | "failed" | "succeeded";
	}>;
}

export interface RendezvousEnsemble extends RendezvousDirectory {
	readonly lastTrace: RendezvousEnsembleTrace | undefined;
}

/** Typed terminal for an ensemble operation with no healthy source. */
export class RendezvousExhaustedError extends Error {
	readonly failedSourceIds: readonly ("dht-anchor" | "registries")[];
	readonly operation: "discover" | "register";

	/**
	 * @param operation - Exhausted ensemble operation.
	 * @param failedSourceIds - Sanitized source categories.
	 */
	constructor(operation: "discover" | "register", failedSourceIds: readonly ("dht-anchor" | "registries")[]) {
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
	if (registries === undefined && options.anchors === undefined) {
		throw new Error("rendezvous ensemble requires at least one source");
	}
	let lastTrace: RendezvousEnsembleTrace | undefined;

	return {
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
				const filtered: AddressFilteredDrpRecord[] = [];
				for (const candidate of reconciled) {
					const acceptedAddresses: string[] = [];
					for (const address of candidate.record.addresses) {
						try {
							const decision = await options.addressPolicy.policy.evaluate(
								address,
								options.addressPolicy.resolver,
								deadline.signal
							);
							if (decision.dialable) acceptedAddresses.push(address);
							else policyRejectedAddressCount += 1;
						} catch {
							policyRejectedAddressCount += 1;
						}
					}
					if (acceptedAddresses.length > 0) filtered.push({ ...candidate, acceptedAddresses });
				}
				lastTrace = Object.freeze({
					policyRejectedAddressCount,
					recordRejectedCount: results.reduce((count, result) => count + result.recordRejectedCount, 0),
					sources: Object.freeze(sources),
				});
				return filtered;
			} finally {
				deadline.cleanup();
			}
		},
	};
}

interface SourceResult {
	readonly id: "dht-anchor" | "registries";
	readonly records: readonly ValidatedDrpRecord[];
	readonly recordRejectedCount: number;
	readonly status: "empty" | "failed" | "succeeded";
}

async function runSource(
	id: SourceResult["id"],
	maximum: number,
	signal: AbortSignal,
	operation: () => Promise<readonly ValidatedDrpRecord[]>
): Promise<SourceResult> {
	try {
		const records = await Promise.race([operation(), aborted(signal)]);
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
		const resolution = await Promise.race([resolver.resolve(namespace, signal, maximum), aborted(signal)]);
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
		},
		signal: controller.signal,
	};
}

function aborted(signal: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		const fail = (): void => reject(signal.reason ?? new Error("rendezvous operation aborted"));
		signal.addEventListener("abort", fail, { once: true });
		if (signal.aborted) fail();
	});
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be an integer within ${minimum}..${maximum}`);
	}
	return value;
}
