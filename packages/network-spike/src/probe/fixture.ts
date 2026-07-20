import { AddressPolicy } from "./address-policy.js";
import { type ProbeEvent, probeEventToJsonLine } from "./events.js";
import {
	type Probe,
	type ProbeExecution,
	ProbeRunner,
	type ProbeRunnerDependencies,
	type ProbeRunResult,
	SeededRandom,
} from "./kernel.js";
import { ManualClock } from "./manual-clock.js";

export interface AllRefusedFixture {
	events: readonly ProbeEvent[];
	jsonl: string;
	result: ProbeRunResult<never>;
}

const ALL_REFUSED_CANDIDATES = ["relay_000000000001", "relay_000000000002", "relay_000000000003", "relay_000000000004"];

/**
 * Runs the deterministic relay-exhaustion fixture through the real ProbeRunner.
 * @returns Ordered events, JSONL, and the expected typed terminal failure.
 */
export async function runAllRefusedFixture(): Promise<AllRefusedFixture> {
	const clock = new ManualClock();
	const recorded: ProbeEvent[] = [];
	const dependencies: ProbeRunnerDependencies = {
		addressPolicy: new AddressPolicy({ target: "browser" }),
		clock,
		dialer: {
			dial: () => Promise.resolve({ latencyMs: 12, transport: "wss" }),
		},
		fetch: () =>
			Promise.resolve({
				json: () => Promise.resolve({}),
				ok: true,
				status: 200,
				text: () => Promise.resolve(""),
			}),
		random: new SeededRandom(5),
		resolver: {
			resolve: () => Promise.resolve(["198.18.0.1"]),
		},
		resourceSampler: {
			sample: () => ({ activeTimers: clock.pendingTimerCount(), openHandles: 0 }),
		},
		sink: {
			record: (event): void => {
				recorded.push(event);
			},
		},
	};
	const runner = new ProbeRunner(dependencies, {
		cleanupTimeoutMs: 5_000,
		parentTimeoutMs: 30_000,
		runId: "fixture-all-refused",
	});
	const result = await runner.run(createAllRefusedProbe(clock));
	if (recorded.length !== result.events.length) {
		throw new Error("fixture observation sink diverged from the runner event ledger");
	}
	return {
		events: result.events,
		jsonl: result.events.map((event) => probeEventToJsonLine(event)).join(""),
		result,
	};
}

function createAllRefusedProbe(clock: ManualClock): Probe<never> {
	return {
		id: "relay-all-refused",
		run: async (context): Promise<ProbeExecution<never>> => {
			context.defer(() => undefined);
			for (const [index, candidatePseudonym] of ALL_REFUSED_CANDIDATES.entries()) {
				const attempt = index + 1;
				context.emit("relay-candidate", {
					candidatePseudonym,
					provenance: "routing",
					source: "delegated-routing",
				});
				context.emit("relay-hop-support", { candidatePseudonym, supported: true });
				context.emit("dial-attempt", {
					addressPseudonym: `addr_${attempt.toString(16).padStart(12, "0")}`,
					attempt,
					family: index % 2 === 0 ? "ipv4" : "ipv6",
					transport: "wss",
				});
				const dial = await context.dialer.dial(`fixture:${attempt}`, context.signal);
				clock.advanceBy(dial.latencyMs);
				context.emit("dial-result", {
					addressPseudonym: `addr_${attempt.toString(16).padStart(12, "0")}`,
					latencyMs: dial.latencyMs,
					outcome: "connected",
				});
				const reservationLatencyMs = 18 + index;
				clock.advanceBy(reservationLatencyMs);
				context.emit("relay-reservation", {
					candidatePseudonym,
					latencyMs: reservationLatencyMs,
					outcome: "refused",
				});
				if (index < ALL_REFUSED_CANDIDATES.length - 1) {
					const delayMs = 100 * 2 ** index;
					context.emit("endpoint-backoff", {
						attempt,
						delayMs,
						endpointClass: "public-relay",
					});
					clock.advanceBy(delayMs);
				}
			}
			const fallbackDelayMs = 700;
			clock.advanceBy(fallbackDelayMs);
			context.emit("fallback", {
				delayMs: fallbackDelayMs,
				from: "public-relay",
				reason: "exhausted",
				to: "owned-fallback",
			});
			return {
				failure: {
					code: "all-candidates-refused",
					message: "Every bounded public-relay candidate refused the reservation.",
					retryable: false,
				},
				status: "failure",
			};
		},
	};
}
