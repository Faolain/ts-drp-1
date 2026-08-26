import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { type Phase4cBrowserServer, startPhase4cBrowserServer } from "./phase-4c-browser-server.js";

const PACKAGE_DIRECTORY = resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, "../..");
const GREEN_READY = ["packages/control-plane/src/creator-trust-advance.ts", "packages/node/src/creator-close.ts"].every(
	(path) => existsSync(resolve(REPOSITORY_ROOT, path))
);

let server: Phase4cBrowserServer | undefined;

interface CreatorLiveCloseApi {
	close(): Promise<void>;
	create(input: Readonly<{ channelName: string; clientId: "alice"; databaseName: string }>): Promise<string>;
	inspectDurableHead(databaseName: string): Promise<
		Readonly<{
			generationId: string;
			references: readonly Readonly<{ byteLength: number; digest: string }>[];
			revision: number;
		}>
	>;
	join(input: Readonly<{ channelName: string; clientId: "bob"; databaseName: string; invite: string }>): Promise<void>;
	sealEpoch(): Promise<
		Readonly<{
			epoch: 0;
			lifecycle: "successor-pending-adoption";
			ok: true;
			successorAnchorDigest: string;
			successorEpoch: 1;
		}>
	>;
	send(text: string): Promise<void>;
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
	expect(after.revision).toBe(before.revision + 1);
	expect(after.generationId).not.toBe(before.generationId);
	expect(after.references).toEqual(expect.arrayContaining(before.references.slice(1)));
	expect(after.references).not.toContainEqual(before.references[0]);
	expect(after.references.length).toBe(before.references.length + 2);

	const status = await page.evaluate(() => window.phase5eCreatorLiveClose.status());
	expect(status).toEqual({
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

test("does not let a joined peer claim creator close authority", async ({ browser }) => {
	const run = crypto.randomUUID();
	const channelName = `phase5e-live-peer-${run}`;
	const creator = await browser.newPage();
	const peer = await browser.newPage();
	try {
		await Promise.all([creator.goto(server?.origin ?? "about:blank"), peer.goto(server?.origin ?? "about:blank")]);
		const invite = await creator.evaluate((input) => window.phase5eCreatorLiveClose.create(input), {
			channelName,
			clientId: "alice",
			databaseName: `phase5e-live-creator-${run}`,
		} as const);
		await peer.evaluate((input) => window.phase5eCreatorLiveClose.join(input), {
			channelName,
			clientId: "bob",
			databaseName: `phase5e-live-peer-${run}`,
			invite,
		} as const);
		await expect(peer.evaluate(() => window.phase5eCreatorLiveClose.sealEpoch())).rejects.toThrow();
		await creator.evaluate(() => window.phase5eCreatorLiveClose.close());
		await peer.evaluate(() => window.phase5eCreatorLiveClose.close());
	} finally {
		await Promise.all([creator.close(), peer.close()]);
	}
});
