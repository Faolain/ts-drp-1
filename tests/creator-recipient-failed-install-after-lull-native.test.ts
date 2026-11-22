/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native fixture inference. */
import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort, SnapshotChunkProtocolStream } from "@ts-drp/network/snapshot-transfer";
import { afterEach, expect, it } from "vitest";

import {
	type ChatSharesPeer,
	chatSharesRoomFixture,
	closeChatSharesRooms,
} from "./fixtures/chat-membership-shares/room.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";

// A receive-only member runs its recovery-pool lull (the received turnover) at its current
// epoch N, as the shipped pages do at an idle lull. Its next successor install then fails inside
// the receive (the snapshot bytes it is served are damaged, as a reset stream or an exhausted
// transfer session leaves them under load). The member must still follow: a retry of the same
// successor, and every later one, installs.
//
// Observed under host load in app-rollover-delivery-native (the steady observer stuck at its
// epoch with "creator recipient current authority is unavailable" on every later install): the
// failed receive marks the room for recovery, the next install reopens the plane through
// authenticated recovery, and that durable reopen finds the lull's completed retirement at the
// current epoch, so the reopened plane is halted until the ORIGINAL received reconciliation runs
// again. Session startup discharges that halt; the install's recovery reopen did not, so every
// later install found the halted plane unavailable and the member never caught up.
//
// Genuine SQLite, Ed25519, room owners, floor and creator material server; only the snapshot
// chunk bytes of the one failing install are damaged on the wire.

afterEach(async () => {
	expect(await closeChatSharesRooms(), "native owners join").toEqual([]);
});

/**
 * The same port, whose chunk (non-material) frames have one byte flipped.
 * @param port - The fixture's honest delivery port.
 * @returns The damaging port.
 */
function damagedChunks(port: SnapshotChunkProtocolPort): SnapshotChunkProtocolPort {
	return {
		...port,
		localPeerId: port.localPeerId,
		connectedPeers: () => port.connectedPeers(),
		close: () => port.close(),
		serve: (handler) => port.serve(handler),
		open: async (peer) => {
			const stream = await port.open(peer);
			let material = false;
			const wrapped: SnapshotChunkProtocolStream = {
				peerId: stream.peerId,
				abort: (reason) => stream.abort(reason),
				close: () => stream.close(),
				write: (bytes, options) => {
					try {
						const request = decodeCanonical(bytes) as Record<string, unknown>;
						if (request.kind === "creator-successor-material-request") material = true;
					} catch {
						// Not a canonical control frame.
					}
					return stream.write(bytes, options);
				},
				read: async (maximum, options) => {
					const frame = await stream.read(maximum, options);
					if (material || frame.byteLength < 256) return frame;
					const damaged = Uint8Array.from(frame);
					damaged[damaged.length - 1] = (damaged[damaged.length - 1] ?? 0) ^ 0xff;
					return damaged;
				},
			};
			return wrapped;
		},
	};
}

// Control (passes before the fix too): with no lull, the same failed install is recovered by the
// next install, so the wedge is the lull's completed retirement meeting the recovery reopen.
it.each([
	["after its recovery-pool lull", true],
	["with no lull (control)", false],
] as const)(
	"a member whose install fails %s still follows every later successor",
	async (_label, lull) => {
		const f = await chatSharesRoomFixture({
			members: ["late"],
			format: "window",
			genesisStateBytes: createShippingChatWindowGenesisStateBytes,
		});
		const creator = await f.open(0);
		const member: ChatSharesPeer = await f.open(1, { receiveOnly: true });
		const advance = async () => {
			expect((await creator.room.sealEpoch()).ok).toBe(true);
			await creator.room.adoptCreatorSuccessor();
		};
		const epochOf = () => member.room.authority()?.epoch ?? 0;
		// Follow until the member's lull has real work: the received turnover runs at the lull.
		let lullEpoch: number | undefined;
		for (let step = 0; step < 10 && lullEpoch === undefined; step++) {
			await advance();
			await f.install(member);
			expect(epochOf()).toBe(creator.room.authority()?.epoch);
			if (!lull) {
				if (epochOf() >= 3) lullEpoch = epochOf();
			} else if ((await member.room.maintainRecoveryPool()).kind === "maintained") lullEpoch = epochOf();
		}
		expect(lullEpoch, "the member's lull ran the received turnover").toBeDefined();
		const at = epochOf();

		// The next successor's install fails inside the receive.
		await advance();
		const transfer = await f.successorDelivery(member.index);
		Reflect.set(member.networkNode, "createSnapshotChunkProtocolHost", () => damagedChunks(transfer.port));
		const failure = await member.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers }).then(
			() => undefined,
			(error: unknown) => error
		);
		expect(failure, "the damaged install is refused").toBeInstanceOf(Error);
		expect(epochOf(), "a refused install leaves the member where it was").toBe(at);

		// The same successor, served intact, installs; so does every later one.
		const retried = await f.install(member).then(
			() => "installed",
			(error: unknown) => `refused: ${error instanceof Error ? error.message : String(error)}`
		);
		expect(retried, "the retry of the same successor").toBe("installed");
		expect(epochOf()).toBe(at + 1);
		for (let step = 0; step < 3; step++) {
			await advance();
			await f.install(member);
			expect(epochOf()).toBe(creator.room.authority()?.epoch);
		}
		expect(member.stateBytes()).toEqual(creator.stateBytes());
	},
	300_000
);
