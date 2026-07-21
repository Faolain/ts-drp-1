import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { fixturePublicCampaign } from "../src/fixture.js";
import { reviewedExecutorModulePath } from "../src/public-campaign/executor-module.js";
import {
	aggregateCampaignObservations,
	aggregatePublicCampaignCells,
	type AuthorizedPublicRequest,
	createEnvironmentBlockedCampaignReport,
	createPublicCampaignTasks,
	createReviewedPublicCampaignDriver,
	parseCampaignObservations,
	preflightPublicCampaign,
	PUBLIC_CAMPAIGN_ACKNOWLEDGEMENT,
	type PublicCampaignConfig,
	type PublicCampaignDriver,
	type PublicCampaignRequestExecutor,
	type PublicRequest,
	type PublicRequestGate,
	runPublicCampaign,
	sanitizePublicCampaignPreflight,
	validatePublicCampaignCoverage,
} from "../src/public-campaign/index.js";

describe("Phase 09 opt-in public campaign", () => {
	it("precomputes the frozen matrix and request ceiling before consent", () => {
		const config = validConfig();
		const preflight = preflightPublicCampaign(
			{
				...config,
				consent: {
					...config.consent,
					acknowledgement: "not-consent",
				},
			},
			undefined
		);

		expect(preflight.authorized).toBe(false);
		expect(preflight.precomputed).toMatchObject({
			browserTrials: 600,
			hardRequestCap: 12_920,
			nodeTrials: 200,
			requiredTrialCount: 800,
			trialBudget: 806,
		});
		expect(preflight.blockers.map(({ code }) => code)).toEqual(
			expect.arrayContaining(["invalid-config", "missing-cli-consent"])
		);
	});

	it("requires two independent registries and materially distinct real egress", () => {
		const config = validConfig();
		const result = preflightPublicCampaign(
			{
				...config,
				conditions: [
					config.conditions[0],
					{
						...config.conditions[1],
						descriptorPseudonym: config.conditions[0]?.descriptorPseudonym,
						egressPseudonym: config.conditions[0]?.egressPseudonym,
					},
				],
				endpoints: {
					...config.endpoints,
					registries: [
						config.endpoints.registries[0],
						{
							operatorPseudonym: config.endpoints.registries[0]?.operatorPseudonym,
							url: "https://registry-a.example.test/v1",
						},
					],
				},
			},
			PUBLIC_CAMPAIGN_ACKNOWLEDGEMENT
		);

		expect(result.authorized).toBe(false);
		expect(result.blockers).toEqual([
			expect.objectContaining({
				code: "invalid-config",
				message: expect.stringMatching(
					/materially distinct descriptorPseudonym.*materially distinct egressPseudonym.*independent URL origins.*independent operator/u
				),
			}),
		]);
	});

	it("refuses post-registration changes to the frozen campaign plan", () => {
		const config = validConfig();
		const result = preflightPublicCampaign(
			{
				...config,
				plan: {
					...config.plan,
					endpointCallCaps: {
						...config.plan.endpointCallCaps,
						relayPerBrowserIdentity: 13,
					},
				},
				requestBudget: { hardCap: 13_520 },
			},
			PUBLIC_CAMPAIGN_ACKNOWLEDGEMENT
		);

		expect(result.authorized).toBe(false);
		expect(result.precomputed?.hardRequestCap).toBe(13_520);
		expect(result.blockers).toEqual([
			expect.objectContaining({
				code: "invalid-config",
				message: expect.stringContaining("must exactly match the pre-registered Phase 09 plan"),
			}),
		]);
	});

	it("builds exactly 100 cold Node identities and a balanced 50/50 browser matrix per condition", () => {
		const tasks = createPublicCampaignTasks(validConfig(), 17);
		const nodeTasks = tasks.filter(
			(task): task is Extract<(typeof tasks)[number], { kind: "node" }> => task.kind === "node"
		);
		const browserTasks = tasks.filter(
			(task): task is Extract<(typeof tasks)[number], { kind: "browser" }> => task.kind === "browser"
		);
		const canaryTasks = tasks.filter(
			(task): task is Extract<(typeof tasks)[number], { kind: "grid-canary" }> => task.kind === "grid-canary"
		);

		expect(tasks).toHaveLength(806);
		expect(new Set(tasks.map(({ identityPseudonym }) => identityPseudonym)).size).toBe(806);
		expect(canaryTasks).toHaveLength(6);
		for (const condition of fixturePublicCampaign.conditions) {
			expect(nodeTasks.filter((task) => task.condition === condition)).toHaveLength(100);
			for (const browser of fixturePublicCampaign.browsers) {
				const cell = browserTasks.filter((task) => task.condition === condition && task.browser === browser);
				expect(cell).toHaveLength(100);
				expect(cell.filter((task) => task.transportProfile === "wss-only")).toHaveLength(50);
				expect(cell.filter((task) => task.transportProfile === "wss-wt-webrtc-direct")).toHaveLength(50);
			}
		}
	});

	it("emits an honest environment-blocked result with zero requests and no synthetic trials", async () => {
		const driver = emptyDriver();
		const report = createEnvironmentBlockedCampaignReport();
		const result = await runPublicCampaign(validConfig(), "wrong acknowledgement", driver, {
			sleep: () => Promise.resolve(),
		});

		expect(report).toMatchObject({
			criterionSatisfied: false,
			observations: [],
			publicRequests: 0,
			requestBudget: { consumed: 0, hardCap: 12_920 },
			status: "environment-blocked",
		});
		expect(result).toMatchObject({
			aggregates: [],
			completedTasks: 0,
			criterionSatisfied: false,
			observationCount: 0,
			requests: { byKind: {}, consumed: 0, hardCap: 12_920 },
			status: "environment-blocked",
			stopReason: "environment-blocked",
		});
		expect(driver.runNodeTask).not.toHaveBeenCalled();
	});

	it("keeps the committed sanitized artifact byte-for-data aligned with the report owner", () => {
		const artifact = JSON.parse(
			readFileSync(
				new URL("../../../specs/public-network-spike/evidence/phase-09-environment-blocked.json", import.meta.url),
				"utf8"
			)
		) as unknown;
		expect(artifact).toEqual(createEnvironmentBlockedCampaignReport());
	});

	it("keeps public execution opt-in and refuses the committed placeholder configuration", () => {
		const cli = readFileSync(new URL("../src/public-campaign-cli.ts", import.meta.url), "utf8");
		const workflow = readFileSync(
			new URL("../../../.github/workflows/network-spike-public.yml", import.meta.url),
			"utf8"
		);
		const example = JSON.parse(
			readFileSync(new URL("../../../configs/network-spike-public.example.json", import.meta.url), "utf8")
		) as unknown;

		expect(workflow).toMatch(/workflow_dispatch:/u);
		expect(workflow).not.toMatch(/^\s+(?:pull_request|push|schedule):/mu);
		expect(cli).not.toContain("JSON.stringify(preflight,");
		expect(cli).toContain("sanitizePublicCampaignPreflight(preflight)");
		expect(workflow).toContain("public-campaign-preflight.json");
		expect(workflow).toContain('--executor "$EXECUTOR_NAME"');
		expect(reviewedExecutorModulePath("reviewed-fixture.ts")).toBe(
			new URL("../src/public-campaign-executors/reviewed-fixture.ts", import.meta.url).pathname
		);
		for (const rejected of [
			"../outside.ts",
			"src/public-campaign-executors/reviewed.ts",
			"packages/network-spike/src/public-campaign-executors/reviewed.ts",
			"reviewed.mjs",
		]) {
			expect(() => reviewedExecutorModulePath(rejected)).toThrow();
		}
		expect(preflightPublicCampaign(example, PUBLIC_CAMPAIGN_ACKNOWLEDGEMENT)).toMatchObject({
			authorized: false,
			blockers: [expect.objectContaining({ code: "invalid-config" })],
			precomputed: { hardRequestCap: 12_920, trialBudget: 806 },
		});
	});

	it("exposes only the explicit sanitized preflight projection to workflow logs", () => {
		const config = validConfig();
		const summary = sanitizePublicCampaignPreflight(preflightPublicCampaign(config, PUBLIC_CAMPAIGN_ACKNOWLEDGEMENT));
		const serialized = JSON.stringify(summary);

		expect(summary).toMatchObject({
			authorized: true,
			blockers: [],
			precomputed: { hardRequestCap: 12_920, trialBudget: 806 },
			runId: config.runId,
		});
		for (const protectedValue of [
			config.consent.grantedBy,
			config.conditions[0]?.authorizationReference,
			config.conditions[0]?.egressPseudonym,
			config.endpoints.delegatedRouting[0],
			config.endpoints.publicDhtBootstrap[0],
			config.endpoints.registries[0]?.url,
		].filter((value): value is string => value !== undefined)) {
			expect(serialized).not.toContain(protectedValue);
		}
	});

	it("rejects executable-looking configs that retain placeholder authorization, endpoints, or versions", () => {
		const config = validConfig();
		const result = preflightPublicCampaign(
			{
				...config,
				conditions: config.conditions.map((condition) => ({
					...condition,
					authorizationReference: "replace-authorization",
				})),
				consent: {
					...config.consent,
					grantedBy: "replace-operator",
				},
				endpointAllowlist: ["https://registry.invalid"],
				endpoints: {
					...config.endpoints,
					delegatedRouting: ["https://registry.invalid/delegated"],
					publicDhtBootstrap: ["/dns4/bootstrap.invalid/tcp/443/wss/p2p/12D3KooWPublic"],
					registries: [
						{
							operatorPseudonym: "operator_111111111111",
							url: "https://registry.invalid/a",
						},
						{
							operatorPseudonym: "operator_222222222222",
							url: "https://other.invalid/b",
						},
					],
					relays: ["https://registry.invalid/relay"],
				},
				versions: {
					...config.versions,
					node: "replace",
				},
			},
			PUBLIC_CAMPAIGN_ACKNOWLEDGEMENT
		);

		expect(result.authorized).toBe(false);
		expect(result.blockers).toEqual([
			expect.objectContaining({
				code: "invalid-config",
				message: expect.stringMatching(
					/placeholder public endpoint.*placeholder public DHT.*placeholder authorization.*placeholder version/u
				),
			}),
		]);
	});

	it("refuses completed schedules whose decision evidence does not cover every frozen cell", () => {
		const config = validConfig();
		const values = createPublicCampaignTasks(config, 9).flatMap((task) => {
			if (task.kind === "node") {
				return [
					observation(task.identityPseudonym, task.condition, "node", {
						decisionId: "node-dht-cold-bootstrap",
					}),
				];
			}
			if (task.kind === "grid-canary") {
				return [
					observation(task.identityPseudonym, task.condition, "grid-canary", {
						browser: task.browser,
						decisionId: "public-direct-webrtc-canary",
					}),
				];
			}
			return [
				"delegated-first-valid-peer",
				"public-relay-supported-baseline",
				"public-relay-optional-overflow",
				"public-relay-diversity",
			].map((decisionId) =>
				observation(task.identityPseudonym, task.condition, "browser", {
					browser: task.browser,
					decisionId,
					transportProfile: task.transportProfile,
				})
			);
		});
		const observations = parseCampaignObservations(values);
		const singleOperator = observations.map((row) => ({
			...row,
			operatorGroupPseudonyms: ["operator_111111111111"],
		}));
		const noAcceptedDiversity = observations.map((row) => ({
			...row,
			...(row.decisionId === "public-relay-diversity" ? { reservationOutcome: "rejected" as const } : {}),
		}));

		expect(validatePublicCampaignCoverage(config, observations)).toEqual([]);
		expect(validatePublicCampaignCoverage(config, observations.slice(0, -1))).not.toEqual([]);
		expect(validatePublicCampaignCoverage(config, singleOperator)).toContain(
			"public-relay-diversity has 1/2 operator groups"
		);
		expect(validatePublicCampaignCoverage(config, noAcceptedDiversity)).toContain(
			"public-relay-diversity has 0/2 operator groups"
		);
	});

	it("accepts only a fully covered schedule that exercises every required request owner", async () => {
		const config = validConfig();
		const driver = createReviewedPublicCampaignDriver(config);

		const result = await runPublicCampaign(config, PUBLIC_CAMPAIGN_ACKNOWLEDGEMENT, driver, {
			executor: reviewedExecutor(),
			now: () => 0,
			sleep: () => Promise.resolve(),
		});

		expect(result).toMatchObject({
			aggregates: expect.any(Array),
			completedTasks: 806,
			coverageIssues: [],
			criterionSatisfied: true,
			plannedTasks: 806,
			requests: {
				consumed: 2_848,
				hardCap: 12_920,
			},
			status: "complete",
		});
		expect(result.observationCount).toBe(2_606);
		expect(result.aggregates).toHaveLength(39);
		expect(result).not.toHaveProperty("observations");
	});

	it("binds every completed observation to the exact task that produced it", async () => {
		const dhtTarget = "/dns4/bootstrap.example.test/tcp/443/wss/p2p/12D3KooWPublic";
		const wrongIdentity = "peer_aaaaaaaaaaaa";
		const driver: PublicCampaignDriver = {
			runBrowserTask: async (task, gate) => {
				await gate.request({ kind: "delegated-lookup", target: "https://delegated.example.test/routing/v1" });
				await gate.request({ kind: "registry-discover", target: registryTarget(task.identityPseudonym) });
				await gate.request({ kind: "relay-reserve", target: "https://relay.example.test/reservations" });
				await gate.request({ kind: "relay-dial", target: "https://relay.example.test/dial" });
				return [
					"delegated-first-valid-peer",
					"public-relay-supported-baseline",
					"public-relay-optional-overflow",
					"public-relay-diversity",
				].map((decisionId) =>
					observation(wrongIdentity, task.condition, "browser", {
						browser: task.browser,
						decisionId,
						transportProfile: task.transportProfile,
					})
				);
			},
			runGridCanaryTask: async (task, gate) => {
				await exerciseGridCanaryOwners(gate, dhtTarget, task.identityPseudonym);
				return [
					observation(wrongIdentity, task.condition, "grid-canary", {
						browser: task.browser,
						decisionId: "public-direct-webrtc-canary",
					}),
				];
			},
			runNodeTask: async (task, gate) => {
				await gate.request({ kind: "dht-provide", target: dhtTarget });
				await gate.request({ kind: "dht-lookup", target: dhtTarget });
				return [
					observation(wrongIdentity, task.condition, "node", {
						decisionId: "node-dht-cold-bootstrap",
					}),
				];
			},
		};

		const result = await runPublicCampaign(validConfig(), PUBLIC_CAMPAIGN_ACKNOWLEDGEMENT, driver, {
			executor: testExecutor(),
			now: () => 0,
			seed: 4,
			sleep: () => Promise.resolve(),
		});

		expect(result).toMatchObject({
			aggregates: [],
			completedTasks: 0,
			criterionSatisfied: false,
			observationCount: 0,
			status: "partial",
			stopReason: "driver-failure",
		});
	});

	it("binds request kinds to their configured endpoint-owner roles", async () => {
		const config = validConfig();
		let seed = 0;
		while (createPublicCampaignTasks(config, seed)[0]?.kind !== "browser") seed += 1;
		const driver: PublicCampaignDriver = {
			runBrowserTask: async (_task, gate) => {
				await gate.request({ kind: "delegated-lookup", target: "https://registry-a.example.test/v1" });
				return [];
			},
			runGridCanaryTask: () => Promise.resolve([]),
			runNodeTask: () => Promise.resolve([]),
		};

		const result = await runPublicCampaign(config, PUBLIC_CAMPAIGN_ACKNOWLEDGEMENT, driver, {
			executor: testExecutor(),
			seed,
			sleep: () => Promise.resolve(),
		});

		expect(result).toMatchObject({
			completedTasks: 0,
			requests: { consumed: 0 },
			status: "partial",
			stopReason: "driver-failure",
		});
	});

	it("rejects credentialed HTTPS targets before spending request budget", async () => {
		const driver: PublicCampaignDriver = {
			runBrowserTask: vi.fn(async (_task, gate) => {
				await gate.request({
					kind: "delegated-lookup",
					target: "https://user:secret@delegated.example.test/routing/v1",
				});
				return [];
			}),
			runGridCanaryTask: vi.fn(() => Promise.resolve([])),
			runNodeTask: vi.fn(() => Promise.resolve([])),
		};
		const executor = testExecutor();
		const execute = vi.spyOn(executor, "execute");
		let seed = 0;
		while (createPublicCampaignTasks(validConfig(), seed)[0]?.kind !== "browser") seed += 1;

		const result = await runPublicCampaign(validConfig(), PUBLIC_CAMPAIGN_ACKNOWLEDGEMENT, driver, {
			executor,
			seed,
			sleep: () => Promise.resolve(),
		});

		expect(result).toMatchObject({
			requests: { consumed: 0 },
			status: "partial",
			stopReason: "driver-failure",
		});
		expect(execute).not.toHaveBeenCalled();
	});

	it("applies the grid-canary cap across all composed endpoint owners, not once per owner", async () => {
		const config = validConfig();
		let seed = 0;
		while (seed < 10_000 && createPublicCampaignTasks(config, seed)[0]?.kind !== "grid-canary") seed += 1;
		expect(seed).toBeLessThan(10_000);
		const requests: PublicRequest[] = [
			{
				kind: "dht-provide",
				target: "/dns4/bootstrap.example.test/tcp/443/wss/p2p/12D3KooWPublic",
			},
			{ kind: "delegated-lookup", target: "https://delegated.example.test/routing/v1" },
			{ kind: "registry-discover", target: "https://registry-a.example.test/v1" },
			{ kind: "relay-reserve", target: "https://relay.example.test/reservations" },
			{ kind: "grid-canary", target: "https://relay.example.test/canary" },
		];
		const driver: PublicCampaignDriver = {
			runBrowserTask: () => Promise.resolve([]),
			runGridCanaryTask: async (_task, gate) => {
				for (let index = 0; index < 21; index += 1) {
					await gate.request(requests[index % requests.length] as PublicRequest);
				}
				return [];
			},
			runNodeTask: () => Promise.resolve([]),
		};

		const result = await runPublicCampaign(config, PUBLIC_CAMPAIGN_ACKNOWLEDGEMENT, driver, {
			executor: testExecutor(),
			seed,
			sleep: () => Promise.resolve(),
		});

		expect(result).toMatchObject({
			completedTasks: 0,
			requests: { consumed: 20 },
			status: "partial",
			stopReason: "request-cap",
		});
	});

	it("records registry-only browser cells as typed partial evidence without inventing other owner requests", async () => {
		const dhtTarget = "/dns4/bootstrap.example.test/tcp/443/wss/p2p/12D3KooWPublic";
		const driver: PublicCampaignDriver = {
			runBrowserTask: async (_task, gate) => {
				await gate.request({ kind: "registry-discover", target: "https://registry-a.example.test/v1" });
				return {
					observations: [],
					reason: "registry-outage",
					status: "partial",
				};
			},
			runGridCanaryTask: async (task, gate) => {
				await exerciseGridCanaryOwners(gate, dhtTarget, task.identityPseudonym);
				return [
					observation(task.identityPseudonym, task.condition, "grid-canary", {
						browser: task.browser,
						decisionId: "public-direct-webrtc-canary",
					}),
				];
			},
			runNodeTask: async (task, gate) => {
				await gate.request({ kind: "dht-provide", target: dhtTarget });
				await gate.request({ kind: "dht-lookup", target: dhtTarget });
				return [
					observation(task.identityPseudonym, task.condition, "node", {
						decisionId: "node-dht-cold-bootstrap",
					}),
				];
			},
		};

		const result = await runPublicCampaign(validConfig(), PUBLIC_CAMPAIGN_ACKNOWLEDGEMENT, driver, {
			executor: testExecutor(),
			now: () => 0,
			sleep: () => Promise.resolve(),
		});

		expect(result).toMatchObject({
			completedTasks: 806,
			criterionSatisfied: false,
			plannedTasks: 806,
			requests: { consumed: 1_048, hardCap: 12_920 },
			status: "partial",
		});
		expect(result.stopReason).toBeUndefined();
		expect(result.partialCells).toHaveLength(600);
		expect(result.partialCells).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					reason: "registry-outage",
					target: "browser",
				}),
			])
		);
		expect(result.requests.byKind).toMatchObject({
			"delegated-lookup": 6,
			"dht-lookup": 206,
			"dht-provide": 206,
			"grid-canary": 6,
			"registry-discover": 606,
			"registry-register": 6,
			"relay-dial": 6,
			"relay-reserve": 6,
		});
	});

	it("serializes and cools requests while stopping immediately on rate limit", async () => {
		let clock = 0;
		const sleep = vi.fn((delayMs: number) => {
			clock += delayMs;
			return Promise.resolve();
		});
		let requestCount = 0;
		const driver: PublicCampaignDriver = {
			runBrowserTask: vi.fn(async (task, gate) => {
				await gate.request({ kind: "delegated-lookup", target: "https://delegated.example.test/routing/v1" });
				await gate.request({ kind: "registry-discover", target: "https://registry-a.example.test/v1" });
				await gate.request({ kind: "relay-reserve", target: "https://relay.example.test/reservations" });
				await gate.request({ kind: "relay-dial", target: "https://relay.example.test/dial" });
				return [
					"delegated-first-valid-peer",
					"public-relay-supported-baseline",
					"public-relay-optional-overflow",
					"public-relay-diversity",
				].map((decisionId) =>
					observation(task.identityPseudonym, task.condition, "browser", {
						browser: task.browser,
						decisionId,
						transportProfile: task.transportProfile,
					})
				);
			}),
			runGridCanaryTask: vi.fn(async (task, gate) => {
				await exerciseGridCanaryOwners(
					gate,
					"/dns4/bootstrap.example.test/tcp/443/wss/p2p/12D3KooWPublic",
					task.identityPseudonym
				);
				return [
					observation(task.identityPseudonym, task.condition, "grid-canary", {
						browser: task.browser,
						decisionId: "public-direct-webrtc-canary",
					}),
				];
			}),
			runNodeTask: vi.fn(async (task, gate) => {
				await gate.request({
					kind: "dht-provide",
					target: "/dns4/bootstrap.example.test/tcp/443/wss/p2p/12D3KooWPublic",
				});
				await gate.request({
					kind: "dht-lookup",
					target: "/dns4/bootstrap.example.test/tcp/443/wss/p2p/12D3KooWPublic",
				});
				return [
					observation(task.identityPseudonym, task.condition, "node", {
						decisionId: "node-dht-cold-bootstrap",
					}),
				];
			}),
		};

		const result = await runPublicCampaign(validConfig(), PUBLIC_CAMPAIGN_ACKNOWLEDGEMENT, driver, {
			executor: testExecutor(() => {
				requestCount += 1;
				return response(requestCount === 3 ? 429 : 200);
			}),
			now: () => clock,
			seed: 4,
			sleep,
		});

		expect(result).toMatchObject({
			completedTasks: 1,
			criterionSatisfied: false,
			requests: { consumed: 3 },
			status: "partial",
			stopReason: "rate-limited",
		});
		expect(sleep).toHaveBeenCalledWith(1_000);
		expect(requestCount).toBe(3);
	});

	it("terminates a hung task at the configured campaign deadline", async () => {
		const config = { ...validConfig(), taskTimeoutMs: 1_000 };
		const hang = (): Promise<never> => new Promise(() => undefined);
		const driver: PublicCampaignDriver = {
			runBrowserTask: hang,
			runGridCanaryTask: hang,
			runNodeTask: hang,
		};

		const result = await runPublicCampaign(config, PUBLIC_CAMPAIGN_ACKNOWLEDGEMENT, driver, {
			executor: testExecutor(),
			seed: 4,
			sleep: () => Promise.resolve(),
		});

		expect(result).toMatchObject({
			completedTasks: 0,
			observationCount: 0,
			requests: { consumed: 0 },
			status: "partial",
			stopReason: "task-timeout",
		});
	});

	it("does not spend request budget when a task deadline expires during cooldown", async () => {
		const config = { ...validConfig(), taskTimeoutMs: 1_000 };
		const executor = testExecutor();
		const execute = vi.spyOn(executor, "execute");
		const driver: PublicCampaignDriver = {
			runBrowserTask: vi.fn(async () => new Promise<never>(() => undefined)),
			runGridCanaryTask: vi.fn(async () => new Promise<never>(() => undefined)),
			runNodeTask: vi.fn(async (task, gate) => {
				await gate.request({
					kind: "dht-provide",
					target: "/dns4/bootstrap.example.test/tcp/443/wss/p2p/12D3KooWPublic",
				});
				await gate.request({
					kind: "dht-lookup",
					target: "/dns4/bootstrap.example.test/tcp/443/wss/p2p/12D3KooWPublic",
				});
				return [
					observation(task.identityPseudonym, task.condition, "node", {
						decisionId: "node-dht-cold-bootstrap",
					}),
				];
			}),
		};

		const result = await runPublicCampaign(config, PUBLIC_CAMPAIGN_ACKNOWLEDGEMENT, driver, {
			executor,
			now: () => 0,
			seed: 4,
			sleep: () => new Promise<never>(() => undefined),
		});

		expect(result).toMatchObject({
			completedTasks: 0,
			requests: { consumed: 1 },
			status: "partial",
			stopReason: "task-timeout",
		});
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("parses rich pseudonymized metrics and computes stable descriptive statistics", () => {
		const parsed = parseCampaignObservations([
			observation("peer_111111111111", "primary-home-nat", "browser", {
				candidateCount: 2,
				candidatesPerSuccess: 2,
				latencyMs: 10,
			}),
			observation("peer_222222222222", "primary-home-nat", "browser", {
				candidateCount: 4,
				candidatesPerSuccess: 4,
				dialSucceeded: false,
				latencyMs: 40,
			}),
		]);
		const aggregate = aggregateCampaignObservations(parsed);

		expect(aggregate).toMatchObject({
			candidateCount: { p50: 2, p95: 4, total: 6 },
			candidatesPerSuccess: { p50: 2, p95: 4 },
			dial: { attempts: 2, rate: 0.5, successes: 1 },
			diversity: { asnGroups: 1, ipGroups: 1, operatorGroups: 2 },
			latencyMs: { p50: 10, p95: 40 },
			sampleCount: 2,
		});
		expect(aggregate.dial.wilson95.lower).toBeCloseTo(0.0945, 3);
		expect(aggregate.dial.wilson95.upper).toBeCloseTo(0.9055, 3);
		const cells = aggregatePublicCampaignCells(
			parseCampaignObservations([
				observation("peer_555555555555", "primary-home-nat", "browser", {
					browser: "chromium",
					decisionId: "delegated-first-valid-peer",
					transportProfile: "wss-only",
				}),
				observation("peer_666666666666", "primary-home-nat", "browser", {
					browser: "chromium",
					decisionId: "delegated-first-valid-peer",
					transportProfile: "wss-wt-webrtc-direct",
				}),
				observation("peer_777777777777", "primary-home-nat", "browser", {
					browser: "chromium",
					decisionId: "public-relay-supported-baseline",
					transportProfile: "wss-only",
				}),
				observation("peer_888888888888", "primary-home-nat", "browser", {
					browser: "chromium",
					decisionId: "public-relay-supported-baseline",
					transportProfile: "wss-wt-webrtc-direct",
				}),
			])
		);
		expect(cells).toHaveLength(3);
		expect(cells.find(({ decisionId }) => decisionId === "delegated-first-valid-peer")).toMatchObject({
			aggregate: { sampleCount: 2 },
			dimensions: { browser: "chromium", networkCondition: "primary-home-nat" },
		});
		expect(cells.filter(({ decisionId }) => decisionId === "public-relay-supported-baseline")).toHaveLength(2);
		expect(() =>
			parseCampaignObservations([
				{
					...observation("peer_333333333333", "primary-home-nat", "node"),
					identityPseudonym: "raw-peer-id",
				},
			])
		).toThrow();
		expect(() =>
			parseCampaignObservations([
				{
					...observation("peer_999999999999", "primary-home-nat", "node"),
					protocols: ["/tls/example.com"],
				},
			])
		).toThrow();
		expect(() =>
			parseCampaignObservations([
				{
					...observation("peer_444444444444", "primary-home-nat", "node"),
					protocols: ["/ip4/203.0.113.8/tcp/4001/p2p/12D3KooWRawPeerIdentity"],
				},
			])
		).toThrow();
		for (const locator of [
			"/tls/bootstrap.example.com.",
			"/tls/relay.example.xn--p1ai",
			"/tls/host.01",
			"/tls/localhost",
		]) {
			expect(() =>
				parseCampaignObservations([
					{
						...observation("peer_777777777777", "primary-home-nat", "browser"),
						browser: "chromium",
						protocols: [locator],
						transportProfile: "wss-only",
					},
				])
			).toThrow();
		}
		expect(
			parseCampaignObservations([
				{
					...observation("peer_888888888888", "primary-home-nat", "browser"),
					browser: "chromium",
					protocols: ["/ts-drp/1.0.0"],
					transportProfile: "wss-only",
				},
			])
		).toHaveLength(1);
	});
});

function validConfig(): PublicCampaignConfig {
	return {
		conditions: [
			{
				authorizationReference: "authorization-primary",
				descriptorPseudonym: "network_111111111111",
				egressPseudonym: "egress_111111111111",
				kind: "real-egress",
				label: "primary-home-nat",
				natClass: "port-restricted",
			},
			{
				authorizationReference: "authorization-secondary",
				descriptorPseudonym: "network_222222222222",
				egressPseudonym: "egress_222222222222",
				kind: "real-egress",
				label: "authorized-secondary-egress",
				natClass: "symmetric",
			},
		],
		consent: {
			acknowledgement: PUBLIC_CAMPAIGN_ACKNOWLEDGEMENT,
			grantedAt: "2026-07-20T08:00:00.000Z",
			grantedBy: "fixture-operator",
			operatorTermsReviewedAt: "2026-07-20T08:00:00.000Z",
		},
		cooldownMs: 1_000,
		endpointAllowlist: [
			"https://delegated.example.test",
			"https://registry-a.example.test",
			"https://registry-b.example.test",
			"https://relay.example.test",
		],
		endpoints: {
			delegatedRouting: ["https://delegated.example.test/routing/v1"],
			publicDhtBootstrap: ["/dns4/bootstrap.example.test/tcp/443/wss/p2p/12D3KooWPublic"],
			registries: [
				{
					operatorPseudonym: "operator_111111111111",
					url: "https://registry-a.example.test/v1",
				},
				{
					operatorPseudonym: "operator_222222222222",
					url: "https://registry-b.example.test/v1",
				},
			],
			relays: ["https://relay.example.test/reservations"],
		},
		maxConcurrency: 1,
		taskTimeoutMs: 30_000,
		plan: fixturePublicCampaign,
		rawOutputDirectory: ".network-spike-raw/public-campaign-fixture",
		requestBudget: { hardCap: 12_920 },
		runId: "public-campaign-fixture",
		schemaVersion: "1.0.0",
		stopPolicy: {
			onOperatorTermsConcern: true,
			onRateLimit: true,
		},
		trialBudget: 806,
		versions: {
			browsers: {
				chromium: "134.0",
				firefox: "135.0",
				webkit: "18.4",
			},
			node: "22.15.0",
			os: "darwin-arm64",
			packages: {
				"@libp2p/kad-dht": "16.3.4",
				"libp2p": "3.3.5",
			},
			pnpm: "10.24.0",
			sources: {
				"delegated-routing-api": "v1",
				"issue-5-registry": "1.0.0",
			},
		},
	};
}

function emptyDriver(): PublicCampaignDriver & {
	runBrowserTask: ReturnType<typeof vi.fn>;
	runGridCanaryTask: ReturnType<typeof vi.fn>;
	runNodeTask: ReturnType<typeof vi.fn>;
} {
	return {
		runBrowserTask: vi.fn(),
		runGridCanaryTask: vi.fn(),
		runNodeTask: vi.fn(),
	};
}

async function exerciseGridCanaryOwners(
	gate: PublicRequestGate,
	dhtTarget: string,
	identityPseudonym: string
): Promise<void> {
	await gate.request({ kind: "dht-provide", target: dhtTarget });
	await gate.request({ kind: "dht-lookup", target: dhtTarget });
	await gate.request({ kind: "delegated-lookup", target: "https://delegated.example.test/routing/v1" });
	await gate.request({ kind: "registry-register", target: registryTarget(identityPseudonym) });
	await gate.request({ kind: "registry-discover", target: registryTarget(identityPseudonym) });
	await gate.request({ kind: "relay-reserve", target: "https://relay.example.test/reservations" });
	await gate.request({ kind: "relay-dial", target: "https://relay.example.test/dial" });
	await gate.request({ kind: "grid-canary", target: "https://relay.example.test/canary" });
}

function testExecutor(
	handler: () => Promise<{
		metadata: { attempts: 1; redirected: false; status: number };
		value: undefined;
	}> = () => response()
): PublicCampaignRequestExecutor {
	return {
		async execute<Value>(): Promise<{
			metadata: { attempts: 1; redirected: false; status: number };
			value: Value;
		}> {
			return (await handler()) as unknown as {
				metadata: { attempts: 1; redirected: false; status: number };
				value: Value;
			};
		},
	};
}

function reviewedExecutor(): PublicCampaignRequestExecutor {
	return {
		execute<Value>(request: Readonly<AuthorizedPublicRequest>): Promise<{
			metadata: { attempts: 1; redirected: false; status: number };
			value: Value;
		}> {
			let observations: Record<string, unknown>[] | undefined;
			if (request.task.kind === "node" && request.kind === "dht-lookup") {
				observations = [
					observation(request.task.identityPseudonym, request.task.condition, "node", {
						decisionId: "node-dht-cold-bootstrap",
					}),
				];
			} else if (request.task.kind === "browser" && request.kind === "relay-dial") {
				const task = request.task;
				observations = [
					"delegated-first-valid-peer",
					"public-relay-supported-baseline",
					"public-relay-optional-overflow",
					"public-relay-diversity",
				].map((decisionId) =>
					observation(task.identityPseudonym, task.condition, "browser", {
						browser: task.browser,
						decisionId,
						transportProfile: task.transportProfile,
					})
				);
			} else if (request.task.kind === "grid-canary" && request.kind === "grid-canary") {
				observations = [
					observation(request.task.identityPseudonym, request.task.condition, "grid-canary", {
						browser: request.task.browser,
						decisionId: "public-direct-webrtc-canary",
					}),
				];
			}
			return Promise.resolve({
				metadata: { attempts: 1, redirected: false, status: 200 },
				value: (observations === undefined ? undefined : { observations }) as Value,
			});
		},
	};
}

function registryTarget(identityPseudonym: string): string {
	return Number.parseInt(identityPseudonym.at(-1) ?? "0", 16) % 2 === 0
		? "https://registry-b.example.test/v1"
		: "https://registry-a.example.test/v1";
}

function observation(
	identityPseudonym: string,
	condition: string,
	target: "node" | "browser" | "grid-canary",
	overrides: Record<string, unknown> = {}
): Record<string, unknown> {
	return {
		addressFamilies: ["ipv4"],
		asnGroupPseudonyms: ["asn_111111111111"],
		candidateCount: 1,
		candidatesPerSuccess: 1,
		condition,
		decisionId: target === "node" ? "node-dht-routing" : "delegated-routing",
		dialSucceeded: true,
		hopSucceeded: target === "node" ? null : true,
		identityPseudonym,
		ipGroupPseudonyms: ["ip_111111111111"],
		latencyMs: 12,
		limits: { dataLimitBytes: null, durationLimitSeconds: null },
		operatorGroupPseudonyms: [
			Number.parseInt(identityPseudonym.at(-1) ?? "0", 16) % 2 === 0
				? "operator_222222222222"
				: "operator_111111111111",
		],
		protocols: ["/ts-drp/1.0.0"],
		refreshOutcome: "not-attempted",
		replacementOutcome: "not-attempted",
		reservationOutcome: target === "node" ? "not-attempted" : "accepted",
		target,
		ttlSeconds: null,
		...overrides,
	};
}

function response(status = 200): Promise<{
	metadata: { attempts: 1; redirected: false; status: number };
	value: undefined;
}> {
	return Promise.resolve({
		metadata: { attempts: 1, redirected: false, status },
		value: undefined,
	});
}
