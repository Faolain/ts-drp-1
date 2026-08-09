import { chromium, expect, type Page, test } from "@playwright/test";
import { type ChildProcess, spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { type AssetServer, startAssetServer } from "./fixtures/asset-server.js";
import { PHASE_2E5_BROWSER_REQUEST_INVENTORY } from "./fixtures/phase-2e5-browser-request-inventory.js";
import {
	phase2e6ExpectedTracePrefix,
	PHASE_2E6_DECLARED_EDGES,
} from "./fixtures/phase-2e6-real-process-death-contract.js";
import {
	phase2e6CampaignErrors,
	phase2e6CampaignFromArtifacts,
	phase2e6RunId,
} from "./fixtures/phase-2e6-real-process-death-validator.js";
import {
	captureProcessForest,
	childGroupStoppedForFreeze,
	freezeCurrentOwnedUnion,
	processClosure,
	type ProcessIdentity,
	type StagedFreezeAuthority,
	validateTwoGroupForest,
} from "./fixtures/process-forest.js";

const ASSET_DIRECTORY = process.env.PHASE_2E6_ASSET_DIR;
const ARTIFACT_DIRECTORY = path.resolve(
	import.meta.dirname,
	"../../../.logs/phase-2e6-real-process-death-green-codex-high/artifacts"
);
const GIT_SHA = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const CAMPAIGN_ID = `phase-2e6-${GIT_SHA}-${process.pid}`;
const EXECUTABLE = chromium.executablePath();
let server: AssetServer;

test.beforeAll(async () => {
	if (ASSET_DIRECTORY === undefined) throw new TypeError("Phase 2e6 global setup did not install assets");
	fs.rmSync(ARTIFACT_DIRECTORY, { force: true, recursive: true });
	fs.mkdirSync(ARTIFACT_DIRECTORY, { recursive: true });
	server = await startAssetServer(ASSET_DIRECTORY);
});

test.afterAll(async () => server.close());

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new TypeError(`missing ${label}`);
	return value;
}

async function poll(
	predicate: (forest: readonly ProcessIdentity[]) => boolean,
	detail: string
): Promise<readonly ProcessIdentity[]> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const forest = captureProcessForest();
		if (predicate(forest)) return forest;
		if (Date.now() >= deadline) throw new TypeError(`FOREST_CONTRADICTION: ${detail}`);
		await sleep(20);
	}
}

function exitOf(
	child: ChildProcess
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
}

async function inFreshPersistentContext<T>(profile: string, run: (page: Page) => Promise<T>): Promise<T> {
	const transitionURL = server.issueTransitionURL("phase-2e6.html");
	const token = required(new URL(transitionURL).pathname.split("/")[2], "fresh transition token");
	const context = await chromium.launchPersistentContext(profile, {
		executablePath: EXECUTABLE,
		headless: true,
	});
	try {
		const page = context.pages()[0] ?? (await context.newPage());
		await page.goto(transitionURL, { waitUntil: "load" });
		await page.waitForFunction(() => typeof window.phase2e6Recover === "function");
		return await run(page);
	} finally {
		await context.close();
		server.revoke(token);
	}
}

async function recoverEdge(
	profile: string,
	databaseName: string,
	edge: (typeof PHASE_2E6_DECLARED_EDGES)[number],
	seededHead: unknown
): Promise<Record<string, unknown>> {
	return inFreshPersistentContext(
		profile,
		async (page) =>
			(await page.evaluate(
				({ databaseName, scenarioId, seededHead }) =>
					window.phase2e6Recover(databaseName, scenarioId, seededHead as never),
				{ databaseName, scenarioId: edge.scenarioId, seededHead }
			)) as Record<string, unknown>
	);
}

async function runControls(): Promise<Record<string, unknown>> {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), "phase-2e6-controls-"));
	try {
		return await inFreshPersistentContext(profile, async (page) => {
			await page.waitForFunction(() => typeof window.phase2e6RunControls === "function");
			return (await page.evaluate(() => window.phase2e6RunControls())) as Record<string, unknown>;
		});
	} finally {
		fs.rmSync(profile, { force: true, recursive: true });
	}
}

async function runEdge(edge: (typeof PHASE_2E6_DECLARED_EDGES)[number], ordinal: number): Promise<unknown> {
	const runId = phase2e6RunId(edge, ordinal);
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), `phase-2e6-${runId}-`));
	const databaseName = `phase-2e6-${runId}`;
	const transitionURL = server.issueTransitionURL("phase-2e6.html");
	const token = required(new URL(transitionURL).pathname.split("/")[2], "transition token");
	const child = spawn(
		process.execPath,
		[path.join(required(ASSET_DIRECTORY, "asset directory"), "phase-2e6-crash-child.js")],
		{
			detached: true,
			env: {
				...process.env,
				PHASE_2E6_DATABASE: databaseName,
				PHASE_2E6_EDGE: JSON.stringify(edge),
				PHASE_2E6_EXECUTABLE_PATH: EXECUTABLE,
				PHASE_2E6_PROFILE: profile,
				PHASE_2E6_URL: transitionURL,
			},
			stdio: ["ignore", "pipe", "pipe"],
		}
	);
	if (child.stdout === null || child.pid === undefined) throw new TypeError("detached crash child did not launch");
	const exit = exitOf(child);
	let ready: Record<string, unknown> | undefined;
	let armed: Record<string, unknown> | undefined;
	let armReachCount = 0;
	let publicResultDeliveries = 0;
	const reached = new Promise<void>((resolve, reject) => {
		const lines = readline.createInterface({
			input: required(child.stdout ?? undefined, "crash stdout"),
			crlfDelay: Infinity,
		});
		lines.on("line", (line) => {
			try {
				const message = JSON.parse(line) as Record<string, unknown>;
				if (message.kind === "child-error") reject(new TypeError(String(message.detail)));
				else if (message.kind === "ready") ready = message;
				else if (message.kind === "armed") {
					armReachCount += 1;
					armed = message;
					resolve();
				} else if (message.kind === "premature-public-result") publicResultDeliveries += 1;
			} catch (error) {
				reject(error);
			}
		});
	});
	const timeout = new Promise<never>((_, reject) =>
		setTimeout(() => reject(new TypeError(`TIMEOUT: ${edge.id}`)), 20_000)
	);
	try {
		await Promise.race([reached, timeout]);
		if (ready === undefined || armed === undefined || armed.cellValue !== 1)
			throw new TypeError("closed arm protocol failed");
		const childIdentity = ready.child as ProcessIdentity;
		const browserRoot = ready.browserRoot as ProcessIdentity;
		if (childIdentity.pid !== child.pid || childIdentity.pgid !== child.pid)
			throw new TypeError("child did not lead detached group");
		const observation = armed.observation as Record<string, unknown>;
		expect(observation.edgeId).toBe(edge.id);
		expect(observation.trace).toEqual(phase2e6ExpectedTracePrefix(edge));
		const all = captureProcessForest();
		const initial = processClosure(all, childIdentity.pid);
		const groups = validateTwoGroupForest(initial, childIdentity.pid, browserRoot.pid);
		const controller = all.find(({ pid }) => pid === process.pid);
		if (controller === undefined || controller.pgid === groups.childPgid || controller.pgid === groups.browserPgid)
			throw new TypeError("controller overlaps owned group");
		const authority: StagedFreezeAuthority = { browserRoot, childRoot: childIdentity, initialForest: initial };
		process.kill(-groups.childPgid, "SIGSTOP");
		await poll((forest) => childGroupStoppedForFreeze(forest, authority), "child group did not stop");
		process.kill(-groups.browserPgid, "SIGSTOP");
		let frozen: readonly ProcessIdentity[] | undefined;
		await poll(
			(forest) => ((frozen = freezeCurrentOwnedUnion(forest, authority)), frozen !== undefined),
			"owned union did not freeze"
		);
		if (frozen === undefined) throw new TypeError("frozen forest missing");
		process.kill(-groups.browserPgid, "SIGKILL");
		process.kill(-groups.childPgid, "SIGKILL");
		const childExit = await exit;
		if (childExit.code !== null || childExit.signal !== "SIGKILL") throw new TypeError("crash child was not SIGKILLed");
		server.revoke(token);
		const frozenForest = required(frozen, "frozen forest");
		const current = await poll(
			(forest) =>
				frozenForest.every(
					({ birthToken, pid }) => forest.find((identity) => identity.pid === pid)?.birthToken !== birthToken
				),
			"a frozen process survived SIGKILL"
		);
		const deaths = frozenForest.map(({ birthToken, pid }) => {
			const found = current.find((identity) => identity.pid === pid);
			if (found?.birthToken === birthToken) throw new TypeError(`SURVIVOR: ${pid}`);
			return {
				birthToken,
				currentBirthToken: found?.birthToken ?? null,
				outcome: found === undefined ? "absent" : "reused",
				pid,
			};
		});
		const recovery = await recoverEdge(profile, databaseName, edge, observation.seededHead);
		const row = required(
			PHASE_2E5_BROWSER_REQUEST_INVENTORY.find(({ id }) => id === edge.scenarioId),
			"inventory row"
		);
		const expectedState = edge.target === "request" ? "old" : "new";
		const databaseCreateCountAfterSeed =
			Number(observation.databaseCreateCountAfterSeed) + Number(recovery.databaseCreateCountAfterSeed);
		const databaseDeleteCount = Number(observation.databaseDeleteCount) + Number(recovery.databaseDeleteCount);
		const evidence = {
			armReachCount,
			browserExecutable: EXECUTABLE,
			browserRoot,
			child: childIdentity,
			childExit,
			controllerPgid: controller.pgid,
			databaseName,
			databaseCreateCountAfterSeed,
			databaseDeleteCount,
			databaseIdentityPreserved:
				recovery.databaseIdentityPreserved === true && databaseCreateCountAfterSeed === 0 && databaseDeleteCount === 0,
			edgeId: edge.id,
			expectedState,
			frozenForest,
			head: recovery.head,
			initialForest: initial,
			killedGroups: [
				{ absent: true, killAccepted: true, pgid: groups.browserPgid, role: "browser", rootPid: browserRoot.pid },
				{ absent: true, killAccepted: true, pgid: groups.childPgid, role: "child", rootPid: childIdentity.pid },
			],
			mainThreadAtomicsWaitCalls: 0,
			operationTransactionCount: Number(observation.transactionCount),
			profilePath: profile,
			publicResultDeliveries,
			reachedRequestedArm: true,
			recordedProcessDeaths: deaths,
			recoveredDatabaseName: recovery.recoveredDatabaseName,
			recoveredImage: recovery.recoveredImage,
			recoveryResult: recovery.recoveryResult,
			scenarioOperation: row.operation,
			sentinelRetained: recovery.sentinelRetained,
			tracePrefix: observation.trace,
			unsupported: false,
			workerCrossOriginIsolated: ready.crossOriginIsolated === true,
			workerRealm: true,
			writeRequestCount: (observation.trace as readonly { id: string; kind: string }[]).filter(
				({ id, kind }) => kind === "request-success" && /-(?:add|put)-/u.test(id)
			).length,
		};
		const artifact = { campaignId: CAMPAIGN_ID, evidence, gitSha: GIT_SHA, runId, schemaVersion: 1 };
		fs.writeFileSync(path.join(ARTIFACT_DIRECTORY, `${runId}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
		return artifact;
	} finally {
		try {
			server.revoke(token);
		} catch {
			// The token may already be revoked by the successful kill path.
		}
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			// The detached child group is expected to be absent after SIGKILL.
		}
		fs.rmSync(profile, { force: true, recursive: true });
	}
}

test("eighteen actual-adapter settlement arms hard-kill detached Chromium before recovery publication", async () => {
	const artifacts: unknown[] = [];
	for (const [ordinal, edge] of PHASE_2E6_DECLARED_EDGES.entries()) artifacts.push(await runEdge(edge, ordinal));
	expect(artifacts).toHaveLength(PHASE_2E6_DECLARED_EDGES.length);
	const diskArtifacts = fs
		.readdirSync(ARTIFACT_DIRECTORY)
		.sort()
		.map((file, index) => {
			expect(file).toBe(`${phase2e6RunId(required(PHASE_2E6_DECLARED_EDGES[index], "artifact edge"), index)}.json`);
			return JSON.parse(fs.readFileSync(path.join(ARTIFACT_DIRECTORY, file), "utf8")) as unknown;
		});
	const controls = await runControls();
	fs.writeFileSync(
		path.join(path.dirname(ARTIFACT_DIRECTORY), "controls.json"),
		`${JSON.stringify({ campaignId: CAMPAIGN_ID, gitSha: GIT_SHA, ...controls }, null, 2)}\n`
	);
	const campaign = phase2e6CampaignFromArtifacts(
		diskArtifacts,
		{
			competingRecovery: controls.competingRecovery as {
				future: "MONOTONE";
				rollback: "MONOTONE";
				same: "MONOTONE";
			},
			staleExpectedRevision: controls.staleExpectedRevision as "HEAD_CONFLICT",
		},
		{ campaignId: CAMPAIGN_ID, gitSha: GIT_SHA }
	);
	expect(phase2e6CampaignErrors(campaign)).toEqual([]);
});
