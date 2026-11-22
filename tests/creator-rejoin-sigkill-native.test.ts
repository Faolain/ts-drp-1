/* eslint-disable @typescript-eslint/explicit-function-return-type -- Parent-owned process-death harness. */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Readable } from "node:stream";
import { expect, it } from "vitest";

import type { KillEdge } from "./fixtures/rejoin-sigkill/native.js";

const enabled = process.env.RUN_CREATOR_REJOIN_SIGKILL === "1";
const output = process.env.CREATOR_REJOIN_SIGKILL_OUT ?? join(tmpdir(), `creator-rejoin-sigkill-${Date.now()}`);
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

type Ready = {
	kind: "ready-to-kill";
	nonce: string;
	edge: KillEdge;
	pid: number;
	reportSha256: string;
	targetA: { epoch: number; anchorDigest: string };
	targetB: { epoch: number; anchorDigest: string };
};
type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: string };

function filesUnder(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)]
	);
}

function sourceReceipt(directory: string) {
	const checkout = realpathSync(process.cwd());
	const scopes = [
		join(checkout, "node_modules", "@ts-drp"),
		...["packages", "examples"].flatMap((group) =>
			readdirSync(join(checkout, group), { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(checkout, group, entry.name, "node_modules", "@ts-drp"))
		),
	];
	const workspaceLinks = scopes.filter(existsSync).flatMap((scope) =>
		readdirSync(scope).map((name) => {
			const resolved = realpathSync(join(scope, name));
			const expected = join(checkout, "packages", name);
			expect(
				resolved === checkout || resolved.startsWith(checkout + "/"),
				"workspace dependency escaped checkout"
			).toBe(true);
			// Every workspace dependency must belong to this exact checkout. A live
			// sibling tree or its dist cannot silently supply the implementation.
			if (existsSync(expected)) expect(resolved, `${relative(checkout, scope)}/${name}`).toBe(realpathSync(expected));
			return { scope: relative(checkout, scope), name, resolved };
		})
	);
	const sourceDiff = execFileSync("git", ["diff", "--no-ext-diff", "HEAD"], {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	writeFileSync(join(directory, "source.diff"), sourceDiff);
	const sourceFiles = [
		"tests/creator-rejoin-sigkill-native.test.ts",
		"tests/fixtures/rejoin-sigkill/native.ts",
		"tests/fixtures/rejoin-sigkill/worker.child.ts",
		"tests/fixtures/rejoin-sigkill/vitest.config.ts",
		"tests/fixtures/rejoin-sigkill/vitest.workspace.ts",
		"tests/fixtures/chat-membership-shares/room.ts",
		"vite.config.mts",
		"packages/node/src/v3-room.ts",
		"packages/node/src/creator-adoption.ts",
		"packages/node/src/creator-adoption-activate.ts",
		"packages/node/src/creator-adoption-commit.ts",
		"packages/node/src/internal/creator-adoption-intent.ts",
		"packages/node/src/internal/creator-adoption-recover.ts",
		"packages/node/src/internal/creator-source-custody.ts",
		"packages/node/src/internal/creator-transition-advance.ts",
		"packages/storage-node/src/snapshot-transfer.ts",
		"packages/storage-node/src/room-head.ts",
		"packages/storage-node/src/internal/node-issuance-store.ts",
	];
	const builtRuntimeFiles = readdirSync(join(checkout, "packages"))
		.flatMap((name) => filesUnder(join(checkout, "packages", name, "dist")))
		.filter((path) => /\.(js|json|wasm)$/.test(path));
	return {
		builtRuntimeHashes: Object.fromEntries(
			builtRuntimeFiles.map((path) => [relative(checkout, path), hash(readFileSync(path))])
		),
		head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
		checkout,
		sourceDiffSha256: hash(sourceDiff),
		sourceHashes: Object.fromEntries(sourceFiles.map((path) => [path, hash(readFileSync(join(checkout, path)))])),
		workspaceLinks,
	};
}

function worker(directory: string, edge: KillEdge, nonce: string, mode: "mutate" | "recover") {
	const log = join(directory, `${mode}.log`);
	const child = spawn(
		process.execPath,
		[
			"node_modules/vitest/vitest.mjs",
			"run",
			"--config",
			"tests/fixtures/rejoin-sigkill/vitest.config.ts",
			"--workspace",
			"tests/fixtures/rejoin-sigkill/vitest.workspace.ts",
		],
		{
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "pipe", "pipe"],
			env: {
				...process.env,
				REJOIN_KILL_DIRECTORY: directory,
				REJOIN_KILL_EDGE: edge,
				REJOIN_KILL_NONCE: nonce,
				REJOIN_KILL_MODE: mode,
			},
		}
	);
	let ended = false,
		tail = "",
		pipeBuffer = "";
	const capture = (data: Buffer) => {
		appendFileSync(log, data);
		tail = (tail + data.toString()).slice(-65536);
	};
	child.stdout?.on("data", capture);
	child.stderr?.on("data", capture);
	let resolveReady: ((value: Ready) => void) | undefined, rejectReady: ((cause: Error) => void) | undefined;
	const ready =
		mode === "mutate"
			? new Promise<Ready>((resolve, reject) => {
					resolveReady = resolve;
					rejectReady = reject;
				})
			: undefined;
	const result = new Promise<Exit>((resolve) => {
		child.once("error", (cause) => {
			ended = true;
			rejectReady?.(cause);
			resolve({ code: null, signal: null, error: String(cause) });
		});
		child.once("close", (code, signal) => {
			ended = true;
			rejectReady?.(new Error(`Worker ended before committed IPC: ${code}/${signal}\n${tail}`));
			resolve({ code, signal });
		});
	});
	(child.stdio[3] as Readable).on("data", (data: Buffer) => {
		pipeBuffer += data.toString();
		if (pipeBuffer.length > 16384) {
			rejectReady?.(new Error("REJOIN_KILL_IPC_TOO_LARGE"));
			return;
		}
		const end = pipeBuffer.indexOf("\n");
		if (end === -1) return;
		try {
			const value = JSON.parse(pipeBuffer.slice(0, end)) as Ready;
			if (value.kind !== "ready-to-kill" || value.nonce !== nonce || value.edge !== edge || value.pid !== child.pid)
				throw new Error("REJOIN_KILL_IPC_IDENTITY_MISMATCH");
			resolveReady?.(value);
			resolveReady = undefined;
			rejectReady = undefined;
		} catch (cause) {
			rejectReady?.(cause instanceof Error ? cause : new Error(String(cause)));
		}
	});
	const stop = async () => {
		if (!ended) child.kill("SIGKILL");
		await result;
	};
	return { child, ready, result, stop, output: () => tail };
}

async function deadline<Value>(promise: Promise<Value>, label: string): Promise<Value> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`REJOIN_KILL_TIMEOUT:${label}`)), 150_000);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

it.skipIf(!enabled).each(["receipt-commit", "floor-commit"] as const)(
	"recovers exact checkpoint A after SIGKILL at %s while creator B is newer",
	async (edge) => {
		mkdirSync(output, { recursive: true });
		const directory = mkdtempSync(join(output, `${edge}-`)),
			nonce = randomUUID();
		const source = sourceReceipt(directory);
		writeFileSync(join(directory, "source.json"), JSON.stringify(source, null, 2));
		const mutation = worker(directory, edge, nonce, "mutate");
		try {
			const readyPromise = mutation.ready;
			if (readyPromise === undefined) throw new Error("REJOIN_KILL_IPC_NOT_INSTALLED");
			const ready = await deadline(readyPromise, "committed-boundary");
			expect(ready.targetA.epoch).toBe(2);
			expect(ready.targetB.epoch).toBe(4);
			expect(ready.targetA.anchorDigest).not.toBe(ready.targetB.anchorDigest);
			const reportBytes = readFileSync(join(directory, "ready-to-kill.json"));
			expect(hash(reportBytes)).toBe(ready.reportSha256);
			const report = JSON.parse(reportBytes.toString()) as { pid: number; nonce: string; edge: KillEdge };
			expect(report).toMatchObject({ pid: mutation.child.pid, nonce, edge });
			expect(mutation.child.kill("SIGKILL")).toBe(true);
			const killed = await deadline(mutation.result, "killed-process-join");
			expect(killed, mutation.output()).toEqual({ code: null, signal: "SIGKILL" });
			writeFileSync(
				join(directory, "death.json"),
				JSON.stringify({ ready, result: killed, parentPid: process.pid, source }, null, 2)
			);
			const recovery = worker(directory, edge, nonce, "recover");
			try {
				const recovered = await deadline(recovery.result, "fresh-process-recovery");
				expect(recovered, recovery.output()).toEqual({ code: 0, signal: null });
				expect(JSON.parse(readFileSync(join(directory, "recovered.json"), "utf8"))).toMatchObject({
					killedPid: ready.pid,
					continued: true,
					productionInterceptorsInstalled: false,
				});
			} finally {
				await recovery.stop();
			}
		} finally {
			await mutation.stop();
		}
	},
	360_000
);
