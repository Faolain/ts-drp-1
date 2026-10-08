import { build } from "esbuild";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Checkpoint, Operation } from "./fixture.js";
import type {
	SnapshotQuarantineDeclaration,
	SnapshotRecoveryOwnerStatus,
} from "../../../packages/storage/src/snapshot-transfer.js";
import { workspaceAliases } from "../../../vite.config.mjs";

const sourceRoot = resolve(import.meta.dirname, "../../..");
export interface NativeMessage {
	readonly kind: string;
	readonly token: string;
	readonly pid: number;
	readonly mode: string;
	readonly transport?: string;
	readonly declaration?: SnapshotQuarantineDeclaration;
	readonly owner?: SnapshotRecoveryOwnerStatus;
	readonly beforeClose?: Checkpoint;
	readonly persistenceEntries?: readonly Checkpoint[];
	readonly boundary?: Checkpoint;
	readonly operations?: readonly Operation[];
	readonly operation?: Operation;
	readonly handle?: {
		readonly id: number;
		readonly completed: boolean;
		readonly released: boolean;
		readonly retentionCalls: number;
		readonly retained: boolean;
	};
	readonly detail?: string;
}
export interface NativeResult {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly pid: number;
	readonly birth: string;
	readonly sameBirthKillChecks: number;
	readonly messages: readonly NativeMessage[];
	readonly timedOut: boolean;
	readonly survivors: readonly string[];
	readonly stderr: string;
	readonly exitObserved: boolean;
	readonly lifecycleErrors: readonly string[];
	readonly cleanupSafe: boolean;
}

/**
 * Bundle the current producer source, using the same source aliases as the Vitest control.
 * @param directory - Test-owned destination for the standalone child bundle.
 * @returns Bundle identity and hashes of every build input.
 */
export async function buildNativeProducerChild(
	directory: string
): Promise<{ readonly bundle: string; readonly hash: string; readonly inputs: Readonly<Record<string, string>> }> {
	const alias: Record<string, string> = {};
	for (const name of readdirSync(join(sourceRoot, "packages"))) {
		const directory = join(sourceRoot, "packages", name);
		const filename = join(directory, "package.json");
		if (!existsSync(filename)) continue;
		const manifest = JSON.parse(readFileSync(filename, "utf8")) as {
			name?: string;
			exports?: Record<string, { import?: string }>;
		};
		if (typeof manifest.name !== "string") continue;
		for (const [subpath, selected] of Object.entries(manifest.exports ?? {})) {
			if (typeof selected.import !== "string" || !subpath.startsWith(".")) continue;
			alias[`${manifest.name}${subpath === "." ? "" : subpath.slice(1)}`] = resolve(directory, selected.import);
		}
	}
	Object.assign(alias, workspaceAliases);
	const bundle = join(directory, "producer-child.mjs");
	const result = await build({
		entryPoints: [join(sourceRoot, "tests/fixtures/producer-presign-retention/native-child.ts")],
		outfile: bundle,
		absWorkingDir: sourceRoot,
		bundle: true,
		format: "esm",
		platform: "node",
		alias,
		metafile: true,
		banner: {
			js: "import { createRequire as producerCreateRequire } from 'node:module'; const require = producerCreateRequire(import.meta.url);",
		},
	});
	const inputs = Object.fromEntries(
		Object.keys(result.metafile.inputs)
			.filter((path) => path.startsWith("packages/") || path.startsWith("tests/"))
			.sort()
			.map((path) => [
				path,
				createHash("sha256")
					.update(readFileSync(join(sourceRoot, path)))
					.digest("hex"),
			])
	);
	assert.ok(
		inputs["packages/node/src/creator-close.ts"],
		"native bundle must contain current producer source, not a stale dist close"
	);
	return { bundle, hash: createHash("sha256").update(readFileSync(bundle)).digest("hex"), inputs };
}

/**
 * Same birth/PGID, observed exit and process-group survivor discipline as the accepted native retention child.
 * @param input - Exact native child identities and selected boundary mode.
 * @param input.bundle - Current-source child executable.
 * @param input.directory - Owned temporary root for child artifacts.
 * @param input.primaryFilename - Snapshot primary database identity.
 * @param input.aheFilename - AHE database identity.
 * @param input.mode - Genuine producer checkpoint or late-retention control.
 * @returns Observed terminal status, bounded messages and ownership/cleanup evidence.
 */
export async function runNativeProducerChild(input: {
	readonly bundle: string;
	readonly directory: string;
	readonly primaryFilename: string;
	readonly aheFilename: string;
	readonly mode: "producer" | "late-retention-control";
}): Promise<NativeResult> {
	const token = randomUUID();
	const child = spawn(process.execPath, [input.bundle, input.primaryFilename, input.aheFilename, input.mode, token], {
		detached: true,
		stdio: ["ignore", "pipe", "pipe", "ipc"],
		serialization: "advanced",
		// Every mkdtemp in the genuine fixture is now under this one parent-owned test directory.
		env: { ...process.env, TMPDIR: input.directory },
	});
	const pid = child.pid;
	assert.ok(pid, "NATIVE_PRODUCER_CHILD_SPAWN_FAILED");
	const birthOf = (): string =>
		execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "pgid="], {
			encoding: "utf8",
			timeout: 2_000,
		}).trim();
	const lifecycleErrors: string[] = [];
	let birth = "";
	try {
		birth = birthOf();
	} catch (error) {
		lifecycleErrors.push(`birth-probe:${String(error)}`);
		// This is still the just-spawned unreaped child, not a discovered PID.
		child.kill("SIGKILL");
	}
	if (birth.split(/\s+/u).at(-1) !== String(pid)) {
		lifecycleErrors.push("child does not own expected detached process group");
		child.kill("SIGKILL");
	}
	let sameBirthKillChecks = 0;
	const killSameBirth = (): void => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		try {
			if (birthOf() === birth && birth.split(/\s+/u).at(-1) === String(pid)) {
				sameBirthKillChecks += 1;
				child.kill("SIGKILL");
			}
		} catch {
			/* An exited/recycled process cannot become an unrelated kill target. */
		}
	};
	const messages: NativeMessage[] = [];
	let stderr = "";
	let timedOut = false;
	let exitObserved = false;
	let stdout = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-32_768);
	});
	const terminal = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
		const timer = setTimeout(() => {
			timedOut = true;
			killSameBirth();
		}, 8_000);
		const exitDeadline = setTimeout(() => {
			killSameBirth();
			lifecycleErrors.push("NATIVE_PRODUCER_EXIT_NOT_OBSERVED");
			clearTimeout(timer);
			// Return explicit unsafe-cleanup evidence; never bypass the survivor scan by rejecting.
			resolveExit({ code: child.exitCode, signal: child.signalCode });
		}, 11_000);
		const receive = (raw: unknown): void => {
			if (raw === null || typeof raw !== "object") return;
			const message = raw as NativeMessage;
			if (message.token !== token || message.pid !== pid || message.mode !== input.mode) return;
			messages.push(message);
			if (["checkpoint", "late-checkpoint", "early-effect", "early-close-success"].includes(message.kind))
				killSameBirth();
		};
		child.on("message", receive);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			if (Buffer.byteLength(stdout) >= 48_000) {
				lifecycleErrors.push("native checkpoint exceeded fixed transport bound");
				stdout = "";
				killSameBirth();
				return;
			}
			let newline: number;
			while ((newline = stdout.indexOf("\n")) >= 0) {
				const line = stdout.slice(0, newline);
				stdout = stdout.slice(newline + 1);
				try {
					assert.ok(line.startsWith("PRODUCER_NATIVE_CHECKPOINT "));
					const raw: unknown = JSON.parse(line.slice("PRODUCER_NATIVE_CHECKPOINT ".length), (_key, value: unknown) => {
						if (value !== null && typeof value === "object" && Reflect.has(value, "producerExactBytes")) {
							const bytes: unknown = Reflect.get(value, "producerExactBytes");
							assert.equal(Reflect.ownKeys(value).length, 1);
							assert.ok(
								Array.isArray(bytes) &&
									bytes.every(
										(byte: unknown) => typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255
									)
							);
							return Uint8Array.from(bytes as number[]);
						}
						return value;
					});
					receive(raw);
				} catch (error) {
					lifecycleErrors.push(`invalid-native-checkpoint:${String(error)}`);
					killSameBirth();
				}
			}
		});
		child.once("error", (error) => {
			lifecycleErrors.push(`child-error:${String(error)}`);
			killSameBirth();
			// Keep waiting for close (or the bounded exit diagnostic) before scanning survivors.
		});
		child.once("close", (code, signal) => {
			exitObserved = true;
			clearTimeout(timer);
			clearTimeout(exitDeadline);
			resolveExit({ code, signal });
		});
	});
	let survivors: string[];
	try {
		survivors = execFileSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 2_000 })
			.trim()
			.split("\n")
			.filter((line) => Number(line.trim().split(/\s+/u)[1]) === pid);
	} catch (error) {
		lifecycleErrors.push(`survivor-scan:${String(error)}`);
		survivors = ["SURVIVOR_SCAN_FAILED"];
	}
	return {
		...terminal,
		pid,
		birth,
		sameBirthKillChecks,
		messages,
		timedOut,
		survivors,
		stderr,
		exitObserved,
		lifecycleErrors,
		cleanupSafe: exitObserved && survivors.length === 0,
	};
}

/**
 * Verify owned process death, without treating a deadline as a producer failure.
 * @param result - Observed native child termination evidence.
 */
export function assertNativeTermination(result: NativeResult): void {
	assert.deepEqual(result.lifecycleErrors, [], result.stderr);
	assert.equal(result.cleanupSafe, true);
	assert.equal(result.timedOut, false, result.stderr);
	assert.equal(result.exitObserved, true);
	assert.equal(result.code, null);
	assert.equal(result.signal, "SIGKILL");
	assert.ok(result.sameBirthKillChecks > 0, "termination requires a matching birth and PGID");
	assert.equal(result.birth.split(/\s+/u).at(-1), String(result.pid));
	assert.deepEqual(result.survivors, []);
	assert.equal(result.messages[0]?.kind, "born");
	assert.deepEqual(
		result.messages.filter((message) => message.kind === "child-error"),
		[],
		result.stderr
	);
}

/**
 * Authoritative absence is cumulative observed pre-kill evidence, never an empty cold fake-IDB database.
 * @param message - Original cumulative checkpoints from the held child.
 */
export function assertHeldProducerCheckpoint(message: NativeMessage): void {
	assert.equal(message.kind, "checkpoint", `PRODUCER_NATIVE_RETENTION_ORDERING:${message.kind}`);
	assertObservedPersistenceBoundary(message);
	assert.ok(message.handle && message.declaration && message.owner);
	assert.deepEqual(message.handle, { id: 0, completed: true, released: false, retentionCalls: 1, retained: true });
	assert.equal(message.owner.migration, "ready");
	assert.equal(message.owner.recoveryScopes, 1);
	assert.equal(
		message.owner.recoveryContentBytes,
		message.declaration.totalBytes + message.declaration.exactCanonicalManifestBytes.byteLength
	);
}

/**
 * Shared cumulative oracle, also exercised against the deliberately late real-retention control.
 * @param message - Held producer message including original handle and owner status.
 */
export function assertObservedPersistenceBoundary(message: NativeMessage): void {
	assert.ok(
		message.beforeClose &&
			message.persistenceEntries &&
			message.boundary &&
			message.handle &&
			message.declaration &&
			message.owner
	);
	assert.equal(message.persistenceEntries.length, 1);
	const entry = message.persistenceEntries[0];
	assert.ok(entry, "checkpoint must contain its persistence-entry baseline");
	assert.deepEqual(
		entry.operations.slice(message.beforeClose.operationCount),
		[],
		"unknown staging effects cannot be reset away"
	);
	assert.deepEqual(entry.ahe, message.beforeClose.ahe, "pre-persistence AHE delta must reconcile once");
	assert.deepEqual(
		message.boundary.operations.slice(entry.operationCount).filter((event) => event.lane !== "snapshot"),
		[],
		"cut/vote/replay/publication already occurred before held retention"
	);
	assert.deepEqual(message.boundary.ahe, entry.ahe, "no new AHE generation/head may precede held retention");
}
