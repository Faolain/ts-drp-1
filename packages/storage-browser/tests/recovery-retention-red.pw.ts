import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";
import type { SnapshotQuarantineDeclaration } from "@ts-drp/storage/snapshot-transfer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { NativeMemoryInput } from "./assets/phase-6a-creator-successor-product-entry.js";
import { captureProcessForest, processClosure, type ProcessIdentity } from "./fixtures/process-forest.js";
import { startProductBrowserServer } from "./fixtures/product-browser-server.js";

interface Observation {
	readonly state: {
		readonly authority: unknown;
		readonly acl: unknown;
		readonly projection: unknown;
		readonly roomId: string;
	};
	readonly issuance: readonly {
		readonly authorSequence: number;
		readonly epoch: number;
		readonly publishState: string;
	}[];
}
type Declaration = Omit<SnapshotQuarantineDeclaration, "exactCanonicalManifestBytes"> & {
	readonly exactCanonicalManifestBytes: readonly number[];
};
const ROOT = resolve(import.meta.dirname, "../../..");
const ENTRY = resolve(import.meta.dirname, "assets/phase-6a-creator-successor-product-entry.ts");

test("required current snapshot survives TTL sweep and hard-process cold recovery", async ({
	browserName,
}, testInfo) => {
	expect(browserName).toBe("chromium");
	const sourceFiles = [
		import.meta.filename,
		ENTRY,
		resolve(import.meta.dirname, "fixtures/product-browser-server.ts"),
		resolve(import.meta.dirname, "../playwright.recovery-retention.config.ts"),
	];
	const hashes = (): unknown =>
		sourceFiles.map((path) => ({ path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") }));
	const sourcesBefore = hashes();
	const profileInput = testInfo.outputPath("profile");
	mkdirSync(profileInput, { recursive: true });
	const profile = realpathSync(profileInput);
	const server = await startProductBrowserServer(ENTRY);
	const events: unknown[] = [];
	let context: BrowserContext | undefined;
	let owned: readonly ProcessIdentity[] = [];
	let terminal = "incomplete";
	const living = (identities: readonly ProcessIdentity[]): readonly ProcessIdentity[] => {
		const forest = captureProcessForest();
		return identities.filter((old) =>
			forest.some(
				(current) => old.pid === current.pid && old.birthToken === current.birthToken && old.command === current.command
			)
		);
	};
	const gone = async (): Promise<void> => {
		await expect.poll(() => living(owned).length, { timeout: 10_000 }).toBe(0);
	};
	const boot = async (): Promise<Page> => {
		context = await chromium.launchPersistentContext(profile, { headless: true });
		const page = context.pages()[0] ?? (await context.newPage());
		await page.goto(server.origin);
		await page.waitForFunction(() => typeof window.phase6aCreatorSuccessorProduct === "object");
		await page.evaluate(() => window.phase6aCreatorSuccessorProduct.boot("native-memory", { nativeStorage: true }));
		const forest = captureProcessForest();
		const roots = forest.filter(
			({ ppid, command }) => ppid === process.pid && command.split(" ").includes(`--user-data-dir=${profile}`)
		);
		expect(roots).toHaveLength(1);
		const root = roots[0];
		if (root === undefined) throw new TypeError("browser root absent");
		owned = processClosure(forest, root.pid);
		events.push({ phase: "boot", owned });
		return page;
	};
	const call = async <T = Observation>(
		page: Page,
		action: NativeMemoryInput["action"],
		epoch: number,
		declaration?: Declaration
	): Promise<T> =>
		page.evaluate(
			async ({ action, epoch, declaration }) =>
				window.phase6aCreatorSuccessorProduct.nativeMemory({
					name: "required-retention-red",
					action,
					epoch,
					nativeGrid: true,
					...(declaration === undefined
						? {}
						: {
								retainedDeclaration: {
									...declaration,
									exactCanonicalManifestBytes: new Uint8Array(declaration.exactCanonicalManifestBytes),
								},
							}),
				}),
			{ action, epoch, declaration }
		) as Promise<T>;
	try {
		let page = await boot();
		await call(page, "create", 0);
		let stable = await call(page, "transition", 0);
		for (let epoch = 1; epoch < 3; epoch += 1) stable = await call(page, "transition", epoch);
		expect(stable.state.authority).toMatchObject({
			epoch: 3,
			lifecycle: "active",
			profileId: "creator-trusted-settlement-v1",
		});
		expect(stable.state.projection).toMatchObject({ blocks: [{ id: "writer-00", kind: "stone", x: 0, y: 0 }] });
		expect(stable.issuance.every(({ publishState }) => publishState === "published")).toBe(true);
		const stableHead = await call<unknown>(page, "retention-head", 3);
		const declaration = await page.evaluate(async () => {
			const result = (await window.phase6aCreatorSuccessorProduct.nativeMemory({
				name: "required-retention-red",
				action: "retention-declaration",
				epoch: 3,
				nativeGrid: true,
			})) as SnapshotQuarantineDeclaration;
			return { ...result, exactCanonicalManifestBytes: Array.from(result.exactCanonicalManifestBytes) };
		});
		// Only this manifest/declaration crosses the process boundary; never snapshot payload bytes.
		await call(page, "close", 3);
		const maintenance = await call<{
			readonly deleted: number;
			readonly temporaryBefore: { readonly scopes: number; readonly chunks: number };
			readonly temporaryAfter: { readonly scopes: number; readonly chunks: number };
			readonly requiredBefore: unknown;
			readonly requiredAfter: unknown;
			readonly clockRestored: boolean;
		}>(page, "retention-sweep", 3, declaration);
		events.push({ phase: "maintenance", stable, stableHead, declaration, maintenance });
		expect(maintenance.deleted).toBeGreaterThanOrEqual(1);
		expect(maintenance.temporaryBefore).toEqual({ scopes: 1, chunks: 1 });
		expect(maintenance.temporaryAfter).toEqual({ scopes: 0, chunks: 0 });
		expect(maintenance.clockRestored).toBe(true);
		const requiredSnapshot = {
			scope: declaration.scope,
			scopeCount: 1,
			manifestIntegrity: true,
			chunkCount: declaration.chunks.length,
			chunks: declaration.chunks.map((descriptor) => ({ ...descriptor, integrity: true })),
		};
		expect(maintenance.requiredBefore).toEqual(requiredSnapshot);
		// Kill the exact owned process identities; no page/realm or payload cache survives.
		for (const identity of [...owned].reverse()) {
			if (living([identity]).length > 0) process.kill(identity.pid, "SIGKILL");
		}
		await context?.close().catch(() => undefined);
		context = undefined;
		await gone();
		events.push({ phase: "hard-cold-boundary", gone: owned });
		page = await boot();
		let reopened: Observation;
		try {
			reopened = await call(page, "reopen", 3, declaration);
		} catch (error) {
			terminal = "recovery-rejected";
			events.push({ phase: "recovery-failure", detail: String(error) });
			throw error;
		}
		expect(reopened.state).toEqual(stable.state);
		// This observation was captured before process death/recovery. A reconstruction fallback cannot satisfy it.
		expect(maintenance.requiredAfter).toEqual(requiredSnapshot);
		expect(await call<unknown>(page, "retention-head", 3)).toEqual(stableHead);
		expect(reopened.issuance).toEqual(stable.issuance);
		const after = await call(page, "issue", 3);
		expect(after.issuance.slice(0, -1)).toEqual(stable.issuance);
		const prior = stable.issuance.at(-1);
		if (prior === undefined) throw new TypeError("prior issuance absent");
		expect(after.issuance.at(-1)).toMatchObject({
			epoch: 3,
			publishState: "published",
			authorSequence: prior.authorSequence + 1,
		});
		expect(after.state.projection).toMatchObject({ blocks: [{ id: "writer-00", kind: "stone", x: 1, y: 0 }] });
		events.push({ phase: "recovered-and-issued", after });
		await call(page, "close", 3);
		terminal = "passed";
	} finally {
		try {
			await context?.close();
			await gone();
			events.push({ phase: "cleanup", processesGone: true });
		} finally {
			await server.close();
			const sourcesAfter = hashes();
			const evidence = {
				terminal,
				sourceCustodyExact: JSON.stringify(sourcesBefore) === JSON.stringify(sourcesAfter),
				sourcesBefore,
				sourcesAfter,
				command: process.argv,
				node: process.version,
				head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
				bundleSha256: server.bundleSha256,
				profile,
				origin: server.origin,
				declarationDiscovery: "explicitly-not-covered",
				events,
			};
			const path = testInfo.outputPath("recovery-retention-evidence.json");
			writeFileSync(path, JSON.stringify(evidence, null, 2), { flag: "wx" });
			await testInfo.attach("recovery-retention-evidence", { path, contentType: "application/json" });
		}
	}
});
