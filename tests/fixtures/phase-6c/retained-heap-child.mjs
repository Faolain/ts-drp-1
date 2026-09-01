/* eslint-disable @typescript-eslint/explicit-function-return-type -- Fresh-process test launcher. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { workspacePackageImportHook } from "../shared/workspace-package-subprocess.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const ROLE = process.argv[2] ?? "parent";
const D110AT_PROFILE_FILENAME = "d110at-main.cpuprofile";

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function built(relative) {
	const path = resolve(REPOSITORY_ROOT, relative);
	if (!existsSync(path) || readFileSync(path).byteLength === 0) {
		throw new TypeError(`D110A_BUILT_TARGET_MISSING:${relative}`);
	}
	return path;
}

function expectedImports() {
	return Object.freeze({
		"@ts-drp/blueprint-catalog": built("packages/blueprint-catalog/dist/src/index.js"),
		"@ts-drp/canonical": built("packages/canonical/dist/src/index.js"),
		"@ts-drp/compaction": built("packages/compaction/dist/src/index.js"),
		"@ts-drp/control-plane": built("packages/control-plane/dist/src/index.js"),
		"@ts-drp/issuance-store": built("packages/issuance-store/dist/src/index.js"),
		"@ts-drp/issuance-store/maintenance": built("packages/issuance-store/dist/src/maintenance.js"),
		"@ts-drp/keychain/finality": built("packages/keychain/dist/src/finality.js"),
		"@ts-drp/live-journal": built("packages/live-journal/dist/src/index.js"),
		"@ts-drp/message-queue": built("packages/message-queue/dist/src/index.js"),
		"@ts-drp/node/creator-adoption": built("packages/node/dist/src/creator-adoption.js"),
		"@ts-drp/node/creator-adoption-activate": built("packages/node/dist/src/creator-adoption-activate.js"),
		"@ts-drp/node/creator-adoption-commit": built("packages/node/dist/src/creator-adoption-commit.js"),
		"@ts-drp/node/creator-close": built("packages/node/dist/src/creator-close.js"),
		"@ts-drp/node/v3-live": built("packages/node/dist/src/v3-live.js"),
		"@ts-drp/protocol-v3": built("packages/protocol-v3/dist/src/public.js"),
		"@ts-drp/storage": built("packages/storage/dist/src/index.js"),
		"@ts-drp/storage/maintenance": built("packages/storage/dist/src/maintenance.js"),
		"@ts-drp/storage/snapshot-transfer": built("packages/storage/dist/src/snapshot-transfer.js"),
		"@ts-drp/storage-browser/seal-evidence": built("packages/storage-browser/dist/src/seal-evidence.js"),
		"@ts-drp/storage-browser/seal-vote": built("packages/storage-browser/dist/src/seal-vote.js"),
		"@ts-drp/storage-browser/snapshot-transfer": built("packages/storage-browser/dist/src/snapshot-transfer.js"),
		"@ts-drp/storage-node": built("packages/storage-node/dist/src/index.js"),
		"@ts-drp/storage-node/issuance": built("packages/storage-node/dist/src/issuance.js"),
		"@ts-drp/storage-node/issuance-maintenance": built("packages/storage-node/dist/src/issuance-maintenance.js"),
		"@ts-drp/storage-node/live-journal": built("packages/storage-node/dist/src/live-journal.js"),
		"@ts-drp/storage-node/maintenance": built("packages/storage-node/dist/src/maintenance.js"),
		"@ts-drp/types": built("packages/types/dist/src/index.js"),
	});
}

function internalModules() {
	return Object.freeze({
		aheMaintenance: pathToFileURL(built("packages/storage-node/dist/src/maintenance.js")).href,
		closedEpochCleanup: pathToFileURL(built("packages/node/dist/src/internal/closed-epoch-cleanup.js")).href,
		runtimeReclamation: pathToFileURL(built("packages/node/dist/src/internal/runtime-reclamation.js")).href,
	});
}

function freshProfileTarget(mode) {
	if (mode !== "profile") return undefined;
	const evidenceRoot = resolve(REPOSITORY_ROOT, ".logs/phase-6c-d110at-green");
	mkdirSync(evidenceRoot, { recursive: true });
	const directory = mkdtempSync(join(evidenceRoot, "profile-"));
	if (readdirSync(directory).length !== 0) throw new TypeError("D110AT_PROFILE_DIRECTORY_NOT_EMPTY");
	return Object.freeze({ directory, path: join(directory, D110AT_PROFILE_FILENAME) });
}

function childEnvironment(mode) {
	if (mode !== "profile") return process.env;
	const environment = { ...process.env };
	delete environment.NODE_OPTIONS;
	return environment;
}

function profileAttribution(profile, result) {
	if (
		!Number.isFinite(profile?.startTime) ||
		!Number.isFinite(profile?.endTime) ||
		profile.endTime <= profile.startTime ||
		profile.endTime - profile.startTime > 900_000 * 1_000 ||
		!Array.isArray(profile.nodes) ||
		!Array.isArray(profile.samples) ||
		!Array.isArray(profile.timeDeltas) ||
		profile.samples.length !== profile.timeDeltas.length
	) {
		throw new TypeError("D110AT_PROFILE_SCHEMA_INVALID");
	}
	const phase = (name) => result.phases.find((entry) => entry.phase === name)?.monotonicMicroseconds;
	const workloadStart = phase("fixture-open");
	const workloadEnd = phase("workload-complete");
	if (
		!Number.isFinite(workloadStart) ||
		!Number.isFinite(workloadEnd) ||
		profile.startTime > workloadStart ||
		workloadStart >= workloadEnd ||
		workloadEnd > profile.endTime
	) {
		throw new TypeError("D110AT_PROFILE_WINDOW_INVALID");
	}
	const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
	const parents = new Map();
	for (const node of profile.nodes) {
		for (const childId of node.children ?? []) parents.set(childId, node.id);
	}
	const hasWorkerFrame = (nodeId) => {
		const visited = new Set();
		for (let current = nodeId; current !== undefined && !visited.has(current); current = parents.get(current)) {
			visited.add(current);
			if (String(nodes.get(current)?.callFrame?.url ?? "").includes("retained-heap-worker.ts")) return true;
		}
		return false;
	};
	if (![...nodes.values()].some((node) => String(node.callFrame?.url ?? "").includes("retained-heap-worker.ts"))) {
		throw new TypeError("D110AT_PROFILE_WORKER_FRAME_MISSING");
	}
	const owners = new Map();
	let timestamp = profile.startTime;
	let workloadSamples = 0;
	let workerAncestrySamples = 0;
	let attributedMicroseconds = 0;
	for (const [index, nodeId] of profile.samples.entries()) {
		const delta = profile.timeDeltas[index];
		if (!Number.isFinite(delta) || delta < 0) throw new TypeError("D110AT_PROFILE_DELTA_INVALID");
		timestamp += delta;
		if (timestamp < workloadStart || timestamp > workloadEnd) continue;
		workloadSamples += 1;
		attributedMicroseconds += delta;
		if (hasWorkerFrame(nodeId)) workerAncestrySamples += 1;
		const frame = nodes.get(nodeId)?.callFrame;
		const owner = String(frame?.url || `[runtime] ${frame?.functionName || "anonymous"}`);
		owners.set(owner, (owners.get(owner) ?? 0) + delta);
	}
	if (workloadSamples === 0 || workerAncestrySamples === 0 || attributedMicroseconds <= 0) {
		throw new TypeError("D110AT_PROFILE_WORKLOAD_SAMPLES_MISSING");
	}
	const rankedOwners = Object.freeze(
		[...owners.entries()]
			.map(([owner, selfMicroseconds]) =>
				Object.freeze({ owner, selfMicroseconds, share: selfMicroseconds / attributedMicroseconds })
			)
			.sort((left, right) => right.selfMicroseconds - left.selfMicroseconds || left.owner.localeCompare(right.owner))
	);
	const first = rankedOwners[0];
	const second = rankedOwners[1];
	const clearlyDominant =
		first !== undefined && first.share >= 0.5 && first.selfMicroseconds >= 2 * (second?.selfMicroseconds ?? 0);
	return Object.freeze({
		attributedMicroseconds,
		clearlyDominant,
		owners: rankedOwners,
		workerAncestrySamples,
		workloadEnd,
		workloadSamples,
		workloadStart,
	});
}

async function inspectorPost(session, method) {
	return new Promise((resolvePromise, reject) => {
		session.post(method, {}, (error, result) => (error === null ? resolvePromise(result) : reject(error)));
	});
}

async function captureChildProfile(profilePath, executeProfile) {
	if (basename(profilePath) !== D110AT_PROFILE_FILENAME || existsSync(profilePath)) {
		throw new TypeError("D110AT_PROFILE_TARGET_INVALID");
	}
	const { Session } = await import("node:inspector");
	const session = new Session();
	session.connect();
	let started = false;
	try {
		await inspectorPost(session, "Profiler.enable");
		await inspectorPost(session, "Profiler.start");
		started = true;
		const result = await executeProfile();
		const stopped = await inspectorPost(session, "Profiler.stop");
		started = false;
		if (stopped?.profile === undefined) throw new TypeError("D110AT_PROFILE_MISSING");
		writeFileSync(profilePath, JSON.stringify(stopped.profile), { encoding: "utf8", flag: "wx" });
		return result;
	} catch (error) {
		if (started) await inspectorPost(session, "Profiler.stop").catch(() => undefined);
		throw error;
	} finally {
		session.disconnect();
	}
}

async function runWorker(mode) {
	const imports = expectedImports();
	const modules = internalModules();
	const importHook = workspacePackageImportHook({ expectedImports: imports });
	const profileTarget = freshProfileTarget(mode);
	const child = spawn(
		process.execPath,
		[
			"--expose-gc",
			"--import=tsx",
			"--import=fake-indexeddb/auto",
			importHook,
			resolve(import.meta.dirname, "retained-heap-child.mjs"),
			"worker",
			mode,
			JSON.stringify(modules),
			profileTarget?.path ?? "",
		],
		{ cwd: REPOSITORY_ROOT, env: childEnvironment(mode), stdio: ["ignore", "pipe", "pipe", "ipc"] }
	);
	let stderr = "";
	let stdout = "";
	let terminal;
	let lastProgress;
	const progressMessages = [];
	const timeoutMs = mode === "full" ? 45 * 60 * 1000 : mode === "profile" ? 900_000 : 5 * 60 * 1000;
	const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (value) => (stdout += value));
	child.stderr?.on("data", (value) => (stderr += value));
	child.on("message", (message) => {
		if (message?.kind === "progress") {
			lastProgress = message;
			progressMessages.push(message);
		} else terminal = message;
	});
	const exit = await new Promise((resolvePromise, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolvePromise({ code, signal }));
	});
	clearTimeout(timer);
	if (exit.code !== 0 || terminal?.kind === "child-error" || terminal?.result === undefined) {
		throw new TypeError(
			`D110A_CHILD_FAILED:${String(exit.code)}:${String(exit.signal)}:${terminal?.message ?? stderr}:${JSON.stringify(lastProgress)}`
		);
	}
	const runtimeIdentity = Object.freeze({
		imports: Object.freeze(
			Object.fromEntries(
				Object.entries(imports).map(([specifier, path]) => [specifier, { path, sha256: sha256(path) }])
			)
		),
		internals: Object.freeze(
			Object.fromEntries(
				Object.entries(modules).map(([name, url]) => {
					const path = new URL(url);
					return [name, { sha256: sha256(path), url }];
				})
			)
		),
		node: Object.freeze({ execPath: process.execPath, version: process.version }),
	});
	if (mode === "profile") {
		if (
			terminal.pid !== child.pid ||
			terminal.execPath !== process.execPath ||
			profileTarget === undefined ||
			terminal.result.kind !== "d110at-profile-v1" ||
			terminal.result.objectEpochs !== 1 ||
			terminal.result.successfulLifecycles !== 1 ||
			terminal.result.appliedWorkloadOperations !== 15_625 ||
			terminal.result.workloadBatchVertices !== 977 ||
			terminal.result.memoryVerdict !== "not-evaluated"
		) {
			throw new TypeError("D110AT_PROFILE_RESULT_INVALID");
		}
		const phases = terminal.result.phases;
		const expectedPhases = [
			"fixture-open",
			"workload-complete",
			"creator-close-complete",
			"reclamation-complete",
			"successor-published",
			"sample-complete",
			"teardown-complete",
		];
		if (
			phases.length !== expectedPhases.length ||
			phases.some(
				(entry, index) =>
					entry.phase !== expectedPhases[index] ||
					(index > 0 && entry.monotonicMicroseconds <= phases[index - 1].monotonicMicroseconds)
			) ||
			JSON.stringify(progressMessages.map(({ kind: _kind, ...entry }) => entry)) !== JSON.stringify(phases)
		) {
			throw new TypeError("D110AT_PROFILE_PROGRESS_INVALID");
		}
		const entries = readdirSync(profileTarget.directory);
		if (entries.length !== 1 || entries[0] !== D110AT_PROFILE_FILENAME) {
			throw new TypeError("D110AT_PROFILE_FILE_CUSTODY_INVALID");
		}
		const profile = JSON.parse(readFileSync(profileTarget.path, "utf8"));
		const attribution = profileAttribution(profile, terminal.result);
		return Object.freeze({
			attribution,
			childIdentity: Object.freeze({ execPath: terminal.execPath, pid: terminal.pid }),
			childIo: Object.freeze({ stderr, stdout }),
			kind: "d110at-profile-parent-v1",
			profile: Object.freeze({
				endTime: profile.endTime,
				path: profileTarget.path,
				sha256: sha256(profileTarget.path),
				startTime: profile.startTime,
			}),
			profileTimeoutMs: timeoutMs,
			result: terminal.result,
			runtimeIdentity: Object.freeze({ ...runtimeIdentity, nodeOptionsCleared: true }),
		});
	}
	if (mode === "full") {
		const { validateD110aProof } = await import("./retained-heap-contract.ts");
		const validation = validateD110aProof(terminal.result);
		return Object.freeze({ kind: "d110a-full-parent-v1", proof: terminal.result, runtimeIdentity, validation });
	}
	if (
		terminal.result.kind !== "d110a-preflight-v1" ||
		terminal.result.objectEpochs !== 2 ||
		terminal.result.successfulLifecycles !== 2 ||
		terminal.result.accountingDiagnostic !== true
	) {
		throw new TypeError("D110A_PREFLIGHT_INVALID");
	}
	return Object.freeze({ kind: "d110a-preflight-parent-v1", preflight: terminal.result, runtimeIdentity });
}

async function runChild() {
	const mode = process.argv[3];
	const modules = JSON.parse(process.argv[4] ?? "null");
	const profilePath = process.argv[5] ?? "";
	if (
		(mode !== "full" && mode !== "preflight" && mode !== "profile") ||
		modules === null ||
		typeof modules !== "object" ||
		(mode === "profile" && profilePath.length === 0)
	) {
		throw new TypeError("D110A_CHILD_ARGUMENTS_INVALID");
	}
	const worker = await import("./retained-heap-worker.ts");
	const executeProfile = () => worker.runD110aProfile(modules);
	const result =
		mode === "full"
			? await worker.runD110aFullWorker(modules)
			: mode === "profile"
				? await captureChildProfile(profilePath, executeProfile)
				: await worker.runD110aPreflight(modules);
	process.send?.(Object.freeze({ execPath: process.execPath, kind: "result", pid: process.pid, result }));
}

try {
	if (ROLE === "worker") {
		await runChild();
	} else {
		if (ROLE !== "full" && ROLE !== "preflight" && ROLE !== "profile") {
			throw new TypeError("D110A_PARENT_MODE_INVALID");
		}
		process.stdout.write(`${JSON.stringify(await runWorker(ROLE))}\n`);
	}
} catch (error) {
	if (ROLE === "worker") {
		process.send?.(
			Object.freeze({
				kind: "child-error",
				message: error instanceof Error ? (error.stack ?? error.message) : String(error),
			})
		);
	}
	throw error;
}
