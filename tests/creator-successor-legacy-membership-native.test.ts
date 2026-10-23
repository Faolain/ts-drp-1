import { afterEach, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";
import { settlementDelivery, type SettlementRoom } from "./fixtures/track-m/settlement-room.js";
import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";

afterEach(async () => {
	expect(await closeFixtures()).toEqual([]);
});

it("a sparse recipient installed from v1 material can retry and reopen persisted state", async () => {
	const f = await readinessHoldRoom();
	const creator = await f.open(0),
		writer = await f.open(1);
	await creator.room.issue({ action: "placeBlock", id: "base", kind: "stone", x: 1, y: 1 });
	await writer.receive(await f.publishedAfter(0, null), 0);
	await writer.room.issue({ action: "placeBlock", id: "writer", kind: "stone", x: 1, y: 2 });
	await creator.receive(await f.publishedAfter(1, null), 1);
	await creator.room.issue({ action: "placeBlock", id: "missed", kind: "stone", x: 1, y: 3 });
	await new Promise((resolve) => setTimeout(resolve, 300));
	expect(await creator.room.sealEpoch()).toMatchObject({ ok: true });
	await creator.room.adoptCreatorSuccessor();
	const delivery = await settlementDelivery(f as unknown as SettlementRoom);
	// Genuine old wire shape: strip the new field and sign the complete v1 frame.
	const legacy = {
		...delivery.port,
		open: async (...args: Parameters<typeof delivery.port.open>) => {
			const stream = await delivery.port.open(...args);
			return {
				...stream,
				read: async (...readArgs: Parameters<typeof stream.read>) => {
					const bytes = await stream.read(...readArgs);
					let record: Record<string, unknown>;
					try {
						record = decodeCanonical(bytes) as Record<string, unknown>;
					} catch {
						return bytes;
					}
					if (record?.kind !== "creator-successor-material-response") return bytes;
					const proof = { ...record, version: 1 };
					delete proof.signature;
					delete proof.exactCanonicalCloseMembershipBytes;
					return encodeCanonical({
						...proof,
						signature: ed25519.sign(
							hashDomain("ts-drp/creator-successor-transport/v1", encodeCanonical(proof)),
							required(f.identities[0]).seed
						),
					});
				},
			};
		},
	};
	Object.assign(writer.networkNode, { createSnapshotChunkProtocolHost: () => legacy });
	await writer.room.installCreatorSuccessor({ offer: delivery.offer, peers: delivery.peers });
	expect(writer.room.authority()?.epoch).toBe(1);
	await writer.room.installCreatorSuccessor({ offer: delivery.offer, peers: delivery.peers });
	const projection = writer.room.projection();
	await f.stop(writer);
	const reopened = await f.open(1, {
		reopen: true,
		onNetwork: (node) => Object.assign(node, { createSnapshotChunkProtocolHost: () => legacy }),
	});
	expect(reopened.room.authority()?.epoch).toBe(1);
	expect(reopened.room.projection()).toEqual(projection);
}, 120000);
