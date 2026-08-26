import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureProcessForest, processClosure } from "./fixtures/process-forest.js";

const profiles: string[] = [];
const transitionTokens = new Set<string>();
let origin = "";
let server: Server;

interface ChildMessage {
	readonly kind: string;
	readonly message?: string;
	readonly result?: Readonly<Record<string, unknown>>;
}

function operations(refCount: number): readonly string[] {
	return [
		"beginGeneration",
		"putCachedBlob",
		...Array.from({ length: refCount }, (_, index) => `promoteReference:${index}`),
		"completeGeneration",
		"swapHead",
	];
}

function requestRoster(refCount: number): readonly string[] {
	return operations(refCount).flatMap((operation) =>
		["before-request", "commit-then-throw", "after-request"].map((edge) => `${operation}:${edge}`)
	);
}

function transactionRoster(refCount: number): readonly string[] {
	return operations(refCount).flatMap((operation) =>
		["before-commit", "after-commit"].map((edge) => `${operation}:${edge}`)
	);
}

test.beforeAll(async () => {
	const directory = process.env.PHASE_6A_CREATOR_ADOPTION_COMMIT_ASSET_DIR;
	if (directory === undefined) throw new TypeError("D.108c browser assets are unavailable");
	server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const [, token, asset] = url.pathname.split("/");
		if (
			!transitionTokens.has(token ?? "") ||
			!/^(?:phase-6a-creator-adoption-commit)(?:\.html|\.js)$/u.test(asset ?? "")
		) {
			response.writeHead(404).end();
			return;
		}
		try {
			response
				.writeHead(200, {
					"content-type": asset?.endsWith(".js") === true ? "text/javascript" : "text/html",
					"cross-origin-embedder-policy": "require-corp",
					"cross-origin-opener-policy": "same-origin",
				})
				.end(readFileSync(join(directory, asset as string)));
		} catch {
			response.writeHead(404).end();
		}
	});
	await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	if (address === null || typeof address === "string") throw new TypeError("D.108c asset server did not bind");
	origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
	await new Promise<void>((resolvePromise, reject) =>
		server.close((error) => (error === undefined ? resolvePromise() : reject(error)))
	);
	for (const profile of profiles.splice(0)) rmSync(profile, { force: true, recursive: true });
});

function browserName(value: string): "chromium" | "firefox" | "webkit" {
	if (value === "chromium" || value === "firefox" || value === "webkit") return value;
	throw new TypeError(`unexpected D.108c browser: ${value}`);
}

function childAsset(): string {
	const directory = process.env.PHASE_6A_CREATOR_ADOPTION_COMMIT_ASSET_DIR;
	if (directory === undefined) throw new TypeError("D.108c child asset is unavailable");
	return join(directory, "phase-6a-creator-adoption-commit-child.js");
}

function inputUrl(input: unknown): Readonly<{ readonly token: string; readonly url: string }> {
	const token = crypto.randomUUID();
	transitionTokens.add(token);
	const url = new URL(`${origin}/${token}/phase-6a-creator-adoption-commit.html`);
	if (input !== undefined) url.searchParams.set("input", Buffer.from(JSON.stringify(input)).toString("base64"));
	return Object.freeze({ token, url: url.href });
}

function runDeath(
	selectedBrowser: "chromium" | "firefox" | "webkit",
	profileDirectory: string,
	url: string
): Promise<void> {
	return new Promise((resolve, reject) => {
		const encoded = Buffer.from(
			JSON.stringify({ browserName: selectedBrowser, mode: "death", profileDirectory, url })
		).toString("base64url");
		const child = spawn(process.execPath, [childAsset(), encoded], {
			detached: true,
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		let stderr = "";
		let killed = false;
		let killedPids: readonly number[] = [];
		const timeout = setTimeout(() => {
			if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			reject(new Error(`D.108c browser death timeout: ${stderr}`));
		}, 30_000);
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (value: string) => (stderr += value));
		child.on("message", (message: ChildMessage) => {
			if (message.kind === "child-error") reject(new Error(message.message));
			if (message.kind === "checkpoint" && child.pid !== undefined) {
				killed = true;
				const owned = processClosure(captureProcessForest(), child.pid);
				if (owned.length < 2) throw new TypeError("D.108c browser process forest is empty");
				killedPids = Object.freeze(owned.map(({ pid }) => pid));
				const groups = [...new Set(owned.map(({ pgid }) => pgid))].filter((pgid) => pgid > 0 && pgid !== child.pid);
				for (const pgid of groups) process.kill(-pgid, "SIGKILL");
				process.kill(-child.pid, "SIGKILL");
			}
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			if (!killed || signal !== "SIGKILL" || code !== null)
				reject(new Error(`expected browser SIGKILL, got ${String(code)}/${String(signal)}`));
			else {
				const deadline = Date.now() + 10_000;
				const poll = (): void => {
					const live = new Set(captureProcessForest().map(({ pid }) => pid));
					if (killedPids.every((pid) => !live.has(pid))) resolve();
					else if (Date.now() >= deadline) reject(new Error("D.108c browser process forest survived SIGKILL"));
					else setTimeout(poll, 25);
				};
				poll();
			}
		});
	});
}

function runRecovery(
	selectedBrowser: "chromium" | "firefox" | "webkit",
	profileDirectory: string,
	url: string
): Promise<ChildMessage> {
	return new Promise((resolve, reject) => {
		const encoded = Buffer.from(
			JSON.stringify({ browserName: selectedBrowser, mode: "recover", profileDirectory, url })
		).toString("base64url");
		const child = spawn(process.execPath, [childAsset(), encoded], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
		let observed: ChildMessage | undefined;
		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (value: string) => (stderr += value));
		child.on("message", (message: ChildMessage) => {
			if (message.kind === "recovery") observed = message;
			if (message.kind === "child-error") reject(new Error(message.message));
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code !== 0 || observed === undefined) reject(new Error(`D.108c browser recovery failed: ${stderr}`));
			else resolve(observed);
		});
	});
}

test("runs the complete ordinary request/terminal matrix in every engine", async ({ browserName: raw, page }) => {
	const selectedBrowser = browserName(raw);
	const bootstrap = inputUrl(undefined);
	await page.goto(bootstrap.url);
	const candidateRefCount = await page.evaluate(() => globalThis.phase6aCreatorAdoptionCommit.candidateRefCount);
	transitionTokens.delete(bootstrap.token);
	for (const target of requestRoster(candidateRefCount).flatMap((value) => {
		const [operation, occurrenceOrEdge, maybeEdge] = value.split(":");
		const named = maybeEdge === undefined ? operation : `${operation}:${occurrenceOrEdge}`;
		const edge = maybeEdge ?? occurrenceOrEdge;
		return edge === "commit-then-throw" ? [] : [`${named}:${edge}`];
	})) {
		const databaseName = `d108c-ordinary-${selectedBrowser}-${crypto.randomUUID()}`;
		const issued = inputUrl(undefined);
		await page.goto(issued.url);
		const result = (await page.evaluate((input) => globalThis.phase6aCreatorAdoptionCommit.run(input), {
			databaseName,
			mode: "ordinary" as const,
			target,
		})) as Readonly<Record<string, unknown>>;
		transitionTokens.delete(issued.token);
		expect(result.classification, target).toBe(target.startsWith("swapHead:after-") ? "active-new" : "pending-old");
	}
});

test("uses genuine process-group SIGKILL and exact reopen in every engine", async ({ browserName: raw, page }) => {
	const selectedBrowser = browserName(raw);
	const bootstrap = inputUrl(undefined);
	await page.goto(bootstrap.url);
	const candidateRefCount = await page.evaluate(() => globalThis.phase6aCreatorAdoptionCommit.candidateRefCount);
	transitionTokens.delete(bootstrap.token);
	for (const row of transactionRoster(candidateRefCount)) {
		const [operation, occurrenceOrEdge, maybeEdge] = row.split(":");
		const named = maybeEdge === undefined ? operation : `${operation}:${occurrenceOrEdge}`;
		const nativeEdge = maybeEdge ?? occurrenceOrEdge;
		const target = `${named}:${nativeEdge === "before-commit" ? "after-native-request" : "after-transaction-terminal"}`;
		const databaseName = `d108c-death-${selectedBrowser}-${crypto.randomUUID()}`;
		const profileDirectory = mkdtempSync(join(tmpdir(), `d108c-${selectedBrowser}-`));
		profiles.push(profileDirectory);
		const death = inputUrl({ databaseName, mode: "death", target });
		await runDeath(selectedBrowser, profileDirectory, death.url);
		transitionTokens.delete(death.token);
		const reopened = inputUrl({ databaseName, mode: "recover" });
		const observation = await runRecovery(selectedBrowser, profileDirectory, reopened.url);
		transitionTokens.delete(reopened.token);
		if (row === "swapHead:before-commit") {
			expect(["pending-old", "active-new"], row).toContain(observation.result?.classification);
		} else {
			expect(observation.result?.classification, row).toBe(
				row === "swapHead:after-commit" ? "active-new" : "pending-old"
			);
		}
	}
});
