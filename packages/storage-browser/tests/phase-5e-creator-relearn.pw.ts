import { type BrowserType, chromium, expect, firefox, test, webkit } from "@playwright/test";
import { decodeCanonical } from "@ts-drp/canonical";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { type Phase4cBrowserServer, startPhase4cBrowserServer } from "./phase-4c-browser-server.js";

const PACKAGE_DIRECTORY = resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, "../..");
const DEATH_CHILD = resolve(import.meta.dirname, "process/phase-5e-creator-relearn-death-child.ts");
const GREEN_READY = ["packages/network/src/seal.ts", "packages/node/src/creator-seal.ts"].every((path) =>
	existsSync(resolve(REPOSITORY_ROOT, path))
);
const profiles: string[] = [];
let server: Phase4cBrowserServer | undefined;

test.beforeAll(async () => {
	if (!GREEN_READY) return;
	server = await startPhase4cBrowserServer({
		entryPoint: resolve(PACKAGE_DIRECTORY, "tests/assets/phase-5e-creator-relearn-entry.ts"),
	});
});

test.afterAll(async () => {
	await server?.close();
	for (const profile of profiles.splice(0)) rmSync(profile, { force: true, recursive: true });
});
test.skip(!GREEN_READY, "D.107c creator re-learn owners are intentionally absent in RED");

function browserType(name: string): BrowserType {
	if (name === "firefox") return firefox;
	if (name === "webkit") return webkit;
	return chromium;
}

function profile(label: string): string {
	const path = mkdtempSync(join(tmpdir(), `ts-drp-phase5e-relearn-${label}-`));
	profiles.push(path);
	return path;
}

function jsonEvidence(value: Readonly<Record<string, unknown>>): unknown {
	const carrier = value.carrier as Readonly<Record<string, Uint8Array>>;
	return {
		...value,
		carrier: {
			exactCanonicalPreimageBytes: Array.from(carrier.exactCanonicalPreimageBytes),
			signature: Array.from(carrier.signature),
		},
		exactCanonicalCommitQcBytes: Array.from(value.exactCanonicalCommitQcBytes as Uint8Array),
		exactCanonicalCutValueBytes: Array.from(value.exactCanonicalCutValueBytes as Uint8Array),
		exactCanonicalTrustStateRecordBytes: Array.from(value.exactCanonicalTrustStateRecordBytes as Uint8Array),
		signerPublicKey: Array.from(value.signerPublicKey as Uint8Array),
	};
}

function childExit(child: ChildProcess): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
	return new Promise((resolvePromise) => {
		child.addListener("exit", (code, signal) => resolvePromise(Object.freeze({ code, signal })));
	});
}

function persisted(child: ChildProcess): Promise<unknown> {
	return new Promise((resolvePromise, reject) => {
		const timeout = setTimeout(() => reject(new Error("peer persistence child timed out")), 30_000);
		const stdout = child.stdout;
		if (stdout === null) {
			clearTimeout(timeout);
			reject(new Error("peer persistence child stdout is unavailable"));
			return;
		}
		let buffered = "";
		child.addListener("error", reject);
		stdout.setEncoding("utf8");
		stdout.addListener("data", (chunk: string) => {
			buffered += chunk;
			const match = /(?:^|\n)PHASE5E_PERSISTED:(\{[^\n]*\})(?:\n|$)/u.exec(buffered);
			if (match?.[1] === undefined) return;
			clearTimeout(timeout);
			resolvePromise(JSON.parse(match[1]) as unknown);
		});
	});
}

test("persists peer evidence before acknowledgement and serves it after genuine process death", async ({
	page,
}, testInfo) => {
	await page.goto(server?.origin ?? "about:blank");
	const sourceDatabase = `phase5e-source-${crypto.randomUUID()}`;
	const peerDatabase = `phase5e-peer-${crypto.randomUUID()}`;
	const exact = (await page.evaluate(
		(name) => window.phase5eCreatorRelearn.createSource(name),
		sourceDatabase
	)) as unknown as Readonly<Record<string, unknown>>;
	const vote = decodeCanonical(
		(exact.carrier as Readonly<{ exactCanonicalPreimageBytes: Uint8Array }>).exactCanonicalPreimageBytes
	) as Readonly<Record<string, unknown>> | undefined;
	if (vote === undefined || typeof vote.objectId !== "string" || typeof vote.signerId !== "string") {
		throw new Error("invalid genuine peer evidence identity");
	}
	const selectedProfile = profile("death");
	const child = spawn(
		"pnpm",
		[
			"exec",
			"tsx",
			DEATH_CHILD,
			JSON.stringify({
				browserName: testInfo.project.name,
				databaseName: peerDatabase,
				evidence: jsonEvidence(exact),
				origin: server?.origin,
				profileDirectory: selectedProfile,
			}),
		],
		{ cwd: REPOSITORY_ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] }
	);
	if (child.pid === undefined) throw new Error("peer persistence child did not start");
	const exit = childExit(child);
	try {
		expect(await persisted(child)).toMatchObject({ ok: true });
		process.kill(-child.pid, "SIGKILL");
		expect(await exit).toEqual({ code: null, signal: "SIGKILL" });
		const context = await browserType(testInfo.project.name).launchPersistentContext(selectedProfile, {
			headless: true,
		});
		try {
			const reopened = context.pages()[0] ?? (await context.newPage());
			await reopened.goto(server?.origin ?? "about:blank");
			const served = await reopened.evaluate(
				({ databaseName, objectId, signerId }) =>
					window.phase5eCreatorRelearn.servePeer(databaseName, objectId, signerId),
				{ databaseName: peerDatabase, objectId: vote.objectId, signerId: vote.signerId }
			);
			expect(served).not.toBeNull();
			expect(served).toEqual(exact);
		} finally {
			await context.close();
		}
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// The dedicated process group is already absent.
			}
		}
	}
});

test("deletion stalls without peers, queries both persistent peers, and terminalizes conflict", async ({
	page: _page,
}, testInfo) => {
	const type = browserType(testInfo.project.name);
	const creatorContext = await type.launchPersistentContext(profile("creator"), { headless: true });
	const peerAContext = await type.launchPersistentContext(profile("peer-a"), { headless: true });
	const peerBContext = await type.launchPersistentContext(profile("peer-b"), { headless: true });
	try {
		const creator = creatorContext.pages()[0] ?? (await creatorContext.newPage());
		const peerA = peerAContext.pages()[0] ?? (await peerAContext.newPage());
		const peerB = peerBContext.pages()[0] ?? (await peerBContext.newPage());
		await Promise.all([creator, peerA, peerB].map(async (page) => page.goto(server?.origin ?? "about:blank")));
		const authorityDatabase = `phase5e-authority-${crypto.randomUUID()}`;
		const recoveryDatabase = `phase5e-recovery-${crypto.randomUUID()}`;
		const peerADatabase = `phase5e-peer-a-${crypto.randomUUID()}`;
		const peerBDatabase = `phase5e-peer-b-${crypto.randomUUID()}`;
		const exact = await creator.evaluate((name) => window.phase5eCreatorRelearn.createSource(name), authorityDatabase);
		const vote = decodeCanonical(exact.carrier.exactCanonicalPreimageBytes) as Readonly<Record<string, unknown>>;
		if (typeof vote.objectId !== "string" || typeof vote.signerId !== "string") {
			throw new Error("invalid creator peer identity");
		}
		await Promise.all([
			peerA.evaluate(({ name, exact }) => window.phase5eCreatorRelearn.persistPeer(name, exact), {
				exact,
				name: peerADatabase,
			}),
			peerB.evaluate(({ name, exact }) => window.phase5eCreatorRelearn.persistPeer(name, exact), {
				exact,
				name: peerBDatabase,
			}),
		]);
		const [servedA, servedB] = await Promise.all([
			peerA.evaluate(
				({ databaseName, objectId, signerId }) =>
					window.phase5eCreatorRelearn.servePeer(databaseName, objectId, signerId),
				{ databaseName: peerADatabase, objectId: vote.objectId, signerId: vote.signerId }
			),
			peerB.evaluate(
				({ databaseName, objectId, signerId }) =>
					window.phase5eCreatorRelearn.servePeer(databaseName, objectId, signerId),
				{ databaseName: peerBDatabase, objectId: vote.objectId, signerId: vote.signerId }
			),
		]);
		expect(servedA).toEqual(exact);
		expect(servedB).toEqual(exact);
		await creator.evaluate((name) => window.phase5eCreatorRelearn.deleteLocal(name), authorityDatabase);
		const stalled = await creator.evaluate(
			({ authority, recovery }) => window.phase5eCreatorRelearn.recover(authority, recovery, {}),
			{ authority: authorityDatabase, recovery: recoveryDatabase }
		);
		expect(stalled).toMatchObject({ ok: false, reason: "NO_AUTHENTICATED_EVIDENCE", status: "stalled" });
		const recovered = await creator.evaluate(
			({ authority, peerA, peerB, recovery }) =>
				window.phase5eCreatorRelearn.recover(authority, recovery, { "peer-a": peerA, "peer-b": peerB }),
			{ authority: authorityDatabase, peerA: servedA, peerB: servedB, recovery: recoveryDatabase }
		);
		expect(recovered).toMatchObject({ ok: true, queriedPeers: ["peer-a", "peer-b"], status: "ready" });
		expect(recovered).toMatchObject({ evidence: exact });
		const restored = await creator.evaluate(
			({ databaseName, objectId, signerId }) =>
				window.phase5eCreatorRelearn.servePeer(databaseName, objectId, signerId),
			{ databaseName: recoveryDatabase, objectId: vote.objectId, signerId: vote.signerId }
		);
		expect(restored).toEqual(exact);
		const conflict = await creator.evaluate(
			async ({ authority, exact, recovery }) => {
				const other = await window.phase5eCreatorRelearn.createSource(`${authority}-conflict`, "f".repeat(64));
				return window.phase5eCreatorRelearn.recover(authority, recovery, { "peer-a": exact, "peer-b": other });
			},
			{ authority: authorityDatabase, exact, recovery: `${recoveryDatabase}-conflict` }
		);
		expect(conflict).toMatchObject({ ok: false, reason: "EQUIVOCATION", status: "equivocation" });
	} finally {
		await Promise.all([creatorContext.close(), peerAContext.close(), peerBContext.close()]);
	}
});
