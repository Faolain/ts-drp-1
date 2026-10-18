import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createMetricsRegister } from "../../packages/network/src/metrics/prometheus.js";
import {
	type StandingShadowTelemetryHandle,
	startStandingShadowTelemetry,
} from "../../packages/test-utils/src/shadow-telemetry.js";
import { enableTracing, flush, OpentelemetryMetrics } from "../../packages/tracer/src/index.js";
import { buildShadowRun } from "../../tests/fixtures/phase-4d-v3/shadow-driver.js";

const JOB_NAME = "ts-drp-shadow-soak";

export interface ShadowSoakProcessInput {
	flush(): Promise<void>;
	readonly handle: StandingShadowTelemetryHandle;
	readonly signal: Promise<"SIGINT" | "SIGTERM">;
}

/**
 * Supervises terminal evidence and process shutdown without allowing either to outrun trace export.
 * @param input - Standing handle, tracer flush and process signal capability.
 */
export async function superviseStandingShadowTelemetry(input: ShadowSoakProcessInput): Promise<void> {
	let terminalFlush: Promise<void> | undefined;
	let signalShutdown: Promise<"signal"> | undefined;
	const flushTerminalOnce = (): Promise<void> => {
		terminalFlush ??= input.flush();
		return terminalFlush;
	};
	const firstCycle = input.handle.firstCycle.then(async (snapshot) => {
		if (snapshot.state === "terminal") await flushTerminalOnce();
		return "first-cycle" as const;
	});
	const signaled = input.signal.then(() => {
		signalShutdown = (async (): Promise<"signal"> => {
			await input.handle.stop();
			await input.flush();
			return "signal" as const;
		})();
		return signalShutdown;
	});
	const done = input.handle.done.then(
		async () => signalShutdown ?? ("done" as const),
		async (error: unknown) => {
			await flushTerminalOnce();
			throw error;
		}
	);
	const firstOutcome = await Promise.race([firstCycle, done, signaled]);
	if (firstOutcome === "first-cycle") await Promise.race([done, signaled]);
}

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) throw new TypeError(`${name} is required`);
	return value;
}

function processSignal(): Promise<"SIGINT" | "SIGTERM"> {
	return new Promise((resolve) => {
		const settle = (signal: "SIGINT" | "SIGTERM"): void => {
			process.off("SIGINT", onInterrupt);
			process.off("SIGTERM", onTerminate);
			resolve(signal);
		};
		const onInterrupt = (): void => settle("SIGINT");
		const onTerminate = (): void => settle("SIGTERM");
		process.once("SIGINT", onInterrupt);
		process.once("SIGTERM", onTerminate);
	});
}

async function main(): Promise<void> {
	const instance = requiredEnvironment("SHADOW_INSTANCE");
	const pushgatewayUrl = requiredEnvironment("SHADOW_PUSHGATEWAY_URL");
	const sha = requiredEnvironment("SHADOW_SHA");
	const exporterUrl = process.env.SHADOW_OTLP_EXPORTER_URL;
	if (exporterUrl !== undefined && exporterUrl.length > 0) {
		enableTracing({ provider: { exporterUrl, serviceName: JOB_NAME } });
	}
	const register = createMetricsRegister(pushgatewayUrl);
	const handle = startStandingShadowTelemetry({
		instance,
		produceShard: ({ closes, seed }) => buildShadowRun({ closes, referenceSampleInterval: closes / 10, seed }),
		prometheus: {
			gauge: ({ help, labelNames, name }) => register.gauge({ help, labelNames: [...labelNames], name }),
			pushStrict: ({ groupings, jobName, signal }) => register.pushMetricsOrThrow(jobName, groupings, signal),
		},
		sha,
		tracer: new OpentelemetryMetrics(JOB_NAME),
	});
	await superviseStandingShadowTelemetry({ flush, handle, signal: processSignal() });
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
	void main().catch(async (error: unknown) => {
		await flush().catch(() => undefined);
		console.error(error);
		process.exitCode = 1;
	});
}
