/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test helpers: inferred fixture shapes. */
import { afterEach, describe, expect, it } from "vitest";

import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { chatSharesRoomFixture, closeChatSharesRooms } from "./fixtures/chat-membership-shares/room.js";

// Owner decision B (2026-10-28): sync before sending. A writer that reopened its own lineage from
// storage (a reload, a cold start, a restored backup) signs nothing until it is current: it
// installed the room's current successor in this session, or it confirmed the creator's
// statement of the current epoch and of this author's admitted frontier in it. Its moves wait,
// in order, and are refused with V3RoomNotYetCurrent after a bounded hold; none is ever signed
// before that. The creator (it defines the current epoch) and a lineage this open created (a
// first-time joiner: nothing it signed can exist) are current at once.
// The read-only window each case measures (ms, installs) is printed for the report.

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

const message = (clientOperationId: string) => ({
	action: "message",
	clientOperationId,
	displayTimeMs: 1_791_662_400_000,
	text: clientOperationId,
});
const settle = <T>(task: Promise<T>) =>
	task.then(
		() => "issued",
		(error: unknown) => String((error as Error)?.message ?? error)
	);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function room() {
	const f = await chatSharesRoomFixture({
		members: ["genesis"],
		format: "window",
		genesisStateBytes: createShippingChatWindowGenesisStateBytes,
	});
	const creator = await f.open(0);
	const close = async () => {
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
	};
	const texts = () => creator.room.projection().messages.map((entry) => entry.clientOperationId);
	return { f, creator, close, texts };
}

describe("decision B: sync before sending", () => {
	it("[RED] the creator and a first-time joiner are current at open; their moves are not held", async () => {
		const { f, creator, texts } = await room();
		expect(creator.room.localIssueCurrency?.()).toBe("current");
		const member = await f.open(1, { currency: false });
		expect(member.room.localIssueCurrency?.()).toBe("current");
		await creator.room.issue(message("creator-1"));
		const started = performance.now();
		await member.room.issue(message("member-1"));
		const rows = await f.issuedAfter(1, null);
		expect(await creator.receive(rows, 1)).toBe(true);
		console.info("[read-only window] first-time joiner: 0 installs, issue joined in", Math.round(performance.now() - started), "ms");
		expect(texts()).toEqual(expect.arrayContaining(["creator-1", "member-1"]));
	}, 240_000);

	it("[RED] a reopened Writer signs nothing until it confirms the creator's current epoch; its held move is then issued once", async () => {
		const { f, creator, texts } = await room();
		let member = await f.open(1);
		await f.stop(member);
		const before = (await f.issuedAfter(1, null)).length;
		const opened = performance.now();
		member = await f.open(1, { reopen: true, currency: false });
		expect(member.room.localIssueCurrency?.()).toBe("not-yet-current");
		const held = settle(member.room.issue(message("held")));
		await sleep(1_500);
		expect((await f.issuedAfter(1, null)).length).toBe(before);
		expect(await member.room.confirmCurrent?.(creator.room.currencyStatement!())).toBe("current");
		expect(member.room.localIssueCurrency?.()).toBe("current");
		expect(await held).toBe("issued");
		console.info("[read-only window] reopened at the current epoch: 0 installs,", Math.round(performance.now() - opened), "ms (includes the 1.5 s probe)");
		const rows = await f.issuedAfter(1, null);
		expect(rows.length).toBe(before + 1);
		expect(await creator.receive(rows, 1)).toBe(true);
		expect(texts().filter((text) => text === "held")).toEqual(["held"]);
	}, 240_000);

	it("[RED] a reopened Writer behind the room's epoch becomes current only by installing the current successor", async () => {
		const { f, creator, close, texts } = await room();
		let member = await f.open(1);
		await f.stop(member);
		await close();
		await close();
		const before = (await f.issuedAfter(1, null)).length;
		const opened = performance.now();
		// The fixture confirms the creator's statement as the page's delivery does: it names epoch 2.
		member = await f.open(1, { reopen: true });
		expect(member.room.authority()?.epoch ?? 0).toBe(0);
		expect(member.room.localIssueCurrency?.()).toBe("not-yet-current");
		expect(await member.room.confirmCurrent?.(creator.room.currencyStatement!())).toBe("other-epoch");
		const held = settle(member.room.issue(message("after-catch-up")));
		await sleep(1_500);
		expect((await f.issuedAfter(1, null)).length).toBe(before);
		await f.install(member);
		expect(member.room.authority()?.epoch).toBe(2);
		expect(member.room.localIssueCurrency?.()).toBe("current");
		expect(await held).toBe("issued");
		console.info("[read-only window] reopened two epochs behind: 1 install,", Math.round(performance.now() - opened), "ms (includes the 1.5 s probe)");
		const rows = await f.issuedAfter(1, null);
		expect(await creator.receive(rows.slice(before), 1)).toBe(true);
		expect(texts().filter((text) => text === "after-catch-up")).toEqual(["after-catch-up"]);
	}, 300_000);

	it("[RED] a move held past the bound is refused with V3RoomNotYetCurrent and never signed", async () => {
		const { f } = await room();
		let member = await f.open(1);
		await f.stop(member);
		const before = (await f.issuedAfter(1, null)).length;
		member = await f.open(1, { reopen: true, currency: false, localIssueCurrencyHoldMs: 1_000 });
		expect(await settle(member.room.issue(message("expired")))).toMatch(/V3_ROOM_NOT_YET_CURRENT: hold-expired/u);
		expect((await f.issuedAfter(1, null)).length).toBe(before);
	}, 240_000);

	it("the read-only window of a reopened Writer: one statement at the current epoch, one install per missed epoch run", async () => {
		const { f, close } = await room();
		let member = await f.open(1);
		await f.stop(member);
		// At the current epoch: the fixture confirms the creator's statement right after the open,
		// as the page's delivery does on bind (one round trip to the creator, no install).
		let started = performance.now();
		member = await f.open(1, { reopen: true });
		const atCurrent = { installs: 0, ms: Math.round(performance.now() - started) };
		expect(member.room.localIssueCurrency?.()).toBe("current");
		await f.stop(member);
		// Behind by two epochs: one install of the creator's latest successor.
		await close();
		await close();
		started = performance.now();
		member = await f.open(1, { reopen: true });
		expect(member.room.localIssueCurrency?.()).toBe("not-yet-current");
		await f.install(member);
		const behind = { installs: 1, ms: Math.round(performance.now() - started) };
		expect(member.room.localIssueCurrency?.()).toBe("current");
		console.info("[read-only window]", JSON.stringify({ atCurrent, behindTwoEpochs: behind }), "(open included; loaded host)");
	}, 300_000);
});
