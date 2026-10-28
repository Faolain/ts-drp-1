/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test helpers: inferred fixture shapes. */
import { hashDomain } from "@ts-drp/canonical";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import * as binding from "../examples/v3-room/src/index.js";
import { chatSharesRoomFixture, closeChatSharesRooms, type ChatSharesRoom } from "./fixtures/chat-membership-shares/room.js";

// Owner decision A (2026-10-28): one room database per player. The shipped pages named a room's
// database by objectId alone, so two identity slots of one browser origin shared it (RED 2725235d:
// both writers' installs refuse, and a slot handover wedges). Every room database is now named by
// room AND author (a new domain tag, v2), and a device that used the shared (v1) database migrates
// it once, before the room opens:
// - claimed: only this author wrote there; the whole database is copied under its new name;
// - claimed-filtered: other authors wrote there too; the copy keeps the room (AHE, snapshots,
//   journal) as a device that received their vertices would, and drops their issuance rows;
// - fresh: this author never wrote there; nothing is copied and it catches up from the room.
// The shared database is only read, so a crash at any point leaves it intact and the migration
// redoes; a pending marker makes a torn copy visible.
// The room runs on the browser room-database host (fake-indexeddb), the pages' default.

type Binding = typeof binding & {
	v3RoomPlayerDatabaseName(input: { application: string; objectId: string; author: string }): string;
	v3RoomLegacyDatabaseName(input: { application: string; objectId: string }): string;
	migrateV3RoomPlayerDatabase(input: {
		legacyName: string;
		playerName: string;
		objectId: string;
		author: string;
		testHooks?: { afterWrite?(database: string): void };
	}): Promise<{ kind: string; writers: readonly string[] }>;
};
const room = binding as Binding;

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const encode = (text: string) => new TextEncoder().encode(text);
const message = (clientOperationId: string) => ({
	action: "message",
	clientOperationId,
	displayTimeMs: 1_791_662_400_000,
	text: clientOperationId,
});

describe("decision A: per-player room database names", () => {
	const objectId = "creator-peer:0011223344556677";
	const alice = "a1".repeat(32);
	const bob = "b2".repeat(32);
	const prefixes = { chat: "ts-drp-v3-chat--", canvas: "ts-drp-v3-canvas--", zone: "ts-drp-v3-zone--" } as const;

	it.each(Object.keys(prefixes) as (keyof typeof prefixes)[])("%s names one database per player", (application) => {
		const name = (author: string) => room.v3RoomPlayerDatabaseName({ application, objectId, author });
		expect(name(alice)).not.toBe(name(bob));
		expect(name(alice)).toBe(name(alice));
		expect(name(alice).startsWith(prefixes[application])).toBe(true);
		expect(name(alice)).not.toBe(room.v3RoomLegacyDatabaseName({ application, objectId }));
	});

	it("the legacy names are exactly the shared (objectId-only) names the pages used", () => {
		expect(room.v3RoomLegacyDatabaseName({ application: "chat", objectId })).toBe(
			"ts-drp-v3-chat--" + hex(hashDomain("ts-drp/chat-database/v1", encode(objectId)))
		);
		expect(room.v3RoomLegacyDatabaseName({ application: "canvas", objectId })).toBe(
			`ts-drp-v3-canvas--${hex(hashDomain("ts-drp/canvas-database/v1", encode(objectId)))}`
		);
		expect(room.v3RoomLegacyDatabaseName({ application: "zone", objectId })).toBe(
			`ts-drp-v3-zone--${hex(hashDomain("ts-drp/d9346-zone-database/v1", encode(objectId)))}`
		);
	});

	it("the shipped pages open the per-player database, migrating the shared one first", () => {
		for (const [file, application] of [
			["examples/chat/src/index.ts", "chat"],
			["examples/canvas/src/index.ts", "canvas"],
			["examples/grid/src/v3-zone.ts", "zone"],
		] as const) {
			const source = readFileSync(join(import.meta.dirname, "..", file), "utf8");
			expect(source, file).not.toMatch(/-database\/v1/u);
			expect(source, file).toContain("prepareV3RoomPlayerDatabase(");
			expect(source, file).toContain(`application: "${application}"`);
		}
	});
});

/** A three-peer shipped Chat room on the browser room-database host. */
async function browserRoom() {
	const f = await chatSharesRoomFixture({
		members: ["genesis", "genesis"],
		format: "window",
		genesisStateBytes: createShippingChatWindowGenesisStateBytes,
		storage: "browser-room",
	});
	const creator = await f.open(0);
	const sent = new Map<number, number | null>();
	const deliver = async (index: 1 | 2, name: string) => {
		const rows = await f.issuedAfter(index, sent.get(index) ?? null, name);
		if (rows.length === 0) return;
		expect(await creator.receive(rows, index, 60_000)).toBe(true);
		sent.set(index, rows.at(-1)!.commit.authorSequence);
	};
	const close = async () => {
		expect((await creator.room.sealEpoch()).ok).toBe(true);
		await creator.room.adoptCreatorSuccessor();
	};
	const texts = () => creator.room.projection().messages.map((entry) => entry.clientOperationId).sort();
	return { f, creator, deliver, close, texts };
}

/** The player's floor starts as the shared database's floor (the host's floor follows its database). */
function copyFloor(f: ChatSharesRoom, from: string, to: string) {
	for (const suffix of ["", "-wal", "-shm"]) {
		const source = join(f.directory, `${from}-external-floor.sqlite${suffix}`);
		if (existsSync(source)) copyFileSync(source, join(f.directory, `${to}-external-floor.sqlite${suffix}`));
	}
}

const sequences = async (f: ChatSharesRoom, index: number, name: string) =>
	(await f.issuedAfter(index, null, name)).map((row) => row.commit.authorSequence);

describe("decision A: the shared database migrates once into per-player databases", () => {
	it("[RED] a shared database holding Alice and Bob becomes two per-player databases; both reopen, follow and issue; no move is lost or duplicated", async () => {
		const { f, creator, deliver, close, texts } = await browserRoom();
		const [, aliceId, bobId] = f.identities;
		// The old layout: both writers (two slots of one origin) on the one shared database and floor.
		let alice = await f.open(1, { name: "shared" });
		let bob = await f.open(2, { name: "shared", promote: true });
		await alice.room.issue(message("alice-1"));
		await bob.room.issue(message("bob-1"));
		await deliver(1, "shared");
		await deliver(2, "shared");
		await close();
		expect(creator.room.authority()?.epoch).toBe(1);
		// An unsettled move: signed and published at the closed epoch 0, never admitted. It must be
		// handed back from Alice's copy, not lost. (In a copy that kept her rows, Bob's install
		// refuses at the recovery census on it: "outbox-classification:0:displaced:published".)
		await alice.room.issue(message("alice-late"));
		const aliceShared = await sequences(f, 1, "shared");
		const bobShared = await sequences(f, 2, "shared");
		await f.stop(alice);
		await f.stop(bob);

		const migrate = (index: 1 | 2, playerName: string) =>
			room.migrateV3RoomPlayerDatabase({
				legacyName: "shared",
				playerName,
				objectId: f.objectId,
				author: f.identities[index]!.author,
			});
		const aliceMigration = await migrate(1, "alice");
		const bobMigration = await migrate(2, "bob");
		expect(aliceMigration.kind).toBe("claimed-filtered");
		expect(bobMigration.kind).toBe("claimed-filtered");
		expect([...aliceMigration.writers].sort()).toEqual([aliceId!.author, bobId!.author].sort());
		// Once: a second run changes nothing.
		expect((await migrate(1, "alice")).kind).toBe("present");
		// Each player's database holds its own lineage, exactly as it was, and nobody else's.
		expect(await sequences(f, 1, "alice")).toEqual(aliceShared);
		expect(await sequences(f, 2, "bob")).toEqual(bobShared);
		expect(await sequences(f, 2, "alice")).toEqual([]);
		expect(await sequences(f, 1, "bob")).toEqual([]);
		// The shared database is only read.
		expect(await sequences(f, 1, "shared")).toEqual(aliceShared);
		expect(await sequences(f, 2, "shared")).toEqual(bobShared);
		copyFloor(f, "shared", "alice");
		copyFloor(f, "shared", "bob");

		alice = await f.open(1, { name: "alice", reopen: true });
		bob = await f.open(2, { name: "bob", reopen: true });
		for (let epoch = 1; epoch <= 2; epoch++) {
			await f.install(alice);
			await f.install(bob);
			expect(alice.room.authority()?.epoch).toBe(epoch);
			expect(bob.room.authority()?.epoch).toBe(epoch);
			await alice.room.issue(message(`alice-${epoch + 1}`));
			await bob.room.issue(message(`bob-${epoch + 1}`));
			await deliver(1, "alice");
			await deliver(2, "bob");
			await close();
		}
		expect(texts()).toEqual(["alice-1", "alice-2", "alice-3", "alice-late", "bob-1", "bob-2", "bob-3"]);
		expect(await alice.room.unresolvedAcceptedWork()).toEqual([]);
	}, 900_000);

	it("[RED] a slot's shared database is claimed whole by its only writer, who continues its lineage; another slot starts fresh", async () => {
		const { f, creator, deliver, close, texts } = await browserRoom();
		let alice = await f.open(1, { name: "shared" });
		await alice.room.issue(message("alice-1"));
		await deliver(1, "shared");
		for (let step = 0; step < 3; step++) {
			await close();
			await f.install(alice);
			await alice.room.issue(message(`alice-${step + 2}`));
			await deliver(1, "shared");
		}
		expect(alice.room.authority()?.epoch).toBe(3);
		const aliceShared = await sequences(f, 1, "shared");
		await f.stop(alice);

		const aliceMigration = await room.migrateV3RoomPlayerDatabase({
			legacyName: "shared",
			playerName: "alice",
			objectId: f.objectId,
			author: f.identities[1]!.author,
		});
		expect(aliceMigration.kind).toBe("claimed");
		expect(
			(
				await room.migrateV3RoomPlayerDatabase({
					legacyName: "shared",
					playerName: "bob",
					objectId: f.objectId,
					author: f.identities[2]!.author,
				})
			).kind
		).toBe("fresh");
		expect(await sequences(f, 1, "alice")).toEqual(aliceShared);
		copyFloor(f, "shared", "alice");

		// Alice reopens her own copy at the room's epoch and keeps issuing on her lineage.
		alice = await f.open(1, { name: "alice", reopen: true });
		expect(alice.room.authority()?.epoch).toBe(3);
		await alice.room.issue(message("alice-5"));
		await deliver(1, "alice");
		// Bob opens his own new database, follows the room and issues.
		const bob = await f.open(2, { name: "bob" });
		await f.install(bob);
		expect(bob.room.authority()?.epoch).toBe(3);
		await bob.room.issue(message("bob-1"));
		await deliver(2, "bob");
		await close();
		await f.install(alice);
		await f.install(bob);
		await alice.room.issue(message("alice-6"));
		await bob.room.issue(message("bob-2"));
		await deliver(1, "alice");
		await deliver(2, "bob");
		expect(creator.room.authority()?.epoch).toBe(4);
		expect(texts()).toEqual(["alice-1", "alice-2", "alice-3", "alice-4", "alice-5", "alice-6", "bob-1", "bob-2"]);
	}, 900_000);

	it("[RED] a migration interrupted after its copy redoes from the untouched shared database", async () => {
		const { f, deliver } = await browserRoom();
		const alice = await f.open(1, { name: "shared" });
		await alice.room.issue(message("alice-1"));
		await deliver(1, "shared");
		const aliceShared = await sequences(f, 1, "shared");
		await f.stop(alice);
		const input = { legacyName: "shared", playerName: "alice", objectId: f.objectId, author: f.identities[1]!.author };
		// A crash after the copy committed but before the migration finished leaves its pending mark.
		await expect(
			room.migrateV3RoomPlayerDatabase({
				...input,
				testHooks: {
					afterWrite: () => {
						throw new Error("SIMULATED_CRASH_AFTER_COPY");
					},
				},
			})
		).rejects.toThrow(/SIMULATED_CRASH_AFTER_COPY/u);
		expect((await room.migrateV3RoomPlayerDatabase(input)).kind).toBe("claimed");
		expect((await room.migrateV3RoomPlayerDatabase(input)).kind).toBe("present");
		expect(await sequences(f, 1, "alice")).toEqual(aliceShared);
		expect(await sequences(f, 1, "shared")).toEqual(aliceShared);
	}, 300_000);
});
