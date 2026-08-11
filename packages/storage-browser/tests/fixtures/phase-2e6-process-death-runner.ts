import type { Browser, BrowserType, Page } from "@playwright/test";
import type { ExpectedHead } from "@ts-drp/storage";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import type { AssetServer } from "./asset-server.js";
import { PHASE_2E5_BROWSER_REQUEST_INVENTORY } from "./phase-2e5-browser-request-inventory.js";
import {
	type Phase2e6CaseEvidence,
	type Phase2e6DeclaredEdge,
	phase2e6ExpectedTracePrefix,
} from "./phase-2e6-real-process-death-contract.js";
import {
	captureProcessForest,
	childGroupStoppedForFreeze,
	freezeCurrentOwnedUnion,
	locateBrowserRoot,
	type ProcessCampaignAuthority,
	processClosure,
	type ProcessContentClass,
	type ProcessIdentity,
	type StagedFreezeAuthority,
	validateTwoGroupForest,
} from "./process-forest.js";

export interface ProcessDeathEngine {
	readonly browserType: BrowserType<Browser>;
	readonly contentProcessClass: ProcessContentClass;
	readonly executablePath: string;
	readonly name: "chromium" | "firefox" | "webkit";
}

export interface ProcessDeathRunner {
	runControls(): Promise<Record<string, unknown>>;
	runEdge(
		edge: Phase2e6DeclaredEdge,
		ordinal: number
	): Promise<
		Readonly<{
			caseEvidence: Phase2e6CaseEvidence;
			recoveredHead: ExpectedHead;
		}>
	>;
}

export interface Phase2hNativeAdmissionDependencies {
	arm(): void;
	readonly authority: ProcessCampaignAuthority;
	captureForest(): readonly ProcessIdentity[];
	constructRecord(): void;
	readonly native: Readonly<{ arch: "x64"; platform: "darwin" | "linux" }>;
	publish(): void;
	recover(): void;
	retainCapture(forest: readonly ProcessIdentity[]): void;
	signalGroup(pgid: number): void;
}

/**
 * Retains and validates the complete native-x64 pre-signal forest before any
 * campaign effect. Contradictions are evidence and never become partial runs.
 * @param dependencies - Injected capture, authority and effect boundaries.
 * @returns Completion after an admitted effect sequence.
 */
export function runPhase2hNativeAdmission(dependencies: Phase2hNativeAdmissionDependencies): Promise<void> {
	return Promise.resolve().then(() => {
		const forest = dependencies.captureForest();
		dependencies.retainCapture(forest);
		if (dependencies.native.platform !== dependencies.authority.platform)
			throw new TypeError("HOST_AUTHORITY_CONTRADICTION: captured host disagrees with authority");
		if (dependencies.native.platform !== "linux")
			throw new TypeError("UNSUPPORTED_PLATFORM: Phase 2h process-death requires Linux");
		const controller = forest.filter(({ pid }) => pid === dependencies.authority.childRoot.ppid);
		if (controller.length !== 1 || controller[0]?.pgid !== dependencies.authority.controllerPgid)
			throw new TypeError("FOREST_CONTRADICTION: unique controller identity is absent or mismatched");
		try {
			validateTwoGroupForest(
				forest,
				dependencies.authority.childRoot.pid,
				dependencies.authority.browserRoot.pid,
				dependencies.authority
			);
		} catch (error) {
			throw new TypeError(`FOREST_CONTRADICTION: ${error instanceof Error ? error.message : String(error)}`);
		}
		dependencies.arm();
		dependencies.signalGroup(dependencies.authority.browserRoot.pgid);
		dependencies.signalGroup(dependencies.authority.childRoot.pgid);
		dependencies.recover();
		dependencies.constructRecord();
		dependencies.publish();
	});
}

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

async function waitForProtocol(promise: Promise<void>, detail: string): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new TypeError(`TIMEOUT: ${detail}`)), 20_000);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function sendAdmission(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!child.connected || child.send === undefined) {
			reject(new TypeError("process-death child IPC admission channel is absent"));
			return;
		}
		child.send({ kind: "admit", version: 1 }, (error) => (error === null ? resolve() : reject(error)));
	});
}

function retainNativeAdmissionCapture(
	engine: ProcessDeathEngine["name"],
	forest: unknown,
	ordinal: number
): readonly ProcessIdentity[] {
	if (!Array.isArray(forest)) throw new TypeError("native admission capture forest is not an array");
	const capture = forest as readonly ProcessIdentity[];
	if (ordinal !== 0) return capture;
	const admissionDirectory = process.env.PHASE_2H_NATIVE_ADMISSION_DIR;
	if (admissionDirectory === undefined) throw new TypeError("native admission artifact directory is absent");
	fs.writeFileSync(
		path.join(admissionDirectory, `${engine}.json`),
		`${JSON.stringify(
			{
				arch: process.arch,
				engine,
				forest,
				platform: process.platform,
				processForestCommand: "LC_ALL=C ps -A -ww -o pid=,ppid=,pgid=,lstart=,state=,command=",
			},
			null,
			2
		)}\n`,
		{ encoding: "utf8", flag: "wx" }
	);
	return capture;
}

function exitOf(child: ChildProcess): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
}

function cleanupIdentity(value: unknown): ProcessIdentity | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const identity = value as Partial<ProcessIdentity>;
	return Number.isSafeInteger(identity.pid) &&
		(identity.pid ?? 0) > 0 &&
		Number.isSafeInteger(identity.ppid) &&
		(identity.ppid ?? -1) >= 0 &&
		Number.isSafeInteger(identity.pgid) &&
		(identity.pgid ?? 0) > 0 &&
		typeof identity.birthToken === "string" &&
		identity.birthToken.length > 0 &&
		typeof identity.command === "string" &&
		identity.command.length > 0 &&
		typeof identity.state === "string" &&
		identity.state.length > 0
		? (identity as ProcessIdentity)
		: undefined;
}

function sameCleanupIdentity(observed: ProcessIdentity, expected: ProcessIdentity): boolean {
	return (
		observed.pid === expected.pid &&
		observed.ppid === expected.ppid &&
		observed.pgid === expected.pgid &&
		observed.birthToken === expected.birthToken &&
		observed.command === expected.command
	);
}

export interface StoppedCleanupRevalidation {
	readonly errors: readonly unknown[];
	readonly groups: readonly number[];
}

type CampaignSignal = "SIGKILL" | "SIGSTOP";
type CampaignSignalStage = "browser-stop" | "child-stop";

interface PinnedCampaignSignalDependencies {
	readonly authority: ProcessCampaignAuthority;
	afterSignal?(stage: CampaignSignalStage): Promise<void>;
	captureForest(): readonly ProcessIdentity[];
	signal(target: number, signal: CampaignSignal | "SIGCONT"): void;
}

function samePinnedKernelIdentity(observed: ProcessIdentity, expected: ProcessIdentity): boolean {
	return (
		observed.pid === expected.pid &&
		observed.ppid === expected.ppid &&
		observed.pgid === expected.pgid &&
		observed.birthToken === expected.birthToken
	);
}

function resumeExactStoppedCandidates(
	forest: readonly ProcessIdentity[],
	expected: readonly ProcessIdentity[],
	signal: PinnedCampaignSignalDependencies["signal"]
): void {
	for (const identity of expected) {
		const observed = forest.find(({ pid }) => pid === identity.pid);
		if (observed === undefined || !samePinnedKernelIdentity(observed, identity) || !/T/u.test(observed.state)) continue;
		try {
			signal(observed.pid, "SIGCONT");
		} catch {
			/* Resumption after a rejected stop boundary is best-effort. */
		}
	}
}

function validateControllerAuthority(forest: readonly ProcessIdentity[], authority: ProcessCampaignAuthority): void {
	const controller = forest.filter(({ pid }) => pid === authority.childRoot.ppid);
	if (controller.length !== 1 || controller[0]?.pgid !== authority.controllerPgid)
		throw new TypeError("FOREST_CONTRADICTION: child controller authority changed");
}

function validateLiveChildGroup(
	forest: readonly ProcessIdentity[],
	authority: ProcessCampaignAuthority,
	frozen: readonly ProcessIdentity[]
): void {
	if (new Set(forest.map(({ pid }) => pid)).size !== forest.length)
		throw new TypeError("FOREST_CONTRADICTION: live child forest is ambiguous");
	validateControllerAuthority(forest, authority);
	const expected = frozen.filter(({ pgid }) => pgid === authority.childRoot.pgid);
	const observed = forest.filter(({ pgid }) => pgid === authority.childRoot.pgid);
	if (
		expected.length === 0 ||
		observed.length !== expected.length ||
		!expected.every((identity) => {
			const live = observed.find(({ pid }) => pid === identity.pid);
			return live !== undefined && sameCleanupIdentity(live, identity) && /T|Z/u.test(live.state);
		})
	)
		throw new TypeError("FOREST_CONTRADICTION: live child group authority changed");
}

/**
 * Owns the live child-first stop and browser-first kill sequence. Every
 * negative-PGID effect receives a fresh exact-authority capture.
 * @param dependencies - Pinned authority, capture, signal, and optional live waits.
 * @returns The exact stopped union captured immediately before the first kill.
 */
export async function executePinnedCampaignSignalSequence(
	dependencies: PinnedCampaignSignalDependencies
): Promise<readonly ProcessIdentity[]> {
	const initial = dependencies.captureForest();
	validateControllerAuthority(initial, dependencies.authority);
	const groups = validateTwoGroupForest(
		initial,
		dependencies.authority.childRoot.pid,
		dependencies.authority.browserRoot.pid,
		dependencies.authority
	);
	const authority: StagedFreezeAuthority = { ...dependencies.authority, initialForest: initial };
	let expected: readonly ProcessIdentity[] = initial.filter(
		({ pgid }) => pgid === groups.childPgid || pgid === groups.browserPgid
	);
	let stopAccepted = false;
	let cleanupAttempted = false;

	const rejectCapture = (forest: readonly ProcessIdentity[], error: unknown): never => {
		cleanupAttempted = true;
		resumeExactStoppedCandidates(forest, expected, dependencies.signal);
		throw error;
	};

	try {
		dependencies.signal(-groups.childPgid, "SIGSTOP");
		stopAccepted = true;
		await dependencies.afterSignal?.("child-stop");

		const beforeBrowserStop = dependencies.captureForest();
		try {
			validateControllerAuthority(beforeBrowserStop, dependencies.authority);
			const current = validateTwoGroupForest(
				beforeBrowserStop,
				dependencies.authority.childRoot.pid,
				dependencies.authority.browserRoot.pid,
				dependencies.authority
			);
			if (
				current.childPgid !== groups.childPgid ||
				current.browserPgid !== groups.browserPgid ||
				!childGroupStoppedForFreeze(beforeBrowserStop, authority)
			)
				throw new TypeError("FOREST_CONTRADICTION: child stop authority changed");
		} catch (error) {
			rejectCapture(beforeBrowserStop, error);
		}
		expected = beforeBrowserStop.filter(({ pgid }) => pgid === groups.childPgid || pgid === groups.browserPgid);
		dependencies.signal(-groups.browserPgid, "SIGSTOP");
		await dependencies.afterSignal?.("browser-stop");

		const beforeBrowserKill = dependencies.captureForest();
		let frozen: readonly ProcessIdentity[] | undefined;
		try {
			validateControllerAuthority(beforeBrowserKill, dependencies.authority);
			frozen = freezeCurrentOwnedUnion(beforeBrowserKill, authority);
		} catch (error) {
			return rejectCapture(beforeBrowserKill, error);
		}
		if (frozen === undefined)
			return rejectCapture(beforeBrowserKill, new TypeError("FOREST_CONTRADICTION: stopped union authority changed"));
		expected = frozen;
		dependencies.signal(-groups.browserPgid, "SIGKILL");

		const beforeChildKill = dependencies.captureForest();
		try {
			validateLiveChildGroup(beforeChildKill, dependencies.authority, frozen);
		} catch (error) {
			rejectCapture(beforeChildKill, error);
		}
		dependencies.signal(-groups.childPgid, "SIGKILL");
		return frozen;
	} catch (error) {
		if (stopAccepted && !cleanupAttempted) {
			const forest = dependencies.captureForest();
			resumeExactStoppedCandidates(forest, expected, dependencies.signal);
		}
		throw error;
	}
}

/**
 * Revalidates positive-PID stops before any negative-PGID cleanup signal.
 * A changed identity is best-effort resumed and never becomes group authority.
 * @param candidates - Exact identities targeted by the preceding SIGSTOP calls.
 * @param forest - Complete forest recaptured after those positive-PID signals.
 * @param resume - Best-effort SIGCONT owner for a mismatched signaled PID.
 * @returns Exact still-pinned groups and fail-closed mismatch errors.
 */
export function revalidateStoppedCleanupIdentities(
	candidates: readonly ProcessIdentity[],
	forest: readonly ProcessIdentity[],
	resume: (pid: number) => void
): StoppedCleanupRevalidation {
	const errors: unknown[] = [];
	const groups: number[] = [];
	for (const identity of candidates) {
		const pinned = forest.find(({ pid }) => pid === identity.pid);
		if (pinned !== undefined && sameCleanupIdentity(pinned, identity)) {
			groups.push(identity.pgid);
			continue;
		}
		try {
			resume(identity.pid);
		} catch (error) {
			errors.push(error);
		}
		errors.push(new TypeError(`UNRESOLVED_CLEANUP_GROUP: identity changed for ${identity.pgid}`));
	}
	return Object.freeze({ errors: Object.freeze(errors), groups: Object.freeze(groups) });
}

function groupPresent(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

async function finalizePinnedProcessGroups(
	ready: Record<string, unknown> | undefined,
	child: ChildProcess,
	authority: Readonly<{
		contentProcessClass: ProcessContentClass;
		executablePath: string;
		platform: "linux";
		profilePath: string;
		scope: "phase2h";
	}>
): Promise<void> {
	const readyChild = cleanupIdentity(ready?.child);
	const readyBrowser = cleanupIdentity(ready?.browserRoot);
	const expected = [readyBrowser, readyChild].filter((identity) => identity !== undefined);
	if (expected.length === 0 && child.pid !== undefined) {
		const forest = captureProcessForest();
		const observed = forest.find(({ pid }) => pid === child.pid);
		const controller = forest.find(({ pid }) => pid === process.pid);
		if (observed !== undefined && observed.pgid === child.pid) {
			if (controller !== undefined) {
				try {
					expected.push(
						locateBrowserRoot(forest, observed.pid, authority.profilePath, {
							...authority,
							childRoot: observed,
							controllerPgid: controller.pgid,
						})
					);
				} catch {
					/* Child-side context closure remains the owner when no exact live root exists. */
				}
			}
			expected.push(observed);
		}
	}
	let failure: unknown;
	const candidates: ProcessIdentity[] = [];
	const beforeStop = captureProcessForest();
	for (const identity of expected) {
		const live = beforeStop.find(({ pid }) => pid === identity.pid);
		if (live === undefined || !sameCleanupIdentity(live, identity)) {
			if (groupPresent(identity.pgid))
				failure ??= new TypeError(`UNRESOLVED_CLEANUP_GROUP: stale identity for ${identity.pgid}`);
			continue;
		}
		try {
			process.kill(identity.pid, "SIGSTOP");
			candidates.push(identity);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error;
		}
	}
	const afterStop = captureProcessForest();
	const revalidated = revalidateStoppedCleanupIdentities(candidates, afterStop, (pid) => process.kill(pid, "SIGCONT"));
	for (const error of revalidated.errors) failure ??= error;
	const groups = revalidated.groups;
	for (const pgid of groups) {
		try {
			process.kill(-pgid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error;
		}
	}
	for (const pgid of groups) {
		try {
			await requireGroupAbsent(pgid);
		} catch (error) {
			failure ??= error;
		}
	}
	if (failure !== undefined) throw failure;
}

async function requireGroupAbsent(pgid: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		try {
			process.kill(-pgid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}
		if (Date.now() >= deadline) throw new TypeError(`SURVIVOR_GROUP: ${pgid}`);
		await sleep(20);
	}
}

/**
 * Creates the one engine-parameterized owner for the existing 2e6 and 2h-d
 * POSIX process-death lifecycle.
 * @param input - Exact engine, assets, server and identity authority.
 * @returns Bounded controls and per-edge execution methods.
 */
export function createProcessDeathRunner(
	input: Readonly<{
		assetDirectory: string;
		engine: ProcessDeathEngine;
		identityPrefix: string;
		platform: "linux";
		scope: "phase2h";
		server: AssetServer;
	}>
): ProcessDeathRunner {
	async function inFreshPersistentContext<T>(profile: string, run: (page: Page) => Promise<T>): Promise<T> {
		const transitionURL = input.server.issueTransitionURL("phase-2e6.html");
		const token = required(new URL(transitionURL).pathname.split("/")[2], "fresh transition token");
		const context = await input.engine.browserType.launchPersistentContext(profile, {
			executablePath: input.engine.executablePath,
			headless: true,
		});
		try {
			const page = context.pages()[0] ?? (await context.newPage());
			await page.goto(transitionURL, { waitUntil: "load" });
			await page.waitForFunction(() => typeof window.phase2e6Recover === "function");
			return await run(page);
		} finally {
			await context.close();
			input.server.revoke(token);
		}
	}

	async function recoverEdge(
		profile: string,
		databaseName: string,
		edge: Phase2e6DeclaredEdge,
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
		const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `${input.identityPrefix}-controls-`));
		if (fs.realpathSync(profile) !== profile) throw new TypeError("process-death control profile is not canonical");
		try {
			return await inFreshPersistentContext(profile, async (page) => {
				await page.waitForFunction(() => typeof window.phase2e6RunControls === "function");
				return (await page.evaluate(() => window.phase2e6RunControls())) as Record<string, unknown>;
			});
		} finally {
			fs.rmSync(profile, { force: true, recursive: true });
		}
	}

	async function runEdge(
		edge: Phase2e6DeclaredEdge,
		ordinal: number
	): Promise<Readonly<{ caseEvidence: Phase2e6CaseEvidence; recoveredHead: ExpectedHead }>> {
		const suffix = `${String(ordinal).padStart(2, "0")}-${edge.id.replaceAll("/", "-")}`;
		const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `${input.identityPrefix}-${suffix}-`));
		if (fs.realpathSync(profile) !== profile) throw new TypeError("process-death profile is not canonical");
		const databaseName = `${input.identityPrefix}-${suffix}`;
		const transitionURL = input.server.issueTransitionURL("phase-2e6.html");
		const token = required(new URL(transitionURL).pathname.split("/")[2], "transition token");
		const child = spawn(process.execPath, [path.join(input.assetDirectory, "phase-2e6-crash-child.js")], {
			detached: true,
			env: {
				...process.env,
				PHASE_2E6_DATABASE: databaseName,
				PHASE_2E6_EDGE: JSON.stringify(edge),
				PHASE_2E6_ENGINE: input.engine.name,
				PHASE_2E6_EXECUTABLE_PATH: input.engine.executablePath,
				PHASE_2E6_PROFILE: profile,
				PHASE_2E6_SCOPE: input.scope,
				PHASE_2E6_URL: transitionURL,
			},
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		if (child.stdout === null || child.pid === undefined) throw new TypeError("detached crash child did not launch");
		const exit = exitOf(child);
		let ready: Record<string, unknown> | undefined;
		let armed: Record<string, unknown> | undefined;
		let admissionCapture: readonly ProcessIdentity[] | undefined;
		let armReachCount = 0;
		let captureObserved = false;
		let readyObserved = false;
		let resolveReady!: () => void;
		let rejectReady!: (error: unknown) => void;
		const reachedReady = new Promise<void>((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		let resolveArmed!: () => void;
		let rejectArmed!: (error: unknown) => void;
		const reachedArmed = new Promise<void>((resolve, reject) => {
			resolveArmed = resolve;
			rejectArmed = reject;
		});
		{
			const lines = readline.createInterface({
				input: required(child.stdout ?? undefined, "crash stdout"),
				crlfDelay: Infinity,
			});
			lines.on("line", (line) => {
				try {
					const message = JSON.parse(line) as Record<string, unknown>;
					if (message.kind === "child-error") {
						const error = new TypeError(String(message.detail));
						if (readyObserved) rejectArmed(error);
						else rejectReady(error);
					} else if (message.kind === "capture") {
						if (captureObserved || readyObserved) throw new TypeError("duplicate or late process-death capture");
						captureObserved = true;
						admissionCapture = retainNativeAdmissionCapture(input.engine.name, message.forest, ordinal);
					} else if (message.kind === "ready") {
						if (!captureObserved || readyObserved) throw new TypeError("missing capture or duplicate ready message");
						readyObserved = true;
						ready = message;
						resolveReady();
					} else if (message.kind === "armed") {
						armReachCount += 1;
						armed = message;
						resolveArmed();
					}
				} catch (error) {
					if (readyObserved) rejectArmed(error);
					else rejectReady(error);
				}
			});
		}
		try {
			await waitForProtocol(reachedReady, `${edge.id}: ready`);
			if (ready === undefined) throw new TypeError("closed ready protocol failed");
			const childIdentity = ready.child as ProcessIdentity;
			const browserRoot = ready.browserRoot as ProcessIdentity;
			if (childIdentity.pid !== child.pid || childIdentity.pgid !== child.pid)
				throw new TypeError("child did not lead detached group");
			const admissionForest = required(admissionCapture, "retained native admission forest");
			const admissionClosure = processClosure(admissionForest, childIdentity.pid);
			const controller = admissionForest.find(({ pid }) => pid === process.pid);
			if (controller === undefined) throw new TypeError("controller identity is absent");
			const admissionAuthority: StagedFreezeAuthority = {
				browserRoot,
				childRoot: childIdentity,
				contentProcessClass: input.engine.contentProcessClass,
				controllerPgid: controller.pgid,
				executablePath: input.engine.executablePath,
				initialForest: admissionClosure,
				platform: input.platform,
				profilePath: profile,
				scope: input.scope,
			};
			validateTwoGroupForest(admissionClosure, childIdentity.pid, browserRoot.pid, admissionAuthority);
			await sendAdmission(child);
			await waitForProtocol(reachedArmed, `${edge.id}: armed`);
			if (armed === undefined || armed.cellValue !== 1) throw new TypeError("closed arm protocol failed");
			const observation = armed.observation as Record<string, unknown>;
			if (observation.edgeId !== edge.id) throw new TypeError("armed wrong process-death edge");
			if (JSON.stringify(observation.trace) !== JSON.stringify(phase2e6ExpectedTracePrefix(edge)))
				throw new TypeError("armed trace prefix drifted");
			const all = captureProcessForest();
			const initial = processClosure(all, childIdentity.pid);
			const authority: StagedFreezeAuthority = { ...admissionAuthority, initialForest: initial };
			const groups = validateTwoGroupForest(initial, childIdentity.pid, browserRoot.pid, authority);
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
			const childExit = await exit;
			if (childExit.code !== null || childExit.signal !== "SIGKILL")
				throw new TypeError("crash child was not SIGKILLed");
			await Promise.all([requireGroupAbsent(groups.browserPgid), requireGroupAbsent(groups.childPgid)]);
			input.server.revoke(token);
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
				return {
					birthToken,
					currentBirthToken: found?.birthToken ?? null,
					outcome: found === undefined ? ("absent" as const) : ("reused" as const),
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
			const caseEvidence: Phase2e6CaseEvidence = {
				armReachCount,
				browserExecutable: input.engine.executablePath,
				browserRoot,
				child: childIdentity,
				childExit,
				controllerPgid: controller.pgid,
				databaseName,
				databaseCreateCountAfterSeed,
				databaseDeleteCount,
				databaseIdentityPreserved:
					recovery.databaseIdentityPreserved === true &&
					databaseCreateCountAfterSeed === 0 &&
					databaseDeleteCount === 0,
				edgeId: edge.id,
				expectedState,
				frozenForest,
				head: recovery.head as Phase2e6CaseEvidence["head"],
				initialForest: initial,
				killedGroups: [
					{ absent: true, killAccepted: true, pgid: groups.browserPgid, role: "browser", rootPid: browserRoot.pid },
					{ absent: true, killAccepted: true, pgid: groups.childPgid, role: "child", rootPid: childIdentity.pid },
				],
				operationTransactionCount: Number(observation.transactionCount),
				profilePath: profile,
				reachedRequestedArm: true,
				recordedProcessDeaths: deaths,
				recoveredDatabaseName: String(recovery.recoveredDatabaseName),
				recoveredImage: recovery.recoveredImage as Phase2e6CaseEvidence["recoveredImage"],
				recoveryResult: recovery.recoveryResult as "OK",
				scenarioOperation: row.operation,
				sentinelRetained: recovery.sentinelRetained === true,
				tracePrefix: observation.trace as Phase2e6CaseEvidence["tracePrefix"],
				unsupported: false,
				workerCrossOriginIsolated: observation.crossOriginIsolated === true,
				workerRealm: true,
				writeRequestCount: (observation.trace as readonly { id: string; kind: string }[]).filter(
					({ id, kind }) => kind === "request-success" && /-(?:add|put)-/u.test(id)
				).length,
			};
			return Object.freeze({
				caseEvidence: Object.freeze(caseEvidence),
				recoveredHead: recovery.recoveredHead as ExpectedHead,
			});
		} finally {
			try {
				input.server.revoke(token);
			} catch {
				/* already revoked */
			}
			await finalizePinnedProcessGroups(ready, child, {
				contentProcessClass: input.engine.contentProcessClass,
				executablePath: input.engine.executablePath,
				platform: input.platform,
				profilePath: profile,
				scope: input.scope,
			});
			fs.rmSync(profile, { force: true, recursive: true });
		}
	}

	return Object.freeze({ runControls, runEdge });
}
