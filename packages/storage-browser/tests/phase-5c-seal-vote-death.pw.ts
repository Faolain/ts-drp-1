import { chromium, expect, type Page, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { type Phase4cBrowserServer, startPhase4cBrowserServer } from "./phase-4c-browser-server.js";

const PACKAGE_DIRECTORY = resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, "../..");
const CHILD = resolve(PACKAGE_DIRECTORY, "tests/assets/phase-5c-seal-vote-death-child.ts");
const REQUIRED_OWNERS = (
	JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, "tests/fixtures/phase-5-v3/seal-safety-contract.json"), "utf8")) as {
		readonly requiredOwners: readonly string[];
	}
).requiredOwners;
const GREEN_READY = REQUIRED_OWNERS.every((path) => existsSync(resolve(REPOSITORY_ROOT, path)));

let server: Phase4cBrowserServer | undefined;
test.beforeAll(async () => {
	if (!GREEN_READY) return;
	server = await startPhase4cBrowserServer({
		entryPoint: resolve(PACKAGE_DIRECTORY, "tests/assets/phase-5c-seal-vote-entry.ts"),
		workerPoint: resolve(PACKAGE_DIRECTORY, "tests/assets/phase-5c-seal-vote-worker.ts"),
	});
});
test.afterAll(async () => server?.close());
test.skip(!GREEN_READY, "D.105b product owners are intentionally absent in RED");
test.skip(({ browserName }) => browserName !== "chromium", "hard process-death evidence is Chromium-only");

async function runArmedDeathChild(input: {
	readonly checkpoint: string;
	readonly databaseName: string;
	readonly origin: string;
	readonly profileDirectory: string;
}): Promise<Readonly<{ signal: NodeJS.Signals; stderr: string; stdout: string }>> {
	const child = spawn("pnpm", ["exec", "tsx", CHILD, JSON.stringify(input)], {
		cwd: REPOSITORY_ROOT,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const exited = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolvePromise) => {
		child.once("exit", (code, signal) => resolvePromise({ code, signal }));
	});
	const armed = new Promise<void>((resolvePromise, reject) => {
		const timeout = setTimeout(() => reject(new Error(`death child did not arm\n${stdout}\n${stderr}`)), 60_000);
		const inspect = (): void => {
			if (!stdout.includes(`PHASE5C_ARMED:${input.checkpoint}`)) return;
			clearTimeout(timeout);
			resolvePromise();
		};
		child.stdout.on("data", inspect);
		void exited.then(({ code, signal }) => {
			if (!stdout.includes(`PHASE5C_ARMED:${input.checkpoint}`)) {
				clearTimeout(timeout);
				reject(new Error(`death child exited before arming: ${String(code)}/${String(signal)}\n${stdout}\n${stderr}`));
			}
		});
	});
	await armed;
	if (child.pid === undefined) throw new Error("death child has no process id");
	process.kill(-child.pid, "SIGKILL");
	let exitTimeout: ReturnType<typeof setTimeout> | undefined;
	const result = await Promise.race([
		exited,
		new Promise<never>((_resolvePromise, reject) => {
			exitTimeout = setTimeout(() => reject(new Error("killed death child did not exit")), 30_000);
		}),
	]);
	clearTimeout(exitTimeout);
	if (result.signal === null) throw new Error(`death child did not die by signal\n${stdout}\n${stderr}`);
	return { signal: result.signal, stderr, stdout };
}

async function inspectRawDeathState(
	page: Page,
	databaseName: string
): Promise<Readonly<{ noPartialRows: boolean; state: "exact-new" | "old" }>> {
	return page.evaluate(async (name) => {
		const known = await indexedDB.databases();
		if (!known.some(({ name: candidate }) => candidate === name)) throw new Error("death database is absent");
		const database = await new Promise<IDBDatabase>((resolvePromise, reject) => {
			const request = indexedDB.open(name);
			request.onerror = (): void => reject(request.error ?? new Error("death database reopen failed"));
			request.onsuccess = (): void => resolvePromise(request.result);
		});
		try {
			if (database.version !== 3) throw new Error(`unexpected death database version ${database.version}`);
			const required = ["signerState", "storageMeta", "voteOutbox", "voteSlots"];
			if (!required.every((store) => database.objectStoreNames.contains(store))) {
				throw new Error("death database is not the exact vote schema");
			}
			const transaction = database.transaction(required, "readonly");
			const counts = await Promise.all(
				required.map(
					(store) =>
						new Promise<number>((resolvePromise, reject) => {
							const request = transaction.objectStore(store).count();
							request.onerror = (): void => reject(request.error ?? new Error("death raw count failed"));
							request.onsuccess = (): void => resolvePromise(request.result);
						})
				)
			);
			const [signerState, storageMeta, voteOutbox, voteSlots] = counts;
			if (storageMeta !== 1) throw new Error("death database lost its incarnation");
			const old = signerState === 0 && voteOutbox === 0 && voteSlots === 0;
			const exactNew = signerState === 1 && voteOutbox === 1 && voteSlots === 1;
			return { noPartialRows: old || exactNew, state: exactNew ? "exact-new" : "old" };
		} finally {
			database.close();
		}
	}, databaseName);
}

test("persistent Chromium death at every vote boundary reopens as old XOR exact-new", async () => {
	const checkpoints = [
		"before-transaction",
		"after-incarnation-read",
		"after-state-read",
		"after-slot-read",
		"after-slot-add",
		"after-state-put",
		"after-outbox-add",
		"after-complete",
	] as const;
	for (const checkpoint of checkpoints) {
		const profileDirectory = mkdtempSync(resolve(tmpdir(), "ts-drp-phase-5c-death-"));
		const databaseName = `phase-5c-death-${checkpoint}-${crypto.randomUUID()}`;
		try {
			const killed = await runArmedDeathChild({
				checkpoint,
				databaseName,
				origin: server?.origin ?? "about:blank",
				profileDirectory,
			});
			expect(killed.signal).toBe("SIGKILL");
			expect(killed.stdout).toContain(`PHASE5C_ARMED:${checkpoint}`);
			const context = await chromium.launchPersistentContext(profileDirectory, { headless: true });
			try {
				const page = await context.newPage();
				await page.goto(server?.origin ?? "about:blank");
				const reopened = await inspectRawDeathState(page, databaseName);
				expect(reopened.noPartialRows).toBe(true);
				if (checkpoint === "before-transaction") expect(reopened.state).toBe("old");
				if (checkpoint === "after-complete") expect(reopened.state).toBe("exact-new");
			} finally {
				await context.close();
			}
		} finally {
			rmSync(profileDirectory, { force: true, recursive: true });
		}
	}
});
