import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import {
	AdmissionPolicy,
	createOpaqueNamespaceV1,
	FixtureRegistryEndpoint,
	type RecordRejectionCode,
	RecordSigner,
	RecordValidator,
	type RegistrationReceipt,
	type RegistryAttempt,
	RegistryClient,
	type RegistryRejection,
	type RegistryRejectionCode,
	RegistryServer,
	type SignedDrpRecordV1,
} from "@ts-drp/rendezvous";
import { type BrowserRoutingTrace, DelegatedBrowserRouting, type EndpointAttempt } from "@ts-drp/routing-browser";

import type { FailureTerminal, FaultKind } from "./index.js";
import type { ProbeContext } from "../probe/kernel.js";
import { ManualClock } from "../probe/manual-clock.js";

const FIXTURE_NOW_MS = 1_750_000_000_000;
const INVITE_TOKEN = "failure-campaign-invite-token-v1";
const ROUTING_PEER_ID = "QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN";
const ROUTING_ADDRESS = "/dns4/relay.example.test/tcp/443/tls/ws";
const ROUTING_ORIGIN = "http://127.0.0.1:4175";
const namespace = createOpaqueNamespaceV1(fixtureSeed(240));
const publicResolver = { resolve: (): Promise<string[]> => Promise.resolve(["93.184.216.34"]) };

type RoutingFault = Extract<FaultKind, `delegated-${string}`>;
type RegistryFault = Extract<FaultKind, `${string}registr${string}`>;
type RecordFault = Extract<FaultKind, `record-${string}`> | "sybil-registration-flood";

/** Result returned by a real endpoint/validation owner exercise. */
export interface EndpointOwnerResult {
	readonly attempts: number;
	readonly backoffs: number;
	readonly terminal: FailureTerminal;
}

/**
 * Drives the delegated-routing owner through deterministic Response/fetch faults.
 * @param fault - Supported delegated-routing fault.
 * @param context - Probe-owned clock, abort signal, cleanup, and telemetry surface.
 * @returns Terminal and observed attempt/backoff counts.
 */
export async function runRoutingFailure(fault: RoutingFault, context: ProbeContext): Promise<EndpointOwnerResult> {
	assertRoutingFault(fault);
	const clock = requireManualClock(context);
	const routing = new DelegatedBrowserRouting({
		allowInsecureLoopback: true,
		allowedOrigins: [ROUTING_ORIGIN],
		backoffBaseMs: 100,
		cacheTTLms: fault === "delegated-stale-response" ? 1 : 0,
		endpoints: [{ id: "failure-endpoint", url: `${ROUTING_ORIGIN}/failure-campaign/` }],
		fetch: async (input, init): Promise<Response> => {
			const observed = await context.fetch(String(input), {
				method: init?.method,
				signal: init?.signal ?? context.signal,
			});
			const body = await observed.text();
			return new Response(body, {
				headers: {
					"content-type": fault === "delegated-oversized-response" ? "application/x-ndjson" : "application/json",
					...(fault === "delegated-oversized-response" ? { "content-length": String(body.length) } : {}),
					...(observed.status === 429 ? { "retry-after": "0.05" } : {}),
				},
				status: observed.status,
			});
		},
		limits: { maxResponseBytes: 1_024 },
		now: (): number => clock.now(),
		resolver: context.resolver,
		sleep: manualSleep(clock),
		timeoutMs: 1_000,
	});
	context.defer(() => routing.stop());

	const traces: BrowserRoutingTrace[] = [];
	if (fault === "delegated-stale-response") {
		await routing.findPeer(ROUTING_PEER_ID, context.signal);
		clock.advanceBy(2);
		await routing.findPeer(ROUTING_PEER_ID, context.signal).catch((error: unknown) => {
			context.signal.throwIfAborted();
			if (!(error instanceof Error)) throw error;
		});
		const trace = routing.lastTrace;
		if (trace === undefined || trace.cache !== "stale" || trace.terminal !== "exhausted") {
			throw new Error("routing owner did not observe failed stale-cache refresh");
		}
		traces.push(trace);
	} else {
		const repetitions = fault === "delegated-rate-limited" ? 3 : isEndpointFailure(fault) ? 2 : 1;
		for (let index = 0; index < repetitions; index += 1) {
			await routing.findPeer(ROUTING_PEER_ID, context.signal).catch((error: unknown) => {
				context.signal.throwIfAborted();
				if (!(error instanceof Error)) throw error;
			});
			const trace = routing.lastTrace;
			if (trace === undefined) throw new Error("routing owner omitted its attempt trace");
			traces.push(trace);
		}
	}

	const observedAttempts = traces.flatMap(({ attempts }) => attempts);
	const finalTrace = traces.at(-1);
	if (finalTrace === undefined) throw new Error("routing owner returned no trace");
	emitRoutingTrace(context, finalTrace, observedAttempts, fault);
	const backoffs = observedAttempts.filter(({ backoffMs }) => backoffMs > 0).length;
	const terminal = isEndpointFailure(fault) ? "owned-fallback" : "invalid-response";
	if (terminal === "owned-fallback") {
		context.emit("fallback", {
			delayMs: observedAttempts.reduce((total, { backoffMs }) => total + backoffMs, 0),
			from: "public-routing",
			reason: fault === "delegated-rate-limited" ? "policy" : "exhausted",
			to: "owned-fallback",
		});
	}
	return { attempts: observedAttempts.length, backoffs, terminal };
}

/**
 * Drives ordered registry discovery through one-down and all-down endpoints.
 * @param fault - Supported registry availability fault.
 * @param context - Probe-owned clock, abort signal, and telemetry surface.
 * @returns Terminal and observed attempt/backoff counts.
 */
export async function runRegistryFailure(fault: RegistryFault, context: ProbeContext): Promise<EndpointOwnerResult> {
	assertRegistryFault(fault);
	const clock = requireManualClock(context);
	const primaryServer = registryServer("registry-primary", clock);
	const secondaryServer = registryServer("registry-secondary", clock);
	const primary = new FixtureRegistryEndpoint(primaryServer);
	const secondary = new FixtureRegistryEndpoint(secondaryServer);
	const record = await signedRecord(80, clock.now());
	if (fault === "registry-one-unavailable") {
		const seeded = await secondaryServer.register({
			clientId: record.peerId,
			credential: { kind: "invite", token: INVITE_TOKEN },
			record,
			signal: context.signal,
		});
		if (!seeded.accepted) throw new Error(`registry seed rejected: ${seeded.code}`);
		primary.setAvailable(false);
	} else {
		primary.setAvailable(false);
		secondary.setAvailable(false);
	}

	const sleeps: number[] = [];
	const client = new RegistryClient({
		backoffMs: 100,
		clientId: "failure-browser",
		endpoints: [primary, secondary],
		sleep: async (durationMs, signal): Promise<void> => {
			sleeps.push(durationMs);
			await manualSleep(clock)(durationMs, signal);
		},
		timeoutMs: 1_000,
		validatorFactory: (): RecordValidator => recordValidator(clock),
	});
	let discoveredCount = 0;
	let exhausted = false;
	try {
		discoveredCount = (await client.discover(namespace, context.signal)).length;
	} catch (error) {
		context.signal.throwIfAborted();
		if (!(error instanceof Error) || error.name !== "RegistryExhaustedError") throw error;
		exhausted = true;
	}
	const attempts = client.lastAttempts;
	emitRegistryAttempts(context, attempts, sleeps);
	for (const [index, attempt] of attempts.entries()) {
		if (attempt.status !== "rejected") continue;
		context.emit("endpoint-failure", {
			endpointClass: "signed-registry",
			reason: "outage",
		});
		if (attempt.code !== "endpoint-unavailable") {
			throw new Error(`unexpected registry failure at ${index + 1}: ${attempt.code ?? "missing-code"}`);
		}
	}
	if (!exhausted) {
		const accepted = attempts.findIndex(({ status }) => status === "accepted");
		if (accepted < 0 || discoveredCount < 1) throw new Error("registry failover returned no signed record");
		context.emit("registry-discover", {
			count: discoveredCount,
			endpointPseudonym: endpointPseudonym(accepted),
		});
		return { attempts: attempts.length, backoffs: sleeps.length, terminal: "failover-recovered" };
	}
	context.emit("fallback", {
		delayMs: sleeps.reduce((total, durationMs) => total + durationMs, 0),
		from: "signed-registry",
		reason: "exhausted",
		to: "owned-fallback",
	});
	return { attempts: attempts.length, backoffs: sleeps.length, terminal: "owned-fallback" };
}

/**
 * Drives signed hostile registration rows through RegistryServer and RecordValidator.
 * @param fault - Supported signed-record fault.
 * @param context - Probe-owned clock, abort signal, and telemetry surface.
 * @returns Terminal and observed registration count.
 */
export async function runRecordFailure(fault: RecordFault, context: ProbeContext): Promise<EndpointOwnerResult> {
	assertRecordFault(fault);
	const clock = requireManualClock(context);
	const server = registryServer(
		"record-validator",
		clock,
		fault === "sybil-registration-flood" ? { maxRecordsPerNamespace: 63 } : undefined
	);
	const rows = fault === "sybil-registration-flood" ? 64 : 1;
	const observedCodes: RecordRejectionCode[] = [];
	const observedRegistryCodes: RegistryRejectionCode[] = [];
	let baseRecord = await signedRecord(120, clock.now());

	if (fault === "record-replayed") {
		const seeded = await register(server, baseRecord, context.signal);
		if (!seeded.accepted) throw new Error(`replay seed rejected: ${seeded.code}`);
	} else if (fault === "record-expired") {
		baseRecord = await signedRecord(121, clock.now() - 70_000, {
			expiresAtMs: FIXTURE_NOW_MS + clock.now() - 10_000,
		});
	} else if (fault === "record-oversized") {
		baseRecord = { ...baseRecord, signature: "A".repeat(9_000) };
	} else if (fault === "record-forged") {
		const forger = await signedRecord(122, clock.now());
		baseRecord = { ...baseRecord, signature: forger.signature };
	}

	for (let index = 0; index < rows; index += 1) {
		const candidate = fault === "sybil-registration-flood" ? await signedRecord(140 + index, clock.now()) : baseRecord;
		const result = await register(server, candidate, context.signal);
		context.emit("registry-register", {
			endpointPseudonym: endpointPseudonym(0),
			outcome: result.accepted ? "accepted" : result.code === "record-rejected" ? "invalid" : "refused",
		});
		if (result.accepted) {
			if (fault !== "sybil-registration-flood") {
				throw new Error(`${fault} hostile registration was unexpectedly accepted`);
			}
			continue;
		}
		observedRegistryCodes.push(result.code);
		if (result.code === "record-rejected" && result.detail !== undefined) {
			observedCodes.push(result.detail as RecordRejectionCode);
		}
	}
	if (fault === "sybil-registration-flood") {
		if (!observedRegistryCodes.includes("quota-exceeded")) {
			throw new Error("Sybil pressure did not reach the registry namespace quota");
		}
		return { attempts: rows, backoffs: 0, terminal: "registration-rejected" };
	}
	const reason = validationFailureReason(observedCodes);
	context.emit("registry-validation-failure", { reason });
	return { attempts: rows, backoffs: 0, terminal: "registration-rejected" };
}

function emitRoutingTrace(
	context: ProbeContext,
	trace: BrowserRoutingTrace,
	attempts: readonly EndpointAttempt[],
	fault: RoutingFault
): void {
	context.emit("routing-query", { method: trace.operation });
	context.emit("routing-result-count", { count: trace.resultCount });
	for (const [index, attempt] of attempts.entries()) {
		context.emit("endpoint-attempt", {
			attempt: index + 1,
			endpointClass: "delegated-routing",
			endpointPseudonym: endpointPseudonym(index),
		});
		if (attempt.backoffMs > 0) {
			context.emit("endpoint-backoff", {
				attempt: index + 1,
				delayMs: attempt.backoffMs,
				endpointClass: "delegated-routing",
			});
		}
		if (attempt.status !== "failure" || fault === "delegated-stale-response") continue;
		context.emit("endpoint-failure", routingFailureDetails(fault, attempt));
	}
	if (fault === "delegated-stale-response" && trace.cache === "stale") {
		context.emit("endpoint-failure", { endpointClass: "delegated-routing", reason: "stale" });
	}
}

function emitRegistryAttempts(
	context: ProbeContext,
	attempts: readonly RegistryAttempt[],
	sleeps: readonly number[]
): void {
	for (const [index] of attempts.entries()) {
		context.emit("endpoint-attempt", {
			attempt: index + 1,
			endpointClass: "signed-registry",
			endpointPseudonym: endpointPseudonym(index),
		});
		const delayMs = index === 0 ? undefined : sleeps[index - 1];
		if (delayMs !== undefined) {
			context.emit("endpoint-backoff", {
				attempt: index + 1,
				delayMs,
				endpointClass: "signed-registry",
			});
		}
	}
}

function routingFailureDetails(
	fault: RoutingFault,
	attempt: EndpointAttempt
): {
	endpointClass: "delegated-routing";
	reason: "cors" | "dns" | "malformed" | "outage" | "oversized" | "poisoned" | "rate-limited";
	status?: number;
} {
	if (attempt.httpStatus === 429) {
		return { endpointClass: "delegated-routing", reason: "rate-limited", status: 429 };
	}
	if (fault === "delegated-cors-dns-failure") {
		return {
			endpointClass: "delegated-routing",
			reason: attempt.error?.toLowerCase().includes("dns") === true ? "dns" : "cors",
		};
	}
	if (fault === "delegated-malformed-response") {
		return { endpointClass: "delegated-routing", reason: "malformed" };
	}
	if (fault === "delegated-oversized-response") {
		return { endpointClass: "delegated-routing", reason: "oversized" };
	}
	if (fault === "delegated-poisoned-response") {
		return { endpointClass: "delegated-routing", reason: "poisoned" };
	}
	return { endpointClass: "delegated-routing", reason: "outage" };
}

function registryServer(
	id: string,
	clock: ManualClock,
	limits?: ConstructorParameters<typeof RegistryServer>[0]["limits"]
): RegistryServer {
	const now = (): number => FIXTURE_NOW_MS + clock.now();
	return new RegistryServer({
		endpointId: id,
		...(limits === undefined ? {} : { limits }),
		now,
		policy: new AdmissionPolicy({ inviteToken: INVITE_TOKEN }, now),
		validator: recordValidator(clock),
	});
}

function recordValidator(clock: ManualClock): RecordValidator {
	return new RecordValidator({
		now: (): number => FIXTURE_NOW_MS + clock.now(),
		resolver: publicResolver,
	});
}

async function signedRecord(
	index: number,
	clockNowMs: number,
	options: { readonly expiresAtMs?: number } = {}
): Promise<SignedDrpRecordV1> {
	const key = await generateKeyPairFromSeed("Ed25519", fixtureSeed(index));
	const peerId = peerIdFromPublicKey(key.publicKey).toString();
	const issuedAtMs = FIXTURE_NOW_MS + clockNowMs;
	return new RecordSigner(key).sign({
		addresses: [`/dns4/relay.example.test/tcp/443/wss/p2p/${peerId}`],
		capabilities: ["drp-gossipsub", "webrtc"],
		expiresAtMs: options.expiresAtMs ?? issuedAtMs + 60_000,
		issuedAtMs,
		namespace,
		sequence: 1,
	});
}

function register(
	server: RegistryServer,
	record: SignedDrpRecordV1,
	signal: AbortSignal
): Promise<RegistrationReceipt | RegistryRejection> {
	return server.register({
		clientId: record.peerId,
		credential: { kind: "invite" as const, token: INVITE_TOKEN },
		record,
		signal,
	});
}

function validationFailureReason(
	codes: readonly RecordRejectionCode[]
): "address" | "expired" | "replay" | "signature" | "size" {
	if (codes.includes("replayed-sequence")) return "replay";
	if (codes.includes("expired")) return "expired";
	if (codes.includes("oversized")) return "size";
	if (codes.includes("invalid-signature")) return "signature";
	if (codes.includes("unsafe-address") || codes.includes("invalid-address")) return "address";
	throw new Error(`record owner returned no recognized validation code: ${codes.join(",")}`);
}

function manualSleep(clock: ManualClock): (durationMs: number, signal: AbortSignal) => Promise<void> {
	return async (durationMs, signal): Promise<void> => {
		const pending = clock.sleep(durationMs, signal);
		clock.advanceBy(durationMs);
		await pending;
	};
}

function requireManualClock(context: ProbeContext): ManualClock {
	if (!(context.clock instanceof ManualClock)) throw new Error("failure endpoint driver requires ManualClock");
	return context.clock;
}

function endpointPseudonym(index: number): `endpoint_${string}` {
	return `endpoint_${(index + 1).toString(16).padStart(12, "0")}`;
}

function fixtureSeed(index: number): Uint8Array {
	return Uint8Array.from({ length: 32 }, (_, offset) => (index * 29 + offset + 1) % 256);
}

function isEndpointFailure(fault: RoutingFault): boolean {
	return fault === "delegated-outage" || fault === "delegated-cors-dns-failure" || fault === "delegated-rate-limited";
}

function assertRoutingFault(fault: string): asserts fault is RoutingFault {
	if (!fault.startsWith("delegated-")) throw new Error(`unsupported routing fault: ${fault}`);
}

function assertRegistryFault(fault: string): asserts fault is RegistryFault {
	if (fault !== "registry-one-unavailable" && fault !== "all-registries-unavailable") {
		throw new Error(`unsupported registry fault: ${fault}`);
	}
}

function assertRecordFault(fault: string): asserts fault is RecordFault {
	if (
		fault !== "record-replayed" &&
		fault !== "record-expired" &&
		fault !== "record-oversized" &&
		fault !== "record-forged" &&
		fault !== "sybil-registration-flood"
	) {
		throw new Error(`unsupported record fault: ${fault}`);
	}
}
