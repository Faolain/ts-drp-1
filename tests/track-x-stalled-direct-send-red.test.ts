import { type Message, MessageType } from "@ts-drp/types";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery } from "./fixtures/track-m/settlement-room.js";
import { asSettlementRoom, fenceDeliveryRoom, type FenceDeliveryRoom } from "./fixtures/track-x/fence-delivery-room.js";

// Track X RED (Canvas harness hang, coordinator 2026-10-21): a direct send that never
// completes must not hold a room forever.
//
// A recipient asks the creator for retained history with a direct HISTORY_REQUEST
// (room-network.ts #performRequest). The creator answers with a targeted republication
// (room-network.ts routes it to `publisher(sender)`; v3-live.ts
// enqueueTargetedRetainedPublication), a task in the creator's live-plane FIFO that sends one
// direct message per retained row and awaits each (`republishRetained`,
// `networkNode.sendMessage(target, message)`, no signal). The genuine `sendMessage` has no
// bound without a signal: libp2p's stream close waits for the stream to go idle or drain, with
// no timeout (@libp2p/utils AbstractStream.close); a WebRTC data channel that never opens, for
// example, never drains. Until that send settles, every later task of the creator's plane waits behind
// it: its moves, its seal, its close. The Track X fix (24699ced) makes the recipient ask after
// every install, so a creator answers a direct request at every successor, not only in the
// first 15 s after a peer opens (RETAINED_REQUEST_DELAYS).
//
// The recipient's own HISTORY_REQUEST send has the same shape: `#performRequest` awaits it with
// no signal, and `#request` lets one attempt run at a time. A request whose send never
// settles leaves every later request joined to it: the recipient never asks again, and a
// creator move held for a missing dependency is never repaired.
//
// Here the network's `sendMessage` stalls a selected send until the send is aborted through
// its signal (as the genuine node aborts the stream), or until the test ends.

const SETTLE_MS = Number(process.env.TRACK_X_RED_SETTLE_MS ?? 16_000);
const BOUND_MS = Number(process.env.TRACK_X_RED_BOUND_MS ?? 45_000);
const DELIVERY_MS = Number(process.env.TRACK_X_RED_DELIVERY_MS ?? 30_000);
const HISTORY_REQUEST = "ts-drp-room-history-request-v1";

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
}, 120_000);

const sleep = (ms: number): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, ms));

type SendMessage = (target: string, message: Message, options?: Readonly<{ signal?: AbortSignal }>) => Promise<void>;

/**
 * Stalls the selected direct sends of one peer until their signal aborts them, or until release.
 * @param networkNode - The peer's network node.
 * @param select - Selects the sends to stall.
 * @returns The stalled sends so far, and release (settles every stalled send, then sends normally).
 */
interface Stall {
	readonly stalled: readonly Readonly<{ signalled: boolean }>[];
	release(): void;
}

function stallSends(networkNode: object, select: (target: string, message: Message) => boolean): Stall {
	const original = Reflect.get(networkNode, "sendMessage") as SendMessage;
	const stalled: Array<Readonly<{ signalled: boolean }>> = [];
	const releases = new Set<() => void>();
	let active = true;
	Reflect.set(networkNode, "sendMessage", ((target, message, options): Promise<void> => {
		if (!active || !select(target, message)) return Reflect.apply(original, networkNode, [target, message, options]);
		const signal = options?.signal;
		stalled.push(Object.freeze({ signalled: signal !== undefined }));
		return new Promise<void>((resolve, reject) => {
			const release = (): void => {
				releases.delete(release);
				resolve();
			};
			releases.add(release);
			signal?.addEventListener(
				"abort",
				() => {
					releases.delete(release);
					reject(signal.reason instanceof Error ? signal.reason : new Error("direct message send aborted"));
				},
				{ once: true }
			);
		});
	}) satisfies SendMessage);
	return {
		stalled: stalled as readonly Readonly<{ signalled: boolean }>[],
		release: (): void => {
			active = false;
			for (const release of [...releases]) release();
		},
	};
}

async function settled(work: Promise<unknown>, ms: number): Promise<"returned" | "rejected" | "pending"> {
	void work.catch(() => undefined);
	return Promise.race([
		work.then(
			() => "returned" as const,
			() => "rejected" as const
		),
		sleep(ms).then(() => "pending" as const),
	]);
}

// One rollover in the shipped order (seal, export, adopt; the successor fence reaches the
// recipient by gossip before its install and is dropped there), then the recipient's install.
async function rollover(
	fixture: FenceDeliveryRoom,
	creator: Opened,
	recipient: Opened,
	before: () => void
): Promise<void> {
	await sleep(300);
	expect(((await creator.room.sealEpoch()) as { ok?: boolean }).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	await fixture.network.idle();
	const transfer = await settlementDelivery(asSettlementRoom(fixture));
	Reflect.set(recipient.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
	before();
	await recipient.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
}

type Opened = Awaited<ReturnType<FenceDeliveryRoom["open"]>>;

async function converged(creator: Opened, recipient: Opened, label: string): Promise<void> {
	const deadline = performance.now() + DELIVERY_MS;
	while (JSON.stringify(recipient.room.projection()) !== JSON.stringify(creator.room.projection())) {
		if (performance.now() > deadline)
			throw new TypeError(`TRACK_X_RED ${label}: not admitted by the recipient within ${DELIVERY_MS} ms`);
		await sleep(25);
	}
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
	const deadline = performance.now() + DELIVERY_MS;
	while (!condition()) {
		if (performance.now() > deadline) throw new TypeError(`TRACK_X_RED ${label} within ${DELIVERY_MS} ms`);
		await sleep(25);
	}
}

it("a creator whose direct reply to a recipient's history request never completes still issues, seals and closes", async () => {
	const fixture = await fenceDeliveryRoom("observer");
	const creator = await fixture.open(0);
	const recipient = await fixture.open(1);
	const recipientPeer = required(fixture.roster[1]).peerId;
	// Let the retained-request schedules both sessions started at open run out.
	await sleep(SETTLE_MS);
	await creator.room.issue({ action: "placeBlock", id: "c-0", kind: "stone", x: 0, y: 0 });
	await converged(creator, recipient, "the creator's genesis move");
	let stall: Stall | undefined;
	try {
		await rollover(fixture, creator, recipient, () => {
			// Every direct send of the creator to the recipient stalls from here on.
			stall = stallSends(creator.networkNode, (target) => target === recipientPeer);
		});
		const stalled = required(stall);
		await waitFor(() => stalled.stalled.length > 0, "the creator answers the recipient's request after its install");
		expect(
			await settled(creator.room.issue({ action: "placeBlock", id: "c-1", kind: "stone", x: 1, y: 0 }), BOUND_MS),
			`TRACK_X_RED a stalled direct reply to the recipient holds the creator's plane: its move did not return within ${BOUND_MS} ms`
		).toBe("returned");
		await sleep(300);
		expect(
			await settled(creator.room.sealEpoch(), BOUND_MS),
			`TRACK_X_RED a stalled direct reply to the recipient holds the creator's plane: its seal did not return within ${BOUND_MS} ms`
		).toBe("returned");
		expect(
			stalled.stalled.every(({ signalled }) => signalled),
			"every direct reply send carries a deadline"
		).toBe(true);
	} finally {
		stall?.release();
	}
}, 300_000);

it("a recipient whose history request send never completes asks again for a dependency it is missing", async () => {
	const fixture = await fenceDeliveryRoom("observer");
	const creator = await fixture.open(0);
	const recipient = await fixture.open(1);
	const creatorPeer = required(fixture.roster[0]).peerId;
	await sleep(SETTLE_MS);
	await creator.room.issue({ action: "placeBlock", id: "c-0", kind: "stone", x: 0, y: 0 });
	await converged(creator, recipient, "the creator's genesis move");
	let stall: Stall | undefined;
	let first = true;
	try {
		await rollover(fixture, creator, recipient, () => {
			// The recipient's first history request after its install stalls; later ones are sent.
			stall = stallSends(recipient.networkNode, (target, message) => {
				const selected =
					first &&
					target === creatorPeer &&
					message.type === MessageType.MESSAGE_TYPE_CUSTOM &&
					new TextDecoder().decode(message.data) === HISTORY_REQUEST;
				if (selected) first = false;
				return selected;
			});
		});
		const stalled = required(stall);
		await waitFor(() => stalled.stalled.length > 0, "the recipient asks the creator after its install");
		// The creator's next move depends on the successor fence the recipient dropped before its
		// install. It reaches the recipient and is held there; the recipient must ask again.
		await creator.room.issue({ action: "placeBlock", id: "c-1", kind: "stone", x: 1, y: 0 });
		await converged(
			creator,
			recipient,
			"a stalled history request leaves the recipient deaf: the creator's successor move"
		);
		expect(
			stalled.stalled.every(({ signalled }) => signalled),
			"every history request send carries a deadline"
		).toBe(true);
	} finally {
		stall?.release();
	}
}, 300_000);
