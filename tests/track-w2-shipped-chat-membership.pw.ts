import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { resolve } from "node:path";

import { installGridRoomHeadAuthority } from "./fixtures/phase-3a1b/grid-room-head-authority";
import { importWorkspacePackageExportFile } from "./fixtures/shared/workspace-package-export-file.mjs";

// Track W2: the shipped Chat page (examples/chat) in Chromium with real browser networking (two
// relays, libp2p gossip and direct streams), on the pattern of
// tests/track-x-shipped-app-long-room.pw.ts. The creator creates a room through the page (new rooms
// sign the v5 shares format), and a second, independent peer joins it with the invite. Mid-room:
// - the creator makes the joiner a Writer with the page's "Make Writer" control; the creator's page
//   issues the share update by itself, and once the joiner's share is in force, the joiner's page
//   sends (it reopens as a Writer on that first Send), and the creator shows the message;
// - the creator revokes the joiner with "Revoke Writer"; the creator's page drops its share, and
//   the creator then fills the window: the departed member's messages stay until the window needs
//   their space, then leave first, oldest first, before any of the creator's own.
// The pages expose no rollover control and no room handle, so the harness appends one read-only
// accessor, `globalThis.__TRACK_W2_ROOM__ = () => room`, to the page's entry module as served, and
// drives seal, export and adopt on the creator and install on the joiner through it, as Track X's
// harness does. Each checkpoint prints a TRACK_W2_EPOCH line (timings and the window's bytes).

const { encodeCanonical } = (
	await importWorkspacePackageExportFile({
		expectedPackageName: "@ts-drp/canonical",
		exportKey: ".",
		packageDirectory: resolve(import.meta.dirname, "../packages/canonical"),
	})
).module as Readonly<{ encodeCanonical(value: unknown): Uint8Array }>;

const ORIGIN = "http://127.0.0.1:4181";
const HEAD_FACTORY = "__TS_DRP_CHAT_ROOM_HEAD_AUTHORITY_FOR_OPEN__";
const ACCESSOR = "\n;globalThis.__TRACK_W2_ROOM__ = () => room;\n";
const CONVERGE_MS = 60_000;
const MAX_FILL_EPOCHS = 40;

interface Row {
	readonly author: string;
	readonly clientOperationId: string;
	readonly displayTimeMs: number;
	readonly text: string;
}
interface Shares {
	readonly allowanceBytes: number;
	readonly windowBytes: number;
	readonly allocations: readonly (readonly [string, number, number])[];
}
interface Seen {
	readonly epoch: number;
	readonly messages: readonly Row[];
	readonly capacity: Shares;
}

const size = (row: Row): number =>
	encodeCanonical({
		author: row.author,
		clientOperationId: row.clientOperationId,
		displayTimeMs: row.displayTimeMs,
		text: row.text,
	}).byteLength;
const windowTotal = (seen: Seen): number => seen.messages.reduce((sum, row) => sum + size(row), 0);

async function exposeRoom(context: BrowserContext): Promise<void> {
	await context.route(
		(url) => url.origin === ORIGIN && url.pathname === "/src/index.ts",
		async (route) => {
			const response = await route.fetch();
			const body = await response.text();
			if (!/\blet room\b/u.test(body)) throw new Error("TRACK_W2_ROOM_BINDING_ABSENT");
			const headers = { ...response.headers() };
			delete headers["content-length"];
			await route.fulfill({ status: response.status(), headers, body: body + ACCESSOR });
		}
	);
}

async function openPage(page: Page): Promise<void> {
	await page.goto(`${ORIGIN}/`);
	await page.waitForFunction(() => {
		const session = Reflect.get(window, "__TS_DRP_CHAT_SESSION__") as
			| { snapshot(): { relayReservations: readonly unknown[] } }
			| undefined;
		return (session?.snapshot().relayReservations.length ?? 0) >= 1;
	});
	await expect(page.locator("#createRoom")).toBeEnabled();
}

const peerIdOf = (page: Page): Promise<string> =>
	page.evaluate(
		() => (Reflect.get(window, "__TS_DRP_CHAT_SESSION__") as { snapshot(): { peerId: string } }).snapshot().peerId
	);

const connectedPeers = (page: Page): Promise<readonly string[]> =>
	page.evaluate(() => {
		const room = (
			Reflect.get(globalThis, "__TRACK_W2_ROOM__") as () => { connectedPeers(): readonly string[] } | undefined
		)();
		return room?.connectedPeers() ?? [];
	});

// The page's own projection: its window, share rows and checkpoint.
const seen = (page: Page): Promise<Seen> =>
	page.evaluate(() => {
		const room = (Reflect.get(globalThis, "__TRACK_W2_ROOM__") as () => { projection(): unknown } | undefined)();
		if (room === undefined) throw new Error("TRACK_W2_ROOM_CLOSED");
		const projection = room.projection() as {
			epoch?: number;
			messages: readonly Row[];
			capacity: Shares;
		};
		return JSON.parse(
			JSON.stringify({ epoch: projection.epoch ?? 0, messages: projection.messages, capacity: projection.capacity })
		) as Seen;
	});

const shows = (page: Page, text: string): Promise<boolean> =>
	page.evaluate(
		(value) =>
			Array.from(document.querySelectorAll(".message-content")).some((element) => element.textContent === value),
		text
	);

// Sends one message through the page's input; returns once the page shows it and clears the input.
async function send(page: Page, text: string): Promise<number> {
	const started = Date.now();
	await expect(page.locator("#messageInput")).toBeEnabled({ timeout: CONVERGE_MS });
	await page.locator("#messageInput").fill(text);
	await page.locator("#messageInput").press("Enter");
	await expect.poll(() => shows(page, text), { timeout: CONVERGE_MS }).toBe(true);
	await expect(page.locator("#messageInput")).toHaveValue("", { timeout: CONVERGE_MS });
	return Date.now() - started;
}

test("the shipped chat page: a late joiner made Writer mid-room sends; a revoked member's bytes are reclaimed when needed", async ({
	browser,
	request,
}) => {
	test.setTimeout(1_800_000);
	expect((await request.post("http://127.0.0.1:4175/grid-control/registry/reset")).ok()).toBe(true);
	const creatorContext = await browser.newContext();
	const joinerContext = await browser.newContext();
	const contexts = [creatorContext, joinerContext];
	// Independent peers own independent account floors (Track X's setup).
	await installGridRoomHeadAuthority([creatorContext], HEAD_FACTORY);
	await installGridRoomHeadAuthority([joinerContext], HEAD_FACTORY, "create");
	await exposeRoom(creatorContext);
	await exposeRoom(joinerContext);
	const creator = await creatorContext.newPage();
	const joiner = await joinerContext.newPage();
	const errors: string[] = [];
	for (const [label, page] of [
		["creator", creator],
		["joiner", joiner],
	] as const) {
		page.on("pageerror", (error) => errors.push(`${label} pageerror ${error.message}`));
		page.on("console", (message) => {
			if (message.type() === "error" || message.type() === "warning")
				process.stdout.write(`TRACK_W2_CONSOLE ${label} ${message.type()} ${message.text().slice(0, 300)}\n`);
		});
	}
	const started = Date.now();
	let joinerFollows = true;
	let epoch = 0;
	const records: unknown[] = [];

	// The creator seals, exports and adopts; the joiner installs from the creator's peer.
	const rollover = async (creatorPeer: string, note: Record<string, unknown> = {}): Promise<void> => {
		const result = await creator.evaluate(async () => {
			const room = (Reflect.get(globalThis, "__TRACK_W2_ROOM__") as () => unknown)() as {
				sealEpoch(): Promise<{ ok: boolean; epoch: number; successorEpoch: number }>;
				exportCreatorSuccessor(): Promise<Record<string, Uint8Array>>;
				adoptCreatorSuccessor(): Promise<unknown>;
			};
			let begun = performance.now();
			const close = await room.sealEpoch();
			const seal = performance.now() - begun;
			if (!close.ok) throw new Error("TRACK_W2_CLOSE_REFUSED");
			begun = performance.now();
			const offer = await room.exportCreatorSuccessor();
			const exported = performance.now() - begun;
			begun = performance.now();
			await room.adoptCreatorSuccessor();
			const adoption = performance.now() - begun;
			return {
				close: { ok: close.ok, epoch: close.epoch, successorEpoch: close.successorEpoch },
				ms: { seal, export: exported, adoption },
				offer: Object.fromEntries(Object.entries(offer).map(([key, value]) => [key, Array.from(value)])),
			};
		});
		expect(result.close).toEqual({ ok: true, epoch, successorEpoch: epoch + 1 });
		let install: number | string | null = null;
		if (joinerFollows) {
			try {
				install = await joiner.evaluate(
					async ({ offer, peer }) => {
						const room = (Reflect.get(globalThis, "__TRACK_W2_ROOM__") as () => unknown)() as {
							installCreatorSuccessor(input: unknown): Promise<unknown>;
						};
						const begun = performance.now();
						await room.installCreatorSuccessor({
							peers: [peer],
							offer: Object.fromEntries(Object.entries(offer).map(([key, value]) => [key, new Uint8Array(value)])),
						});
						return performance.now() - begun;
					},
					{ offer: result.offer, peer: creatorPeer }
				);
			} catch (error) {
				install = `failed: ${String(error).slice(0, 300)}`;
				joinerFollows = false;
			}
		}
		epoch += 1;
		const view = await seen(creator);
		const record = {
			epoch,
			testMs: Date.now() - started,
			ms: { ...result.ms, install },
			windowBytes: windowTotal(view),
			budget: view.capacity.windowBytes,
			holders: view.capacity.allocations.length,
			messages: view.messages.length,
			...note,
		};
		records.push(record);
		process.stdout.write(`TRACK_W2_EPOCH ${JSON.stringify(record)}\n`);
		if (joinerFollows && typeof install === "number") {
			// Every peer that follows shows the creator's window and rows after the install (the
			// creator's page may add its share update meanwhile; the joiner receives it live).
			await expect
				.poll(async () => JSON.stringify(await seen(joiner)) === JSON.stringify(await seen(creator)), {
					timeout: CONVERGE_MS,
				})
				.toBe(true);
		}
	};

	try {
		await Promise.all([openPage(creator), openPage(joiner)]);
		await creator.locator("#createRoom").click();
		await expect(creator.locator("#chatId")).toHaveAttribute("data-full-id", /.+/u);
		await expect(creator.locator("#messageInput")).toBeEnabled();
		const invite = await creator.locator("#chatInvite").inputValue();
		await joiner.locator("#roomInput").fill(invite);
		await joiner.locator("#joinRoom").click();
		await expect(joiner.locator("#chatId")).toHaveAttribute("data-full-id", /.+/u);
		await expect(joiner.getByRole("status", { name: "Chat connection status" })).toContainText(/observer/iu);
		await expect(joiner.locator("#messageInput")).toBeDisabled();
		const creatorPeer = await peerIdOf(creator);
		const joinerPeer = await peerIdOf(joiner);
		await expect.poll(() => connectedPeers(creator), { timeout: CONVERGE_MS }).toContain(joinerPeer);
		await expect.poll(() => connectedPeers(joiner), { timeout: CONVERGE_MS }).toContain(creatorPeer);
		const creatorAuthor = (await creator.locator("#authorId").getAttribute("data-author")) ?? "";
		const joinerAuthor = (await joiner.locator("#authorId").getAttribute("data-author")) ?? "";
		expect(creatorAuthor).toMatch(/^[0-9a-f]{64}$/u);
		expect(joinerAuthor).toMatch(/^[0-9a-f]{64}$/u);
		// The admin's control shows on the creator's page only.
		await expect(creator.locator("#membershipPanel")).toBeVisible();
		await expect(joiner.locator("#membershipPanel")).toBeHidden();
		const genesis = await seen(creator);
		expect(genesis.capacity.allocations.map((row) => row[0])).toEqual([creatorAuthor]);
		const allowance = genesis.capacity.allowanceBytes;
		process.stdout.write(
			`TRACK_W2_OPENED ${JSON.stringify({ ms: Date.now() - started, allowance, budget: genesis.capacity.windowBytes })}\n`
		);

		// Checkpoint 0: the creator speaks; the joiner (an observer) shows it.
		await send(creator, "w2 hello from the creator");
		await expect.poll(() => shows(joiner, "w2 hello from the creator"), { timeout: CONVERGE_MS }).toBe(true);
		await rollover(creatorPeer);

		// Checkpoint 1: mid-room, the creator makes the joiner a Writer (it latches at checkpoint 2).
		await creator.locator("#memberInput").fill(joinerAuthor);
		await creator.locator("#grantWriter").click();
		await expect(creator.getByRole("status", { name: "Chat connection status" })).toContainText(/Writer granted/u);
		await send(creator, "w2 creator in checkpoint 1");
		await rollover(creatorPeer, { event: "grant latches" });

		// Checkpoint 2: the creator's page gives the joiner a share from checkpoint 3, by itself.
		await expect
			.poll(
				async () => (await seen(creator)).capacity.allocations.find((row) => row[0] === joinerAuthor)?.[2] ?? null,
				{
					timeout: CONVERGE_MS,
				}
			)
			.toBe(3);
		await expect
			.poll(async () => (await seen(joiner)).capacity.allocations.find((row) => row[0] === joinerAuthor)?.[2] ?? null, {
				timeout: CONVERGE_MS,
			})
			.toBe(3);
		await expect(joiner.locator("#sendHint")).toContainText(/from checkpoint 3/u);
		await expect(joiner.locator("#messageInput")).toBeDisabled();
		await rollover(creatorPeer, { event: "share in force" });

		// Checkpoint 3: the joiner's page sends (reopening as a Writer on this first Send).
		const joinerSent: string[] = [];
		const firstSendMs = await send(joiner, "w2 hello from the late joiner");
		joinerSent.push("w2 hello from the late joiner");
		await expect.poll(() => shows(creator, "w2 hello from the late joiner"), { timeout: CONVERGE_MS }).toBe(true);
		process.stdout.write(`TRACK_W2_JOINER_FIRST_SEND ${JSON.stringify({ ms: firstSendMs, epoch })}\n`);
		// Both of the joiner's messages in this checkpoint fit its allowance together.
		const joinerText = (index: number): string => `w2 joiner ${index} ` + "j".repeat(allowance - 500);
		joinerSent.push(joinerText(1));
		await send(joiner, joinerText(1));
		await expect.poll(() => shows(creator, joinerText(1)), { timeout: CONVERGE_MS }).toBe(true);
		await rollover(creatorPeer, { event: "joiner spoke" });
		// Checkpoint 4: the joiner, now a Writer replica, speaks again after a checkpoint.
		joinerSent.push(joinerText(2));
		await send(joiner, joinerText(2));
		await expect.poll(() => shows(creator, joinerText(2)), { timeout: CONVERGE_MS }).toBe(true);
		await rollover(creatorPeer);

		// Checkpoint 5: the creator revokes the joiner (it latches at checkpoint 6).
		await creator.locator("#memberInput").fill(joinerAuthor);
		await creator.locator("#revokeWriter").click();
		await expect(creator.getByRole("status", { name: "Chat connection status" })).toContainText(/Writer revoked/u);
		await rollover(creatorPeer, { event: "revoke latches" });
		// Checkpoint 6: the creator's page drops the departed member's share, by itself.
		await expect
			.poll(async () => (await seen(creator)).capacity.allocations.map((row) => row[0]), { timeout: CONVERGE_MS })
			.toEqual([creatorAuthor]);
		if (joinerFollows) await expect(joiner.locator("#messageInput")).toBeDisabled({ timeout: CONVERGE_MS });
		const spokenIds = (await seen(creator)).messages
			.filter((row) => row.author === joinerAuthor)
			.map((row) => row.clientOperationId);
		expect(spokenIds).toHaveLength(joinerSent.length);

		// The creator fills the window, one allowance-sized message per checkpoint. The departed
		// member's messages leave only when the window needs their space, oldest first, and before
		// any of the creator's own.
		const creatorSent: string[] = [];
		let reclaimedAt: number | undefined;
		for (let index = 0; index < MAX_FILL_EPOCHS; index++) {
			const before = await seen(creator);
			const departedBefore = before.messages.filter((row) => row.author === joinerAuthor);
			if (departedBefore.length === 0) break;
			const text = `w2 fill ${index} ` + "c".repeat(allowance - 260);
			await send(creator, text);
			creatorSent.push(text);
			const after = await seen(creator);
			const added = after.messages.find((row) => row.text === text);
			if (added === undefined) throw new Error("TRACK_W2_FILL_NOT_IN_WINDOW");
			expect(size(added)).toBeLessThanOrEqual(allowance);
			const departedAfter = after.messages.filter((row) => row.author === joinerAuthor);
			const needed = windowTotal(before) + size(added) > before.capacity.windowBytes;
			if (departedAfter.length < departedBefore.length) {
				expect(needed).toBe(true);
				reclaimedAt ??= epoch;
			} else expect(needed).toBe(false);
			// Oldest first: what stays is the newest suffix of what the member said.
			expect(departedAfter.map((row) => row.clientOperationId)).toEqual(
				spokenIds.slice(spokenIds.length - departedAfter.length)
			);
			// None of the creator's own messages leave while the departed member's remain.
			const creatorTexts = after.messages.filter((row) => row.author === creatorAuthor).map((row) => row.text);
			if (departedAfter.length > 0)
				expect(creatorTexts.filter((value) => value.startsWith("w2 fill "))).toEqual(creatorSent);
			expect(windowTotal(after)).toBeLessThanOrEqual(after.capacity.windowBytes);
			await rollover(creatorPeer, {
				event: "fill",
				departedMessages: departedAfter.length,
				reclaimed: departedAfter.length < departedBefore.length,
			});
		}
		expect((await seen(creator)).messages.filter((row) => row.author === joinerAuthor)).toEqual([]);
		expect(reclaimedAt).toBeDefined();
		process.stdout.write(
			`TRACK_W2_RESULT ${JSON.stringify({ epochs: epoch, reclaimedAt, joinerFollows, ms: Date.now() - started, errors })}\n`
		);
		expect(errors).toEqual([]);
	} finally {
		process.stdout.write(`TRACK_W2_RECORDS ${JSON.stringify(records)}\n`);
		const closes = [creator, joiner].map((page) =>
			page.evaluate(() =>
				(Reflect.get(globalThis, "__TRACK_W2_ROOM__") as () => { close(): Promise<void> } | undefined)()?.close()
			)
		);
		for (const close of closes) void close.catch(() => undefined);
		await Promise.allSettled(closes);
		await Promise.allSettled([creator.close(), joiner.close(), ...contexts.map((context) => context.close())]);
	}
});
