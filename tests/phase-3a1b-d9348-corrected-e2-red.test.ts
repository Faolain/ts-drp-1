import {
	createEphemeralChannel,
	decodeEphemeralFrame,
	encodeEphemeralFrame,
	type EphemeralChannel,
	type EphemeralChannelOptions,
	type EphemeralIngress,
} from "@ts-drp/ephemeral";
import { type DRPNetworkNode, Message, MessageType } from "@ts-drp/types";
import { describe, expect, it, vi } from "vitest";

import { type EphemeralAuthorizationProvider, NodeEphemeralAdapter } from "../packages/node/src/ephemeral.js";
import { NodeRoomNetworkAdapter } from "../packages/node/src/room-network.js";
import {
	ControlledRawBus,
	type ControlledRawOwner,
} from "../packages/node/tests/fixtures/controlled-unreliable-webrtc.js";

const DIRECT_PROTOCOL = "/drp/message/0.0.1";
const options: EphemeralChannelOptions = {
	maxMessageBytes: 65_536,
	maxSequencedKeys: 1,
	maxSequencedSenders: 8,
};

interface Authority {
	readonly aclDigest: string;
	readonly anchorDigest: string;
	readonly epoch: number;
	readonly objectId: string;
}

interface Snapshot {
	readonly data: Uint8Array;
	readonly objectId: string;
	readonly sender: string;
	readonly type: MessageType;
}

type Transport =
	| Readonly<{ kind: "authenticated-stream"; protocol: string; sender: string }>
	| Readonly<{ kind: "signed-gossip"; sender: string; topic: string }>;

type Evidence = Readonly<{ message: Snapshot; transport: Transport }>;

interface EvidenceNetwork extends DRPNetworkNode {
	claimIngressEvidence?(message: Message): Evidence | undefined;
	gossipTopicFor(message: Message): string | undefined;
}

interface V3Stats {
	readonly authorityMismatch: number;
	readonly malformed: number;
	readonly rateLimited: number;
	readonly stale: number;
	readonly writerBuckets: number;
}

interface ControlledV3 {
	readonly adapter: NodeEphemeralAdapter;
	readonly authority: { value: Authority };
	readonly channel: EphemeralChannel;
	readonly evidence: WeakMap<Message, Evidence>;
	readonly network: EvidenceNetwork;
	readonly published: Message[];
	readonly rawOwner: ControlledRawOwner;
	readonly roster: Map<string, string>;
	readonly writers: Set<string>;
	close(): void;
	disconnect(peerId: string): void;
	publish(
		payload: Uint8Array,
		sequencedKey?: string,
		deliveryClass?: "reliable-unordered" | "unreliable-sequenced" | "unreliable-unordered"
	): Promise<Uint8Array>;
	route(bytes: Uint8Array, sender: string, kind?: Transport["kind"]): void;
	routeReliable(bytes: Uint8Array, sender: string): void;
	stamp(message: Message, transport: Transport): void;
	topic(): string;
	unsubscribe(peerId: string): void;
}

const defaultAuthority = Object.freeze<Authority>({
	aclDigest: "22".repeat(32),
	anchorDigest: "11".repeat(32),
	epoch: 0,
	objectId: "zone",
});

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function exactSnapshot(message: Message): Snapshot {
	return Object.freeze({
		data: message.data.slice(),
		objectId: message.objectId,
		sender: message.sender,
		type: message.type,
	});
}

function stats(channel: EphemeralChannel): V3Stats {
	return channel.stats() as unknown as V3Stats;
}

function controlledV3(
	input: {
		authority?: Authority;
		objectId?: string;
		roster?: ReadonlyMap<string, string>;
		writers?: ReadonlySet<string>;
	} = {}
): ControlledV3 {
	const objectId = input.objectId ?? input.authority?.objectId ?? defaultAuthority.objectId;
	const authority = { value: input.authority ?? { ...defaultAuthority, objectId } };
	const roster = new Map(
		input.roster ?? [
			["peer-local", "author-local"],
			["peer-writer", "author-writer"],
			["peer-reader", "author-reader"],
		]
	);
	const writers = new Set(input.writers ?? ["author-local", "author-writer"]);
	const evidence = new WeakMap<Message, Evidence>();
	const published: Message[] = [];
	const rawBus = new ControlledRawBus();
	const rawOwner = rawBus.owner("peer-local");
	const peerChangeHandlers = new Set<(change: { peerId: string; subscribed: boolean; topic: string }) => void>();
	const peerDisconnectHandlers = new Set<(peerId: string) => void>();
	let subscribedTopic = "";
	const stamp = (message: Message, transport: Transport): void => {
		evidence.set(message, Object.freeze({ message: exactSnapshot(message), transport: Object.freeze(transport) }));
	};
	const network = {
		broadcastMessage: (): Promise<void> => Promise.resolve(),
		claimIngressEvidence(message: Message): Evidence | undefined {
			const claimed = evidence.get(message);
			evidence.delete(message);
			if (claimed === undefined) return undefined;
			const snapshot = claimed.message;
			return snapshot.sender === message.sender &&
				snapshot.type === message.type &&
				snapshot.objectId === message.objectId &&
				sameBytes(snapshot.data, message.data)
				? claimed
				: undefined;
		},
		getAllPeers: (): string[] => [...roster.keys()],
		getGroupPeers: (): string[] => [...roster.keys()],
		gossipTopicFor: (message: Message): string | undefined => {
			const transport = evidence.get(message)?.transport;
			return transport?.kind === "signed-gossip" ? transport.topic : undefined;
		},
		peerId: "peer-local",
		publishMessage(topic: string, message: Message): Promise<true> {
			published.push(message);
			stamp(message, { kind: "signed-gossip", sender: message.sender, topic });
			return Promise.resolve(true);
		},
		sendMessage: (): Promise<void> => Promise.resolve(),
		subscribe(topic: string): void {
			subscribedTopic = topic;
		},
		subscribeToGroupPeerChanges(
			handler: (change: { peerId: string; subscribed: boolean; topic: string }) => void
		): () => void {
			peerChangeHandlers.add(handler);
			return () => peerChangeHandlers.delete(handler);
		},
		subscribeToPeerDisconnects(handler: (peerId: string) => void): () => void {
			peerDisconnectHandlers.add(handler);
			return () => peerDisconnectHandlers.delete(handler);
		},
		subscribeToMessageQueue: (): void => undefined,
		unsubscribe: (): void => undefined,
	} as unknown as EvidenceNetwork;
	const provider = {
		authorForPeer: (peerId: string): string | undefined => roster.get(peerId),
		currentAuthority: (): Authority => authority.value,
		isCurrentWriter: (author: string): boolean => writers.has(author),
	} as EphemeralAuthorizationProvider & { currentAuthority(): Authority };
	const adapter = new NodeEphemeralAdapter(network, () => undefined, rawOwner);
	const channel = adapter.openAuthorized(objectId, provider, options);
	for (const peerId of roster.keys()) {
		const owner = peerId === "peer-local" ? rawOwner : rawBus.owner(peerId);
		owner.openUnreliableWebRtcRoute(subscribedTopic);
		rawBus.connect("peer-local", peerId);
	}
	return {
		adapter,
		authority,
		channel,
		close: () => channel.close(),
		disconnect(peerId: string): void {
			for (const handler of peerDisconnectHandlers) handler(peerId);
		},
		evidence,
		network,
		async publish(
			payload: Uint8Array,
			sequencedKey?: string,
			deliveryClass = sequencedKey === undefined ? "unreliable-unordered" : "unreliable-sequenced"
		): Promise<Uint8Array> {
			await expect(
				channel.publish({
					class: deliveryClass,
					key: sequencedKey ?? null,
					payload,
				})
			).resolves.toBe(true);
			const bytes = deliveryClass === "reliable-unordered" ? published.at(-1)?.data : rawBus.sends.at(-1)?.bytes;
			if (bytes === undefined) throw new TypeError(`missing ${deliveryClass} v3 frame`);
			return bytes.slice();
		},
		published,
		rawOwner,
		roster,
		route(bytes: Uint8Array, sender: string, _kind: Transport["kind"] = "signed-gossip"): void {
			rawBus.inject("peer-local", subscribedTopic, sender, bytes);
		},
		routeReliable(bytes: Uint8Array, sender: string): void {
			const message = Message.create({
				data: bytes.slice(),
				objectId: subscribedTopic,
				sender,
				type: MessageType.MESSAGE_TYPE_CUSTOM,
			});
			stamp(message, { kind: "signed-gossip", sender, topic: subscribedTopic });
			expect(adapter.route(message)).toBe(true);
		},
		stamp,
		topic: () => subscribedTopic,
		unsubscribe(peerId: string): void {
			for (const handler of peerChangeHandlers) handler({ peerId, subscribed: false, topic: subscribedTopic });
		},
		writers,
	};
}

async function publishedBytes(fixture: ControlledV3, payload: string, key?: string): Promise<Uint8Array> {
	return fixture.publish(new TextEncoder().encode(payload), key);
}

async function publishedReliableBytes(fixture: ControlledV3, payload: string): Promise<Uint8Array> {
	return fixture.publish(new TextEncoder().encode(payload), undefined, "reliable-unordered");
}

describe("D.93.48 corrected E2 RED", () => {
	it("emits authority-bound v2 traffic only through raw ingress with authenticated peer attribution", async () => {
		const fixture = controlledV3();
		try {
			const delivered: string[] = [];
			fixture.channel.subscribe(({ payload, sender }) =>
				delivered.push(`${sender}:${new TextDecoder().decode(payload)}`)
			);
			const exact = await fixture.publish(new TextEncoder().encode("raw"));
			expect(exact[0]).toBe(2);
			fixture.route(exact, "peer-writer");
			fixture.route(exact, "peer-reader");
			expect(delivered).toContain("peer-writer:raw");
			expect(delivered).not.toContain("peer-reader:raw");
			const reliableBypass = Message.create({
				data: exact.slice(),
				objectId: fixture.topic(),
				sender: "peer-writer",
				type: MessageType.MESSAGE_TYPE_CUSTOM,
			});
			fixture.stamp(reliableBypass, {
				kind: "signed-gossip",
				sender: "peer-writer",
				topic: fixture.topic(),
			});
			expect(fixture.adapter.route(reliableBypass)).toBe(true);
			expect(delivered.filter((entry) => entry === "peer-writer:raw")).toHaveLength(1);
			expect(fixture.published).toHaveLength(0);
		} finally {
			fixture.close();
		}
	});

	it("requires one-use authenticated-stream evidence for direct durable-room ingress", () => {
		const fixture = controlledV3();
		const room = new NodeRoomNetworkAdapter(fixture.network, fixture.adapter);
		const port = room.open(
			"zone",
			"peer-writer",
			() => Promise.resolve(),
			() => undefined
		);
		const retained = vi.fn();
		port.setIngressHandler("zone-ingress", vi.fn(), retained);
		const message = (): Message =>
			Message.create({
				data: Uint8Array.of(1, 2, 3),
				objectId: "zone-ingress",
				sender: "peer-writer",
				type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
			});
		try {
			const exact = message();
			fixture.stamp(exact, {
				kind: "authenticated-stream",
				protocol: DIRECT_PROTOCOL,
				sender: "peer-writer",
			});
			expect(room.route(exact)).toBe(true);
			expect(room.route(exact)).toBe(true);

			const copied = message();
			expect(room.route(copied)).toBe(true);
			const mutated = message();
			fixture.stamp(mutated, {
				kind: "authenticated-stream",
				protocol: DIRECT_PROTOCOL,
				sender: "peer-writer",
			});
			mutated.data[0] = 0xff;
			expect(room.route(mutated)).toBe(true);
			const wrongProtocol = message();
			fixture.stamp(wrongProtocol, {
				kind: "authenticated-stream",
				protocol: "/wrong/direct/protocol",
				sender: "peer-writer",
			});
			expect(room.route(wrongProtocol)).toBe(true);
			const signedGossip = message();
			fixture.stamp(signedGossip, {
				kind: "signed-gossip",
				sender: "peer-writer",
				topic: "zone-ingress",
			});
			expect(room.route(signedGossip)).toBe(false);
			expect(fixture.network.gossipTopicFor(signedGossip)).toBe("zone-ingress");
			expect(fixture.network.claimIngressEvidence?.(signedGossip)).toEqual({
				message: {
					data: Uint8Array.of(1, 2, 3),
					objectId: "zone-ingress",
					sender: "peer-writer",
					type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
				},
				transport: { kind: "signed-gossip", sender: "peer-writer", topic: "zone-ingress" },
			});
			expect(retained).toHaveBeenCalledTimes(1);
			expect(retained).toHaveBeenCalledWith(expect.objectContaining({ data: Uint8Array.of(1, 2, 3) }));
		} finally {
			port.close();
			room.closeAll();
			fixture.close();
		}
	});

	it("binds v2 frames to one object, epoch, anchor and ACL while preserving the public v1 codec", async () => {
		const target = controlledV3();
		const currentSource = controlledV3();
		const variants = [
			controlledV3({ authority: { ...defaultAuthority, epoch: 1 } }),
			controlledV3({ authority: { ...defaultAuthority, anchorDigest: "33".repeat(32) } }),
			controlledV3({ authority: { ...defaultAuthority, aclDigest: "44".repeat(32) } }),
		];
		try {
			expect(() => controlledV3({ authority: { ...defaultAuthority, anchorDigest: "not-lower-hex" } })).toThrow();
			const delivered: string[] = [];
			target.channel.subscribe(({ payload }) => delivered.push(new TextDecoder().decode(payload)));
			for (const [index, variant] of variants.entries()) {
				target.route(await publishedBytes(variant, `wrong-context-${index}`), "peer-writer");
			}
			const current = await publishedBytes(currentSource, "current-context");
			const malformed = [
				current.subarray(0, current.byteLength - 1),
				Uint8Array.of(...current, 0),
				Uint8Array.of(0xff, ...current.subarray(1)),
				encodeEphemeralFrame({
					class: "unreliable-unordered",
					key: null,
					payload: new TextEncoder().encode("legacy-into-v3"),
					sequence: 0,
				}),
			];
			for (const bytes of malformed) target.route(bytes, "peer-writer");
			expect(delivered).toEqual([]);

			let legacyIngress: ((ingress: EphemeralIngress) => void) | undefined;
			const legacy = createEphemeralChannel(
				{
					authorizedPeers: () => ["peer-writer"],
					isAuthorized: () => true,
					localPeerId: "legacy-local",
					maxEnvelopeBytes: (): number => 65_536,
					onMessage: (listener) => {
						legacyIngress = listener;
						return (): void => {
							legacyIngress = undefined;
						};
					},
					send: () => Promise.resolve(true),
				},
				options
			);
			const legacyDelivered: string[] = [];
			legacy.subscribe(({ payload }) => legacyDelivered.push(new TextDecoder().decode(payload)));
			expect(legacyIngress).toBeDefined();
			legacyIngress?.({
				bytes: encodeEphemeralFrame({
					class: "unreliable-unordered",
					key: null,
					payload: new TextEncoder().encode("legacy-control"),
					sequence: 0,
				}),
				sender: "peer-writer",
			});
			expect(legacyDelivered).toEqual(["legacy-control"]);
			legacyIngress?.({ bytes: current, sender: "peer-writer" });
			expect(legacyDelivered).toEqual(["legacy-control"]);
			expect(() => decodeEphemeralFrame(current)).toThrow();
			legacy.close();
		} finally {
			target.close();
			currentSource.close();
			for (const variant of variants) variant.close();
		}
	});

	it("resets replay and receive-budget state when the installed authority changes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const target = controlledV3();
		const oldSource = controlledV3();
		const nextAuthority = Object.freeze({
			...defaultAuthority,
			aclDigest: "55".repeat(32),
			anchorDigest: "66".repeat(32),
			epoch: 1,
		});
		const newSource = controlledV3({ authority: nextAuthority });
		try {
			const delivered: string[] = [];
			target.channel.subscribe(({ payload }) => delivered.push(new TextDecoder().decode(payload)));
			const filler = await publishedBytes(oldSource, "filler");
			for (let index = 0; index < 119; index += 1) target.route(filler, "peer-writer");
			const oldFrame = await publishedBytes(oldSource, "old", "movement");
			target.route(oldFrame, "peer-writer");
			target.authority.value = nextAuthority;
			const newFrame = await publishedBytes(newSource, "new", "movement");
			target.route(newFrame, "peer-writer");
			target.route(oldFrame, "peer-writer");
			expect(delivered).toHaveLength(121);
			expect(delivered.slice(-2)).toEqual(["old", "new"]);
			expect(stats(target.channel).writerBuckets).toBe(1);
		} finally {
			target.close();
			oldSource.close();
			newSource.close();
			vi.useRealTimers();
		}
	});

	it("bounds rejected senders and shares one 120-message bucket per authenticated author", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const source = controlledV3();
		const sharedAuthor = controlledV3({
			roster: new Map([
				["peer-a", "author-shared"],
				["peer-b", "author-shared"],
			]),
			writers: new Set(["author-shared"]),
		});
		const rejectedRoster = new Map<string, string>();
		for (let index = 0; index < 200; index += 1) rejectedRoster.set(`peer-${index}`, `reader-${index}`);
		const rejected = controlledV3({ roster: rejectedRoster, writers: new Set() });
		const rejectedBytes = controlledV3({ roster: new Map([["peer-reader", "reader"]]), writers: new Set() });
		try {
			const bytes = await publishedBytes(source, "budget");
			let delivered = 0;
			sharedAuthor.channel.subscribe(() => {
				delivered += 1;
			});
			for (let index = 0; index < 121; index += 1) {
				sharedAuthor.route(bytes, index % 2 === 0 ? "peer-a" : "peer-b");
			}
			expect(delivered).toBe(120);
			expect(stats(sharedAuthor.channel)).toMatchObject({ rateLimited: 1, writerBuckets: 1 });

			for (let index = 0; index < 200; index += 1) rejected.route(bytes, `peer-${index}`);
			expect(stats(rejected.channel)).toMatchObject({ authorityMismatch: 120, rateLimited: 80, writerBuckets: 0 });

			const large = await publishedReliableBytes(source, "x".repeat(60_000));
			const allowedByBytes = Math.floor(1_048_576 / large.byteLength);
			for (let index = 0; index <= allowedByBytes; index += 1) rejectedBytes.routeReliable(large, "peer-reader");
			expect(stats(rejectedBytes.channel)).toMatchObject({
				authorityMismatch: allowedByBytes,
				rateLimited: 1,
				writerBuckets: 0,
			});
		} finally {
			source.close();
			sharedAuthor.close();
			rejected.close();
			rejectedBytes.close();
			vi.useRealTimers();
		}
	});

	it("charges malformed, foreign-context and stale writer traffic before parsing or replay", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const source = controlledV3();
		const foreign = controlledV3({ authority: { ...defaultAuthority, anchorDigest: "77".repeat(32) } });
		const malformedTarget = controlledV3();
		const foreignTarget = controlledV3();
		const staleTarget = controlledV3();
		const malformedCharge = controlledV3();
		const foreignCharge = controlledV3();
		const staleCharge = controlledV3();
		try {
			const valid = await publishedBytes(source, "valid");
			const malformed = Uint8Array.of(0xff, ...valid.subarray(1));
			const foreignFrame = await publishedBytes(foreign, "foreign");
			const sequenced = await publishedBytes(source, "sequenced", "movement");
			for (let index = 0; index < 120; index += 1) malformedTarget.route(valid, "peer-writer");
			malformedTarget.route(malformed, "peer-writer");
			expect(stats(malformedTarget.channel)).toMatchObject({ malformed: 0, rateLimited: 1 });

			for (let index = 0; index < 120; index += 1) foreignTarget.route(valid, "peer-writer");
			foreignTarget.route(foreignFrame, "peer-writer");
			expect(stats(foreignTarget.channel)).toMatchObject({ authorityMismatch: 0, rateLimited: 1 });

			for (let index = 0; index < 119; index += 1) staleTarget.route(valid, "peer-writer");
			staleTarget.route(sequenced, "peer-writer");
			staleTarget.route(sequenced, "peer-writer");
			expect(stats(staleTarget.channel)).toMatchObject({ rateLimited: 1, stale: 0 });

			for (let index = 0; index < 119; index += 1) malformedCharge.route(valid, "peer-writer");
			malformedCharge.route(malformed, "peer-writer");
			malformedCharge.route(valid, "peer-writer");
			expect(stats(malformedCharge.channel)).toMatchObject({ malformed: 1, rateLimited: 1 });

			for (let index = 0; index < 119; index += 1) foreignCharge.route(valid, "peer-writer");
			foreignCharge.route(foreignFrame, "peer-writer");
			foreignCharge.route(valid, "peer-writer");
			expect(stats(foreignCharge.channel)).toMatchObject({ authorityMismatch: 1, rateLimited: 1 });

			for (let index = 0; index < 118; index += 1) staleCharge.route(valid, "peer-writer");
			staleCharge.route(sequenced, "peer-writer");
			staleCharge.route(sequenced, "peer-writer");
			staleCharge.route(valid, "peer-writer");
			expect(stats(staleCharge.channel)).toMatchObject({ rateLimited: 1, stale: 1 });
		} finally {
			source.close();
			foreign.close();
			malformedTarget.close();
			foreignTarget.close();
			staleTarget.close();
			malformedCharge.close();
			foreignCharge.close();
			staleCharge.close();
			vi.useRealTimers();
		}
	});

	it("enforces the byte budget, 128-writer ceiling, revocation, disconnect and idle cleanup", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(0);
			const largeSource = controlledV3();
			const byteBound = controlledV3();
			const large = await publishedReliableBytes(largeSource, "x".repeat(60_000));
			const allowedByBytes = Math.floor(1_048_576 / large.byteLength);
			let byteDeliveries = 0;
			byteBound.channel.subscribe(() => {
				byteDeliveries += 1;
			});
			for (let index = 0; index <= allowedByBytes; index += 1) byteBound.routeReliable(large, "peer-writer");
			expect(byteDeliveries).toBe(allowedByBytes);
			expect(stats(byteBound.channel).rateLimited).toBe(1);
			vi.advanceTimersByTime(1_000);
			byteBound.routeReliable(large, "peer-writer");
			expect(byteDeliveries).toBe(allowedByBytes + 1);
			expect(stats(byteBound.channel).rateLimited).toBe(1);

			const roster = new Map<string, string>();
			const writers = new Set<string>();
			for (let index = 0; index < 129; index += 1) {
				roster.set(`peer-${index}`, `author-${index}`);
				writers.add(`author-${index}`);
			}
			const capped = controlledV3({ roster, writers });
			let cappedDeliveries = 0;
			capped.channel.subscribe(() => {
				cappedDeliveries += 1;
			});
			const small = await publishedBytes(largeSource, "small");
			for (let index = 0; index < 129; index += 1) capped.route(small, `peer-${index}`);
			expect(cappedDeliveries).toBe(128);
			expect(stats(capped.channel)).toMatchObject({ rateLimited: 1, writerBuckets: 128 });

			const cleanup = controlledV3();
			const disconnectReset = controlledV3();
			const sharedDisconnect = controlledV3({
				roster: new Map([
					["peer-a", "author-shared"],
					["peer-b", "author-shared"],
				]),
				writers: new Set(["author-shared"]),
			});
			const refilled = controlledV3();
			cleanup.route(small, "peer-writer");
			expect(stats(cleanup.channel).writerBuckets).toBe(1);
			let refilledDeliveries = 0;
			refilled.channel.subscribe(() => {
				refilledDeliveries += 1;
			});
			for (let index = 0; index < 121; index += 1) refilled.route(small, "peer-writer");
			expect(refilledDeliveries).toBe(120);
			refilled.unsubscribe("peer-writer");
			refilled.route(small, "peer-writer", "authenticated-stream");
			expect(refilledDeliveries).toBe(120);
			expect(stats(refilled.channel).rateLimited).toBe(2);
			vi.advanceTimersByTime(1_000);
			refilled.route(small, "peer-writer");
			expect(refilledDeliveries).toBe(121);
			expect(stats(refilled.channel).rateLimited).toBe(2);

			let disconnectDeliveries = 0;
			disconnectReset.channel.subscribe(() => {
				disconnectDeliveries += 1;
			});
			for (let index = 0; index < 121; index += 1) disconnectReset.route(small, "peer-writer");
			expect(disconnectDeliveries).toBe(120);
			disconnectReset.disconnect("peer-writer");
			disconnectReset.route(small, "peer-writer", "authenticated-stream");
			expect(disconnectDeliveries).toBe(121);
			expect(stats(disconnectReset.channel).writerBuckets).toBe(1);
			let sharedDisconnectDeliveries = 0;
			sharedDisconnect.channel.subscribe(() => {
				sharedDisconnectDeliveries += 1;
			});
			for (let index = 0; index < 121; index += 1) {
				sharedDisconnect.route(small, index % 2 === 0 ? "peer-a" : "peer-b");
			}
			expect(sharedDisconnectDeliveries).toBe(120);
			sharedDisconnect.disconnect("peer-a");
			sharedDisconnect.route(small, "peer-b", "authenticated-stream");
			expect(sharedDisconnectDeliveries).toBe(120);
			expect(stats(sharedDisconnect.channel)).toMatchObject({ rateLimited: 2, writerBuckets: 1 });
			cleanup.writers.delete("author-writer");
			cleanup.route(small, "peer-writer");
			expect(stats(cleanup.channel).writerBuckets).toBe(0);
			cleanup.writers.add("author-writer");
			cleanup.route(small, "peer-writer");
			expect(stats(cleanup.channel).writerBuckets).toBe(1);
			cleanup.disconnect("peer-writer");
			expect(stats(cleanup.channel).writerBuckets).toBe(0);

			cleanup.route(small, "peer-local");
			vi.advanceTimersByTime(60_001);
			cleanup.roster.set("peer-next", "author-next");
			cleanup.writers.add("author-next");
			cleanup.route(small, "peer-next");
			expect(stats(cleanup.channel).writerBuckets).toBe(1);

			largeSource.close();
			byteBound.close();
			capped.close();
			cleanup.close();
			disconnectReset.close();
			sharedDisconnect.close();
			refilled.close();
		} finally {
			vi.useRealTimers();
		}
	});
});
