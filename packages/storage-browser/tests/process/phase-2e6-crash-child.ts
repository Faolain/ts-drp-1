import { chromium } from "@playwright/test";

import type { Phase2e6DeclaredEdge } from "../fixtures/phase-2e6-real-process-death-contract.js";
import {
	captureProcessForest,
	locateBrowserRoot,
	processClosure,
	type ProcessIdentity,
} from "../fixtures/process-forest.js";

interface Phase2e6RootAuthority {
	readonly childRoot: ProcessIdentity;
	readonly contentProcessClass: "chromium-renderer";
	readonly controllerPgid: number;
	readonly executablePath: string;
	readonly platform: "darwin" | "linux";
	readonly profilePath: string;
	readonly scope: "phase2e6";
}

function campaignPlatform(): Phase2e6RootAuthority["platform"] {
	if (process.platform !== "darwin" && process.platform !== "linux")
		throw new TypeError(`unsupported Phase 2e6 campaign platform ${process.platform}`);
	return process.platform;
}

function required(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) throw new TypeError(`${name} is required`);
	return value;
}

function write(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function run(): Promise<never> {
	const executablePath = required("PHASE_2E6_EXECUTABLE_PATH");
	const profilePath = required("PHASE_2E6_PROFILE");
	const databaseName = required("PHASE_2E6_DATABASE");
	const url = required("PHASE_2E6_URL");
	const edge = JSON.parse(required("PHASE_2E6_EDGE")) as Phase2e6DeclaredEdge;
	const context = await chromium.launchPersistentContext(profilePath, { executablePath, headless: true });
	const page = context.pages()[0] ?? (await context.newPage());
	await page.exposeBinding("phase2e6Relay", (_source, observation: unknown, cellValue: number) => {
		write({ cellValue, kind: "armed", observation, version: 1 });
	});
	await page.goto(url, { waitUntil: "load" });
	if ((await page.evaluate(() => globalThis.crossOriginIsolated)) !== true)
		throw new TypeError("crash page was not cross-origin isolated");
	const forest = captureProcessForest();
	const child = forest.find(({ pid }) => pid === process.pid);
	if (child === undefined) throw new TypeError("crash child identity missing");
	const controller = forest.find(({ pid }) => pid === process.ppid);
	if (controller === undefined) throw new TypeError("crash controller identity missing");
	const authority: Phase2e6RootAuthority = {
		childRoot: child,
		contentProcessClass: "chromium-renderer",
		controllerPgid: controller.pgid,
		executablePath,
		platform: campaignPlatform(),
		profilePath,
		scope: "phase2e6",
	};
	const browserRoot = Reflect.apply(locateBrowserRoot, undefined, [
		forest,
		process.pid,
		profilePath,
		authority,
	]) as ProcessIdentity;
	write({
		browserRoot,
		child,
		crossOriginIsolated: true,
		forest: processClosure(forest, process.pid),
		kind: "ready",
		version: 1,
	});
	void page.evaluate(({ databaseName, edge }) => window.phase2e6RunOne(edge, databaseName), { databaseName, edge });
	return new Promise<never>(() => undefined);
}

void run().catch((error: unknown) => {
	write({ detail: error instanceof Error ? error.message : String(error), kind: "child-error", version: 1 });
	process.exitCode = 1;
});
