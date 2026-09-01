/* eslint-disable @typescript-eslint/explicit-function-return-type -- Fresh-process test launcher. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { workspacePackageImportHook } from "../shared/workspace-package-subprocess.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const ROLE = process.argv[2] ?? "parent";

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

async function runWorker(mode) {
	const imports = expectedImports();
	const modules = internalModules();
	const importHook = workspacePackageImportHook({ expectedImports: imports });
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
		],
		{ cwd: REPOSITORY_ROOT, stdio: ["ignore", "pipe", "pipe", "ipc"] }
	);
	let stderr = "";
	let stdout = "";
	let terminal;
	let lastProgress;
	const timeoutMs = mode === "full" ? 45 * 60 * 1000 : 5 * 60 * 1000;
	const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (value) => (stdout += value));
	child.stderr?.on("data", (value) => (stderr += value));
	child.on("message", (message) => {
		if (message?.kind === "progress") lastProgress = message;
		else terminal = message;
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
	if ((mode !== "full" && mode !== "preflight") || modules === null || typeof modules !== "object") {
		throw new TypeError("D110A_CHILD_ARGUMENTS_INVALID");
	}
	const worker = await import("./retained-heap-worker.ts");
	const result = mode === "full" ? await worker.runD110aFullWorker(modules) : await worker.runD110aPreflight(modules);
	process.send?.(Object.freeze({ kind: "result", result }));
}

try {
	if (ROLE === "worker") {
		await runChild();
	} else {
		if (ROLE !== "full" && ROLE !== "preflight") throw new TypeError("D110A_PARENT_MODE_INVALID");
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
