import { chromium, expect, type Page, test } from "@playwright/test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { executePinnedCampaignSignalSequence } from "./fixtures/phase-2e6-process-death-runner.js";
import {
	captureProcessForest,
	childGroupStoppedForFreeze,
	freezeCurrentOwnedUnion,
	processClosure,
	type ProcessIdentity,
	type StagedFreezeAuthority,
	validateTwoGroupForest,
} from "./fixtures/process-forest.js";
import {
	assertExactDeathRegistry,
	expectedPhase3a1bP2Snapshot,
	type Phase3a1bP2BrowserDeathTuple,
	PHASE_3A1B_P2_BROWSER_DEATH_TUPLES,
	PHASE_3A1B_P2_METHODS,
} from "../../../tests/fixtures/phase-3a1b-p2-outbox-publication-contract.js";

const EXECUTABLE = chromium.executablePath();
let assetServer: http.Server;
let baseURL: string;

function assertBrowserTrace(
	trace: readonly Record<string, unknown>[],
	expectedPuts: number,
	databaseName: string
): void {
	const transactions = trace.filter(({ kind }) => kind === "transaction");
	expect(transactions).toEqual([
		{
			databaseName: `${databaseName}--drp-issuance-v1`,
			durability: "strict",
			id: "transaction-1",
			kind: "transaction",
			mode: "readwrite",
			stores: ["issuanceOutbox", "issuedRecords", "lineages"],
		},
		{
			databaseName: `${databaseName}--drp-issuance-v1`,
			durability: "strict",
			id: "transaction-2",
			kind: "transaction",
			mode: "readonly",
			stores: ["issuanceOutbox", "issuedRecords", "lineages"],
		},
	]);
	expect(trace.filter(({ kind }) => kind === "get").map(({ store }) => store)).toEqual([
		"lineages",
		"issuedRecords",
		"issuanceOutbox",
		"lineages",
		"issuedRecords",
		"issuanceOutbox",
	]);
	expect(trace.filter(({ kind }) => kind === "get").map(({ key }) => key)).toEqual([
		["room:publication", "alice"],
		["room:publication", "alice", 0],
		["room:publication", "alice", 0],
		["room:publication", "alice"],
		["room:publication", "alice", 0],
		["room:publication", "alice", 0],
	]);
	expect(trace.filter(({ kind }) => kind === "put")).toHaveLength(expectedPuts);
	for (const put of trace.filter(({ kind }) => kind === "put")) {
		expect(put).toMatchObject({
			key: ["room:publication", "alice", 0],
			publishState: "published",
			store: "issuanceOutbox",
			value: {
				author: "alice",
				authorSequence: 0,
				digest: [41, 209],
				objectId: "room:publication",
				publishState: "published",
			},
		});
	}
	expect(trace.filter(({ kind }) => kind === "complete").map(({ id }) => id)).toEqual([
		"transaction-1",
		"transaction-2",
	]);
}

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new TypeError(`missing ${label}`);
	return value;
}

function closeServer(server: http.Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function serveAssets(directory: string): Promise<Readonly<{ server: http.Server; url: string }>> {
	const root = fs.realpathSync(directory);
	const server = http.createServer((request, response) => {
		const name = path.basename(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
		if (!["phase-3a1b-p2.html", "phase-3a1b-p2-entry.js", "phase-3a1b-p2-worker.js"].includes(name)) {
			response.writeHead(404).end();
			return;
		}
		const candidate = path.join(root, name);
		fs.readFile(candidate, (error, bytes) => {
			if (error) return void response.writeHead(404).end();
			response.writeHead(200, {
				"Cache-Control": "no-store",
				"Content-Type": name.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
				"Cross-Origin-Embedder-Policy": "require-corp",
				"Cross-Origin-Opener-Policy": "same-origin",
			});
			response.end(bytes);
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") return reject(new TypeError("asset server did not bind"));
			resolve({ server, url: `http://127.0.0.1:${address.port}/phase-3a1b-p2.html` });
		});
	});
}

function exitOf(child: ChildProcess): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
}

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

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

function platform(): StagedFreezeAuthority["platform"] {
	if (process.platform !== "darwin" && process.platform !== "linux") {
		throw new TypeError(`unsupported Seam 2 platform ${process.platform}`);
	}
	return process.platform;
}

async function inFreshContext<T>(profile: string, run: (page: Page) => Promise<T>): Promise<T> {
	const context = await chromium.launchPersistentContext(profile, { executablePath: EXECUTABLE, headless: true });
	try {
		const page = context.pages()[0] ?? (await context.newPage());
		await page.goto(baseURL, { waitUntil: "load" });
		await page.waitForFunction(() => typeof window.phase3a1bP2Recover === "function");
		return await run(page);
	} finally {
		await context.close();
	}
}

async function runTuple(tuple: Phase3a1bP2BrowserDeathTuple, ordinal: number): Promise<Record<string, unknown>> {
	const assetDirectory = required(process.env.PHASE_3A1B_P2_BROWSER_ASSET_DIR, "asset directory");
	const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `phase-3a1b-p2-${ordinal}-`));
	const primaryDatabaseName = `phase-3a1b-p2-${ordinal}-${Date.now()}`;
	const child = spawn(process.execPath, [path.join(assetDirectory, "phase-3a1b-p2-crash-child.js")], {
		detached: true,
		env: {
			...process.env,
			PHASE_3A1B_P2_EXECUTABLE: EXECUTABLE,
			PHASE_3A1B_P2_PRIMARY: primaryDatabaseName,
			PHASE_3A1B_P2_PROFILE: profile,
			PHASE_3A1B_P2_TUPLE: JSON.stringify(tuple),
			PHASE_3A1B_P2_URL: baseURL,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (child.stdout === null || child.pid === undefined) throw new TypeError("Seam 2 death child did not launch");
	const exited = exitOf(child);
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
				setTimeout(() => reject(new TypeError(`death arm timeout ${tuple.id}`)), 25_000)
			),
		]);
		expect(armed?.cellValue).toBe(1);
		const childIdentity = required(ready?.child as ProcessIdentity | undefined, "child identity");
		const browserRoot = required(ready?.browserRoot as ProcessIdentity | undefined, "browser identity");
		const controller = required(
			captureProcessForest().find(({ pid }) => pid === process.pid),
			"controller identity"
		);
		const authority: StagedFreezeAuthority = {
			browserRoot,
			childRoot: childIdentity,
			contentProcessClass: "chromium-renderer",
			controllerPgid: controller.pgid,
			executablePath: EXECUTABLE,
			initialForest: processClosure(captureProcessForest(), childIdentity.pid),
			platform: platform(),
			profilePath: profile,
			scope: "phase2e6",
		};
		validateTwoGroupForest(authority.initialForest, childIdentity.pid, browserRoot.pid, authority);
		const frozen = await executePinnedCampaignSignalSequence({
			afterSignal: async (stage) => {
				if (stage === "child-stop") {
					await poll((forest) => childGroupStoppedForFreeze(forest, authority), "child group did not stop");
				} else {
					await poll(
						(forest) => freezeCurrentOwnedUnion(forest, authority) !== undefined,
						"owned union did not freeze"
					);
				}
			},
			authority,
			captureForest: captureProcessForest,
			signal: (target, signal) => process.kill(target, signal),
		});
		const childExit = await exited;
		expect(childExit.signal).toBe("SIGKILL");
		await poll(
			(forest) =>
				frozen.every(({ birthToken, pid }) => forest.find((row) => row.pid === pid)?.birthToken !== birthToken),
			"frozen process survived SIGKILL"
		);
		const recovery = await inFreshContext(profile, (page) =>
			page.evaluate(({ databaseName, includeOther }) => window.phase3a1bP2Recover(databaseName, includeOther), {
				databaseName: primaryDatabaseName,
				includeOther: tuple.scenario !== "single-row",
			})
		);
		return { armCount, armed, frozenCount: frozen.length, recovery };
	} finally {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			// Expected after the owned process groups are gone.
		}
		fs.rmSync(profile, { force: true, recursive: true });
	}
}

test.beforeAll(async () => {
	assertExactDeathRegistry();
	const assets = await serveAssets(required(process.env.PHASE_3A1B_P2_BROWSER_ASSET_DIR, "asset directory"));
	assetServer = assets.server;
	baseURL = assets.url;
});

test.afterAll(async () => closeServer(assetServer));

test("uses the exact null-prototype six-method facade and converges concurrent same-database marks", async ({
	page,
}) => {
	await page.goto(baseURL, { waitUntil: "load" });
	await page.waitForFunction(() => typeof window.phase3a1bP2Control === "function");
	const databaseName = `control-${Date.now()}`;
	const value = (await page.evaluate((databaseName) => window.phase3a1bP2Control(databaseName), databaseName)) as {
		absent: { readonly code: string };
		closed: { readonly code: string };
		corruption: { readonly code: string };
		corruptionIdentity: boolean;
		crossTrace: readonly Record<string, unknown>[];
		firstKeys: readonly string[];
		firstPrototypeIsNull: boolean;
		firstTrace: readonly Record<string, unknown>[];
		foreign: { readonly code: string };
		reopenTrace: readonly Record<string, unknown>[];
		repeatTrace: readonly Record<string, unknown>[];
		snapshot: { readonly outbox: readonly { readonly publishState: string }[] };
	};
	expect(value.firstKeys).toEqual(PHASE_3A1B_P2_METHODS);
	expect(value.firstPrototypeIsNull).toBe(true);
	expect(value.absent.code).toBe("ISSUANCE_INVALID_ARGUMENT");
	expect(value.foreign.code).toBe("ISSUANCE_INVALID_ARGUMENT");
	expect(value.closed.code).toBe("ISSUANCE_STORE_CLOSED");
	expect(value.corruption.code).toBe("ISSUANCE_RECOVERY_CORRUPT");
	expect(value.corruptionIdentity).toBe(true);
	expect(value.snapshot.outbox.map(({ publishState }) => publishState)).toEqual(["published", "published"]);
	assertBrowserTrace(value.firstTrace, 1, databaseName);
	assertBrowserTrace(value.repeatTrace, 0, databaseName);
	assertBrowserTrace(value.reopenTrace, 0, databaseName);
	const crossTransactions = value.crossTrace.filter(({ kind }) => kind === "transaction");
	expect(crossTransactions).toHaveLength(4);
	expect(crossTransactions.map(({ mode }) => mode).sort()).toEqual(["readonly", "readonly", "readwrite", "readwrite"]);
	for (const transaction of crossTransactions) {
		expect(transaction).toMatchObject({
			databaseName: `${databaseName}--drp-issuance-v1`,
			durability: "strict",
			stores: ["issuanceOutbox", "issuedRecords", "lineages"],
		});
	}
	const crossPuts = value.crossTrace.filter(({ kind }) => kind === "put");
	expect(crossPuts.length).toBeGreaterThanOrEqual(1);
	expect(crossPuts.length).toBeLessThanOrEqual(2);
	for (const put of crossPuts) {
		expect(put).toMatchObject({
			key: ["room:unaddressed", "bob", 0],
			publishState: "published",
			store: "issuanceOutbox",
			value: {
				author: "bob",
				authorSequence: 0,
				digest: [41, 209],
				objectId: "room:unaddressed",
				publishState: "published",
			},
		});
	}
	expect(new Set(crossPuts.map(({ value }) => JSON.stringify(value))).size).toBe(1);
});

test("hard-kills exact fourteen IndexedDB boundaries and reopens deterministic local publication state", async () => {
	const evidence: Record<string, unknown>[] = [];
	for (const [ordinal, tuple] of PHASE_3A1B_P2_BROWSER_DEATH_TUPLES.entries()) {
		const row = await runTuple(tuple, ordinal);
		expect(row).toMatchObject({ armCount: 1 });
		expect(row.frozenCount).toBeGreaterThan(1);
		const armedTrace =
			(
				row.armed as
					| {
							readonly observation?: { readonly trace?: readonly Record<string, unknown>[] };
					  }
					| undefined
			)?.observation?.trace ?? [];
		for (const event of armedTrace.filter(({ kind }) => kind === "transaction-created")) {
			expect(event.databaseName, tuple.id).toContain("--drp-issuance-v1");
			expect(event.durability, tuple.id).toBe("strict");
			expect(event.stores, tuple.id).toEqual(["issuanceOutbox", "issuedRecords", "lineages"]);
		}
		expect(armedTrace.filter(({ kind }) => kind === "transaction-created").length, tuple.id).toBeLessThanOrEqual(2);
		const recovery = row.recovery as {
			counts: readonly number[];
			keys: readonly string[];
			prototypeIsNull: boolean;
			snapshot: unknown;
		};
		expect(recovery.keys).toEqual(PHASE_3A1B_P2_METHODS);
		expect(recovery.prototypeIsNull).toBe(true);
		const expectedCount = tuple.scenario === "single-row" ? 1 : 2;
		expect(recovery.counts, tuple.id).toEqual([expectedCount, expectedCount, expectedCount]);
		expect(recovery.snapshot, tuple.id).toEqual(expectedPhase3a1bP2Snapshot(tuple.scenario, tuple.terminalFate));
		evidence.push(row);
	}
	expect(evidence).toHaveLength(14);
});
