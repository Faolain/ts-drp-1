/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await -- runtime mocks preserve the producer's async dependency shapes. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type RegisteredProducer = (fixtures: Readonly<Record<string, unknown>>) => Promise<void>;

const harness = vi.hoisted(() => ({
	afterAll: undefined as (() => Promise<void>) | undefined,
	beforeAll: undefined as (() => Promise<void>) | undefined,
	events: [] as string[],
	measurement: "supported" as "failed" | "supported" | "throwing" | "unsupported",
	producer: undefined as RegisteredProducer | undefined,
}));

vi.mock("@playwright/test", async () => {
	const { expect: vitestExpect } = (await vi.importActual("vitest")) as { expect: typeof expect };
	const browserType = Object.freeze({ executablePath: () => "/opt/playwright/browser" });
	const test = Object.assign(
		(_name: string, producer: RegisteredProducer): void => {
			harness.producer = producer;
		},
		{
			afterAll: (callback: () => Promise<void>): void => {
				harness.afterAll = callback;
			},
			beforeAll: (callback: () => Promise<void>): void => {
				harness.beforeAll = callback;
			},
		}
	);
	return { chromium: browserType, expect: vitestExpect, firefox: browserType, test, webkit: browserType };
});

vi.mock("./fixtures/asset-server.js", () => ({
	startAssetServer: async () =>
		Object.freeze({
			close: async (): Promise<void> => undefined,
			issueTransitionURL: () => "http://127.0.0.1:3000/run/token/phase-2e6.html",
		}),
}));

vi.mock("./fixtures/phase-2e6-process-death-runner.js", () => ({
	createProcessDeathRunner: () =>
		Object.freeze({
			runControls: async () => Object.freeze({}),
			runEdge: async (edge: Readonly<{ id: string }>) => {
				harness.events.push(`runEdge:${edge.id}`);
				return Object.freeze({
					caseEvidence: Object.freeze({ recoveredImage: Object.freeze({}), tracePrefix: Object.freeze([]) }),
					recoveredHead: Object.freeze({ kind: "none", objectId: "arming-order-control" }),
				});
			},
		}),
}));

vi.mock("./fixtures/phase-2e6-real-process-death-validator.js", () => ({
	phase2e6CaseErrors: () => Object.freeze([]),
}));

vi.mock("./fixtures/phase-2h-a-aggregate.js", () => ({
	aggregatePhase2h: () =>
		Object.freeze({
			records: Object.freeze([
				Object.freeze({
					persistenceMode: "unsupported",
					scenarioEvidence: Object.freeze({ tag: "capacity" }),
					tupleId: "capacity/chromium",
					webLocksMode: "unavailable",
				}),
			]),
		}),
	readPhase2hRunEntries: () => Object.freeze({ diagnostics: Object.freeze([]), records: Object.freeze([]) }),
}));

vi.mock("./fixtures/phase-2h-a-evidence-digest.js", () => ({
	phase2hEvidenceImageDigest: () => "0".repeat(64),
}));

vi.mock("./fixtures/phase-2h-a-record.js", () => ({
	validatePhase2hRecord: (record: unknown) => Object.freeze({ errors: Object.freeze([]), record }),
}));

const ORIGINAL_PLATFORM = process.platform;

function armingObservation(): Readonly<Record<string, unknown>> {
	if (harness.measurement === "throwing") throw new TypeError("injected arming measurement exception");
	harness.events.push(`measurement:${harness.measurement}`);
	if (harness.measurement !== "supported") return Object.freeze({ outcome: harness.measurement });
	return Object.freeze({
		armHitCount: 1,
		blockedForMs: 100,
		cellAtHit: 1,
		finalCellValue: 2,
		notifyWoken: 1,
		transactionTerminalAfterResume: "complete",
		transactionTerminalWhileBlocked: false,
		workerCrossOriginIsolated: true,
		workerScope: "DedicatedWorkerGlobalScope",
	});
}

async function runProducer(): Promise<void> {
	const producer = harness.producer;
	if (producer === undefined) throw new TypeError("Phase 2h-d producer registration was not captured");
	await producer({
		browser: Object.freeze({ version: () => "1.0" }),
		browserName: "chromium",
		page: Object.freeze({
			evaluate: async (callback: unknown) =>
				typeof callback === "function" && callback.length === 0 ? "test-agent" : armingObservation(),
			goto: async () => undefined,
			waitForFunction: async () => undefined,
		}),
	});
}

beforeAll(async () => {
	Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
	process.env.PHASE_2H_A_ASSET_DIR = "/tmp/phase-2h-assets";
	process.env.PHASE_2H_A_GIT_SHA = "a".repeat(40);
	process.env.PHASE_2H_A_RUN_ID = `phase-2h/${"a".repeat(40)}/00000000-0000-4000-8000-000000000000`;
	process.env.PHASE_2H_A_SUBMISSION_URLS = JSON.stringify({ chromium: "http://127.0.0.1:3000/submit" });
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init: Readonly<{ body?: unknown }>) => {
			const body = JSON.parse(String(init.body)) as { record: { tupleId: string } };
			harness.events.push(`submit:${body.record.tupleId}`);
			return Object.freeze({
				json: async () =>
					Object.freeze({
						owner: "phase-2h-parent/v1",
						project: "chromium",
						status: "accepted",
						tupleId: body.record.tupleId,
					}),
				ok: true,
			});
		})
	);
	await import("./phase-2h-d-process-death-producer.pw.js");
	await harness.beforeAll?.();
});

afterAll(async () => {
	await harness.afterAll?.();
	Object.defineProperty(process, "platform", { configurable: true, value: ORIGINAL_PLATFORM });
	vi.unstubAllGlobals();
});

describe("Phase 2h-d arming-before-death corrective RED", () => {
	it.each(["unsupported", "failed", "throwing"] as const)(
		"RED: %s arming produces zero process-death executions and zero submissions",
		async (measurement) => {
			harness.events.length = 0;
			harness.measurement = measurement;

			await expect(runProducer()).rejects.toThrow(/arming measurement|injected arming/u);
			expect.soft(harness.events.filter((event) => event.startsWith("runEdge:"))).toEqual([]);
			expect.soft(harness.events.filter((event) => event.startsWith("submit:"))).toEqual([]);
		}
	);

	it("RED: completes the supported measurement before the first of all eighteen death executions", async () => {
		harness.events.length = 0;
		harness.measurement = "supported";

		await runProducer();

		expect.soft(harness.events[0]).toBe("measurement:supported");
		expect.soft(harness.events.filter((event) => event.startsWith("measurement:"))).toHaveLength(1);
		expect.soft(harness.events.filter((event) => event.startsWith("runEdge:"))).toHaveLength(18);
		expect.soft(harness.events.filter((event) => event.startsWith("submit:"))).toHaveLength(18);
	});

	it("positive control: supported arming still completes the full batch and parent publication", async () => {
		harness.events.length = 0;
		harness.measurement = "supported";

		await runProducer();

		expect(harness.events.filter((event) => event.startsWith("measurement:"))).toEqual(["measurement:supported"]);
		expect(harness.events.filter((event) => event.startsWith("runEdge:"))).toHaveLength(18);
		expect(harness.events.filter((event) => event.startsWith("submit:"))).toHaveLength(18);
	});
});
