import { z } from "zod";

export const PROBE_EVENT_SCHEMA_VERSION = "1.0.0";

const PseudonymSchema = z.string().regex(/^[a-z]+_[a-f0-9]{12}$/u);
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const EndpointClassSchema = z.enum([
	"public-dht",
	"delegated-routing",
	"signed-registry",
	"public-relay",
	"owned-fallback",
]);

export const ProbeEventPayloadSchemas = {
	"routing-query": z
		.object({ method: z.enum(["find-peer", "find-providers", "get-closest-peers", "provide"]) })
		.strict(),
	"routing-result-count": z.object({ count: NonNegativeIntegerSchema }).strict(),
	"address-family": z
		.object({ count: NonNegativeIntegerSchema, family: z.enum(["ipv4", "ipv6", "dns", "unknown"]) })
		.strict(),
	"dial-attempt": z
		.object({
			addressPseudonym: PseudonymSchema,
			attempt: z.number().int().positive(),
			family: z.enum(["ipv4", "ipv6", "dns", "unknown"]),
			transport: z.enum(["wss", "webtransport", "webrtc-direct", "relay", "tcp", "quic-v1", "unknown"]),
		})
		.strict(),
	"dial-result": z
		.object({
			addressPseudonym: PseudonymSchema,
			latencyMs: NonNegativeIntegerSchema,
			outcome: z.enum(["connected", "refused", "timeout", "aborted", "invalid"]),
		})
		.strict(),
	"identify-protocols": z.object({ protocols: z.array(z.string().startsWith("/").max(128)).max(64) }).strict(),
	"autonat-reachability": z.object({ status: z.enum(["public", "private", "unknown"]) }).strict(),
	"relay-candidate": z
		.object({
			candidatePseudonym: PseudonymSchema,
			provenance: z.enum(["routing", "registry", "configured", "owned-fallback"]),
			source: z.enum(["public-dht", "delegated-routing", "signed-registry", "fixed"]),
		})
		.strict(),
	"relay-hop-support": z.object({ candidatePseudonym: PseudonymSchema, supported: z.boolean() }).strict(),
	"relay-reservation": z
		.object({
			candidatePseudonym: PseudonymSchema,
			latencyMs: NonNegativeIntegerSchema,
			outcome: z.enum(["accepted", "refused", "timeout", "aborted"]),
		})
		.strict(),
	"relay-reservation-limit": z
		.object({
			candidatePseudonym: PseudonymSchema,
			dataBytes: NonNegativeIntegerSchema.optional(),
			durationSeconds: NonNegativeIntegerSchema.optional(),
		})
		.strict(),
	"relay-reservation-expiry": z
		.object({ candidatePseudonym: PseudonymSchema, expiresInMs: NonNegativeIntegerSchema })
		.strict(),
	"relay-refresh": z
		.object({
			attempt: z.number().int().positive(),
			candidatePseudonym: PseudonymSchema,
			outcome: z.enum(["accepted", "refused", "timeout", "aborted"]),
		})
		.strict(),
	"relay-replacement": z
		.object({
			outcome: z.enum(["accepted", "exhausted", "owned-fallback"]),
			reason: z.enum(["expired", "disconnected", "refresh-refused", "limit", "policy"]),
		})
		.strict(),
	"registry-register": z
		.object({ endpointPseudonym: PseudonymSchema, outcome: z.enum(["accepted", "refused", "timeout", "invalid"]) })
		.strict(),
	"registry-discover": z.object({ count: NonNegativeIntegerSchema, endpointPseudonym: PseudonymSchema }).strict(),
	"registry-freshness": z.object({ accepted: z.boolean(), ageMs: NonNegativeIntegerSchema }).strict(),
	"registry-validation-failure": z
		.object({
			reason: z.enum(["signature", "expired", "future", "namespace", "size", "address", "replay"]),
		})
		.strict(),
	"endpoint-attempt": z
		.object({
			attempt: z.number().int().positive(),
			endpointClass: EndpointClassSchema,
			endpointPseudonym: PseudonymSchema,
		})
		.strict(),
	"endpoint-backoff": z
		.object({
			attempt: z.number().int().positive(),
			delayMs: NonNegativeIntegerSchema,
			endpointClass: EndpointClassSchema,
		})
		.strict(),
	"endpoint-failure": z
		.object({
			endpointClass: EndpointClassSchema,
			reason: z.enum(["cors", "dns", "malformed", "outage", "oversized", "poisoned", "rate-limited", "stale"]),
			status: NonNegativeIntegerSchema.optional(),
		})
		.strict(),
	"milestone": z
		.object({
			durationMs: NonNegativeIntegerSchema,
			name: z.enum(["first-reservation", "first-drp-peer", "mesh-joined", "first-object"]),
		})
		.strict(),
	"transport-selected": z
		.object({ transport: z.enum(["wss", "webtransport", "webrtc-direct", "relay", "tcp", "quic-v1"]) })
		.strict(),
	"ice-candidate-pair": z
		.object({
			correlated: z.boolean(),
			localType: z.enum(["host", "srflx", "prflx", "relay", "unknown"]),
			remoteType: z.enum(["host", "srflx", "prflx", "relay", "unknown"]),
		})
		.strict(),
	"traffic-by-path": z
		.object({
			path: z.enum(["relayed", "direct"]),
			receivedBytes: NonNegativeIntegerSchema,
			sentBytes: NonNegativeIntegerSchema,
		})
		.strict(),
	"fallback": z
		.object({
			delayMs: NonNegativeIntegerSchema,
			from: z.enum(["public-routing", "public-relay", "signed-registry"]),
			reason: z.enum(["exhausted", "timeout", "invalid", "policy"]),
			to: z.literal("owned-fallback"),
		})
		.strict(),
	"terminal": z
		.object({
			durationMs: NonNegativeIntegerSchema,
			reason: z
				.string()
				.min(1)
				.max(64)
				.regex(/^[a-z0-9-]+$/u),
			status: z.enum(["success", "failure", "aborted", "timeout"]),
		})
		.strict(),
	"resource-sample": z
		.object({
			activeTimers: NonNegativeIntegerSchema,
			heapBytes: NonNegativeIntegerSchema.optional(),
			openHandles: NonNegativeIntegerSchema,
		})
		.strict(),
	"cleanup": z
		.object({
			completed: NonNegativeIntegerSchema,
			failed: NonNegativeIntegerSchema,
			phase: z.enum(["start", "finish"]),
			registered: NonNegativeIntegerSchema,
		})
		.strict(),
	"redaction": z
		.object({
			namespaces: z.literal("per-run-pseudonyms"),
			operatorDiversity: z.literal("aggregate-only"),
			peerIds: z.literal("per-run-pseudonyms"),
		})
		.strict(),
} satisfies Record<string, z.ZodTypeAny>;

export type ProbeEventKind = keyof typeof ProbeEventPayloadSchemas;
export type ProbeEventDetails<Kind extends ProbeEventKind> = z.infer<(typeof ProbeEventPayloadSchemas)[Kind]>;

export type ProbeEvent = {
	[Kind in ProbeEventKind]: {
		atMs: number;
		details: ProbeEventDetails<Kind>;
		kind: Kind;
		probeId: string;
		runId: string;
		schemaVersion: typeof PROBE_EVENT_SCHEMA_VERSION;
		sequence: number;
	};
}[ProbeEventKind];

export const PROBE_EVENT_OWNERS = {
	"routing-query": "routing",
	"routing-result-count": "routing",
	"address-family": "address-policy",
	"dial-attempt": "dialer",
	"dial-result": "dialer",
	"identify-protocols": "network-observation",
	"autonat-reachability": "network-observation",
	"relay-candidate": "relay-policy",
	"relay-hop-support": "relay-policy",
	"relay-reservation": "relay-policy",
	"relay-reservation-limit": "relay-policy",
	"relay-reservation-expiry": "relay-policy",
	"relay-refresh": "relay-policy",
	"relay-replacement": "relay-policy",
	"registry-register": "registry",
	"registry-discover": "registry",
	"registry-freshness": "record-validator",
	"registry-validation-failure": "record-validator",
	"endpoint-attempt": "endpoint-policy",
	"endpoint-backoff": "endpoint-policy",
	"endpoint-failure": "endpoint-policy",
	"milestone": "probe-runner",
	"transport-selected": "network-observation",
	"ice-candidate-pair": "network-observation",
	"traffic-by-path": "network-observation",
	"fallback": "probe-runner",
	"terminal": "probe-runner",
	"resource-sample": "probe-runner",
	"cleanup": "probe-runner",
	"redaction": "probe-runner",
} as const satisfies Record<ProbeEventKind, string>;

const ProbeEventEnvelopeSchema = z
	.object({
		atMs: NonNegativeIntegerSchema,
		details: z.unknown(),
		kind: z.enum(Object.keys(ProbeEventPayloadSchemas) as [ProbeEventKind, ...ProbeEventKind[]]),
		probeId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u),
		runId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u),
		schemaVersion: z.literal(PROBE_EVENT_SCHEMA_VERSION),
		sequence: NonNegativeIntegerSchema,
	})
	.strict();

/**
 * Parses one durable probe event against its kind-specific payload schema.
 * @param value - Candidate event.
 * @returns A typed probe event.
 */
export function parseProbeEvent(value: unknown): ProbeEvent {
	const envelope = ProbeEventEnvelopeSchema.parse(value);
	const details = ProbeEventPayloadSchemas[envelope.kind].parse(envelope.details);
	return { ...envelope, details } as ProbeEvent;
}

/**
 * Serializes an event as a single replayable JSONL row.
 * @param event - Typed event to serialize.
 * @returns One newline-terminated JSON row.
 */
export function probeEventToJsonLine(event: ProbeEvent): string {
	return `${JSON.stringify(parseProbeEvent(event))}\n`;
}

/**
 * Parses ordered JSONL and rejects gaps or reordered sequence numbers.
 * @param jsonl - Durable JSONL event stream.
 * @returns Parsed ordered events.
 */
export function parseProbeJsonLines(jsonl: string): ProbeEvent[] {
	const events = jsonl
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => parseProbeEvent(JSON.parse(line)));
	events.forEach((event, index) => {
		if (event.sequence !== index) {
			throw new Error(`probe event sequence ${event.sequence} appeared at row ${index}`);
		}
	});
	return events;
}
