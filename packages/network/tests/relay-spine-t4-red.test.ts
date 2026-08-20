import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import type { PeerScoreParams } from "@libp2p/gossipsub/score";
import type { MultiaddrConnection, PeerId } from "@libp2p/interface";
import { peerIdFromPublicKey, peerIdFromString } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import {
	type ActiveRelayReservation,
	CIRCUIT_RELAY_V2_HOP_PROTOCOL,
	RELAY_TRANSPORT_PROFILES,
	type RelayCandidate,
	type RelayCandidateSource,
	type RelayPolicyResult,
	type RelayReplacementResult,
} from "@ts-drp/relay-policy";
import type { DRPConnectionBudget, DRPNetworkNodeConfig, DRPPeerSelectionSnapshot } from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
	type ConnectionAdmissionController,
	createConnectionAdmissionController,
	type ExplicitDialTicket,
} from "../src/connection-budget.js";
import {
	type DRPNetworkHostFactory,
	DRPNetworkNode,
	type RelayPolicyDriver,
	type RelayPolicyFactoryOptions,
} from "../src/node.js";

const RELAY_PEER_ID = "12D3KooWQ8U7hG4xYQmLJxhnvYwQbWJ7SwkVmJmM5J4zn5LhfZ7f";
const RELAY_ADDRESS = `/dns4/relay.example/tcp/443/wss/p2p/${RELAY_PEER_ID}`;
const quietPolicy = {
	bootstrapDiscovery: false,
	coldStartPubsubDiscovery: false,
	gossipSubPeerExchange: false,
};
const localAddressPolicy = {
	allowInsecureWebSocket: true,
	allowLoopback: true,
	allowPrivate: true,
	target: "node" as const,
};

interface PriorityAdmissionController extends ConnectionAdmissionController {
	createPriorityTicket(target: string | PeerId): ExplicitDialTicket | undefined;
	hasActiveRelayPeer(peerId: string): boolean;
	reconcileRelayReservations(
		reservations: readonly Readonly<{
			peerId: string;
			priorityTicket?: ExplicitDialTicket;
		}>[],
		terminal?: RelayPolicyResult["terminal"]
	): void;
}

interface T4Snapshot extends DRPPeerSelectionSnapshot {
	readonly priority: number;
	readonly prioritySlots: number;
	readonly replacements: number;
}

interface T4NodeView {
	readonly _connectionAdmission?: PriorityAdmissionController;
	readonly _pubsub?: {
		heartbeat(): Promise<void>;
		readonly score: { readonly params: PeerScoreParams; score(peerId: string): number };
	};
	readonly _lastRelayPolicyResult?: RelayPolicyResult;
	readonly _relayPolicy?: RelayPolicyDriver;
	readonly _relayPolicyAcquirePromise?: Promise<void>;
	readonly _relayPolicyController?: AbortController;
	getPeerSelectionSnapshot(): T4Snapshot;
	_scheduleRelayRefresh(result: RelayPolicyResult, policy: RelayPolicyDriver, controller: AbortController): void;
}

type T4ControllerFactory = (
	budget: DRPConnectionBudget,
	options: { readonly prioritySlots: number }
) => PriorityAdmissionController;

const createT4Controller = createConnectionAdmissionController as unknown as T4ControllerFactory;

function peer(index: number): PeerId {
	const bytes = new Uint8Array(32);
	bytes[0] = 0x49;
	new DataView(bytes.buffer).setUint32(28, index + 1, false);
	return peerIdFromPublicKey(privateKeyFromRaw(bytes).publicKey);
}

function connection(index: number): MultiaddrConnection {
	return { remoteAddr: multiaddr(`/ip4/127.0.0.1/tcp/${45_000 + index}`) } as MultiaddrConnection;
}

function snapshot(controller: PriorityAdmissionController): T4Snapshot {
	return controller.getSnapshot(0, 5_000, false) as T4Snapshot;
}

function relayCandidate(address = RELAY_ADDRESS, peerId = RELAY_PEER_ID): RelayCandidate {
	return {
		addresses: [address],
		operatorGroup: "operator:verified-a",
		peerId,
		protocols: ["/libp2p/circuit/relay/0.2.0/hop"],
		provenance: {
			origin: "configured-relay",
			queryDigest: "query_t4",
			resultIndex: 0,
			routingSource: "configured",
		},
	};
}

function activeReservation(candidate = relayCandidate()): ActiveRelayReservation {
	return {
		candidate,
		expiresAtMs: Date.now() + 60_000,
		limit: { dataBytes: 1_024, durationSeconds: 60 },
		reservedAtMs: Date.now(),
	};
}

function relayResult(reservations: readonly ActiveRelayReservation[] = [activeReservation()]): RelayPolicyResult {
	return {
		attempts: [],
		candidatesObserved: 1,
		durationMs: 1,
		operatorGroups: reservations.map(({ candidate }) => candidate.operatorGroup),
		reservations,
		terminal: reservations.length === 0 ? "exhausted" : "reserved",
	};
}

function relayDriver(result: RelayPolicyResult = relayResult()): RelayPolicyDriver {
	return {
		activeReservations: result.reservations,
		acquire: (): Promise<RelayPolicyResult> => Promise.resolve(result),
		refresh: (): Promise<RelayPolicyResult> => Promise.resolve(result),
		replace: (peerId, reason): Promise<RelayReplacementResult> =>
			Promise.resolve({ ...result, reason, replacedPeerId: peerId }),
		stop: (): Promise<void> => Promise.resolve(),
	};
}

function delayedRelaySource(candidate: RelayCandidate): {
	release(): void;
	readonly source: RelayCandidateSource;
} {
	let release: (() => void) | undefined;
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		release: (): void => release?.(),
		source: {
			async *getCandidates(_queryKey, signal): AsyncIterable<RelayCandidate> {
				await ready;
				signal.throwIfAborted();
				yield candidate;
			},
		},
	};
}

function gateRelayReserveStream(
	node: DRPNetworkNode,
	relayPeerId: string
): {
	fail(): void;
	release(): void;
	restore(): void;
	readonly started: Promise<void>;
} {
	type GateableConnection = {
		close(): Promise<void>;
		newStream(...args: unknown[]): Promise<unknown>;
	};
	const host = node["_node"] as unknown as
		| { getConnections(peerId: PeerId): readonly GateableConnection[] }
		| undefined;
	const connection = host?.getConnections(peerIdFromString(relayPeerId))[0];
	if (connection === undefined) throw new Error("expected a reusable relay connection");
	const original = connection.newStream.bind(connection);
	let failReservation = false;
	let release: (() => void) | undefined;
	let started: (() => void) | undefined;
	const reservationStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const reservationGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	Object.defineProperty(connection, "newStream", {
		configurable: true,
		value: async (...args: unknown[]): Promise<unknown> => {
			if (args[0] !== CIRCUIT_RELAY_V2_HOP_PROTOCOL) return original(...args);
			started?.();
			await reservationGate;
			if (failReservation) throw new Error("controlled RESERVE stream failure");
			return original(...args);
		},
	});
	return {
		fail: (): void => {
			failReservation = true;
		},
		release: (): void => release?.(),
		restore: (): void => {
			Object.defineProperty(connection, "newStream", { configurable: true, value: original });
		},
		started: reservationStarted,
	};
}

function realRelayPolicyFactory(node: DRPNetworkNode): (options: RelayPolicyFactoryOptions) => RelayPolicyDriver {
	return (
		node as unknown as { _createRelayPolicy(options: RelayPolicyFactoryOptions): RelayPolicyDriver }
	)._createRelayPolicy.bind(node);
}

function config(
	maxConnections = 4,
	maxParallelDials = 1,
	maxApplicationScore?: number,
	targetReservations = 1,
	relayAddress: string | readonly string[] = RELAY_ADDRESS
): DRPNetworkNodeConfig {
	return {
		bootstrap_peers: [],
		connection_budget: {
			max_connections: maxConnections,
			max_parallel_dials: maxParallelDials,
		},
		control_plane: {
			address_policy: localAddressPolicy,
			...(maxApplicationScore === undefined
				? {}
				: {
						pubsub_scoring: {
							observed_behavior_reward: {
								enabled: true,
								max_application_score: maxApplicationScore,
							},
						},
					}),
			relay_policy: {
				sources: { configured_relays: typeof relayAddress === "string" ? [relayAddress] : [...relayAddress] },
				target_reservations: targetReservations,
			},
		},
		listen_addresses: [],
		log_config: { level: "silent" },
	};
}

describe("D.93.50 T4 relay-spine priority admission", () => {
	const running: DRPNetworkNode[] = [];

	afterEach(async () => {
		await Promise.allSettled(
			running.splice(0).map(async (node) => {
				if (node["_node"]?.status !== "stopped") await node.stop();
			})
		);
	});

	test("keeps the committed priority tail unavailable to ordinary explicit and inbound custody", async () => {
		const controller = createT4Controller(
			{ maxConnections: 4, maxParallelDials: 1, role: "node" },
			{ prioritySlots: 1 }
		);
		const tickets = ["ordinary-a", "ordinary-b", "ordinary-c"].map((target) => controller.createExplicitTicket(target));
		for (const ticket of tickets) expect(ticket).toBeDefined();
		expect(controller.createExplicitTicket("ordinary-tail"), "T4_COMMITTED_TAIL_ABSENT").toBeUndefined();
		const priorityAtCommittedBoundary = controller.createPriorityTicket("relay-at-tail");
		expect(priorityAtCommittedBoundary, "T4_COMMITTED_TAIL_ABSENT").toBeDefined();
		expect(snapshot(controller)).toMatchObject({ charged: 1, priority: 1, prioritySlots: 1 });
		priorityAtCommittedBoundary?.release();
		for (const ticket of tickets) ticket?.release();

		const borrower = peer(1);
		expect(controller.admitDiscoveredPeer(borrower, [multiaddr(`/p2p/${borrower}`)])).toBe(true);
		const inbound = controller.connectionGater.denyInboundUpgradedConnection;
		if (inbound === undefined) throw new Error("expected inbound admission gate");
		for (const index of [2, 3, 4]) expect(inbound(peer(index), connection(index))).toBe(false);
		expect(inbound(peer(5), connection(5)), "T4_COMMITTED_TAIL_ABSENT").toBe(true);
		expect(snapshot(controller)).toMatchObject({ selected: 1, upgrade: 3 });
		const borrowerManager = {
			openConnection: vi.fn((_target: PeerId, _options: object) => Promise.resolve()),
		};
		controller.wrapConnectionManager(borrowerManager);
		await expect(
			borrowerManager.openConnection(borrower, {}),
			"T4_SELECTED_CHARGE_AT_COMMITTED_TAIL"
		).rejects.toThrow();
		const outbound = controller.connectionGater.denyOutboundUpgradedConnection;
		if (outbound === undefined) throw new Error("expected outbound admission gate");
		expect(outbound(borrower, connection(6)), "T4_SELECTED_LIVE_AT_COMMITTED_TAIL").toBe(true);
		const reclaim = controller.createPriorityTicket("relay-reclaims-borrower");
		expect(reclaim, "T4_COMMITTED_TAIL_RECLAIM_ABSENT").toBeDefined();
		expect(snapshot(controller)).toMatchObject({ charged: 1, priority: 1, replacements: 1, selected: 0, upgrade: 3 });
		const denyDialPeer = controller.connectionGater.denyDialPeer;
		if (denyDialPeer === undefined) throw new Error("expected dial peer admission gate");
		expect(denyDialPeer(borrower)).toBe(true);
		reclaim?.release();
		controller.stop();

		const explicitBoundary = createT4Controller(
			{ maxConnections: 4, maxParallelDials: 1, role: "node" },
			{ prioritySlots: 1 }
		);
		const explicitInbound = explicitBoundary.connectionGater.denyInboundUpgradedConnection;
		if (explicitInbound === undefined) throw new Error("expected explicit-boundary inbound gate");
		expect(explicitInbound(peer(7), connection(7))).toBe(false);
		expect(explicitInbound(peer(8), connection(8))).toBe(false);
		const unchargedExplicit = explicitBoundary.createExplicitTicket(peer(9));
		expect(unchargedExplicit).toBeDefined();
		expect(
			explicitBoundary.createExplicitTicket(peer(10)),
			"T4_ORDINARY_EXPLICIT_COMMITTED_TAIL_ABSENT"
		).toBeUndefined();
		expect(explicitBoundary.createPriorityTicket("relay-private-free-tail")).toBeDefined();
		expect(snapshot(explicitBoundary)).toMatchObject({ priority: 1, prioritySlots: 1, upgrade: 2 });
		unchargedExplicit?.release();
		explicitBoundary.stop();
	});

	test("serializes free-capacity priority requests and publishes one immutable subset census", () => {
		const controller = createT4Controller(
			{ maxConnections: 4, maxParallelDials: 1, role: "node" },
			{ prioritySlots: 2 }
		);
		expect(controller.createPriorityTicket, "T4_PRIORITY_CONTROLLER_ABSENT").toBeTypeOf("function");
		const first = controller.createPriorityTicket(peer(6));
		const second = controller.createPriorityTicket(peer(7));
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(controller.createPriorityTicket(peer(8))).toBeUndefined();
		const value = snapshot(controller);
		expect(value).toMatchObject({ priority: 2, prioritySlots: 2, replacements: 0 });
		expect(value.priority).toBeLessThanOrEqual(value.charged + value.upgrade + value.live);
		expect(Object.isFrozen(value)).toBe(true);
		first?.release();
		second?.release();
		controller.stop();
	});

	test("lets only priority custody reclaim the newest borrowed selection", async () => {
		const controller = createT4Controller(
			{ maxConnections: 4, maxParallelDials: 1, role: "node" },
			{ prioritySlots: 1 }
		);
		const first = peer(10);
		const newest = peer(11);
		expect(
			controller.admitDiscoveredPeers([first, newest], [multiaddr(`/p2p/${first}`), multiaddr(`/p2p/${newest}`)])
		).toBe(true);
		const inbound = controller.connectionGater.denyInboundUpgradedConnection;
		if (inbound === undefined) throw new Error("expected inbound admission gate");
		expect(inbound(peer(12), connection(12))).toBe(false);
		expect(inbound(peer(13), connection(13))).toBe(false);

		expect(controller.createPriorityTicket, "T4_SELECTED_RECLAIM_ABSENT").toBeTypeOf("function");
		const priority = controller.createPriorityTicket(peer(14));
		expect(priority, "T4_SELECTED_RECLAIM_ABSENT").toBeDefined();
		expect(snapshot(controller)).toMatchObject({
			priority: 1,
			prioritySlots: 1,
			replacements: 1,
			selected: 1,
			upgrade: 2,
		});
		const manager = { openConnection: vi.fn((_target: PeerId, _options: object) => Promise.resolve()) };
		controller.wrapConnectionManager(manager);
		await expect(manager.openConnection(first, {}), "T4_RETAINED_SELECTION_IDENTITY_ABSENT").resolves.toBeUndefined();
		await expect(manager.openConnection(newest, {}), "T4_NEWEST_SELECTION_IDENTITY_ABSENT").rejects.toThrow();
		expect(controller.createPriorityTicket(peer(15))).toBeUndefined();
		priority?.release();
		controller.stop();
	});

	test("never reclaims charged, upgrade, live, explicit, priority, or unknown custody", async () => {
		const charged = createT4Controller({ maxConnections: 2, maxParallelDials: 1, role: "node" }, { prioritySlots: 1 });
		const chargedPeer = peer(30);
		const chargedTicket = charged.createExplicitTicket(chargedPeer);
		if (chargedTicket === undefined) throw new Error("expected charged-state ticket");
		expect(charged.createPriorityTicket, "T4_ACTIVE_WORK_PROTECTION_ABSENT").toBeTypeOf("function");
		const manager = {
			openConnection: vi.fn((_target: PeerId, _options: object) => Promise.resolve()),
		};
		charged.wrapConnectionManager(manager);
		await manager.openConnection(chargedPeer, chargedTicket.bindOptions(chargedPeer, {}));
		expect(charged.createPriorityTicket(peer(31)), "T4_ACTIVE_WORK_PROTECTION_ABSENT").toBeDefined();
		expect(charged.createPriorityTicket(peer(32))).toBeUndefined();
		expect(snapshot(charged)).toMatchObject({ charged: 2, priority: 1 });
		charged.stop();

		const upgraded = createT4Controller({ maxConnections: 2, maxParallelDials: 1, role: "node" }, { prioritySlots: 1 });
		expect(upgraded.createPriorityTicket, "T4_ACTIVE_WORK_PROTECTION_ABSENT").toBeTypeOf("function");
		const inbound = upgraded.connectionGater.denyInboundUpgradedConnection;
		if (inbound === undefined) throw new Error("expected inbound admission gate");
		expect(inbound(peer(33), connection(33))).toBe(false);
		expect(upgraded.createPriorityTicket(peer(34)), "T4_ACTIVE_WORK_PROTECTION_ABSENT").toBeDefined();
		expect(upgraded.createPriorityTicket(peer(35))).toBeUndefined();
		expect(snapshot(upgraded)).toMatchObject({ priority: 1, upgrade: 1 });
		upgraded.stop();

		const live = createT4Controller({ maxConnections: 3, maxParallelDials: 1, role: "node" }, { prioritySlots: 1 });
		expect(live.createPriorityTicket, "T4_ACTIVE_WORK_PROTECTION_ABSENT").toBeTypeOf("function");
		const livePeer = peer(36);
		const liveConnection = {
			id: "t4-live-connection",
			remoteAddr: multiaddr("/ip4/127.0.0.1/tcp/45036"),
			remotePeer: livePeer,
		};
		const secondLiveConnection = { ...liveConnection, id: "t4-live-connection-2" };
		const host = Object.assign(new EventTarget(), {
			getConnections: (): readonly [typeof liveConnection, typeof secondLiveConnection] => [
				liveConnection,
				secondLiveConnection,
			],
			peerId: peer(999),
		});
		live.attach(host as unknown as Parameters<ConnectionAdmissionController["attach"]>[0]);
		expect(live.createPriorityTicket(peer(37)), "T4_ACTIVE_WORK_PROTECTION_ABSENT").toBeDefined();
		expect(live.createPriorityTicket(peer(38))).toBeUndefined();
		expect(snapshot(live)).toMatchObject({ live: 2, priority: 1 });
		const denyLiveDial = live.connectionGater.denyDialPeer;
		if (denyLiveDial === undefined) throw new Error("expected live dial admission gate");
		expect(denyLiveDial(livePeer)).toBe(false);
		live.stop();

		const explicit = createT4Controller({ maxConnections: 2, maxParallelDials: 1, role: "node" }, { prioritySlots: 1 });
		expect(explicit.createPriorityTicket, "T4_ACTIVE_WORK_PROTECTION_ABSENT").toBeTypeOf("function");
		const explicitTicket = explicit.createExplicitTicket(peer(39));
		expect(explicitTicket, "T4_ACTIVE_WORK_PROTECTION_ABSENT").toBeDefined();
		expect(explicit.createPriorityTicket(peer(40))).toBeDefined();
		expect(explicit.createPriorityTicket(peer(41))).toBeUndefined();
		const explicitManager = {
			openConnection: vi.fn((_target: PeerId, _options: object) => Promise.resolve()),
		};
		explicit.wrapConnectionManager(explicitManager);
		if (explicitTicket === undefined) throw new Error("expected explicit-state ticket");
		await expect(
			explicitManager.openConnection(peer(39), explicitTicket.bindOptions(peer(39), {})),
			"T4_UNCHARGED_EXPLICIT_RECLAIMED"
		).resolves.toBeUndefined();
		expect(snapshot(explicit)).toMatchObject({ charged: 2, priority: 1 });
		explicitTicket?.release();
		explicit.stop();

		const priority = createT4Controller({ maxConnections: 2, maxParallelDials: 1, role: "node" }, { prioritySlots: 1 });
		expect(priority.createPriorityTicket, "T4_ACTIVE_WORK_PROTECTION_ABSENT").toBeTypeOf("function");
		expect(priority.createPriorityTicket(peer(42)), "T4_ACTIVE_WORK_PROTECTION_ABSENT").toBeDefined();
		expect(priority.createPriorityTicket(peer(43))).toBeUndefined();
		const denyUnknownDial = priority.connectionGater.denyDialPeer;
		if (denyUnknownDial === undefined) throw new Error("expected unknown dial admission gate");
		expect(denyUnknownDial(peer(44))).toBe(true);
		priority.stop();
	});

	test("reconciles only controller-issued reservations and clears absent or stopped membership", () => {
		const controller = createT4Controller(
			{ maxConnections: 4, maxParallelDials: 1, role: "node" },
			{ prioritySlots: 2 }
		);
		expect(controller.createPriorityTicket, "T4_RESULT_RECONCILIATION_ABSENT").toBeTypeOf("function");
		const ticket = controller.createPriorityTicket("relay-correlated");
		const secondTicket = controller.createPriorityTicket("relay-partial");
		if (ticket === undefined) throw new Error("expected priority ticket");
		if (secondTicket === undefined) throw new Error("expected second priority ticket");
		expect(controller.reconcileRelayReservations, "T4_RESULT_RECONCILIATION_ABSENT").toBeTypeOf("function");

		controller.reconcileRelayReservations(
			[
				{ peerId: "relay-correlated", priorityTicket: ticket },
				{ peerId: "relay-partial", priorityTicket: secondTicket },
			],
			"reserved"
		);
		expect(controller.hasActiveRelayPeer("relay-correlated")).toBe(true);
		expect(controller.hasActiveRelayPeer("relay-partial")).toBe(true);
		expect(snapshot(controller)).toMatchObject({ priority: 2 });

		controller.reconcileRelayReservations([{ peerId: "relay-partial", priorityTicket: secondTicket }], "exhausted");
		expect(controller.hasActiveRelayPeer("relay-correlated")).toBe(false);
		expect(controller.hasActiveRelayPeer("relay-partial")).toBe(true);
		expect(snapshot(controller)).toMatchObject({ priority: 1 });

		const abortedTicket = controller.createPriorityTicket("relay-aborted-partial");
		if (abortedTicket === undefined) throw new Error("expected capacity after exhausted partial reconciliation");
		controller.reconcileRelayReservations(
			[
				{ peerId: "relay-partial", priorityTicket: secondTicket },
				{ peerId: "relay-aborted-partial", priorityTicket: abortedTicket },
			],
			"reserved"
		);
		controller.reconcileRelayReservations(
			[{ peerId: "relay-aborted-partial", priorityTicket: abortedTicket }],
			"aborted"
		);
		expect(controller.hasActiveRelayPeer("relay-partial")).toBe(false);
		expect(controller.hasActiveRelayPeer("relay-aborted-partial")).toBe(true);
		expect(snapshot(controller)).toMatchObject({ priority: 1 });

		controller.reconcileRelayReservations([], "exhausted");
		expect(controller.hasActiveRelayPeer("relay-aborted-partial")).toBe(false);
		expect(snapshot(controller)).toMatchObject({ priority: 0 });
		controller.stop();
		expect(controller.hasActiveRelayPeer("relay-correlated")).toBe(false);

		const uncorrelated = createT4Controller(
			{ maxConnections: 2, maxParallelDials: 1, role: "node" },
			{ prioritySlots: 1 }
		);
		uncorrelated.reconcileRelayReservations([{ peerId: "relay-uncorrelated" }]);
		expect(uncorrelated.hasActiveRelayPeer("relay-uncorrelated")).toBe(false);
		const firstUnbound = uncorrelated.createPriorityTicket("relay-first");
		const secondUnbound = uncorrelated.createPriorityTicket("relay-second");
		if (firstUnbound === undefined) throw new Error("expected one bounded correlation ticket");
		uncorrelated.reconcileRelayReservations([{ peerId: "relay-second", priorityTicket: firstUnbound }]);
		expect(uncorrelated.hasActiveRelayPeer("relay-second"), "T4_REBOUND_TICKET_REJECTED_ABSENT").toBe(false);
		uncorrelated.reconcileRelayReservations([
			{ peerId: "relay-forged", priorityTicket: { release: (): void => undefined } as ExplicitDialTicket },
		]);
		expect(uncorrelated.hasActiveRelayPeer("relay-forged"), "T4_FORGED_TICKET_REJECTED_ABSENT").toBe(false);
		firstUnbound.release();
		uncorrelated.reconcileRelayReservations([{ peerId: "relay-first", priorityTicket: firstUnbound }]);
		expect(uncorrelated.hasActiveRelayPeer("relay-first"), "T4_STALE_TICKET_REJECTED_ABSENT").toBe(false);
		secondUnbound?.release();
		uncorrelated.stop();
	});

	test("keeps priority inert after controller stop and preserves the zero-slot private dial fallback", async () => {
		const controller = createT4Controller(
			{ maxConnections: 4, maxParallelDials: 1, role: "node" },
			{ prioritySlots: 1 }
		);
		controller.stop();
		expect(controller.createPriorityTicket, "T4_STOPPED_PRIORITY_AUTHORITY_ABSENT").toBeTypeOf("function");
		expect(controller.createPriorityTicket(peer(20))).toBeUndefined();

		const relay = new DRPNetworkNode(
			{
				bootstrap_peers: [],
				connection_budget: { max_connections: 4, max_parallel_dials: 1 },
				control_plane: { address_policy: localAddressPolicy },
				listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
				log_config: { level: "silent" },
				relay_service: { enabled: true },
			},
			{ hostPolicy: quietPolicy }
		);
		const node = new DRPNetworkNode(
			{
				...config(),
				control_plane: {
					address_policy: localAddressPolicy,
					relay_policy: { sources: {}, target_reservations: 1 },
				},
			},
			{ hostPolicy: quietPolicy }
		);
		running.push(relay, node);
		await Promise.all([relay.start(), node.start()]);
		expect((node as unknown as T4NodeView).getPeerSelectionSnapshot()).toMatchObject({ prioritySlots: 0 });
		const relayAddress = relay.getMultiaddrs().find((address) => address.includes("/ws/p2p/"));
		if (relayAddress === undefined) throw new Error("relay did not expose a WebSocket address");
		const policy = realRelayPolicyFactory(node)({
			onReservationEvent: (): void => undefined,
			perCandidateDeadlineMs: 5_000,
			source: {
				async *getCandidates(): AsyncIterable<RelayCandidate> {
					await Promise.resolve();
					yield {
						...relayCandidate(relayAddress, relay.peerId),
						operatorEvidence: {
							credentialDigest: `sha256:${relay.peerId}`,
							operatorGroup: "operator:verified-a",
							verified: true,
						},
					};
				},
			},
			targetReservations: 1,
			transportProfile: RELAY_TRANSPORT_PROFILES.node,
			totalDeadlineMs: 10_000,
		});
		await expect(
			policy.acquire(new TextEncoder().encode(node.peerId), new AbortController().signal),
			"T4_ZERO_SLOT_PRIVATE_DIAL_FALLBACK_ABSENT"
		).resolves.toMatchObject({ terminal: "reserved" });
		expect((node as unknown as T4NodeView).getPeerSelectionSnapshot()).toMatchObject({ priority: 0, prioritySlots: 0 });
		await policy.stop();
	});

	test("clears the preinstalled tail when relay-policy factory construction fails", async () => {
		let capturedAdmission: PriorityAdmissionController | undefined;
		let builtHost: { readonly status: string } | undefined;
		const node = new DRPNetworkNode(config(), {
			hostFactory: async (context): Promise<Awaited<ReturnType<typeof context.createHost>>> => {
				capturedAdmission = (node as unknown as T4NodeView)._connectionAdmission;
				const host = await context.createHost();
				builtHost = host;
				return host;
			},
			hostPolicy: quietPolicy,
			relayPolicyFactory: (): RelayPolicyDriver => {
				throw new Error("controlled relay factory failure");
			},
		});
		running.push(node);
		await expect(node.start()).rejects.toThrow("controlled relay factory failure");
		if (capturedAdmission === undefined) throw new Error("expected pre-host controller evidence");
		expect((node as unknown as T4NodeView)._connectionAdmission).toBeUndefined();
		expect(capturedAdmission.createPriorityTicket, "T4_FACTORY_FAILURE_CLEANUP_ABSENT").toBeTypeOf("function");
		expect(capturedAdmission.createPriorityTicket(peer(21))).toBeUndefined();
		expect(snapshot(capturedAdmission)).toMatchObject({ priority: 0, prioritySlots: 0 });
		expect(builtHost?.status, "T4_FACTORY_FAILURE_HOST_CLEANUP_ABSENT").toBe("stopped");
	});

	test("installs a source-qualified priority tail before host construction", async () => {
		const hostFactory = vi.fn<DRPNetworkHostFactory>((context) => {
			const admission = (node as unknown as T4NodeView)._connectionAdmission;
			if (admission === undefined) throw new Error("expected pre-host admission evidence");
			expect(snapshot(admission), "T4_PRE_HOST_PRIORITY_INSTALLATION_ABSENT").toMatchObject({
				priority: 0,
				prioritySlots: 1,
			});
			return context.createHost();
		});
		const node = new DRPNetworkNode(config(4, 1, undefined, 1), {
			hostFactory,
			hostPolicy: quietPolicy,
			relayPolicyFactory: (): RelayPolicyDriver => relayDriver(relayResult([])),
		});
		running.push(node);
		await node.start();
		expect(hostFactory).toHaveBeenCalledOnce();
	});

	test("does not let an arbitrary injected result mint score authority", async () => {
		const node = new DRPNetworkNode(config(4, 1, 0.2), {
			hostPolicy: quietPolicy,
			relayPolicyFactory: (): RelayPolicyDriver => relayDriver(),
		});
		running.push(node);
		await node.start();
		await node.retryRelayPolicyAcquisition();

		const score = (node as unknown as T4NodeView)._pubsub?.score.params.appSpecificScore(RELAY_PEER_ID);
		expect(score).toBe(0);
	});

	test("reconciles genuine acquire and refresh partials regardless of exhausted or aborted terminal labels", async () => {
		const relays = [0, 1].map(
			() =>
				new DRPNetworkNode(
					{
						bootstrap_peers: [],
						connection_budget: { max_connections: 4, max_parallel_dials: 1 },
						control_plane: { address_policy: localAddressPolicy },
						listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
						log_config: { level: "silent" },
						relay_service: { enabled: true },
					},
					{ hostPolicy: quietPolicy }
				)
		);
		running.push(...relays);
		await Promise.all(relays.map(async (relay) => relay.start()));
		const addresses = relays.map((relay) => {
			const address = relay.getMultiaddrs().find((candidate) => candidate.includes("/ws/p2p/"));
			if (address === undefined) throw new Error("relay did not expose a WebSocket address");
			return address;
		});

		const partialAcquire = new DRPNetworkNode(config(5, 1, 0.2, 2, addresses[0] as string), {
			hostPolicy: quietPolicy,
		});
		running.push(partialAcquire);
		await partialAcquire.start();
		const partialAcquireView = partialAcquire as unknown as T4NodeView;
		await partialAcquireView._relayPolicyAcquirePromise;
		const partialAcquireAdmission = partialAcquireView._connectionAdmission;
		if (partialAcquireAdmission === undefined) throw new Error("expected partial-acquire admission owner");
		expect(partialAcquireAdmission.hasActiveRelayPeer, "T4_PARTIAL_ACQUIRE_RECONCILIATION_ABSENT").toBeTypeOf(
			"function"
		);
		expect(
			partialAcquireAdmission.hasActiveRelayPeer(relays[0]?.peerId ?? ""),
			"T4_PARTIAL_ACQUIRE_RECONCILIATION_ABSENT"
		).toBe(true);
		expect(partialAcquireView.getPeerSelectionSnapshot()).toMatchObject({ priority: 1, prioritySlots: 2 });

		const refreshNode = new DRPNetworkNode(config(5, 1, 0.2, 2, addresses), { hostPolicy: quietPolicy });
		running.push(refreshNode);
		await refreshNode.start();
		const refreshView = refreshNode as unknown as T4NodeView;
		await refreshView._relayPolicyAcquirePromise;
		const refreshAdmission = refreshView._connectionAdmission;
		const policy = refreshView._relayPolicy;
		const controller = refreshView._relayPolicyController;
		if (refreshAdmission === undefined || policy === undefined || controller === undefined) {
			throw new Error("expected genuine refresh reconciliation owners");
		}
		expect(refreshAdmission.hasActiveRelayPeer, "T4_PARTIAL_REFRESH_RECONCILIATION_ABSENT").toBeTypeOf("function");
		const reservations = [...(policy.activeReservations ?? [])];
		const first = reservations[0];
		const second = reservations[1];
		if (first === undefined || second === undefined) throw new Error("expected two genuine reservations");
		const farExpiry = Date.now() + 300_000;
		const partial = (reservation: ActiveRelayReservation, terminal: "aborted" | "exhausted"): RelayPolicyResult => ({
			...relayResult([{ ...reservation, expiresAtMs: farExpiry }]),
			terminal,
		});
		const refresh = vi.spyOn(policy, "refresh").mockResolvedValue(partial(first, "exhausted"));
		refreshView._scheduleRelayRefresh(
			{ ...relayResult([{ ...first, expiresAtMs: Date.now() }]), terminal: "reserved" },
			policy,
			controller
		);
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
		await vi.waitFor(() => {
			expect(refreshAdmission.hasActiveRelayPeer(first.candidate.peerId)).toBe(true);
			expect(refreshAdmission.hasActiveRelayPeer(second.candidate.peerId)).toBe(false);
			expect(refreshView.getPeerSelectionSnapshot()).toMatchObject({ priority: 1, prioritySlots: 2 });
		});

		refresh.mockResolvedValue(partial(second, "aborted"));
		refreshView._scheduleRelayRefresh(
			{ ...relayResult([{ ...first, expiresAtMs: Date.now() }]), terminal: "reserved" },
			policy,
			controller
		);
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => {
			expect(refreshAdmission.hasActiveRelayPeer(first.candidate.peerId)).toBe(false);
			expect(refreshAdmission.hasActiveRelayPeer(second.candidate.peerId)).toBe(true);
			expect(refreshView.getPeerSelectionSnapshot()).toMatchObject({ priority: 1, prioritySlots: 2 });
		});
		refresh.mockRestore();
	}, 30_000);

	test("keeps reused live custody ordinary across genuine private-policy success and failure", async () => {
		const relay = new DRPNetworkNode(
			{
				bootstrap_peers: [],
				connection_budget: { max_connections: 4, max_parallel_dials: 1 },
				control_plane: { address_policy: localAddressPolicy },
				listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
				log_config: { level: "silent" },
				relay_service: { enabled: true },
			},
			{ hostPolicy: quietPolicy }
		);
		const ordinary = [0, 1].map(
			() =>
				new DRPNetworkNode(
					{
						bootstrap_peers: [],
						connection_budget: { max_connections: 4, max_parallel_dials: 1 },
						control_plane: { address_policy: localAddressPolicy },
						listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
						log_config: { level: "silent" },
					},
					{ hostPolicy: quietPolicy }
				)
		);
		running.push(relay, ...ordinary);
		await Promise.all([relay.start(), ...ordinary.map(async (node) => node.start())]);
		const addressOf = (node: DRPNetworkNode): string => {
			const address = node.getMultiaddrs().find((candidate) => candidate.includes("/ws/p2p/"));
			if (address === undefined) throw new Error("node did not expose a WebSocket address");
			return address;
		};
		const relayAddress = addressOf(relay);
		const ordinaryAddresses = ordinary.map(addressOf);
		const ordinaryA = ordinary[0];
		const ordinaryAddressA = ordinaryAddresses[0];
		const ordinaryAddressB = ordinaryAddresses[1];
		if (ordinaryA === undefined || ordinaryAddressA === undefined || ordinaryAddressB === undefined) {
			throw new Error("expected two ordinary reused-live fixtures");
		}

		for (const [caseName, candidateNode, liveAddresses, expectedActive, failDuringReserve] of [
			["success", relay, [relayAddress, ordinaryAddressA], true, false],
			["reserve-failure", relay, [relayAddress, ordinaryAddressB], false, true],
			["non-hop", ordinaryA, [ordinaryAddressA, ordinaryAddressB], false, undefined],
		] as const) {
			const source = delayedRelaySource(relayCandidate(liveAddresses[0], candidateNode.peerId));
			const client = new DRPNetworkNode(
				{
					bootstrap_peers: [],
					connection_budget: { max_connections: 3, max_parallel_dials: 1 },
					control_plane: {
						address_policy: localAddressPolicy,
						pubsub_scoring: { observed_behavior_reward: { enabled: true, max_application_score: 0.2 } },
						relay_policy: {
							sources: { configured_fallback: { enabled: true } },
							target_reservations: 1,
						},
					},
					listen_addresses: [],
					log_config: { level: "silent" },
				},
				{
					hostPolicy: quietPolicy,
					relayCandidateSources: { configuredFallback: source.source },
					relayPolicyFactory: (options): RelayPolicyDriver =>
						realRelayPolicyFactory(client)({ ...options, transportProfile: RELAY_TRANSPORT_PROFILES.node }),
				}
			);
			running.push(client);
			await client.start();
			await Promise.all(liveAddresses.map(async (address) => client.connect(address)));
			const view = client as unknown as T4NodeView;
			expect(view.getPeerSelectionSnapshot()).toMatchObject({ live: 2 });
			const reserveGate =
				failDuringReserve === undefined ? undefined : gateRelayReserveStream(client, candidateNode.peerId);
			const acquisition = view._relayPolicyAcquirePromise;
			if (acquisition === undefined) throw new Error("expected initial relay acquisition");
			source.release();
			const admission = view._connectionAdmission;
			if (admission === undefined) throw new Error("expected reused-live admission controller");
			if (reserveGate !== undefined) {
				await reserveGate.started;
				expect(view.getPeerSelectionSnapshot(), "T4_REUSED_LIVE_INFLIGHT_CENSUS_ABSENT").toMatchObject({
					live: 2,
					priority: 0,
					prioritySlots: 1,
				});
				expect(
					admission.createExplicitTicket(`ordinary-during-reused-reserve-${caseName}`),
					"T4_REUSED_LIVE_CONCURRENT_BOUNDARY_ABSENT"
				).toBeUndefined();
				if (failDuringReserve) reserveGate.fail();
				reserveGate.release();
			}
			await acquisition;
			reserveGate?.restore();
			expect(admission.hasActiveRelayPeer, "T4_REUSED_LIVE_RECONCILIATION_ABSENT").toBeTypeOf("function");
			expect(admission.hasActiveRelayPeer(candidateNode.peerId), `T4_REUSED_LIVE_${caseName}_MEMBERSHIP`).toBe(
				expectedActive
			);
			expect(view.getPeerSelectionSnapshot()).toMatchObject({ live: 2, priority: 0, prioritySlots: 1 });
			expect(
				admission.createExplicitTicket(`ordinary-at-reused-boundary-${caseName}`),
				"T4_REUSED_LIVE_COMMITTED_BOUNDARY_ABSENT"
			).toBeUndefined();
			const appSpecificScore = view._pubsub?.score.params.appSpecificScore;
			if (appSpecificScore === undefined) throw new Error("expected reused-live score closure");
			expect(appSpecificScore(candidateNode.peerId) > 0).toBe(expectedActive);
			if (expectedActive) {
				await expect(
					client.replaceRelay({ relayId: candidateNode.peerId }, new AbortController().signal),
					"T4_REUSED_LIVE_RELEASE_RECONCILIATION_ABSENT"
				).resolves.toBe(false);
				expect(admission.hasActiveRelayPeer(candidateNode.peerId)).toBe(false);
				expect(appSpecificScore(candidateNode.peerId)).toBe(0);
				expect(view.getPeerSelectionSnapshot()).toMatchObject({ live: 2, priority: 0, prioritySlots: 1 });
			}
			await client.stop();
		}
	}, 30_000);

	test("releases only the genuinely created relay connection and preserves a same-peer application connection", async () => {
		const relay = new DRPNetworkNode(
			{
				bootstrap_peers: [],
				connection_budget: { max_connections: 4, max_parallel_dials: 1 },
				control_plane: { address_policy: localAddressPolicy },
				listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
				log_config: { level: "silent" },
				relay_service: { enabled: true },
			},
			{ hostPolicy: quietPolicy }
		);
		running.push(relay);
		await relay.start();
		const reservationAddress = relay.getMultiaddrs().find((candidate) => candidate.includes("/ws/p2p/"));
		if (reservationAddress === undefined) throw new Error("relay did not expose a WebSocket address");
		const source = delayedRelaySource(relayCandidate(reservationAddress, relay.peerId));
		const client = new DRPNetworkNode(
			{
				bootstrap_peers: [],
				connection_budget: { max_connections: 3, max_parallel_dials: 1 },
				control_plane: {
					address_policy: localAddressPolicy,
					relay_policy: {
						sources: { node_closest_peers: { enabled: true } },
						target_reservations: 1,
					},
					rollout: { public_components: { delegated_routing: { enabled: true } } },
					routing: {
						node: {
							enabled: true,
							network: "public",
							public_network_acknowledgement: "I_ACKNOWLEDGE_PUBLIC_NETWORK_TRAFFIC",
						},
					},
				},
				listen_addresses: [],
				log_config: { level: "silent" },
			},
			{
				hostPolicy: quietPolicy,
				relayCandidateSources: { nodeClosestPeers: source.source },
				relayPolicyFactory: (options): RelayPolicyDriver => realRelayPolicyFactory(client)(options),
			}
		);
		running.push(client);
		await client.start();

		type ClosableConnection = { close(): Promise<void>; readonly id: string };
		type DialHost = {
			dial(target: ReturnType<typeof multiaddr>, options: object): Promise<ClosableConnection>;
			getConnections(peerId: PeerId): readonly ClosableConnection[];
			hangUp(peerId: PeerId): Promise<void>;
		};
		const host = client["_node"] as unknown as DialHost | undefined;
		if (host === undefined) throw new Error("expected a started client host");
		const relayPeer = peerIdFromString(relay.peerId);
		const hangUp = vi.spyOn(host, "hangUp");

		const acquisition = (client as unknown as T4NodeView)._relayPolicyAcquirePromise;
		if (acquisition === undefined) throw new Error("expected initial relay acquisition");
		source.release();
		await acquisition;
		const result = (client as unknown as T4NodeView)._lastRelayPolicyResult;
		expect(result).toMatchObject({
			attempts: [{ status: "reserved" }],
			candidatesObserved: 1,
			terminal: "reserved",
		});
		const ownedConnectionId = result?.attempts[0]?.connectionId;
		expect(ownedConnectionId, "T4_PRODUCTION_OWNED_CONNECTION_RECEIPT_ABSENT").toBeTypeOf("string");
		if (ownedConnectionId === undefined) throw new Error("expected the reserved attempt connection id");
		hangUp.mockClear();
		const ownedConnection = host.getConnections(relayPeer).find(({ id }) => id === ownedConnectionId);
		expect(ownedConnection, "T4_PRODUCTION_OWNED_CONNECTION_RECEIPT_ABSENT").toBeDefined();
		if (ownedConnection === undefined) throw new Error("expected the relay-policy dial connection");
		const ownedClose = vi.spyOn(ownedConnection, "close");
		const admission = (client as unknown as T4NodeView)._connectionAdmission;
		if (admission === undefined) throw new Error("expected a connection admission controller");
		const applicationTarget = multiaddr(reservationAddress);
		const applicationTicket = admission.createExplicitTicket(applicationTarget);
		if (applicationTicket === undefined) throw new Error("expected same-peer application authorization");
		const applicationConnection = await host.dial(
			applicationTarget,
			applicationTicket.bindOptions(applicationTarget, { force: true })
		);
		expect(applicationConnection.id).not.toBe(ownedConnection.id);
		const applicationClose = vi.spyOn(applicationConnection, "close");
		expect(host.getConnections(relayPeer).map(({ id }) => id)).toEqual(
			expect.arrayContaining([ownedConnection.id, applicationConnection.id])
		);
		await expect(
			client.replaceRelay({ relayId: relay.peerId }, new AbortController().signal),
			"T4_PRODUCTION_EXACT_RELEASE_ABSENT"
		).resolves.toBe(false);
		expect(ownedClose, "T4_PRODUCTION_EXACT_RELEASE_ABSENT").toHaveBeenCalledOnce();
		expect(applicationClose, "T4_PRODUCTION_APPLICATION_CONNECTION_CLOSED").not.toHaveBeenCalled();
		expect(hangUp, "T4_PRODUCTION_PEER_WIDE_RELEASE_USED").not.toHaveBeenCalled();
		expect(host.getConnections(relayPeer).map(({ id }) => id)).toContain(applicationConnection.id);
	}, 30_000);

	test("projects a genuinely reserved relay above an otherwise neutral peer with behavior rollout disabled", async () => {
		const relay = new DRPNetworkNode(
			{
				bootstrap_peers: [],
				connection_budget: { max_connections: 4, max_parallel_dials: 1 },
				control_plane: { address_policy: localAddressPolicy },
				listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
				log_config: { level: "silent" },
				relay_service: { enabled: true },
			},
			{ hostPolicy: quietPolicy }
		);
		running.push(relay);
		await relay.start();
		const relayAddress = relay.getMultiaddrs().find((address) => address.includes("/ws/p2p/"));
		if (relayAddress === undefined) throw new Error("relay did not expose a WebSocket address");

		const node = new DRPNetworkNode(config(4, 1, undefined, 1, relayAddress), { hostPolicy: quietPolicy });
		running.push(node);
		await node.start();
		await node.retryRelayPolicyAcquisition();

		const view = node as unknown as T4NodeView;
		const appSpecificScore = view._pubsub?.score.params.appSpecificScore;
		if (appSpecificScore === undefined) throw new Error("expected native GossipSub score closure");
		expect(appSpecificScore(relay.peerId), "T4_RESERVED_RELAY_DEFAULT_SCORE_ABSENT").toBe(0.5);
		expect(appSpecificScore(peer(30).toString())).toBe(0);
		expect(view.getPeerSelectionSnapshot()).toMatchObject({ priority: 1, prioritySlots: 1 });
	}, 15_000);

	test("moves score membership through genuine relay replacement and clears it on stop", async () => {
		const relays = [40, 41].map(
			() =>
				new DRPNetworkNode(
					{
						bootstrap_peers: [],
						connection_budget: { max_connections: 4, max_parallel_dials: 1 },
						control_plane: { address_policy: localAddressPolicy },
						listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
						log_config: { level: "silent" },
						relay_service: { enabled: true },
					},
					{ hostPolicy: quietPolicy }
				)
		);
		running.push(...relays);
		await Promise.all(relays.map(async (relay) => relay.start()));
		const addresses = relays.map((relay) => {
			const address = relay.getMultiaddrs().find((candidate) => candidate.includes("/ws/p2p/"));
			if (address === undefined) throw new Error("relay did not expose a WebSocket address");
			return address;
		});
		const node = new DRPNetworkNode(config(4, 1, 0.2, 1, addresses), { hostPolicy: quietPolicy });
		running.push(node);
		await node.start();
		await node.retryRelayPolicyAcquisition();
		const pubsub = (node as unknown as T4NodeView)._pubsub;
		if (pubsub === undefined) throw new Error("expected native score closure");
		const scoreOwner = pubsub.score;
		const score = scoreOwner.params.appSpecificScore;
		const activeIndex = score(relays[0]?.peerId ?? "") > 0 ? 0 : 1;
		const replacementIndex = activeIndex === 0 ? 1 : 0;
		const active = relays[activeIndex];
		const replacement = relays[replacementIndex];
		if (active === undefined || replacement === undefined) throw new Error("expected two relays");
		expect(score(active.peerId), "T4_RESERVED_RELAY_SCORE_ABSENT").toBe(0.2);
		expect(score(replacement.peerId)).toBe(0);
		await vi.waitFor(() => {
			expect(scoreOwner.score(active.peerId), "T4_NATIVE_SCORE_CACHE_PRIME_ABSENT").toBeGreaterThan(0);
		});

		await expect(
			node.replaceRelay({ relayId: active.peerId }, new AbortController().signal),
			"T4_PUBLIC_REPLACE_RECONCILIATION_ABSENT"
		).resolves.toBe(true);
		await vi.waitFor(
			() => {
				expect(score(active.peerId)).toBe(0);
				expect(score(replacement.peerId)).toBe(0.2);
			},
			{ timeout: 5_000 }
		);
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		await pubsub.heartbeat();
		expect(scoreOwner.score(active.peerId), "T4_NATIVE_SCORE_CACHE_EXPIRY_ABSENT").toBe(0);
		await replacement.stop();
		await vi.waitFor(
			() => {
				expect(score(replacement.peerId)).toBe(0);
				expect(score(active.peerId)).toBe(0.2);
			},
			{ timeout: 5_000 }
		);
		await node.stop();
		expect(score(active.peerId)).toBe(0);
		await node.start();
		await node.retryRelayPolicyAcquisition();
		const restartedView = node as unknown as T4NodeView;
		const restartedScore = restartedView._pubsub?.score.params.appSpecificScore;
		if (restartedScore === undefined) throw new Error("expected restarted score closure");
		expect(restartedScore(active.peerId), "T4_RESTART_RECONCILIATION_ABSENT").toBe(0.2);
		expect(restartedView.getPeerSelectionSnapshot()).toMatchObject({ priority: 1, prioritySlots: 1 });
		await node.stop();
		expect(restartedScore(active.peerId)).toBe(0);
	}, 30_000);

	test("rejects an impossible priority tail before host construction", async () => {
		const hostFactory = vi.fn<DRPNetworkHostFactory>((context) => context.createHost());
		const node = new DRPNetworkNode(config(4, 3, undefined, 2), {
			hostFactory,
			hostPolicy: quietPolicy,
			relayPolicyFactory: (): RelayPolicyDriver => relayDriver(),
		});
		running.push(node);

		await expect(node.start(), "T4_PRIORITY_BUDGET_VALIDATION_ABSENT").rejects.toThrow();
		expect(hostFactory).not.toHaveBeenCalled();
	});

	test("rejects a priority tail that consumes every non-parallel connection before host construction", async () => {
		const hostFactory = vi.fn<DRPNetworkHostFactory>((context) => context.createHost());
		const node = new DRPNetworkNode(config(4, 1, undefined, 4), {
			hostFactory,
			hostPolicy: quietPolicy,
			relayPolicyFactory: (): RelayPolicyDriver => relayDriver(),
		});
		running.push(node);

		await expect(node.start(), "T4_PRIORITY_BUDGET_VALIDATION_ABSENT").rejects.toThrow();
		expect(hostFactory).not.toHaveBeenCalled();
	});

	test("accepts the exact upper target boundary when capacity can reserve it", async () => {
		const node = new DRPNetworkNode(config(16, 8, undefined, 8), {
			hostPolicy: quietPolicy,
			relayPolicyFactory: (): RelayPolicyDriver => relayDriver(relayResult([])),
		});
		running.push(node);
		await node.start();
		expect((node as unknown as T4NodeView).getPeerSelectionSnapshot()).toMatchObject({ prioritySlots: 8 });
	});
});
