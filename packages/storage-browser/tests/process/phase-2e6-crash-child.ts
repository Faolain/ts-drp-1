import { chromium, firefox, webkit } from "@playwright/test";

import type { Phase2e6DeclaredEdge } from "../fixtures/phase-2e6-real-process-death-contract.js";
import {
	captureProcessForest,
	locateBrowserRoot,
	processClosure,
	type ProcessIdentity,
	retainThenLocateBrowserRoot,
} from "../fixtures/process-forest.js";

interface Phase2e6RootAuthority {
	readonly childRoot: ProcessIdentity;
	readonly contentProcessClass: "chromium-renderer" | "firefox-contentproc" | "webkit-webcontent";
	readonly controllerPgid: number;
	readonly executablePath: string;
	readonly platform: "darwin" | "linux";
	readonly profilePath: string;
	readonly scope: "phase2e6" | "phase2h";
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

function waitForAdmission(): Promise<void> {
	if (typeof process.send !== "function") throw new TypeError("process-death child IPC admission channel is absent");
	return new Promise((resolve, reject) => {
		const disconnected = (): void => reject(new TypeError("process-death admission channel disconnected"));
		process.once("disconnect", disconnected);
		process.once("message", (message: unknown) => {
			process.off("disconnect", disconnected);
			if (
				typeof message !== "object" ||
				message === null ||
				Reflect.get(message, "kind") !== "admit" ||
				Reflect.get(message, "version") !== 1
			)
				reject(new TypeError("process-death admission message is not closed"));
			else resolve();
		});
	});
}

async function run(): Promise<never> {
	const executablePath = required("PHASE_2E6_EXECUTABLE_PATH");
	const engine = process.env.PHASE_2E6_ENGINE ?? "chromium";
	if (engine !== "chromium" && engine !== "firefox" && engine !== "webkit")
		throw new TypeError(`unsupported process-death engine ${engine}`);
	const browserType = { chromium, firefox, webkit }[engine];
	const contentProcessClass = {
		chromium: "chromium-renderer",
		firefox: "firefox-contentproc",
		webkit: "webkit-webcontent",
	} as const;
	const scope = process.env.PHASE_2E6_SCOPE === "phase2h" ? "phase2h" : "phase2e6";
	const profilePath = required("PHASE_2E6_PROFILE");
	const databaseName = required("PHASE_2E6_DATABASE");
	const url = required("PHASE_2E6_URL");
	const edge = JSON.parse(required("PHASE_2E6_EDGE")) as Phase2e6DeclaredEdge;
	const context = await browserType.launchPersistentContext(profilePath, { executablePath, headless: true });
	try {
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
			contentProcessClass: contentProcessClass[engine],
			controllerPgid: controller.pgid,
			executablePath,
			platform: campaignPlatform(),
			profilePath,
			scope,
		};
		const retain = (capture: readonly ProcessIdentity[]): void =>
			write({ child, crossOriginIsolated: true, forest: capture, kind: "capture", version: 1 });
		const browserRoot =
			scope === "phase2h"
				? retainThenLocateBrowserRoot(forest, process.pid, profilePath, authority, retain)
				: (Reflect.apply(locateBrowserRoot, undefined, [
						forest,
						process.pid,
						profilePath,
						authority,
					]) as ProcessIdentity);
		const admission = scope === "phase2h" ? waitForAdmission() : Promise.resolve();
		write({
			browserRoot,
			child,
			crossOriginIsolated: true,
			forest: processClosure(forest, process.pid),
			kind: "ready",
			version: 1,
		});
		await admission;
		void page.evaluate(({ databaseName, edge }) => window.phase2e6RunOne(edge, databaseName), { databaseName, edge });
		return await new Promise<never>(() => undefined);
	} catch (error) {
		await context.close();
		throw error;
	}
}

void run().catch((error: unknown) => {
	write({ detail: error instanceof Error ? error.message : String(error), kind: "child-error", version: 1 });
	process.exitCode = 1;
});
