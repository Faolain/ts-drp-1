/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local test helpers keep their inferred shapes. */
import type * as V3LiveModule from "@ts-drp/node/v3-live";
import { type DRPNetworkNode, type Message, MessageType, V3Envelope } from "@ts-drp/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	type CreatorDeliveryRoom,
	creatorDeliveryRoom,
	envelopeMessage,
	eventually,
	liveTopicOf,
	type Profile,
	ROOM_PARAMETERS,
	sleep,
} from "./fixtures/track-aa/creator-delivery-room.js";
import {
	admitted,
	ingressWarnings,
	openAll,
	type OpenedPeer,
	place,
	placedRows,
} from "./fixtures/track-aa/scenario.js";
import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { readV3RuntimeOwnerCensus } from "../packages/node/src/v3-live.js";

// The plane's ingress warnings (v3-live.ts `ingressFailureLog`) go to the console captured at
// module load. vi.hoisted runs before every import, so the recorder sees them.
const { warnings, planes } = vi.hoisted(() => {
	const recorded: unknown[][] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]): void => {
		recorded.push(args);
		if (process.env.TRACK_AA_ECHO_WARN === "1") original(...args);
	};
	return { warnings: recorded, planes: new Map<string, unknown>() };
});

// Every live plane a peer activates, by transport identity (for its census only).
vi.mock("@ts-drp/node/v3-live", async (importOriginal) => {
	const real = await importOriginal<typeof V3LiveModule>();
	return {
		...real,
		activateV3LivePlane: (...args: Parameters<typeof real.activateV3LivePlane>) => {
			const result = real.activateV3LivePlane(...args);
			if (result.ok) planes.set(args[0].networkNode.peerId, result.handle);
			return result;
		},
	};
});

// Track AA proofs (decision row 73: astra's acceptance list and the coordinator's four points).
// The room is the REDs' room: a Grid zone, the genuine room transport over Track X's in-memory
// network, and the node SQLite host. Each test states the bound it holds the repair to.

afterEach(async () => {
	planes.clear();
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const TEST_TIMEOUT = 240_000;
const HISTORY_REQUEST = new TextEncoder().encode("ts-drp-room-history-request-v1");
const PROFILES: readonly Profile[] = (process.env.TRACK_AA_PROFILES?.split(",") as Profile[] | undefined) ?? [
	"shipped",
	"settlement",
];
// The plane's census once nothing is queued, held or waiting for a repair signal.
const SETTLED = {
	admittedInputJobs: 0,
	admittedInputBytes: 0,
	admittedGossipQueueJobs: 0,
	admittedGossipQueueBytes: 0,
	pendingIngress: 0,
	pendingIngressBytes: 0,
	deliveryRepairWake: 0,
};

const isHistoryRequest = (message: Message) =>
	message.type === MessageType.MESSAGE_TYPE_CUSTOM &&
	message.data.byteLength === HISTORY_REQUEST.byteLength &&
	message.data.every((byte, index) => byte === HISTORY_REQUEST[index]);

/**
 * The creator's direct HISTORY_REQUESTs, by recipient and send time.
 * @param fixture - The room.
 * @param creatorPeer - The creator's transport identity.
 * @returns How many requests went to a peer at or after a time.
 */
function creatorRequests(fixture: CreatorDeliveryRoom, creatorPeer: string) {
	const requests: { to: string; at: number }[] = [];
	fixture.network.observe(({ kind, from, to, message }) => {
		if (kind === "direct" && from === creatorPeer && isHistoryRequest(message)) requests.push({ to, at: Date.now() });
	});
	return (peer: string, since = 0) => requests.filter((request) => request.to === peer && request.at >= since).length;
}

function planeCensus(peer: OpenedPeer) {
	return required(readV3RuntimeOwnerCensus(required(planes.get(peer.peerId)) as V3LiveModule.V3PlaneHandle));
}

function repairCensus(fixture: CreatorDeliveryRoom, peer: OpenedPeer) {
	return required(peer.adapter.readDeliveryRepairCensus(fixture.objectId));
}

async function settled(fixture: CreatorDeliveryRoom, creator: OpenedPeer): Promise<void> {
	const quiet = await eventually(() => {
		const plane = planeCensus(creator);
		const repair = repairCensus(fixture, creator);
		return (
			Object.entries(SETTLED).every(([field, value]) => plane[field] === value) &&
			repair.duePeers === 0 &&
			repair.sends === 0 &&
			repair.waitingForCapacity === 0
		);
	}, 10_000);
	expect(planeCensus(creator)).toMatchObject(SETTLED);
	expect(repairCensus(fixture, creator)).toMatchObject({ duePeers: 0, sends: 0, waitingForCapacity: 0 });
	expect(quiet).toBe(true);
}

/**
 * A copy with the same signed preimage (so the same digest) and an invalid signature.
 * @param message - The genuine row.
 * @param sender - The forger's transport identity.
 * @returns The forged copy.
 */
function forged(message: Message, sender: string): Message {
	const envelope = V3Envelope.decode(message.data);
	const data = V3Envelope.encode({
		canonicalPreimage: envelope.canonicalPreimage,
		signature: new Uint8Array(64).fill(7),
	}).finish();
	return envelopeMessage(message.objectId, data, sender);
}

/**
 * Gossip junk too large for the creator's gossip queue: refused at once, naming its sender.
 * @param sender - The publishing identity.
 * @param topic - The room's live topic.
 */
async function oversizedGossip(sender: DRPNetworkNode, topic: string): Promise<void> {
	const data = new Uint8Array(ROOM_PARAMETERS.maxPendingBytes / 2 + 1).fill(1);
	await sender.publishMessage(topic, envelopeMessage(topic, data, sender.peerId));
}

describe("Track AA proof: the admitted-copy filter (v3-live routeV3RetainedIngress)", () => {
	it(
		"a forged or genuine copy of an admitted row takes no input slot and gains nothing; an unknown copy still does",
		async () => {
			const fixture = await creatorDeliveryRoom({ profile: "shipped" });
			const [creator, writer] = await openAll(fixture);
			const hostile = fixture.bare("track-aa-hostile");
			const creatorPeer = required(creator).peerId;
			const ids = await place(required(writer), "dedup", 3);
			await fixture.network.idle();
			const rows = placedRows(fixture, required(writer), ids);
			expect(
				(
					await admitted(
						required(creator),
						rows.map((row) => row.digest)
					)
				).complete
			).toBe(true);
			await fixture.network.idle();
			// The creator is busy: a Writer row holds its FIFO, so any copy that entered the input
			// pool would keep its slot.
			fixture.creatorGate.hold();
			const entered = fixture.creatorGate.entered;
			await place(required(writer), "dedup-busy", 1, 1);
			await fixture.network.idle();
			await fixture.creatorGate.whenEntered(entered + 1);
			const before = planeCensus(required(creator));
			const acceptedBefore = required(creator).accepted.size;
			const mark = warnings.length;
			for (let copy = 0; copy < 100; copy++)
				for (const row of rows) {
					await hostile.sendMessage(creatorPeer, forged(row.message, hostile.peerId));
					await hostile.sendMessage(
						creatorPeer,
						envelopeMessage(row.message.objectId, row.message.data, hostile.peerId)
					);
				}
			await fixture.network.idle();
			const during = planeCensus(required(creator));
			expect(during.admittedInputJobs, "600 copies of admitted digests: no input slot").toBe(before.admittedInputJobs);
			expect(during.admittedInputBytes).toBe(before.admittedInputBytes);
			expect(warnings.length - mark, "no copy reached capture or authentication").toBe(0);
			// Control: copies of an unknown row take input slots.
			const topic = required(rows[0]).message.objectId;
			for (let copy = 0; copy < 10; copy++)
				await hostile.sendMessage(
					creatorPeer,
					envelopeMessage(topic, new Uint8Array(64).fill(copy + 1), hostile.peerId)
				);
			await fixture.network.idle();
			expect(planeCensus(required(creator)).admittedInputJobs).toBe(before.admittedInputJobs + 10);
			fixture.creatorGate.release();
			await fixture.network.idle();
			await settled(fixture, required(creator));
			// The busy row was counted when it entered the gate; no copy admitted anything more.
			expect(required(creator).accepted.size, "no copy was admitted").toBe(acceptedBefore);
		},
		TEST_TIMEOUT
	);

	it(
		"a copy of a queued, not yet admitted row, and of a held (pending) row, is not dropped",
		async () => {
			const fixture = await creatorDeliveryRoom({ profile: "shipped" });
			const [creator, writer] = await openAll(fixture);
			const creatorPeer = required(creator).peerId;
			const writerPeer = required(writer).peerId;
			const writerNode = required(fixture.nodes.get(writerPeer));
			// Queued: the first of two rows holds the FIFO (it is admitted: indexed before the
			// accepted-vertex callback), the second waits behind it.
			fixture.creatorGate.hold();
			const entered = fixture.creatorGate.entered;
			const queued = await place(required(writer), "queued", 2);
			await fixture.network.idle();
			await fixture.creatorGate.whenEntered(entered + 1);
			const queuedRows = placedRows(fixture, required(writer), queued);
			const before = planeCensus(required(creator)).admittedInputJobs;
			await writerNode.sendMessage(creatorPeer, required(queuedRows[1]).message);
			await fixture.network.idle();
			expect(planeCensus(required(creator)).admittedInputJobs, "the queued row's copy takes a slot").toBe(before + 1);
			await writerNode.sendMessage(creatorPeer, required(queuedRows[0]).message);
			await fixture.network.idle();
			expect(planeCensus(required(creator)).admittedInputJobs, "the admitted row's copy does not").toBe(before + 1);
			fixture.creatorGate.release();
			expect(
				(
					await admitted(
						required(creator),
						queuedRows.map((row) => row.digest)
					)
				).complete
			).toBe(true);
			// Pending: the parent never reaches the creator, and neither do the creator's repair
			// requests to the Writer, so the dependent stays held.
			fixture.network.lose(
				({ from, to, message }) => from === creatorPeer && to === writerPeer && isHistoryRequest(message)
			);
			const loseParent = fixture.network.lose(({ from, to }) => from === writerPeer && to === creatorPeer);
			await place(required(writer), "pending-parent", 1, 1);
			await fixture.network.idle();
			loseParent();
			const dependent = await place(required(writer), "pending-dependent", 1, 2);
			await fixture.network.idle();
			expect(planeCensus(required(creator)).pendingIngress, "the dependent is held").toBe(1);
			const [dependentRow] = placedRows(fixture, required(writer), dependent);
			const mark = warnings.length;
			await writerNode.sendMessage(creatorPeer, required(dependentRow).message);
			await fixture.network.idle();
			expect(ingressWarnings(warnings, mark)["graph-rejected"], "the held row's copy was authenticated again").toBe(1);
		},
		TEST_TIMEOUT
	);

	it(
		"a successor plane does not drop a copy of its predecessor's row, and the predecessor's repair state ends",
		async () => {
			const fixture = await creatorDeliveryRoom({ profile: "shipped" });
			const creator = await fixture.open(0);
			const hostile = fixture.bare("track-aa-hostile");
			await creator.room.issue({ action: "placeBlock", id: "epoch-0-row", kind: "stone", x: 0, y: 0 });
			await fixture.network.idle();
			const author = required(fixture.identities[0]).author;
			const epoch0 = required(fixture.sentBy(creator.peerId, author).at(-1)).message;
			const topic = epoch0.objectId;
			// A refusal makes the plane report: the repair is bound to it.
			await oversizedGossip(hostile, topic);
			await fixture.network.idle();
			expect(repairCensus(fixture, creator).planeBound, "the epoch-0 plane reported").toBe(1);
			let mark = warnings.length;
			await hostile.sendMessage(creator.peerId, envelopeMessage(topic, epoch0.data, hostile.peerId));
			await fixture.network.idle();
			expect(warnings.length - mark, "epoch 0: the copy of its admitted row is dropped").toBe(0);
			const sealed = await creator.room.sealEpoch();
			expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
			await creator.room.adoptCreatorSuccessor();
			expect(creator.room.authority()?.epoch).toBe(1);
			const adopted = repairCensus(fixture, creator);
			expect(adopted.clears, "the retired plane's repair state was cleared").toBeGreaterThanOrEqual(1);
			expect(adopted).toMatchObject({ peers: 0, sends: 0, planeBound: 0, timers: 0 });
			mark = warnings.length;
			await hostile.sendMessage(creator.peerId, envelopeMessage(topic, epoch0.data, hostile.peerId));
			await fixture.network.idle();
			await sleep(200);
			expect(warnings.length - mark, "epoch 1: the epoch-0 row's copy goes to ordinary admission").toBeGreaterThan(0);
			await creator.room.issue({ action: "placeBlock", id: "epoch-1-row", kind: "stone", x: 2, y: 0 });
			await fixture.network.idle();
			const epoch1 = required(fixture.sentBy(creator.peerId, author).at(-1)).message;
			mark = warnings.length;
			await hostile.sendMessage(creator.peerId, envelopeMessage(topic, epoch1.data, hostile.peerId));
			await fixture.network.idle();
			expect(warnings.length - mark, "epoch 1: the copy of its own admitted row is dropped").toBe(0);
		},
		TEST_TIMEOUT
	);
});

describe.each(PROFILES)("Track AA proof, %s profile: repair under load", (profile) => {
	it(
		"three Writers outpacing a slow creator: every row is admitted, with bounded requests and state",
		async () => {
			const fixture = await creatorDeliveryRoom({ profile, writers: 3 });
			const peers = await openAll(fixture);
			const creator = required(peers[0]);
			const writers = peers.slice(1);
			const asked = creatorRequests(fixture, creator.peerId);
			// The creator is slow (20 ms per accepted vertex) throughout and stopped while the
			// Writers issue: the repair runs against repeated overload.
			fixture.creatorGate.slow(20);
			fixture.creatorGate.hold();
			const mark = warnings.length;
			const ids = await Promise.all(writers.map((writer, index) => place(writer, `w${index}`, 40, index * 5)));
			await fixture.network.idle();
			const refusals = ingressWarnings(warnings, mark)["admission-rejected"] ?? 0;
			expect(refusals, "precondition: refusals at the creator").toBeGreaterThan(0);
			const digests = writers.flatMap((writer, index) =>
				placedRows(fixture, writer, required(ids[index])).map((row) => row.digest)
			);
			const released = Date.now();
			fixture.creatorGate.release();
			const result = await admitted(creator, digests, 60_000);
			const elapsed = Date.now() - released;
			const requests = writers.map((writer) => asked(writer.peerId, released));
			console.info(
				`TRACK_AA_PROOF multi-writer ${profile}: ${result.count}/${result.of} in ${elapsed} ms after release, ` +
					`refusals ${refusals}, requests per Writer ${JSON.stringify(requests)}`
			);
			expect(result, `creator admitted ${result.count} of ${result.of}`).toMatchObject({ complete: true });
			// Each Writer is asked at most once per second, plus the first ask.
			for (const count of requests) expect(count).toBeLessThanOrEqual(Math.ceil(elapsed / 1_000) + 1);
			fixture.creatorGate.slow(0);
			await settled(fixture, creator);
			const repair = repairCensus(fixture, creator);
			expect(repair.peers).toBeLessThanOrEqual(3);
			expect(repair.peerBytes).toBeLessThanOrEqual(3 * (64 + 128));
		},
		TEST_TIMEOUT
	);

	it(
		"fairness: a Writer that blackholes HISTORY_REQUEST does not hold back another Writer",
		async () => {
			const fixture = await creatorDeliveryRoom({ profile, writers: 2 });
			const [creator, deaf, healthy] = await openAll(fixture);
			const creatorPeer = required(creator).peerId;
			const deafPeer = required(deaf).peerId;
			const healthyPeer = required(healthy).peerId;
			const asked = creatorRequests(fixture, creatorPeer);
			fixture.network.lose(
				({ from, to, message }) => from === creatorPeer && to === deafPeer && isHistoryRequest(message)
			);
			// The deaf Writer's rows can come from the deaf Writer only: the healthy Writer never
			// sees them (so its journal cannot replay them and its rows do not depend on them).
			fixture.network.lose(({ from, to }) => from === deafPeer && to === healthyPeer);
			fixture.creatorGate.hold();
			const mark = warnings.length;
			// The deaf Writer issues first, so it is first in the repair's order.
			const deafIds = await place(required(deaf), "deaf", 40, 0);
			const healthyIds = await place(required(healthy), "healthy", 40, 5);
			await fixture.network.idle();
			expect(ingressWarnings(warnings, mark)["admission-rejected"] ?? 0, "precondition: refusals").toBeGreaterThan(0);
			const healthyRows = placedRows(fixture, required(healthy), healthyIds);
			const deafRows = placedRows(fixture, required(deaf), deafIds);
			// From here the deaf Writer sends the creator nothing directly either (its open-time
			// republication schedule included): it is asked, and never answers.
			fixture.network.lose(({ kind, from, to }) => kind === "direct" && from === deafPeer && to === creatorPeer);
			const released = Date.now();
			fixture.creatorGate.release();
			// Stated bound: every row of the healthy Writer within 10 s of release. Its request goes
			// out at the plane's low-water signal, at most one 250 ms spacing after the deaf
			// Writer's, and its replay is then admitted at the creator's own pace.
			const result = await admitted(
				required(creator),
				healthyRows.map((row) => row.digest),
				10_000
			);
			const elapsed = Date.now() - released;
			await sleep(5_000);
			const window = Date.now() - released;
			const deafAsked = asked(deafPeer, released);
			const deafAdmitted = deafRows.filter((row) => required(creator).accepted.has(row.digest)).length;
			console.info(
				`TRACK_AA_PROOF fairness ${profile}: healthy ${result.count}/${result.of} in ${elapsed} ms; deaf asked ` +
					`${deafAsked} times in ${window} ms, ${deafAdmitted}/${deafRows.length} admitted`
			);
			expect(result, `healthy Writer: ${result.count} of ${result.of} within 10 s`).toMatchObject({ complete: true });
			expect(deafAsked, "the deaf Writer was asked").toBeGreaterThan(0);
			expect(deafAsked, "at most once per second").toBeLessThanOrEqual(Math.ceil(window / 1_000) + 1);
			expect(deafAdmitted, "scenario check: the deaf Writer's refused rows stay missing").toBeLessThan(deafRows.length);
			expect(repairCensus(fixture, required(creator)).peers).toBeLessThanOrEqual(2);
		},
		TEST_TIMEOUT
	);

	it(
		"a disconnected Writer is dropped from the repair; once back, its next row brings its gap back",
		async () => {
			const fixture = await creatorDeliveryRoom({ profile, writers: 2 });
			const [creator, gone, staying] = await openAll(fixture);
			const creatorNode = required(creator).networkNode;
			const gonePeer = required(gone).peerId;
			fixture.creatorGate.hold();
			const goneIds = await place(required(gone), "gone", 40, 0);
			const stayingIds = await place(required(staying), "staying", 40, 5);
			await fixture.network.idle();
			// The Writer disconnects from the creator before the creator has room again.
			const allPeers = creatorNode.getAllPeers.bind(creatorNode);
			Object.assign(creatorNode, { getAllPeers: () => allPeers().filter((peer) => peer !== gonePeer) });
			const cut = fixture.network.lose(({ from, to }) => from === gonePeer || to === gonePeer);
			fixture.creatorGate.release();
			const stayingRows = placedRows(fixture, required(staying), stayingIds).map((row) => row.digest);
			expect((await admitted(required(creator), stayingRows)).complete, "the connected Writer recovers").toBe(true);
			expect(
				await eventually(() => repairCensus(fixture, required(creator)).unreachablePeers > 0, 5_000),
				"the disconnected Writer was dropped"
			).toBe(true);
			// Back: its next row depends on its own missing rows, so the creator asks it again.
			Object.assign(creatorNode, { getAllPeers: allPeers });
			cut();
			const next = await place(required(gone), "gone-next", 1, 4);
			await fixture.network.idle();
			const goneRows = placedRows(fixture, required(gone), [...goneIds, ...next]).map((row) => row.digest);
			const result = await admitted(required(creator), goneRows);
			expect(result, `the reconnected Writer: ${result.count} of ${result.of}`).toMatchObject({ complete: true });
		},
		TEST_TIMEOUT
	);
});

describe("Track AA proof: hostile peers and teardown", () => {
	it(
		"a hostile peer that keeps provoking refusals and answers with the whole history: 1 request/s, no input slot",
		async () => {
			const fixture = await creatorDeliveryRoom({ profile: "shipped" });
			const [creator, writer] = await openAll(fixture);
			const creatorPeer = required(creator).peerId;
			const hostile = fixture.bare("track-aa-hostile");
			const ids = await place(required(writer), "history", 30);
			await fixture.network.idle();
			const rows = placedRows(fixture, required(writer), ids);
			expect(
				(
					await admitted(
						required(creator),
						rows.map((row) => row.digest)
					)
				).complete
			).toBe(true);
			await fixture.network.idle();
			const asked = creatorRequests(fixture, creatorPeer);
			let answers = 0;
			fixture.network.observe(({ to, message }) => {
				if (to !== hostile.peerId || !isHistoryRequest(message)) return;
				answers++;
				void (async () => {
					for (const row of rows)
						await hostile.sendMessage(
							creatorPeer,
							envelopeMessage(row.message.objectId, row.message.data, hostile.peerId)
						);
				})();
			});
			let maxInputJobs = 0;
			const sampler = setInterval(() => {
				maxInputJobs = Math.max(maxInputJobs, planeCensus(required(creator)).admittedInputJobs);
			}, 5);
			const mark = warnings.length;
			const started = Date.now();
			const topic = required(rows[0]).message.objectId;
			for (let round = 0; round < 15; round++) {
				await oversizedGossip(hostile, topic);
				await sleep(300);
			}
			await fixture.network.idle();
			await sleep(1_500);
			clearInterval(sampler);
			const elapsed = Date.now() - started;
			const requests = asked(hostile.peerId);
			const counts = ingressWarnings(warnings, mark);
			console.info(
				`TRACK_AA_PROOF hostile-history: ${requests} requests in ${elapsed} ms, ${answers} whole-history answers ` +
					`(${answers * rows.length} copies), max input jobs ${maxInputJobs}, warnings ${JSON.stringify(counts)}`
			);
			expect(requests, "the hostile peer was asked").toBeGreaterThan(0);
			expect(requests, "at most once per second").toBeLessThanOrEqual(Math.ceil(elapsed / 1_000) + 1);
			expect(maxInputJobs, "the replayed admitted rows took no input slot").toBe(0);
			expect(Object.keys(counts), "only the oversized gossip was refused").toEqual(["admission-rejected"]);
			await settled(fixture, required(creator));
		},
		TEST_TIMEOUT
	);

	it(
		"saturation: 80 refusing hostile peers fill the set; a Writer's held row still brings its gap back",
		async () => {
			const fixture = await creatorDeliveryRoom({ profile: "shipped" });
			const [creator, writer] = await openAll(fixture);
			const creatorPeer = required(creator).peerId;
			const sybils = Array.from({ length: 80 }, (_, index) => fixture.bare(`track-aa-sybil-${index}`));
			await place(required(writer), "saturation-warmup", 1);
			await fixture.network.idle();
			const topic = liveTopicOf(fixture, required(writer).peerId);
			fixture.creatorGate.hold();
			const entered = fixture.creatorGate.entered;
			await place(required(writer), "saturation-busy", 1, 1);
			await fixture.network.idle();
			await fixture.creatorGate.whenEntered(entered + 1);
			// Fill the input pool, then each sybil's copy is refused (one refusal each).
			const first = required(sybils[0]);
			for (let copy = 0; copy < 32; copy++)
				await first.sendMessage(creatorPeer, envelopeMessage(topic, new Uint8Array(32).fill(copy + 1), first.peerId));
			for (const sybil of sybils)
				await sybil.sendMessage(creatorPeer, envelopeMessage(topic, new Uint8Array(32).fill(99), sybil.peerId));
			await fixture.network.idle();
			// The Writer's rows are refused too; with the set full its refused copies are not
			// remembered (the bound's stated non-guarantee).
			const refusedBefore = repairCensus(fixture, required(creator)).refusedPeers;
			const refusedIds = await place(required(writer), "saturation-refused", 40, 2);
			await fixture.network.idle();
			const saturated = repairCensus(fixture, required(creator));
			console.info(`TRACK_AA_PROOF saturation: ${JSON.stringify(saturated)}`);
			expect(saturated.peers).toBe(64);
			expect(saturated.peerBytes).toBeLessThanOrEqual(64 * (64 + 128));
			expect(saturated.refusedPeers, "the Writer's refused copies were not remembered").toBeGreaterThan(refusedBefore);
			fixture.creatorGate.release();
			await fixture.network.idle();
			// Its next row depends on its refused rows: authenticated and held, it names the Writer,
			// which replaces a sybil in the set and is asked first.
			const next = await place(required(writer), "saturation-next", 1, 7);
			await fixture.network.idle();
			const rows = placedRows(fixture, required(writer), [...refusedIds, ...next]).map((row) => row.digest);
			const started = Date.now();
			const result = await admitted(required(creator), rows);
			console.info(`TRACK_AA_PROOF saturation: Writer ${result.count}/${result.of} in ${Date.now() - started} ms`);
			expect(result, `the Writer: ${result.count} of ${result.of}`).toMatchObject({ complete: true });
			expect(repairCensus(fixture, required(creator)).evictedPeers).toBeGreaterThan(0);
		},
		TEST_TIMEOUT
	);

	it(
		"close joins the repair: no remembered peer, timer or request outlives the room",
		async () => {
			const fixture = await creatorDeliveryRoom({ profile: "shipped" });
			const [creator, writer] = await openAll(fixture);
			fixture.creatorGate.hold();
			await place(required(writer), "close", 40);
			await fixture.network.idle();
			const during = repairCensus(fixture, required(creator));
			expect(during.peers, "the room holds repair state").toBeGreaterThan(0);
			fixture.creatorGate.release();
			const closing = required(creator).room.close();
			await closing;
			expect(required(creator).adapter.readDeliveryRepairCensus(fixture.objectId), "the repair is gone").toBe(
				undefined
			);
			expect(required(creator).adapter.activeObjectIds()).toEqual([]);
		},
		TEST_TIMEOUT
	);
});
