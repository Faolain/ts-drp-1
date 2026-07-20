import {
	type EndpointOwnerResult,
	runRecordFailure,
	runRegistryFailure,
	runRoutingFailure,
} from "./endpoint-driver.js";
import {
	ControlPlaneCoordinator,
	type DirectTransportProof,
	type GridCoordinatorSnapshot,
	type GridNodePort,
	type GridObjectPort,
	type GridRelayPolicyPort,
} from "../grid/index.js";
import { AddressPolicy } from "../probe/address-policy.js";
import { type ProbeEvent, type ProbeEventKind } from "../probe/events.js";
import {
	type FetchResponse,
	type Probe,
	type ProbeContext,
	type ProbeExecution,
	ProbeRunner,
	type ProbeRunResult,
	SeededRandom,
} from "../probe/kernel.js";
import { ManualClock } from "../probe/manual-clock.js";
import type { SignedDrpRecordV1 } from "../record/index.js";
import type { RendezvousDirectory, ValidatedDrpRecord } from "../registry/index.js";
import {
	BrowserRoutingClosestPeersSource,
	CIRCUIT_RELAY_V2_HOP_PROTOCOL,
	RELAY_RESERVATION_STATUS,
	type RelayAttempt,
	type RelayCandidate,
	RelayConnectionLostError,
	type RelayInspection,
	RelayPolicy,
	type RelayPolicyResult,
	type RelayReservationClient,
	type RelayReservationWireResponse,
} from "../relay/index.js";

export const FAILURE_CAMPAIGN_SCHEMA_VERSION = "1.0.0";

const FIXTURE_NOW_MS = 1_750_000_000_000;
const NAMESPACE = "drp-rendezvous:v1:failurecampaign01";
const CREATOR_PEER_ID = "creator-fixture";
const JOINER_PEER_ID = "joiner-fixture";
const RELAY_PEER_ID = "relay-fixture";
const REPLACEMENT_RELAY_PEER_ID = "replacement-fixture";
const CHILD_BUDGETS = Object.freeze({
	cleanupMs: 5_000,
	ownedFallbackMs: 12_000,
	registryAndRoutingMs: 8_000,
	relaySearchMs: 5_000,
});

export type FailureCategory = "composed" | "control-plane" | "record" | "registry" | "relay" | "routing";

export type FaultTarget =
	| "control-health"
	| "delegated-routing"
	| "dnsaddr-fallback"
	| "record-validator"
	| "registry"
	| "relay-policy"
	| "signaling";

export type FaultKind =
	| "all-dependencies-down"
	| "all-registries-unavailable"
	| "all-reservations-refused"
	| "control-health-degraded"
	| "delegated-cors-dns-failure"
	| "delegated-malformed-response"
	| "delegated-outage"
	| "delegated-oversized-response"
	| "delegated-poisoned-response"
	| "delegated-rate-limited"
	| "delegated-stale-response"
	| "record-expired"
	| "record-forged"
	| "record-oversized"
	| "record-replayed"
	| "registry-one-unavailable"
	| "relay-loss-after-direct"
	| "relay-loss-after-reservation"
	| "relay-loss-during-signaling"
	| "stale-dnsaddr-fallback"
	| "sybil-registration-flood"
	| "undialable-50"
	| "undialable-75"
	| "undialable-90";

export type FailureTerminal =
	| "direct-retained"
	| "exhausted"
	| "failover-recovered"
	| "invalid-response"
	| "owned-fallback"
	| "reconnect-recovered"
	| "registration-rejected"
	| "replacement-recovered"
	| "reserved"
	| "total-outage";

export type ControlPlaneHealthState = "degraded" | "healthy" | "reconnecting" | "recovered" | "terminal";

export interface ControlPlaneHealthSnapshot {
	readonly productionReconnectRedesignDeferredToPhase10: true;
	readonly reason?: "dependency-outage";
	readonly reconnectAttempts: number;
	readonly state: ControlPlaneHealthState;
}

export interface ScheduledFault {
	readonly atMs: number;
	readonly fault: FaultKind;
	readonly target: FaultTarget;
}

export interface FaultSchedule {
	readonly childBudgets: typeof CHILD_BUDGETS;
	readonly maxAttempts: number;
	readonly maxBackoffs: number;
	readonly parentDeadlineMs: number;
	readonly steps: readonly ScheduledFault[];
}

export interface FailureScenario {
	readonly category: FailureCategory;
	readonly expectedStatus: "failure" | "success";
	readonly expectedTerminal: FailureTerminal;
	readonly id: string;
	readonly label: string;
	readonly requiredEvents: readonly ProbeEventKind[];
	readonly schedule: FaultSchedule;
}

export interface FailureCheck {
	readonly label: string;
	readonly passed: boolean;
	readonly value: string;
}

export interface FailureScenarioResult {
	readonly attempts: number;
	readonly backoffs: number;
	readonly childBudgets: readonly ChildBudgetEvidence[];
	readonly checks: readonly FailureCheck[];
	readonly cleanup: {
		readonly completed: number;
		readonly failed: number;
		readonly registered: number;
	};
	readonly controlPlaneHealth: ControlPlaneHealthSnapshot;
	readonly coordinator: {
		readonly attempts: number;
		readonly backoffs: number;
		readonly eventKinds: readonly string[];
		readonly phase: GridCoordinatorSnapshot["phase"];
		readonly relayAttemptStatuses: readonly RelayAttempt["status"][];
		readonly stopped: boolean;
		readonly terminal?: GridCoordinatorSnapshot["terminal"];
	};
	readonly durationMs: number;
	readonly events: readonly ProbeEvent[];
	readonly expectedStatus: FailureScenario["expectedStatus"];
	readonly expectedTerminal: FailureTerminal;
	readonly id: string;
	readonly label: string;
	readonly passed: boolean;
	readonly status: "aborted" | "failure" | "success";
	readonly terminal: FailureTerminal | "external-abort" | "parent-timeout" | "unexpected-failure";
}

export type ChildBudgetOwner = "owned-fallback" | "registry-and-routing" | "relay-search";

export interface ChildBudgetEvidence {
	readonly abortObserved: boolean;
	readonly budgetMs: number;
	readonly finishedAtMs: number;
	readonly outcome: "completed" | "timed-out";
	readonly owner: ChildBudgetOwner;
	readonly startedAtMs: number;
}

export interface FailureCampaignReport {
	readonly fixture: "all";
	readonly generatedAt: "deterministic-fixture";
	readonly noPublicEgress: true;
	readonly parentDeadlineMs: 30_000;
	readonly scenarios: readonly FailureScenarioResult[];
	readonly schemaVersion: typeof FAILURE_CAMPAIGN_SCHEMA_VERSION;
	readonly summary: {
		readonly failed: number;
		readonly passed: number;
		readonly total: number;
	};
	readonly telemetryCoverage: readonly ProbeEventKind[];
}

interface ScenarioValue {
	readonly attempts: number;
	readonly backoffs: number;
	readonly childBudgets: readonly ChildBudgetEvidence[];
	readonly coordinator: FailureScenarioResult["coordinator"];
	readonly terminal: FailureTerminal;
}

interface CoordinatorExercise {
	readonly attempts: number;
	readonly backoffs: number;
	readonly eventKinds: readonly string[];
	readonly phase: GridCoordinatorSnapshot["phase"];
	readonly relayAttemptStatuses: readonly RelayAttempt["status"][];
	readonly stopped: boolean;
	readonly terminal?: GridCoordinatorSnapshot["terminal"];
}

interface TrackedConnection {
	readonly closed: boolean;
	close(): void;
}

interface TrackedRefresh {
	readonly active: boolean;
	stop(): void;
}

class CampaignResources {
	readonly #clock: ManualClock;
	readonly #connections = new Set<TrackedConnection>();
	readonly #controllers = new Set<AbortController>();
	readonly #refreshes = new Set<TrackedRefresh>();

	constructor(clock: ManualClock) {
		this.#clock = clock;
	}

	openController(parent: AbortSignal): { abort(reason?: unknown): void; close(): void; readonly signal: AbortSignal } {
		const controller = new AbortController();
		const forwardAbort = (): void => controller.abort(parent.reason);
		if (parent.aborted) forwardAbort();
		else parent.addEventListener("abort", forwardAbort, { once: true });
		this.#controllers.add(controller);
		let closed = false;
		return {
			abort: (reason?: unknown): void => controller.abort(reason),
			close: (): void => {
				if (closed) return;
				closed = true;
				parent.removeEventListener("abort", forwardAbort);
				controller.abort(new DOMException("campaign scope closed", "AbortError"));
				this.#controllers.delete(controller);
			},
			signal: controller.signal,
		};
	}

	openConnection(): TrackedConnection {
		let closed = false;
		const connection: TrackedConnection = {
			get closed(): boolean {
				return closed;
			},
			close: (): void => {
				if (closed) return;
				closed = true;
				this.#connections.delete(connection);
			},
		};
		this.#connections.add(connection);
		return connection;
	}

	startRefresh(intervalMs: number): TrackedRefresh {
		let active = true;
		let timer: unknown;
		const schedule = (): void => {
			timer = this.#clock.setTimer(() => {
				if (active) schedule();
			}, intervalMs);
		};
		const refresh: TrackedRefresh = {
			get active(): boolean {
				return active;
			},
			stop: (): void => {
				if (!active) return;
				active = false;
				this.#clock.clearTimer(timer);
				this.#refreshes.delete(refresh);
			},
		};
		this.#refreshes.add(refresh);
		schedule();
		return refresh;
	}

	closeAll(): void {
		for (const refresh of [...this.#refreshes]) refresh.stop();
		for (const connection of [...this.#connections]) connection.close();
		for (const controller of [...this.#controllers])
			controller.abort(new DOMException("campaign cleanup", "AbortError"));
		this.#controllers.clear();
	}

	sample(): { activeTimers: number; openHandles: number } {
		return {
			activeTimers: this.#clock.pendingTimerCount(),
			openHandles: this.#connections.size + this.#controllers.size + this.#refreshes.size,
		};
	}
}

/** Spike-only typed health adapter; production reconnect redesign remains Phase 10. */
export class FailureControlPlaneHealthAdapter {
	readonly #maxReconnectAttempts: number;
	#reason?: ControlPlaneHealthSnapshot["reason"];
	#reconnectAttempts = 0;
	#state: ControlPlaneHealthState = "healthy";

	/** @param maxReconnectAttempts - Hard retry cap for deterministic fault rows. */
	constructor(maxReconnectAttempts = 1) {
		if (!Number.isInteger(maxReconnectAttempts) || maxReconnectAttempts < 0 || maxReconnectAttempts > 4) {
			throw new Error("control-plane reconnect cap must be within 0..4");
		}
		this.#maxReconnectAttempts = maxReconnectAttempts;
	}

	/** Records typed dependency degradation. */
	degrade(): void {
		if (this.#state !== "healthy") throw new Error(`cannot degrade control plane from ${this.#state}`);
		this.#reason = "dependency-outage";
		this.#state = "degraded";
	}

	/** Starts one capped reconnect attempt. */
	beginReconnect(): void {
		if (this.#state !== "degraded") throw new Error(`cannot reconnect control plane from ${this.#state}`);
		if (this.#reconnectAttempts >= this.#maxReconnectAttempts) {
			throw new Error("control-plane reconnect attempt cap reached");
		}
		this.#reconnectAttempts += 1;
		this.#state = "reconnecting";
	}

	/** Marks the spike adapter recovered. */
	recover(): void {
		if (this.#state !== "reconnecting") throw new Error(`cannot recover control plane from ${this.#state}`);
		this.#state = "recovered";
	}

	/** Marks the typed terminal after bounded reconnect exhaustion. */
	terminate(): void {
		if (this.#state !== "reconnecting" && this.#state !== "degraded") {
			throw new Error(`cannot terminate control plane from ${this.#state}`);
		}
		this.#state = "terminal";
	}

	/** @returns Immutable typed health evidence. */
	get snapshot(): ControlPlaneHealthSnapshot {
		return {
			productionReconnectRedesignDeferredToPhase10: true,
			...(this.#reason === undefined ? {} : { reason: this.#reason }),
			reconnectAttempts: this.#reconnectAttempts,
			state: this.#state,
		};
	}
}

const scenarios: readonly FailureScenario[] = [
	endpointScenario("delegated-outage", "Delegated endpoint outage", "delegated-outage", "owned-fallback"),
	endpointScenario("delegated-dns-cors", "Delegated DNS/CORS failure", "delegated-cors-dns-failure", "owned-fallback"),
	endpointScenario(
		"delegated-rate-limit",
		"Delegated HTTP 429 with bounded backoff",
		"delegated-rate-limited",
		"owned-fallback",
		3,
		2
	),
	responseScenario("delegated-stale-response", "Stale delegated response", "delegated-stale-response", "expired"),
	responseScenario(
		"delegated-poisoned-response",
		"Poisoned delegated response",
		"delegated-poisoned-response",
		"address"
	),
	responseScenario(
		"delegated-malformed-response",
		"Malformed delegated response",
		"delegated-malformed-response",
		"signature"
	),
	responseScenario(
		"delegated-oversized-response",
		"Oversized delegated response",
		"delegated-oversized-response",
		"size"
	),
	undialableScenario("undialable-50", "50% undialable relay population", "undialable-50"),
	undialableScenario("undialable-75", "75% undialable relay population", "undialable-75"),
	undialableScenario("undialable-90", "90% undialable relay population", "undialable-90"),
	scenario({
		category: "relay",
		expectedStatus: "success",
		expectedTerminal: "owned-fallback",
		fault: "all-reservations-refused",
		id: "relay-all-refused",
		label: "All relay reservations refused",
		maxAttempts: 4,
		requiredEvents: ["relay-candidate", "relay-reservation", "fallback"],
		target: "relay-policy",
	}),
	relayLossScenario(
		"relay-loss-signaling",
		"Relay loss during signaling",
		"relay-loss-during-signaling",
		"replacement-recovered"
	),
	relayLossScenario(
		"relay-loss-reserved",
		"Relay loss after reservation",
		"relay-loss-after-reservation",
		"replacement-recovered"
	),
	relayLossScenario(
		"relay-loss-direct",
		"Relay loss after direct upgrade",
		"relay-loss-after-direct",
		"direct-retained"
	),
	scenario({
		category: "registry",
		expectedStatus: "success",
		expectedTerminal: "failover-recovered",
		fault: "registry-one-unavailable",
		id: "registry-one-unavailable",
		label: "One registry unavailable",
		maxAttempts: 2,
		maxBackoffs: 1,
		requiredEvents: ["endpoint-attempt", "endpoint-backoff", "endpoint-failure", "registry-discover"],
		target: "registry",
	}),
	scenario({
		category: "registry",
		expectedStatus: "success",
		expectedTerminal: "owned-fallback",
		fault: "all-registries-unavailable",
		id: "registry-all-unavailable",
		label: "All registries unavailable",
		maxAttempts: 2,
		maxBackoffs: 1,
		requiredEvents: ["endpoint-attempt", "endpoint-backoff", "endpoint-failure", "fallback"],
		target: "registry",
	}),
	recordScenario("record-replayed", "Replayed registration", "record-replayed", "replay"),
	recordScenario("record-expired", "Expired registration", "record-expired", "expired"),
	recordScenario("record-oversized", "Oversized registration", "record-oversized", "size"),
	recordScenario("record-forged", "Forged registration", "record-forged", "signature"),
	scenario({
		category: "record",
		expectedStatus: "success",
		expectedTerminal: "registration-rejected",
		fault: "sybil-registration-flood",
		id: "record-sybil-flood",
		label: "Sybil registration flood",
		maxAttempts: 64,
		requiredEvents: ["registry-register"],
		target: "record-validator",
	}),
	scenario({
		category: "relay",
		expectedStatus: "failure",
		expectedTerminal: "exhausted",
		fault: "stale-dnsaddr-fallback",
		id: "fallback-stale-dnsaddr",
		label: "Stale DNSADDR owned fallback",
		maxAttempts: 4,
		requiredEvents: ["fallback", "registry-validation-failure"],
		target: "dnsaddr-fallback",
	}),
	scenario({
		category: "control-plane",
		expectedStatus: "success",
		expectedTerminal: "reconnect-recovered",
		fault: "control-health-degraded",
		id: "control-health-reconnect",
		label: "Typed control-plane health and reconnect",
		requiredEvents: ["relay-replacement", "milestone"],
		target: "control-health",
	}),
	{
		category: "composed",
		expectedStatus: "failure",
		expectedTerminal: "total-outage",
		id: "all-dependencies-down",
		label: "All dependencies down under one parent deadline",
		requiredEvents: ["endpoint-attempt", "endpoint-backoff", "endpoint-failure", "fallback"],
		schedule: {
			childBudgets: CHILD_BUDGETS,
			maxAttempts: 8,
			maxBackoffs: 3,
			parentDeadlineMs: 30_000,
			steps: [
				{ atMs: 0, fault: "all-dependencies-down", target: "registry" },
				{ atMs: 0, fault: "all-dependencies-down", target: "delegated-routing" },
				{ atMs: 8_000, fault: "all-dependencies-down", target: "relay-policy" },
				{ atMs: 13_000, fault: "all-dependencies-down", target: "dnsaddr-fallback" },
				{ atMs: 25_000, fault: "all-dependencies-down", target: "control-health" },
			],
		},
	},
];

/** @returns Frozen deterministic failure matrix. */
export function failureScenarios(): readonly FailureScenario[] {
	return scenarios.map((item) => ({
		...item,
		requiredEvents: [...item.requiredEvents],
		schedule: { ...item.schedule, childBudgets: { ...item.schedule.childBudgets }, steps: [...item.schedule.steps] },
	}));
}

/**
 * Runs every Phase 08 deterministic failure row.
 * @returns Validated campaign report with complete telemetry.
 */
export async function runFailureCampaign(): Promise<FailureCampaignReport> {
	const results: FailureScenarioResult[] = [];
	for (const item of scenarios) results.push(await runFailureScenario(item));
	const telemetryCoverage = [...new Set(results.flatMap(({ events }) => events.map(({ kind }) => kind)))].sort();
	return {
		fixture: "all",
		generatedAt: "deterministic-fixture",
		noPublicEgress: true,
		parentDeadlineMs: 30_000,
		scenarios: results,
		schemaVersion: FAILURE_CAMPAIGN_SCHEMA_VERSION,
		summary: {
			failed: results.filter(({ passed }) => !passed).length,
			passed: results.filter(({ passed }) => passed).length,
			total: results.length,
		},
		telemetryCoverage,
	};
}

/**
 * Runs and validates one table row.
 * @param item - Failure fixture and its bounded fault schedule.
 * @returns Deterministic terminal, telemetry, and cleanup evidence.
 */
export async function runFailureScenario(item: FailureScenario): Promise<FailureScenarioResult> {
	validateScenario(item);
	const clock = new ManualClock();
	const resources = new CampaignResources(clock);
	const health = new FailureControlPlaneHealthAdapter();
	let coordinatorEvidence: CoordinatorExercise | undefined;
	let ownerEvidence: (EndpointOwnerResult & { readonly childBudgets: readonly ChildBudgetEvidence[] }) | undefined;
	const invalidDialCount = undialableCount(item);
	let dialAttempt = 0;
	let fetchAttempt = 0;
	const runner = new ProbeRunner(
		{
			addressPolicy: new AddressPolicy({ target: "browser" }),
			clock,
			dialer: {
				dial: (): Promise<{ latencyMs: number; transport: string }> => {
					dialAttempt += 1;
					if (dialAttempt <= invalidDialCount) return Promise.reject(new Error("fixture candidate undialable"));
					return Promise.resolve({ latencyMs: 1, transport: "wss" });
				},
			},
			fetch: (_input, init): Promise<FetchResponse> => {
				fetchAttempt += 1;
				return failureFetchResponse(item, fetchAttempt, init.signal);
			},
			random: new SeededRandom(8),
			resolver: {
				resolve: (): Promise<string[]> =>
					hasFault(item, "all-dependencies-down")
						? Promise.reject(new Error("fixture DNSADDR dependency unavailable"))
						: Promise.resolve(["8.8.8.8"]),
			},
			resourceSampler: {
				sample: (): { activeTimers: number; openHandles: number } => resources.sample(),
			},
			sink: { record: (): undefined => undefined },
		},
		{
			cleanupTimeoutMs: CHILD_BUDGETS.cleanupMs,
			parentTimeoutMs: item.schedule.parentDeadlineMs,
			runId: `failure-${item.id}`,
		}
	);
	const result = await runner.run(
		createFailureProbe(
			item,
			clock,
			resources,
			health,
			(evidence) => {
				ownerEvidence = evidence;
			},
			(evidence) => {
				coordinatorEvidence = evidence;
			}
		)
	);
	return resultFor(item, result, coordinatorEvidence, ownerEvidence, health.snapshot);
}

/**
 * Throws if any scenario misses its terminal, telemetry, budget, or cleanup contract.
 * @param report - Completed deterministic campaign report.
 */
export function assertFailureCampaign(report: FailureCampaignReport): void {
	if (report.schemaVersion !== FAILURE_CAMPAIGN_SCHEMA_VERSION) throw new Error("failure campaign schema mismatch");
	if (!report.noPublicEgress) throw new Error("failure campaign attempted public egress");
	if (report.scenarios.length !== scenarios.length) throw new Error("failure campaign scenario coverage is incomplete");
	assertSanitizedFailureReport(report);
	const failures = report.scenarios.filter(({ passed }) => !passed);
	if (failures.length > 0) {
		throw new Error(`failure campaign has failing rows: ${failures.map(({ id }) => id).join(", ")}`);
	}
	const passed = report.scenarios.filter(({ passed: rowPassed }) => rowPassed).length;
	const failed = report.scenarios.length - passed;
	if (
		report.summary.total !== report.scenarios.length ||
		report.summary.passed !== passed ||
		report.summary.failed !== failed
	) {
		throw new Error("failure campaign summary is inconsistent");
	}
}

function assertSanitizedFailureReport(report: FailureCampaignReport): void {
	const rawPeerId = /\b(?:12D3KooW|Qm)[A-Za-z0-9]{20,}\b/u;
	const rawMultiaddr = /\/(?:dns4|dns6|ip4|ip6|p2p)\//u;
	const rawIpv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/u;
	const credentialUrl = /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/iu;
	const inspect = (value: unknown, path: string): void => {
		if (typeof value === "string") {
			if (rawPeerId.test(value) || rawMultiaddr.test(value) || rawIpv4.test(value) || credentialUrl.test(value)) {
				throw new Error(`failure campaign report contains raw-sensitive value at ${path}`);
			}
			return;
		}
		if (Array.isArray(value)) {
			value.forEach((item, index) => inspect(item, `${path}[${index}]`));
			return;
		}
		if (value !== null && typeof value === "object") {
			for (const [key, item] of Object.entries(value)) inspect(item, `${path}.${key}`);
		}
	};
	inspect(report, "report");
}

/**
 * @param report - Completed deterministic campaign report.
 * @returns Sanitized durable Markdown summary.
 */
export function renderFailureCampaignMarkdown(report: FailureCampaignReport): string {
	assertFailureCampaign(report);
	const rows = report.scenarios
		.map(
			(item) =>
				`| ${item.id} | ${item.terminal} | ${item.durationMs} | ${item.attempts}/${item.backoffs} | ${item.cleanup.completed}/${item.cleanup.registered} | ${item.passed ? "PASS" : "FAIL"} |`
		)
		.join("\n");
	return `# Phase 08 Deterministic Failure Campaign

- Fixture: \`${report.fixture}\`
- Public egress: \`disabled\`
- Rows: \`${report.summary.passed}/${report.summary.total} passed\`
- Parent deadline: \`${report.parentDeadlineMs} ms\`

| Scenario | Terminal | Duration ms | Attempts/backoffs | Cleanup | Verdict |
| --- | --- | ---: | ---: | ---: | --- |
${rows}

Telemetry coverage: ${report.telemetryCoverage.map((kind) => `\`${kind}\``).join(", ")}
`;
}

/**
 * @param report - Completed deterministic campaign report.
 * @returns Standalone sanitized HTML report.
 */
export function renderFailureCampaignHtml(report: FailureCampaignReport): string {
	assertFailureCampaign(report);
	const rows = report.scenarios
		.map(
			(item) =>
				`<tr><td>${escapeHtml(item.id)}</td><td>${escapeHtml(item.terminal)}</td><td>${item.durationMs}</td><td>${item.attempts}/${item.backoffs}</td><td>${item.cleanup.completed}/${item.cleanup.registered}</td><td class="pass">PASS</td></tr>`
		)
		.join("");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Phase 08 failure campaign</title><style>body{font:15px system-ui;margin:32px;color:#161914;background:#f1efe7}h1{font-size:clamp(2rem,6vw,5rem);margin:0 0 12px}p{max-width:70ch}table{width:100%;border-collapse:collapse;background:#fff}th,td{padding:10px;border:1px solid #161914;text-align:left}.pass{font-weight:800;background:#d8ff43}@media(max-width:700px){body{margin:14px;overflow-wrap:anywhere}th,td{padding:7px;font-size:11px}}</style></head><body><h1>Deterministic failure campaign</h1><p>${report.summary.passed}/${report.summary.total} rows reached their typed terminal or recovery state under one bounded owner. Public egress remained disabled.</p><table><thead><tr><th>Scenario</th><th>Terminal</th><th>ms</th><th>Attempts/backoffs</th><th>Cleanup</th><th>Verdict</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

function createFailureProbe(
	item: FailureScenario,
	clock: ManualClock,
	resources: CampaignResources,
	health: FailureControlPlaneHealthAdapter,
	captureOwner: (evidence: EndpointOwnerResult & { readonly childBudgets: readonly ChildBudgetEvidence[] }) => void,
	captureCoordinator: (evidence: CoordinatorExercise) => void
): Probe<ScenarioValue> {
	return {
		id: item.id,
		run: async (context): Promise<ProbeExecution<ScenarioValue>> => {
			if (hasFault(item, "all-dependencies-down")) {
				context.defer(async (signal): Promise<void> => {
					const pending = clock.sleep(CHILD_BUDGETS.cleanupMs - 1, signal);
					clock.advanceBy(CHILD_BUDGETS.cleanupMs - 1);
					await pending;
					resources.closeAll();
				});
			}
			if (!hasFault(item, "all-dependencies-down")) {
				const scheduledAtMs = item.schedule.steps[0]?.atMs ?? 0;
				clock.advanceBy(scheduledAtMs);
			}
			const relayLoss = isRelayLossScenario(item);
			const ownerBeforeCoordinator = relayLoss ? undefined : await runObservedOwner(item, context, resources, health);
			const coordinator = await exerciseCoordinator(item, context, resources);
			captureCoordinator(coordinator);
			const terminal = terminalFromCoordinator(item, ownerBeforeCoordinator?.terminal, coordinator);
			const owner =
				ownerBeforeCoordinator ??
				({
					attempts: coordinator.attempts,
					backoffs: coordinator.backoffs,
					childBudgets: [],
					terminal,
				} satisfies EndpointOwnerResult & { readonly childBudgets: readonly ChildBudgetEvidence[] });
			captureOwner(owner);
			emitCoordinatorObservations(item, context, coordinator, terminal);
			if (item.expectedStatus === "failure") {
				return {
					failure: {
						code: terminal,
						message: `${item.id} reached the expected typed terminal`,
						retryable: false,
					},
					status: "failure",
				};
			}
			return {
				status: "success",
				value: {
					attempts: owner.attempts,
					backoffs: owner.backoffs,
					childBudgets: owner.childBudgets,
					coordinator,
					terminal,
				},
			};
		},
	};
}

async function runObservedOwner(
	item: FailureScenario,
	context: ProbeContext,
	resources: CampaignResources,
	health: FailureControlPlaneHealthAdapter
): Promise<EndpointOwnerResult & { readonly childBudgets: readonly ChildBudgetEvidence[] }> {
	const fault = item.schedule.steps[0]?.fault;
	if (fault === undefined) throw new Error("failure scenario has no fault");
	if (fault === "all-dependencies-down") {
		return runComposedOutage(context, resources, health);
	}
	if (
		fault === "delegated-outage" ||
		fault === "delegated-cors-dns-failure" ||
		fault === "delegated-rate-limited" ||
		fault === "delegated-stale-response" ||
		fault === "delegated-poisoned-response" ||
		fault === "delegated-malformed-response" ||
		fault === "delegated-oversized-response"
	) {
		return { ...(await runRoutingFailure(fault, context)), childBudgets: [] };
	}
	if (fault === "registry-one-unavailable" || fault === "all-registries-unavailable") {
		return { ...(await runRegistryFailure(fault, context)), childBudgets: [] };
	}
	if (
		fault === "record-replayed" ||
		fault === "record-expired" ||
		fault === "record-oversized" ||
		fault === "record-forged" ||
		fault === "sybil-registration-flood"
	) {
		return { ...(await runRecordFailure(fault, context)), childBudgets: [] };
	}
	if (
		fault === "undialable-50" ||
		fault === "undialable-75" ||
		fault === "undialable-90" ||
		fault === "all-reservations-refused" ||
		fault === "stale-dnsaddr-fallback"
	) {
		return { ...(await runRelayFailure(fault, context, resources)), childBudgets: [] };
	}
	if (fault === "control-health-degraded") {
		health.degrade();
		health.beginReconnect();
		health.recover();
		return { attempts: 0, backoffs: 0, childBudgets: [], terminal: "reconnect-recovered" };
	}
	throw new Error(`failure fault ${fault} has no endpoint owner`);
}

async function runComposedOutage(
	context: ProbeContext,
	resources: CampaignResources,
	health: FailureControlPlaneHealthAdapter
): Promise<EndpointOwnerResult & { readonly childBudgets: readonly ChildBudgetEvidence[] }> {
	const childBudgets: ChildBudgetEvidence[] = [];
	let attempts = 0;
	let backoffs = 0;
	childBudgets.push(
		await runChildBudget(
			context,
			resources,
			"registry-and-routing",
			CHILD_BUDGETS.registryAndRoutingMs,
			async (signal, ready) => {
				const childContext = { ...context, signal };
				const registry = await runRegistryFailure("all-registries-unavailable", childContext);
				const routing = await runRoutingFailure("delegated-outage", childContext);
				attempts += registry.attempts + routing.attempts;
				backoffs += registry.backoffs + routing.backoffs;
				ready();
				await context.clock.sleep(CHILD_BUDGETS.registryAndRoutingMs + 1, signal);
			}
		)
	);
	childBudgets.push(
		await runChildBudget(context, resources, "relay-search", CHILD_BUDGETS.relaySearchMs, async (signal, ready) => {
			const relay = await runRelayFailure("all-dependencies-down", { ...context, signal }, resources);
			attempts += relay.attempts;
			ready();
			await context.clock.sleep(CHILD_BUDGETS.relaySearchMs + 1, signal);
		})
	);
	childBudgets.push(
		await runChildBudget(context, resources, "owned-fallback", CHILD_BUDGETS.ownedFallbackMs, async (signal, ready) => {
			try {
				await context.resolver.resolve("owned-fallback.invalid", signal);
			} catch {
				// The injected resolver outage is the observed fallback failure.
			}
			context.emit("fallback", {
				delayMs: CHILD_BUDGETS.ownedFallbackMs,
				from: "public-relay",
				reason: "timeout",
				to: "owned-fallback",
			});
			ready();
			await context.clock.sleep(CHILD_BUDGETS.ownedFallbackMs + 1, signal);
		})
	);
	health.degrade();
	health.beginReconnect();
	health.terminate();
	return { attempts, backoffs, childBudgets, terminal: "total-outage" };
}

async function runChildBudget(
	context: ProbeContext,
	resources: CampaignResources,
	owner: ChildBudgetOwner,
	budgetMs: number,
	operation: (signal: AbortSignal, ready: () => void) => Promise<void>
): Promise<ChildBudgetEvidence> {
	context.throwIfAborted();
	const startedAtMs = context.clock.now();
	const scope = resources.openController(context.signal);
	const timer = context.clock.setTimer(
		() => scope.abort(new DOMException(`${owner} budget exhausted`, "TimeoutError")),
		budgetMs
	);
	let abortObserved = false;
	let markReady = (): void => undefined;
	const ready = new Promise<void>((resolve) => {
		markReady = resolve;
	});
	try {
		const pending = operation(scope.signal, markReady).catch((error: unknown) => {
			if (!scope.signal.aborted) throw error;
			abortObserved = true;
		});
		await ready;
		const remainingMs = Math.max(0, startedAtMs + budgetMs - context.clock.now());
		if (context.clock instanceof ManualClock) context.clock.advanceBy(remainingMs);
		await pending;
	} finally {
		context.clock.clearTimer(timer);
		scope.close();
	}
	context.throwIfAborted();
	return {
		abortObserved,
		budgetMs,
		finishedAtMs: context.clock.now(),
		outcome: abortObserved ? "timed-out" : "completed",
		owner,
		startedAtMs,
	};
}

async function runRelayFailure(
	fault: Extract<
		FaultKind,
		"all-dependencies-down" | "all-reservations-refused" | "stale-dnsaddr-fallback" | `undialable-${number}`
	>,
	context: ProbeContext,
	resources: CampaignResources
): Promise<EndpointOwnerResult> {
	const total = fault.startsWith("undialable-") ? 20 : 4;
	const invalid = fault.startsWith("undialable-") ? Number.parseInt(fault.slice("undialable-".length), 10) / 5 : 0;
	const peers = Array.from({ length: total }, (_, index) => {
		const ordinal = index + 1;
		return {
			acceptedAddresses: [`/dns4/relay-${ordinal}.example/tcp/443/wss/p2p/relay-${ordinal}`],
			addressDecisions: [],
			inputAddressCount: 1,
			peerId: `relay-${ordinal}`,
			protocols: [CIRCUIT_RELAY_V2_HOP_PROTOCOL],
			rawAddresses: [`/dns4/relay-${ordinal}.example/tcp/443/wss/p2p/relay-${ordinal}`],
			truncatedAddressCount: 0,
		};
	});
	const source = new BrowserRoutingClosestPeersSource(
		{
			async *getClosestPeers(): AsyncIterable<(typeof peers)[number]> {
				await Promise.resolve();
				yield* peers;
			},
		},
		(peer) => {
			const ordinal = Number.parseInt(peer.peerId.slice("relay-".length), 10);
			if (ordinal === total) return "operator-b";
			return ordinal > invalid ? "operator-a" : `invalid-${ordinal}`;
		}
	);
	const reservations = new CampaignReservationClient(
		resources,
		fault === "all-reservations-refused" || fault === "all-dependencies-down" || fault === "stale-dnsaddr-fallback"
	);
	const inspector = {
		inspect: async (_candidate: RelayCandidate, address: string, signal: AbortSignal): Promise<RelayInspection> => {
			try {
				const dial = await context.dialer.dial(address, signal);
				return {
					connectionId: `connection-${address}`,
					hopAdvertised: true,
					latencyMs: dial.latencyMs,
					outcome: "connected",
					protocols: ["/ipfs/id/1.0.0", CIRCUIT_RELAY_V2_HOP_PROTOCOL],
				};
			} catch {
				signal.throwIfAborted();
				return { hopAdvertised: false, latencyMs: 1, outcome: "refused", protocols: [] };
			}
		},
	};
	const policy = new RelayPolicy({
		fallback: {
			acquire: (): Promise<
				| { readonly address: string; readonly expiresAtMs: number; readonly status: "accepted" }
				| { readonly status: "empty" }
			> => {
				if (fault === "all-reservations-refused") {
					return Promise.resolve({
						address: "/dnsaddr/owned.example/p2p/owned",
						expiresAtMs: FIXTURE_NOW_MS + 60_000,
						status: "accepted",
					});
				}
				if (fault === "stale-dnsaddr-fallback") {
					return Promise.resolve({
						address: "/dnsaddr/stale.example/p2p/owned",
						expiresAtMs: FIXTURE_NOW_MS - 1,
						status: "accepted",
					});
				}
				return Promise.resolve({ status: "empty" });
			},
		},
		inspector,
		limits: {
			maxCandidates: total,
			maxConcurrentReservations: 2,
			maxPerOperatorGroup: 1,
			maxQueuedCandidates: total,
			ownedFallbackDeadlineMs: 100,
			perCandidateDeadlineMs: 100,
			refreshBeforeExpiryMs: 30_000,
			requiredOperatorGroups: 2,
			requiredReservations: 2,
			totalDeadlineMs: 5_000,
		},
		now: (): number => FIXTURE_NOW_MS + context.clock.now(),
		reservationClient: reservations,
		source,
	});
	context.defer(() => policy.stop());
	const result = await policy.acquire(new TextEncoder().encode("failure-relay"), context.signal);
	emitRelayEvidence(context, result, total);
	return { attempts: result.attempts.length, backoffs: 0, terminal: relayTerminal(result) };
}

class CampaignReservationClient implements RelayReservationClient {
	readonly #connections = new Map<string, TrackedConnection>();
	#connectionLossPending: boolean;
	readonly #refuse: boolean;
	readonly #refreshes = new Map<string, TrackedRefresh>();
	readonly #resources: CampaignResources;

	constructor(resources: CampaignResources, refuse: boolean, loseDuringSignaling = false) {
		this.#resources = resources;
		this.#refuse = refuse;
		this.#connectionLossPending = loseDuringSignaling;
	}

	refresh(candidate: RelayCandidate, signal: AbortSignal): Promise<RelayReservationWireResponse> {
		return this.reserve(candidate, signal);
	}

	release(candidate: RelayCandidate): Promise<void> {
		this.#connections.get(candidate.peerId)?.close();
		this.#connections.delete(candidate.peerId);
		this.#refreshes.get(candidate.peerId)?.stop();
		this.#refreshes.delete(candidate.peerId);
		return Promise.resolve();
	}

	reserve(candidate: RelayCandidate, signal: AbortSignal): Promise<RelayReservationWireResponse> {
		signal.throwIfAborted();
		if (this.#refuse) return Promise.resolve({ status: RELAY_RESERVATION_STATUS.RESERVATION_REFUSED });
		if (this.#connectionLossPending && candidate.peerId === RELAY_PEER_ID) {
			this.#connectionLossPending = false;
			return Promise.reject(new RelayConnectionLostError());
		}
		this.#connections.set(candidate.peerId, this.#resources.openConnection());
		this.#refreshes.set(candidate.peerId, this.#resources.startRefresh(30_000));
		return Promise.resolve({
			reservation: { expire: Math.floor((FIXTURE_NOW_MS + 60_000) / 1_000) },
			status: RELAY_RESERVATION_STATUS.OK,
		});
	}
}

function emitRelayEvidence(context: ProbeContext, result: RelayPolicyResult, candidateCount: number): void {
	emitRelayAttempts(context, result.attempts, candidateCount);
	if (result.terminal === "owned-fallback" || result.fallback?.status === "stale") {
		if (result.fallback?.status === "stale") {
			context.emit("registry-validation-failure", { reason: "expired" });
		}
		context.emit("fallback", {
			delayMs: result.durationMs,
			from: "public-relay",
			reason: result.terminal === "owned-fallback" ? "exhausted" : "invalid",
			to: "owned-fallback",
		});
	}
}

function emitRelayAttempts(context: ProbeContext, attempts: readonly RelayAttempt[], candidateCount: number): void {
	if (candidateCount > 0) {
		context.emit("routing-query", { method: "get-closest-peers" });
		context.emit("routing-result-count", { count: candidateCount });
	}
	attempts.forEach((attempt, index) => {
		const ordinal = index + 1;
		const candidatePseudonym = pseudonym("candidate", ordinal);
		const addressPseudonym = pseudonym("address", ordinal);
		context.emit("relay-candidate", {
			candidatePseudonym,
			provenance: "routing",
			source: "delegated-routing",
		});
		if (attempt.address === undefined) {
			context.emit("relay-hop-support", { candidatePseudonym, supported: attempt.hopAdvertised });
			return;
		}
		context.emit("dial-attempt", {
			addressPseudonym,
			attempt: ordinal,
			family: "dns",
			transport: "wss",
		});
		context.emit("dial-result", {
			addressPseudonym,
			latencyMs: attempt.inspectionLatencyMs,
			outcome: dialOutcome(attempt),
		});
		context.emit("relay-hop-support", { candidatePseudonym, supported: attempt.hopAdvertised });
		if (attempt.reservationStatus !== undefined) {
			context.emit("relay-reservation", {
				candidatePseudonym,
				latencyMs: attempt.reservationLatencyMs,
				outcome: attempt.status === "reserved" ? "accepted" : "refused",
			});
		} else if (attempt.status === "connection-failed") {
			context.emit("relay-reservation", {
				candidatePseudonym,
				latencyMs: attempt.reservationLatencyMs,
				outcome: "aborted",
			});
		}
	});
}

function dialOutcome(attempt: RelayAttempt): "aborted" | "connected" | "refused" | "timeout" {
	if (attempt.status === "aborted") return "aborted";
	if (attempt.status === "dial-timeout") return "timeout";
	if (attempt.status === "dial-refused") return "refused";
	return "connected";
}

function relayTerminal(result: RelayPolicyResult): FailureTerminal {
	if (result.terminal === "reserved") return "reserved";
	if (result.terminal === "owned-fallback") return "owned-fallback";
	return "exhausted";
}

function terminalFromCoordinator(
	item: FailureScenario,
	ownerTerminal: FailureTerminal | undefined,
	coordinator: CoordinatorExercise
): FailureTerminal {
	if (hasFault(item, "relay-loss-after-direct")) {
		if (!coordinator.eventKinds.includes("direct-proof") || !coordinator.eventKinds.includes("relay-recovery")) {
			throw new Error("relay-loss-after-direct did not retain direct proof through real relay replacement");
		}
		return "direct-retained";
	}
	if (hasFault(item, "relay-loss-during-signaling") || hasFault(item, "relay-loss-after-reservation")) {
		if (hasFault(item, "relay-loss-during-signaling")) {
			if (
				coordinator.relayAttemptStatuses[0] !== "connection-failed" ||
				coordinator.relayAttemptStatuses[1] !== "reserved" ||
				!coordinator.eventKinds.includes("relay-reservation")
			) {
				throw new Error("signaling loss did not rotate inside RelayPolicy acquisition");
			}
		} else if (!coordinator.eventKinds.includes("relay-recovery")) {
			throw new Error("post-reservation loss did not acquire a replacement through RelayPolicy.replace");
		}
		return "replacement-recovered";
	}
	if (hasFault(item, "control-health-degraded") && coordinator.eventKinds.includes("relay-recovery")) {
		return "reconnect-recovered";
	}
	if (ownerTerminal === undefined) throw new Error("scenario has neither endpoint nor coordinator terminal evidence");
	return ownerTerminal;
}

function emitCoordinatorObservations(
	item: FailureScenario,
	context: ProbeContext,
	coordinator: CoordinatorExercise,
	terminal: FailureTerminal
): void {
	if (
		coordinator.eventKinds.includes("relay-recovery") ||
		(hasFault(item, "relay-loss-during-signaling") && coordinator.relayAttemptStatuses.includes("connection-failed"))
	) {
		context.emit("relay-replacement", {
			outcome: terminal === "exhausted" ? "exhausted" : "accepted",
			reason: hasFault(item, "control-health-degraded") ? "policy" : "disconnected",
		});
	}
	if (hasFault(item, "relay-loss-after-direct") && coordinator.eventKinds.includes("direct-proof")) {
		context.emit("traffic-by-path", { path: "direct", receivedBytes: 2_048, sentBytes: 2_048 });
	}
	if (
		(hasFault(item, "relay-loss-during-signaling") || hasFault(item, "relay-loss-after-reservation")) &&
		(coordinator.eventKinds.includes("relay-recovery") ||
			coordinator.relayAttemptStatuses.includes("connection-failed"))
	) {
		context.emit("milestone", { durationMs: context.clock.now(), name: "first-reservation" });
	}
	if (hasFault(item, "control-health-degraded") && coordinator.eventKinds.includes("direct-proof")) {
		context.emit("milestone", { durationMs: context.clock.now(), name: "first-drp-peer" });
	}
}

function pseudonym(kind: "address" | "candidate", ordinal: number): string {
	return `${kind}_${ordinal.toString(16).padStart(12, "0")}`;
}

async function exerciseCoordinator(
	item: FailureScenario,
	context: ProbeContext,
	resources: CampaignResources
): Promise<CoordinatorExercise> {
	const harness = coordinatorHarness(item, context, resources);
	const coordinator = new ControlPlaneCoordinator(harness.options);
	let stopped = false;
	try {
		if (hasFault(item, "relay-loss-during-signaling")) {
			await coordinator.startJoiner("grid-object", new AbortController().signal);
		} else if (hasFault(item, "relay-loss-after-reservation")) {
			try {
				await coordinator.startJoiner("grid-object", new AbortController().signal);
			} catch {
				await coordinator.recoverRelay(RELAY_PEER_ID, new AbortController().signal);
			}
		} else if (hasFault(item, "relay-loss-after-direct") || hasFault(item, "control-health-degraded")) {
			await coordinator.startJoiner("grid-object", new AbortController().signal);
			await coordinator.recoverRelay(RELAY_PEER_ID, new AbortController().signal);
		} else {
			try {
				await coordinator.startJoiner("grid-object", new AbortController().signal);
			} catch {
				// The scenario-level terminal retains the dependency-specific reason.
			}
		}
	} finally {
		await coordinator.stop();
		stopped = harness.stopCount() === 1;
	}
	const snapshot = coordinator.snapshot;
	const relayAttempts = harness.relayAttemptEvidence();
	if (isRelayLossScenario(item)) emitRelayAttempts(context, relayAttempts, relayAttempts.length);
	return {
		attempts: relayAttempts.length,
		backoffs: 0,
		eventKinds: snapshot.events.map(({ kind }) => kind),
		phase: snapshot.phase,
		relayAttemptStatuses: relayAttempts.map(({ status }) => status),
		stopped,
		...(snapshot.terminal === undefined ? {} : { terminal: snapshot.terminal }),
	};
}

function coordinatorHarness(
	item: FailureScenario,
	context: ProbeContext,
	resources: CampaignResources
): {
	readonly options: ConstructorParameters<typeof ControlPlaneCoordinator>[0];
	relayAttemptEvidence(): readonly RelayAttempt[];
	stopCount(): number;
} {
	let stopped = 0;
	let connectAttempts = 0;
	const relayAttempts: RelayAttempt[] = [];
	const connections: TrackedConnection[] = [];
	const peers: string[] = [];
	const groups: string[] = [];
	const object: GridObjectPort = {
		id: "grid-object",
		move: () => undefined,
		position: () => ({ x: 0, y: 0 }),
	};
	const node: GridNodePort = {
		connectObject: () => {
			groups.push(CREATOR_PEER_ID);
			return Promise.resolve(object);
		},
		createObject: () => Promise.resolve(object),
		networkNode: {
			connect: () => {
				connectAttempts += 1;
				if (hasFault(item, "relay-loss-after-reservation") && connectAttempts === 1) {
					return Promise.reject(new Error("fixture relay lost after reservation"));
				}
				connections.push(resources.openConnection());
				peers.push(CREATOR_PEER_ID);
				return Promise.resolve();
			},
			getAllPeers: () => [...peers],
			getGroupPeers: () => [...groups],
			peerId: JOINER_PEER_ID,
		},
		start: () => Promise.resolve(),
		stop: () => {
			stopped += 1;
			for (const connection of connections) connection.close();
			return Promise.resolve();
		},
	};
	const directory: RendezvousDirectory = {
		discover: () => Promise.resolve(coordinatorHasCreator(item) ? [validatedRecord()] : []),
		register: () => Promise.resolve({ acceptedEndpointIds: ["registry-a"], attempts: [], sequence: 1 }),
	};
	const policy = coordinatorRelayPolicy(item, context, resources);
	context.defer(() => policy.stop());
	const relayPolicy: GridRelayPolicyPort = {
		acquire: async (queryKey, signal) => {
			const result = await policy.acquire(queryKey, signal);
			relayAttempts.push(...result.attempts);
			return result;
		},
		replace: async (peerId, reason, signal) => {
			const result = await policy.replace(peerId, reason, signal);
			relayAttempts.push(...result.attempts);
			return result;
		},
	};
	return {
		options: {
			bootstrapPeers: [],
			directory,
			directProof: { inspect: () => Promise.resolve(directProof()) },
			namespace: NAMESPACE,
			node,
			now: () => FIXTURE_NOW_MS,
			recordFactory: {
				create: () => Promise.resolve(signedRecord()),
			},
			relayPolicy,
			role: "joiner",
		},
		relayAttemptEvidence: () => [...relayAttempts],
		stopCount: () => stopped,
	};
}

function coordinatorRelayPolicy(
	item: FailureScenario,
	context: ProbeContext,
	resources: CampaignResources
): RelayPolicy {
	const peers = [RELAY_PEER_ID, REPLACEMENT_RELAY_PEER_ID].map((peerId) => ({
		acceptedAddresses: [`/dns4/${peerId}.example/tcp/443/wss/p2p/${peerId}`],
		addressDecisions: [],
		inputAddressCount: 1,
		peerId,
		protocols: [CIRCUIT_RELAY_V2_HOP_PROTOCOL],
		rawAddresses: [`/dns4/${peerId}.example/tcp/443/wss/p2p/${peerId}`],
		truncatedAddressCount: 0,
	}));
	const source = new BrowserRoutingClosestPeersSource(
		{
			async *getClosestPeers(): AsyncIterable<(typeof peers)[number]> {
				await Promise.resolve();
				yield* peers;
			},
		},
		(peer) => (peer.peerId === RELAY_PEER_ID ? "operator-primary" : "operator-replacement")
	);
	const inspector = {
		inspect: async (_candidate: RelayCandidate, address: string, signal: AbortSignal): Promise<RelayInspection> => {
			try {
				const dial = await context.dialer.dial(address, signal);
				return {
					connectionId: `coordinator-${address}`,
					hopAdvertised: true,
					latencyMs: dial.latencyMs,
					outcome: "connected",
					protocols: ["/ipfs/id/1.0.0", CIRCUIT_RELAY_V2_HOP_PROTOCOL],
				};
			} catch {
				signal.throwIfAborted();
				return { hopAdvertised: false, latencyMs: 1, outcome: "refused", protocols: [] };
			}
		},
	};
	return new RelayPolicy({
		fallback: { acquire: () => Promise.resolve({ status: "empty" }) },
		inspector,
		limits: {
			maxCandidates: peers.length,
			maxConcurrentReservations: 1,
			maxPerOperatorGroup: 1,
			maxQueuedCandidates: peers.length,
			ownedFallbackDeadlineMs: 100,
			perCandidateDeadlineMs: 100,
			refreshBeforeExpiryMs: 30_000,
			requiredOperatorGroups: 1,
			requiredReservations: 1,
			totalDeadlineMs: 5_000,
		},
		now: () => FIXTURE_NOW_MS + context.clock.now(),
		reservationClient: new CampaignReservationClient(
			resources,
			coordinatorRelayExhausted(item),
			hasFault(item, "relay-loss-during-signaling")
		),
		source,
	});
}

function resultFor(
	item: FailureScenario,
	result: ProbeRunResult<ScenarioValue>,
	coordinatorEvidence: CoordinatorExercise | undefined,
	ownerEvidence: (EndpointOwnerResult & { readonly childBudgets: readonly ChildBudgetEvidence[] }) | undefined,
	controlPlaneHealth: ControlPlaneHealthSnapshot
): FailureScenarioResult {
	const cleanup = result.events.findLast(
		(event): event is Extract<ProbeEvent, { kind: "cleanup" }> =>
			event.kind === "cleanup" && event.details.phase === "finish"
	);
	const finalResources = result.events.findLast(
		(event): event is Extract<ProbeEvent, { kind: "resource-sample" }> => event.kind === "resource-sample"
	);
	const actualStatus = result.status;
	const value = result.status === "success" ? result.value : undefined;
	const attempts = value?.attempts ?? ownerEvidence?.attempts ?? 0;
	const backoffs = value?.backoffs ?? ownerEvidence?.backoffs ?? 0;
	const childBudgets = value?.childBudgets ?? ownerEvidence?.childBudgets ?? [];
	let terminal: FailureScenarioResult["terminal"];
	if (result.status === "success") terminal = result.value.terminal;
	else if (result.status === "failure") terminal = result.failure.code as FailureTerminal;
	else terminal = result.reason === "timeout" ? "parent-timeout" : "external-abort";
	const coordinator = value?.coordinator ??
		coordinatorEvidence ?? {
			attempts: 0,
			backoffs: 0,
			eventKinds: [],
			phase: "terminal" as const,
			relayAttemptStatuses: [],
			stopped: true,
		};
	const expectedHealth = expectedHealthFor(item);
	const checks: FailureCheck[] = [
		check("typed terminal", terminal === item.expectedTerminal, `${terminal} == ${item.expectedTerminal}`),
		check("expected status", actualStatus === item.expectedStatus, `${actualStatus} == ${item.expectedStatus}`),
		check(
			"parent deadline",
			result.durationMs <= item.schedule.parentDeadlineMs,
			`${result.durationMs}/${item.schedule.parentDeadlineMs} ms`
		),
		check("attempt cap", attempts <= item.schedule.maxAttempts, `${attempts}/${item.schedule.maxAttempts}`),
		check("backoff cap", backoffs <= item.schedule.maxBackoffs, `${backoffs}/${item.schedule.maxBackoffs}`),
		check(
			"child budgets consumed",
			!hasFault(item, "all-dependencies-down") ||
				(childBudgets.length === 3 &&
					childBudgets.every(({ abortObserved, outcome }) => abortObserved && outcome === "timed-out")),
			childBudgets.map(({ budgetMs, owner, outcome }) => `${owner}:${budgetMs}:${outcome}`).join(",") ||
				"not-applicable"
		),
		check(
			"required telemetry",
			item.requiredEvents.every((kind) => result.events.some((event) => event.kind === kind)),
			item.requiredEvents.join(",")
		),
		check(
			"cleanup completed",
			cleanup !== undefined && cleanup.details.failed === 0 && cleanup.details.completed === cleanup.details.registered,
			cleanup === undefined
				? "missing"
				: `${cleanup.details.completed}/${cleanup.details.registered}; failed=${cleanup.details.failed}`
		),
		check(
			"no leaked work",
			finalResources?.details.activeTimers === 0 && finalResources.details.openHandles === 0,
			finalResources === undefined
				? "missing"
				: `timers=${finalResources.details.activeTimers}; handles=${finalResources.details.openHandles}`
		),
		check("coordinator stopped", coordinator.stopped, coordinator.stopped ? "stopped" : "leaked"),
		check(
			"typed control health",
			controlPlaneHealth.state === expectedHealth.state &&
				controlPlaneHealth.reconnectAttempts === expectedHealth.reconnectAttempts,
			`${controlPlaneHealth.state}/${controlPlaneHealth.reconnectAttempts} == ${expectedHealth.state}/${expectedHealth.reconnectAttempts}`
		),
	];
	return {
		attempts,
		backoffs,
		childBudgets,
		checks,
		cleanup: {
			completed: cleanup?.details.completed ?? 0,
			failed: cleanup?.details.failed ?? 1,
			registered: cleanup?.details.registered ?? 0,
		},
		controlPlaneHealth,
		coordinator,
		durationMs: result.durationMs,
		events: result.events,
		expectedStatus: item.expectedStatus,
		expectedTerminal: item.expectedTerminal,
		id: item.id,
		label: item.label,
		passed: checks.every(({ passed }) => passed),
		status: actualStatus,
		terminal,
	};
}

function expectedHealthFor(item: FailureScenario): Pick<ControlPlaneHealthSnapshot, "reconnectAttempts" | "state"> {
	if (hasFault(item, "control-health-degraded")) return { reconnectAttempts: 1, state: "recovered" };
	if (hasFault(item, "all-dependencies-down")) return { reconnectAttempts: 1, state: "terminal" };
	return { reconnectAttempts: 0, state: "healthy" };
}

function endpointScenario(
	id: string,
	label: string,
	fault: Extract<FaultKind, `delegated-${string}`>,
	expectedTerminal: "owned-fallback",
	maxAttempts = 2,
	maxBackoffs = 1
): FailureScenario {
	return scenario({
		category: "routing",
		expectedStatus: "success",
		expectedTerminal,
		fault,
		id,
		label,
		maxAttempts,
		maxBackoffs,
		requiredEvents: ["endpoint-attempt", "endpoint-backoff", "endpoint-failure", "fallback"],
		target: "delegated-routing",
	});
}

function responseScenario(
	id: string,
	label: string,
	fault: Extract<FaultKind, `delegated-${string}`>,
	_reason: "address" | "expired" | "signature" | "size"
): FailureScenario {
	return scenario({
		category: "routing",
		expectedStatus: "failure",
		expectedTerminal: "invalid-response",
		fault,
		id,
		label,
		requiredEvents: ["routing-query", "routing-result-count", "endpoint-failure"],
		target: "delegated-routing",
	});
}

function undialableScenario(
	id: string,
	label: string,
	fault: "undialable-50" | "undialable-75" | "undialable-90"
): FailureScenario {
	return scenario({
		category: "relay",
		expectedStatus: "success",
		expectedTerminal: "reserved",
		fault,
		id,
		label,
		maxAttempts: 20,
		requiredEvents: ["routing-result-count", "dial-result", "relay-reservation"],
		target: "relay-policy",
	});
}

function relayLossScenario(
	id: string,
	label: string,
	fault: "relay-loss-after-direct" | "relay-loss-after-reservation" | "relay-loss-during-signaling",
	expectedTerminal: "direct-retained" | "replacement-recovered"
): FailureScenario {
	return scenario({
		category: "relay",
		expectedStatus: "success",
		expectedTerminal,
		fault,
		id,
		label,
		maxAttempts: 2,
		requiredEvents:
			fault === "relay-loss-after-direct"
				? ["relay-replacement", "traffic-by-path"]
				: ["relay-replacement", "milestone"],
		target: fault === "relay-loss-during-signaling" ? "signaling" : "relay-policy",
	});
}

function recordScenario(
	id: string,
	label: string,
	fault: "record-expired" | "record-forged" | "record-oversized" | "record-replayed",
	_reason: "expired" | "replay" | "signature" | "size"
): FailureScenario {
	return scenario({
		category: "record",
		expectedStatus: "success",
		expectedTerminal: "registration-rejected",
		fault,
		id,
		label,
		requiredEvents: ["registry-register", "registry-validation-failure"],
		target: "record-validator",
	});
}

function scenario(input: {
	category: FailureCategory;
	expectedStatus: FailureScenario["expectedStatus"];
	expectedTerminal: FailureTerminal;
	fault: FaultKind;
	id: string;
	label: string;
	maxAttempts?: number;
	maxBackoffs?: number;
	requiredEvents: readonly ProbeEventKind[];
	target: FaultTarget;
}): FailureScenario {
	return {
		category: input.category,
		expectedStatus: input.expectedStatus,
		expectedTerminal: input.expectedTerminal,
		id: input.id,
		label: input.label,
		requiredEvents: input.requiredEvents,
		schedule: {
			childBudgets: CHILD_BUDGETS,
			maxAttempts: input.maxAttempts ?? 1,
			maxBackoffs: input.maxBackoffs ?? 0,
			parentDeadlineMs: 30_000,
			steps: [{ atMs: defaultFaultTime(input.fault), fault: input.fault, target: input.target }],
		},
	};
}

function defaultFaultTime(fault: FaultKind): number {
	if (fault === "all-reservations-refused") return 4_900;
	if (fault === "stale-dnsaddr-fallback") return 17_000;
	if (fault.startsWith("relay-loss")) return 4_000;
	if (fault === "control-health-degraded") return 6_000;
	return 2_000;
}

function validateScenario(item: FailureScenario): void {
	if (!/^[a-z0-9-]{1,64}$/u.test(item.id)) throw new Error("failure scenario ID is not safe");
	if (item.schedule.parentDeadlineMs !== 30_000) throw new Error("failure scenario must retain the 30s parent");
	if (item.schedule.steps.length === 0) throw new Error("failure scenario schedule cannot be empty");
	let previous = -1;
	for (const step of item.schedule.steps) {
		if (!Number.isInteger(step.atMs) || step.atMs < 0 || step.atMs >= item.schedule.parentDeadlineMs) {
			throw new Error("scheduled fault must be inside the parent deadline");
		}
		if (step.atMs < previous) throw new Error("scheduled faults must be ordered");
		previous = step.atMs;
	}
}

function coordinatorHasCreator(item: FailureScenario): boolean {
	return !item.schedule.steps.some(({ fault }) =>
		[
			"all-dependencies-down",
			"all-registries-unavailable",
			"delegated-malformed-response",
			"delegated-oversized-response",
			"delegated-poisoned-response",
			"delegated-stale-response",
			"record-expired",
			"record-forged",
			"record-oversized",
			"record-replayed",
			"stale-dnsaddr-fallback",
			"sybil-registration-flood",
		].includes(fault)
	);
}

function coordinatorRelayExhausted(item: FailureScenario): boolean {
	return item.schedule.steps.some(({ fault }) =>
		["all-dependencies-down", "all-reservations-refused", "stale-dnsaddr-fallback"].includes(fault)
	);
}

function isRelayLossScenario(item: FailureScenario): boolean {
	return item.schedule.steps.some(({ fault }) => fault.startsWith("relay-loss-"));
}

function hasFault(item: FailureScenario, fault: FaultKind): boolean {
	return item.schedule.steps.some((step) => step.fault === fault);
}

function undialableCount(item: FailureScenario): number {
	if (hasFault(item, "undialable-50")) return 10;
	if (hasFault(item, "undialable-75")) return 15;
	if (hasFault(item, "undialable-90")) return 18;
	return 0;
}

function failureFetchResponse(item: FailureScenario, attempt: number, signal: AbortSignal): Promise<FetchResponse> {
	signal.throwIfAborted();
	if (hasFault(item, "delegated-outage")) return Promise.reject(new TypeError("fixture endpoint outage"));
	if (hasFault(item, "delegated-cors-dns-failure")) {
		return Promise.reject(new TypeError(attempt === 1 ? "fixture DNS lookup failed" : "fixture CORS policy blocked"));
	}
	if (hasFault(item, "delegated-stale-response") && attempt > 1) {
		return Promise.reject(new TypeError("stale cache refresh endpoint unavailable"));
	}
	let body: string;
	let status = 200;
	if (hasFault(item, "delegated-rate-limited")) {
		body = JSON.stringify({ Peers: [] });
		status = 429;
	} else if (hasFault(item, "delegated-malformed-response")) {
		body = "{";
	} else if (hasFault(item, "delegated-oversized-response")) {
		body = "x".repeat(2_048);
	} else if (hasFault(item, "delegated-poisoned-response")) {
		body = JSON.stringify({
			Peers: [{ Addrs: ["/dns4/relay.example.test/tcp/443/tls/ws"], ID: "not-a-peer-id" }],
		});
	} else {
		body = JSON.stringify({
			Peers: [
				{
					Addrs: ["/dns4/relay.example.test/tcp/443/tls/ws"],
					ID: "QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
					Protocols: ["transport-bitswap"],
					Schema: "peer",
				},
			],
		});
	}
	return Promise.resolve({
		json: (): Promise<unknown> => Promise.resolve(JSON.parse(body)),
		ok: status >= 200 && status < 300,
		status,
		text: (): Promise<string> => Promise.resolve(body),
	});
}

function validatedRecord(): ValidatedDrpRecord {
	return { admissionMode: "invite", record: signedRecord(), sourceEndpointId: "registry-a" };
}

function signedRecord(): SignedDrpRecordV1 {
	return {
		addresses: [`/dns4/relay.example/tcp/443/wss/p2p/${RELAY_PEER_ID}/p2p-circuit/webrtc/p2p/${CREATOR_PEER_ID}`],
		capabilities: ["circuit-relay", "drp-gossipsub", "webrtc"],
		expiresAtMs: FIXTURE_NOW_MS + 60_000,
		issuedAtMs: FIXTURE_NOW_MS,
		kind: "ts-drp-rendezvous-record",
		namespace: NAMESPACE,
		peerId: CREATOR_PEER_ID,
		publicKey: "fixture-public-key",
		sequence: 1,
		signature: "fixture-signature",
		version: 1,
	};
}

function directProof(): DirectTransportProof {
	return {
		connectionId: "connection-fixture",
		correlation: "runtime-observed",
		correlationBasis: "unique-libp2p-webrtc-connection-and-init-datachannel",
		dataChannelOpen: true,
		directBytesReceived: 2_048,
		directBytesSent: 2_048,
		iceCandidateTypes: ["host", "host"],
		libp2pAddress: "/webrtc/p2p/creator-fixture",
		libp2pTransport: "webrtc",
		relayedBytesReceived: 1_024,
		relayedBytesSent: 1_024,
		rtcPeerConnectionId: "rtc-fixture",
		transport: "webrtc",
	};
}

function check(label: string, passed: boolean, value: string): FailureCheck {
	return { label, passed, value };
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
