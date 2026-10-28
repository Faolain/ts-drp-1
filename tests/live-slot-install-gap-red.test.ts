/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test helpers: inferred fixture shapes. */
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { afterEach, expect, it } from "vitest";

import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { chatSharesRoomFixture, closeChatSharesRooms } from "./fixtures/chat-membership-shares/room.js";

// The live-slot install gap (found by creator-successor-lineage-admission.qnt,
// testRestoreInstallReissuesLiveSlotKnownGap). The install proves only the CLOSED frontier: the
// successor's authenticated admitted sequence of each author through the epoch it closed. A
// device restored from a backup taken before the original device signed in the epoch it installs
// is above that frontier, so the frontier guard (8b857b4a) lets it install, and decision B made
// it current by that install. Its lineage then re-signs the slots the original device already
// signed, and the creator already admitted, in that same epoch: a second, conflicting signed
// vertex for one (author, sequence). (Here the settlement author fence re-signs identically, being
// deterministic; the next move conflicts.)
// Fix (installRule "live"): a device that reopened its lineage from storage installs only with the
// creator's statement for the installed epoch (its live frontier, carried with the offer); at or
// below that frontier the install is refused before anything is adopted or signed
// (V3RoomNotYetCurrent behind-frontier), and the device stays read-only.
afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const settle = <T>(task: Promise<T>) =>
	task.then(
		() => "done",
		(error: unknown) => String((error as Error)?.message ?? error)
	);

it("[RED] a device restored from a backup older than the original's signatures in the installed epoch never re-signs those slots", async () => {
	const f = await chatSharesRoomFixture({
		members: ["genesis"],
		format: "window",
		genesisStateBytes: createShippingChatWindowGenesisStateBytes,
	});
	const creator = await f.open(0);
	const before = new Set(readdirSync(f.directory));
	// Device A: Bob's first open (his lineage is created here).
	let member = await f.open(1);
	const opened = await f.issuedAfter(1, null);
	await f.stop(member);
	// Bob's whole device state (every owner database and the floor), backed up now.
	const bobFiles = readdirSync(f.directory).filter((file) => !before.has(file));
	expect(bobFiles.length).toBeGreaterThan(0);
	const backup = join(f.directory, "bob-backup");
	mkdirSync(backup);
	for (const file of bobFiles) copyFileSync(join(f.directory, file), join(backup, file));
	// The creator closes epoch 0. Device A reopens and installs epoch 1: its settlement author fence
	// is signed in epoch 1; it then moves, and the creator admits both live (epoch 1 is still open).
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	member = await f.open(1, { reopen: true });
	await f.install(member);
	expect(member.room.authority()?.epoch).toBe(1);
	await member.room.issue({
		action: "message",
		clientOperationId: "bob-on-device-a",
		displayTimeMs: 1_791_662_400_000,
		text: "bob-on-device-a",
	});
	const deviceA = await f.issuedAfter(1, null);
	const signedInEpoch1 = deviceA.filter((row) => !opened.some((old) => old.commit.authorSequence === row.commit.authorSequence));
	expect(signedInEpoch1.length, "device A signed its fence in epoch 1").toBeGreaterThan(0);
	expect(await creator.receive(deviceA, 1)).toBe(true);
	const admitted = new Map(deviceA.map((row) => [row.commit.authorSequence, hex(row.commit.envelope.digest)]));
	await f.stop(member);
	expect(creator.room.authority()?.epoch).toBe(1);

	// Device B: the backup restored (same key, lineage from before device A's fence), installing the
	// same epoch 1.
	for (const file of readdirSync(f.directory).filter((name) => !before.has(name) && name !== "bob-backup"))
		rmSync(join(f.directory, file));
	for (const file of bobFiles) copyFileSync(join(backup, file), join(f.directory, file));
	member = await f.open(1, { reopen: true });
	expect(member.room.authority()?.epoch ?? 0).toBe(0);
	/** Every (Bob, seq) row device B signed whose digest differs from the one the room admitted. */
	const conflicting = async () =>
		(await f.issuedAfter(1, null))
			.filter((row: DurableIssuanceOutboxRecord) => {
				const original = admitted.get(row.commit.authorSequence);
				return original !== undefined && original !== hex(row.commit.envelope.digest);
			})
			.map((row) => ({ authorSequence: row.commit.authorSequence, publishState: row.publishState }));
	const installed = await settle(f.install(member));
	const moved = await settle(
		member.room.issue({
			action: "message",
			clientOperationId: "bob-on-device-b",
			displayTimeMs: 1_791_662_400_000,
			text: "bob-on-device-b",
		})
	);
	expect(await conflicting(), "no second signature for an admitted slot").toEqual([]);
	// The creator's statement for epoch 1 names device A's move: device B is behind it, refused
	// before it adopted or signed anything, and stays read-only.
	expect(installed).toMatch(/V3_ROOM_NOT_YET_CURRENT: behind-frontier/u);
	expect(moved).toMatch(/V3_ROOM_NOT_YET_CURRENT: behind-frontier/u);
	expect(member.room.localIssueCurrency?.()).toBe("not-yet-current");
	await f.stop(member);
	expect(await conflicting()).toEqual([]);
}, 300_000);
