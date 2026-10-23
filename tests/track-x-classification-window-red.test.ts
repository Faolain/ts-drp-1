import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import {
	blockIds,
	deliver,
	install,
	isControl,
	journalHolds,
	openOutsideRowsRoom,
	play,
	protectedEpochs,
	seal,
} from "./fixtures/track-x/outside-rows-room.js";

// A received scope retains its exact Cut/QC/trust with membership until its details are Done.
// Authority outside the ordinary recovery window is reopened against the immutable genesis
// and signed scope header. Own outside rows need signed terminal coverage and complete local
// settlement; they do not wait for later replacement Cuts. These schedules cover delayed
// replacement/fence delivery, a restart with old authority outside the window, and clean-scope
// restart boundaries. Every retained byte remains under the native image ceiling.
// Grid zone application, creator-trusted-settlement-v1, the node SQLite host.

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const PROTECTED_BOUND = 4;

it("a Writer whose move's replacement misses three Cuts in a row keeps installing, its scopes bounded", async () => {
	const room = await openOutsideRowsRoom();
	const creator = required(room.peers[0]);
	const history: string[] = [];
	const MISSED = 1;
	// The replacements issued by the installs after these seals miss the next Cut.
	const CHAIN = new Set([MISSED, MISSED + 1, MISSED + 2]);
	const EPOCHS = Number(process.env.TRACK_X_WINDOW_EPOCHS ?? 12);
	let source: DurableIssuanceOutboxRecord | undefined;
	let late: DurableIssuanceOutboxRecord[] = [];
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		// The Writer does not move while its replacement is withheld: its moves would depend on it.
		await play(room, `epoch-${epoch}`, CHAIN.has(epoch - 1) ? [0] : [0, 1]);
		await seal(room, epoch, epoch === MISSED ? [1] : []);
		// The withheld replacement reaches the creator after its seal, which drops it.
		if (late.length > 0) creator.inject(late, 1);
		late = [];
		if (epoch === MISSED)
			source = (await room.fixture.publishedAfter(1, null)).find(
				(row) => row.commit.authorSequence === room.delivered[1]
			);
		await creator.room.adoptCreatorSuccessor();
		const installed = await install(room, 1);
		const kept = await protectedEpochs(room, 1);
		history.push(`epoch ${epoch + 1}: ${installed}; protected [${kept.join(",")}]`);
		expect(installed, history.join("\n")).toBe("ok");
		if (CHAIN.has(epoch)) {
			// The install's fence reaches the creator in time, its replacement only after the next seal.
			const rows = await room.fixture.publishedAfter(1, room.delivered[1]);
			expect(rows.map(isControl)).toEqual([true, false]);
			creator.inject([required(rows[0])], 1);
			late = [required(rows[1])];
			room.delivered[1] = required(rows[1]).commit.authorSequence;
		} else await deliver(room, 1);
	}
	console.log(`TRACK_X_WINDOW_TRIPLE ${JSON.stringify(history)}`);
	expect(blockIds(creator)).toContain(`seal-${MISSED}-1`);
	const kept = await protectedEpochs(room, 1);
	expect(kept.length, history.join("\n")).toBeLessThanOrEqual(PROTECTED_BOUND);
	for (const epoch of [MISSED, MISSED + 1, MISSED + 2]) expect(kept, history.join("\n")).not.toContain(epoch);
	expect(await journalHolds(room, 1, required(source).commit.envelope.digest), "collected").toBe(false);
	expect(required(room.peers[1]).room.projection()).toEqual(creator.room.projection());
}, 900_000);

it("a Writer whose settlement fence misses four Cuts survives an out-of-window restart and keeps its scopes bounded", async () => {
	const room = await openOutsideRowsRoom();
	const creator = required(room.peers[0]);
	const history: string[] = [];
	// The fences published by the installs after these seals reach the creator after its next
	// seal: they miss cut(1) to cut(4). The Writer makes no moves.
	const WITHHELD = new Set([0, 1, 2, 3]);
	const EPOCHS = Number(process.env.TRACK_X_WINDOW_FENCE_EPOCHS ?? 12);
	const fences: DurableIssuanceOutboxRecord[] = [];
	let late = false;
	await deliver(room, 1);
	for (let epoch = 0; epoch < EPOCHS; epoch++) {
		await play(room, `epoch-${epoch}`, [0]);
		await seal(room, epoch);
		if (late) {
			const rows = await room.fixture.publishedAfter(1, room.delivered[1] ?? null);
			expect(rows.map(isControl)).toEqual([true]);
			creator.inject(rows, 1);
			room.delivered[1] = required(rows[0]).commit.authorSequence;
			fences.push(required(rows[0]));
		}
		await creator.room.adoptCreatorSuccessor();
		const installed = await install(room, 1);
		const kept = await protectedEpochs(room, 1);
		history.push(`epoch ${epoch + 1}: ${installed}; protected [${kept.join(",")}]`);
		expect(installed, history.join("\n")).toBe("ok");
		if (epoch + 1 === 5) {
			expect(kept).toContain(1);
			await room.fixture.stop(required(room.peers[1]));
			room.peers[1] = await room.fixture.open(1, { reopen: true });
			history.push("reopened at epoch 5 with scope 1 outside the ordinary recovery window");
		}
		late = WITHHELD.has(epoch);
		if (!late) await deliver(room, 1);
		expect(kept.length, history.join("\n")).toBeLessThanOrEqual(PROTECTED_BOUND);
	}
	console.log(`TRACK_X_WINDOW_FENCES ${JSON.stringify(history)}`);
	expect(fences).toHaveLength(WITHHELD.size);
	for (const fence of fences)
		expect(await journalHolds(room, 1, fence.commit.envelope.digest), "the fence's scope collected").toBe(false);
	expect(required(room.peers[1]).room.projection()).toEqual(creator.room.projection());
}, 900_000);

it("a Writer stopped and reopened right after its classification install still collects the clean scope", async () => {
	const room = await openOutsideRowsRoom();
	const creator = required(room.peers[0]);
	const history: string[] = [];
	// Scope 2 (no rows outside its Cut) is protected for replay through the install of epoch 5 and
	// classified at the install of epoch 6, inside that install's received recovery turnover. The
	// Writer stops and reopens right after each of those installs.
	const CLEAN = 2;
	const CRASHES = new Set([CLEAN + 3, CLEAN + 4]);
	for (let epoch = 0; epoch < CLEAN + 7; epoch++) {
		await play(room, `epoch-${epoch}`);
		await seal(room, epoch);
		await creator.room.adoptCreatorSuccessor();
		const installed = await install(room, 1);
		history.push(`epoch ${epoch + 1}: ${installed}; protected [${(await protectedEpochs(room, 1)).join(",")}]`);
		expect(installed, history.join("\n")).toBe("ok");
		if (CRASHES.has(epoch + 1)) {
			await room.fixture.stop(required(room.peers[1]));
			room.peers[1] = await room.fixture.open(1, { reopen: true });
			history.push(`reopened at epoch ${String(required(room.peers[1]).room.authority()?.epoch)}`);
		}
		await deliver(room, 1);
	}
	console.log(`TRACK_X_WINDOW_CRASH ${JSON.stringify(history)}`);
	const kept = await protectedEpochs(room, 1);
	expect(kept, history.join("\n")).not.toContain(CLEAN);
	expect(kept.length, history.join("\n")).toBeLessThanOrEqual(PROTECTED_BOUND);
	expect(required(room.peers[1]).room.projection()).toEqual(creator.room.projection());
}, 900_000);
