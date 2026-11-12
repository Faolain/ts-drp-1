/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test helpers: inferred fixture shapes. */
import { hashDomain } from "@ts-drp/canonical";
import {
	DirectMessageSendError,
	DRP_HEADS_CHUNK_PROTOCOL,
	DRP_MESSAGE_PROTOCOL,
	DRP_MESSAGE_SESSION_BULK_PROTOCOL,
	DRP_MESSAGE_SESSION_RT_PROTOCOL,
	DRP_SYNC_PROTOCOLS,
	isDirectMessageProtocol,
} from "@ts-drp/network";
import { type DRPNetworkNode, Message, MessageType } from "@ts-drp/types";
import { describe, expect, it, vi } from "vitest";

import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";
import {
	createV3RoomSuccessorChannel,
	createV3RoomSuccessorDelivery,
} from "../examples/v3-room/src/successor-delivery.js";
import { NodeEphemeralAdapter } from "../packages/node/src/ephemeral.js";
import { NodeRoomNetworkAdapter } from "../packages/node/src/room-network.js";

// Track 46 (docs/realtime-latency/tracks/46-network-stream-reuse): direct messages now arrive on
// long-lived session streams (`/drp/message/1.0.0/session/rt` and `.../bulk`) as well as on the
// legacy one-frame-per-stream protocol. Every consumer that requires authenticated-stream ingress
// evidence must accept a frame from either session protocol exactly as it accepts the legacy id, and
// must still refuse a sync-family id that is not a direct-message protocol (heads-chunk).
//
// Completion semantics (decision 4): `sendMessage` resolves once the frame is accepted by the stream
// and rejects with a typed `DirectMessageSendError` otherwise; it never resolves for a frame that was
// not handed to the transport. Each caller below is pinned to map that resolution as before.

const DIRECT = [
	["session rt", DRP_MESSAGE_SESSION_RT_PROTOCOL],
	["session bulk", DRP_MESSAGE_SESSION_BULK_PROTOCOL],
	["legacy", DRP_MESSAGE_PROTOCOL],
] as const;

type Evidence = Readonly<{
	message: Readonly<{ data: Uint8Array; objectId: string; sender: string; type: MessageType }>;
	transport: Readonly<{ kind: "authenticated-stream"; protocol: string; sender: string }>;
}>;

/** A fake network that stamps one-use authenticated-stream evidence for the protocol chosen per copy. */
function directNetwork(peerId: string) {
	const evidence = new WeakMap<Message, Evidence>();
	const sent: { to: string; message: Message }[] = [];
	const network = fakeNetwork(peerId, false);
	let refuse: Error | undefined;
	Object.assign(network, {
		getAllPeers: () => ["peer-creator", "peer-member"].filter((id) => id !== peerId),
		claimIngressEvidence: (message: Message) => {
			const claimed = evidence.get(message);
			evidence.delete(message);
			return claimed;
		},
		sendMessage: (to: string, message: Message) => {
			if (refuse !== undefined) return Promise.reject(refuse);
			sent.push({ to, message });
			return Promise.resolve();
		},
	});
	return {
		network,
		sent,
		refuseWith(error: Error | undefined) {
			refuse = error;
		},
		/** A received copy of `message` from `sender`, carrying evidence for `protocol`. */
		arrive(message: Message, sender: string, protocol: string): Message {
			const received = Message.decode(Message.encode(message).finish());
			evidence.set(received, {
				message: { data: received.data.slice(), objectId: received.objectId, sender, type: received.type },
				transport: { kind: "authenticated-stream", protocol, sender },
			});
			return received;
		},
	};
}

function roomAdapter(network: DRPNetworkNode) {
	return new NodeRoomNetworkAdapter(network, new NodeEphemeralAdapter(network, null));
}

describe("isDirectMessageProtocol", () => {
	it("accepts the legacy id and both session ids, and no other sync-family id", () => {
		for (const [, protocol] of DIRECT) expect(isDirectMessageProtocol(protocol)).toBe(true);
		expect(isDirectMessageProtocol(DRP_HEADS_CHUNK_PROTOCOL)).toBe(false);
		// The legacy id doubles as the negotiated sync fallback; every other sync id is refused.
		expect(DRP_SYNC_PROTOCOLS.filter(isDirectMessageProtocol)).toEqual([DRP_MESSAGE_PROTOCOL]);
		expect(isDirectMessageProtocol("/drp/message/1.0.0/session")).toBe(false);
		expect(isDirectMessageProtocol("/meshsub/1.1.0")).toBe(false);
	});
});

describe("room network: direct v3 ingress (room-network.ts route)", () => {
	const ingress = (protocol: string) => {
		const wire = directNetwork("peer-member");
		const adapter = roomAdapter(wire.network);
		const port = adapter.open(
			"peer-creator:00112233445566778899aabbccddeeff",
			"peer-creator",
			() => Promise.resolve(),
			() => undefined
		);
		const received: Message[] = [];
		port.setIngressHandler(
			"ingress-46",
			() => undefined,
			(message) => received.push(message)
		);
		const envelope = Message.create({
			data: Uint8Array.of(1, 2, 3),
			objectId: "ingress-46",
			sender: "peer-creator",
			type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
		});
		expect(adapter.route(wire.arrive(envelope, "peer-creator", protocol))).toBe(true);
		void port.close();
		return received;
	};

	it.each(DIRECT)("admits a %s copy", (_name, protocol) => {
		const received = ingress(protocol);
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ objectId: "ingress-46", sender: "peer-creator" });
		expect([...(received[0]?.data ?? [])]).toEqual([1, 2, 3]);
	});

	it("refuses a heads-chunk copy", () => {
		expect(ingress(DRP_HEADS_CHUNK_PROTOCOL)).toEqual([]);
	});
});

describe("room network: creator selection request and response (room-network.ts #routeSelection)", () => {
	const objectId = "peer-creator:00112233445566778899aabbccddeeff";
	const selection = new TextEncoder().encode("exact canonical selection");
	const request = () => ({
		exactCanonicalSelectionBytes: selection,
		digest: hashDomain("ts-drp/settlement-source-selection/v1", selection),
	});
	const signature = new Uint8Array(64).fill(7);

	const pairOfRooms = () => {
		const creator = directNetwork("peer-creator");
		const member = directNetwork("peer-member");
		const creatorAdapter = roomAdapter(creator.network);
		const memberAdapter = roomAdapter(member.network);
		const creatorPort = creatorAdapter.open(
			objectId,
			"peer-creator",
			() => Promise.resolve(),
			() => undefined
		);
		const memberPort = memberAdapter.open(
			objectId,
			"peer-creator",
			() => Promise.resolve(),
			() => undefined
		);
		const authorizer = vi.fn(() => Promise.resolve(signature));
		creatorPort.setSettlementSourceAuthorizer(authorizer);
		return { creator, member, creatorAdapter, memberAdapter, creatorPort, memberPort, authorizer };
	};

	const until = async (condition: () => boolean) => {
		for (let attempt = 0; attempt < 200 && !condition(); attempt++) await new Promise((r) => setTimeout(r, 5));
	};

	it.each(DIRECT)("a %s request is authorized and its %s response resolves the requester", async (_name, protocol) => {
		const rooms = pairOfRooms();
		try {
			const approval = rooms.memberPort.requestSettlementSourceAuthorization(request());
			await until(() => rooms.member.sent.length === 1);
			const [outbound] = rooms.member.sent;
			if (outbound === undefined) throw new TypeError("no selection request was sent");
			expect(outbound.to).toBe("peer-creator");
			expect(rooms.creatorAdapter.route(rooms.creator.arrive(outbound.message, "peer-member", protocol))).toBe(true);
			await until(() => rooms.creator.sent.length === 1);
			expect(rooms.authorizer).toHaveBeenCalledOnce();
			expect(rooms.authorizer.mock.calls[0]?.[0]).toMatchObject({ authenticatedRequesterPeerId: "peer-member" });
			const [response] = rooms.creator.sent;
			if (response === undefined) throw new TypeError("no selection response was sent");
			expect(response.to).toBe("peer-member");
			expect(rooms.memberAdapter.route(rooms.member.arrive(response.message, "peer-creator", protocol))).toBe(true);
			expect([...(await approval)]).toEqual([...signature]);
		} finally {
			await Promise.allSettled([rooms.creatorPort.close(), rooms.memberPort.close()]);
		}
	});

	it("a heads-chunk request is not authorized and gets no response", async () => {
		const rooms = pairOfRooms();
		const controller = new AbortController();
		try {
			const approval = rooms.memberPort.requestSettlementSourceAuthorization(request(), { signal: controller.signal });
			void approval.catch(() => undefined);
			await until(() => rooms.member.sent.length === 1);
			const [outbound] = rooms.member.sent;
			if (outbound === undefined) throw new TypeError("no selection request was sent");
			expect(
				rooms.creatorAdapter.route(rooms.creator.arrive(outbound.message, "peer-member", DRP_HEADS_CHUNK_PROTOCOL))
			).toBe(true);
			await new Promise((r) => setTimeout(r, 50));
			expect(rooms.authorizer).not.toHaveBeenCalled();
			expect(rooms.creator.sent).toEqual([]);
			controller.abort(new Error("test done"));
			await expect(approval).rejects.toThrow("room creator approval unavailable");
		} finally {
			await Promise.allSettled([rooms.creatorPort.close(), rooms.memberPort.close()]);
		}
	});

	it("completion pin: a typed send failure rejects the requester at once with it as the cause", async () => {
		const rooms = pairOfRooms();
		const failure = new DirectMessageSendError("DIRECT_DIAL_FAILED", "Could not dial direct-message peer");
		rooms.member.refuseWith(failure);
		const started = performance.now();
		try {
			const approval = rooms.memberPort.requestSettlementSourceAuthorization(request());
			const error = await approval.then(
				() => undefined,
				(reason: unknown) => reason
			);
			expect(error).toBeInstanceOf(TypeError);
			expect((error as Error).message).toContain("room creator approval unavailable");
			expect((error as Error).cause).toBe(failure);
			// Not the 10 s request deadline: the typed failure itself settled it.
			expect(performance.now() - started).toBeLessThan(5_000);
		} finally {
			await Promise.allSettled([rooms.creatorPort.close(), rooms.memberPort.close()]);
		}
	});
});

describe("ephemeral: direct E1 ingress (ephemeral.ts route)", () => {
	const roster = new Map([["peer-writer", "author-writer"]]);
	const open = () => {
		let topic = "";
		const frames: Uint8Array[] = [];
		const wire = directNetwork("peer-local");
		Object.assign(wire.network, {
			getGroupPeers: () => ["peer-writer"],
			subscribe: (selected: string) => {
				topic = selected;
			},
			publishMessage: (_topic: string, message: Message) => {
				frames.push(message.data.slice());
				return Promise.resolve(true);
			},
		});
		const adapter = new NodeEphemeralAdapter(wire.network, null);
		const channel = adapter.openAuthorized(
			"zone",
			{
				authorForPeer: (peerId) => roster.get(peerId),
				currentAuthority: () => ({
					aclDigest: "22".repeat(32),
					anchorDigest: "11".repeat(32),
					epoch: 0,
					objectId: "zone",
				}),
				isCurrentWriter: (author) => author === "author-writer",
			},
			{ maxMessageBytes: 65_536, maxSequencedKeys: 1, maxSequencedSenders: 4_095 }
		);
		return { wire, adapter, channel, frames, topic: () => topic };
	};

	const deliver = async (protocol: string) => {
		const { wire, adapter, channel, frames, topic } = open();
		const delivered: string[] = [];
		channel.subscribe(({ payload }) => delivered.push(new TextDecoder().decode(payload)));
		await expect(
			channel.publish({ class: "reliable-unordered", key: null, payload: new TextEncoder().encode("move-46") })
		).resolves.toBe(true);
		const frame = frames[0] ?? wire.sent[0]?.message.data;
		if (frame === undefined) throw new TypeError("missing production E1 frame");
		const copy = Message.create({
			data: frame,
			objectId: topic(),
			sender: "peer-writer",
			type: MessageType.MESSAGE_TYPE_CUSTOM,
		});
		expect(adapter.route(wire.arrive(copy, "peer-writer", protocol))).toBe(true);
		channel.close();
		return delivered;
	};

	it.each(DIRECT)("delivers a %s copy", async (_name, protocol) => {
		expect(await deliver(protocol)).toEqual(["move-46"]);
	});

	it("refuses a heads-chunk copy", async () => {
		expect(await deliver(DRP_HEADS_CHUNK_PROTOCOL)).toEqual([]);
	});
});

describe("successor delivery: member request (successor-delivery.ts send)", () => {
	const member = (sendMessage: (peerId: string, message: Message) => Promise<void>) => {
		const sends: string[] = [];
		const errors: unknown[] = [];
		const node = {
			networkNode: {
				peerId: "peer-member",
				getAllPeers: () => ["peer-creator"],
				sendMessage: (peerId: string, message: Message) => {
					sends.push(peerId);
					return sendMessage(peerId, message);
				},
			},
			messageQueueManager: { subscribe: () => undefined, close: () => undefined },
		};
		const delivery = createV3RoomSuccessorDelivery({
			role: "member",
			objectId: "peer-creator:room-46",
			channel: createV3RoomSuccessorChannel(node, "peer-creator:room-46"),
			pollMs: 3_600_000,
			hooks: { onError: (error) => errors.push(error) },
		});
		delivery.bind({
			authority: () => ({ epoch: 0 }),
			connectedPeers: () => ["peer-creator"],
			installCreatorSuccessor: () => Promise.reject(new Error("not used")),
		} as unknown as Parameters<typeof delivery.bind>[0]);
		return { delivery, sends, errors };
	};

	it("completion pin: a send accepted by the stream is a sent request and no error", async () => {
		const { delivery, sends, errors } = member(() => Promise.resolve());
		await new Promise((r) => setTimeout(r, 10));
		expect(sends).toEqual(["peer-creator"]);
		expect(delivery.stats()).toMatchObject({ requested: 1, lastError: undefined });
		expect(errors).toEqual([]);
		delivery.close();
	});

	it("completion pin: a typed send failure is reported, never silent", async () => {
		const failure = new DirectMessageSendError("DIRECT_SESSION_RESET", "Direct-message session stream reset");
		const { delivery, sends, errors } = member(() => Promise.reject(failure));
		await new Promise((r) => setTimeout(r, 10));
		expect(sends).toEqual(["peer-creator"]);
		expect(errors).toEqual([failure]);
		expect(delivery.stats().lastError).toContain("Direct-message session stream reset");
		delivery.close();
	});
});
