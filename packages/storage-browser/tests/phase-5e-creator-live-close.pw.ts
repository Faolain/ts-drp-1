import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { type Phase4cBrowserServer, startPhase4cBrowserServer } from "./phase-4c-browser-server.js";

const PACKAGE_DIRECTORY = resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, "../..");

function hasPackageExport(packagePath: string, subpath: string): boolean {
	const manifest = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, packagePath), "utf8")) as Readonly<{
		readonly exports?: Readonly<Record<string, unknown>>;
	}>;
	return Object.hasOwn(manifest.exports ?? {}, subpath);
}

function hasOrderedAlias(source: string, specific: string, bare: string): boolean {
	const specificIndex = source.indexOf(`"${specific}"`);
	const bareIndex = source.indexOf(`"${bare}"`);
	return specificIndex >= 0 && (bareIndex < 0 || specificIndex < bareIndex);
}

function greenReady(): boolean {
	if (
		!["packages/control-plane/src/creator-trust-advance.ts", "packages/node/src/creator-close.ts"].every((path) =>
			existsSync(resolve(REPOSITORY_ROOT, path))
		)
	)
		return false;
	if (
		!hasPackageExport("packages/control-plane/package.json", "./creator-trust-advance") ||
		!hasPackageExport("packages/node/package.json", "./creator-close")
	)
		return false;
	const vite = readFileSync(resolve(REPOSITORY_ROOT, "vite.config.mts"), "utf8");
	return (
		hasOrderedAlias(vite, "@ts-drp/control-plane/creator-trust-advance", "@ts-drp/control-plane") &&
		hasOrderedAlias(vite, "@ts-drp/node/creator-close", "@ts-drp/node")
	);
}

const GREEN_READY = greenReady();

interface ModelRef {
	readonly byteLength: number;
	readonly digest: string;
}

function expectedCombinedClosure(
	input: Readonly<{
		current: readonly ModelRef[];
		currentTrustRef: ModelRef;
		proofRefs: readonly ModelRef[];
		successorTrustRef: ModelRef;
	}>
): readonly ModelRef[] {
	const retained = input.current.filter(({ digest }) => digest !== input.currentTrustRef.digest);
	if (retained.length !== input.current.length - 1) throw new TypeError("current trust ref must occur exactly once");
	return [...retained, input.successorTrustRef, ...input.proofRefs].sort((left, right) =>
		left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0
	);
}

let server: Phase4cBrowserServer | undefined;

interface CreatorLiveCloseApi {
	close(): Promise<void>;
	create(input: Readonly<{ channelName: string; clientId: "alice"; databaseName: string }>): Promise<string>;
	inspectDurableHead(databaseName: string): Promise<
		Readonly<{
			generationId: string;
			references: readonly Readonly<{ byteLength: number; digest: string }>[];
			revision: number;
			trustRef: Readonly<{ byteLength: number; digest: string }>;
		}>
	>;
	join(
		input: Readonly<{ channelName: string; clientId: "bob" | "carol"; databaseName: string; invite: string }>
	): Promise<void>;
	sealEpoch(): Promise<
		Readonly<{
			closedVertexCount: number;
			commitQcRef: Readonly<{ byteLength: number; digest: string }>;
			currentTrustRef: Readonly<{ byteLength: number; digest: string }>;
			cutValueRef: Readonly<{ byteLength: number; digest: string }>;
			epoch: 0;
			lifecycle: "successor-pending-adoption";
			ok: true;
			successorAnchorDigest: string;
			successorEpoch: 1;
			successorTrustRef: Readonly<{ byteLength: number; digest: string }>;
		}>
	>;
	send(text: string): Promise<void>;
	snapshot(): Readonly<{ readonly accepted: readonly Readonly<{ readonly text: string }>[] }>;
	status(): Readonly<Record<string, unknown>>;
}

declare global {
	interface Window {
		readonly phase5eCreatorLiveClose: CreatorLiveCloseApi;
	}
}

test.beforeAll(async () => {
	if (!GREEN_READY) return;
	server = await startPhase4cBrowserServer({
		entryPoint: resolve(PACKAGE_DIRECTORY, "tests/assets/phase-5e-creator-live-close-entry.ts"),
	});
});

test.afterAll(async () => server?.close());
test.skip(!GREEN_READY, "D.107d live close owners are intentionally absent in RED");

test("closes a genuine non-empty creator room and terminalizes the old live handle", async ({ page }) => {
	await page.goto(server?.origin ?? "about:blank");
	const run = crypto.randomUUID();
	const databaseName = `phase5e-live-close-${run}`;
	const channelName = `phase5e-live-close-${run}`;
	const invite = await page.evaluate((input) => window.phase5eCreatorLiveClose.create(input), {
		channelName,
		clientId: "alice",
		databaseName,
	} as const);
	await page.evaluate(() => window.phase5eCreatorLiveClose.send("close me while live"));
	await expect
		.poll(() => page.evaluate(() => window.phase5eCreatorLiveClose.snapshot().accepted.map(({ text }) => text)))
		.toContain("close me while live");
	const beforeStatus = await page.evaluate(() => window.phase5eCreatorLiveClose.status());
	const before = await page.evaluate((name) => window.phase5eCreatorLiveClose.inspectDurableHead(name), databaseName);
	const sealed = await page.evaluate(() => window.phase5eCreatorLiveClose.sealEpoch());
	const after = await page.evaluate((name) => window.phase5eCreatorLiveClose.inspectDurableHead(name), databaseName);

	expect(invite).toMatch(/^[0-9a-f]+$/u);
	expect(sealed).toMatchObject({
		epoch: 0,
		lifecycle: "successor-pending-adoption",
		ok: true,
		successorEpoch: 1,
	});
	expect(sealed.successorAnchorDigest).toMatch(/^[0-9a-f]{64}$/u);
	expect(sealed.closedVertexCount).toBeGreaterThan(0);
	expect(sealed.currentTrustRef).toEqual(before.trustRef);
	expect(after.revision).toBe(before.revision + 1);
	expect(after.generationId).not.toBe(before.generationId);
	expect(after.trustRef).toEqual(sealed.successorTrustRef);
	expect(after.references).toEqual(
		expectedCombinedClosure({
			current: before.references,
			currentTrustRef: sealed.currentTrustRef,
			proofRefs: [sealed.cutValueRef, sealed.commitQcRef],
			successorTrustRef: sealed.successorTrustRef,
		})
	);

	const status = await page.evaluate(() => window.phase5eCreatorLiveClose.status());
	expect(beforeStatus).toEqual({
		closeAuthority: "available",
		continuity: "continuous",
		lifecycle: "active",
		trust: {
			byzantineFaultTolerant: false,
			kind: "creator-certified",
			quorum: 1,
			signerCount: 1,
			text: "Creator-certified; one of one; not Byzantine-fault-tolerant.",
		},
	});
	expect(status).toEqual({
		closeAuthority: "unavailable",
		continuity: "continuous",
		lifecycle: "successor-pending-adoption",
		trust: {
			byzantineFaultTolerant: false,
			kind: "creator-certified",
			quorum: 1,
			signerCount: 1,
			text: "Creator-certified; one of one; not Byzantine-fault-tolerant.",
		},
	});
	await expect(page.evaluate(() => window.phase5eCreatorLiveClose.send("too late"))).rejects.toThrow();
	await expect(page.evaluate(() => window.phase5eCreatorLiveClose.sealEpoch())).rejects.toThrow();
	await page.evaluate(() => window.phase5eCreatorLiveClose.close());
});

test("does not let a connected joined peer claim creator close authority", async ({ context }) => {
	const run = crypto.randomUUID();
	const channelName = `phase5e-live-peer-${run}`;
	const creator = await context.newPage();
	const peer = await context.newPage();
	const latePeer = await context.newPage();
	try {
		await Promise.all([
			creator.goto(server?.origin ?? "about:blank"),
			peer.goto(server?.origin ?? "about:blank"),
			latePeer.goto(server?.origin ?? "about:blank"),
		]);
		const invite = await creator.evaluate((input) => window.phase5eCreatorLiveClose.create(input), {
			channelName,
			clientId: "alice",
			databaseName: `phase5e-live-creator-${run}`,
		} as const);
		await peer.evaluate((input) => window.phase5eCreatorLiveClose.join(input), {
			channelName,
			clientId: "carol",
			databaseName: `phase5e-live-peer-${run}`,
			invite,
		} as const);
		await creator.evaluate(() => window.phase5eCreatorLiveClose.send("peer must receive this"));
		await expect
			.poll(() => peer.evaluate(() => window.phase5eCreatorLiveClose.snapshot().accepted.map(({ text }) => text)))
			.toContain("peer must receive this");
		expect(await peer.evaluate(() => window.phase5eCreatorLiveClose.status())).toMatchObject({
			closeAuthority: "unavailable",
			lifecycle: "active",
		});
		await expect(peer.evaluate(() => window.phase5eCreatorLiveClose.sealEpoch())).rejects.toThrow(
			/creator close authority/iu
		);
		expect(await creator.evaluate(() => window.phase5eCreatorLiveClose.sealEpoch())).toMatchObject({
			lifecycle: "successor-pending-adoption",
			ok: true,
		});
		await latePeer.evaluate((input) => window.phase5eCreatorLiveClose.join(input), {
			channelName,
			clientId: "bob",
			databaseName: `phase5e-live-late-peer-${run}`,
			invite,
		} as const);
		await expect
			.poll(() => latePeer.evaluate(() => window.phase5eCreatorLiveClose.snapshot().accepted.map(({ text }) => text)))
			.toContain("peer must receive this");
		await creator.evaluate(() => window.phase5eCreatorLiveClose.close());
		await peer.evaluate(() => window.phase5eCreatorLiveClose.close());
		await latePeer.evaluate(() => window.phase5eCreatorLiveClose.close());
	} finally {
		await Promise.all([creator.close(), peer.close(), latePeer.close()]);
	}
});
