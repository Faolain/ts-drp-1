import type { DRPNetworkHostConfigSnapshot } from "@ts-drp/network";
import type { RelayCandidate, RelayPolicyResult } from "@ts-drp/relay-policy";
import type { RendezvousDirectory, SignedDrpRecordV1, ValidatedDrpRecord } from "@ts-drp/rendezvous";
import { describe, expect, it, vi } from "vitest";

import {
	assertIsolatedHostSnapshot,
	ControlPlaneCoordinator,
	type DirectTransportProof,
	type GridCoordinatorOptions,
	type GridNodePort,
	type GridObjectPort,
	type GridRelayPolicyPort,
	isValidDirectProof,
} from "../src/grid/index.js";

const NAMESPACE = "drp-network:v1:abcdefghijklmnopqrstuv";
const CREATOR = "creator-peer";
const JOINER = "joiner-peer";
const RELAY = "relay-peer";

describe("ControlPlaneCoordinator", () => {
	it("rejects an omitted-policy equivalent: any fixed bootstrap seed", () => {
		expect(
			() =>
				new ControlPlaneCoordinator({
					...options("creator"),
					bootstrapPeers: ["/dns4/bootstrap.topology.gg/tcp/443/wss/p2p/fixed"],
				})
		).toThrowError(expect.objectContaining({ code: "BOOTSTRAP_CONFIGURATION_FORBIDDEN" }));
	});

	it("registers a short-TTL creator record only after a routing-backed reservation", async () => {
		const harness = options("creator");
		const coordinator = new ControlPlaneCoordinator(harness);

		const result = await coordinator.startCreator(AbortSignal.timeout(1_000));

		expect(result.objectId).toBe("grid-object");
		expect(harness.directory.register).toHaveBeenCalledOnce();
		expect(result.record.expiresAtMs - result.record.issuedAtMs).toBe(60_000);
		expect(coordinator.snapshot.provenance).toEqual(["rendezvous register"]);
		expect(coordinator.snapshot.events.map(({ kind }) => kind)).toEqual([
			"host-started",
			"relay-discovery",
			"relay-reservation",
			"registry-register",
		]);
	});

	it("joins without creator identity input and preserves the exact anti-cheat provenance", async () => {
		const harness = options("joiner");
		const coordinator = new ControlPlaneCoordinator(harness);

		const object = await coordinator.startJoiner("grid-object", AbortSignal.timeout(1_000));

		expect(object.id).toBe("grid-object");
		expect(coordinator.snapshot.creatorPeerKnownBeforeDiscovery).toBe(false);
		expect(coordinator.snapshot.provenance).toEqual([
			"rendezvous register",
			"discover",
			"validate",
			"routing-backed relay candidate",
			"reservation",
			"dial",
		]);
		expect(harness.node.networkNode.connect).toHaveBeenCalledWith(expect.stringContaining(`/p2p/${CREATOR}`));
		expect(coordinator.snapshot.terminal).toBe("success");
		expect(coordinator.snapshot.phase).toBe("direct");
	});

	it("records movement through the joined production-object port", async () => {
		const harness = options("joiner");
		const coordinator = new ControlPlaneCoordinator(harness);
		await coordinator.startJoiner("grid-object", AbortSignal.timeout(1_000));

		await coordinator.move("R");
		await coordinator.move("U");

		expect(harness.object.position(JOINER)).toEqual({ x: 1, y: 1 });
		expect(coordinator.snapshot.events.filter(({ kind }) => kind === "movement")).toHaveLength(2);
	});

	it("reports bounded owned fallback separately from success", async () => {
		const harness = options("joiner", relayResult("owned-fallback", 4_999));
		const coordinator = new ControlPlaneCoordinator(harness);

		await expect(coordinator.startJoiner("grid-object", AbortSignal.timeout(6_000))).rejects.toMatchObject({
			code: "RELAY_EXHAUSTED",
		});
		expect(coordinator.snapshot.terminal).toBe("owned-fallback");
		expect(coordinator.snapshot.events.at(-1)).toMatchObject({
			detail: "relay policy owned-fallback in 4999 ms",
			kind: "terminal",
		});
	});

	it("replaces a lost relay without adding a seed", async () => {
		const harness = options("joiner");
		harness.relayPolicy.replace = vi.fn(() => Promise.resolve(relayResult("reserved", 12, "replacement-relay")));
		const coordinator = new ControlPlaneCoordinator(harness);
		await coordinator.startJoiner("grid-object", AbortSignal.timeout(1_000));

		await coordinator.recoverRelay(RELAY, AbortSignal.timeout(1_000));

		expect(harness.relayPolicy.replace).toHaveBeenCalledWith(RELAY, "relay-disconnected", expect.any(AbortSignal));
		expect(coordinator.snapshot.relayPeerIds).toEqual(["replacement-relay"]);
		expect(coordinator.snapshot.events.at(-1)?.kind).toBe("relay-recovery");
	});
});

describe("Phase 07 direct oracle and host isolation", () => {
	it("accepts a correlated, non-circuit WebRTC data channel with separate byte counters", () => {
		expect(isValidDirectProof(directProof())).toBe(true);
		expect(
			isValidDirectProof({
				...directProof(),
				libp2pAddress: "/p2p-circuit",
				libp2pTransport: "unknown" as never,
			})
		).toBe(false);
		expect(isValidDirectProof({ ...directProof(), iceCandidateTypes: ["host", "relay"] })).toBe(false);
		expect(isValidDirectProof({ ...directProof(), iceCandidateTypes: ["host"] })).toBe(false);
		expect(isValidDirectProof({ ...directProof(), directBytesSent: 0 })).toBe(false);
	});

	it("requires every fail-closed production host invariant", () => {
		const isolated = isolatedSnapshot();
		expect(() => assertIsolatedHostSnapshot(isolated)).not.toThrow();
		for (const unsafe of [
			{ ...isolated, bootstrapDiscovery: true },
			{ ...isolated, bootstrapPeerCount: 1 },
			{ ...isolated, coldStartPubsubDiscovery: true },
			{ ...isolated, gossipSubPeerExchange: true },
			{ ...isolated, outboundAddressPolicy: "allow-all" as const },
			{ ...isolated, peerDiscoveryModules: ["@libp2p/bootstrap"] as const },
		]) {
			expect(() => assertIsolatedHostSnapshot(unsafe)).toThrow("not fail-closed");
		}
	});
});

function options(
	role: "creator" | "joiner",
	relay = relayResult("reserved", 12)
): GridCoordinatorOptions & {
	readonly directory: RendezvousDirectory;
	readonly node: GridNodePort;
	readonly object: GridObjectPort;
	readonly relayPolicy: GridRelayPolicyPort;
} {
	const object = gridObject();
	const peers: string[] = [];
	const groups: string[] = [];
	const networkNode = {
		connect: vi.fn((address: string | readonly string[]): Promise<void> => {
			if (String(address).includes(CREATOR)) peers.push(CREATOR);
			return Promise.resolve();
		}),
		getAllPeers: vi.fn(() => [...peers]),
		getGroupPeers: vi.fn(() => [...groups]),
		peerId: role === "creator" ? CREATOR : JOINER,
	};
	const node = {
		connectObject: vi.fn((): Promise<GridObjectPort> => {
			groups.push(CREATOR);
			return Promise.resolve(object);
		}),
		createObject: vi.fn(() => Promise.resolve(object)),
		networkNode,
		start: vi.fn(() => Promise.resolve()),
		stop: vi.fn(() => Promise.resolve()),
	} satisfies GridNodePort;
	const record = signedRecord();
	const validated: ValidatedDrpRecord = {
		admissionMode: "invite",
		record,
		sourceEndpointId: "registry-a",
	};
	const directory = {
		discover: vi.fn(() => Promise.resolve([validated])),
		register: vi.fn(() =>
			Promise.resolve({ acceptedEndpointIds: ["registry-a"], attempts: [], sequence: record.sequence })
		),
	} satisfies RendezvousDirectory;
	const relayPolicy: GridRelayPolicyPort = {
		acquire: vi.fn(() => Promise.resolve(relay)),
	};
	return {
		bootstrapPeers: [],
		directory,
		directProof: { inspect: vi.fn(() => Promise.resolve(directProof())) },
		namespace: NAMESPACE,
		node,
		now: () => 1_750_000_000_000,
		object,
		recordFactory: {
			create: vi.fn(({ addresses, namespace, nowMs, peerId }) =>
				Promise.resolve({
					...record,
					addresses,
					expiresAtMs: nowMs + 60_000,
					issuedAtMs: nowMs,
					namespace,
					peerId,
				})
			),
		},
		relayPolicy,
		role,
	};
}

function gridObject(): GridObjectPort {
	const positions = new Map<string, { x: number; y: number }>();
	return {
		id: "grid-object",
		move(actor, direction): void {
			const position = positions.get(actor) ?? { x: 0, y: 0 };
			if (direction === "R") position.x += 1;
			if (direction === "L") position.x -= 1;
			if (direction === "U") position.y += 1;
			if (direction === "D") position.y -= 1;
			positions.set(actor, position);
		},
		position(actor): { readonly x: number; readonly y: number } | undefined {
			return positions.get(actor);
		},
	};
}

function relayCandidate(peerId = RELAY): RelayCandidate {
	return {
		addresses: [`/dns4/relay.example/tcp/443/wss/p2p/${peerId}`],
		operatorGroup: "operator-a",
		peerId,
		protocols: ["/libp2p/circuit/relay/0.2.0/hop"],
		provenance: {
			origin: "browser-closest-peers",
			queryDigest: "query-safe",
			resultIndex: 0,
			routingSource: "delegated-routing",
		},
	};
}

function relayResult(terminal: RelayPolicyResult["terminal"], durationMs: number, peerId = RELAY): RelayPolicyResult {
	return {
		attempts: [],
		candidatesObserved: 1,
		durationMs,
		operatorGroups: terminal === "reserved" ? ["operator-a"] : [],
		reservations:
			terminal === "reserved"
				? [{ candidate: relayCandidate(peerId), expiresAtMs: Date.now() + 60_000, limit: {}, reservedAtMs: Date.now() }]
				: [],
		terminal,
		...(terminal === "owned-fallback" ? { fallback: { status: "accepted" as const } } : {}),
	};
}

function signedRecord(): SignedDrpRecordV1 {
	return {
		addresses: [`/dns4/relay.example/tcp/443/wss/p2p/${RELAY}/p2p-circuit/webrtc/p2p/${CREATOR}`],
		capabilities: ["drp-gossipsub", "relay-client", "webrtc"],
		expiresAtMs: 1_750_000_060_000,
		issuedAtMs: 1_750_000_000_000,
		kind: "ts-drp-rendezvous-record",
		namespace: NAMESPACE,
		peerId: CREATOR,
		publicKey: "fixture-public-key",
		sequence: 1,
		signature: "fixture-signature",
		version: 1,
	};
}

function directProof(): DirectTransportProof {
	return {
		connectionId: "libp2p-connection-1",
		correlation: "runtime-observed",
		correlationBasis: "unique-libp2p-webrtc-connection-and-init-datachannel",
		dataChannelOpen: true,
		directBytesReceived: 256,
		directBytesSent: 128,
		iceCandidateTypes: ["host", "host"],
		libp2pAddress: `/ip4/192.0.2.2/udp/4001/webrtc-direct/p2p/${CREATOR}`,
		libp2pTransport: "webrtc",
		relayedBytesReceived: 64,
		relayedBytesSent: 96,
		rtcPeerConnectionId: "rtc-peer-connection-1",
		transport: "webrtc",
	};
}

function isolatedSnapshot(): DRPNetworkHostConfigSnapshot {
	return {
		bootstrapDiscovery: false,
		bootstrapPeerCount: 0,
		coldStartPubsubDiscovery: false,
		gossipSubPeerExchange: false,
		outboundAddressPolicy: "injected",
		peerDiscoveryModules: [],
	};
}
