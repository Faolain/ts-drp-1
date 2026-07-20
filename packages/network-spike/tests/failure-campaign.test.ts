import { describe, expect, it } from "vitest";

import {
	assertFailureCampaign,
	FAILURE_CAMPAIGN_SCHEMA_VERSION,
	type FailureCampaignReport,
	FailureControlPlaneHealthAdapter,
	failureScenarios,
	renderFailureCampaignHtml,
	renderFailureCampaignMarkdown,
	runFailureCampaign,
	runFailureScenario,
} from "../src/failure-campaign/index.js";

describe("Phase 08 deterministic failure campaign", () => {
	it("pre-registers every issue-listed fault class in one bounded table", () => {
		const scenarios = failureScenarios();
		expect(scenarios).toHaveLength(24);
		expect(new Set(scenarios.map(({ id }) => id)).size).toBe(scenarios.length);
		expect(new Set(scenarios.map(({ category }) => category))).toEqual(
			new Set(["composed", "control-plane", "record", "registry", "relay", "routing"])
		);
		expect(scenarios.flatMap(({ schedule }) => schedule.steps).map(({ fault }) => fault)).toEqual(
			expect.arrayContaining([
				"delegated-outage",
				"delegated-cors-dns-failure",
				"delegated-rate-limited",
				"delegated-stale-response",
				"delegated-poisoned-response",
				"delegated-malformed-response",
				"delegated-oversized-response",
				"undialable-50",
				"undialable-75",
				"undialable-90",
				"all-reservations-refused",
				"relay-loss-during-signaling",
				"relay-loss-after-reservation",
				"relay-loss-after-direct",
				"registry-one-unavailable",
				"all-registries-unavailable",
				"record-replayed",
				"record-expired",
				"record-oversized",
				"record-forged",
				"sybil-registration-flood",
				"stale-dnsaddr-fallback",
				"control-health-degraded",
				"all-dependencies-down",
			])
		);
		for (const scenario of scenarios) {
			expect(scenario.schedule.parentDeadlineMs).toBe(30_000);
			expect(scenario.schedule.childBudgets).toEqual({
				cleanupMs: 5_000,
				ownedFallbackMs: 12_000,
				registryAndRoutingMs: 8_000,
				relaySearchMs: 5_000,
			});
		}
	});

	it("keeps reconnect ownership typed, capped, and spike-local", () => {
		const health = new FailureControlPlaneHealthAdapter(1);
		expect(health.snapshot).toEqual({
			productionReconnectRedesignDeferredToPhase10: true,
			reconnectAttempts: 0,
			state: "healthy",
		});
		health.degrade();
		health.beginReconnect();
		expect(() => health.beginReconnect()).toThrow("cannot reconnect");
		health.recover();
		expect(health.snapshot).toEqual({
			productionReconnectRedesignDeferredToPhase10: true,
			reason: "dependency-outage",
			reconnectAttempts: 1,
			state: "recovered",
		});
	});

	it("reaches every typed terminal with complete telemetry and no leaked work", async () => {
		const report = await runFailureCampaign();

		expect(() => assertFailureCampaign(report)).not.toThrow();
		expect(report).toMatchObject({
			fixture: "all",
			generatedAt: "deterministic-fixture",
			noPublicEgress: true,
			parentDeadlineMs: 30_000,
			schemaVersion: FAILURE_CAMPAIGN_SCHEMA_VERSION,
			summary: { failed: 0, passed: 24, total: 24 },
		});
		for (const scenario of report.scenarios) {
			expect(scenario.passed, scenario.id).toBe(true);
			expect(
				scenario.checks.every(({ passed }) => passed),
				scenario.id
			).toBe(true);
			expect(scenario.cleanup.failed).toBe(0);
			expect(scenario.cleanup.completed).toBe(scenario.cleanup.registered);
			expect(scenario.events.findLast(({ kind }) => kind === "resource-sample")).toMatchObject({
				details: { activeTimers: 0, openHandles: 0 },
			});
			expect(scenario.events.filter(({ kind }) => kind === "terminal")).toHaveLength(1);
			expect(scenario.coordinator.stopped).toBe(true);
			expect(scenario.controlPlaneHealth.productionReconnectRedesignDeferredToPhase10).toBe(true);
		}
	});

	it("consumes the Phase 07 coordinator for failure and recovery rows", async () => {
		const report = await runFailureCampaign();
		const invalid = report.scenarios.find(({ id }) => id === "delegated-malformed-response");
		const failover = report.scenarios.find(({ id }) => id === "registry-one-unavailable");
		const duringSignaling = report.scenarios.find(({ id }) => id === "relay-loss-signaling");
		const afterDirect = report.scenarios.find(({ id }) => id === "relay-loss-direct");

		expect(invalid?.coordinator).toMatchObject({
			eventKinds: ["host-started", "registry-discover"],
			phase: "discovering-creator",
			stopped: true,
		});
		expect(failover?.coordinator.eventKinds).toContain("direct-proof");
		expect(failover?.coordinator.terminal).toBe("success");
		expect(duringSignaling?.attempts).toBe(2);
		expect(duringSignaling?.coordinator.attempts).toBe(2);
		expect(duringSignaling?.coordinator.relayAttemptStatuses).toEqual(["connection-failed", "reserved"]);
		expect(duringSignaling?.coordinator.eventKinds).toContain("relay-reservation");
		expect(duringSignaling?.coordinator.eventKinds).not.toContain("relay-recovery");
		expect(
			duringSignaling?.events.flatMap((event) => (event.kind === "relay-reservation" ? [event.details.outcome] : []))
		).toEqual(["aborted", "accepted"]);
		const afterReservation = report.scenarios.find(({ id }) => id === "relay-loss-reserved");
		expect(afterReservation?.coordinator.relayAttemptStatuses).toEqual(["reserved", "reserved"]);
		expect(afterReservation?.coordinator.eventKinds).toContain("relay-recovery");
		expect(
			afterReservation?.events.flatMap((event) => (event.kind === "relay-reservation" ? [event.details.outcome] : []))
		).toEqual(["accepted", "accepted"]);
		expect(afterDirect?.attempts).toBe(2);
		expect(afterDirect?.coordinator.attempts).toBe(2);
		expect(afterDirect?.coordinator.eventKinds).toEqual(
			expect.arrayContaining(["direct-proof", "terminal", "relay-recovery"])
		);
	});

	it.each([
		["undialable-50", 10, 13],
		["undialable-75", 15, 18],
		["undialable-90", 18, 20],
	] as const)("measures %s against twenty candidates and still reserves", async (id, invalidCount, actualDialCount) => {
		const scenario = failureScenarios().find((item) => item.id === id);
		if (scenario === undefined) throw new Error(`missing ${id}`);

		const result = await runFailureScenario(scenario);
		const candidates = result.events.filter((event) => event.kind === "relay-candidate");
		const dialAttempts = result.events.filter((event) => event.kind === "dial-attempt");
		const dials = result.events.filter((event) => event.kind === "dial-result");

		expect(candidates).toHaveLength(20);
		expect(dialAttempts).toHaveLength(dials.length);
		expect(dials).toHaveLength(actualDialCount);
		expect(dials.filter((event) => event.kind === "dial-result" && event.details.outcome === "refused")).toHaveLength(
			invalidCount
		);
		expect(result.events).toContainEqual(
			expect.objectContaining({
				details: expect.objectContaining({ outcome: "accepted" }),
				kind: "relay-reservation",
			})
		);
		expect(result.terminal).toBe("reserved");
	});

	it("records four RelayPolicy refusal outcomes before the owned fallback signal", async () => {
		const scenario = failureScenarios().find(({ id }) => id === "relay-all-refused");
		if (scenario === undefined) throw new Error("missing refusal scenario");

		const result = await runFailureScenario(scenario);

		expect(
			result.events.filter((event) => event.kind === "relay-reservation" && event.details.outcome === "refused")
		).toHaveLength(4);
		expect(result.events.find(({ kind }) => kind === "fallback")).toMatchObject({
			details: { from: "public-relay", reason: "exhausted", to: "owned-fallback" },
		});
		expect(result.durationMs).toBeLessThanOrEqual(5_000);
	});

	it.each([
		["record-replayed", "replay"],
		["record-expired", "expired"],
		["record-oversized", "size"],
		["record-forged", "signature"],
	] as const)("preserves the exact validation reason for %s", async (id, reason) => {
		const scenario = failureScenarios().find((item) => item.id === id);
		if (scenario === undefined) throw new Error(`missing ${id}`);

		const result = await runFailureScenario(scenario);

		expect(result.events.find(({ kind }) => kind === "registry-validation-failure")).toMatchObject({
			details: { reason },
		});
		expect(result.terminal).toBe("registration-rejected");
	});

	it.each([
		["delegated-stale-response", "stale"],
		["delegated-poisoned-response", "poisoned"],
		["delegated-malformed-response", "malformed"],
		["delegated-oversized-response", "oversized"],
	] as const)("preserves the endpoint failure reason for %s", async (id, reason) => {
		const scenario = failureScenarios().find((item) => item.id === id);
		if (scenario === undefined) throw new Error(`missing ${id}`);

		const result = await runFailureScenario(scenario);

		expect(result.events.find(({ kind }) => kind === "endpoint-failure")).toMatchObject({
			details: { endpointClass: "delegated-routing", reason },
		});
		expect(result.events.some(({ kind }) => kind === "registry-validation-failure")).toBe(false);
		expect(result.terminal).toBe("invalid-response");
	});

	it("caps a Sybil flood after 64 real registry registration decisions", async () => {
		const scenario = failureScenarios().find(({ id }) => id === "record-sybil-flood");
		if (scenario === undefined) throw new Error("missing Sybil scenario");

		const result = await runFailureScenario(scenario);

		expect(result.events.filter(({ kind }) => kind === "registry-register")).toHaveLength(64);
		expect(
			result.events.filter((event) => event.kind === "registry-register" && event.details.outcome === "accepted")
		).toHaveLength(63);
		expect(result.events.at(-1)?.kind).not.toBe("registry-validation-failure");
		expect(result.attempts).toBe(64);
		expect(result.checks.find(({ label }) => label === "attempt cap")?.passed).toBe(true);
	});

	it("spends the composed child windows without resetting the 30s parent", async () => {
		const scenario = failureScenarios().find(({ id }) => id === "all-dependencies-down");
		if (scenario === undefined) throw new Error("missing composed outage");

		expect(scenario.schedule.steps.map(({ atMs, target }) => [atMs, target])).toEqual([
			[0, "registry"],
			[0, "delegated-routing"],
			[8_000, "relay-policy"],
			[13_000, "dnsaddr-fallback"],
			[25_000, "control-health"],
		]);
		const result = await runFailureScenario(scenario);
		expect(result).toMatchObject({
			childBudgets: [
				{
					abortObserved: true,
					budgetMs: 8_000,
					finishedAtMs: 8_000,
					outcome: "timed-out",
					owner: "registry-and-routing",
					startedAtMs: 0,
				},
				{
					abortObserved: true,
					budgetMs: 5_000,
					finishedAtMs: 13_000,
					outcome: "timed-out",
					owner: "relay-search",
					startedAtMs: 8_000,
				},
				{
					abortObserved: true,
					budgetMs: 12_000,
					finishedAtMs: 25_000,
					outcome: "timed-out",
					owner: "owned-fallback",
					startedAtMs: 13_000,
				},
			],
			controlPlaneHealth: {
				reconnectAttempts: 1,
				state: "terminal",
			},
			durationMs: 29_999,
			passed: true,
			status: "failure",
			terminal: "total-outage",
		});
		expect(result.events.findLast(({ kind }) => kind === "terminal")).toMatchObject({
			atMs: 29_999,
			details: { durationMs: 29_999, reason: "total-outage", status: "failure" },
		});
	});

	it("recovers typed control-plane health through the Phase 07 replacement seam", async () => {
		const scenario = failureScenarios().find(({ id }) => id === "control-health-reconnect");
		if (scenario === undefined) throw new Error("missing control health scenario");

		const result = await runFailureScenario(scenario);

		expect(result.controlPlaneHealth).toEqual({
			productionReconnectRedesignDeferredToPhase10: true,
			reason: "dependency-outage",
			reconnectAttempts: 1,
			state: "recovered",
		});
		expect(result.coordinator.eventKinds).toContain("relay-recovery");
		expect(result.terminal).toBe("reconnect-recovered");
	});

	it("rejects schedules that reset or escape the parent budget", async () => {
		const base = failureScenarios()[0];
		if (base === undefined) throw new Error("missing base scenario");
		const firstStep = base.schedule.steps[0];
		if (firstStep === undefined) throw new Error("missing base schedule step");
		await expect(
			runFailureScenario({
				...base,
				schedule: {
					...base.schedule,
					steps: [{ ...firstStep, atMs: 30_000 }],
				},
			})
		).rejects.toThrow("inside the parent deadline");
		await expect(
			runFailureScenario({
				...base,
				schedule: { ...base.schedule, parentDeadlineMs: 29_999 },
			})
		).rejects.toThrow("retain the 30s parent");
	});

	it("renders sanitized deterministic Markdown and HTML summaries", async () => {
		const report = await runFailureCampaign();
		const markdown = renderFailureCampaignMarkdown(report);
		const html = renderFailureCampaignHtml(report);

		expect(markdown).toContain("24/24 passed");
		expect(markdown).toContain("| all-dependencies-down | total-outage | 29999 |");
		expect(html).toContain("<!doctype html>");
		expect(html).toContain("24/24 rows");
		expect(`${markdown}${html}`).not.toContain(CREATOR_RAW_SENTINEL);
	});

	it("rejects a report whose displayed pass count hides a failed row", async () => {
		const report = await runFailureCampaign();
		const first = report.scenarios[0];
		if (first === undefined) throw new Error("missing campaign row");
		const tampered: FailureCampaignReport = {
			...report,
			scenarios: [{ ...first, passed: false }, ...report.scenarios.slice(1)],
		};

		expect(() => assertFailureCampaign(tampered)).toThrow("failing rows");
	});

	it("rejects raw identity and network material before rendering an artifact", async () => {
		const report = await runFailureCampaign();
		const first = report.scenarios[0];
		if (first === undefined) throw new Error("missing campaign row");
		const tampered: FailureCampaignReport = {
			...report,
			scenarios: [{ ...first, label: CREATOR_RAW_SENTINEL }, ...report.scenarios.slice(1)],
		};

		expect(() => assertFailureCampaign(tampered)).toThrow("raw-sensitive value");
		expect(() => renderFailureCampaignMarkdown(tampered)).toThrow("raw-sensitive value");
		expect(() => renderFailureCampaignHtml(tampered)).toThrow("raw-sensitive value");
	});

	it("is byte-for-byte deterministic across repeated runs", async () => {
		const first = await runFailureCampaign();
		const second = await runFailureCampaign();
		expect(second).toEqual(first);
	});
});

const CREATOR_RAW_SENTINEL = "12D3KooWRawCreatorPeerIdMustNeverAppear";
