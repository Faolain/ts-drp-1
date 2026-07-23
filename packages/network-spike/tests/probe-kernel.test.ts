import { AddressPolicy } from "@ts-drp/rendezvous";
import { describe, expect, it } from "vitest";

import {
	ManualClock,
	parseProbeJsonLines,
	type Probe,
	type ProbeContext,
	type ProbeEvent,
	ProbeRunner,
	type ProbeRunnerDependencies,
	type ProbeRunResult,
	runAllRefusedFixture,
	SeededRandom,
} from "../src/probe/index.js";

describe("ProbeRunner", () => {
	it("freezes valid budgets and rejects invalid runner identities and limits", async () => {
		const clock = new ManualClock();
		const options = { cleanupTimeoutMs: 100, parentTimeoutMs: 1_000, runId: "frozen-run" };
		const runner = new ProbeRunner(createDependencies(clock), options);
		options.parentTimeoutMs = 30_001;
		const result = await runner.run({
			id: "frozen-options",
			run: () => Promise.resolve({ status: "success", value: "done" }),
		});
		expect(result).toMatchObject({ status: "success", value: "done" });
		expect(() => new ProbeRunner(createDependencies(clock), { ...options, parentTimeoutMs: Number.NaN })).toThrow();
		expect(
			() =>
				new ProbeRunner(createDependencies(clock), {
					cleanupTimeoutMs: 100,
					parentTimeoutMs: 1_000,
					runId: "",
				})
		).toThrow(/run ID/u);
		expect(
			() =>
				new ProbeRunner(createDependencies(clock), {
					cleanupTimeoutMs: 100,
					parentTimeoutMs: 1_000,
					runId: "unsafe/run",
				})
		).toThrow(/safe identifier/u);
		await expect(
			runner.run({ id: "", run: () => Promise.resolve({ status: "success", value: "done" }) })
		).rejects.toThrow(/probe ID/u);
	});

	it("returns success with ordered telemetry and LIFO cleanup", async () => {
		const clock = new ManualClock();
		const cleanupOrder: number[] = [];
		const runner = createRunner(clock);
		const probe: Probe<string> = {
			id: "success-fixture",
			run: (context) => {
				context.defer(() => {
					cleanupOrder.push(1);
				});
				context.defer(() => {
					cleanupOrder.push(2);
				});
				context.emit("routing-query", { method: "find-peer" });
				return Promise.resolve({ status: "success", value: "done" });
			},
		};
		const result = await runner.run(probe);
		expect(result).toMatchObject({ status: "success", value: "done" });
		expect(cleanupOrder).toEqual([2, 1]);
		expect(result.events.map((event) => event.sequence)).toEqual(result.events.map((_event, index) => index));
		expect(result.events.at(-1)).toMatchObject({
			details: { reason: "completed", status: "success" },
			kind: "terminal",
		});
		expect(clock.pendingTimerCount()).toBe(0);
	});

	it("caps retry/backoff and terminates on the fake-clock parent timeout", async () => {
		const clock = new ManualClock();
		const runner = createRunner(clock, { parentTimeoutMs: 1_000 });
		let cleaned = false;
		const probe: Probe<never> = {
			id: "bounded-timeout",
			run: async (context) => {
				context.defer(async (signal) => {
					await clock.sleep(50, signal);
					cleaned = true;
				});
				for (let attempt = 1; attempt <= 3; attempt += 1) {
					context.emit("endpoint-attempt", {
						attempt,
						endpointClass: "delegated-routing",
						endpointPseudonym: "endpoint_000000000001",
					});
					context.emit("endpoint-backoff", {
						attempt,
						delayMs: 400,
						endpointClass: "delegated-routing",
					});
					await context.clock.sleep(400, context.signal);
				}
				return {
					failure: { code: "unexpected", message: "parent timer should win", retryable: false },
					status: "failure",
				};
			},
		};
		const result = await settleWithClock(runner.run(probe), clock);
		expect(result).toMatchObject({ reason: "timeout", status: "aborted" });
		expect(result.events.filter((event) => event.kind === "endpoint-attempt")).toHaveLength(3);
		expect(cleaned).toBe(true);
		expect(result.events).toContainEqual(
			expect.objectContaining({
				details: { completed: 1, failed: 0, phase: "finish", registered: 1 },
				kind: "cleanup",
			})
		);
		expect(result.events.at(-1)).toMatchObject({ details: { status: "timeout" }, kind: "terminal" });
		expect(clock.pendingTimerCount()).toBe(0);
	});

	it("turns malformed output, dependency throws, sink errors, and cleanup hangs into typed failures", async () => {
		const cases: Array<{
			expected: string;
			probe: Probe<unknown>;
			setup?(dependencies: ProbeRunnerDependencies): void;
		}> = [
			{
				expected: "malformed-result",
				probe: {
					id: "malformed",
					run: () => Promise.resolve({ nope: true }) as never,
				},
			},
			{
				expected: "malformed-result",
				probe: {
					id: "malformed-failure-code",
					run: () =>
						Promise.resolve({
							failure: { code: "DNS_TIMEOUT!", message: "invalid terminal reason", retryable: false },
							status: "failure",
						}),
				},
			},
			{
				expected: "dependency-failure",
				probe: {
					id: "throw",
					run: () => Promise.reject(new Error("resolver exploded")),
				},
			},
			{
				expected: "dependency-failure",
				probe: {
					id: "invalid-event",
					run: (context): Promise<{ status: "success"; value: undefined }> => {
						context.emit("routing-query", { method: "unregistered-method" } as never);
						return Promise.resolve({ status: "success", value: undefined });
					},
				},
			},
			{
				expected: "dependency-failure",
				probe: {
					id: "resource-sampler",
					run: () => Promise.resolve({ status: "success", value: undefined }),
				},
				setup: (dependencies): void => {
					dependencies.resourceSampler.sample = (): never => {
						throw new Error("resource sampler unavailable");
					};
				},
			},
			{
				expected: "dependency-failure",
				probe: {
					id: "non-finite-clock",
					run: () => Promise.resolve({ status: "success", value: undefined }),
				},
				setup: (dependencies): void => {
					dependencies.clock.now = (): number => Number.NaN;
				},
			},
			{
				expected: "resource-limit",
				probe: {
					id: "event-cap",
					run: (context): Promise<{ status: "success"; value: undefined }> => {
						for (let index = 0; index < 2_049; index += 1) {
							context.emit("routing-query", { method: "find-peer" });
						}
						return Promise.resolve({ status: "success", value: undefined });
					},
				},
			},
			{
				expected: "probe-contract-violation",
				probe: {
					id: "forged-terminal",
					run: (context): Promise<{ status: "success"; value: undefined }> => {
						context.emit("terminal", { durationMs: 0, reason: "forged", status: "success" });
						return Promise.resolve({ status: "success", value: undefined });
					},
				},
			},
			{
				expected: "resource-limit",
				probe: {
					id: "cleanup-cap",
					run: (context): Promise<{ status: "success"; value: undefined }> => {
						for (let index = 0; index < 65; index += 1) {
							context.defer(() => undefined);
						}
						return Promise.resolve({ status: "success", value: undefined });
					},
				},
			},
			{
				expected: "dependency-failure",
				probe: {
					id: "clock-read",
					run: () => Promise.resolve({ status: "success", value: undefined }),
				},
				setup: (dependencies): void => {
					dependencies.clock.now = (): never => {
						throw new Error("clock unavailable");
					};
				},
			},
			{
				expected: "dependency-failure",
				probe: {
					id: "timer-setup",
					run: () => Promise.resolve({ status: "success", value: undefined }),
				},
				setup: (dependencies): void => {
					dependencies.clock.setTimer = (): never => {
						throw new Error("timer setup unavailable");
					};
				},
			},
			{
				expected: "dependency-failure",
				probe: {
					id: "timer-teardown",
					run: () => Promise.resolve({ status: "success", value: undefined }),
				},
				setup: (dependencies): void => {
					const clearTimer = dependencies.clock.clearTimer.bind(dependencies.clock);
					dependencies.clock.clearTimer = (handle): void => {
						clearTimer(handle);
						throw new Error("timer teardown unavailable");
					};
				},
			},
			{
				expected: "observation-sink-failure",
				probe: {
					id: "sink",
					run: () => Promise.resolve({ status: "success", value: undefined }),
				},
				setup: (dependencies): void => {
					dependencies.sink.record = (): void => {
						throw new Error("sink unavailable");
					};
				},
			},
			{
				expected: "observation-sink-failure",
				probe: {
					id: "terminal-sink",
					run: () => Promise.resolve({ status: "success", value: undefined }),
				},
				setup: (dependencies): void => {
					const record = dependencies.sink.record.bind(dependencies.sink);
					dependencies.sink.record = (event): void => {
						if (event.kind === "terminal") throw new Error("terminal sink unavailable");
						record(event);
					};
				},
			},
			{
				expected: "cleanup-failure",
				probe: {
					id: "cleanup",
					run: (context): Promise<{ status: "success"; value: undefined }> => {
						context.defer(() => new Promise<void>(() => undefined));
						return Promise.resolve({ status: "success", value: undefined });
					},
				},
			},
		];

		for (const testCase of cases) {
			const clock = new ManualClock();
			const dependencies = createDependencies(clock);
			testCase.setup?.(dependencies);
			const runner = new ProbeRunner(dependencies, {
				cleanupTimeoutMs: 100,
				parentTimeoutMs: 1_000,
				runId: `fixture-${testCase.expected}`,
			});
			const result = await settleWithClock(runner.run(testCase.probe), clock);
			expect(result).toMatchObject({
				failure: { code: testCase.expected },
				status: "failure",
			});
			expect(result.events.at(-1)).toMatchObject({
				details: { reason: testCase.expected, status: "failure" },
				kind: "terminal",
			});
			expect(clock.pendingTimerCount()).toBe(0);
		}
	});

	it("respects external abort and leaves no scheduled work", async () => {
		const clock = new ManualClock();
		const runner = createRunner(clock);
		const controller = new AbortController();
		let cleaned = false;
		const probe: Probe<never> = {
			id: "external-abort",
			run: async (context) => {
				context.defer(async (signal) => {
					await clock.sleep(50, signal);
					cleaned = true;
				});
				await context.clock.sleep(10_000, context.signal);
				throw new Error("unreachable");
			},
		};
		const pending = runner.run(probe, controller.signal);
		controller.abort();
		const result = await settleWithClock(pending, clock);
		expect(result).toMatchObject({ reason: "external", status: "aborted" });
		expect(cleaned).toBe(true);
		expect(result.events).toContainEqual(
			expect.objectContaining({
				details: { completed: 1, failed: 0, phase: "finish", registered: 1 },
				kind: "cleanup",
			})
		);
		expect(clock.pendingTimerCount()).toBe(0);
	});

	it("applies one aggregate cleanup deadline and never starts later cleanup work after it expires", async () => {
		const clock = new ManualClock();
		const runner = createRunner(clock);
		let started = 0;
		const result = await settleWithClock(
			runner.run({
				id: "aggregate-cleanup-timeout",
				run: (context) => {
					for (let index = 0; index < 3; index += 1) {
						context.defer((signal) => {
							started += 1;
							return clock.sleep(10_000, signal);
						});
					}
					return Promise.resolve({ status: "success", value: undefined });
				},
			}),
			clock
		);
		expect(result).toMatchObject({
			durationMs: 100,
			failure: { code: "cleanup-failure" },
			status: "failure",
		});
		expect(started).toBe(1);
		expect(clock.pendingTimerCount()).toBe(0);
	});

	it("keeps one absolute parent deadline alive through bounded cleanup", async () => {
		class RecordingClock extends ManualClock {
			readonly delays: number[] = [];

			override setTimer(callback: () => void, delayMs: number): unknown {
				this.delays.push(delayMs);
				return super.setTimer(callback, delayMs);
			}
		}
		const clock = new RecordingClock();
		const runner = new ProbeRunner(createDependencies(clock), {
			cleanupTimeoutMs: 5_000,
			parentTimeoutMs: 30_000,
			runId: "parent-includes-cleanup",
		});
		const result = await runner.run({
			id: "parent-includes-cleanup",
			run: (context) => {
				context.defer(async (signal) => {
					const pending = clock.sleep(4_999, signal);
					clock.advanceBy(4_999);
					await pending;
				});
				clock.advanceBy(25_000);
				return Promise.resolve({ status: "success", value: undefined });
			},
		});

		expect(result).toMatchObject({ durationMs: 29_999, status: "success" });
		expect(clock.delays.filter((delayMs) => delayMs === 30_000)).toHaveLength(1);
		expect(clock.delays).toContain(5_000);
		expect(clock.pendingTimerCount()).toBe(0);
	});

	it("closes retained probe contexts before cleanup and preserves terminal finality", async () => {
		const clock = new ManualClock();
		const runner = createRunner(clock);
		let retained: ProbeContext | undefined;
		const result = await runner.run({
			id: "retained-context",
			run: (context) => {
				retained = context;
				return Promise.resolve({ status: "success", value: undefined });
			},
		});
		if (retained === undefined) throw new Error("probe context was not retained");
		const eventCount = result.events.length;
		expect(() => retained?.emit("routing-query", { method: "find-peer" })).toThrow(/stream is closed/u);
		expect(() => retained?.defer(() => undefined)).toThrow(/registration is closed/u);
		expect(result.events).toHaveLength(eventCount);
		expect(result.events.at(-1)?.kind).toBe("terminal");
		expect(Object.isFrozen(result.events)).toBe(true);
		expect(Object.isFrozen(result.events.at(-1))).toBe(true);
		expect(clock.pendingTimerCount()).toBe(0);
	});

	it("rejects zombie emissions after timeout without changing the frozen ledger or sink", async () => {
		const clock = new ManualClock();
		const dependencies = createDependencies(clock);
		const sinkEvents: ProbeEvent[] = [];
		dependencies.sink.record = (event): void => {
			sinkEvents.push(event);
		};
		const runner = new ProbeRunner(dependencies, {
			cleanupTimeoutMs: 100,
			parentTimeoutMs: 100,
			runId: "zombie-run",
		});
		let resume: (() => void) | undefined;
		let lateEmitRejected = false;
		const pending = runner.run({
			id: "zombie",
			run: async (context) => {
				await new Promise<void>((resolve) => {
					resume = resolve;
				});
				try {
					context.emit("routing-query", { method: "find-peer" });
				} catch {
					lateEmitRejected = true;
				}
				return { status: "success" as const, value: undefined };
			},
		});
		const result = await settleWithClock(pending, clock);
		expect(result).toMatchObject({ reason: "timeout", status: "aborted" });
		const eventCount = result.events.length;
		const sinkEventCount = sinkEvents.length;
		resume?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(lateEmitRejected).toBe(true);
		expect(result.events).toHaveLength(eventCount);
		expect(result.events.at(-1)?.kind).toBe("terminal");
		expect(sinkEvents).toHaveLength(sinkEventCount);
		expect(Object.isFrozen(result.events)).toBe(true);
		expect(clock.pendingTimerCount()).toBe(0);
	});
});

describe("all-refused replay fixture", () => {
	it("round-trips JSONL and terminates after bounded candidate refusal and fallback", async () => {
		const fixture = await runAllRefusedFixture();
		expect(fixture.result).toMatchObject({
			failure: { code: "all-candidates-refused" },
			status: "failure",
		});
		expect(fixture.events.filter((event) => event.kind === "relay-candidate")).toHaveLength(4);
		expect(fixture.events.filter((event) => event.kind === "relay-reservation")).toHaveLength(4);
		expect(fixture.events.map((event) => event.kind)).toContain("fallback");
		expect(fixture.result.durationMs).toBe(1_526);
		expect(fixture.events.at(-1)).toMatchObject({
			atMs: 1_526,
			details: { durationMs: 1_526 },
			kind: "terminal",
		});
		expect(fixture.events.map((event) => event.atMs)).toEqual(
			[...fixture.events].map((event) => event.atMs).sort((left, right) => left - right)
		);
		expect(parseProbeJsonLines(fixture.jsonl)).toEqual(fixture.events);
		expect(fixture.jsonl).not.toMatch(/12D3Koo|16Uiu2H|Qm|\/ip[46]\//u);
	});
});

function createRunner(clock: ManualClock, options: { parentTimeoutMs?: number } = {}): ProbeRunner {
	return new ProbeRunner(createDependencies(clock), {
		cleanupTimeoutMs: 100,
		parentTimeoutMs: options.parentTimeoutMs ?? 1_000,
		runId: "fixture-run",
	});
}

function createDependencies(clock: ManualClock): ProbeRunnerDependencies {
	const events: ProbeEvent[] = [];
	return {
		addressPolicy: new AddressPolicy({ target: "browser" }),
		clock,
		dialer: { dial: () => Promise.resolve({ latencyMs: 1, transport: "wss" }) },
		fetch: () =>
			Promise.resolve({
				json: () => Promise.resolve({}),
				ok: true,
				status: 200,
				text: () => Promise.resolve(""),
			}),
		random: new SeededRandom(5),
		resolver: { resolve: () => Promise.resolve(["8.8.8.8"]) },
		resourceSampler: {
			sample: () => ({ activeTimers: clock.pendingTimerCount(), openHandles: 0 }),
		},
		sink: {
			record: (event): void => {
				events.push(event);
			},
		},
	};
}

async function settleWithClock<Value>(
	promise: Promise<ProbeRunResult<Value>>,
	clock: ManualClock
): Promise<ProbeRunResult<Value>> {
	let settled = false;
	void promise.finally(() => {
		settled = true;
	});
	for (let turn = 0; turn < 50 && !settled; turn += 1) {
		for (let microtask = 0; microtask < 6; microtask += 1) await Promise.resolve();
		if (!settled) clock.advanceToNext();
	}
	if (!settled) throw new Error("manual-clock probe did not settle");
	return promise;
}
