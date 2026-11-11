/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native composition probe; capability inference. */
// The authority-bound ephemeral stream across genuine epoch rollovers on native SQLite and the
// production room transport: creator seals and adopts epoch e+1 while the Writer is still on e, then
// the Writer installs the creator's successor. Movement frames are exchanged at fixed points (not on
// a timer), so every count is deterministic: between the creator's adoption and the Writer's install,
// frames in both directions must still be delivered (no authority-mismatch blackout), and the
// ephemeral exchanges themselves never produce a durable vertex.
import type { EphemeralChannel } from "@ts-drp/ephemeral";
import { expect, it } from "vitest";

import { nativePlayNetwork } from "./fixtures/active-endurance/native-network.js";
import { creatorDeliveryRoom, eventually } from "./fixtures/track-aa/creator-delivery-room.js";
import { closeFixtures, ports, required } from "./fixtures/track-m/room-retention-fixture.js";
import { settlementDelivery } from "./fixtures/track-m/settlement-room.js";

const ROLLOVERS = 3;
const channelOptions = { maxMessageBytes: 512, maxSequencedKeys: 1, maxSequencedSenders: 2 };

it(
	"keeps creator and Writer movement flowing through adoption-to-install on every rollover",
	async () => {
		let network: Awaited<ReturnType<typeof nativePlayNetwork>> | undefined;
		try {
			network = await nativePlayNetwork();
			const fixture = await creatorDeliveryRoom({ profile: "settlement", network, peerIds: network.peerIds });
			const peers = [await fixture.open(0), await fixture.open(1)] as const;
			const [creator, writer] = peers;
			await writer.room.issue({ action: "placeBlock", id: "warm", kind: "stone", x: 1, y: 1 });
			expect(await eventually(() => creator.room.projection().blocks.length === 1, 10_000)).toBe(true);

			// The room may hand out a replacement channel after a transition; count across every channel.
			const channels = new Map<number, EphemeralChannel>();
			const retired = { mismatch: 0, unauthorized: 0 };
			const received = [0, 0];
			const channelFor = (index: number) => {
				const channel = required(peers[index]).room.openEphemeral(channelOptions);
				const previous = channels.get(index);
				if (previous !== channel) {
					if (previous !== undefined) {
						retired.mismatch += previous.stats().authorityMismatch;
						retired.unauthorized += previous.stats().unauthorized;
					}
					channels.set(index, channel);
					channel.subscribe(() => {
						received[index] = (received[index] ?? 0) + 1;
					});
				}
				return channel;
			};
			const mismatches = () =>
				retired.mismatch + [...channels.values()].reduce((total, channel) => total + channel.stats().authorityMismatch, 0);
			const acceptedVertices = () => [...fixture.accepted.values()].reduce((total, seen) => total + seen.size, 0);

			let exchanges = 0;
			const durableDuringExchanges: number[] = [];
			const gaps: string[] = [];
			const exchange = async (label: string) => {
				const vertices = acceptedVertices();
				const before = [...received];
				const epochs = peers.map(({ room }) => room.authority()?.epoch ?? null);
				for (const index of [0, 1]) {
					const payload = new TextEncoder().encode(`${label}:${index}`);
					await channelFor(index).publish({ class: "unreliable-sequenced", key: "movement", payload });
				}
				exchanges++;
				const arrived = await eventually(
					() => received[0] === (before[0] ?? 0) + 1 && received[1] === (before[1] ?? 0) + 1,
					3_000
				);
				if (!arrived) gaps.push(`${label} epochs=${JSON.stringify(epochs)} received=${JSON.stringify(received)}`);
				durableDuringExchanges.push(acceptedVertices() - vertices);
			};

			await exchange("start");
			for (let rollover = 1; rollover <= ROLLOVERS; rollover++) {
				await writer.room.issue({ action: "placeBlock", id: `move-${rollover}`, kind: "stone", x: 1 + rollover, y: 1 });
				expect(await eventually(() => creator.room.projection().blocks.length === 1 + rollover, 10_000)).toBe(true);
				expect((await creator.room.sealEpoch()).ok).toBe(true);
				await creator.room.adoptCreatorSuccessor();
				expect(creator.room.authority()?.epoch).toBe(rollover);
				expect(writer.room.authority()?.epoch ?? 0).toBe(rollover - 1);
				// Creator on the successor, Writer still on the epoch the creator just left.
				await exchange(`adopted-${rollover}`);
				const transfer = await settlementDelivery(fixture);
				Reflect.set(writer.networkNode, "createSnapshotChunkProtocolHost", () => transfer.port);
				try {
					await writer.room.installCreatorSuccessor({ offer: transfer.offer, peers: transfer.peers });
				} finally {
					await Promise.allSettled(
						[...ports].map(async (port) => {
							await port.close();
							ports.delete(port);
						})
					);
				}
				expect(writer.room.authority()?.epoch).toBe(rollover);
				await exchange(`installed-${rollover}`);
			}

			expect({ gaps, mismatches: mismatches(), received }).toEqual({
				gaps: [],
				mismatches: 0,
				received: [exchanges, exchanges],
			});
			// Zero durable vertices from ephemeral traffic.
			expect(durableDuringExchanges.every((count) => count === 0)).toBe(true);
		} finally {
			await closeFixtures();
			await network?.close();
		}
	},
	180_000
);
