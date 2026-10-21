import { expect, type Page, test } from "@playwright/test";

import { installGridRoomHeadAuthority } from "./fixtures/phase-3a1b/grid-room-head-authority";

// Track V: the shipped Grid page (examples/grid, served by its own dev server with real
// browser networking, as phase-3a1b-d9346-v3-zone.pw.ts serves it) as a long zone in
// Chromium. The creator and one enrolled Writer each place two blocks every epoch through
// the page's own zone API; the creator seals, exports and adopts each successor, and the
// Writer installs it from the creator over the real snapshot protocol. Each epoch records
// the in-page latency of every call and an observation-only IndexedDB census of both pages
// (record counts per store, and the origin usage the browser reports). The same block ids
// move every epoch, so the zone state stays the same size. Measurement: it asserts
// convergence and successful transitions, and bounds nothing; the bounded-storage proof is
// the native test tests/grid-long-room-issuance-retention-native.test.ts. It also counts
// each page's console warnings per epoch and, when a block does not converge, prints the
// recent console lines (TRACK_V_GRID_STUCK). Track V found that on the settlement profile
// the creator's blocks stop reaching the Writer after four successors (see
// docs/realtime-latency/tracks/32-track-v-settlement-for-grid-and-chat/RESULT.md).
const EPOCHS = Number(process.env.TRACK_V_GRID_EPOCHS ?? 16);
const MOVES = 2;
const SETTLE_MS = 300;
// Diagnostics only. A pause between the Writer's install and the next epoch's first move, and
// a probe that, when a placed block does not converge, records what still converges.
const POST_INSTALL_PAUSE_MS = Number(process.env.TRACK_V_GRID_POST_INSTALL_PAUSE_MS ?? 0);
const PROBE = process.env.TRACK_V_GRID_PROBE === "1";
// Diagnostics: TRACK_V_GRID_CENSUS=0 skips the IndexedDB census, to rule out any effect of its reads.
const CENSUS = process.env.TRACK_V_GRID_CENSUS !== "0";

interface Census {
	readonly databases: Readonly<Record<string, Readonly<Record<string, number>>>>;
	readonly usage: number | null;
}

async function openGrid(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForFunction(() => Reflect.get(window, "__TS_DRP_GRID_SESSION__") !== undefined);
	await expect(page.locator("#loadingMessage")).toBeHidden();
	await page.waitForFunction(() => Reflect.get(window, "__TS_DRP_V3_ZONE__") !== undefined, undefined, {
		timeout: 10_000,
	});
}

async function zone(page: Page): Promise<{
	readonly blocks: readonly unknown[];
	readonly durableVertexCount: number;
	readonly enrollment: string;
	readonly invite: string;
	readonly localPeerId: string;
	readonly ready: boolean;
}> {
	return page.evaluate(() => {
		const api = Reflect.get(window, "__TS_DRP_V3_ZONE__") as { snapshot(): unknown } | undefined;
		if (api === undefined) throw new Error("TRACK_V_ZONE_API_ABSENT");
		const snapshot = api.snapshot() as Record<string, unknown>;
		return {
			blocks: snapshot.blocks as unknown[],
			durableVertexCount: snapshot.durableVertexCount as number,
			enrollment: snapshot.enrollment as string,
			invite: snapshot.invite as string,
			localPeerId: snapshot.localPeerId as string,
			ready: snapshot.ready as boolean,
		};
	});
}

// Observation only: counts records per object store of every IndexedDB database of the
// page's origin, read-only, closing each connection at once.
async function census(page: Page): Promise<Census> {
	return page.evaluate(async () => {
		const request = <Value>(value: IDBRequest<Value>): Promise<Value> =>
			new Promise((resolve, reject) => {
				value.onsuccess = (): void => resolve(value.result);
				value.onerror = (): void => reject(value.error);
			});
		const databases: Record<string, Record<string, number>> = {};
		for (const { name } of await indexedDB.databases()) {
			if (name === undefined) continue;
			const opened = indexedDB.open(name);
			opened.onupgradeneeded = (): void => opened.transaction?.abort();
			let database: IDBDatabase;
			try {
				database = await request(opened);
			} catch {
				continue;
			}
			try {
				const stores: Record<string, number> = {};
				for (const store of Array.from(database.objectStoreNames))
					stores[store] = await request(database.transaction(store, "readonly").objectStore(store).count());
				databases[name] = stores;
			} finally {
				database.close();
			}
		}
		const estimate = await navigator.storage.estimate();
		return { databases, usage: estimate.usage ?? null };
	});
}

const total = (value: Census): number =>
	Object.values(value.databases).reduce(
		(sum, stores) => sum + Object.values(stores).reduce((inner, count) => inner + count, 0),
		0
	);
const issuance = (value: Census): Readonly<{ issuedRecords: number | null; issuanceOutbox: number | null }> | null => {
	const entry = Object.entries(value.databases).find(([name]) => name.endsWith("--drp-issuance-v1"));
	return entry === undefined
		? null
		: { issuedRecords: entry[1].issuedRecords ?? null, issuanceOutbox: entry[1].issuanceOutbox ?? null };
};

// Diagnostics after a block did not converge: does a later block from either Writer converge,
// and does the next successor's install repair the Writer's view?
async function probeStuck(creator: Page, receiver: Page, epoch: number): Promise<void> {
	const place = (page: Page, block: unknown): Promise<void> =>
		page.evaluate(async (value) => {
			await (Reflect.get(window, "__TS_DRP_V3_ZONE__") as { placeBlock(input: unknown): Promise<void> }).placeBlock(
				value
			);
		}, block);
	const converges = async (page: Page, block: unknown): Promise<boolean> => {
		try {
			await expect.poll(async () => (await zone(page)).blocks, { timeout: 20_000 }).toContainEqual(block);
			return true;
		} catch {
			return false;
		}
	};
	const later = { id: "probe-creator", kind: "wood", x: 100 + epoch, y: 0 };
	await place(creator, later);
	const laterCreatorBlock = await converges(receiver, later);
	const reverse = { id: "probe-recipient", kind: "wood", x: 100 + epoch, y: 1 };
	await place(receiver, reverse);
	const recipientBlock = await converges(creator, reverse);
	const views = async (): Promise<unknown> => ({
		creator: (await zone(creator)).blocks,
		recipient: (await zone(receiver)).blocks,
		creatorVertices: (await zone(creator)).durableVertexCount,
		recipientVertices: (await zone(receiver)).durableVertexCount,
	});
	process.stdout.write(
		`TRACK_V_GRID_PROBE ${JSON.stringify({ epoch: epoch + 1, laterCreatorBlock, recipientBlock, views: await views() })}\n`
	);
}

test(`the shipped Grid page runs ${EPOCHS} creator successors with an enrolled Writer (measurement)`, async ({
	browser,
}, info) => {
	test.setTimeout(1_800_000);
	const creatorContext = await browser.newContext();
	const receiverContext = await browser.newContext();
	const contexts = [creatorContext, receiverContext];
	// Independent Writers own independent account floors, as the d9346 rollover test does.
	await installGridRoomHeadAuthority([creatorContext]);
	await installGridRoomHeadAuthority([receiverContext], "__TS_DRP_GRID_ROOM_HEAD_AUTHORITY_FOR_OPEN__", "create");
	const creator = await creatorContext.newPage();
	const receiver = await receiverContext.newPage();
	const records: unknown[] = [];
	// Observation only: browser console warnings and errors per page since the last epoch
	// record, keyed by their first two words (for example "::v3-ingress graph-rejected").
	const consoleCounts = { creator: new Map<string, number>(), recipient: new Map<string, number>() };
	const consoleTail: string[] = [];
	for (const [label, page] of [
		["creator", creator],
		["recipient", receiver],
	] as const)
		page.on("console", (message) => {
			if (message.type() !== "warning" && message.type() !== "error") return;
			const key = `${message.type()} ${message.text().split(/\s+/u).slice(0, 2).join(" ").slice(0, 80)}`;
			consoleCounts[label].set(key, (consoleCounts[label].get(key) ?? 0) + 1);
			consoleTail.push(`${label} ${Math.round(performance.now())} ${message.type()} ${message.text().slice(0, 240)}`);
			if (consoleTail.length > 200) consoleTail.shift();
		});
	const takeConsole = (): Readonly<Record<"creator" | "recipient", Readonly<Record<string, number>>>> => {
		const taken = {
			creator: Object.fromEntries(consoleCounts.creator),
			recipient: Object.fromEntries(consoleCounts.recipient),
		};
		consoleCounts.creator.clear();
		consoleCounts.recipient.clear();
		return taken;
	};
	try {
		await Promise.all([openGrid(creator), openGrid(receiver)]);
		const [creatorEnrollment, receiverEnrollment] = await Promise.all([zone(creator), zone(receiver)]);
		await creator.fill("#zoneMemberEnrollment", receiverEnrollment.enrollment);
		await creator.click("#createGrid");
		await expect.poll(async () => (await zone(creator)).ready).toBe(true);
		const created = await zone(creator);
		await receiver.fill("#gridInput", created.invite);
		await receiver.click("#joinGrid");
		await expect.poll(async () => (await zone(receiver)).durableVertexCount).toBe(2);
		await expect.poll(async () => (await zone(creator)).durableVertexCount).toBe(2);
		for (let epoch = 0; epoch < EPOCHS; epoch++) {
			const issueMs: { creator: number[]; recipient: number[] } = { creator: [], recipient: [] };
			for (let ordinal = 0; ordinal < MOVES * 2; ordinal++) {
				const index = ordinal % 2;
				const [page, other] = index === 0 ? [creator, receiver] : [receiver, creator];
				const block = { id: `block-${index}-${ordinal >> 1}`, kind: "stone", x: epoch, y: index };
				const ms = await page.evaluate(async (value) => {
					const api = Reflect.get(window, "__TS_DRP_V3_ZONE__") as { placeBlock(input: unknown): Promise<void> };
					const started = performance.now();
					await api.placeBlock(value);
					return performance.now() - started;
				}, block);
				issueMs[index === 0 ? "creator" : "recipient"].push(ms);
				try {
					await expect
						.poll(async () => (await zone(other)).blocks, { timeout: PROBE ? 20_000 : 60_000 })
						.toContainEqual(block);
				} catch (error) {
					process.stdout.write(
						`TRACK_V_GRID_STUCK ${JSON.stringify({ epoch: epoch + 1, ordinal, block, console: consoleTail })}\n`
					);
					if (PROBE) await probeStuck(creator, receiver, epoch);
					throw error;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
			const rollover = await creator.evaluate(async () => {
				const api = Reflect.get(window, "__TS_DRP_V3_ZONE__") as {
					sealEpoch(): Promise<{ ok: boolean; epoch: number; successorEpoch: number }>;
					exportCreatorSuccessor(): Promise<Record<string, Uint8Array>>;
					adoptCreatorSuccessor(): Promise<unknown>;
				};
				let started = performance.now();
				const close = await api.sealEpoch();
				const seal = performance.now() - started;
				if (!close.ok) throw new Error("TRACK_V_HEALTHY_CLOSE_REFUSED");
				started = performance.now();
				const offer = await api.exportCreatorSuccessor();
				const exported = performance.now() - started;
				started = performance.now();
				await api.adoptCreatorSuccessor();
				const adoption = performance.now() - started;
				return {
					close: { ok: close.ok, epoch: close.epoch, successorEpoch: close.successorEpoch },
					ms: { seal, export: exported, adoption },
					offer: Object.fromEntries(
						[
							"exactCanonicalCutValueBytes",
							"exactCanonicalCommitQcBytes",
							"exactCanonicalTrustStateRecordBytes",
							"exactCanonicalSnapshotManifestBytes",
						].map((key) => [key, Array.from(offer[key] ?? [])])
					),
				};
			});
			expect(rollover.close).toEqual({ ok: true, epoch, successorEpoch: epoch + 1 });
			const install = await receiver.evaluate(
				async ({ offer, peer }) => {
					const api = Reflect.get(window, "__TS_DRP_V3_ZONE__") as {
						installCreatorSuccessor(input: unknown): Promise<unknown>;
					};
					const started = performance.now();
					await api.installCreatorSuccessor({
						peers: [peer],
						offer: Object.fromEntries(Object.entries(offer).map(([key, value]) => [key, new Uint8Array(value)])),
					});
					return performance.now() - started;
				},
				{ offer: rollover.offer, peer: creatorEnrollment.localPeerId }
			);
			await expect.poll(async () => (await zone(receiver)).blocks).toEqual((await zone(creator)).blocks);
			if (POST_INSTALL_PAUSE_MS > 0) await new Promise((resolve) => setTimeout(resolve, POST_INSTALL_PAUSE_MS));
			const skipped: Census = { databases: {}, usage: null };
			const [creatorCensus, recipientCensus] = CENSUS
				? await Promise.all([census(creator), census(receiver)])
				: [skipped, skipped];
			const record = {
				epoch: epoch + 1,
				ms: { ...rollover.ms, install },
				issueMs,
				creator: { rows: total(creatorCensus), issuance: issuance(creatorCensus), usage: creatorCensus.usage },
				recipient: { rows: total(recipientCensus), issuance: issuance(recipientCensus), usage: recipientCensus.usage },
				stores: { creator: creatorCensus.databases, recipient: recipientCensus.databases },
				console: takeConsole(),
			};
			records.push(record);
			process.stdout.write(`TRACK_V_GRID_CHROMIUM ${JSON.stringify(record)}\n`);
		}
		await info.attach("track-v-grid-long-room", {
			body: JSON.stringify({ epochs: EPOCHS, records }),
			contentType: "application/json",
		});
	} finally {
		await Promise.allSettled([
			creator.evaluate(() =>
				(Reflect.get(window, "__TS_DRP_V3_ZONE__") as { close(): Promise<void> } | undefined)?.close()
			),
			receiver.evaluate(() =>
				(Reflect.get(window, "__TS_DRP_V3_ZONE__") as { close(): Promise<void> } | undefined)?.close()
			),
		]);
		await Promise.allSettled([creator.close(), receiver.close(), ...contexts.map((context) => context.close())]);
	}
});
