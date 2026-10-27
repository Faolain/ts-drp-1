/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the native owners' signatures. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { GRID_ROLLOVER_BUDGET } from "../examples/grid/src/rollover.js";
import { createV3ZoneApi, type V3ZoneApi } from "../examples/grid/src/v3-zone.js";
import {
	type createV3RoomSession,
	type V3RoomSession,
	waitForV3RoomStartupForDiagnostics,
} from "../examples/v3-room/src/index.js";
import { DRPNode } from "../packages/node/src/index.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";
import { createNodeV3RoomStorageHost } from "../packages/storage-node/src/v3-room-host.js";

// Grid successor delivery after a zone migration: the shipped zone API (createV3ZoneApi, its policy
// and successor delivery wiring) on three real DRPNodes over local libp2p. The creator migrates the
// zone (rehearse + activate); one Writer is open through the migration and follows the redirect,
// another joins afterwards with the creator's post-migration invite. The creator's page reopens (a
// live-migrated source session cannot issue; a reopened one forwards issue to its target) and its
// policy rolls the migrated room over; each Writer must install every offer through the zone's
// delivery. No offer is passed by the test. Delivery used to stay bound to the source object id and source session, so
// offers for the migrated room never reached its members.
// Only the storage host is wired (Node SQLite instead of IndexedDB), as the other Grid native tests do.

type RoomInput = Parameters<typeof createV3RoomSession>[0];
const wiring = vi.hoisted(() => ({
	hosts: new Map<string, unknown>(),
	opened: [] as { author: string; session: Promise<unknown> }[],
}));
vi.mock("@ts-drp/example-v3-room", async (original) => {
	const actual = await original<{ readonly createV3RoomSession: typeof createV3RoomSession }>();
	return {
		...actual,
		createV3RoomSession: (input: RoomInput): Promise<unknown> => {
			const storageHost = wiring.hosts.get(input.author);
			if (storageHost === undefined) throw new TypeError("APP_ROLLOVER_MIGRATED_HOST_UNWIRED");
			const session = actual.createV3RoomSession({ ...input, storageHost } as RoomInput);
			wiring.opened.push({ author: input.author, session });
			return session;
		},
	};
});

const ROLLOVERS = Number(process.env.APP_ROLLOVER_MIGRATED_ROLLOVERS ?? 3);
const directories = new Set<string>();
const nodes = new Set<DRPNode>();
const zones = new Set<V3ZoneApi>();
const heads = new Set<{ close(): Promise<void> }>();
function required<Value>(value: Value | null | undefined): Value {
	if (value === undefined || value === null) throw new TypeError("APP_ROLLOVER_MIGRATED_REQUIRED");
	return value;
}
afterEach(async () => {
	const zoneJoined = await Promise.allSettled([...zones].map((zone) => zone.close()));
	zones.clear();
	const headJoined = await Promise.allSettled([...heads].map((head) => head.close()));
	heads.clear();
	const nodeJoined = await Promise.allSettled([...nodes].map((node) => node.stop()));
	nodes.clear();
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
	directories.clear();
	wiring.hosts.clear();
	wiring.opened.length = 0;
	expect(
		[...zoneJoined, ...headJoined, ...nodeJoined].filter((result) => result.status === "rejected"),
		"native owners join"
	).toEqual([]);
});

async function until(predicate: () => boolean, timeoutMs: number, label: () => string): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!predicate()) {
		if (performance.now() > deadline) throw new Error(`APP_ROLLOVER_MIGRATED_TIMEOUT ${label()}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

it(`Grid Writers follow ${ROLLOVERS} rollovers of a migrated zone through the zone's delivery (one redirected live, one joined after the migration)`, async () => {
	const root = mkdtempSync(join(tmpdir(), "app-rollover-migrated-grid-"));
	directories.add(root);
	const peers = await Promise.all(
		["creator", "redirected", "joined"].map(async (name) => {
			const node = new DRPNode({
				keychain_config: { private_key_seed: `app-rollover-migrated-grid-${name}` },
				log_config: { level: "silent" },
				network_config: {
					bootstrap_peers: [],
					listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
					log_config: { level: "silent" },
				},
			});
			nodes.add(node);
			await node.start();
			const directory = join(root, name);
			mkdirSync(directory);
			const created = new Set<string>();
			wiring.hosts.set(
				node.keychain.localAuthorId,
				createNodeV3RoomStorageHost({
					directory,
					initialization: ({ name: store, family }) => {
						const key = `${store}/${family}`;
						if (created.has(key)) return "reopen";
						created.add(key);
						return "create";
					},
				})
			);
			return { name, node, directory, zone: undefined as V3ZoneApi | undefined, floorOpened: false };
		})
	);
	const [creator, redirected, joined] = peers.map((peer) => required(peer));
	for (const peer of [redirected, joined]) {
		await peer.node.networkNode.connect(creator.node.networkNode.getMultiaddrs() ?? []);
		await expect
			.poll(() => creator.node.networkNode.getAllPeers(), { timeout: 15_000 })
			.toContain(peer.node.networkNode.peerId);
	}
	const zoneFor = (peer: typeof creator) => {
		const reopen = peer.floorOpened;
		peer.floorOpened = true;
		const zone = createV3ZoneApi(
			peer.node,
			() => undefined,
			() => {
				const floor = createNodeRoomHeadAuthority({
					filename: join(peer.directory, "external-floor.sqlite"),
					initialization: { kind: reopen ? "reopen" : "create" },
				});
				heads.add(floor);
				return floor;
			}
		);
		zones.add(zone);
		peer.zone = zone;
		return zone;
	};
	// The session the zone opened; after a migration redirect it forwards authority and projection
	// to its target, so its epoch is the migrated room's epoch.
	const roomOf = async (peer: typeof creator) =>
		(await required(wiring.opened.findLast((entry) => entry.author === peer.node.keychain.localAuthorId))
			.session) as V3RoomSession<{
			blocks: readonly { id: string }[];
		}>;
	const redirectedZone = zoneFor(redirected);
	const joinedZone = zoneFor(joined);
	const creatorZone = zoneFor(creator);
	await creatorZone.create([redirectedZone.snapshot().enrollment, joinedZone.snapshot().enrollment]);
	const sourceInvite = creatorZone.snapshot().invite;
	const sourceZoneId = creatorZone.snapshot().zoneId;
	await redirectedZone.join(sourceInvite);
	let creatorRoom = await roomOf(creator);
	const redirectedRoom = await roomOf(redirected);
	for (const room of [creatorRoom, redirectedRoom]) await waitForV3RoomStartupForDiagnostics(room);
	const epochOf = (room: V3RoomSession<{ blocks: readonly { id: string }[] }>) => room.authority()?.epoch ?? 0;
	const blocksOf = (room: V3RoomSession<{ blocks: readonly { id: string }[] }>) =>
		room
			.projection()
			.blocks.map((block) => block.id)
			.sort();
	const placed: string[] = [];
	const kept: string[] = [];
	const place = async (peer: typeof creator, id: string, index: number) => {
		try {
			await required(peer.zone).placeBlock({ id, kind: "stone", x: index % 16, y: Math.floor(index / 16) % 16 });
			placed.push(id);
		} catch (error) {
			// A Writer's placement kept for want of a successor is re-offered by its policy.
			if (error instanceof Error && error.name === "V3RoomSuccessorUnavailable") {
				kept.push(id);
				placed.push(id);
				return;
			}
			throw error;
		}
	};
	await place(creator, "source-creator", 0);
	await place(redirected, "source-redirected", 1);
	await until(
		() => blocksOf(redirectedRoom).join() === blocksOf(creatorRoom).join() && blocksOf(creatorRoom).length === 2,
		60_000,
		() => `source sync ${blocksOf(creatorRoom).join()} / ${blocksOf(redirectedRoom).join()}`
	);

	const receipt = await creatorZone.rehearseMigration();
	await creatorZone.activateMigration(receipt);
	const targetZoneId = creatorZone.snapshot().zoneId;
	const targetInvite = creatorZone.snapshot().invite;
	expect(targetZoneId).not.toBe(sourceZoneId);
	await until(
		() => redirectedZone.snapshot().zoneId === targetZoneId,
		90_000,
		() => `redirected Writer zone ${redirectedZone.snapshot().zoneId} (target ${targetZoneId})`
	);
	await creatorZone.close();
	zones.delete(creatorZone);
	const reopenedCreatorZone = zoneFor(creator);
	await reopenedCreatorZone.join(sourceInvite);
	expect(reopenedCreatorZone.snapshot().zoneId).toBe(targetZoneId);
	creatorRoom = await roomOf(creator);
	await waitForV3RoomStartupForDiagnostics(creatorRoom);
	await joinedZone.join(targetInvite);
	const joinedRoom = await roomOf(joined);
	await waitForV3RoomStartupForDiagnostics(joinedRoom);
	expect(joinedZone.snapshot().zoneId).toBe(targetZoneId);
	const migratedEpoch = epochOf(creatorRoom);

	let index = 2;
	const budget = GRID_ROLLOVER_BUDGET.movesPerAuthor;
	while (epochOf(creatorRoom) < migratedEpoch + ROLLOVERS) {
		await place(creator, `creator-${index}`, index);
		if (index % 3 === 1) await place(joined, `joined-${index}`, index);
		index++;
		if (index > ROLLOVERS * budget * 4 + 2) throw new Error("APP_ROLLOVER_MIGRATED_NO_PROGRESS");
	}
	const finalEpoch = epochOf(creatorRoom);
	const rooms = [creatorRoom, redirectedRoom, joinedRoom];
	const target = [...placed].sort();
	const state = () =>
		JSON.stringify({
			sourceZoneId,
			targetZoneId,
			zones: [reopenedCreatorZone, redirectedZone, joinedZone].map((zone) => zone.snapshot().zoneId),
			migratedEpoch,
			finalEpoch,
			epochs: rooms.map(epochOf),
			missing: rooms.map((room) => target.filter((id) => !blocksOf(room).includes(id))),
			kept,
		});
	await until(
		() =>
			rooms.every((room) => epochOf(room) >= finalEpoch) &&
			rooms.every((room) => blocksOf(room).join() === target.join()),
		90_000,
		state
	);
	console.log("APP_ROLLOVER_MIGRATED_GRID", state());
	expect(finalEpoch).toBeGreaterThanOrEqual(migratedEpoch + ROLLOVERS);
	for (const room of rooms) expect(blocksOf(room)).toEqual(target);
}, 600_000);
