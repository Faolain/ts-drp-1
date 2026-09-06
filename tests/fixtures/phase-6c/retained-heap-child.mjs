/* eslint-disable @typescript-eslint/explicit-function-return-type -- Fresh-process test launcher. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	D110A_FULL_TIMEOUT_MS,
	D110A_OBJECT_EPOCHS,
	D110A_PREFLIGHT_TIMEOUT_MS,
	validateD110auProfileAttribution,
} from "./retained-heap-contract.ts";
import {
	captureD110aForensicChild,
	createD110aForensicRecorder,
	createD110aFullForensicConfiguration,
	readD110aForensicJournal,
	requireSuccessfulD110aForensicCapture,
	validateD110aForensicJournal,
} from "./retained-heap-forensics.mjs";
import { workspacePackageImportHook } from "../shared/workspace-package-subprocess.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const ROLE = process.argv[2] ?? "parent";
const D110AU_PROFILE_FILENAME = "d110au-main.cpuprofile";
const D110AU_CAPTURE_SENTINEL = "capture-consumed.json";
const D110AU_CAPTURE_RECORDS = "capture-records.json";

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

function runtimeIdentity(imports, modules) {
	return Object.freeze({
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
}

function checkedGit(args) {
	const result = spawnSync("git", args, { cwd: REPOSITORY_ROOT, encoding: "utf8" });
	if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
		throw new TypeError(
			`D110AX_SOURCE_AUTHENTICATION_FAILED:${args.join(" ")}:${result.error?.message ?? result.stderr}`
		);
	}
	return Object.freeze({ stderr: result.stderr, stdout: result.stdout.trim() });
}

function fullSourceRuntimeIdentity({ childArguments, imports, modules }) {
	const sourceCommit = checkedGit(["rev-parse", "HEAD"]).stdout;
	const sourceTree = checkedGit(["rev-parse", "HEAD^{tree}"]).stdout;
	const signature = checkedGit(["verify-commit", "--raw", sourceCommit]);
	checkedGit(["diff", "--quiet"]);
	checkedGit(["diff", "--cached", "--quiet"]);
	const ownerPaths = Object.freeze([
		"tests/fixtures/phase-6c/retained-heap-child.mjs",
		"tests/fixtures/phase-6c/retained-heap-contract.ts",
		"tests/fixtures/phase-6c/retained-heap-forensics.mjs",
		"tests/fixtures/phase-6c/retained-heap-worker.ts",
	]);
	return Object.freeze({
		command: Object.freeze({ arguments: childArguments, cwd: REPOSITORY_ROOT, execPath: process.execPath }),
		deadlineMs: D110A_FULL_TIMEOUT_MS,
		kind: "d110ax-full-source-runtime-identity-v1",
		owners: Object.freeze(
			Object.fromEntries(
				ownerPaths.map((relative) => [relative, { sha256: sha256(resolve(REPOSITORY_ROOT, relative)) }])
			)
		),
		runtime: runtimeIdentity(imports, modules),
		sourceCommit,
		sourceSignature: Object.freeze({ stderr: signature.stderr, stdout: signature.stdout, verified: true }),
		sourceTree,
		trackedWorktreeClean: true,
	});
}

function freshProfileTarget(mode) {
	if (mode !== "profile") return undefined;
	const evidenceRoot = resolve(REPOSITORY_ROOT, ".logs/phase-6c-d110au-green");
	if (existsSync(evidenceRoot)) throw new TypeError("D110AU_PROFILE_ROOT_NOT_FRESH");
	mkdirSync(evidenceRoot, { recursive: true });
	const directory = mkdtempSync(join(evidenceRoot, "profile-"));
	if (readdirSync(directory).length !== 0) throw new TypeError("D110AU_PROFILE_DIRECTORY_NOT_EMPTY");
	return Object.freeze({
		directory,
		evidenceRoot,
		path: join(directory, D110AU_PROFILE_FILENAME),
		recordsPath: join(evidenceRoot, D110AU_CAPTURE_RECORDS),
		sentinelPath: join(evidenceRoot, D110AU_CAPTURE_SENTINEL),
	});
}

function childEnvironment(mode) {
	if (mode !== "profile") return process.env;
	const environment = { ...process.env };
	delete environment.NODE_OPTIONS;
	return environment;
}

async function inspectorPost(session, method) {
	return new Promise((resolvePromise, reject) => {
		session.post(method, {}, (error, result) => (error === null ? resolvePromise(result) : reject(error)));
	});
}

function monotonicMicroseconds() {
	return Number(process.hrtime.bigint() / 1_000n);
}

async function captureChildProfile(profilePath, executeProfile) {
	if (basename(profilePath) !== D110AU_PROFILE_FILENAME || existsSync(profilePath)) {
		throw new TypeError("D110AU_PROFILE_TARGET_INVALID");
	}
	const { Session } = await import("node:inspector");
	const session = new Session();
	session.connect();
	let started = false;
	try {
		await inspectorPost(session, "Profiler.enable");
		const hrtimeBeforeStart = monotonicMicroseconds();
		await inspectorPost(session, "Profiler.start");
		const hrtimeAfterStart = monotonicMicroseconds();
		started = true;
		const result = await executeProfile();
		const hrtimeBeforeStop = monotonicMicroseconds();
		const stopped = await inspectorPost(session, "Profiler.stop");
		const hrtimeAfterStop = monotonicMicroseconds();
		started = false;
		if (stopped?.profile === undefined) throw new TypeError("D110AT_PROFILE_MISSING");
		writeFileSync(profilePath, JSON.stringify(stopped.profile), { encoding: "utf8", flag: "wx" });
		return Object.freeze({
			calibration: Object.freeze({
				hrtimeAfterStart,
				hrtimeAfterStop,
				hrtimeBeforeStart,
				hrtimeBeforeStop,
			}),
			result,
		});
	} catch (error) {
		if (started) await inspectorPost(session, "Profiler.stop").catch(() => undefined);
		throw error;
	} finally {
		session.disconnect();
	}
}

async function runFullWorker(imports, modules, importHook) {
	const childPath = resolve(import.meta.dirname, "retained-heap-child.mjs");
	const configuration = createD110aFullForensicConfiguration({
		childPath,
		deadlineMs: D110A_FULL_TIMEOUT_MS,
		repositoryRoot: REPOSITORY_ROOT,
	});
	const childArguments = Object.freeze([
		"--expose-gc",
		"--import=tsx",
		"--import=fake-indexeddb/auto",
		importHook,
		configuration.childPath,
		"worker",
		"full",
		JSON.stringify(modules),
		"",
	]);
	const identity = fullSourceRuntimeIdentity({ childArguments, imports, modules });
	const recorder = createD110aForensicRecorder({ configuration, identity });
	let finalizing = false;
	let capture = Object.freeze({
		childPid: null,
		exitCode: null,
		exitSignal: null,
		terminalResultReceived: false,
		watchdogFired: false,
	});
	try {
		const child = spawn(process.execPath, childArguments, {
			cwd: REPOSITORY_ROOT,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		capture = await captureD110aForensicChild({ child, recorder });
		const terminal = requireSuccessfulD110aForensicCapture(capture);
		const durableTerminal = JSON.parse(readFileSync(`${configuration.evidenceRoot}/terminal.json`, "utf8"));
		if (
			JSON.stringify(durableTerminal) !== JSON.stringify(terminal) ||
			durableTerminal.pid !== child.pid ||
			durableTerminal.execPath !== process.execPath
		) {
			throw new TypeError("D110AX_FORENSIC_TERMINAL_IDENTITY_INVALID");
		}
		const journalValidation = validateD110aForensicJournal({
			expectedObjectEpochs: D110A_OBJECT_EPOCHS,
			proof: durableTerminal.result,
			records: readD110aForensicJournal(configuration.evidenceRoot),
		});
		const { validateD110aProof } = await import("./retained-heap-contract.ts");
		const validation = validateD110aProof(durableTerminal.result);
		const parentResult = Object.freeze({
			failureForensics: Object.freeze({
				evidenceRoot: configuration.evidenceRoot,
				journal: journalValidation,
			}),
			kind: "d110a-full-parent-v1",
			proof: durableTerminal.result,
			runtimeIdentity: identity.runtime,
			validation,
		});
		finalizing = true;
		recorder.finish({ capture, parentResult, parentStatus: "success" });
		return parentResult;
	} catch (error) {
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		const classification = error instanceof Error ? error.message.split(":", 1)[0] : "D110AX_FORENSIC_UNKNOWN_FAILURE";
		if (!finalizing) {
			finalizing = true;
			recorder.finish({
				capture,
				failureClassification: classification,
				failureMessage: message,
				parentStatus: "failure",
			});
		}
		throw error;
	}
}

async function runWorker(mode) {
	const imports = expectedImports();
	const modules = internalModules();
	const importHook = workspacePackageImportHook({ expectedImports: imports });
	if (mode === "full") return runFullWorker(imports, modules, importHook);
	const profileTarget = freshProfileTarget(mode);
	if (profileTarget !== undefined) {
		writeFileSync(
			profileTarget.sentinelPath,
			JSON.stringify(Object.freeze({ kind: "d110au-profile-capture-consumed-v1" })),
			{ encoding: "utf8", flag: "wx" }
		);
	}
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
	let captureRecordError;
	let lastProgress;
	const progressMessages = [];
	const timeoutMs = mode === "full" ? D110A_FULL_TIMEOUT_MS : mode === "profile" ? 900_000 : D110A_PREFLIGHT_TIMEOUT_MS;
	const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (value) => (stdout += value));
	child.stderr?.on("data", (value) => (stderr += value));
	child.on("message", (message) => {
		if (message?.kind === "progress") {
			lastProgress = message;
			progressMessages.push(message);
		} else {
			if (profileTarget !== undefined) {
				try {
					writeFileSync(profileTarget.recordsPath, JSON.stringify(message), { encoding: "utf8", flag: "wx" });
				} catch (error) {
					captureRecordError = error;
				}
			}
			terminal = message;
		}
	});
	const exit = await new Promise((resolvePromise, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolvePromise({ code, signal }));
	});
	clearTimeout(timer);
	if (captureRecordError !== undefined) {
		throw new TypeError(
			`D110AU_CAPTURE_RECORD_WRITE_FAILED:${captureRecordError instanceof Error ? captureRecordError.message : String(captureRecordError)}`
		);
	}
	if (exit.code !== 0 || terminal?.kind === "child-error" || terminal?.result === undefined) {
		throw new TypeError(
			`D110A_CHILD_FAILED:${String(exit.code)}:${String(exit.signal)}:${terminal?.message ?? stderr}:${JSON.stringify(lastProgress)}`
		);
	}
	const currentRuntimeIdentity = runtimeIdentity(imports, modules);
	if (mode === "profile") {
		if (profileTarget === undefined || !existsSync(profileTarget.recordsPath)) {
			throw new TypeError("D110AU_CAPTURE_RECORD_MISSING");
		}
		const durableTerminal = JSON.parse(readFileSync(profileTarget.recordsPath, "utf8"));
		if (JSON.stringify(durableTerminal) !== JSON.stringify(terminal)) {
			throw new TypeError("D110AU_CAPTURE_RECORD_MISMATCH");
		}
		terminal = durableTerminal;
		if (
			terminal.pid !== child.pid ||
			terminal.execPath !== process.execPath ||
			terminal.result.kind !== "d110at-profile-v1" ||
			terminal.result.objectEpochs !== 1 ||
			terminal.result.successfulLifecycles !== 1 ||
			terminal.result.appliedWorkloadOperations !== 15_625 ||
			terminal.result.workloadBatchVertices !== 977 ||
			terminal.result.memoryVerdict !== "not-evaluated" ||
			terminal.profileCalibration === undefined
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
		if (entries.length !== 1 || entries[0] !== D110AU_PROFILE_FILENAME) {
			throw new TypeError("D110AT_PROFILE_FILE_CUSTODY_INVALID");
		}
		const rootEntries = readdirSync(profileTarget.evidenceRoot).sort();
		const expectedRootEntries = [
			D110AU_CAPTURE_RECORDS,
			D110AU_CAPTURE_SENTINEL,
			basename(profileTarget.directory),
		].sort();
		if (JSON.stringify(rootEntries) !== JSON.stringify(expectedRootEntries)) {
			throw new TypeError("D110AU_PROFILE_ROOT_CUSTODY_INVALID");
		}
		const profile = JSON.parse(readFileSync(profileTarget.path, "utf8"));
		const attribution = validateD110auProfileAttribution({
			calibration: terminal.profileCalibration,
			phases,
			profile,
		});
		return Object.freeze({
			attribution,
			captureRecords: Object.freeze({
				path: profileTarget.recordsPath,
				sha256: sha256(profileTarget.recordsPath),
			}),
			childIdentity: Object.freeze({ execPath: terminal.execPath, pid: terminal.pid }),
			childIo: Object.freeze({ stderr, stdout }),
			kind: "d110au-profile-parent-v1",
			profile: Object.freeze({
				endTime: profile.endTime,
				path: profileTarget.path,
				sha256: sha256(profileTarget.path),
				startTime: profile.startTime,
			}),
			profileTimeoutMs: timeoutMs,
			result: terminal.result,
			runtimeIdentity: Object.freeze({ ...currentRuntimeIdentity, nodeOptionsCleared: true }),
		});
	}
	if (
		terminal.result.kind !== "d110a-preflight-v1" ||
		terminal.result.objectEpochs !== 2 ||
		terminal.result.successfulLifecycles !== 2 ||
		terminal.result.accountingDiagnostic !== true
	) {
		throw new TypeError("D110A_PREFLIGHT_INVALID");
	}
	return Object.freeze({
		kind: "d110a-preflight-parent-v1",
		preflight: terminal.result,
		runtimeIdentity: currentRuntimeIdentity,
	});
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
	const sendTerminal = async (message) =>
		new Promise((resolvePromise, reject) => {
			if (process.send === undefined) return reject(new TypeError("D110A_CHILD_IPC_MISSING"));
			process.send(message, (error) => (error === undefined || error === null ? resolvePromise() : reject(error)));
		});
	const executeProfile = () => worker.runD110aProfile(modules);
	if (mode === "profile") {
		const captured = await captureChildProfile(profilePath, executeProfile);
		await sendTerminal(
			Object.freeze({
				execPath: process.execPath,
				kind: "result",
				pid: process.pid,
				profileCalibration: captured.calibration,
				result: captured.result,
			})
		);
		return;
	}
	const result = mode === "full" ? await worker.runD110aFullWorker(modules) : await worker.runD110aPreflight(modules);
	await sendTerminal(Object.freeze({ execPath: process.execPath, kind: "result", pid: process.pid, result }));
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
		if (process.send !== undefined && process.connected) {
			await new Promise((resolvePromise) => {
				process.send(
					Object.freeze({
						kind: "child-error",
						message: error instanceof Error ? (error.stack ?? error.message) : String(error),
					}),
					() => resolvePromise()
				);
			});
		}
	}
	throw error;
}
