import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type P4AssetServer, startP4AssetServer } from "./fixtures/phase-3a1b-p4-asset-server.js";
import {
	P4_BROWSER_DEATH_TUPLES,
	P4_BROWSER_NO_WRITE_DEATH_TUPLES,
} from "./fixtures/phase-3a1b-p4-browser-contract.js";

interface ChildMessage {
	readonly edge?: string;
	readonly expectedRaw?: Readonly<{
		readonly rows: readonly Record<string, unknown>[];
		readonly scopes: readonly Record<string, unknown>[];
	}>;
	readonly kind: string;
	readonly message?: string;
	readonly primary?: Readonly<Record<string, unknown>>;
	readonly raw?: Readonly<{
		readonly rows: readonly Record<string, unknown>[];
		readonly scopes: readonly Record<string, unknown>[];
	}>;
	readonly unaddressed?: Readonly<Record<string, unknown>> | null;
}

let server: P4AssetServer;
const profiles: string[] = [];

test.beforeAll(async () => {
	const directory = process.env.PHASE_3A1B_P4_BROWSER_ASSET_DIR;
	if (directory === undefined) throw new TypeError("p4 browser global setup did not install assets");
	server = await startP4AssetServer(directory);
});

test.afterAll(async () => {
	await server.close();
	for (const profile of profiles.splice(0)) fs.rmSync(profile, { force: true, recursive: true });
});

function childAsset(): string {
	const directory = process.env.PHASE_3A1B_P4_BROWSER_ASSET_DIR;
	if (directory === undefined) throw new TypeError("missing p4 browser assets");
	return path.join(directory, "phase-3a1b-p4-browser-live-journal-crash-child.js");
}

function inputUrl(value: unknown): { readonly pathToken: string; readonly url: string } {
	const issued = server.issueTransitionURL("phase-3a1b-p4-death.html");
	const url = new URL(issued);
	url.searchParams.set("input", Buffer.from(JSON.stringify(value)).toString("base64"));
	return { pathToken: url.pathname.split("/")[2] ?? "", url: url.href };
}

function runMutation(
	browserName: "chromium" | "firefox" | "webkit",
	profileDirectory: string,
	url: string,
	tuple: (typeof P4_BROWSER_DEATH_TUPLES)[number]
): Promise<readonly ChildMessage[]> {
	return new Promise((resolve, reject) => {
		const encoded = Buffer.from(JSON.stringify({ browserName, mode: "mutate", profileDirectory, url })).toString(
			"base64url"
		);
		const child = spawn(process.execPath, [childAsset(), encoded], {
			detached: true,
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const messages: ChildMessage[] = [];
		let killed = false;
		let stderr = "";
		const timeout = setTimeout(() => {
			if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			reject(new Error(`${tuple.id}: browser death timeout: ${stderr}`));
		}, 20_000);
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (value: string) => (stderr += value));
		child.on("message", (message: ChildMessage) => {
			messages.push(message);
			if (message.kind === "child-error" || message.kind === "worker-error") {
				clearTimeout(timeout);
				reject(new Error(`${tuple.id}: ${message.message}`));
			} else if (message.kind === "checkpoint" && message.edge === tuple.edge && !killed && child.pid !== undefined) {
				killed = true;
				process.kill(-child.pid, "SIGKILL");
			}
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			if (!killed) reject(new Error(`${tuple.id}: child exited before checkpoint (${String(code)}): ${stderr}`));
			else if (signal !== "SIGKILL") reject(new Error(`${tuple.id}: expected SIGKILL, got ${String(signal)}`));
			else resolve(messages);
		});
	});
}

function runRecovery(
	browserName: "chromium" | "firefox" | "webkit",
	profileDirectory: string,
	url: string
): Promise<ChildMessage> {
	return new Promise((resolve, reject) => {
		const encoded = Buffer.from(JSON.stringify({ browserName, mode: "recover", profileDirectory, url })).toString(
			"base64url"
		);
		const child = spawn(process.execPath, [childAsset(), encoded], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
		let recovery: ChildMessage | undefined;
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`browser recovery timeout: ${stderr}`));
		}, 20_000);
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (value: string) => (stderr += value));
		child.on("message", (message: ChildMessage) => {
			if (message.kind === "recovery") recovery = message;
			else if (message.kind === "child-error" || message.kind === "worker-error") {
				clearTimeout(timeout);
				reject(new Error(message.message));
			}
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			clearTimeout(timeout);
			if (code !== 0 || recovery === undefined) reject(new Error(`recovery failed (${String(code)}): ${stderr}`));
			else resolve(recovery);
		});
	});
}

test("genuine persistent-context death is old XOR exact-new at all 36 edges", async ({ browserName }) => {
	if (browserName !== "chromium" && browserName !== "firefox" && browserName !== "webkit") {
		throw new TypeError(`unexpected browser ${browserName}`);
	}
	for (const tuple of P4_BROWSER_DEATH_TUPLES) {
		const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `phase-3a1b-p4-${browserName}-`));
		profiles.push(profile);
		const databaseName = `phase-3a1b-p4-${browserName}-${crypto.randomUUID()}`;
		const mutationInput = inputUrl({ databaseName, mode: "mutate", tuple });
		const messages = await runMutation(browserName, profile, mutationInput.url, tuple);
		expect(
			messages.filter(({ kind }) => kind === "checkpoint"),
			tuple.id
		).toHaveLength(1);
		expect(
			messages.some(({ kind }) => kind === "unexpected-result"),
			tuple.id
		).toBe(false);
		server.revoke(mutationInput.pathToken);
		const recoveryInput = inputUrl({ databaseName, mode: "recover", tuple });
		const recovery = await runRecovery(browserName, profile, recoveryInput.url);
		server.revoke(recoveryInput.pathToken);
		const expectedReady = tuple.terminalFate === "exact-new" || tuple.scenario !== "install-genesis";
		const expectedRows = tuple.scenario === "install-genesis" || tuple.terminalFate === "old" ? 0 : 1;
		if (expectedReady) {
			expect(recovery.primary, tuple.id).toMatchObject({ ok: true, ready: true, rowCount: expectedRows });
		} else {
			expect(recovery.primary, tuple.id).toMatchObject({ ok: true, ready: false });
			expect(Object.hasOwn(recovery.primary ?? {}, "rowCount"), tuple.id).toBe(false);
		}
		expect(recovery.raw, tuple.id).toEqual(recovery.expectedRaw);
		expect(recovery.raw?.rows, tuple.id).toHaveLength(expectedRows);
		expect(recovery.raw?.scopes, tuple.id).toHaveLength(
			(expectedReady ? 1 : 0) + (tuple.scopeScenario === "two-scopes" ? 1 : 0)
		);
		if (expectedReady) {
			const primaryScope = recovery.raw?.scopes.find((scope) => scope.objectId === `creator:${"1".repeat(32)}`);
			expect(primaryScope, tuple.id).toMatchObject({ nextJournalSequence: expectedRows });
		}
		if (tuple.scopeScenario === "two-scopes") {
			expect(recovery.unaddressed, tuple.id).toMatchObject({ ok: true, ready: true, rowCount: 0 });
		}
	}
});

test("genuine persistent-context death leaves five no-write repeat/race closures byte-identical", async ({
	browserName,
}) => {
	if (browserName !== "chromium" && browserName !== "firefox" && browserName !== "webkit") {
		throw new TypeError(`unexpected browser ${browserName}`);
	}
	for (const tuple of P4_BROWSER_NO_WRITE_DEATH_TUPLES) {
		const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `phase-3a1b-p4-nowrite-${browserName}-`));
		profiles.push(profile);
		const databaseName = `phase-3a1b-p4-nowrite-${browserName}-${crypto.randomUUID()}`;
		const mutationInput = inputUrl({ databaseName, mode: "mutate", tuple });
		const messages = await runMutation(
			browserName,
			profile,
			mutationInput.url,
			tuple as unknown as (typeof P4_BROWSER_DEATH_TUPLES)[number]
		);
		if (tuple.scenario === "cross-kind-race" || tuple.scenario === "local-ref-race") {
			expect(
				messages.some(({ kind }) => kind === "race-writers-invoked"),
				tuple.id
			).toBe(true);
		}
		server.revoke(mutationInput.pathToken);
		const recoveryInput = inputUrl({ databaseName, mode: "recover", tuple });
		const recovery = await runRecovery(browserName, profile, recoveryInput.url);
		server.revoke(recoveryInput.pathToken);
		const expectedRows = tuple.scenario === "idempotent-genesis" ? 0 : 1;
		expect(recovery.raw, tuple.id).toEqual(recovery.expectedRaw);
		expect(recovery.raw?.rows, tuple.id).toHaveLength(expectedRows);
		expect(recovery.raw?.scopes, tuple.id).toHaveLength(1);
		expect(recovery.raw?.scopes[0], tuple.id).toMatchObject({ nextJournalSequence: expectedRows });
	}
});
