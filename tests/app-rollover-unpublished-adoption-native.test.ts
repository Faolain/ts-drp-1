/* eslint-disable @typescript-eslint/explicit-function-return-type -- Transparent fixture inference preserves the native owners' signatures. */
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { CANVAS_GENESIS_PROFILE } from "../examples/canvas/src/profile.js";
import { CANVAS_ROLLOVER_BUDGET } from "../examples/canvas/src/rollover.js";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomRolloverPolicy,
	createV3RoomSession,
	createV3RoomSuccessorChannel,
	createV3RoomSuccessorDelivery,
	type V3RoomRolloverEvent,
	type V3RoomSession,
	type V3RoomSuccessorDelivery,
	waitForV3RoomStartupForDiagnostics,
} from "../examples/v3-room/src/index.js";
import { toCanvasWireOperation } from "../packages/blueprints/src/v3-canvas.js";
import { type CanvasProjection, createV3CanvasApplication } from "../packages/node/src/applications/canvas.js";
import { DRPNode } from "../packages/node/src/index.js";
import { createNodeV3RoomStorageHost } from "../packages/storage-node/src/v3-room-host.js";

// Successor-delivery liveness (browser Grid at a447a40c, .logs/realtime-resume-2026-11-10/browser-grid/fps-gbd1):
// the creator ended at epoch 34 and the member at 33, for good. The creator's policy sealed 33 times
// and its 34th seal failed ("creator recovery role transfer source failed ... SUBSTRATE_FAILURE");
// the room's own interrupted-close retry (v3-room sealEpoch -> interruptedCloseRetry.kick) then sealed
// and adopted epoch 34 by itself. Nothing exported or announced that successor: the policy exports and
// publishes only after its own adoption, so the delivery's latest offer stayed epoch 33's. Every pull
// of the member (at 33) was then unanswered (no newer offer, and no currency statement for an epoch the
// creator had left), and the idle creator had nothing more to roll.
//
// Native: the shipped Canvas over two real DRPNodes on local libp2p, a creator and a receive-only
// observer, each with the shipped rollover policy and successor delivery. The room's own close is run
// with the same two calls its interrupted-close retry makes (sealEpoch, adoptCreatorSuccessor; see
// v3-room's startInterruptedCloseRetry retry), not through the policy. The creator stays idle after.

const directories = new Set<string>();
const nodes = new Set<DRPNode>();
const rooms = new Set<V3RoomSession<CanvasProjection>>();
const closers = new Set<() => void>();
const heads = new Set<{ close(): Promise<void> }>();
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const SIDE = 8;
// One member poll (V3_ROOM_SUCCESSOR_POLL_MS, 15 s) plus an install, with margin.
const RECOVERY_MS = Number(process.env.UNPUBLISHED_ADOPTION_RECOVERY_MS ?? 40_000);

function required<Value>(value: Value | null | undefined): Value {
	if (value === undefined || value === null) throw new TypeError("UNPUBLISHED_ADOPTION_REQUIRED");
	return value;
}

afterEach(async () => {
	for (const close of closers) close();
	closers.clear();
	const joined = await Promise.allSettled([...rooms].map((room) => room.close()));
	rooms.clear();
	const headJoined = await Promise.allSettled([...heads].map((head) => head.close()));
	heads.clear();
	const nodeJoined = await Promise.allSettled([...nodes].map((node) => node.stop()));
	nodes.clear();
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
	directories.clear();
	expect(
		[...joined, ...headJoined, ...nodeJoined].filter((result) => result.status === "rejected"),
		"native owners join"
	).toEqual([]);
});

async function canvasRoom() {
	const directory = mkdtempSync(join(tmpdir(), "unpublished-adoption-"));
	directories.add(directory);
	const start = async (seed: string) => {
		const node = new DRPNode({
			keychain_config: { private_key_seed: seed },
			log_config: { level: "silent" },
			network_config: {
				bootstrap_peers: [],
				listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
				log_config: { level: "silent" },
			},
		});
		nodes.add(node);
		await node.start();
		return node;
	};
	const creatorNode = await start("unpublished-adoption-creator");
	const memberNode = await start("unpublished-adoption-member");
	const creatorPeer = creatorNode.networkNode.peerId;
	const connect = async () => {
		await memberNode.networkNode.connect(creatorNode.networkNode.getMultiaddrs() ?? []);
		await expect
			.poll(() => creatorNode.networkNode.getAllPeers(), { timeout: 15_000 })
			.toContain(memberNode.networkNode.peerId);
	};
	await connect();
	const application = createV3CanvasApplication(SIDE, SIDE);
	const objectId = `${creatorPeer}:${hex(hashDomain("unpublished-adoption/v1", new TextEncoder().encode(directory))).slice(0, 32)}`;
	const author = creatorNode.keychain.localAuthorId;
	const signers = [{ publicKey: author, signerId: "creator" }];
	const invite = await createV3RoomCreatorInviteMaterial({
		blueprintDigest: required(application.catalog.blueprintDigests[0]),
		exactCanonicalApplicationStateBytes: required(application.migration).canonicalStateBytes(
			application.projectAcceptedOperations({ authenticatedBase: undefined, currentEpochOperations: [] })
		),
		exactCanonicalLatchedAclBytes: encodeCanonical({
			epoch: 0,
			kind: "drp-v3-latched-acl",
			members: [{ author, finalityKey: author, groups: ["admin", "finality", "writer"] }],
			objectId,
			permissionless: false,
			version: CANVAS_GENESIS_PROFILE.latchedAclVersion,
		}),
		exactCanonicalParametersCarrierBytes: encodeCanonical({
			maxDependencies: 16,
			maxEpochBytes: 8_388_608,
			maxEpochVertices: 8192,
			maxPendingBytes: 16_777_216,
			maxPendingEntries: 4096,
			maxSnapshotBytes: 268_435_456,
			snapshotChunkBytes: 131_072,
		}),
		exactCanonicalProfileBytes: encodeCanonical({
			cryptoSuiteId: "ed25519-sha256-v3",
			profileId: CANVAS_GENESIS_PROFILE.profileId,
			quorum: 1,
			signers,
		}),
		exactCanonicalSignerSetBytes: encodeCanonical(signers),
		objectId,
		signGenesisAnchorDigest: (digest) => creatorNode.keychain.signWithLocalAuthor(digest),
	});
	// A store is created the first time a replica opens it and reopened after.
	const created = new Set<string>();
	const host = createNodeV3RoomStorageHost({
		directory,
		initialization: ({ name, family }) => {
			const key = `${name}/${family}`;
			if (created.has(key)) return "reopen";
			created.add(key);
			return "create";
		},
	});
	const open = async (name: string, node: DRPNode, role: "creator" | "member") => {
		const floor = await host.openRoomHead(name, { kind: "create" });
		heads.add(floor);
		const events: V3RoomRolloverEvent[] = [];
		const errors: unknown[] = [];
		const delivery: V3RoomSuccessorDelivery = createV3RoomSuccessorDelivery({
			role,
			objectId,
			channel: createV3RoomSuccessorChannel(node, objectId),
			// As the pages wire it (examples/grid/src/v3-zone.ts): a member pulling from behind a successor
			// the room adopted outside the policy has the policy publish it.
			hooks: { onError: (error) => errors.push(error), onMemberBehind: () => void policy?.publishCurrent() },
		});
		closers.add(() => delivery.close());
		const policy =
			role === "creator"
				? createV3RoomRolloverPolicy({
						role: "creator",
						budget: CANVAS_ROLLOVER_BUDGET,
						hooks: {
							publishSuccessor: (offer, successorEpoch) => delivery.publish(offer, successorEpoch),
							onRollover: (event) => events.push(event),
							onError: (error) => errors.push(error),
						},
					})
				: undefined;
		if (policy !== undefined) closers.add(() => policy.close());
		const room = await createV3RoomSession<CanvasProjection>({
			application,
			storageHost: host,
			recoveryPoolScheduledLull: true,
			author: node.keychain.localAuthorId,
			...(role === "creator"
				? { creatorFinalitySigner: await node.keychain.acquireLocalAuthorFinalitySigner() }
				: { receiveOnly: true as const }),
			creatorInvite: invite,
			databaseName: name,
			issuanceDatabaseName: name,
			migrationDatabaseNamespace: name,
			initialLogicalTime: 3,
			objectId,
			publicKeyBytes: Uint8Array.from(Buffer.from(node.keychain.localAuthorId, "hex")),
			roomHeadAuthority: floor,
			signRegisteredVertexDigest: (digest) => node.keychain.signWithLocalAuthor(digest),
			onProjection: () => undefined,
			onAcceptedVertex: (vertex) => policy?.observe(vertex),
			openTransport: (id) => node.openRoomNetwork(id),
		});
		rooms.add(room);
		await waitForV3RoomStartupForDiagnostics(room);
		policy?.bind(room);
		delivery.bind(room);
		return { room, policy, delivery, events, errors };
	};
	const creator = await open("creator", creatorNode, "creator");
	const member = await open("member", memberNode, "member");
	return { creatorNode, memberNode, creatorPeer, creator, member, connect };
}

const epochOf = (room: V3RoomSession<CanvasProjection>): number => room.authority()?.epoch ?? 0;
const paint = (index: number) =>
	toCanvasWireOperation(
		{ action: "paint", offset: [index % SIDE, Math.floor(index / SIDE) % SIDE], rgb: [index % 251, 7, 3] },
		`unpublished-${index}`
	);
async function until(predicate: () => boolean, timeoutMs: number, label: () => string): Promise<number> {
	const started = performance.now();
	while (!predicate()) {
		if (performance.now() - started > timeoutMs) throw new Error(`UNPUBLISHED_ADOPTION_TIMEOUT ${label()}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return Math.round(performance.now() - started);
}

type Fixture = Awaited<ReturnType<typeof canvasRoom>>;
/** The creator's policy rolls over `count` times on its own budget; the member follows each. */
async function rollThroughPolicy(fixture: Fixture, count: number, from: number, follow = true): Promise<number> {
	const policy = required(fixture.creator.policy);
	const target = fixture.creator.events.length + count;
	let index = from;
	while (fixture.creator.events.length < target) {
		await policy.issue(paint(index++));
		if (index % CANVAS_ROLLOVER_BUDGET.movesPerAuthor === 0) await policy.settled();
	}
	await policy.settled();
	if (follow)
		await until(
			() => epochOf(fixture.member.room) === epochOf(fixture.creator.room),
			60_000,
			() => `member follows the policy ${JSON.stringify(state(fixture))}`
		);
	return index;
}
const state = (fixture: Fixture) => ({
	creator: [epochOf(fixture.creator.room), fixture.creator.delivery.stats()],
	member: [epochOf(fixture.member.room), fixture.member.delivery.stats()],
	errors: [...fixture.creator.errors, ...fixture.member.errors].map(String).slice(0, 4),
});

it("a creator room that adopts a successor outside its policy (its own interrupted-close retry) is followed by a member while the creator stays idle", async () => {
	const fixture = await canvasRoom();
	await rollThroughPolicy(fixture, 2, 0);
	const before = epochOf(fixture.creator.room);
	const publishedBefore = fixture.creator.delivery.stats().announced;
	// The room's own close: the calls its interrupted-close retry makes, with no policy involved.
	await fixture.creator.room.sealEpoch();
	await fixture.creator.room.adoptCreatorSuccessor();
	expect(epochOf(fixture.creator.room), "the room adopted its successor by itself").toBe(before + 1);
	expect(fixture.creator.delivery.stats().announced, "nothing announced it").toBe(publishedBefore);
	// The creator is idle from here on: no move, no rollover.
	const installedAfterMs = await until(
		() => epochOf(fixture.member.room) === epochOf(fixture.creator.room),
		RECOVERY_MS,
		() => `member follows the room's own adoption within ${RECOVERY_MS} ms ${JSON.stringify(state(fixture))}`
	);
	console.log(`UNPUBLISHED_ADOPTION own-retry ${JSON.stringify({ installedAfterMs, ...state(fixture) })}`);
	expect(fixture.creator.events.length, "the policy did not roll").toBe(2);
	// The member keeps following the policy's rollovers afterwards.
	await rollThroughPolicy(fixture, 1, 100);
	expect(epochOf(fixture.member.room)).toBe(before + 2);
	await until(
		() =>
			encodeCanonical(fixture.member.room.projection().state).join() ===
			encodeCanonical(fixture.creator.room.projection().state).join(),
		30_000,
		() => "projections converge"
	);
}, 300_000);

it("a member whose connection to the creator dropped right after an announcement installs once it reconnects, while the creator stays idle", async () => {
	const fixture = await canvasRoom();
	const next = await rollThroughPolicy(fixture, 1, 0);
	// Drop the link, roll once (the announcement reaches no one), then the creator goes idle.
	await fixture.memberNode.networkNode.disconnect(fixture.creatorPeer);
	await fixture.creatorNode.networkNode.disconnect(fixture.memberNode.networkNode.peerId);
	await expect.poll(() => fixture.creatorNode.networkNode.getAllPeers(), { timeout: 15_000 }).toEqual([]);
	await rollThroughPolicy(fixture, 1, next, false);
	expect(epochOf(fixture.member.room), "the member missed the announcement").toBe(epochOf(fixture.creator.room) - 1);
	await fixture.connect();
	const installedAfterMs = await until(
		() => epochOf(fixture.member.room) === epochOf(fixture.creator.room),
		RECOVERY_MS,
		() => `member follows after reconnecting within ${RECOVERY_MS} ms ${JSON.stringify(state(fixture))}`
	);
	console.log(`UNPUBLISHED_ADOPTION reconnect ${JSON.stringify({ installedAfterMs, ...state(fixture) })}`);
}, 300_000);

it("a member that reconnects to a creator whose room adopted outside its policy while they were apart installs that successor, with the creator idle", async () => {
	const fixture = await canvasRoom();
	await rollThroughPolicy(fixture, 1, 0);
	await fixture.memberNode.networkNode.disconnect(fixture.creatorPeer);
	await fixture.creatorNode.networkNode.disconnect(fixture.memberNode.networkNode.peerId);
	await expect.poll(() => fixture.creatorNode.networkNode.getAllPeers(), { timeout: 15_000 }).toEqual([]);
	await fixture.creator.room.sealEpoch();
	await fixture.creator.room.adoptCreatorSuccessor();
	await fixture.connect();
	const installedAfterMs = await until(
		() => epochOf(fixture.member.room) === epochOf(fixture.creator.room),
		RECOVERY_MS,
		() => `member follows the room's own adoption after reconnecting ${JSON.stringify(state(fixture))}`
	);
	console.log(`UNPUBLISHED_ADOPTION own-retry-reconnect ${JSON.stringify({ installedAfterMs, ...state(fixture) })}`);
}, 300_000);
