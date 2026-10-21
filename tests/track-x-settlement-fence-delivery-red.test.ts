import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery } from "./fixtures/track-m/settlement-room.js";
import {
	asSettlementRoom,
	deliveredVertex,
	fenceDeliveryRoom,
	type RecipientRole,
} from "./fixtures/track-x/fence-delivery-room.js";

// Track X RED: on creator-trusted-settlement-v1, a recipient that receives the creator's
// settlement fence BEFORE it installs the successor must still admit the creator's later
// moves after the install, at every successor.
//
// The genuine order of the shipped pages (Canvas, Chat, and Grid under Track V's switch):
// the creator seals, exports and adopts; adoption issues the settlement author fence
// (`$drp.author-fence.v1`) in the successor epoch and publishes it by gossip at once; the
// recipient installs afterwards. The fence therefore reaches the recipient while it is still
// on the closed epoch, fails authentication there (`not-authenticated`: unknown anchor) and is
// dropped. Every later creator vertex of the new epoch depends on the fence.
//
// At base 58bcd767 nothing asks for the fence again: the install requests no retained
// history, and a creator move held for its missing fence (`graph-rejected`) requests
// nothing either. Only the retained-request schedule started when the session opened
// (room-network.ts RETAINED_REQUEST_DELAYS, the last attempt 15 s after open) can repair it.
// Once that schedule has run out, the recipient never admits another creator move: the
// moves arrive and are held, not delivered. The browser harness
// (tests/track-x-shipped-app-long-room.pw.ts) shows it at epoch 5 of the shipped pages.
//
// This test lets the open-time schedule run out first (SETTLE_MS), then rolls over several
// times with the shipped order and asserts that every creator move reaches the recipient.

const SETTLE_MS = Number(process.env.TRACK_X_RED_SETTLE_MS ?? 16_000);
const ROLLOVERS = Number(process.env.TRACK_X_RED_ROLLOVERS ?? 4);
const DELIVERY_MS = Number(process.env.TRACK_X_RED_DELIVERY_MS ?? 10_000);
const FENCE_ACTION = "$drp.author-fence.v1";

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

const sleep = (ms: number): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, ms));

for (const role of ["writer", "observer"] as const satisfies readonly RecipientRole[])
	it(`a ${role} recipient admits the creator's moves after each successor whose fence arrived before its install`, async () => {
		const fixture = await fenceDeliveryRoom(role);
		const creator = await fixture.open(0);
		const recipient = await fixture.open(1);
		const creatorPeer = required(fixture.roster[0]).peerId;
		const recipientPeer = required(fixture.roster[1]).peerId;
		// The recipient's epoch when each successor fence (by anchor) first reached it by gossip.
		// The genesis epoch has a fence too (republished by the open-time schedule); it is not counted.
		const genesisAnchor = fixture.invite.pinnedGenesisAnchorDigest;
		const fences = new Map<unknown, number>();
		fixture.network.observe(({ kind, from, to, message }) => {
			const vertex = deliveredVertex(message);
			const operation = vertex?.operation as Readonly<Record<string, unknown>> | undefined;
			if (
				kind === "gossip" &&
				from === creatorPeer &&
				to === recipientPeer &&
				operation?.action === FENCE_ACTION &&
				vertex?.anchor !== genesisAnchor &&
				!fences.has(vertex?.anchor)
			)
				fences.set(vertex?.anchor, recipient.room.authority()?.epoch ?? 0);
		});
		const converged = async (label: string): Promise<void> => {
			const deadline = Date.now() + DELIVERY_MS;
			for (;;) {
				const expected = JSON.stringify(creator.room.projection());
				if (JSON.stringify(recipient.room.projection()) === expected) return;
				if (Date.now() > deadline)
					throw new TypeError(`TRACK_X_RED ${label}: not admitted by the ${role} recipient within ${DELIVERY_MS} ms`);
				await sleep(25);
			}
		};
		// Let the retained-request schedules both sessions started at open run out.
		await sleep(SETTLE_MS);
		for (let epoch = 0; epoch < ROLLOVERS; epoch++) {
			for (let ordinal = 0; ordinal < 2; ordinal++) {
				await creator.room.issue({
					action: "placeBlock",
					id: `c-${epoch}-${ordinal}`,
					kind: "stone",
					x: epoch,
					y: ordinal,
				});
				await converged(`epoch ${epoch} creator move ${ordinal}`);
			}
			if (role === "writer") {
				await recipient.room.issue({ action: "placeBlock", id: `r-${epoch}`, kind: "stone", x: epoch, y: 7 });
				const deadline = Date.now() + DELIVERY_MS;
				while (JSON.stringify(creator.room.projection()) !== JSON.stringify(recipient.room.projection())) {
					if (Date.now() > deadline)
						throw new TypeError(`TRACK_X_RED epoch ${epoch} recipient move: not admitted by the creator`);
					await sleep(25);
				}
			}
			// Track M's settle before the seal (its recorded native read reservation race).
			await sleep(300);
			const sealed = await creator.room.sealEpoch();
			expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
			await creator.room.adoptCreatorSuccessor();
			await fixture.network.idle();
			// The shipped order: the fence reached the recipient before its install.
			expect([...fences.values()], "successor fences gossiped and the recipient's epoch then").toEqual(
				Array.from({ length: epoch + 1 }, (_, index) => index)
			);
			const transfer = await settlementDelivery(asSettlementRoom(fixture));
			Reflect.set(recipient.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
			await recipient.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
			expect(recipient.room.authority()).toMatchObject({ epoch: epoch + 1, objectId: fixture.objectId });
		}
		// One more move at the last successor.
		await creator.room.issue({ action: "placeBlock", id: "c-final", kind: "stone", x: 99, y: 0 });
		await converged(`epoch ${ROLLOVERS} creator move`);
		expect(fences.size).toBe(ROLLOVERS);
	}, 180_000);
