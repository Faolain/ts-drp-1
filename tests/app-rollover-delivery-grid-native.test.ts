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

// App rollover delivery, items 1 and 4, Grid: the shipped zone API (createV3ZoneApi, the page's own
// policy and successor delivery wiring) on three real DRPNodes over local libp2p. The creator and
// two Writers place blocks; the creator's policy rolls the zone over, its delivery announces each
// offer, and each Writer's delivery installs it. No offer is passed by the test. One Writer's page
// closes for three rollovers and reopens; every block placed is in every replica at the end.
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
			if (storageHost === undefined) throw new TypeError("APP_ROLLOVER_GRID_HOST_UNWIRED");
			const session = actual.createV3RoomSession({ ...input, storageHost } as RoomInput);
			wiring.opened.push({ author: input.author, session });
			return session;
		},
	};
});

const ROLLOVERS = Number(process.env.APP_ROLLOVER_DELIVERY_ROLLOVERS ?? 10);
const directories = new Set<string>();
const nodes = new Set<DRPNode>();
const zones = new Set<V3ZoneApi>();
const heads = new Set<{ close(): Promise<void> }>();
function required<Value>(value: Value | null | undefined): Value {
	if (value === undefined || value === null) throw new TypeError("APP_ROLLOVER_GRID_REQUIRED");
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
		if (performance.now() > deadline) throw new Error(`APP_ROLLOVER_GRID_TIMEOUT ${label()}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

it(`Grid creator and two Writers over real libp2p follow ${ROLLOVERS} automatic rollovers through the zone's delivery; one Writer's page closes for three and catches up`, async () => {
	const root = mkdtempSync(join(tmpdir(), "app-rollover-delivery-grid-"));
	directories.add(root);
	const peers = await Promise.all(
		["creator", "writer-1", "writer-2"].map(async (name) => {
			const node = new DRPNode({
				keychain_config: { private_key_seed: `app-rollover-delivery-grid-${name}` },
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
	const [creator, steady, late] = peers.map((peer) => required(peer));
	const connect = async (peer: typeof creator) => {
		await peer.node.networkNode.connect(creator.node.networkNode.getMultiaddrs() ?? []);
		await expect
			.poll(() => creator.node.networkNode.getAllPeers(), { timeout: 15_000 })
			.toContain(peer.node.networkNode.peerId);
	};
	for (const peer of [steady, late]) await connect(required(peer));
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
	const roomOf = async (peer: typeof creator) =>
		(await required(wiring.opened.findLast((entry) => entry.author === peer.node.keychain.localAuthorId))
			.session) as V3RoomSession<{
			blocks: readonly { id: string }[];
		}>;
	const steadyZone = zoneFor(steady);
	const lateZone = zoneFor(late);
	const creatorZone = zoneFor(creator);
	await creatorZone.create([steadyZone.snapshot().enrollment, lateZone.snapshot().enrollment]);
	const invite = creatorZone.snapshot().invite;
	await steadyZone.join(invite);
	await lateZone.join(invite);
	const creatorRoom = await roomOf(creator);
	let steadyRoom = await roomOf(steady);
	let lateRoom = await roomOf(late);
	for (const room of [creatorRoom, steadyRoom, lateRoom]) await waitForV3RoomStartupForDiagnostics(room);
	const epochOf = (room: V3RoomSession<never> | V3RoomSession<{ blocks: readonly { id: string }[] }>) =>
		room.authority()?.epoch ?? 0;
	const blocksOf = (room: V3RoomSession<{ blocks: readonly { id: string }[] }>) =>
		room
			.projection()
			.blocks.map((block) => block.id)
			.sort();
	const placed: string[] = [];
	const kept: string[] = [];
	const progress: string[] = [];
	let cutEpoch: number | undefined;
	let rejoined = false;
	const place = async (peer: typeof creator, index: number) => {
		const id = `${peer.name}-${index}`;
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
	let index = 0;
	const budget = GRID_ROLLOVER_BUDGET.movesPerAuthor;
	while (epochOf(creatorRoom) < ROLLOVERS) {
		await place(creator, index);
		if (index % 3 === 0) await place(steady, index);
		if (cutEpoch === undefined && index % 3 === 1) await place(late, index);
		index++;
		const epoch = epochOf(creatorRoom);
		if (cutEpoch === undefined && epoch >= 3) {
			await until(
				() => epochOf(lateRoom) === epochOf(creatorRoom),
				60_000,
				() => `late at cut: ${epochOf(lateRoom)}/${epochOf(creatorRoom)}`
			);
			cutEpoch = epochOf(lateRoom);
			await required(late.zone).close();
			zones.delete(required(late.zone));
			await late.node.networkNode.disconnect(creator.node.networkNode.peerId);
			progress.push(`cut late Writer at epoch ${cutEpoch}`);
		}
		if (cutEpoch !== undefined && !rejoined && epoch >= cutEpoch + 3) {
			rejoined = true;
			await connect(late);
			await zoneFor(late).join(invite);
			lateRoom = await roomOf(late);
			await waitForV3RoomStartupForDiagnostics(lateRoom);
			progress.push(`rejoined late Writer at creator epoch ${epoch}, its epoch ${epochOf(lateRoom)}`);
		}
		if (index > ROLLOVERS * budget * 4) throw new Error(`APP_ROLLOVER_GRID_NO_PROGRESS ${progress.join("; ")}`);
	}
	steadyRoom = await roomOf(steady);
	const finalEpoch = epochOf(creatorRoom);
	const target = [...placed].sort();
	await until(
		() =>
			epochOf(steadyRoom) >= finalEpoch &&
			epochOf(lateRoom) >= finalEpoch &&
			[creatorRoom, steadyRoom, lateRoom].every((room) => blocksOf(room).join() === target.join()),
		180_000,
		() =>
			JSON.stringify({
				finalEpoch,
				epochs: [creatorRoom, steadyRoom, lateRoom].map(epochOf),
				missing: [creatorRoom, steadyRoom, lateRoom].map((room) => target.filter((id) => !blocksOf(room).includes(id))),
				kept,
				progress,
			})
	);
	console.log(
		"APP_ROLLOVER_GRID",
		JSON.stringify({
			placed: placed.length,
			kept: kept.length,
			finalEpoch,
			epochs: [creatorRoom, steadyRoom, lateRoom].map(epochOf),
			progress,
		})
	);
	expect(finalEpoch).toBeGreaterThanOrEqual(10);
	expect(cutEpoch, "the late Writer was cut").toBeDefined();
	expect(rejoined, "the late Writer rejoined").toBe(true);
	for (const room of [creatorRoom, steadyRoom, lateRoom]) expect(blocksOf(room)).toEqual(target);
}, 900_000);
