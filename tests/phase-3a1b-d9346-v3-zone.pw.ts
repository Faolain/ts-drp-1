import { expect, type Page, test } from "@playwright/test";
import { resolve } from "node:path";

import { importWorkspacePackageExportFile } from "./fixtures/shared/workspace-package-export-file.mjs";

const { decodeCanonical } = (
	await importWorkspacePackageExportFile({
		expectedPackageName: "@ts-drp/canonical",
		exportKey: ".",
		packageDirectory: resolve(import.meta.dirname, "../packages/canonical"),
	})
).module as Readonly<{ decodeCanonical(bytes: Uint8Array): unknown }>;

interface ZoneSnapshot {
	readonly acceptedOperationDigest: string;
	readonly blocks: readonly Readonly<{
		readonly id: string;
		readonly kind: string;
		readonly x: number;
		readonly y: number;
	}>[];
	readonly durableVertexCount: number;
	readonly enrollment: string;
	readonly invite: string;
	readonly localAuthor: string;
	readonly localPeerId: string;
	readonly ready: boolean;
	readonly rawTransport: Readonly<{
		readonly fallbackCount: number;
		readonly received: number;
		readonly sent: number;
		readonly links: readonly Readonly<{
			readonly label: "ts-drp-ephemeral/1";
			readonly maxRetransmits: 0;
			readonly ordered: false;
			readonly peerId: string;
		}>[];
	}>;
	readonly transientPositions: Readonly<Record<string, Readonly<{ readonly x: number; readonly y: number }>>>;
	readonly transportPeerAuthors: readonly Readonly<{ readonly author: string; readonly peerId: string }>[];
	readonly zoneId: string;
}

interface ZoneApi {
	activateMigration(receipt: Awaited<ReturnType<ZoneApi["rehearseMigration"]>>): Promise<
		Readonly<{
			readonly activated: true;
			readonly activationDecisionDigest: string;
			readonly activationVertexDigest: string;
			readonly targetAnchorDigest: string;
		}>
	>;
	close(): Promise<void>;
	placeBlock(
		input: Readonly<{ readonly id: string; readonly kind: string; readonly x: number; readonly y: number }>
	): Promise<void>;
	rehearseMigration(): Promise<
		Readonly<{
			readonly activated: false;
			readonly applicationStateDigest: string;
			readonly exactCanonicalRecordBytes: Uint8Array;
			readonly importedOperationCount: number;
			readonly recordDigest: string;
			readonly recordVertexDigest: string;
			readonly targetAnchorDigest: string;
		}>
	>;
	snapshot(): ZoneSnapshot;
}

interface NetworkSnapshot {
	readonly connectionBudget: Readonly<{
		readonly maxConnections: number;
		readonly maxParallelDials: number;
		readonly role: "browser";
	}>;
	readonly connections: readonly unknown[];
	readonly peerId: string;
}

declare global {
	interface Window {
		readonly __TS_DRP_GRID_SESSION__?: { snapshot(): NetworkSnapshot };
		readonly __TS_DRP_V3_ZONE__?: ZoneApi;
	}
}

const DIGEST = /^[0-9a-f]{64}$/u;

function escaped(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function openGrid(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForFunction(() => window.__TS_DRP_GRID_SESSION__ !== undefined);
	await expect(page.locator("#loadingMessage")).toBeHidden();
	await page.waitForFunction(() => window.__TS_DRP_V3_ZONE__ !== undefined, undefined, { timeout: 10_000 });
}

async function zone(page: Page): Promise<ZoneSnapshot> {
	return page.evaluate(() => {
		const api = window.__TS_DRP_V3_ZONE__;
		if (api === undefined) throw new Error("D9346_V3_ZONE_API_ABSENT");
		return api.snapshot();
	});
}

async function networkSnapshot(page: Page): Promise<NetworkSnapshot> {
	return page.evaluate(() => {
		const session = window.__TS_DRP_GRID_SESSION__;
		if (session === undefined) throw new Error("D9346_GRID_NETWORK_SESSION_ABSENT");
		return session.snapshot();
	});
}

async function expectReciprocalRawUnreliableLinks(
	sender: Page,
	receiver: Page,
	senderPeerId: string,
	receiverPeerId: string
): Promise<void> {
	await expect
		.poll(async () => (await zone(sender)).rawTransport.links)
		.toEqual([{ label: "ts-drp-ephemeral/1", maxRetransmits: 0, ordered: false, peerId: receiverPeerId }]);
	await expect
		.poll(async () => (await zone(receiver)).rawTransport.links)
		.toEqual([{ label: "ts-drp-ephemeral/1", maxRetransmits: 0, ordered: false, peerId: senderPeerId }]);
	expect((await zone(sender)).rawTransport.fallbackCount).toBe(0);
	expect((await zone(receiver)).rawTransport.fallbackCount).toBe(0);
}

async function expectOneMeasuredRawMovement(input: {
	readonly acceptedOperationDigest: string;
	readonly durableVertexCount: number;
	readonly key: string;
	readonly receiver: Page;
	readonly receiverPeerId: string;
	readonly sender: Page;
	readonly senderPeerId: string;
}): Promise<void> {
	await expectReciprocalRawUnreliableLinks(input.sender, input.receiver, input.senderPeerId, input.receiverPeerId);
	await input.sender.evaluate(() => {
		const selected = document.activeElement;
		if (selected instanceof HTMLElement) selected.blur();
	});
	expect(
		await input.sender.evaluate(() => {
			const selected = document.activeElement;
			return !(
				selected instanceof HTMLInputElement ||
				selected instanceof HTMLTextAreaElement ||
				selected instanceof HTMLSelectElement
			);
		})
	).toBe(true);
	const [senderBefore, receiverBefore] = await Promise.all([zone(input.sender), zone(input.receiver)]);
	const positionBefore = receiverBefore.transientPositions[input.senderPeerId];
	await input.sender.keyboard.press(input.key);
	await expect
		.poll(async () => {
			const [senderAfter, receiverAfter] = await Promise.all([zone(input.sender), zone(input.receiver)]);
			return {
				positionChanged:
					JSON.stringify(receiverAfter.transientPositions[input.senderPeerId]) !== JSON.stringify(positionBefore),
				receivedAdvanced: receiverAfter.rawTransport.received > receiverBefore.rawTransport.received,
				sentAdvanced: senderAfter.rawTransport.sent > senderBefore.rawTransport.sent,
			};
		})
		.toEqual({ positionChanged: true, receivedAdvanced: true, sentAdvanced: true });
	for (const observed of await Promise.all([zone(input.sender), zone(input.receiver)])) {
		expect(observed.durableVertexCount).toBe(input.durableVertexCount);
		expect(observed.acceptedOperationDigest).toBe(input.acceptedOperationDigest);
	}
}

function expectWithinInstalledBudget(snapshot: NetworkSnapshot): void {
	expect(snapshot.connectionBudget).toEqual({ maxConnections: 48, maxParallelDials: 6, role: "browser" });
	expect(snapshot.connections.length).toBeLessThanOrEqual(snapshot.connectionBudget.maxConnections);
}

test("two real network clients recover and converge one durable v3 zone while movement stays transient", async ({
	browser,
}) => {
	test.setTimeout(240_000);
	const creatorContext = await browser.newContext();
	const joinerContext = await browser.newContext();
	const creator = await creatorContext.newPage();
	let joiner = await joinerContext.newPage();
	try {
		await Promise.all([openGrid(creator), openGrid(joiner)]);
		const [creatorNetwork, joinerNetwork] = await Promise.all([networkSnapshot(creator), networkSnapshot(joiner)]);
		expectWithinInstalledBudget(creatorNetwork);
		expectWithinInstalledBudget(joinerNetwork);
		const creatorPeerId = creatorNetwork.peerId;
		const joinerPeerId = joinerNetwork.peerId;
		const [creatorEnrollment, joinerEnrollment] = await Promise.all([zone(creator), zone(joiner)]);
		expect(creatorEnrollment.ready).toBe(false);
		expect(joinerEnrollment.ready).toBe(false);
		expect(creatorEnrollment.localPeerId).toBe(creatorPeerId);
		expect(joinerEnrollment.localPeerId).toBe(joinerPeerId);
		expect(creatorEnrollment.localAuthor).toMatch(DIGEST);
		expect(joinerEnrollment.localAuthor).toMatch(DIGEST);
		expect(creatorEnrollment.enrollment).not.toBe(joinerEnrollment.enrollment);
		expect(creatorEnrollment.transientPositions).toEqual({});
		expect(joinerEnrollment.transientPositions).toEqual({});

		await creator.fill("#zoneMemberEnrollment", joinerEnrollment.enrollment);
		await creator.click("#createGrid");
		await expect.poll(async () => (await zone(creator)).ready).toBe(true);
		const created = await zone(creator);
		expect(created.zoneId).toMatch(new RegExp(`^${escaped(creatorPeerId)}:[0-9a-f]{32}$`, "u"));
		expect(created.invite).toMatch(/^[0-9a-f]+$/u);
		expect(created.durableVertexCount).toBe(1);
		expect(created.transportPeerAuthors).toEqual([
			{ author: creatorEnrollment.localAuthor, peerId: creatorPeerId },
			{ author: joinerEnrollment.localAuthor, peerId: joinerPeerId },
		]);

		await joiner.fill("#gridInput", created.invite);
		await joiner.click("#joinGrid");
		await expect.poll(async () => (await zone(joiner)).zoneId).toBe(created.zoneId);
		await expect.poll(async () => (await zone(creator)).durableVertexCount).toBe(2);
		await expect.poll(async () => (await zone(joiner)).durableVertexCount).toBe(2);
		expect((await zone(joiner)).transportPeerAuthors).toEqual(created.transportPeerAuthors);
		expect((await zone(joiner)).acceptedOperationDigest).toBe((await zone(creator)).acceptedOperationDigest);
		expect((await zone(creator)).rawTransport.fallbackCount).toBe(0);
		expect((await zone(joiner)).rawTransport.fallbackCount).toBe(0);

		await creator.evaluate(() => window.__TS_DRP_V3_ZONE__?.placeBlock({ id: "spawn", kind: "stone", x: 2, y: 3 }));
		await expect.poll(async () => (await zone(creator)).blocks).toEqual([{ id: "spawn", kind: "stone", x: 2, y: 3 }]);
		await expect.poll(async () => (await zone(joiner)).blocks).toEqual([{ id: "spawn", kind: "stone", x: 2, y: 3 }]);
		await expect(creator.locator('[data-block-id="spawn"]')).toBeVisible();
		await expect(joiner.locator('[data-block-id="spawn"]')).toBeVisible();

		const afterBlock = await zone(creator);
		const joinedAfterBlock = await zone(joiner);
		expect(afterBlock.acceptedOperationDigest).toMatch(DIGEST);
		expect(joinedAfterBlock.acceptedOperationDigest).toBe(afterBlock.acceptedOperationDigest);
		expect(afterBlock.durableVertexCount).toBe(3);
		expect(joinedAfterBlock.durableVertexCount).toBe(3);
		await expectOneMeasuredRawMovement({
			acceptedOperationDigest: afterBlock.acceptedOperationDigest,
			durableVertexCount: afterBlock.durableVertexCount,
			key: "w",
			receiver: joiner,
			receiverPeerId: joinerPeerId,
			sender: creator,
			senderPeerId: creatorPeerId,
		});
		await expectOneMeasuredRawMovement({
			acceptedOperationDigest: afterBlock.acceptedOperationDigest,
			durableVertexCount: afterBlock.durableVertexCount,
			key: "d",
			receiver: creator,
			receiverPeerId: creatorPeerId,
			sender: joiner,
			senderPeerId: joinerPeerId,
		});

		await joiner.evaluate(() => window.__TS_DRP_V3_ZONE__?.close());
		await joiner.close();
		await creator.evaluate(() => window.__TS_DRP_V3_ZONE__?.placeBlock({ id: "offline", kind: "wood", x: 5, y: 8 }));
		await expect.poll(async () => (await zone(creator)).blocks).toHaveLength(2);
		const afterOfflineProgress = await zone(creator);
		expect(afterOfflineProgress.durableVertexCount).toBe(afterBlock.durableVertexCount + 1);
		expect(afterOfflineProgress.acceptedOperationDigest).not.toBe(afterBlock.acceptedOperationDigest);
		await expect(creator.locator('[data-block-id="offline"]')).toBeVisible();

		joiner = await joinerContext.newPage();
		await openGrid(joiner);
		const reopened = await zone(joiner);
		expect(reopened.enrollment).toBe(joinerEnrollment.enrollment);
		expect(reopened.localAuthor).toBe(joinerEnrollment.localAuthor);
		expect(reopened.localPeerId).toBe(joinerPeerId);
		expect(reopened.transientPositions).toEqual({});
		await joiner.fill("#gridInput", created.invite);
		await joiner.click("#joinGrid");
		await expect.poll(async () => (await zone(joiner)).blocks).toEqual((await zone(creator)).blocks);
		expect((await zone(joiner)).rawTransport.fallbackCount).toBe(0);
		expect((await zone(joiner)).acceptedOperationDigest).toBe((await zone(creator)).acceptedOperationDigest);
		expect((await zone(joiner)).transientPositions).toEqual({});
		expect((await zone(joiner)).durableVertexCount).toBe(afterOfflineProgress.durableVertexCount);
		await expect(joiner.locator('[data-block-id="offline"]')).toBeVisible();

		await expectOneMeasuredRawMovement({
			acceptedOperationDigest: afterOfflineProgress.acceptedOperationDigest,
			durableVertexCount: afterOfflineProgress.durableVertexCount,
			key: "a",
			receiver: joiner,
			receiverPeerId: joinerPeerId,
			sender: creator,
			senderPeerId: creatorPeerId,
		});

		await joiner.evaluate(() => window.__TS_DRP_V3_ZONE__?.placeBlock({ id: "rejoined", kind: "glass", x: 13, y: 21 }));
		await expect.poll(async () => (await zone(creator)).blocks).toHaveLength(3);
		await expect.poll(async () => (await zone(joiner)).blocks).toEqual((await zone(creator)).blocks);
		expect((await zone(creator)).durableVertexCount).toBe(afterOfflineProgress.durableVertexCount + 1);
		expect((await zone(joiner)).durableVertexCount).toBe(afterOfflineProgress.durableVertexCount + 1);
		expect((await zone(joiner)).acceptedOperationDigest).toBe((await zone(creator)).acceptedOperationDigest);
		expect((await zone(joiner)).acceptedOperationDigest).not.toBe(afterOfflineProgress.acceptedOperationDigest);
		await expect(creator.locator('[data-block-id="rejoined"]')).toBeVisible();
		await expect(joiner.locator('[data-block-id="rejoined"]')).toBeVisible();

		await expect(joiner.evaluate(() => window.__TS_DRP_V3_ZONE__?.rehearseMigration())).rejects.toThrow();
		const rehearsal = await creator.evaluate(() => window.__TS_DRP_V3_ZONE__?.rehearseMigration());
		expect(rehearsal).toMatchObject({ activated: false, importedOperationCount: 3 });
		expect(rehearsal?.applicationStateDigest).toMatch(DIGEST);
		expect(rehearsal?.recordDigest).toMatch(DIGEST);
		expect(rehearsal?.recordVertexDigest).toMatch(DIGEST);
		expect(rehearsal?.targetAnchorDigest).toMatch(DIGEST);
		if (rehearsal === undefined) throw new TypeError("zone migration rehearsal is absent");
		const record = decodeCanonical(rehearsal.exactCanonicalRecordBytes);
		const targetObjectId = Reflect.get(record as object, "targetObjectId");
		expect(targetObjectId).toMatch(/^.+:[0-9a-f]{32}$/u);
		await joiner.evaluate(() => window.__TS_DRP_V3_ZONE__?.close());
		await joiner.close();
		const activation = await creator.evaluate(
			(receipt) => window.__TS_DRP_V3_ZONE__?.activateMigration(receipt),
			rehearsal
		);
		expect(activation).toMatchObject({
			activated: true,
			activationDecisionDigest: expect.stringMatching(DIGEST),
			activationVertexDigest: expect.stringMatching(DIGEST),
			targetAnchorDigest: rehearsal.targetAnchorDigest,
		});
		await expect.poll(async () => (await zone(creator)).zoneId).toBe(targetObjectId);
		joiner = await joinerContext.newPage();
		await openGrid(joiner);
		await joiner.fill("#gridInput", created.invite);
		await joiner.click("#joinGrid");
		await expect.poll(async () => (await zone(joiner)).zoneId).toBe(targetObjectId);
		await expect.poll(async () => (await zone(joiner)).blocks).toEqual((await zone(creator)).blocks);
		await joiner.evaluate(() =>
			window.__TS_DRP_V3_ZONE__?.placeBlock({ id: "target-suffix", kind: "gold", x: 34, y: 55 })
		);
		await expect
			.poll(async () => (await zone(creator)).blocks)
			.toContainEqual({
				id: "target-suffix",
				kind: "gold",
				x: 34,
				y: 55,
			});
		await joiner.evaluate(() => window.__TS_DRP_V3_ZONE__?.close());
		await joiner.close();
		joiner = await joinerContext.newPage();
		await openGrid(joiner);
		await joiner.fill("#gridInput", created.invite);
		await joiner.click("#joinGrid");
		await expect.poll(async () => (await zone(joiner)).zoneId).toBe(targetObjectId);
		await expect
			.poll(async () => (await zone(joiner)).blocks)
			.toContainEqual({
				id: "target-suffix",
				kind: "gold",
				x: 34,
				y: 55,
			});
	} finally {
		await Promise.allSettled([
			creator.evaluate(() => window.__TS_DRP_V3_ZONE__?.close()),
			joiner.evaluate(() => window.__TS_DRP_V3_ZONE__?.close()),
		]);
		await Promise.allSettled([creator.close(), joiner.close(), creatorContext.close(), joinerContext.close()]);
	}
});
