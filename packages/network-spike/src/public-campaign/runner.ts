import { createHash } from "node:crypto";

import { RequestBudget } from "../campaign-primitives.js";
import { PUBLIC_DECISION_RULES } from "../contract.js";
import {
	preflightPublicCampaign,
	type PublicCampaignConfig,
	type PublicCampaignPreflight,
	type PublicRequestKind,
} from "./config.js";
import { aggregatePublicCampaignCells, type CampaignObservation, CampaignObservationSchema } from "./report.js";
import { SeededRandom } from "../probe/kernel.js";

export type CampaignTask =
	| {
			browser: "chromium" | "firefox" | "webkit";
			condition: string;
			identityPseudonym: string;
			kind: "browser";
			transportProfile: "wss-only" | "wss-wt-webrtc-direct";
	  }
	| {
			condition: string;
			identityPseudonym: string;
			kind: "node";
	  }
	| {
			browser: "chromium" | "firefox" | "webkit";
			condition: string;
			identityPseudonym: string;
			kind: "grid-canary";
	  };

export interface PublicRequest {
	kind: PublicRequestKind;
	target: string;
}

export interface AuthorizedPublicRequest extends PublicRequest {
	task: Readonly<CampaignTask>;
}

export interface PublicResponseMetadata {
	attempts: 1;
	operatorTermsConcern?: boolean;
	redirected: false;
	retryAfter?: string;
	status: number;
}

export interface PublicRequestGate {
	request<Value>(request: PublicRequest): Promise<Value>;
}

export interface PublicCampaignRequestExecutor {
	execute<Value>(
		request: Readonly<AuthorizedPublicRequest>,
		signal: AbortSignal
	): Promise<{
		metadata: PublicResponseMetadata;
		value: Value;
	}>;
}

export type PublicCampaignPartialReason =
	| "delegated-outage"
	| "dht-outage"
	| "grid-canary-outage"
	| "registry-outage"
	| "relay-outage";

export type PublicCampaignTaskResult =
	| {
			observations: unknown[];
			status: "complete";
	  }
	| {
			observations: unknown[];
			reason: PublicCampaignPartialReason;
			status: "partial";
	  };

export interface PublicCampaignDriver {
	runBrowserTask(
		task: Extract<CampaignTask, { kind: "browser" }>,
		gate: PublicRequestGate,
		signal: AbortSignal
	): Promise<PublicCampaignTaskResult | unknown[]>;
	runGridCanaryTask(
		task: Extract<CampaignTask, { kind: "grid-canary" }>,
		gate: PublicRequestGate,
		signal: AbortSignal
	): Promise<PublicCampaignTaskResult | unknown[]>;
	runNodeTask(
		task: Extract<CampaignTask, { kind: "node" }>,
		gate: PublicRequestGate,
		signal: AbortSignal
	): Promise<PublicCampaignTaskResult | unknown[]>;
}

export type PublicCampaignStopReason =
	| "environment-blocked"
	| "operator-terms-concern"
	| "rate-limited"
	| "request-cap"
	| "task-timeout"
	| "driver-failure";

export interface PublicCampaignRunResult {
	status: "complete" | "partial" | "environment-blocked";
	criterionSatisfied: boolean;
	stopReason?: PublicCampaignStopReason;
	blockers: PublicCampaignPreflight["blockers"];
	coverageIssues: string[];
	conditions: Array<{
		descriptorPseudonym: string;
		egressPseudonym: string;
		label: string;
		natClass: PublicCampaignConfig["conditions"][number]["natClass"];
	}>;
	completedTasks: number;
	plannedTasks: number;
	requests: {
		byKind: Partial<Record<PublicRequestKind, number>>;
		consumed: number;
		hardCap: number;
	};
	observationCount: number;
	partialCells: Array<{
		browser?: Extract<CampaignTask, { kind: "browser" | "grid-canary" }>["browser"];
		condition: string;
		identityPseudonym: string;
		reason: PublicCampaignPartialReason;
		target: CampaignTask["kind"];
		transportProfile?: Extract<CampaignTask, { kind: "browser" }>["transportProfile"];
	}>;
	aggregates: ReturnType<typeof aggregatePublicCampaignCells>;
	runId: string;
	versions?: PublicCampaignConfig["versions"];
}

export interface PublicCampaignRunnerOptions {
	executor?: PublicCampaignRequestExecutor;
	now?(): number;
	seed?: number;
	sleep?(delayMs: number): Promise<void>;
}

class CampaignStop extends Error {
	readonly reason: PublicCampaignStopReason;

	constructor(reason: PublicCampaignStopReason, message: string) {
		super(message);
		this.name = "CampaignStop";
		this.reason = reason;
	}
}

/**
 * Builds the exact randomized-but-balanced identity schedule.
 * @param config - Authorized public campaign configuration.
 * @param seed - Reproducible randomization seed.
 * @returns Serialized node, browser, and grid-canary tasks.
 */
export function createPublicCampaignTasks(config: PublicCampaignConfig, seed: number): CampaignTask[] {
	const tasks: CampaignTask[] = [];
	let identityIndex = 0;
	for (const condition of config.plan.conditions) {
		for (let index = 0; index < config.plan.nodeIdentitiesPerCondition; index += 1) {
			tasks.push({
				condition,
				identityPseudonym: pseudonym(config.runId, "peer", identityIndex),
				kind: "node",
			});
			identityIndex += 1;
		}
		for (const browser of config.plan.browsers) {
			for (const [transportProfile, count] of Object.entries(config.plan.transportProfileSplit) as Array<
				["wss-only" | "wss-wt-webrtc-direct", number]
			>) {
				for (let index = 0; index < count; index += 1) {
					tasks.push({
						browser,
						condition,
						identityPseudonym: pseudonym(config.runId, "peer", identityIndex),
						kind: "browser",
						transportProfile,
					});
					identityIndex += 1;
				}
			}
			tasks.push({
				browser,
				condition,
				identityPseudonym: pseudonym(config.runId, "peer", identityIndex),
				kind: "grid-canary",
			});
			identityIndex += 1;
		}
	}
	return shuffle(tasks, new SeededRandom(seed));
}

/**
 * Runs an authorized campaign through one serialized, bounded request gate.
 * @param input - Candidate campaign configuration.
 * @param cliAcknowledgement - Independent command-line acknowledgement.
 * @param driver - Protocol owner adapter for Node, browser, and grid cells.
 * @param options - Deterministic test hooks.
 * @returns Complete, partial, or environment-blocked sanitized result.
 */
export async function runPublicCampaign(
	input: unknown,
	cliAcknowledgement: string | undefined,
	driver: PublicCampaignDriver,
	options: PublicCampaignRunnerOptions = {}
): Promise<PublicCampaignRunResult> {
	const preflight = preflightPublicCampaign(input, cliAcknowledgement);
	const hardCap = preflight.precomputed?.hardRequestCap ?? 0;
	if (!preflight.authorized || preflight.config === undefined) {
		return {
			blockers: preflight.blockers,
			completedTasks: 0,
			conditions: [],
			coverageIssues: ["public campaign was not authorized"],
			criterionSatisfied: false,
			aggregates: [],
			observationCount: 0,
			partialCells: [],
			plannedTasks: preflight.precomputed?.trialBudget ?? 0,
			requests: {
				byKind: {},
				consumed: 0,
				hardCap,
			},
			runId: "environment-blocked",
			status: "environment-blocked",
			stopReason: "environment-blocked",
		};
	}

	const config = preflight.config;
	if (options.executor === undefined) {
		throw new Error("authorized public campaign requires one reviewed request executor");
	}
	const tasks = createPublicCampaignTasks(config, options.seed ?? 9);
	const gate = new SerializedPublicRequestGate(config, options.executor, options);
	const observations: CampaignObservation[] = [];
	const partialCells: PublicCampaignRunResult["partialCells"] = [];
	let completedTasks = 0;
	let stopReason: PublicCampaignStopReason | undefined;

	for (const task of tasks) {
		const before = gate.consumed;
		const taskSignal = AbortSignal.timeout(config.taskTimeoutMs);
		const taskGate = new TaskRequestGate(config, task, gate, taskSignal);
		try {
			const taskPromise =
				task.kind === "node"
					? driver.runNodeTask(task, taskGate, taskSignal)
					: task.kind === "browser"
						? driver.runBrowserTask(task, taskGate, taskSignal)
						: driver.runGridCanaryTask(task, taskGate, taskSignal);
			const rawResult = await withAbort(taskPromise, taskSignal);
			if (taskSignal.aborted) {
				throw new CampaignStop("task-timeout", "campaign task exceeded its configured deadline");
			}
			if (gate.consumed === before) {
				throw new CampaignStop("driver-failure", "a campaign task attempted no allowlisted public request");
			}
			const taskResult = normalizeTaskResult(rawResult);
			if (taskResult.status === "complete") {
				taskGate.assertRequiredRequests();
			} else {
				taskGate.assertPartialFailure(taskResult.reason);
				partialCells.push(partialCell(task, taskResult.reason));
			}
			const taskObservations = taskResult.observations.map((value) => CampaignObservationSchema.parse(value));
			assertTaskObservations(task, taskObservations, taskResult.status);
			observations.push(...taskObservations);
			completedTasks += 1;
		} catch (error) {
			stopReason =
				error instanceof CampaignStop ? error.reason : taskSignal.aborted ? "task-timeout" : "driver-failure";
			break;
		}
	}

	const coverageIssues = validatePublicCampaignCoverage(config, observations);
	if (gate.registryEndpointCount < config.endpoints.registries.length) {
		coverageIssues.push(
			`signed-registry campaign reached ${gate.registryEndpointCount}/${config.endpoints.registries.length} configured endpoints`
		);
	}
	const complete =
		completedTasks === tasks.length &&
		stopReason === undefined &&
		coverageIssues.length === 0 &&
		partialCells.length === 0;
	if (
		completedTasks === tasks.length &&
		stopReason === undefined &&
		coverageIssues.length > 0 &&
		partialCells.length === 0
	) {
		stopReason = "driver-failure";
	}
	return {
		blockers: [],
		completedTasks,
		conditions: config.conditions.map(({ descriptorPseudonym, egressPseudonym, label, natClass }) => ({
			descriptorPseudonym,
			egressPseudonym,
			label,
			natClass,
		})),
		coverageIssues,
		criterionSatisfied: complete,
		aggregates: aggregatePublicCampaignCells(observations),
		observationCount: observations.length,
		partialCells,
		plannedTasks: tasks.length,
		requests: {
			byKind: gate.byKind,
			consumed: gate.consumed,
			hardCap: config.requestBudget.hardCap,
		},
		runId: config.runId,
		status: complete ? "complete" : "partial",
		...(stopReason === undefined ? {} : { stopReason }),
		versions: config.versions,
	};
}

class SerializedPublicRequestGate {
	readonly #allowedOrigins: Set<string>;
	readonly #allowedOriginsByGroup: Record<"delegated" | "grid" | "registry" | "relay", Set<string>>;
	readonly #allowedDhtTargets: Set<string>;
	readonly #budget: RequestBudget;
	readonly #byKind: Partial<Record<PublicRequestKind, number>> = {};
	readonly #config: PublicCampaignConfig;
	readonly #executor: PublicCampaignRequestExecutor;
	readonly #now: () => number;
	readonly #registryOriginsReached = new Set<string>();
	readonly #sleep: (delayMs: number) => Promise<void>;
	#active = false;
	#lastRequestAt: number | undefined;

	constructor(
		config: PublicCampaignConfig,
		executor: PublicCampaignRequestExecutor,
		options: PublicCampaignRunnerOptions
	) {
		this.#config = config;
		this.#executor = executor;
		this.#allowedOrigins = new Set(config.endpointAllowlist.map((url) => new URL(url).origin));
		const relayOrigins = new Set(config.endpoints.relays.map((url) => new URL(url).origin));
		this.#allowedOriginsByGroup = {
			delegated: new Set(config.endpoints.delegatedRouting.map((url) => new URL(url).origin)),
			grid: relayOrigins,
			registry: new Set(config.endpoints.registries.map(({ url }) => new URL(url).origin)),
			relay: relayOrigins,
		};
		this.#allowedDhtTargets = new Set(config.endpoints.publicDhtBootstrap);
		this.#budget = new RequestBudget(config.requestBudget.hardCap);
		this.#now = options.now ?? Date.now;
		this.#sleep =
			options.sleep ??
			((delayMs): Promise<void> => {
				return new Promise((resolve) => setTimeout(resolve, delayMs));
			});
	}

	get byKind(): Partial<Record<PublicRequestKind, number>> {
		return { ...this.#byKind };
	}

	get consumed(): number {
		return this.#budget.consumed;
	}

	get registryEndpointCount(): number {
		return this.#registryOriginsReached.size;
	}

	async request<Value>(request: PublicRequest, task: CampaignTask, signal: AbortSignal): Promise<Value> {
		if (this.#active) {
			throw new CampaignStop("driver-failure", "public requests must be serialized");
		}
		signal.throwIfAborted();
		this.assertAllowlisted(request);

		this.#active = true;
		let attempted = false;
		try {
			if (this.#lastRequestAt !== undefined) {
				const elapsed = this.#now() - this.#lastRequestAt;
				if (elapsed < this.#config.cooldownMs) {
					await withAbort(this.#sleep(this.#config.cooldownMs - elapsed), signal);
				}
			}
			signal.throwIfAborted();
			try {
				this.#budget.consume();
			} catch (error) {
				throw new CampaignStop("request-cap", error instanceof Error ? error.message : "request cap exhausted");
			}
			this.#byKind[request.kind] = (this.#byKind[request.kind] ?? 0) + 1;
			if (request.kind.startsWith("registry-")) {
				this.#registryOriginsReached.add(new URL(request.target).origin);
			}
			attempted = true;
			const result = await this.#executor.execute<Value>(
				Object.freeze({ ...request, task: Object.freeze({ ...task }) }),
				signal
			);
			if (result.metadata.attempts !== 1 || result.metadata.redirected !== false) {
				throw new CampaignStop(
					"driver-failure",
					"reviewed executor must report exactly one non-redirected top-level attempt"
				);
			}
			if (result.metadata.status === 429 || result.metadata.retryAfter !== undefined) {
				throw new CampaignStop("rate-limited", "operator rate limit observed; collection stopped");
			}
			if (result.metadata.operatorTermsConcern === true) {
				throw new CampaignStop("operator-terms-concern", "operator terms concern observed; collection stopped");
			}
			return result.value;
		} finally {
			if (attempted) this.#lastRequestAt = this.#now();
			this.#active = false;
		}
	}

	private assertAllowlisted(request: PublicRequest): void {
		if (request.kind.startsWith("dht-")) {
			if (!this.#allowedDhtTargets.has(request.target)) {
				throw new CampaignStop("driver-failure", "public DHT bootstrap target is not allowlisted");
			}
			return;
		}
		let origin: string;
		try {
			const target = new URL(request.target);
			if (target.protocol !== "https:") {
				throw new Error("not HTTPS");
			}
			if (target.username !== "" || target.password !== "") {
				throw new Error("contains URL credentials");
			}
			origin = target.origin;
		} catch {
			throw new CampaignStop("driver-failure", "public request target must be an allowlisted HTTPS URL");
		}
		if (!this.#allowedOrigins.has(origin)) {
			throw new CampaignStop("driver-failure", "public request origin is not allowlisted");
		}
		const group = requestGroup(request.kind);
		if (group === "dht" || !this.#allowedOriginsByGroup[group].has(origin)) {
			throw new CampaignStop("driver-failure", "public request target does not match its configured endpoint role");
		}
	}
}

class TaskRequestGate implements PublicRequestGate {
	readonly #caps: Partial<Record<PublicRequestKind, number>>;
	readonly #consumed: Partial<Record<PublicRequestKind, number>> = {};
	readonly #delegate: SerializedPublicRequestGate;
	readonly #signal: AbortSignal;
	readonly #task: CampaignTask;
	readonly #taskKind: CampaignTask["kind"];
	readonly #totalCap: number | undefined;

	constructor(
		config: PublicCampaignConfig,
		task: CampaignTask,
		delegate: SerializedPublicRequestGate,
		signal: AbortSignal
	) {
		this.#delegate = delegate;
		this.#signal = signal;
		this.#task = task;
		this.#taskKind = task.kind;
		this.#totalCap =
			task.kind === "grid-canary" ? config.plan.endpointCallCaps.gridCanaryPerBrowserCondition : undefined;
		if (task.kind === "node") {
			const cap = config.plan.endpointCallCaps.nodeRoutingPerIdentity;
			this.#caps = {
				"dht-lookup": cap,
				"dht-provide": cap,
				"dht-reprovide": cap,
			};
		} else if (task.kind === "browser") {
			const delegatedCap = config.plan.endpointCallCaps.delegatedPerBrowserIdentity;
			const registryCap = config.plan.endpointCallCaps.registryPerBrowserIdentity;
			const relayCap = config.plan.endpointCallCaps.relayPerBrowserIdentity;
			this.#caps = {
				"delegated-lookup": delegatedCap,
				"registry-discover": registryCap,
				"registry-refresh": registryCap,
				"registry-register": registryCap,
				"relay-dial": relayCap,
				"relay-discover": relayCap,
				"relay-refresh": relayCap,
				"relay-replace": relayCap,
				"relay-reserve": relayCap,
			};
		} else {
			const cap = config.plan.endpointCallCaps.gridCanaryPerBrowserCondition;
			this.#caps = {
				"delegated-lookup": cap,
				"dht-lookup": cap,
				"dht-provide": cap,
				"dht-reprovide": cap,
				"grid-canary": cap,
				"registry-discover": cap,
				"registry-refresh": cap,
				"registry-register": cap,
				"relay-dial": cap,
				"relay-discover": cap,
				"relay-refresh": cap,
				"relay-replace": cap,
				"relay-reserve": cap,
			};
		}
	}

	async request<Value>(request: PublicRequest): Promise<Value> {
		const totalConsumed = Object.values(this.#consumed).reduce((total, value) => total + (value ?? 0), 0);
		if (this.#totalCap !== undefined && totalConsumed >= this.#totalCap) {
			throw new CampaignStop(
				"request-cap",
				`${this.#taskKind} per-task request cap exhausted (${totalConsumed}/${this.#totalCap})`
			);
		}
		const group = requestGroup(request.kind);
		const cap = Object.entries(this.#caps)
			.filter(([kind]) => requestGroup(kind as PublicRequestKind) === group)
			.reduce((highest, [, value]) => Math.max(highest, value ?? 0), 0);
		if (cap === 0) {
			throw new CampaignStop("driver-failure", `${request.kind} is not permitted for this campaign task`);
		}
		const consumed = Object.entries(this.#consumed)
			.filter(([kind]) => requestGroup(kind as PublicRequestKind) === group)
			.reduce((total, [, value]) => total + (value ?? 0), 0);
		if (consumed >= cap) {
			throw new CampaignStop("request-cap", `${group} per-task request cap exhausted (${consumed}/${cap})`);
		}
		this.#consumed[request.kind] = (this.#consumed[request.kind] ?? 0) + 1;
		this.#signal.throwIfAborted();
		return this.#delegate.request(request, this.#task, this.#signal);
	}

	assertRequiredRequests(): void {
		const groups = new Set(
			Object.entries(this.#consumed)
				.filter(([, count]) => (count ?? 0) > 0)
				.map(([kind]) => requestGroup(kind as PublicRequestKind))
		);
		const requiredGroups =
			this.#taskKind === "node"
				? ["dht"]
				: this.#taskKind === "browser"
					? ["delegated", "registry", "relay"]
					: ["dht", "delegated", "registry", "relay", "grid"];
		for (const group of requiredGroups) {
			if (!groups.has(group as ReturnType<typeof requestGroup>)) {
				throw new CampaignStop("driver-failure", `${this.#taskKind} task omitted required ${group} request`);
			}
		}
		if (
			(this.#taskKind === "node" || this.#taskKind === "grid-canary") &&
			((this.#consumed["dht-provide"] ?? 0) === 0 || (this.#consumed["dht-lookup"] ?? 0) === 0)
		) {
			throw new CampaignStop(
				"driver-failure",
				`${this.#taskKind} task must provide and look up its Node anchor through the public DHT`
			);
		}
		if (
			(this.#taskKind === "browser" || this.#taskKind === "grid-canary") &&
			(this.#consumed["registry-discover"] ?? 0) === 0
		) {
			throw new CampaignStop("driver-failure", `${this.#taskKind} task must discover through a signed registry`);
		}
		if (
			(this.#taskKind === "browser" || this.#taskKind === "grid-canary") &&
			((this.#consumed["relay-reserve"] ?? 0) === 0 || (this.#consumed["relay-dial"] ?? 0) === 0)
		) {
			throw new CampaignStop("driver-failure", `${this.#taskKind} task must reserve and dial a public relay`);
		}
		if (this.#taskKind === "grid-canary" && (this.#consumed["registry-register"] ?? 0) === 0) {
			throw new CampaignStop("driver-failure", "grid-canary task must register through a signed registry");
		}
	}

	assertPartialFailure(reason: PublicCampaignPartialReason): void {
		const group = partialReasonGroup(reason);
		const permitted = Object.keys(this.#caps).some((kind) => requestGroup(kind as PublicRequestKind) === group);
		const consumed = Object.entries(this.#consumed)
			.filter(([kind]) => requestGroup(kind as PublicRequestKind) === group)
			.reduce((total, [, count]) => total + (count ?? 0), 0);
		if (!permitted || consumed === 0) {
			throw new CampaignStop(
				"driver-failure",
				`${this.#taskKind} task reported ${reason} without a matching public request`
			);
		}
	}
}

/**
 * Refuses reports that do not cover every pre-registered Phase 09 cell.
 * @param config - Frozen campaign configuration.
 * @param observations - Parsed, pseudonymized observations.
 * @returns Human-readable missing or duplicate cell issues.
 */
export function validatePublicCampaignCoverage(
	config: PublicCampaignConfig,
	observations: CampaignObservation[]
): string[] {
	const issues: string[] = [];
	const identities = new Set<string>();
	for (const observation of observations) {
		const key = `${observation.decisionId}:${observation.identityPseudonym}`;
		if (identities.has(key)) issues.push(`duplicate decision identity ${key}`);
		identities.add(key);
	}

	for (const condition of config.plan.conditions) {
		requireCount(issues, observations, {
			count: 100,
			label: `node-dht-cold-bootstrap/${condition}`,
			predicate: (row) =>
				row.decisionId === "node-dht-cold-bootstrap" && row.condition === condition && row.target === "node",
		});
		for (const browser of config.plan.browsers) {
			requireCount(issues, observations, {
				count: 100,
				label: `delegated-first-valid-peer/${condition}/${browser}`,
				predicate: (row) =>
					row.decisionId === "delegated-first-valid-peer" && row.condition === condition && row.browser === browser,
			});
			for (const [transportProfile, count] of Object.entries(config.plan.transportProfileSplit)) {
				for (const decisionId of ["public-relay-supported-baseline", "public-relay-optional-overflow"]) {
					requireCount(issues, observations, {
						count,
						label: `${decisionId}/${condition}/${browser}/${transportProfile}`,
						predicate: (row) =>
							row.decisionId === decisionId &&
							row.condition === condition &&
							row.browser === browser &&
							row.transportProfile === transportProfile,
					});
				}
			}
			requireCount(issues, observations, {
				count: 1,
				label: `public-direct-webrtc-canary/${condition}/${browser}`,
				predicate: (row) =>
					row.decisionId === "public-direct-webrtc-canary" &&
					row.condition === condition &&
					row.browser === browser &&
					row.target === "grid-canary",
			});
		}
	}
	const diversityIdentities = new Set(
		observations
			.filter(({ decisionId }) => decisionId === "public-relay-diversity")
			.map(({ identityPseudonym }) => identityPseudonym)
	);
	const diversityOperators = new Set(
		observations
			.filter(
				({ decisionId, reservationOutcome }) =>
					decisionId === "public-relay-diversity" && reservationOutcome === "accepted"
			)
			.flatMap(({ operatorGroupPseudonyms }) => operatorGroupPseudonyms)
	);
	if (diversityIdentities.size < 600) {
		issues.push(`public-relay-diversity has ${diversityIdentities.size}/600 unique identities`);
	}
	const minimumOperatorGroups = PUBLIC_DECISION_RULES.find(
		({ id }) => id === "public-relay-diversity"
	)?.minimumOperatorGroups;
	if (minimumOperatorGroups === undefined) {
		issues.push("public-relay-diversity has no frozen minimum-operator rule");
	} else if (diversityOperators.size < minimumOperatorGroups) {
		issues.push(`public-relay-diversity has ${diversityOperators.size}/${minimumOperatorGroups} operator groups`);
	}
	return issues;
}

function assertTaskObservations(
	task: CampaignTask,
	observations: CampaignObservation[],
	status: PublicCampaignTaskResult["status"]
): void {
	const expectedDecisions =
		task.kind === "node"
			? ["node-dht-cold-bootstrap"]
			: task.kind === "grid-canary"
				? ["public-direct-webrtc-canary"]
				: [
						"delegated-first-valid-peer",
						"public-relay-supported-baseline",
						"public-relay-optional-overflow",
						"public-relay-diversity",
					];
	for (const observation of observations) {
		const taskMatches =
			observation.identityPseudonym === task.identityPseudonym &&
			observation.condition === task.condition &&
			observation.target === task.kind &&
			(task.kind === "node" ||
				(observation.browser === task.browser &&
					(task.kind === "grid-canary" || observation.transportProfile === task.transportProfile)));
		if (!taskMatches || !expectedDecisions.includes(observation.decisionId)) {
			throw new CampaignStop("driver-failure", "campaign observation is not owned by its producing task");
		}
	}
	if (status === "complete") {
		const actualDecisions = observations.map(({ decisionId }) => decisionId).sort();
		const expected = [...expectedDecisions].sort();
		if (
			actualDecisions.length !== expected.length ||
			actualDecisions.some((value, index) => value !== expected[index])
		) {
			throw new CampaignStop(
				"driver-failure",
				"complete campaign task omitted or duplicated required decision evidence"
			);
		}
	}
}

function normalizeTaskResult(value: PublicCampaignTaskResult | unknown[]): PublicCampaignTaskResult {
	if (Array.isArray(value)) {
		return { observations: value, status: "complete" };
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!("status" in value) ||
		!("observations" in value) ||
		!Array.isArray(value.observations)
	) {
		throw new CampaignStop("driver-failure", "campaign driver returned an invalid task result");
	}
	if (value.status === "complete") {
		return { observations: value.observations, status: "complete" };
	}
	if (
		value.status === "partial" &&
		"reason" in value &&
		typeof value.reason === "string" &&
		isPartialReason(value.reason)
	) {
		return {
			observations: value.observations,
			reason: value.reason,
			status: "partial",
		};
	}
	throw new CampaignStop("driver-failure", "campaign driver returned an invalid task result");
}

function isPartialReason(value: string): value is PublicCampaignPartialReason {
	return ["delegated-outage", "dht-outage", "grid-canary-outage", "registry-outage", "relay-outage"].includes(value);
}

function partialReasonGroup(reason: PublicCampaignPartialReason): "dht" | "delegated" | "grid" | "registry" | "relay" {
	switch (reason) {
		case "delegated-outage":
			return "delegated";
		case "dht-outage":
			return "dht";
		case "grid-canary-outage":
			return "grid";
		case "registry-outage":
			return "registry";
		case "relay-outage":
			return "relay";
	}
}

function partialCell(
	task: CampaignTask,
	reason: PublicCampaignPartialReason
): PublicCampaignRunResult["partialCells"][number] {
	if (task.kind === "browser") {
		return {
			browser: task.browser,
			condition: task.condition,
			identityPseudonym: task.identityPseudonym,
			reason,
			target: task.kind,
			transportProfile: task.transportProfile,
		};
	}
	if (task.kind === "grid-canary") {
		return {
			browser: task.browser,
			condition: task.condition,
			identityPseudonym: task.identityPseudonym,
			reason,
			target: task.kind,
		};
	}
	return {
		condition: task.condition,
		identityPseudonym: task.identityPseudonym,
		reason,
		target: task.kind,
	};
}

function pseudonym(runId: string, prefix: "peer", index: number): string {
	const digest = createHash("sha256").update(`${runId}:${prefix}:${index}`).digest("hex").slice(0, 12);
	return `${prefix}_${digest}`;
}

function shuffle<Value>(values: Value[], random: SeededRandom): Value[] {
	const shuffled = [...values];
	for (let index = shuffled.length - 1; index > 0; index -= 1) {
		const selected = Math.floor(random.next() * (index + 1));
		[shuffled[index], shuffled[selected]] = [shuffled[selected] as Value, shuffled[index] as Value];
	}
	return shuffled;
}

function requestGroup(kind: PublicRequestKind): "dht" | "delegated" | "grid" | "registry" | "relay" {
	if (kind.startsWith("dht-")) return "dht";
	if (kind.startsWith("registry-")) return "registry";
	if (kind.startsWith("relay-")) return "relay";
	if (kind === "delegated-lookup") return "delegated";
	return "grid";
}

function requireCount(
	issues: string[],
	observations: CampaignObservation[],
	requirement: {
		count: number;
		label: string;
		predicate(observation: CampaignObservation): boolean;
	}
): void {
	const count = observations.filter(requirement.predicate).length;
	if (count < requirement.count) issues.push(`${requirement.label} has ${count}/${requirement.count} observations`);
}

async function withAbort<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
	if (signal.aborted) throw signal.reason;
	return new Promise<Value>((resolve, reject) => {
		const abort = (): void => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		signal.addEventListener("abort", abort, { once: true });
		void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
