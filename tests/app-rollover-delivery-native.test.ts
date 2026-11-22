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
	V3_ROOM_SUCCESSOR_OFFER_MAX_BYTES,
	type V3RoomRolloverEvent,
	type V3RoomSession,
	type V3RoomSuccessorChannel,
	type V3RoomSuccessorDelivery,
	type V3RoomSuccessorOffer,
	waitForV3RoomStartupForDiagnostics,
} from "../examples/v3-room/src/index.js";
import { toCanvasWireOperation } from "../packages/blueprints/src/v3-canvas.js";
import { type CanvasProjection, createV3CanvasApplication } from "../packages/node/src/applications/canvas.js";
import { DRPNode } from "../packages/node/src/index.js";
import { createNodeV3RoomStorageHost } from "../packages/storage-node/src/v3-room-host.js";

// App rollover delivery, items 1 and 4: the shipped Canvas over three real DRPNodes on local
// libp2p (the pages' own `node.openRoomNetwork` transport and the network node's direct streams),
// a creator and two receive-only observers, as the page opens them. No offer is passed by the
// harness: the creator's rollover policy publishes each adopted offer through the shared
// successor delivery, and each observer's delivery installs it. One observer is cut off for three
// rollovers and catches up by asking the creator; nothing the creator admitted is lost.
// A forged and a stale offer reach an observer through the same delivery path: its install refuses
// them, with no change to its epoch, projection or durable head.

const directories = new Set<string>();
const nodes = new Set<DRPNode>();
const rooms = new Set<V3RoomSession<CanvasProjection>>();
const closers = new Set<() => void>();
const heads = new Set<{ close(): Promise<void> }>();
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const ROLLOVERS = Number(process.env.APP_ROLLOVER_DELIVERY_ROLLOVERS ?? 11);
const SIDE = 8;
// RED control: APP_ROLLOVER_DELIVERY_WITHOUT=1 opens the pages as 5d4cb12f did, with no delivery
// (the creator publishes nowhere, observers never ask); the observers strand at the first rollover.
const WITHOUT_DELIVERY = process.env.APP_ROLLOVER_DELIVERY_WITHOUT === "1";

function required<Value>(value: Value | null | undefined): Value {
	if (value === undefined || value === null) throw new TypeError("APP_ROLLOVER_DELIVERY_REQUIRED");
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

/** A channel whose frames the test can also inject, as if a peer had sent them. */
function tapped(channel: V3RoomSuccessorChannel) {
	const listeners = new Set<(sender: string, bytes: Uint8Array) => void>();
	return {
		channel: Object.freeze({
			...channel,
			listen: (listener: (sender: string, bytes: Uint8Array) => void) => {
				listeners.add(listener);
				const stop = channel.listen(listener);
				return () => {
					listeners.delete(listener);
					stop();
				};
			},
		}) as V3RoomSuccessorChannel,
		inject: (sender: string, bytes: Uint8Array) => {
			for (const listener of listeners) listener(sender, bytes);
		},
	};
}

async function canvasRoom() {
	const directory = mkdtempSync(join(tmpdir(), "app-rollover-delivery-"));
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
	const creatorNode = await start("app-rollover-delivery-creator");
	const memberNodes = [await start("app-rollover-delivery-member-1"), await start("app-rollover-delivery-member-2")];
	const creatorPeer = creatorNode.networkNode.peerId;
	const connect = async (node: DRPNode) => {
		await node.networkNode.connect(creatorNode.networkNode.getMultiaddrs() ?? []);
		await expect
			.poll(() => creatorNode.networkNode.getAllPeers(), { timeout: 15_000 })
			.toContain(node.networkNode.peerId);
	};
	for (const node of memberNodes) await connect(node);
	const application = createV3CanvasApplication(SIDE, SIDE);
	const objectId = `${creatorPeer}:${hex(hashDomain("app-rollover-delivery/v1", new TextEncoder().encode(directory))).slice(0, 32)}`;
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
	// A store is created the first time a replica opens it and reopened after (a page reload); an
	// observer may first open a store (its received snapshots) only after it reopened.
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
	const open = async (name: string, node: DRPNode, role: "creator" | "member", reopen = false) => {
		const selectedHost = host;
		const floor = await selectedHost.openRoomHead(name, { kind: reopen ? "reopen" : "create" });
		heads.add(floor);
		const accepted = new Set<string>();
		const events: V3RoomRolloverEvent[] = [];
		const offers: { offer: V3RoomSuccessorOffer; successorEpoch: number }[] = [];
		const errors: unknown[] = [];
		const tap = tapped(createV3RoomSuccessorChannel(node, objectId));
		const delivery: V3RoomSuccessorDelivery = createV3RoomSuccessorDelivery({
			role,
			objectId,
			channel: tap.channel,
			hooks: { onError: (error) => errors.push(error) },
		});
		closers.add(() => delivery.close());
		const policy =
			role === "creator"
				? createV3RoomRolloverPolicy({
						role: "creator",
						budget: CANVAS_ROLLOVER_BUDGET,
						hooks: {
							publishSuccessor: async (offer, successorEpoch) => {
								offers.push({ offer, successorEpoch });
								if (!WITHOUT_DELIVERY) await delivery.publish(offer, successorEpoch);
							},
							onRollover: (event) => events.push(event),
							onError: (error) => errors.push(error),
						},
					})
				: undefined;
		if (policy !== undefined) closers.add(() => policy.close());
		const room = await createV3RoomSession<CanvasProjection>({
			application,
			storageHost: selectedHost,
			// As the browser binding opens every new room (examples/v3-room createV3RoomSession).
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
			onAcceptedVertex: (vertex) => {
				accepted.add(hex(vertex.digest));
				policy?.observe(vertex);
			},
			openTransport: (id) => node.openRoomNetwork(id),
		});
		rooms.add(room);
		await waitForV3RoomStartupForDiagnostics(room);
		policy?.bind(room);
		if (!WITHOUT_DELIVERY) delivery.bind(room);
		const close = async () => {
			delivery.close();
			policy?.close();
			await room.close();
			rooms.delete(room);
			await floor.close();
			heads.delete(floor);
		};
		return { name, node, room, policy, delivery, inject: tap.inject, accepted, events, offers, errors, close };
	};
	return { creatorNode, memberNodes, creatorPeer, objectId, open, connect };
}

const epochOf = (room: V3RoomSession<CanvasProjection>): number => room.authority()?.epoch ?? 0;
const paint = (index: number) =>
	toCanvasWireOperation(
		{ action: "paint", offset: [index % SIDE, Math.floor(index / SIDE) % SIDE], rgb: [index % 251, 7, 3] },
		`delivery-${index}`
	);
async function until(predicate: () => boolean, timeoutMs: number, label: string | (() => string)): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!predicate()) {
		if (performance.now() > deadline)
			throw new Error(`APP_ROLLOVER_DELIVERY_TIMEOUT ${typeof label === "string" ? label : label()}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

it(`Canvas creator and two observers over real libp2p follow ${ROLLOVERS} automatic rollovers through the page delivery; one observer misses three and catches up`, async () => {
	const fixture = await canvasRoom();
	const creator = await fixture.open("creator", fixture.creatorNode, "creator");
	const steady = await fixture.open("member-1", required(fixture.memberNodes[0]), "member");
	let late = await fixture.open("member-2", required(fixture.memberNodes[1]), "member");
	const lateInstalls: number[] = [];
	const creatorPolicy = required(creator.policy);
	const progress: string[] = [];
	const issued: string[] = [];
	let moves = 0;
	let cutAt: number | undefined;
	let rejoinedAt: number | undefined;
	let lateEpochWhileCut: number | undefined;
	const budget = CANVAS_ROLLOVER_BUDGET.movesPerAuthor;
	while (creator.events.length < ROLLOVERS) {
		await creatorPolicy.issue(paint(moves));
		issued.push(`delivery-${moves}`);
		moves++;
		if (moves % budget === 0) await creatorPolicy.settled();
		const rolled = creator.events.length;
		if (cutAt === undefined && rolled >= 3) {
			// Cut the late observer off: its page closes the room and its node disconnects from the
			// creator. It reopens the same replica three rollovers later.
			await creatorPolicy.settled();
			await until(
				() => epochOf(late.room) === epochOf(creator.room),
				60_000,
				() =>
					`late observer at the cut ${JSON.stringify({
						creator: [epochOf(creator.room), creator.delivery.stats()],
						steady: [epochOf(steady.room), steady.delivery.stats()],
						late: [epochOf(late.room), late.delivery.stats()],
						errors: creator.errors.map(String),
					})}`
			);
			cutAt = rolled;
			lateEpochWhileCut = epochOf(late.room);
			lateInstalls.push(late.delivery.stats().installed);
			await late.close();
			await late.node.networkNode.disconnect(fixture.creatorPeer);
			await fixture.creatorNode.networkNode.disconnect(late.node.networkNode.peerId);
			progress.push(`cut late observer at rollover ${rolled}, epoch ${lateEpochWhileCut}`);
		}
		if (cutAt !== undefined && rejoinedAt === undefined && rolled >= cutAt + 3) {
			await creatorPolicy.settled();
			rejoinedAt = rolled;
			await fixture.connect(late.node);
			late = await fixture.open("member-2", required(fixture.memberNodes[1]), "member", true);
			expect(epochOf(late.room), "the reopened observer starts where it was cut off").toBe(lateEpochWhileCut);
			progress.push(`rejoined late observer at rollover ${rolled}, creator epoch ${epochOf(creator.room)}`);
		}
		if (moves > ROLLOVERS * budget * 3) throw new Error(`APP_ROLLOVER_DELIVERY_NO_PROGRESS ${progress.join("; ")}`);
	}
	await creatorPolicy.settled();
	const finalEpoch = epochOf(creator.room);
	await until(
		() => epochOf(steady.room) === finalEpoch && epochOf(late.room) === finalEpoch,
		120_000,
		() =>
			`members at epoch ${finalEpoch}: ${JSON.stringify({
				creator: [epochOf(creator.room), creator.delivery.stats()],
				steady: [epochOf(steady.room), steady.delivery.stats()],
				late: [epochOf(late.room), late.delivery.stats()],
				progress,
			})}`
	);
	await until(
		() =>
			encodeCanonical(steady.room.projection().state).join() ===
				encodeCanonical(creator.room.projection().state).join() &&
			encodeCanonical(late.room.projection().state).join() === encodeCanonical(creator.room.projection().state).join(),
		60_000,
		"projections converge"
	);
	console.log(
		"APP_ROLLOVER_DELIVERY",
		JSON.stringify({
			moves,
			rollovers: creator.events.length,
			triggers: creator.events.map((event) => event.trigger),
			finalEpoch,
			creator: creator.delivery.stats(),
			steady: steady.delivery.stats(),
			late: late.delivery.stats(),
			progress,
			rolloverMs: creator.events.map((event) => Math.round(event.ms)),
		})
	);
	expect(creator.events.length).toBeGreaterThanOrEqual(10);
	expect(
		creator.events.filter((event) => event.trigger === "refusal"),
		"no capacity refusal"
	).toEqual([]);
	expect(creator.errors, "creator policy and delivery errors").toEqual([]);
	expect(rejoinedAt, "the late observer was cut for three rollovers and rejoined").toBeDefined();
	// Nothing lost: every creator move is in the creator's state, and both observers hold that state.
	expect(creator.accepted.size, "every paint the creator issued was admitted").toBe(moves);
	expect(steady.room.projection().state).toEqual(creator.room.projection().state);
	expect(late.room.projection().state).toEqual(creator.room.projection().state);
	// Each observer installs the latest offer it holds; when the creator rolls over again during an
	// install, the creator refuses the stale fetch and the observer installs the newer offer over the
	// gap (the creator's reattachment checkpoint), so installs can be fewer than rollovers. The late
	// observer's three missed rollovers are covered by one install after it rejoined.
	expect(steady.delivery.stats().installed).toBeGreaterThanOrEqual(Math.ceil(creator.events.length / 2));
	const lateTotal = required(lateInstalls[0]) + late.delivery.stats().installed;
	expect(lateTotal).toBeLessThanOrEqual(creator.events.length - 2);
	expect(lateTotal).toBeGreaterThanOrEqual(1);
	expect(creator.delivery.stats().largestOfferBytes).toBeLessThan(V3_ROOM_SUCCESSOR_OFFER_MAX_BYTES);
}, 600_000);

it("a forged and a stale offer reach an observer through the delivery and are refused with no state change", async () => {
	const fixture = await canvasRoom();
	const creator = await fixture.open("creator", fixture.creatorNode, "creator");
	const observer = await fixture.open("member-1", required(fixture.memberNodes[0]), "member");
	const creatorPolicy = required(creator.policy);
	const budget = CANVAS_ROLLOVER_BUDGET.movesPerAuthor;
	for (let index = 0; creator.events.length < 2; index++) {
		await creatorPolicy.issue(paint(index));
		if ((index + 1) % budget === 0) await creatorPolicy.settled();
	}
	await creatorPolicy.settled();
	await until(
		() => epochOf(observer.room) === epochOf(creator.room),
		60_000,
		() =>
			`observer follows ${JSON.stringify({
				creator: [epochOf(creator.room), creator.delivery.stats()],
				observer: [epochOf(observer.room), observer.delivery.stats()],
				errors: [...creator.errors, ...observer.errors].map(String),
			})}`
	);
	const current = epochOf(observer.room);
	const stale = required(creator.offers.at(-2));
	const latest = required(creator.offers.at(-1));
	const before = {
		epoch: current,
		authority: observer.room.authority(),
		state: encodeCanonical(observer.room.projection().state),
		acl: encodeCanonical(observer.room.previewLatchedAcl()),
	};
	const frame = (offer: V3RoomSuccessorOffer, successorEpoch: number) =>
		encodeCanonical(
			{
				kind: "ts-drp-v3-successor-offer",
				version: 1,
				successorEpoch,
				cut: offer.exactCanonicalCutValueBytes,
				qc: offer.exactCanonicalCommitQcBytes,
				trust: offer.exactCanonicalTrustStateRecordBytes,
				manifest: offer.exactCanonicalSnapshotManifestBytes,
			},
			{ maxBytes: V3_ROOM_SUCCESSOR_OFFER_MAX_BYTES, maxDepth: 2, maxItems: 64 }
		);
	// Forged: the latest offer with one byte of its commit QC changed, claiming the next epoch.
	const qc = Uint8Array.from(latest.offer.exactCanonicalCommitQcBytes);
	qc[qc.length - 5] = (qc[qc.length - 5] ?? 0) ^ 0xff;
	const forged = { ...latest.offer, exactCanonicalCommitQcBytes: qc };
	// Stale: an offer the observer already installed, with an envelope hint claiming a later epoch.
	for (const [label, bytes] of [
		["forged", frame(forged, current + 1)],
		["stale", frame(stale.offer, current + 5)],
	] as const) {
		const refusedBefore = observer.delivery.stats().refused;
		observer.inject(fixture.creatorPeer, bytes);
		await until(() => observer.delivery.stats().refused === refusedBefore + 1, 30_000, `${label} refused`);
		await observer.delivery.idle();
		expect(epochOf(observer.room), `${label}: epoch unchanged`).toBe(before.epoch);
		expect(observer.room.authority(), `${label}: authority unchanged`).toEqual(before.authority);
		expect(encodeCanonical(observer.room.projection().state), `${label}: projection unchanged`).toEqual(before.state);
		expect(encodeCanonical(observer.room.previewLatchedAcl()), `${label}: latched ACL unchanged`).toEqual(before.acl);
		console.log("APP_ROLLOVER_DELIVERY_REFUSED", label, observer.delivery.stats().lastError);
	}
	// A stale offer whose hint is honest is skipped without an install attempt.
	const ignoredBefore = observer.delivery.stats().ignored;
	observer.inject(fixture.creatorPeer, frame(stale.offer, stale.successorEpoch));
	await until(() => observer.delivery.stats().ignored === ignoredBefore + 1, 5_000, "honest stale skipped");
	// The real next successor still installs through the same delivery.
	for (let index = 100; creator.events.length < 3; index++) {
		await creatorPolicy.issue(paint(index));
		if ((index + 1) % budget === 0) await creatorPolicy.settled();
	}
	await creatorPolicy.settled();
	await until(() => epochOf(observer.room) === epochOf(creator.room), 60_000, "observer follows after the refusals");
	expect(epochOf(observer.room)).toBe(current + 1);
	await until(
		() =>
			encodeCanonical(observer.room.projection().state).join() ===
			encodeCanonical(creator.room.projection().state).join(),
		30_000,
		"observer converges"
	);
}, 300_000);
