import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, concatBytes } from "@noble/hashes/utils";
import type { EphemeralChannel, EphemeralChannelOptions } from "@ts-drp/ephemeral";
import type { DRPNetworkNode, IDRP, IDRPObject, Message } from "@ts-drp/types";
import { describe, expect, it } from "vitest";

import { type EphemeralAuthorizationProvider, NodeEphemeralAdapter } from "../src/ephemeral.js";
import {
	ControlledRawBus,
	type ControlledRawOwner,
	type ControlledRawRoute,
} from "./fixtures/controlled-unreliable-webrtc.js";

const OPTIONS: EphemeralChannelOptions = Object.freeze({
	maxMessageBytes: 1_024,
	maxSequencedKeys: 2,
	maxSequencedSenders: 8,
});
const AUTHORITY = Object.freeze({
	aclDigest: "22".repeat(32),
	anchorDigest: "11".repeat(32),
	epoch: 0,
	objectId: "zone",
});
const TOPIC_DOMAIN = new TextEncoder().encode("ts-drp-ephemeral-topic-v1\0");

interface ControlledNode {
	readonly adapter: NodeEphemeralAdapter;
	readonly channel: EphemeralChannel;
	readonly direct: Message[];
	readonly owner: ControlledRawOwner | null;
	readonly published: Message[];
}

function topicFor(objectId: string): string {
	return `/ts-drp/ephemeral/1/${bytesToHex(sha256(concatBytes(TOPIC_DOMAIN, new TextEncoder().encode(objectId))))}`;
}

function controlledNode(input: {
	readonly bus: ControlledRawBus;
	readonly localPeerId: string;
	readonly peers: string[];
	readonly raw: boolean;
	readonly roster: ReadonlyMap<string, string>;
	readonly writers: ReadonlySet<string>;
}): ControlledNode {
	const direct: Message[] = [];
	const published: Message[] = [];
	const owner = input.raw ? input.bus.owner(input.localPeerId) : null;
	const network = {
		getAllPeers: (): readonly string[] => [...input.peers],
		getGroupPeers: (): readonly string[] => [...input.peers],
		peerId: input.localPeerId,
		publishMessage: (_topic: string, message: Message): Promise<boolean> => {
			published.push(message);
			return Promise.resolve(true);
		},
		sendMessage: (_peerId: string, message: Message): Promise<void> => {
			direct.push(message);
			return Promise.resolve();
		},
		subscribe: (): void => undefined,
		subscribeToPeerDisconnects: (): (() => void) => (): void => undefined,
		unsubscribe: (): void => undefined,
	} as unknown as DRPNetworkNode;
	const provider: EphemeralAuthorizationProvider = {
		authorForPeer: (peerId): string | undefined => input.roster.get(peerId),
		currentAuthority: () => AUTHORITY,
		isCurrentWriter: (author): boolean => input.writers.has(author),
	};
	const adapter = new NodeEphemeralAdapter(network, () => undefined, owner);
	return {
		adapter,
		channel: adapter.openAuthorized("zone", provider, OPTIONS),
		direct,
		owner,
		published,
	};
}

function payload(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function onlyRoute(owner: ControlledRawOwner | null): ControlledRawRoute {
	const route = owner?.opened.values().next().value;
	if (route === undefined) throw new Error("raw route missing");
	return route;
}

function expectNoReliable(node: ControlledNode): void {
	expect(node.published).toHaveLength(0);
	expect(node.direct).toHaveLength(0);
}

describe("E3-02 v3 zone transport adoption RED", () => {
	it("selects authority-derived raw lanes and intersects live writers with connected peers", async () => {
		const bus = new ControlledRawBus();
		bus.connect("peer-a", "peer-b");
		bus.connect("peer-a", "peer-connected-reader");
		const peers = ["peer-b", "peer-authorized-offline", "peer-connected-reader"];
		const roster = new Map([
			["peer-a", "author-a"],
			["peer-b", "author-b"],
			["peer-authorized-offline", "author-offline"],
			["peer-connected-reader", "author-reader"],
		]);
		const writers = new Set(["author-a", "author-b", "author-offline"]);
		const left = controlledNode({ bus, localPeerId: "peer-a", peers, raw: true, roster, writers });
		const right = controlledNode({ bus, localPeerId: "peer-b", peers: ["peer-a"], raw: true, roster, writers });
		const connectedReader = controlledNode({
			bus,
			localPeerId: "peer-connected-reader",
			peers: ["peer-a"],
			raw: true,
			roster,
			writers,
		});
		const delivered: string[] = [];
		right.channel.subscribe(({ payload: bytes, sender }) =>
			delivered.push(`${sender}:${new TextDecoder().decode(bytes)}`)
		);
		try {
			const routeId = topicFor("zone");
			expect(onlyRoute(left.owner).routeId).toBe(routeId);
			expect(onlyRoute(right.owner).routeId).toBe(routeId);
			expect(topicFor("zone-collision")).not.toBe(routeId);
			expect(
				await left.channel.publish({ class: "unreliable-sequenced", key: "movement", payload: payload("east") })
			).toBe(true);
			expect(delivered).toEqual(["peer-a:east"]);
			expect(bus.sends.at(-1)).toMatchObject({ peers: ["peer-b"], routeId, sender: "peer-a" });
			expectNoReliable(left);

			writers.delete("author-b");
			writers.add("author-reader");
			expect(await left.channel.publish({ class: "unreliable-unordered", key: null, payload: payload("south") })).toBe(
				true
			);
			expect(bus.sends.at(-1)?.peers).toEqual(["peer-connected-reader"]);
			expectNoReliable(left);
		} finally {
			left.channel.close();
			right.channel.close();
			connectedReader.channel.close();
		}
	});

	it("fails every unavailable raw state closed with zero reliable fallback", async () => {
		const roster = new Map([["peer-b", "author-b"]]);
		const writers = new Set(["author-b"]);
		const cases = ["missing", "unready", "closed", "backpressured"] as const;
		for (const state of cases) {
			const bus = new ControlledRawBus();
			bus.connect("peer-a", "peer-b");
			const node = controlledNode({
				bus,
				localPeerId: "peer-a",
				peers: ["peer-b"],
				raw: state !== "missing",
				roster,
				writers,
			});
			const remote = controlledNode({ bus, localPeerId: "peer-b", peers: ["peer-a"], raw: true, roster, writers });
			try {
				if (state === "unready") bus.disconnect("peer-a", "peer-b");
				if (state === "closed") onlyRoute(node.owner).close();
				if (state === "backpressured") onlyRoute(node.owner).backpressured = true;
				for (const deliveryClass of ["unreliable-unordered", "unreliable-sequenced"] as const) {
					expect(
						await node.channel.publish({
							class: deliveryClass,
							key: deliveryClass === "unreliable-sequenced" ? "movement" : null,
							payload: payload(state),
						})
					).toBe(false);
				}
				expectNoReliable(node);
			} finally {
				node.channel.close();
				remote.channel.close();
			}
		}
	});

	it("isolates wrong routes and spoofed peers and releases the private route", async () => {
		const bus = new ControlledRawBus();
		bus.connect("peer-a", "peer-b");
		const roster = new Map([
			["peer-a", "author-a"],
			["peer-b", "author-b"],
		]);
		const writers = new Set(["author-a", "author-b"]);
		const left = controlledNode({ bus, localPeerId: "peer-a", peers: ["peer-b"], raw: true, roster, writers });
		const right = controlledNode({ bus, localPeerId: "peer-b", peers: ["peer-a"], raw: true, roster, writers });
		const delivered: string[] = [];
		right.channel.subscribe(({ payload: bytes, sender }) =>
			delivered.push(`${sender}:${new TextDecoder().decode(bytes)}`)
		);
		const route = onlyRoute(right.owner);
		try {
			expect(await left.channel.publish({ class: "unreliable-unordered", key: null, payload: payload("exact") })).toBe(
				true
			);
			const frame = bus.sends.at(-1)?.bytes;
			if (frame === undefined) throw new Error("raw frame missing");
			const foreign = right.owner?.openUnreliableWebRtcRoute(topicFor("other-zone"));
			if (foreign === undefined) throw new Error("foreign route missing");
			foreign.emit(frame, "peer-a");
			route.emit(frame, "peer-spoofed");
			expect(delivered).toEqual(["peer-a:exact"]);
			expectNoReliable(left);
		} finally {
			left.channel.close();
			right.channel.close();
		}
		expect(route.closed).toBe(true);
	});

	it("keeps every legacy class on the reliable carrier and never opens raw", async () => {
		const bus = new ControlledRawBus();
		const owner = bus.owner("peer-legacy");
		const reliable: Message[] = [];
		const network = {
			getGroupPeers: (): readonly string[] => ["peer-b"],
			peerId: "peer-legacy",
			publishMessage: (_topic: string, message: Message): Promise<boolean> => {
				reliable.push(message);
				return Promise.resolve(true);
			},
			sendMessage: (): Promise<void> => Promise.resolve(),
			subscribe: (): void => undefined,
			unsubscribe: (): void => undefined,
		} as unknown as DRPNetworkNode;
		const object = { acl: { query_isWriter: (): boolean => true } } as unknown as IDRPObject<IDRP>;
		const adapter = new NodeEphemeralAdapter(network, () => object, owner);
		const channel = adapter.open("legacy-zone", OPTIONS);
		try {
			for (const deliveryClass of ["reliable-unordered", "unreliable-unordered", "unreliable-sequenced"] as const) {
				expect(
					await channel.publish({
						class: deliveryClass,
						key: deliveryClass === "unreliable-sequenced" ? "movement" : null,
						payload: payload(deliveryClass),
					})
				).toBe(true);
			}
			expect(reliable).toHaveLength(3);
			expect(owner.opened.size).toBe(0);
		} finally {
			channel.close();
		}
	});
});
