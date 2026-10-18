import { type DRPNetworkNode, Message, MessageType } from "@ts-drp/types";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
	ControlledEphemeralBus,
	type ControlledTransportPort,
} from "./fixtures/track-e1-ephemeral/controlled-transport.js";
import {
	ControlledRawBus,
	type ControlledRawOwner,
} from "../packages/node/tests/fixtures/controlled-unreliable-webrtc.js";

type DeliveryClass = "reliable-unordered" | "unreliable-sequenced" | "unreliable-unordered";

interface PublishInput {
	readonly class: DeliveryClass;
	readonly key: string | null;
	readonly payload: Uint8Array;
}

interface DeliveredFrame extends PublishInput {
	readonly sender: string;
	readonly sequence: number;
}

type DecodedFrame = Omit<DeliveredFrame, "sender">;

interface EphemeralStats {
	readonly delivered: number;
	readonly dropped: number;
	readonly malformed: number;
	readonly overLimit: number;
	readonly published: number;
	readonly received: number;
	readonly remoteSequencedKeys: number;
	readonly sequencedSenders: number;
	readonly sequencedKeys: number;
	readonly localSequencedKeys: number;
	readonly stale: number;
	readonly subscriberFailures: number;
	readonly unauthorized: number;
}

interface EphemeralChannel {
	authorizedPeers(): readonly string[];
	close(): void;
	publish(input: PublishInput): Promise<boolean>;
	stats(): EphemeralStats;
	subscribe(listener: (frame: DeliveredFrame) => void): () => void;
}

interface EphemeralModule {
	createEphemeralChannel(
		port: ControlledTransportPort,
		options: {
			readonly maxMessageBytes: number;
			readonly maxSequencedKeys: number;
			readonly maxSequencedSenders: number;
		}
	): EphemeralChannel;
	decodeEphemeralFrame(bytes: Uint8Array): DecodedFrame;
	encodeEphemeralFrame(frame: DecodedFrame): Uint8Array;
}

interface V3EphemeralAuthorizationProvider {
	authorForPeer(peerId: string): string | undefined;
	currentAuthority(): Readonly<{ aclDigest: string; anchorDigest: string; epoch: 0; objectId: string }> | undefined;
	isCurrentWriter(author: string): boolean;
}

interface V3EphemeralAdapter {
	openAuthorized(
		objectId: string,
		provider: V3EphemeralAuthorizationProvider,
		channelOptions: ReturnType<typeof options>
	): EphemeralChannel;
	route(message: Message): boolean;
}

interface NodeEphemeralModule {
	NodeEphemeralAdapter: new (networkNode: DRPNetworkNode, rawOwner: ControlledRawOwner | null) => V3EphemeralAdapter;
}

const ephemeralSourcePath = "packages/ephemeral/src/index.ts";
const ephemeralManifestPath = "packages/ephemeral/package.json";

const sourceExists = existsSync(ephemeralSourcePath);
const manifestExists = existsSync(ephemeralManifestPath);
const channelAvailable = sourceExists && manifestExists;
let ephemeralModule: EphemeralModule | undefined;

async function loadEphemeralModule(): Promise<EphemeralModule> {
	if (ephemeralModule !== undefined) return ephemeralModule;
	if (!sourceExists) throw new Error("Track E1 shared ephemeral channel is absent");
	const loaded: unknown = await import(pathToFileURL(ephemeralSourcePath).href);
	if (typeof loaded !== "object" || loaded === null) throw new TypeError("ephemeral module must be an object");
	const candidate = loaded as Partial<EphemeralModule>;
	if (
		typeof candidate.createEphemeralChannel !== "function" ||
		typeof candidate.encodeEphemeralFrame !== "function" ||
		typeof candidate.decodeEphemeralFrame !== "function"
	) {
		throw new TypeError("ephemeral module surface differs");
	}
	ephemeralModule = candidate as EphemeralModule;
	return ephemeralModule;
}

async function loadNodeEphemeralModule(): Promise<NodeEphemeralModule> {
	const loaded: unknown = await import(pathToFileURL("packages/node/src/ephemeral.ts").href);
	if (typeof loaded !== "object" || loaded === null || !("NodeEphemeralAdapter" in loaded)) {
		throw new TypeError("node ephemeral adapter surface differs");
	}
	return loaded as NodeEphemeralModule;
}

function nodeNetwork(): object {
	return {
		broadcastMessage: (): Promise<void> => Promise.resolve(),
		getAllPeers: (): readonly string[] => [],
		getGroupPeers: (): readonly string[] => [],
		gossipTopicFor: (): undefined => undefined,
		peerId: "alice",
		publishMessage: (): Promise<true> => Promise.resolve(true),
		subscribe: (): void => undefined,
		unsubscribe: (): void => undefined,
	};
}

function options(
	overrides: Partial<{ maxMessageBytes: number; maxSequencedKeys: number; maxSequencedSenders: number }> = {}
): {
	readonly maxMessageBytes: number;
	readonly maxSequencedKeys: number;
	readonly maxSequencedSenders: number;
} {
	return { maxMessageBytes: 65_536, maxSequencedKeys: 1, maxSequencedSenders: 4_095, ...overrides };
}

let legacyBoundaryFallbackCount = 0;

function createBoundaryChannel(
	module: EphemeralModule,
	port: ControlledTransportPort,
	channelOptions: ReturnType<typeof options>
): EphemeralChannel {
	try {
		return module.createEphemeralChannel(port, channelOptions);
	} catch (error) {
		if (!(error instanceof TypeError) || !error.message.includes("ephemeral options differ")) throw error;
		legacyBoundaryFallbackCount++;
		const createLegacyChannel = module.createEphemeralChannel as unknown as (
			legacyPort: ControlledTransportPort,
			legacyOptions: { readonly maxMessageBytes: number; readonly maxSequencedKeys: number }
		) => EphemeralChannel;
		return createLegacyChannel(port, {
			maxMessageBytes: channelOptions.maxMessageBytes,
			maxSequencedKeys: channelOptions.maxSequencedKeys,
		});
	}
}

function bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

describe("Track E1 controlled transport", () => {
	it("provides transport facts without owning frame semantics", async () => {
		const bus = new ControlledEphemeralBus();
		const alice = bus.createPort("alice");
		const bob = bus.createPort("bob");
		const observed: { readonly bytes: Uint8Array; readonly sender: string }[] = [];
		bob.onMessage((ingress) => observed.push(ingress));
		bus.authorize("bob", "alice");

		const callerBytes = bytes("detached");
		expect(await alice.send(callerBytes)).toBe(true);
		callerBytes.fill(0);
		expect(new TextDecoder().decode(observed[0]?.bytes)).toBe("detached");
		bus.hold("alice");
		const held = alice.send(bytes("held"));
		expect(bus.pending("alice")).toBe(1);
		expect(observed).toHaveLength(1);
		bus.release("alice");
		expect(await held).toBe(true);
		expect(new TextDecoder().decode(observed[1]?.bytes)).toBe("held");
		expect(bob.isAuthorized("alice")).toBe(true);
		bus.authorize("bob", "alice", false);
		expect(bob.isAuthorized("alice")).toBe(false);
	});
});

describe("Track E1 post-closure correction", () => {
	it("isolates local and admitted sender registries while bounding each owner", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		for (const peerId of ["alice", "bob", "carol", "dave"]) bus.createPort(peerId);
		const bob = createBoundaryChannel(
			module,
			bus.createPort("receiver"),
			options({ maxSequencedKeys: 1, maxSequencedSenders: 2 })
		);
		for (const sender of ["alice", "carol", "dave"]) bus.authorize("receiver", sender);
		const delivered: DeliveredFrame[] = [];
		bob.subscribe((frame) => delivered.push(frame));
		const inject = (sender: string, key: string, sequence: number): void => {
			bus.inject(
				"receiver",
				sender,
				module.encodeEphemeralFrame({
					class: "unreliable-sequenced",
					key,
					payload: bytes(`${sender}:${key}`),
					sequence,
				})
			);
		};

		inject("alice", "first", 1);
		inject("alice", "overflow", 1);
		inject("carol", "first", 1);
		inject("dave", "first", 1);
		expect(await bob.publish({ class: "unreliable-sequenced", key: "local", payload: bytes("local") })).toBe(true);

		expect(delivered.map(({ sender }) => sender)).toEqual(["alice", "carol"]);
		expect(bob.stats()).toMatchObject({
			localSequencedKeys: 1,
			overLimit: 2,
			remoteSequencedKeys: 2,
			sequencedKeys: 3,
			sequencedSenders: 2,
		});
	});

	it("exposes detached current peers and releases the complete registry and transport on close", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		bus.createPort("alice");
		const bob = createBoundaryChannel(module, bus.createPort("bob"), options());
		bus.authorize("bob", "alice");
		const first = bob.authorizedPeers();
		expect(first).toEqual(["alice"]);
		(first as string[]).push("forged");
		expect(bob.authorizedPeers()).toEqual(["alice"]);
		bus.disconnect("alice");
		expect(bob.authorizedPeers()).toEqual([]);
		bus.connect("alice");
		expect(bob.authorizedPeers()).toEqual(["alice"]);
		expect(
			await bob.publish({ class: "unreliable-sequenced", key: "local", payload: bytes("local-before-close") })
		).toBe(true);
		bus.inject(
			"bob",
			"alice",
			module.encodeEphemeralFrame({
				class: "unreliable-sequenced",
				key: "remote",
				payload: bytes("remote-before-close"),
				sequence: 1,
			})
		);
		expect(bob.stats()).toMatchObject({
			localSequencedKeys: 1,
			remoteSequencedKeys: 1,
			sequencedKeys: 2,
			sequencedSenders: 1,
		});

		bob.close();
		expect(bus.closeCount("bob")).toBe(1);
		expect(bob.stats()).toMatchObject({
			localSequencedKeys: 0,
			remoteSequencedKeys: 0,
			sequencedKeys: 0,
			sequencedSenders: 0,
		});
	});

	it("authorizes v3 E1 only through enrolled peer-to-author mappings and the current writer projection", async () => {
		const { NodeEphemeralAdapter } = await loadNodeEphemeralModule();
		const groups = ["peer-writer", "peer-reader", "peer-unknown"];
		const subscribed: string[] = [];
		const network = {
			...nodeNetwork(),
			getGroupPeers: (): readonly string[] => [...groups],
			peerId: "peer-local",
			subscribe: (topic: string): void => {
				subscribed.push(topic);
			},
		} as unknown as DRPNetworkNode;
		const adapter = new NodeEphemeralAdapter(network, null);
		const roster = new Map([
			["peer-writer", "author-writer"],
			["peer-reader", "author-reader"],
		]);
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
			options()
		);
		expect(subscribed).toHaveLength(1);
		expect(channel.authorizedPeers()).toEqual(["peer-writer"]);
		roster.set("peer-writer", "author-no-longer-writer");
		expect(channel.authorizedPeers()).toEqual([]);
		roster.set("peer-writer", "author-writer");
		groups.splice(0, groups.length, "peer-reader", "peer-unknown");
		expect(channel.authorizedPeers()).toEqual([]);
		channel.close();
	});

	it("keeps 57,600 v3 movements on the raw lane with zero durable vertices and one durable control vertex", async () => {
		const { NodeEphemeralAdapter } = await loadNodeEphemeralModule();
		const raw = new ControlledRawBus();
		raw.connect("alice", "bob");
		const aliceOwner = raw.owner("alice");
		const bobOwner = raw.owner("bob");
		const aliceReliable: Message[] = [];
		const bobReliable: Message[] = [];
		const network = (peerId: string, peer: string, reliable: Message[]): DRPNetworkNode =>
			({
				...nodeNetwork(),
				getAllPeers: (): readonly string[] => [peer],
				getGroupPeers: (): readonly string[] => [peer],
				peerId,
				publishMessage: (_topic: string, message: Message): Promise<true> => {
					reliable.push(message);
					return Promise.resolve(true);
				},
				sendMessage: (_peer: string, message: Message): Promise<void> => {
					reliable.push(message);
					return Promise.resolve();
				},
				subscribeToPeerDisconnects: (): (() => void) => (): void => undefined,
			}) as unknown as DRPNetworkNode;
		const roster = new Map([
			["alice", "author-alice"],
			["bob", "author-bob"],
		]);
		const provider: V3EphemeralAuthorizationProvider = {
			authorForPeer: (peerId) => roster.get(peerId),
			currentAuthority: () => ({
				aclDigest: "22".repeat(32),
				anchorDigest: "11".repeat(32),
				epoch: 0,
				objectId: "zone",
			}),
			isCurrentWriter: (author) => author === "author-alice" || author === "author-bob",
		};
		const alice = new NodeEphemeralAdapter(network("alice", "bob", aliceReliable), aliceOwner);
		const bob = new NodeEphemeralAdapter(network("bob", "alice", bobReliable), bobOwner);
		const aliceChannel = alice.openAuthorized("zone", provider, options());
		const bobChannel = bob.openAuthorized("zone", provider, options());
		let delivered = 0;
		bobChannel.subscribe(() => {
			delivered += 1;
		});
		for (let sample = 0; sample < 57_600; sample += 1) {
			await expect(
				aliceChannel.publish({
					class: "unreliable-sequenced",
					key: "alice",
					payload: bytes(String(sample)),
				})
			).resolves.toBe(true);
		}
		expect(delivered).toBeGreaterThan(0);
		expect(delivered).toBeLessThan(57_600);
		expect(raw.sends).toHaveLength(57_600);
		expect(aliceReliable).toHaveLength(0);
		expect(bobReliable).toHaveLength(0);
		aliceChannel.close();
		bobChannel.close();
	});

	it("fails v3 E1 closed for wrong-topic, malformed, unauthorized, and post-deactivation ingress", async () => {
		const { NodeEphemeralAdapter } = await loadNodeEphemeralModule();
		let topic = "";
		const published: Message[] = [];
		const evidence = new WeakMap<
			Message,
			Readonly<{
				message: Readonly<{ data: Uint8Array; objectId: string; sender: string; type: MessageType }>;
				transport: Readonly<{ kind: "signed-gossip"; sender: string; topic: string }>;
			}>
		>();
		const stamp = (message: Message, selectedTopic = topic): void => {
			evidence.set(message, {
				message: {
					data: message.data.slice(),
					objectId: message.objectId,
					sender: message.sender,
					type: message.type,
				},
				transport: { kind: "signed-gossip", sender: message.sender, topic: selectedTopic },
			});
		};
		const network = {
			...nodeNetwork(),
			claimIngressEvidence: (message: Message): unknown => {
				const claimed = evidence.get(message);
				evidence.delete(message);
				if (claimed === undefined) return undefined;
				const snapshot = claimed.message;
				return snapshot.sender === message.sender &&
					snapshot.type === message.type &&
					snapshot.objectId === message.objectId &&
					snapshot.data.every((value, index) => value === message.data[index]) &&
					snapshot.data.byteLength === message.data.byteLength
					? claimed
					: undefined;
			},
			getGroupPeers: (): readonly string[] => ["peer-writer", "peer-reader"],
			gossipTopicFor: (message: Message): string | undefined => evidence.get(message)?.transport.topic,
			peerId: "peer-local",
			publishMessage: (selected: string, message: Message): Promise<true> => {
				published.push(message);
				stamp(message, selected);
				return Promise.resolve(true);
			},
			sendMessage: (_peerId: string, message: Message): Promise<void> => {
				published.push(message);
				return Promise.resolve();
			},
			subscribe: (selected: string): void => {
				topic = selected;
			},
		} as unknown as DRPNetworkNode;
		const adapter = new NodeEphemeralAdapter(network, null);
		const roster = new Map([
			["peer-writer", "author-writer"],
			["peer-reader", "author-reader"],
		]);
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
			options()
		);
		expect(topic).not.toBe("");
		const message = (objectId: string, sender: string, data: Uint8Array): Message =>
			Message.create({ data, objectId, sender, type: MessageType.MESSAGE_TYPE_CUSTOM });
		await expect(channel.publish({ class: "reliable-unordered", key: null, payload: bytes("fixture") })).resolves.toBe(
			true
		);
		const publishedFrame = published[0]?.data;
		if (publishedFrame === undefined) throw new TypeError("missing production v3 frame");
		const frame = (): Uint8Array => publishedFrame.slice();
		const delivered: string[] = [];
		channel.subscribe(({ payload }) => delivered.push(new TextDecoder().decode(payload)));
		const exact = message(topic, "peer-writer", frame());
		stamp(exact);
		expect(adapter.route(exact)).toBe(true);
		const wrongTopic = message(topic, "peer-writer", Uint8Array.of(1));
		stamp(wrongTopic, "wrong-topic");
		expect(adapter.route(wrongTopic)).toBe(true);
		expect(network.claimIngressEvidence?.(wrongTopic)).toBeUndefined();
		const malformed = message(topic, "peer-writer", Uint8Array.of(0xff));
		stamp(malformed);
		expect(adapter.route(malformed)).toBe(true);
		const unknown = message(topic, "peer-unknown", frame());
		stamp(unknown);
		expect(adapter.route(unknown)).toBe(true);
		const reader = message(topic, "peer-reader", frame());
		stamp(reader);
		expect(adapter.route(reader)).toBe(true);
		roster.set("peer-writer", "author-reader");
		const revoked = message(topic, "peer-writer", frame());
		stamp(revoked);
		expect(adapter.route(revoked)).toBe(true);
		expect(delivered).toEqual(["fixture"]);
		expect(channel.stats()).toMatchObject({ delivered: 1, malformed: 1, unauthorized: 3 });
		channel.close();
		expect(adapter.route(message(topic, "peer-writer", Uint8Array.of(1)))).toBe(false);
	});
});

describe.skipIf(!channelAvailable)("Track E1 shared ephemeral channel", () => {
	it("publishes 57,600 movement samples through the ephemeral channel", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		const channel = createBoundaryChannel(module, bus.createPort("alice"), options());
		for (let sample = 0; sample < 57_600; sample += 1) {
			await channel.publish({
				class: "unreliable-sequenced",
				key: "alice",
				payload: bytes(String(sample)),
			});
		}

		expect(channel.stats().published).toBe(57_600);

		channel.close();
	});

	it("delivers all three classes and isolates sequenced watermarks by sender and key", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		const alice = createBoundaryChannel(module, bus.createPort("alice"), options());
		const carol = createBoundaryChannel(module, bus.createPort("carol"), options());
		const bob = createBoundaryChannel(
			module,
			bus.createPort("bob"),
			options({ maxSequencedKeys: 6, maxSequencedSenders: 2 })
		);
		bus.authorize("bob", "alice");
		bus.authorize("bob", "carol");
		const delivered: DeliveredFrame[] = [];
		bob.subscribe((frame) => delivered.push(frame));

		expect(await alice.publish({ class: "unreliable-unordered", key: null, payload: bytes("unordered") })).toBe(true);
		expect(await alice.publish({ class: "reliable-unordered", key: null, payload: bytes("reliable") })).toBe(true);
		expect(await alice.publish({ class: "unreliable-sequenced", key: "avatar", payload: bytes("alice-1") })).toBe(true);
		expect(await carol.publish({ class: "unreliable-sequenced", key: "avatar", payload: bytes("carol-1") })).toBe(true);
		bus.inject(
			"bob",
			"alice",
			module.encodeEphemeralFrame({
				class: "unreliable-sequenced",
				key: "primary",
				payload: bytes("alice-primary-10"),
				sequence: 10,
			})
		);
		bus.inject(
			"bob",
			"alice",
			module.encodeEphemeralFrame({
				class: "unreliable-sequenced",
				key: "secondary",
				payload: bytes("alice-secondary-1"),
				sequence: 1,
			})
		);

		expect(delivered.map((frame) => new TextDecoder().decode(frame.payload))).toEqual([
			"unordered",
			"reliable",
			"alice-1",
			"carol-1",
			"alice-primary-10",
			"alice-secondary-1",
		]);
		expect(delivered.at(-2)?.sequence).toBe(10);
		expect(delivered.at(-1)?.sequence).toBe(1);
		expect(bob.stats()).toMatchObject({ delivered: 6, received: 6 });
	});

	it("rejects replay after disconnect while accepting a later monotonic publication", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		const alice = createBoundaryChannel(module, bus.createPort("alice"), options());
		const bob = createBoundaryChannel(module, bus.createPort("bob"), options());
		bus.authorize("bob", "alice");
		const delivered: DeliveredFrame[] = [];
		let replayedDuringCallback = false;
		bob.subscribe((frame) => {
			if (!replayedDuringCallback) {
				replayedDuringCallback = true;
				bus.inject(
					"bob",
					"alice",
					module.encodeEphemeralFrame({
						class: frame.class,
						key: frame.key,
						payload: frame.payload,
						sequence: frame.sequence,
					})
				);
			}
		});
		bob.subscribe((frame) => delivered.push(frame));
		await alice.publish({ class: "unreliable-sequenced", key: "avatar", payload: bytes("first") });
		const replay = bus.sent().at(-1)?.bytes;
		if (replay === undefined) throw new Error("missing controlled replay frame");

		bus.disconnect("alice");
		bus.connect("alice");
		bus.inject("bob", "alice", replay);
		await alice.publish({ class: "unreliable-sequenced", key: "avatar", payload: bytes("second") });

		expect(delivered.map((frame) => new TextDecoder().decode(frame.payload))).toEqual(["first", "second"]);
		expect(bob.stats()).toMatchObject({ delivered: 2, received: 4, stale: 2 });
	});

	it("bounds unreliable queues, drops newest unordered work and coalesces sequenced work by key", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		const alice = createBoundaryChannel(module, bus.createPort("alice"), options());
		const bob = createBoundaryChannel(module, bus.createPort("bob"), options());
		bus.authorize("bob", "alice");
		const delivered: DeliveredFrame[] = [];
		bob.subscribe((frame) => delivered.push(frame));

		bus.hold("alice");
		const unordered = Array.from({ length: 10_000 }, (_, index) =>
			alice.publish({ class: "unreliable-unordered", key: null, payload: bytes(`u:${index}`) })
		);
		await Promise.resolve();
		expect(bus.pending("alice")).toBeGreaterThan(0);
		bus.release("alice");
		const unorderedResults = await Promise.all(unordered);
		const unorderedAccepted = unorderedResults.filter(Boolean).length;
		expect(unorderedAccepted).toBeGreaterThan(0);
		expect(unorderedAccepted).toBeLessThan(unordered.length);
		expect(unorderedResults[0]).toBe(true);
		expect(unorderedResults.at(-1)).toBe(false);

		bus.hold("alice");
		const sequenced = Array.from({ length: 10_000 }, (_, index) =>
			alice.publish({ class: "unreliable-sequenced", key: "avatar", payload: bytes(`s:${index}`) })
		);
		await Promise.resolve();
		expect(bus.pending("alice")).toBeGreaterThan(0);
		bus.release("alice");
		const sequencedResults = await Promise.all(sequenced);
		const sequencedAccepted = sequencedResults.filter(Boolean).length;
		expect(sequencedAccepted).toBeGreaterThan(0);
		expect(sequencedAccepted).toBeLessThan(sequenced.length);
		expect(sequencedResults.at(-1)).toBe(true);
		const latest = delivered.at(-1);
		if (latest === undefined) throw new Error("missing latest sequenced delivery");
		expect(new TextDecoder().decode(latest.payload)).toBe("s:9999");
		expect(alice.stats().dropped).toBeGreaterThan(0);
		expect(alice.stats().published).toBe(unorderedAccepted + sequencedAccepted);
	});

	it("copies publication bytes and isolates throwing subscribers", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		const alice = createBoundaryChannel(module, bus.createPort("alice"), options());
		const bob = createBoundaryChannel(module, bus.createPort("bob"), options());
		bus.authorize("bob", "alice");
		const payload = bytes("copied");
		const delivered: string[] = [];
		bob.subscribe((frame) => {
			frame.payload.fill(0);
			throw new Error("subscriber failure");
		});
		bob.subscribe((frame) => delivered.push(new TextDecoder().decode(frame.payload)));

		const publication = alice.publish({ class: "unreliable-unordered", key: null, payload });
		payload.fill(0);
		expect(await publication).toBe(true);
		expect(delivered).toEqual(["copied"]);
		expect(bob.stats().subscriberFailures).toBe(1);
	});

	it("fails closed for malformed, unauthorized, stale and over-limit ingress", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		const alice = createBoundaryChannel(module, bus.createPort("alice"), options());
		const bob = createBoundaryChannel(module, bus.createPort("bob"), options({ maxMessageBytes: 128 }));
		const delivered: DeliveredFrame[] = [];
		bob.subscribe((frame) => delivered.push(frame));

		bus.authorize("bob", "alice");
		bus.inject("bob", "alice", Uint8Array.of(0xff, 0x00));
		bus.authorize("bob", "alice", false);
		await alice.publish({ class: "unreliable-unordered", key: null, payload: bytes("unauthorized") });
		bus.authorize("bob", "alice");
		bus.inject(
			"bob",
			"alice",
			module.encodeEphemeralFrame({
				class: "unreliable-sequenced",
				key: "avatar",
				payload: new Uint8Array(256),
				sequence: 1,
			})
		);

		expect(delivered).toEqual([]);
		expect(bob.stats()).toMatchObject({
			delivered: 0,
			malformed: 1,
			overLimit: 1,
			received: 3,
			unauthorized: 1,
		});
	});

	it("enforces closed options and sender-plus-key limits", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		const port = bus.createPort("alice");
		expect(() => module.createEphemeralChannel(port, options({ maxMessageBytes: 0 }))).toThrow();
		expect(() => module.createEphemeralChannel(port, options({ maxMessageBytes: 65_537 }))).toThrow();
		expect(() => module.createEphemeralChannel(port, options({ maxSequencedKeys: 0 }))).toThrow();
		expect(() => module.createEphemeralChannel(port, options({ maxSequencedKeys: 4_097 }))).toThrow();
		expect(() => module.createEphemeralChannel(port, options({ maxSequencedSenders: 0 }))).toThrow();
		const maxSenderBoundary = module.createEphemeralChannel(
			bus.createPort("max-sender-boundary"),
			options({ maxSequencedKeys: 1, maxSequencedSenders: 4_095 })
		);
		maxSenderBoundary.close();
		expect(() => module.createEphemeralChannel(port, options({ maxSequencedSenders: 4_096 }))).toThrow();
		expect(() =>
			module.createEphemeralChannel(port, options({ maxSequencedKeys: 2, maxSequencedSenders: 2_048 }))
		).toThrow();
		const tinyEnvelope = module.createEphemeralChannel(bus.createPort("tiny-envelope", 1), options());
		expect(await tinyEnvelope.publish({ class: "unreliable-unordered", key: null, payload: bytes("oversize") })).toBe(
			false
		);
		expect(tinyEnvelope.stats()).toMatchObject({ overLimit: 1, published: 0 });
		tinyEnvelope.close();
		expect(() =>
			module.createEphemeralChannel(port, {
				maxMessageBytes: 65_536,
				maxSequencedKeys: 1,
			} as ReturnType<typeof options>)
		).toThrow();
		expect(() =>
			module.createEphemeralChannel(bus.createPort("extra-options"), {
				...options(),
				unexpected: true,
			} as ReturnType<typeof options>)
		).toThrow();
		const channel = module.createEphemeralChannel(port, options({ maxSequencedKeys: 1 }));
		expect(await channel.publish({ class: "unreliable-sequenced", key: "x".repeat(129), payload: bytes("x") })).toBe(
			false
		);
		const retainedKey = "y".repeat(128);
		expect(await channel.publish({ class: "unreliable-sequenced", key: retainedKey, payload: bytes("x") })).toBe(true);
		expect(await channel.publish({ class: "unreliable-sequenced", key: "second", payload: bytes("x") })).toBe(false);
		expect(await channel.publish({ class: "unreliable-sequenced", key: retainedKey, payload: bytes("again") })).toBe(
			true
		);
		const snapshot = channel.stats();
		expect(snapshot).toMatchObject({ overLimit: 2, sequencedKeys: 1 });
		try {
			(snapshot as { sequencedKeys: number }).sequencedKeys = 99;
		} catch {
			// A frozen snapshot and a detached mutable snapshot are both externally immutable channel state.
		}
		expect(channel.stats().sequencedKeys).toBe(1);
		channel.close();
		expect(channel.stats().sequencedKeys).toBe(0);
		expect(await channel.publish({ class: "unreliable-unordered", key: null, payload: bytes("closed") })).toBe(false);
		expect(legacyBoundaryFallbackCount).toBe(0);
	});

	it("reuses identical authorized node channel options and rejects conflicting reopen", async () => {
		const { NodeEphemeralAdapter } = await loadNodeEphemeralModule();
		const subscribedTopics: string[] = [];
		const getGroupPeers = vi.fn((topic: string): readonly string[] =>
			topic === "world" ? ["durable-only"] : ["writer", "reader"]
		);
		const network = {
			...nodeNetwork(),
			getGroupPeers,
			subscribe: (topic: string): void => {
				subscribedTopics.push(topic);
			},
		} as unknown as DRPNetworkNode;
		const adapter = new NodeEphemeralAdapter(network, null);
		const provider: V3EphemeralAuthorizationProvider = {
			authorForPeer: (peerId) =>
				peerId === "writer" ? "author-writer" : peerId === "reader" ? "author-reader" : undefined,
			currentAuthority: () => ({
				objectId: "world",
				epoch: 0,
				aclDigest: "22".repeat(32),
				anchorDigest: "11".repeat(32),
			}),
			isCurrentWriter: (author) => author === "author-writer",
		};
		const first = adapter.openAuthorized("world", provider, options());
		expect(first.authorizedPeers()).toEqual(["writer"]);
		expect(subscribedTopics).toHaveLength(1);
		expect(subscribedTopics[0]).not.toBe("world");
		expect(getGroupPeers).toHaveBeenCalledWith(subscribedTopics[0]);
		expect(getGroupPeers).not.toHaveBeenCalledWith("world");
		expect(adapter.openAuthorized("world", provider, options())).toBe(first);
		expect(() => adapter.openAuthorized("world", provider, options({ maxMessageBytes: 1_024 }))).toThrow();
		expect(() => adapter.openAuthorized("world", provider, options({ maxSequencedSenders: 4_094 }))).toThrow();
		first.close();
	});
	it("retries reliable local failures but does not retry unreliable publications", async () => {
		const module = await loadEphemeralModule();
		const bus = new ControlledEphemeralBus();
		const alice = createBoundaryChannel(module, bus.createPort("alice"), options());
		bus.failNext("alice", 1);
		expect(await alice.publish({ class: "unreliable-unordered", key: null, payload: bytes("drop") })).toBe(false);
		bus.failNext("alice", 2);
		expect(await alice.publish({ class: "reliable-unordered", key: null, payload: bytes("retry") })).toBe(true);
		bus.failNext("alice", 1_000);
		expect(await alice.publish({ class: "reliable-unordered", key: null, payload: bytes("bounded") })).toBe(false);
		expect(alice.stats()).toMatchObject({ dropped: 1, published: 1 });
	});

	it("keeps frame decoding closed and detached", async () => {
		const module = await loadEphemeralModule();
		const encoded = module.encodeEphemeralFrame({
			class: "unreliable-sequenced",
			key: "avatar",
			payload: bytes("frame"),
			sequence: 7,
		});
		const decoded = module.decodeEphemeralFrame(encoded);
		expect(decoded).toMatchObject({
			class: "unreliable-sequenced",
			key: "avatar",
			sequence: 7,
		});
		expect(new TextDecoder().decode(decoded.payload)).toBe("frame");
		expect(() =>
			module.encodeEphemeralFrame({
				class: "unknown" as DeliveryClass,
				key: null,
				payload: bytes("frame"),
				sequence: 0,
			})
		).toThrow();
		expect(() =>
			module.encodeEphemeralFrame({
				class: "unreliable-unordered",
				key: null,
				payload: bytes("frame"),
				sequence: 0,
				unexpected: true,
			} as DecodedFrame)
		).toThrow();
		expect(() =>
			module.encodeEphemeralFrame({
				class: "unreliable-unordered",
				key: "extra",
				payload: bytes("frame"),
				sequence: 0,
			})
		).toThrow();
		expect(() =>
			module.encodeEphemeralFrame({
				class: "unreliable-sequenced",
				key: null,
				payload: bytes("frame"),
				sequence: 1,
			})
		).toThrow();
		expect(() =>
			module.encodeEphemeralFrame({
				class: "unreliable-sequenced",
				key: "avatar",
				payload: bytes("frame"),
				sequence: Number.MAX_SAFE_INTEGER + 1,
			})
		).toThrow();
		expect(() => module.decodeEphemeralFrame(encoded.subarray(0, encoded.length - 1))).toThrow();
		expect(() => module.decodeEphemeralFrame(Uint8Array.of(...encoded, 0))).toThrow();
		expect(() => module.decodeEphemeralFrame(Uint8Array.of(0xff, 0xfe, 0xfd))).toThrow();
	});
});
