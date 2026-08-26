import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { type Phase4cBrowserServer, startPhase4cBrowserServer } from "./phase-4c-browser-server.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const D108D2_BROWSER_BEHAVIORS = Object.freeze([
	"hot creator adoption exposes oracle authority and issues through the replacement handle",
	"established peer cold reopen accepts the genuine epoch-one live operation",
	"fresh late peer cold reopen accepts the targeted retained epoch-one operation",
] as const);

function productReady(): boolean {
	const read = (path: string): string => {
		const absolute = resolve(REPOSITORY_ROOT, path);
		return existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
	};
	const room = read("examples/v3-room/src/index.ts");
	const chat = read("examples/v3-chat/src/index.ts");
	return (
		/interface\s+ChatSnapshot[\s\S]*readonly\s+authority\s*:/u.test(chat) &&
		/interface\s+(?:JoinInput|RoomJoinInput)[\s\S]*successorSnapshotDeclaration\??\s*:/u.test(chat) &&
		/adoptSuccessor\s*\([^)]*\)\s*:[^{]+\{[\s\S]*\.adoptCreatorSuccessor\s*\(/u.test(chat) &&
		/authority\s*\(\)\s*:[^{]+\{/u.test(room) &&
		/await\s+(?:Promise\.resolve\s*\()?[^;\n]*activeHandle[^;\n]*\.deactivate\s*\(/u.test(room) &&
		/successorSnapshotDeclaration/u.test(room) &&
		/reopenCreatorSuccessorAdoption\s*\(/u.test(room) &&
		/@ts-drp\/node\/creator-adoption["']/u.test(room) &&
		/@ts-drp\/node\/creator-adoption-commit["']/u.test(room) &&
		/@ts-drp\/node\/creator-adoption-activate["']/u.test(room) &&
		/adoptCreatorSuccessor\s*\([^)]*\)\s*:[^{]+\{/u.test(room) &&
		/verifyCreatorSuccessorAdoption\s*\(/u.test(room) &&
		/commitCreatorSuccessorAdoption\s*\(/u.test(room) &&
		/activateCreatorSuccessorAdoption\s*\(/u.test(room) &&
		/interface\s+CreateV3RoomSessionInput[\s\S]*successorSnapshotDeclaration\??\s*:/u.test(room) &&
		/interface\s+V3RoomSession[\s\S]*adoptCreatorSuccessor\s*\(/u.test(room) &&
		/interface\s+V3RoomSession[\s\S]*authority\s*\(/u.test(room)
	);
}

function isD108d2Authority(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Readonly<Record<string, unknown>>;
	return (
		Reflect.ownKeys(record).length === 7 &&
		["aclDigest", "anchorDigest", "epoch", "genesisAnchorDigest", "lifecycle", "objectId", "profileId"].every((key) =>
			Object.hasOwn(record, key)
		) &&
		record.epoch === 1 &&
		record.lifecycle === "active" &&
		record.profileId === "creator-trusted-v1"
	);
}

const PRODUCT_READY = productReady();
const DATABASES = Object.freeze({ creator: "d108d2-creator", established: "d108d2-established", late: "d108d2-late" });
const CHANNEL_NAME = "d108d2-successor-product";

type Carrier = Awaited<ReturnType<typeof window.phase6aCreatorSuccessorProduct.exportSuccessor>>;

let servers: readonly Phase4cBrowserServer[] = [];
let context: BrowserContext | undefined;
let creator: Page | undefined;
let established: Page | undefined;
let late: Page | undefined;
let invite = "";
let genesisRoomId = "";
let carrier: Carrier | undefined;

async function openRealm(
	page: Page,
	origin: string,
	selectedRealmId: string,
	pages: () => readonly Page[]
): Promise<void> {
	await page.exposeFunction("__phase6aProductRelayPost", async (packet: unknown) => {
		await Promise.all(
			pages().map(async (target) => {
				if (target === page || target.isClosed()) return;
				await target.evaluate((selected) => window.phase6aCreatorSuccessorProduct.deliver(selected as never), packet);
			})
		);
	});
	await page.goto(origin);
	await page.evaluate((realmId) => window.phase6aCreatorSuccessorProduct.boot(realmId), selectedRealmId);
}

async function snapshot(page: Page): Promise<Readonly<Record<string, unknown>>> {
	return page.evaluate(() => window.phase6aCreatorSuccessorProduct.snapshot());
}

async function waitForText(page: Page, text: string): Promise<void> {
	await expect
		.poll(
			async () => {
				const selected = await snapshot(page);
				const accepted = selected.accepted as readonly Readonly<Record<string, unknown>>[];
				return accepted.some((message) => message.text === text);
			},
			{ timeout: 15_000 }
		)
		.toBe(true);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
	if (!PRODUCT_READY) return;
	servers = Object.freeze(
		await Promise.all(
			["creator", "established", "late"].map(() =>
				startPhase4cBrowserServer({
					entryPoint: new URL("./assets/phase-6a-creator-successor-product-entry.ts", import.meta.url).pathname,
				})
			)
		)
	);
	context = await browser.newContext();
	creator = await context.newPage();
	established = await context.newPage();
	late = await context.newPage();
	const pages = (): readonly Page[] => [creator as Page, established as Page, late as Page];
	await Promise.all([
		openRealm(creator, servers[0]?.origin ?? "about:blank", "creator", pages),
		openRealm(established, servers[1]?.origin ?? "about:blank", "established", pages),
		openRealm(late, servers[2]?.origin ?? "about:blank", "late", pages),
	]);
});

test.afterAll(async () => {
	await Promise.allSettled(
		[creator, established, late].map((page) =>
			page?.isClosed() === false ? page.evaluate(() => window.phase6aCreatorSuccessorProduct.close()) : undefined
		)
	);
	await context?.close();
	await Promise.all(servers.map((server) => server.close()));
});

test("pins the exact successor product browser inventory", () => {
	expect(D108D2_BROWSER_BEHAVIORS).toEqual([
		"hot creator adoption exposes oracle authority and issues through the replacement handle",
		"established peer cold reopen accepts the genuine epoch-one live operation",
		"fresh late peer cold reopen accepts the targeted retained epoch-one operation",
	]);
});

test(D108D2_BROWSER_BEHAVIORS[0], async () => {
	test.skip(!PRODUCT_READY, "D.108d2 product surface is intentionally absent in RED");
	if (creator === undefined || established === undefined) throw new TypeError("D.108d2 browser realms are absent");
	invite = await creator.evaluate((input) => window.phase6aCreatorSuccessorProduct.create(input), {
		channelName: CHANNEL_NAME,
		clientId: "alice",
		databaseName: DATABASES.creator,
	});
	await established.evaluate((input) => window.phase6aCreatorSuccessorProduct.join(input), {
		channelName: CHANNEL_NAME,
		clientId: "bob",
		databaseName: DATABASES.established,
		invite,
	});
	await creator.evaluate(() => window.phase6aCreatorSuccessorProduct.send("epoch-zero"));
	await waitForText(established, "epoch-zero");
	const before = await snapshot(creator);
	genesisRoomId = String(before.roomId);
	expect(before).toMatchObject({ authority: null, ready: true, roomId: genesisRoomId });
	await creator.evaluate(() => window.phase6aCreatorSuccessorProduct.sealEpoch());
	await creator.evaluate(() => window.phase6aCreatorSuccessorProduct.adoptSuccessor());
	carrier = await creator.evaluate(
		(databaseName) => window.phase6aCreatorSuccessorProduct.exportSuccessor(databaseName),
		DATABASES.creator
	);
	const after = await snapshot(creator);
	expect(isD108d2Authority(after.authority)).toBe(true);
	expect(after.authority).toEqual(carrier.authority);
	expect(after.roomId).toBe(carrier.authority.anchorDigest);
	expect(after.roomId).not.toBe(genesisRoomId);
	await creator.evaluate(() => window.phase6aCreatorSuccessorProduct.send("successor-hot"));
	await waitForText(creator, "successor-hot");
});

test(D108D2_BROWSER_BEHAVIORS[1], async () => {
	test.skip(!PRODUCT_READY, "D.108d2 product surface is intentionally absent in RED");
	if (creator === undefined || established === undefined || carrier === undefined) {
		throw new TypeError("D.108d2 established-peer state is absent");
	}
	await established.evaluate(() => window.phase6aCreatorSuccessorProduct.close());
	await established.evaluate(
		({ carrier, source, target }) => window.phase6aCreatorSuccessorProduct.importSuccessor(carrier, source, target),
		{ carrier, source: DATABASES.creator, target: DATABASES.established }
	);
	await established.evaluate((input) => window.phase6aCreatorSuccessorProduct.join(input), {
		channelName: CHANNEL_NAME,
		clientId: "bob",
		databaseName: DATABASES.established,
		invite,
		successorSnapshotDeclaration: carrier.snapshotDeclaration,
	});
	const reopened = await snapshot(established);
	expect(reopened.authority).toEqual(carrier.authority);
	expect(reopened.roomId).toBe(carrier.authority.anchorDigest);
	await creator.evaluate(() => window.phase6aCreatorSuccessorProduct.send("successor-live"));
	await waitForText(established, "successor-live");
});

test(D108D2_BROWSER_BEHAVIORS[2], async () => {
	test.skip(!PRODUCT_READY, "D.108d2 product surface is intentionally absent in RED");
	if (creator === undefined || established === undefined || late === undefined || carrier === undefined) {
		throw new TypeError("D.108d2 late-peer state is absent");
	}
	await late.evaluate(
		({ carrier, source, target }) => window.phase6aCreatorSuccessorProduct.importSuccessor(carrier, source, target),
		{ carrier, source: DATABASES.creator, target: DATABASES.late }
	);
	await late.evaluate((input) => window.phase6aCreatorSuccessorProduct.join(input), {
		channelName: CHANNEL_NAME,
		clientId: "carol",
		databaseName: DATABASES.late,
		invite,
		successorSnapshotDeclaration: carrier.snapshotDeclaration,
	});
	await waitForText(late, "successor-live");
	const retained = await snapshot(late);
	expect(retained.authority).toEqual(carrier.authority);
	expect(retained.roomId).toBe(carrier.authority.anchorDigest);

	await creator.evaluate(() => window.phase6aCreatorSuccessorProduct.close());
	await creator.evaluate((input) => window.phase6aCreatorSuccessorProduct.join(input), {
		channelName: CHANNEL_NAME,
		clientId: "alice",
		databaseName: DATABASES.creator,
		invite,
		successorSnapshotDeclaration: carrier.snapshotDeclaration,
	});
	expect((await snapshot(creator)).authority).toEqual(carrier.authority);
	const audits = await Promise.all(
		[creator, established, late].map((page) => page.evaluate(() => window.phase6aCreatorSuccessorProduct.relayAudit()))
	);
	expect(audits.every(({ mismatch }) => mismatch === 0)).toBe(true);
	expect(audits.reduce((total, audit) => total + audit.incoming, 0)).toBeGreaterThan(0);
});
