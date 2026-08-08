import { chromium, expect, test } from "@playwright/test";
import { type ChildProcess, fork, spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { type KillHit, type KillPoint, orderedKillPoints } from "../src/killpoints.js";
import type {
	ArmingPassArtifact,
	BrowserIdentity,
	DiscoveryPassArtifact,
	FailureArtifact,
	ParentFailureCode,
	PartialFailureEvidence,
	PassArtifact,
	RunStage,
	SettledChildEvidence,
	TuplePassArtifact,
} from "./fixtures/artifacts.js";
import { aggregatePassArtifacts, classifyRunFailure } from "./fixtures/artifacts.js";
import { type AssetServer, startAssetServer } from "./fixtures/asset-server.js";
import {
	classifyParentRecords,
	EXPECTED_NEW_DIGEST,
	EXPECTED_OLD_DIGEST,
	FIXTURE_OBJECT_ID,
	fixtureRecordsDigest,
	seedFixtureRecords,
	transitionFixtureRecords,
} from "./fixtures/fixture-records.js";
import { expectedFixtureState, expectedHitDurability } from "./fixtures/inert-campaign.js";
import {
	captureProcessForest,
	processClosure,
	type ProcessIdentity,
	validateTwoGroupForest,
} from "./fixtures/process-forest.js";
import { finalizeFailedRun } from "./fixtures/run-finalizer.js";
import { ownershipFromSettledFailure, SettledRunFailure } from "./fixtures/settled-failure-ownership.js";
import {
	captureSettledRunOwnership,
	disposeProfileWhenAllowed,
	profileDispositionFor,
} from "./fixtures/settled-run-lifecycle.js";
import { parseWorkerToPageMessage } from "./fixtures/worker-protocol.js";

const ASSET_DIRECTORY_VALUE = process.env.PHASE_2B_ASSET_DIR;
const ASSET_DIRECTORY: string =
	ASSET_DIRECTORY_VALUE ?? path.join(os.tmpdir(), "phase-2b-list-only-assets-unavailable");
const ARTIFACT_DIRECTORY =
	process.env.PHASE_2B_ARTIFACT_DIR ?? path.join(os.tmpdir(), "phase-2b-list-only-artifacts-unavailable");
const GIT_SHA = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const chromiumExecutablePath = chromium.executablePath();
const PLATFORM = process.platform;
if (PLATFORM !== "darwin" && PLATFORM !== "linux")
	throw new TypeError("UNSUPPORTED_PLATFORM: POSIX process groups required");
const SUPPORTED_PLATFORM: "darwin" | "linux" = PLATFORM;

let server: AssetServer;

test.beforeAll(async () => {
	if (process.env.PHASE_2B_ASSET_DIR === undefined) {
		throw new TypeError("PHASE_2B_ASSET_DIR was not installed by global setup");
	}
	if (process.env.PHASE_2B_ARTIFACT_DIR === undefined) {
		throw new TypeError("PHASE_2B_ARTIFACT_DIR was not installed by global setup");
	}
	fs.mkdirSync(ARTIFACT_DIRECTORY, { recursive: true });
	server = await startAssetServer(ASSET_DIRECTORY);
	const oldDigest = fixtureRecordsDigest(
		classifyParentRecords(seedFixtureRecords().map((record) => ({ ...record, bytes: Array.from(record.bytes) })))
			.records
	);
	const newDigest = fixtureRecordsDigest(
		classifyParentRecords(transitionFixtureRecords().map((record) => ({ ...record, bytes: Array.from(record.bytes) })))
			.records
	);
	if (oldDigest !== EXPECTED_OLD_DIGEST || newDigest !== EXPECTED_NEW_DIGEST) {
		throw new TypeError("checked-in fixture diagnostics did not independently recompute");
	}
});

test.afterAll(async () => {
	await server.close();
});

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, detail: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new TypeError(`TIMEOUT: ${detail}`)), milliseconds);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

function exactIdentity(value: unknown): ProcessIdentity {
	if (typeof value !== "object" || value === null) throw new TypeError("CHILD_PROTOCOL: process identity missing");
	const keys = Object.keys(value).sort().join("\u0000");
	if (keys !== "birthToken\u0000command\u0000pgid\u0000pid\u0000ppid\u0000state") {
		throw new TypeError("CHILD_PROTOCOL: process identity fields are not closed");
	}
	const candidate = value as Record<string, unknown>;
	if (
		![candidate.pid, candidate.ppid, candidate.pgid].every((item) => Number.isSafeInteger(item) && Number(item) > 0) ||
		typeof candidate.birthToken !== "string" ||
		candidate.birthToken.length === 0 ||
		typeof candidate.command !== "string" ||
		candidate.command.length === 0 ||
		typeof candidate.state !== "string" ||
		candidate.state.length === 0
	) {
		throw new TypeError("CHILD_PROTOCOL: malformed process identity");
	}
	return Object.freeze(candidate) as unknown as ProcessIdentity;
}

function exactForest(value: unknown): readonly ProcessIdentity[] {
	if (!Array.isArray(value)) throw new TypeError("CHILD_PROTOCOL: forest is not an array");
	const identities = value.map(exactIdentity);
	const unique = new Set(identities.map((identity) => `${identity.pid}:${identity.birthToken}`));
	if (unique.size !== identities.length) throw new TypeError("FOREST_CONTRADICTION: ambiguous transported identity");
	return Object.freeze(identities);
}

function exactBrowser(value: unknown): BrowserIdentity {
	if (typeof value !== "object" || value === null) throw new TypeError("CHILD_PROTOCOL: browser identity missing");
	if (Object.keys(value).sort().join("\u0000") !== "executablePath\u0000name\u0000version") {
		throw new TypeError("CHILD_PROTOCOL: browser identity fields are not closed");
	}
	const candidate = value as Record<string, unknown>;
	if (
		candidate.name !== "chromium" ||
		typeof candidate.version !== "string" ||
		candidate.version.length === 0 ||
		typeof candidate.executablePath !== "string" ||
		candidate.executablePath.length === 0
	) {
		throw new TypeError("CHILD_PROTOCOL: malformed browser identity");
	}
	return Object.freeze(candidate) as unknown as BrowserIdentity;
}

function exitOf(
	child: ChildProcess
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve(Object.freeze({ code, signal })));
	});
}

function sameRecordedProcessesPresent(recorded: readonly ProcessIdentity[]): boolean {
	const current = captureProcessForest();
	return recorded.some((identity) => {
		const found = current.find((candidate) => candidate.pid === identity.pid);
		return found !== undefined && found.birthToken === identity.birthToken;
	});
}

async function requireRecordedProcessesAbsent(recorded: readonly ProcessIdentity[], bound = 10_000): Promise<void> {
	const deadline = Date.now() + bound;
	while (sameRecordedProcessesPresent(recorded)) {
		if (Date.now() >= deadline) throw new TypeError("SURVIVOR: a recorded process remained alive");
		await sleep(20);
	}
}

interface SettledResult {
	readonly evidence: SettledChildEvidence;
	readonly result: unknown;
	readonly browser: BrowserIdentity;
	readonly relayed: readonly unknown[];
}

async function runSettled(
	role: "seed" | "discovery" | "arming" | "recovery",
	profilePath: string,
	databaseName: string
): Promise<SettledResult> {
	const entry = path.join(ASSET_DIRECTORY, role === "arming" ? "arming-child.js" : "settled-child.js");
	const child = fork(entry, [], {
		detached: true,
		env: {
			...process.env,
			PHASE_2B_EXECUTABLE_PATH: chromiumExecutablePath,
			PHASE_2B_ROLE: role,
			PHASE_2B_PROFILE: profilePath,
			PHASE_2B_DATABASE: databaseName,
			PHASE_2B_URL:
				role === "seed"
					? `${server.baseURL}/seed.html`
					: role === "recovery"
						? `${server.baseURL}/oracle.html`
						: `${server.baseURL}/index.html`,
		},
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	const resultPromise = new Promise<unknown>((resolve, reject) => {
		child.on("message", (message: unknown) => {
			if (typeof message !== "object" || message === null) {
				reject(new TypeError("CHILD_PROTOCOL: settled child emitted a non-object"));
				return;
			}
			const candidate = message as Record<string, unknown>;
			if (candidate.kind === "child-error") reject(new TypeError(`SETUP_FAILED: ${String(candidate.detail)}`));
			else if (candidate.kind === "settled-result") resolve(message);
			else reject(new TypeError("CHILD_PROTOCOL: unknown settled child message"));
		});
	});
	let trustedChildIdentity: ProcessIdentity | undefined;
	try {
		const [untrusted, exit] = await Promise.all([
			withTimeout(resultPromise, 20_000, `${role} result`),
			withTimeout(exitOf(child), 20_000, `${role} exit`),
		]);
		if (exit.code !== 0 || exit.signal !== null) {
			throw new TypeError(`WRONG_EXIT: settled ${role} code=${String(exit.code)} signal=${String(exit.signal)}`);
		}
		const candidate = untrusted as Record<string, unknown>;
		if (candidate.version !== 1 || candidate.role !== role)
			throw new TypeError("CHILD_PROTOCOL: settled role mismatch");
		const childIdentity = exactIdentity(candidate.child);
		const browserRoot = exactIdentity(candidate.browserRoot);
		const forest = exactForest(candidate.forest);
		const browser = exactBrowser(candidate.browser);
		if (child.pid !== childIdentity.pid || childIdentity.pgid !== childIdentity.pid) {
			throw new TypeError("FOREST_CONTRADICTION: settled child did not lead its group");
		}
		trustedChildIdentity = childIdentity;
		validateTwoGroupForest(forest, childIdentity.pid, browserRoot.pid);
		await requireRecordedProcessesAbsent(forest);
		return Object.freeze({
			result: candidate.result,
			browser,
			relayed: Object.freeze(Array.isArray(candidate.relayed) ? [...candidate.relayed] : []),
			evidence: Object.freeze({
				role,
				child: Object.freeze({ ...childIdentity, exitCode: 0, exitSignal: null }),
				browserRoot,
				ownedGroups: Object.freeze([
					Object.freeze({
						role: "child" as const,
						pgid: childIdentity.pgid,
						rootPid: childIdentity.pid,
						absent: true as const,
					}),
					Object.freeze({
						role: "browser" as const,
						pgid: browserRoot.pgid,
						rootPid: browserRoot.pid,
						absent: true as const,
					}),
				]),
				recordedForest: forest,
				allRecordedProcessesAbsent: true,
			}),
		});
	} catch (error) {
		const childPid = child.pid ?? -1;
		const controllerPid = process.pid;
		const failureOwnership = captureSettledRunOwnership(captureProcessForest, {
			childPid,
			chromiumExecutablePath: chromiumExecutablePath,
			controllerPid,
			profilePath,
			...(trustedChildIdentity === undefined ? {} : { trustedChildIdentity }),
		});
		throw new SettledRunFailure(error, failureOwnership);
	}
}

function baseArtifact<K extends "tuple" | "discovery" | "arming">(
	runKind: K,
	runId: string,
	profilePath: string,
	databaseName: string,
	browser: BrowserIdentity
): Readonly<{
	schemaVersion: 1;
	runKind: K;
	runId: string;
	gitSha: string;
	platform: "darwin" | "linux";
	browser: BrowserIdentity;
	profilePath: string;
	databaseName: string;
	objectId: typeof FIXTURE_OBJECT_ID;
	expectedDigests: Readonly<{ old: typeof EXPECTED_OLD_DIGEST; new: typeof EXPECTED_NEW_DIGEST }>;
}> {
	return Object.freeze({
		schemaVersion: 1 as const,
		runKind,
		runId,
		gitSha: GIT_SHA,
		platform: SUPPORTED_PLATFORM,
		browser,
		profilePath,
		databaseName,
		objectId: FIXTURE_OBJECT_ID,
		expectedDigests: Object.freeze({ old: EXPECTED_OLD_DIGEST, new: EXPECTED_NEW_DIGEST }),
	});
}

function writeArtifact(artifact: PassArtifact | FailureArtifact): void {
	fs.writeFileSync(
		path.join(ARTIFACT_DIRECTORY, `${artifact.runId}.json`),
		`${JSON.stringify(artifact, null, 2)}\n`,
		"utf8"
	);
}

function failureFallback(stage: RunStage): ParentFailureCode {
	if (stage === "setup" || stage === "seed") return "SETUP_FAILED";
	if (stage === "ready" || stage === "hit") return "CHILD_PROTOCOL";
	if (stage === "recovery") return "RECOVERY_INVALID";
	return "FOREST_CONTRADICTION";
}

function killValidatedGroup(pgid: number): void {
	try {
		process.kill(-pgid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

function parseHitRelay(value: unknown): { readonly hit: KillHit; readonly cellValue: number } {
	if (typeof value !== "object" || value === null) throw new TypeError("CHILD_PROTOCOL: crash relay missing");
	const candidate = value as Record<string, unknown>;
	if (candidate.kind !== "hit" || candidate.version !== 1 || !Number.isInteger(candidate.cellValue)) {
		throw new TypeError("CHILD_PROTOCOL: malformed crash hit relay");
	}
	const message = parseWorkerToPageMessage(candidate.message);
	if (message === undefined || message.kind !== "hit")
		throw new TypeError("CHILD_PROTOCOL: invalid relayed Worker hit");
	return Object.freeze({
		hit: Object.freeze({ id: message.id, edge: message.edge, transactionDurability: message.transactionDurability }),
		cellValue: candidate.cellValue as number,
	});
}

async function pollForest(
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

function groupAbsent(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

async function requireGroupsAbsent(pgids: readonly number[]): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!pgids.every(groupAbsent)) {
		if (Date.now() >= deadline) throw new TypeError("SURVIVOR: a killed process group still exists");
		await sleep(20);
	}
}

function sameUnion(
	forest: readonly ProcessIdentity[],
	recorded: readonly ProcessIdentity[]
): readonly ProcessIdentity[] | undefined {
	const byPid = new Map(forest.map((identity) => [identity.pid, identity]));
	const current = recorded.map((identity) => byPid.get(identity.pid));
	if (current.some((identity, index) => identity?.birthToken !== recorded[index]?.birthToken)) return undefined;
	return current as readonly ProcessIdentity[];
}

async function runTuple(point: KillPoint, ordinal: number): Promise<TuplePassArtifact> {
	const runId = `tuple-${String(ordinal).padStart(2, "0")}-${point.id}-${point.edge}`;
	const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), `${runId}-profile-`));
	const databaseName = `phase-2b-${runId}-${path.basename(profilePath)}`;
	let token = "";
	let stage: RunStage = "setup";
	let artifactWritten = false;
	let profileDisposition: ReturnType<typeof profileDispositionFor> = "retain";
	let ownedGroups: readonly number[] = [];
	let validatedGroups: readonly number[] = [];
	let crashProcess: ChildProcess | undefined;
	let trustedCrashChildIdentity: ProcessIdentity | undefined;
	const hits: KillHit[] = [];
	const settledChildren: SettledChildEvidence[] = [];
	let recordedForestEvidence: readonly ProcessIdentity[] | undefined;
	let recoveryClassification: PartialFailureEvidence["recoveryClassification"];
	let browserForFailure: BrowserIdentity = Object.freeze({
		name: "chromium",
		version: "unreached",
		executablePath: path.join(ASSET_DIRECTORY, "chromium-unreached"),
	});
	const writeOnce = (artifact: PassArtifact | FailureArtifact): void => {
		if (artifactWritten) throw new TypeError("ARTIFACT_SCHEMA: run attempted to write more than one artifact");
		writeArtifact(artifact);
		artifactWritten = true;
	};
	try {
		stage = "seed";
		const seed = await runSettled("seed", profilePath, databaseName);
		settledChildren.push(seed.evidence);
		browserForFailure = seed.browser;
		if ((seed.result as Record<string, unknown>).transactionDurability !== "strict") {
			throw new TypeError("DURABILITY_PROVENANCE: seed was not strict");
		}
		const transitionURL = server.issueTransitionURL();
		token = new URL(transitionURL).pathname.split("/")[2] ?? "";
		const crash = spawn(process.execPath, [path.join(ASSET_DIRECTORY, "crash-child.js")], {
			detached: true,
			env: {
				...process.env,
				PHASE_2B_EXECUTABLE_PATH: chromiumExecutablePath,
				PHASE_2B_PROFILE: profilePath,
				PHASE_2B_DATABASE: databaseName,
				PHASE_2B_URL: transitionURL,
				PHASE_2B_ARMED: JSON.stringify(point),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		crashProcess = crash;
		if (crash.stdout === null) throw new TypeError("SETUP_FAILED: crash stdout unavailable");
		const lines = readline.createInterface({ input: crash.stdout, crlfDelay: Infinity });
		let ready: Record<string, unknown> | undefined;
		let terminalCell: number | undefined;
		const reached = new Promise<void>((resolve, reject) => {
			lines.on("line", (line) => {
				let message: unknown;
				try {
					message = JSON.parse(line) as unknown;
				} catch {
					reject(new TypeError("CHILD_PROTOCOL: crash child emitted non-JSON line"));
					return;
				}
				if (typeof message !== "object" || message === null) {
					reject(new TypeError("CHILD_PROTOCOL: crash child emitted non-object"));
					return;
				}
				const candidate = message as Record<string, unknown>;
				if (candidate.kind === "ready") {
					try {
						if (ready !== undefined) throw new TypeError("CHILD_PROTOCOL: duplicate crash ready");
						const childIdentity = exactIdentity(candidate.child);
						if (crash.pid === undefined || childIdentity.pid !== crash.pid || childIdentity.pgid !== crash.pid) {
							throw new TypeError("FOREST_CONTRADICTION: crash child did not lead its detached group");
						}
						trustedCrashChildIdentity = childIdentity;
						ready = candidate;
					} catch (error) {
						reject(error);
					}
					return;
				}
				if (candidate.kind === "child-error") {
					reject(new TypeError(`CHILD_PROTOCOL: ${String(candidate.detail)}`));
					return;
				}
				try {
					const relay = parseHitRelay(candidate);
					hits.push(relay.hit);
					if (relay.hit.id === point.id && relay.hit.edge === point.edge) {
						terminalCell = relay.cellValue;
						resolve();
					}
				} catch (error) {
					reject(error);
				}
			});
		});
		stage = "ready";
		await withTimeout(reached, 20_000, `armed hit ${point.id}/${point.edge}`);
		stage = "hit";
		if (ready === undefined || crash.pid === undefined)
			throw new TypeError("CHILD_PROTOCOL: hit preceded ready identity");
		const childIdentity = trustedCrashChildIdentity;
		if (childIdentity === undefined) throw new TypeError("CHILD_PROTOCOL: ready child identity was not retained");
		const browserRoot = exactIdentity(ready.browserRoot);
		ownedGroups = Object.freeze([...new Set([crash.pid, browserRoot.pgid])]);
		browserForFailure = exactBrowser(ready.browser);
		if (ready.crossOriginIsolated !== true) {
			throw new TypeError("CHILD_PROTOCOL: crash child did not relay literal cross-origin isolation");
		}
		if (childIdentity.pid !== crash.pid || childIdentity.pgid !== crash.pid) {
			throw new TypeError("FOREST_CONTRADICTION: crash child did not lead its detached group");
		}
		if (!browserRoot.command.includes(browserForFailure.executablePath) || !browserRoot.command.includes(profilePath)) {
			throw new TypeError(
				`FOREST_CONTRADICTION: browser root identity mismatch executable=${browserForFailure.executablePath} command=${browserRoot.command}`
			);
		}
		const expectedPrefix = orderedKillPoints().slice(0, ordinal + 1);
		expect(hits.map(({ id, edge }) => ({ id, edge }))).toEqual(expectedPrefix);
		expect(hits.map(({ transactionDurability }) => transactionDurability)).toEqual(
			expectedPrefix.map(expectedHitDurability)
		);
		if (terminalCell !== 1) throw new TypeError("CHILD_PROTOCOL: armed cell was not observed at one");

		stage = "freeze";
		const initialAll = captureProcessForest();
		const initial = processClosure(initialAll, childIdentity.pid);
		const groups = validateTwoGroupForest(initial, childIdentity.pid, browserRoot.pid);
		if (groups.childPgid !== childIdentity.pid || groups.browserPgid !== browserRoot.pid) {
			throw new TypeError("FOREST_CONTRADICTION: roots did not lead the two groups");
		}
		const parent = initialAll.find((identity) => identity.pid === process.pid);
		if (parent === undefined || parent.pgid === groups.childPgid || parent.pgid === groups.browserPgid) {
			throw new TypeError("FOREST_CONTRADICTION: owned groups overlap the parent");
		}
		validatedGroups = Object.freeze([groups.browserPgid, groups.childPgid]);
		process.kill(-groups.childPgid, "SIGSTOP");
		await pollForest((forest) => {
			const union = sameUnion(forest, initial);
			return (
				union !== undefined &&
				union.filter((identity) => identity.pgid === groups.childPgid).every((identity) => /T|Z/u.test(identity.state))
			);
		}, "child group did not stop with stable identities");
		process.kill(-groups.browserPgid, "SIGSTOP");
		const stoppedAll = await pollForest((forest) => {
			const union = sameUnion(forest, initial);
			return union !== undefined && union.every((identity) => /T|Z/u.test(identity.state));
		}, "owned union did not stop with stable identities");
		const recordedForest = sameUnion(stoppedAll, initial);
		if (recordedForest === undefined) throw new TypeError("FOREST_CONTRADICTION: stopped union changed identity");
		recordedForestEvidence = Object.freeze(recordedForest);
		stage = "kill";
		process.kill(-groups.browserPgid, "SIGKILL");
		process.kill(-groups.childPgid, "SIGKILL");
		const exit = await withTimeout(exitOf(crash), 10_000, "crash child SIGKILL exit");
		if (exit.code !== null || exit.signal !== "SIGKILL") {
			throw new TypeError(`WRONG_EXIT: crash child code=${String(exit.code)} signal=${String(exit.signal)}`);
		}
		await requireGroupsAbsent(validatedGroups);
		const deathForest = captureProcessForest();
		const recordedProcessDeaths = recordedForest.map((identity) => {
			const current = deathForest.find((candidate) => candidate.pid === identity.pid);
			if (current !== undefined && current.birthToken === identity.birthToken) {
				throw new TypeError(`SURVIVOR: pid ${identity.pid} retained its birth token`);
			}
			return Object.freeze({
				pid: identity.pid,
				birthToken: identity.birthToken,
				outcome: current === undefined ? ("absent" as const) : ("reused" as const),
				currentBirthToken: current?.birthToken ?? null,
			});
		});
		server.revoke(token);
		token = "";
		stage = "recovery";
		const recovery = await runSettled("recovery", profilePath, databaseName);
		settledChildren.push(recovery.evidence);
		const classification = classifyParentRecords(recovery.result as readonly unknown[]);
		recoveryClassification = Object.freeze({ state: classification.state, digest: classification.digest });
		if (classification.mixed)
			throw new TypeError("RECOVERY_MIXED: recovered image was neither exact old nor exact new");
		const expectedState = expectedFixtureState(point);
		if (classification.state !== expectedState) {
			throw new TypeError(`EXPECTED_STATE_MISMATCH: expected ${expectedState}, recovered ${classification.state}`);
		}
		const expectedDurability = expectedHitDurability(point);
		const observedDurability = hits.at(-1)?.transactionDurability;
		if (observedDurability !== expectedDurability) throw new TypeError("DURABILITY_PROVENANCE: terminal hit mismatch");
		if (classification.state !== "old" && classification.state !== "new") {
			throw new TypeError("RECOVERY_MIXED: recovered classification was mixed");
		}
		const artifact: TuplePassArtifact = Object.freeze({
			...baseArtifact("tuple", runId, profilePath, databaseName, browserForFailure),
			verdict: "pass",
			armedPoint: Object.freeze({ ...point }),
			expectedRecoveredState: expectedState,
			recoveredState: classification.state,
			mixed: false,
			expectedTransactionDurability: expectedDurability,
			observedTransactionDurability: observedDurability,
			recoveredFixtureRecordsDigest: classification.digest,
			observedHits: Object.freeze([...hits]),
			armedCellValue: 1,
			crossOriginIsolated: true,
			child: Object.freeze({ ...childIdentity, exitCode: null, exitSignal: "SIGKILL" }),
			browserRoot,
			killedGroups: Object.freeze([
				Object.freeze({
					role: "browser" as const,
					pgid: groups.browserPgid,
					rootPid: browserRoot.pid,
					stopAccepted: true as const,
					killAccepted: true as const,
					absent: true as const,
				}),
				Object.freeze({
					role: "child" as const,
					pgid: groups.childPgid,
					rootPid: childIdentity.pid,
					stopAccepted: true as const,
					killAccepted: true as const,
					absent: true as const,
				}),
			]),
			recordedForest: Object.freeze(recordedForest),
			recordedProcessDeaths: Object.freeze(recordedProcessDeaths),
			settledChildren: Object.freeze([seed.evidence, recovery.evidence] as const),
		});
		writeOnce(artifact);
		profileDisposition = profileDispositionFor({ kind: "pass" });
		return artifact;
	} catch (error) {
		const failureOwnership = ownershipFromSettledFailure(error);
		const localOwnership = captureSettledRunOwnership(captureProcessForest, {
			childPid: crashProcess?.pid ?? -1,
			chromiumExecutablePath: chromiumExecutablePath,
			controllerPid: process.pid,
			profilePath,
			priorOwnershipEvidenceState: failureOwnership.evidenceState,
			...(trustedCrashChildIdentity === undefined ? {} : { trustedChildIdentity: trustedCrashChildIdentity }),
		});
		ownedGroups = Object.freeze([
			...new Set([...ownedGroups, ...failureOwnership.ownedGroups, ...localOwnership.ownedGroups]),
		]);
		validatedGroups = Object.freeze([
			...new Set([...validatedGroups, ...failureOwnership.validatedGroups, ...localOwnership.validatedGroups]),
		]);
		const reachedForest = new Map<string, ProcessIdentity>();
		for (const identity of [
			...(recordedForestEvidence ?? []),
			...failureOwnership.recordedForest,
			...localOwnership.recordedForest,
		]) {
			reachedForest.set(`${identity.pid}:${identity.birthToken}`, identity);
		}
		if (reachedForest.size !== 0) recordedForestEvidence = Object.freeze([...reachedForest.values()]);
		if (token !== "") {
			try {
				server.revoke(token);
			} catch {
				// The causal run failure remains primary; the token is already unusable outside this server instance.
			}
		}
		const classified = classifyRunFailure(error, failureFallback(stage));
		const partialEvidence: Omit<PartialFailureEvidence, "cleanup"> = Object.freeze({
			...(settledChildren.length === 0 ? {} : { settledChildren: Object.freeze([...settledChildren]) }),
			...(hits.length === 0 ? {} : { observedHits: Object.freeze([...hits]) }),
			...(recordedForestEvidence === undefined ? {} : { recordedForest: recordedForestEvidence }),
			...(recoveryClassification === undefined ? {} : { recoveryClassification }),
		});
		const finalization = finalizeFailedRun(
			{
				base: baseArtifact("tuple", runId, profilePath, databaseName, browserForFailure),
				stage,
				code: classified.code,
				detail: classified.detail,
				partialEvidence,
				ownedGroups,
				validatedGroups,
			},
			{
				writeArtifact: (artifact): void => writeOnce(artifact),
				killValidatedGroup,
			}
		);
		profileDisposition = profileDispositionFor({
			kind: "failed-finalized",
			finalization,
			ownershipEvidenceState: localOwnership.evidenceState,
		});
		throw error;
	} finally {
		disposeProfileWhenAllowed(profilePath, profileDisposition, (disposableProfilePath) =>
			fs.rmSync(disposableProfilePath, { recursive: true, force: true })
		);
	}
}

function exactHits(value: unknown): readonly KillHit[] {
	if (!Array.isArray(value)) throw new TypeError("CHILD_PROTOCOL: hits are not an array");
	return Object.freeze(
		value.map((candidate) => {
			const parsed = parseWorkerToPageMessage({ kind: "hit", version: 1, ...(candidate as object) });
			if (parsed === undefined || parsed.kind !== "hit") throw new TypeError("CHILD_PROTOCOL: malformed settled hit");
			return Object.freeze({ id: parsed.id, edge: parsed.edge, transactionDurability: parsed.transactionDurability });
		})
	);
}

async function runControl(runKind: "discovery" | "arming"): Promise<DiscoveryPassArtifact | ArmingPassArtifact> {
	const runId = runKind;
	const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), `phase-2b-${runId}-profile-`));
	const databaseName = `phase-2b-${runId}-${path.basename(profilePath)}`;
	let stage: RunStage = "setup";
	let artifactWritten = false;
	let profileDisposition: ReturnType<typeof profileDispositionFor> = "retain";
	const settledChildren: SettledChildEvidence[] = [];
	let observedHits: readonly KillHit[] = [];
	let recoveryClassification: PartialFailureEvidence["recoveryClassification"];
	let browserForFailure: BrowserIdentity = Object.freeze({
		name: "chromium",
		version: "unreached",
		executablePath: path.join(ASSET_DIRECTORY, "chromium-unreached"),
	});
	const writeOnce = (artifact: PassArtifact | FailureArtifact): void => {
		if (artifactWritten) throw new TypeError("ARTIFACT_SCHEMA: run attempted to write more than one artifact");
		writeArtifact(artifact);
		artifactWritten = true;
	};
	try {
		stage = "seed";
		const seed = await runSettled("seed", profilePath, databaseName);
		settledChildren.push(seed.evidence);
		browserForFailure = seed.browser;
		stage = "hit";
		const control = await runSettled(runKind, profilePath, databaseName);
		settledChildren.push(control.evidence);
		browserForFailure = control.browser;
		stage = "recovery";
		const recovery = await runSettled("recovery", profilePath, databaseName);
		settledChildren.push(recovery.evidence);
		const classification = classifyParentRecords(recovery.result as readonly unknown[]);
		recoveryClassification = Object.freeze({ state: classification.state, digest: classification.digest });
		if (classification.state !== "new" || classification.mixed || classification.digest !== EXPECTED_NEW_DIGEST) {
			throw new TypeError("RECOVERY_INVALID: completed control did not recover exact new image");
		}
		const result = control.result as Record<string, unknown>;
		const complete = result.complete as Record<string, unknown>;
		const hits = exactHits(result.hits);
		observedHits = hits;
		if (result.crossOriginIsolated !== true) {
			throw new TypeError("CHILD_PROTOCOL: control did not relay literal cross-origin isolation");
		}
		const expected = orderedKillPoints();
		expect(hits.map(({ id, edge }) => ({ id, edge }))).toEqual(expected);
		expect(hits.map(({ transactionDurability }) => transactionDurability)).toEqual(expected.map(expectedHitDurability));
		if (complete.transactionDurability !== "strict")
			throw new TypeError("DURABILITY_PROVENANCE: complete was not strict");
		const completeHits = exactHits(complete.observed);
		expect(completeHits).toEqual(hits);
		const common = {
			...baseArtifact(runKind, runId, profilePath, databaseName, control.browser),
			verdict: "pass" as const,
			recoveredState: "new" as const,
			mixed: false as const,
			recoveredFixtureRecordsDigest: EXPECTED_NEW_DIGEST as typeof EXPECTED_NEW_DIGEST,
			observedHits: hits,
			completeObservedPairs: Object.freeze(completeHits.map(({ id, edge }) => Object.freeze({ id, edge }))),
			completeTransactionDurability: "strict" as const,
			crossOriginIsolated: true as const,
		};
		if (runKind === "discovery") {
			if (result.finalCellValue !== 0) throw new TypeError("CHILD_PROTOCOL: discovery cell did not remain zero");
			const artifact: DiscoveryPassArtifact = Object.freeze({
				...common,
				runKind: "discovery",
				armedPoint: null,
				finalCellValue: 0,
				settledChildren: Object.freeze([seed.evidence, control.evidence, recovery.evidence] as const),
			});
			writeOnce(artifact);
			profileDisposition = profileDispositionFor({ kind: "pass" });
			return artifact;
		}
		const preResume = exactHits(result.preResumeHits);
		const prefix = expected.slice(0, 9);
		expect(preResume.map(({ id, edge }) => ({ id, edge }))).toEqual(prefix);
		if (result.notifyWoken !== 1 || result.finalCellValue !== 2) {
			throw new TypeError("CHILD_PROTOCOL: arming waiter proof was incomplete");
		}
		if (control.relayed.length !== expected.length) {
			throw new TypeError("CHILD_PROTOCOL: arming relay acknowledgements incomplete");
		}
		const terminalRelay = control.relayed[prefix.length - 1] as Record<string, unknown> | undefined;
		if (terminalRelay?.cellValue !== 1)
			throw new TypeError("CHILD_PROTOCOL: arming terminal relay did not observe cell one");
		const artifact: ArmingPassArtifact = Object.freeze({
			...common,
			runKind: "arming",
			armedPoint: Object.freeze({ id: "left-write", edge: "before" }),
			preResumeObservedHits: preResume,
			armedHitTransactionDurability: "strict",
			notifyWoken: 1,
			finalCellValue: 2,
			settledChildren: Object.freeze([seed.evidence, control.evidence, recovery.evidence] as const),
		});
		writeOnce(artifact);
		profileDisposition = profileDispositionFor({ kind: "pass" });
		return artifact;
	} catch (error) {
		const failureOwnership = ownershipFromSettledFailure(error);
		const classified = classifyRunFailure(error, failureFallback(stage));
		const partialEvidence: Omit<PartialFailureEvidence, "cleanup"> = Object.freeze({
			...(settledChildren.length === 0 ? {} : { settledChildren: Object.freeze([...settledChildren]) }),
			...(observedHits.length === 0 ? {} : { observedHits }),
			...(failureOwnership.recordedForest.length === 0 ? {} : { recordedForest: failureOwnership.recordedForest }),
			...(recoveryClassification === undefined ? {} : { recoveryClassification }),
		});
		const finalization = finalizeFailedRun(
			{
				base: baseArtifact(runKind, runId, profilePath, databaseName, browserForFailure),
				stage,
				code: classified.code,
				detail: classified.detail,
				partialEvidence,
				ownedGroups: failureOwnership.ownedGroups,
				validatedGroups: failureOwnership.validatedGroups,
			},
			{
				writeArtifact: (artifact): void => writeOnce(artifact),
				killValidatedGroup,
			}
		);
		profileDisposition = profileDispositionFor({
			kind: "failed-finalized",
			finalization,
			ownershipEvidenceState: failureOwnership.evidenceState,
		});
		throw error;
	} finally {
		disposeProfileWhenAllowed(profilePath, profileDisposition, (disposableProfilePath) =>
			fs.rmSync(disposableProfilePath, { recursive: true, force: true })
		);
	}
}

function aggregate(artifacts: readonly PassArtifact[]): void {
	expect(artifacts).toHaveLength(16);
	expect(new Set(artifacts.map((artifact) => artifact.runId)).size).toBe(16);
	const tuples = artifacts.filter((artifact): artifact is TuplePassArtifact => artifact.runKind === "tuple");
	const discovery = artifacts.filter((artifact): artifact is DiscoveryPassArtifact => artifact.runKind === "discovery");
	const arming = artifacts.filter((artifact): artifact is ArmingPassArtifact => artifact.runKind === "arming");
	expect(tuples).toHaveLength(14);
	expect(discovery).toHaveLength(1);
	expect(arming).toHaveLength(1);
	const expectedKeys = new Set(orderedKillPoints().map((point) => `${point.id}/${point.edge}`));
	const actualKeys = new Set(tuples.map((artifact) => `${artifact.armedPoint.id}/${artifact.armedPoint.edge}`));
	const missingKillPoints = [...expectedKeys].filter((key) => !actualKeys.has(key));
	expect(missingKillPoints).toEqual([]);
	expect(actualKeys.size).toBe(14);
	expect(tuples.filter((artifact) => artifact.recoveredState === "old")).toHaveLength(13);
	expect(tuples.filter((artifact) => artifact.recoveredState === "new")).toHaveLength(1);
	expect(tuples.filter((artifact) => artifact.observedTransactionDurability === "not-reached")).toHaveLength(3);
	expect(tuples.filter((artifact) => artifact.observedTransactionDurability === "strict")).toHaveLength(11);
	expect(tuples.every((artifact) => artifact.mixed === false && artifact.armedCellValue === 1)).toBe(true);
	expect(discovery[0]).toMatchObject({
		recoveredState: "new",
		finalCellValue: 0,
		completeTransactionDurability: "strict",
	});
	expect(arming[0]).toMatchObject({
		recoveredState: "new",
		notifyWoken: 1,
		finalCellValue: 2,
		completeTransactionDurability: "strict",
	});
	const diskFiles = fs.readdirSync(ARTIFACT_DIRECTORY).filter((file) => file.endsWith(".json"));
	expect(diskFiles).toHaveLength(16);
	const diskArtifacts = diskFiles.map(
		(file) => JSON.parse(fs.readFileSync(path.join(ARTIFACT_DIRECTORY, file), "utf8")) as unknown
	);
	expect(aggregatePassArtifacts(diskArtifacts)).toEqual({
		artifactCount: 16,
		tupleCount: 14,
		discoveryCount: 1,
		armingCount: 1,
		old: 13,
		new: 1,
		mixed: 0,
		notReachedDurability: 3,
		strictDurability: 11,
		missingKillPoints: [],
	});
}

test("sixteen isolated runs prove strict two-record atomic recovery after measured browser process death", async () => {
	const artifacts: PassArtifact[] = [];
	for (const [ordinal, point] of orderedKillPoints().entries()) artifacts.push(await runTuple(point, ordinal));
	artifacts.push(await runControl("discovery"));
	artifacts.push(await runControl("arming"));
	aggregate(artifacts);
});
