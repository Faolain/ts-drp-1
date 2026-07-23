import { describe, expect, it } from "vitest";

import {
	parseProbeEvent,
	parseProbeJsonLines,
	PROBE_EVENT_OWNERS,
	PROBE_EVENT_SCHEMA_VERSION,
	type ProbeEvent,
	ProbeEventPayloadSchemas,
	probeEventToJsonLine,
} from "../src/probe/index.js";

describe("ProbeEvent contract", () => {
	it("assigns every frozen telemetry kind to exactly one owner", () => {
		const kinds = Object.keys(ProbeEventPayloadSchemas).sort();
		expect(Object.keys(PROBE_EVENT_OWNERS).sort()).toEqual(kinds);
		expect(new Set(kinds).size).toBe(kinds.length);
		expect(kinds).toEqual(
			expect.arrayContaining([
				"routing-query",
				"routing-result-count",
				"address-family",
				"dial-attempt",
				"dial-result",
				"identify-protocols",
				"autonat-reachability",
				"relay-candidate",
				"relay-hop-support",
				"relay-reservation",
				"relay-reservation-limit",
				"relay-reservation-expiry",
				"relay-refresh",
				"relay-replacement",
				"registry-register",
				"registry-discover",
				"registry-freshness",
				"registry-validation-failure",
				"endpoint-attempt",
				"endpoint-backoff",
				"endpoint-failure",
				"milestone",
				"transport-selected",
				"ice-candidate-pair",
				"traffic-by-path",
				"fallback",
				"terminal",
				"resource-sample",
				"cleanup",
				"redaction",
			])
		);
	});

	it("round-trips strict kind-specific payloads and rejects side-channel fields", () => {
		const event: ProbeEvent = {
			atMs: 12,
			details: { method: "find-peer" },
			kind: "routing-query",
			probeId: "probe",
			runId: "run",
			schemaVersion: PROBE_EVENT_SCHEMA_VERSION,
			sequence: 0,
		};
		expect(parseProbeEvent(event)).toEqual(event);
		expect(parseProbeJsonLines(probeEventToJsonLine(event))).toEqual([event]);
		expect(() => parseProbeEvent({ ...event, details: { ...event.details, rawPeerId: "peer-secret" } })).toThrow();
		expect(() => parseProbeEvent({ ...event, probeId: "unsafe/probe" })).toThrow();
		expect(() =>
			parseProbeEvent({
				...event,
				details: { protocols: Array.from({ length: 65 }, () => "/noise") },
				kind: "identify-protocols",
			})
		).toThrow();
		expect(() => parseProbeJsonLines(`${probeEventToJsonLine({ ...event, sequence: 1 })}`)).toThrow(/sequence/u);
	});
});
