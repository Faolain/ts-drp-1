import { chromium, expect, type Page, test } from "@playwright/test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { type AssetServer, startAssetServer } from "./fixtures/asset-server.js";
import { type Phase2lBDeathTuple, PHASE_2L_B_DEATH_TUPLES } from "./fixtures/phase-2l-b-browser-issuance-contract.js";
import { captureProcessForest, processClosure, type ProcessIdentity } from "./fixtures/process-forest.js";

const EXECUTABLE = chromium.executablePath();
let server: AssetServer;

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new TypeError(`missing ${label}`);
	return value;
}

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

function exitOf(child: ChildProcess): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
}

async function pollAbsent(frozen: readonly ProcessIdentity[]): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const current = captureProcessForest();
		if (frozen.every(({ birthToken, pid }) => current.find((row) => row.pid === pid)?.birthToken !== birthToken))
			return;
		if (Date.now() >= deadline) throw new TypeError("a frozen Phase 2l-b process survived SIGKILL");
		await sleep(20);
	}
}

async function inFreshContext<T>(profile: string, run: (page: Page) => Promise<T>): Promise<T> {
	const url = server.issueTransitionURL("phase-2l-b-death.html");
	const token = required(new URL(url).pathname.split("/")[2], "transition token");
	const context = await chromium.launchPersistentContext(profile, { executablePath: EXECUTABLE, headless: true });
	try {
		const page = context.pages()[0] ?? (await context.newPage());
		await page.goto(url, { waitUntil: "load" });
		await page.waitForFunction(() => typeof window.phase2e6Recover === "function");
		return await run(page);
	} finally {
		await context.close();
		server.revoke(token);
	}
}

async function runTuple(edge: Phase2lBDeathTuple, ordinal: number): Promise<unknown> {
	const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `phase-2l-b-${ordinal}-`));
	const primaryDatabaseName = `phase-2l-b-death-${ordinal}-${Date.now()}`;
	const url = server.issueTransitionURL("phase-2l-b-death.html");
	const token = required(new URL(url).pathname.split("/")[2], "death transition token");
	const assetDirectory = required(process.env.PHASE_2L_B_ASSET_DIR, "asset directory");
	const child = spawn(process.execPath, [path.join(assetDirectory, "phase-2l-b-crash-child.js")], {
		detached: true,
		env: {
			...process.env,
			PHASE_2L_B_EDGE: JSON.stringify(edge),
			PHASE_2L_B_EXECUTABLE: EXECUTABLE,
			PHASE_2L_B_PRIMARY: primaryDatabaseName,
			PHASE_2L_B_PROFILE: profile,
			PHASE_2L_B_URL: url,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (child.stdout === null || child.pid === undefined) throw new TypeError("death child did not launch");
	const exit = exitOf(child);
	let ready: Record<string, unknown> | undefined;
	let armed: Record<string, unknown> | undefined;
	let armCount = 0;
	const reached = new Promise<void>((resolve, reject) => {
		const lines = readline.createInterface({
			input: required(child.stdout ?? undefined, "child stdout"),
			crlfDelay: Infinity,
		});
		lines.on("line", (line) => {
			try {
				const message = JSON.parse(line) as Record<string, unknown>;
				if (message.kind === "child-error") reject(new TypeError(String(message.detail)));
				else if (message.kind === "ready") ready = message;
				else if (message.kind === "armed") {
					armCount++;
					armed = message;
					resolve();
				}
			} catch (error) {
				reject(error);
			}
		});
	});
	try {
		await Promise.race([
			reached,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new TypeError(`death arm timeout: ${edge.id}`)), 20_000)
			),
		]);
		if (armed?.cellValue !== 1) {
			return { armCount, armed, candidateAvailable: false };
		}
		const childIdentity = required(ready?.child as ProcessIdentity | undefined, "child identity");
		const browserRoot = required(ready?.browserRoot as ProcessIdentity | undefined, "browser identity");
		const initial = captureProcessForest();
		const controller = required(
			initial.find(({ pid }) => pid === process.pid),
			"controller identity"
		);
		if (childIdentity.pid !== child.pid || childIdentity.pgid !== child.pid)
			throw new TypeError("death child did not lead its detached group");
		if (browserRoot.pid !== browserRoot.pgid || browserRoot.ppid !== childIdentity.pid)
			throw new TypeError("browser root did not lead the second owned group");
		if (controller.pgid === childIdentity.pgid || controller.pgid === browserRoot.pgid)
			throw new TypeError("controller overlaps a death-owned process group");
		const frozen = [...processClosure(initial, childIdentity.pid), ...processClosure(initial, browserRoot.pid)].filter(
			({ pid }, index, rows) => pid !== process.pid && rows.findIndex((row) => row.pid === pid) === index
		);
		process.kill(-childIdentity.pgid, "SIGKILL");
		process.kill(-browserRoot.pgid, "SIGKILL");
		const childExit = await exit;
		expect(childExit.signal).toBe("SIGKILL");
		await pollAbsent(frozen);
		const recovery = await inFreshContext(profile, (page) =>
			page.evaluate(({ primaryDatabaseName, scenarioId }) => window.phase2lBRecover(primaryDatabaseName, scenarioId), {
				primaryDatabaseName,
				scenarioId: edge.id,
			})
		);
		return { armCount, armed, candidateAvailable: true, childExit, frozenCount: frozen.length, recovery };
	} finally {
		server.revoke(token);
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			// Expected after a successful detached-group kill.
		}
		fs.rmSync(profile, { force: true, recursive: true });
	}
}

test.beforeAll(async () => {
	const assetDirectory = process.env.PHASE_2L_B_ASSET_DIR;
	if (assetDirectory === undefined) throw new TypeError("Phase 2l-b global setup did not install assets");
	server = await startAssetServer(assetDirectory);
});

test.afterAll(async () => server.close());

test("all 16 literal issuance edges hard-kill detached Chromium and reopen old XOR exact-new", async () => {
	const evidence: Array<Record<string, unknown>> = [];
	for (const [ordinal, edge] of PHASE_2L_B_DEATH_TUPLES.entries()) {
		let row: Record<string, unknown>;
		try {
			row = (await runTuple(edge, ordinal)) as Record<string, unknown>;
		} catch (error) {
			row = { runError: error instanceof Error ? error.message : String(error) };
		}
		expect(row).toMatchObject({ armCount: 1, candidateAvailable: true });
		expect(row.frozenCount).toBeGreaterThan(1);
		expect(row.armed).toMatchObject({ cellValue: 1, observation: { edgeId: edge.id } });
		const recovery = row.recovery as { exactNew: boolean; old: boolean };
		expect(Number(recovery.old) + Number(recovery.exactNew)).toBe(1);
		if (edge.terminalFate === "old") expect(recovery.old).toBe(true);
		if (edge.terminalFate === "exact-new") expect(recovery.exactNew).toBe(true);
		evidence.push(row);
	}
	expect(evidence).toHaveLength(16);
});
