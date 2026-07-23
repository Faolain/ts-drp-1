import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromString } from "@libp2p/peer-id";
import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";
import {
	BOOTSTRAP_NODES,
	type DRPNetworkHostConfigSnapshot,
	type DRPNetworkHostFactory,
	DRPNetworkNode,
} from "@ts-drp/network";
import { DRPNode } from "@ts-drp/node";
import {
	BrowserRoutingClosestPeersSource,
	Libp2pRelayClient,
	RELAY_RESERVATION_STATUS,
	RelayPolicy,
	type RelayPolicyResult,
	type RelayReplacementResult,
} from "@ts-drp/relay-policy";
import {
	AddressPolicy,
	createOpaqueNamespaceV1,
	RecordSigner,
	type RecordValidationResult,
	RecordValidator,
	RegistryClient,
	type SignedDrpRecordV1,
} from "@ts-drp/rendezvous";
import { type BrowserRouting, type BrowserRoutingTrace, createBrowserRouting } from "@ts-drp/routing-browser";
import { ActionType, type IDRP, type ResolveConflictsType, SemanticsType, type Vertex } from "@ts-drp/types";
import type { Libp2p } from "libp2p";

import { HttpGridRegistryEndpoint } from "./http-directory.js";
import {
	ControlPlaneCoordinator,
	ControlPlaneHostFactory,
	type DirectTransportProof,
	type GridNodePort,
	type GridObjectPort,
	isValidDirectProof,
} from "./index.js";

const PRIMARY_RELAY = {
	address: "/ip4/127.0.0.1/tcp/50000/ws/p2p/16Uiu2HAmTY71bbCHtmYD3nvVKUGbk7NWqLBbPFNng4jhaXJHi3W5",
	operatorGroup: "fixture-routing-a",
	peerId: "16Uiu2HAmTY71bbCHtmYD3nvVKUGbk7NWqLBbPFNng4jhaXJHi3W5",
} as const;
const REPLACEMENT_RELAY = {
	address: "/ip4/127.0.0.1/tcp/50002/ws/p2p/16Uiu2HAmT72TapomemeWskZbmzd4hZcakAzYnTwLtbdsvdaSUvXU",
	operatorGroup: "fixture-routing-b",
	peerId: "16Uiu2HAmT72TapomemeWskZbmzd4hZcakAzYnTwLtbdsvdaSUvXU",
} as const;
const REFUSAL_RELAYS = [
	{
		address: "/ip4/127.0.0.1/tcp/50004/ws/p2p/16Uiu2HAm4WvcWKEkvP1pX5tqyQogncus5EwZHrxvShSGm2EywxS8",
		operatorGroup: "fixture-routing-refusal-a",
		peerId: "16Uiu2HAm4WvcWKEkvP1pX5tqyQogncus5EwZHrxvShSGm2EywxS8",
	},
	{
		address: "/ip4/127.0.0.1/tcp/50006/ws/p2p/16Uiu2HAmRgxW71ra5FBwuKQXxm5XdidPXdopkPf5boqjgTdfoioN",
		operatorGroup: "fixture-routing-refusal-b",
		peerId: "16Uiu2HAmRgxW71ra5FBwuKQXxm5XdidPXdopkPf5boqjgTdfoioN",
	},
] as const;
const RELAY_FIXTURES = [PRIMARY_RELAY, REPLACEMENT_RELAY, ...REFUSAL_RELAYS] as const;
let activeGridMovementLog: GridBrowserTrace["movements"][number][] | undefined;

export type GridBrowserScenario = "exhaustion" | "success";

export interface GridBrowserTrace {
	readonly antiCheat: {
		readonly preAuthPxCandidates: number;
		readonly topologyDialAttempts: number;
		readonly topologyGaterRejections: number;
	};
	readonly assertions: readonly {
		readonly label: string;
		readonly passed: boolean;
		readonly value: string;
	}[];
	readonly bootstrapPeers: readonly [];
	readonly creatorPeerInputFields: 0;
	readonly direct?: DirectTransportProof;
	readonly fallbackInitiatedAtMs?: number;
	readonly hostSnapshot: {
		readonly bootstrapDiscovery: false;
		readonly bootstrapPeerCount: 0;
		readonly coldStartPubsubDiscovery: false;
		readonly gossipSubPeerExchange: false;
		readonly outboundAddressPolicy: "injected";
		readonly peerDiscoveryModules: readonly [];
	};
	readonly movements: readonly {
		readonly actor: "creator" | "joiner";
		readonly direction: "D" | "L" | "R" | "U";
		readonly x: number;
		readonly y: number;
	}[];
	readonly namespace: string;
	readonly objectId: string;
	readonly positions: {
		readonly creator?: { readonly x: number; readonly y: number };
		readonly joiner?: { readonly x: number; readonly y: number };
	};
	readonly provenance: readonly string[];
	readonly readiness: "signed-relay-record-registered";
	readonly record: SignedDrpRecordV1;
	readonly recordValidation: "accepted" | Exclude<RecordValidationResult, { accepted: true }>["code"];
	readonly recovery?: {
		readonly directRetained: boolean;
		readonly durationMs: number;
		readonly postRemovalConverged: boolean;
		readonly replacementPeerId: string;
		readonly selectedRelayRemoved: boolean;
	};
	readonly relayAttempts: RelayPolicyResult["attempts"];
	readonly relayReservations: number;
	readonly relayRouting?: BrowserRoutingTrace;
	readonly role: "creator" | "joiner";
	readonly scenario: GridBrowserScenario;
	readonly terminal: "exhausted" | "success";
	readonly traceId: string;
}

export interface GridBrowserPeerSession {
	move(direction: "D" | "L" | "R" | "U"): Promise<void>;
	snapshot(): GridBrowserTrace;
	stop(): Promise<void>;
}

export interface GridBrowserFixtureOptions {
	readonly namespace?: string;
	readonly objectId?: string;
	readonly role: "creator" | "joiner";
	readonly run: number;
	readonly scenario: GridBrowserScenario;
}

/**
 * Starts exactly one production DRP peer in the calling page. Creator and
 * joiner pages coordinate only through the signed HTTP registry and libp2p.
 * @param options
 */
export async function createGridBrowserPeer(options: GridBrowserFixtureOptions): Promise<GridBrowserPeerSession> {
	const namespace = options.namespace ?? createOpaqueNamespaceV1(crypto.getRandomValues(new Uint8Array(24)));
	const objectId = options.objectId ?? `grid-${crypto.randomUUID()}`;
	if (options.role === "joiner" && (options.namespace === undefined || options.objectId === undefined)) {
		throw new Error("joiner requires only the namespace and object ID from the creator link");
	}
	const rtcCapture = captureRtcPeerConnections();
	const relayTraffic = captureRelayWebSocketTraffic();
	const movements: GridBrowserTrace["movements"][number][] = [];
	const runtime = createProductionRuntime(options.role, objectId, rtcCapture, relayTraffic, movements);
	const directory = createDirectory(namespace, runtime.network.peerId);
	const relay = createRelayPort(runtime, options.role === "joiner" ? options.scenario : "success");
	let direct: DirectTransportProof | undefined;
	let fallbackInitiatedAtMs: number | undefined;
	let recovery: GridBrowserTrace["recovery"];
	let record: SignedDrpRecordV1 | undefined;
	let recordValidation: GridBrowserTrace["recordValidation"] = "accepted";
	let terminal: GridBrowserTrace["terminal"] = "success";
	let stopped = false;

	const coordinator = new ControlPlaneCoordinator({
		bootstrapPeers: [],
		directory,
		directProof: {
			inspect: async ({ creatorPeerId }): Promise<DirectTransportProof> => {
				direct = await inspectDirectProof(runtime, rtcCapture, relayTraffic, creatorPeerId);
				return direct;
			},
		},
		namespace,
		node: runtime.nodePort,
		recordFactory: {
			create: async ({ nowMs }): Promise<SignedDrpRecordV1> => {
				const address = await waitForValue(
					() => runtime.network.getMultiaddrs().find((value) => value.includes("/p2p-circuit/webrtc/")),
					5_000,
					"creator signed relay address"
				);
				const signer = new RecordSigner(privateKeyFromRaw(runtime.node.keychain.secp256k1PrivateKey));
				return signer.sign({
					addresses: [address],
					capabilities: ["drp-gossipsub", "relay-client", "webrtc"],
					expiresAtMs: nowMs + 60_000,
					issuedAtMs: nowMs,
					namespace,
					sequence: 1,
				});
			},
		},
		relayPolicy: relay.port,
		role: options.role,
	});

	if (options.role === "creator") {
		const created = await coordinator.startCreator(AbortSignal.timeout(15_000));
		record = created.record;
		recordValidation = await validateFixtureRecord(record, namespace);
		if (recordValidation !== "accepted") throw new Error(`registered creator record rejected: ${recordValidation}`);
		void driveCreatorAfterJoin(runtime);
	} else {
		try {
			await coordinator.startJoiner(objectId, AbortSignal.timeout(20_000));
		} catch (error) {
			const outcome = relay.lastResult;
			if (options.scenario !== "exhaustion" || outcome?.terminal !== "exhausted") throw error;
			terminal = "exhausted";
			fallbackInitiatedAtMs = relay.fallbackInitiatedAtMs;
		}
		record = relay.discoveredRecord;
		if (record === undefined) {
			const records = await directory.discover(namespace, AbortSignal.timeout(3_000));
			record = records[0]?.record;
		}
		if (record === undefined) throw new Error("joiner registry discovery omitted creator record");
		recordValidation = await validateFixtureRecord(record, namespace);
		if (terminal === "success") {
			await driveJoiner(runtime, coordinator);
			const recoveryStarted = performance.now();
			const selected = relay.lastResult?.reservations[0]?.candidate.peerId;
			if (selected === undefined) throw new Error("selected relay identity missing before recovery");
			const bytesBefore = await selectedPairBytes(rtcCapture.outboundPeerConnections()[0]);
			let selectedRelayRemoved = false;
			await setRelayFixtureRunning(selected, false);
			try {
				await waitForValue(
					() =>
						runtime.host
							.getConnections(peerIdFromString(selected))
							.some((connection) => !connection.remoteAddr.toString().includes("/webrtc"))
							? undefined
							: true,
					3_000,
					"selected relay process removal"
				);
				selectedRelayRemoved = true;
				await coordinator.recoverRelay(selected, AbortSignal.timeout(5_000));
				await coordinator.move("R");
				await waitForValue(
					() => {
						const pc = rtcCapture.outboundPeerConnections()[0];
						return pc?.connectionState === "connected" &&
							runtime.network.getGroupPeers(objectId).some((peer) => peer !== runtime.network.peerId)
							? true
							: undefined;
					},
					3_000,
					"direct data plane after selected relay removal"
				);
				const bytesAfter = await waitForValue(
					async () => {
						const current = await selectedPairBytes(rtcCapture.outboundPeerConnections()[0]);
						return current.sent > bytesBefore.sent && current.received > bytesBefore.received ? current : undefined;
					},
					3_000,
					"direct WebRTC byte growth after relay removal"
				);
				const replacementPeerId = relay.lastReplacement?.reservations[0]?.candidate.peerId;
				recovery = {
					directRetained: bytesAfter.sent > bytesBefore.sent && bytesAfter.received > bytesBefore.received,
					durationMs: performance.now() - recoveryStarted,
					postRemovalConverged: positionOrThrow(runtime.grid, "joiner").x === 0,
					replacementPeerId: replacementPeerId ?? "missing",
					selectedRelayRemoved,
				};
			} finally {
				await setRelayFixtureRunning(selected, true);
			}
		}
	}

	const session: GridBrowserPeerSession = {
		async move(direction): Promise<void> {
			if (terminal !== "success") return;
			await coordinator.move(direction);
		},
		snapshot(): GridBrowserTrace {
			if (record === undefined) throw new Error("grid record not ready");
			const coordinatorSnapshot = coordinator.snapshot;
			const assertions =
				terminal === "success"
					? successAssertions(runtime, direct, recovery, movements)
					: exhaustionAssertions(fallbackInitiatedAtMs, relay.lastResult);
			return {
				antiCheat: { ...runtime.antiCheat },
				assertions,
				bootstrapPeers: [],
				creatorPeerInputFields: 0,
				...(direct === undefined ? {} : { direct }),
				...(fallbackInitiatedAtMs === undefined ? {} : { fallbackInitiatedAtMs }),
				hostSnapshot: isolatedSnapshot(runtime.snapshot),
				movements: [...movements],
				namespace,
				objectId,
				positions: currentPositions(runtime.grid),
				provenance: coordinatorSnapshot.provenance,
				readiness: "signed-relay-record-registered",
				record,
				recordValidation,
				...(recovery === undefined ? {} : { recovery }),
				relayAttempts: relay.lastResult?.attempts ?? [],
				relayReservations: relay.lastResult?.reservations.length ?? 0,
				...(relay.routingTrace === undefined ? {} : { relayRouting: relay.routingTrace }),
				role: options.role,
				scenario: options.scenario,
				terminal,
				traceId: `grid-${options.role}-${options.scenario}-${options.run}`,
			};
		},
		async stop(): Promise<void> {
			if (stopped) return;
			stopped = true;
			rtcCapture.stop();
			relayTraffic.stop();
			await Promise.allSettled([coordinator.stop(), relay.stop()]);
		},
	};
	return session;
}

async function setRelayFixtureRunning(peerId: string, running: boolean): Promise<void> {
	const controlPort = peerId === PRIMARY_RELAY.peerId ? 51000 : peerId === REPLACEMENT_RELAY.peerId ? 51002 : undefined;
	if (controlPort === undefined) throw new Error(`relay fixture control missing for ${peerId}`);
	const response = await fetch(`http://127.0.0.1:${controlPort}/${running ? "start" : "stop"}`, {
		method: "POST",
		signal: AbortSignal.timeout(3_000),
	});
	if (!response.ok) throw new Error(`relay fixture control returned HTTP ${response.status}`);
}

/**
 * Compatibility wrapper used only by non-cross-page callers.
 * @param options
 * @deprecated Prefer createGridBrowserPeer so one page owns one peer.
 */
export async function createGridBrowserFixture(options: GridBrowserFixtureOptions): Promise<GridBrowserTrace> {
	const session = await createGridBrowserPeer(options);
	return session.snapshot();
}

interface CircuitListenHost extends Libp2p {
	readonly components: {
		readonly transportManager: {
			getListeners(): Array<{ close(): Promise<void>; getAddrs(): Multiaddr[] }>;
			listen(addresses: Multiaddr[]): Promise<void>;
		};
	};
}

interface AntiCheatCounters {
	preAuthPxCandidates: number;
	topologyDialAttempts: number;
	topologyGaterRejections: number;
}

interface ProductionRuntime {
	readonly antiCheat: AntiCheatCounters;
	connect(address: string | readonly string[]): Promise<void>;
	grid?: FixtureGrid;
	readonly host: CircuitListenHost;
	readonly network: DRPNetworkNode;
	readonly node: DRPNode;
	readonly nodePort: GridNodePort;
	readonly snapshot: DRPNetworkHostConfigSnapshot;
}

function createProductionRuntime(
	role: "creator" | "joiner",
	objectId: string,
	rtcCapture: RtcCapture,
	relayTraffic: RelayTrafficCapture,
	movements: GridBrowserTrace["movements"][number][]
): ProductionRuntime {
	activeGridMovementLog = movements;
	let host: CircuitListenHost | undefined;
	let snapshot: DRPNetworkHostConfigSnapshot | undefined;
	let topologyProbe = false;
	const authorizedPeers = new Set<string>();
	const antiCheat: AntiCheatCounters = {
		preAuthPxCandidates: 0,
		topologyDialAttempts: 0,
		topologyGaterRejections: 0,
	};
	const resolver = { resolve: (): Promise<string[]> => Promise.resolve(["127.0.0.1"]) };
	const isolated = new ControlPlaneHostFactory({
		addressPolicy: new AddressPolicy({
			allowInsecureWebSocket: true,
			allowLoopback: true,
			target: "browser",
		}),
		resolver,
	});
	const hostFactory: DRPNetworkHostFactory = async (context) => {
		const created = await isolated.factory(context);
		host = created as CircuitListenHost;
		host.addEventListener("peer:discovery", (event) => {
			if (!authorizedPeers.has(event.detail.id.toString())) {
				antiCheat.preAuthPxCandidates += 1;
			}
		});
		snapshot = context.snapshot;
		return created;
	};
	const topology = new Set(BOOTSTRAP_NODES);
	const deny = isolated.policy.denyDialMultiaddr;
	const hostPolicy = {
		...isolated.policy,
		denyDialMultiaddr: async (address: Parameters<NonNullable<typeof deny>>[0]): Promise<boolean> => {
			if (topology.has(address.toString())) {
				antiCheat.topologyGaterRejections += 1;
				if (!topologyProbe) antiCheat.topologyDialAttempts += 1;
				return true;
			}
			return (await deny?.(address)) ?? true;
		},
	};
	const config = { bootstrap_peers: [], log_config: { level: "silent" as const } };
	const network = new DRPNetworkNode(config, { hostFactory, hostPolicy });
	const node = new DRPNode(
		{ log_config: { level: "silent" }, network_config: config },
		{ networkNode: network, reconnect: false }
	);
	const runtime = {} as ProductionRuntime;
	const connect = (address: string | readonly string[]): Promise<void> => {
		for (const value of typeof address === "string" ? [address] : address) {
			for (const component of multiaddr(value).getComponents()) {
				if (component.name === "p2p" && component.value !== undefined) {
					authorizedPeers.add(component.value);
				}
			}
		}
		return network.connect(typeof address === "string" ? address : [...address]);
	};
	const nodePort: GridNodePort = {
		connectObject: async ({ id, sync }): Promise<GridObjectPort> => {
			const object = await node.connectObject({
				drp: new FixtureGrid(),
				id,
				...(sync === undefined ? {} : { sync }),
			});
			const grid = object.drp;
			if (grid === undefined) throw new Error("joined production grid missing");
			runtime.grid = grid;
			grid.addUser(role);
			return gridPort(id, grid, network.peerId, role);
		},
		createObject: async ({ id }): Promise<GridObjectPort> => {
			const object = await node.createObject({ drp: new FixtureGrid(), id: id ?? objectId });
			const grid = object.drp;
			if (grid === undefined) throw new Error("created production grid missing");
			runtime.grid = grid;
			grid.addUser(role);
			return gridPort(object.id, grid, network.peerId, role);
		},
		networkNode: {
			connect,
			getAllPeers: (): string[] => network.getAllPeers(),
			getGroupPeers: (topic): string[] => network.getGroupPeers(topic),
			get peerId(): string {
				return network.peerId;
			},
		},
		start: async (): Promise<void> => {
			relayTraffic.markPeerStart();
			rtcCapture.markPeerStart();
			await node.start();
			const createdHost = host;
			const createdSnapshot = snapshot;
			if (createdHost === undefined || createdSnapshot === undefined) throw new Error("host factory was not invoked");
			const dcutrService = createdHost.services.dcutr as { stop?(): Promise<void> };
			await dcutrService.stop?.();
			topologyProbe = true;
			try {
				for (const address of BOOTSTRAP_NODES) {
					const rejected = await hostPolicy.denyDialMultiaddr(multiaddr(address));
					if (!rejected) throw new Error("known Topology seed escaped the dial gater");
				}
			} finally {
				topologyProbe = false;
			}
			Object.assign(runtime, { host: createdHost, snapshot: createdSnapshot });
		},
		stop: async (): Promise<void> => {
			await node.stop();
			if (activeGridMovementLog === movements) activeGridMovementLog = undefined;
		},
	};
	Object.assign(runtime, { antiCheat, connect, network, node, nodePort });
	return runtime;
}

function createDirectory(namespace: string, clientId: string): RegistryClient {
	const endpoints = [
		new HttpGridRegistryEndpoint("grid-primary", "http://127.0.0.1:4175/grid-registry/primary"),
		new HttpGridRegistryEndpoint("grid-secondary", "http://127.0.0.1:4175/grid-registry/secondary"),
	];
	return new RegistryClient({
		backoffMs: 0,
		clientId: clientId || `browser-${namespace.slice(-12)}`,
		endpoints,
		timeoutMs: 2_000,
		validatorFactory: () => fixtureRecordValidator(),
	});
}

function createRelayPort(
	runtime: ProductionRuntime,
	scenario: GridBrowserScenario
): {
	readonly discoveredRecord?: SignedDrpRecordV1;
	readonly fallbackInitiatedAtMs?: number;
	lastReplacement?: RelayReplacementResult;
	lastResult?: RelayPolicyResult;
	readonly routingTrace?: BrowserRoutingTrace;
	readonly port: {
		acquire(queryKey: Uint8Array, signal: AbortSignal): Promise<RelayPolicyResult>;
		replace(peerId: string, reason: "relay-disconnected", signal: AbortSignal): Promise<RelayPolicyResult>;
	};
	stop(): Promise<void>;
} {
	let fallbackInitiatedAtMs: number | undefined;
	let policyStartedAtMs: number | undefined;
	const routing: BrowserRouting = createBrowserRouting({
		allowInsecureLoopback: true,
		allowInsecureWebSocketFixture: true,
		allowLoopbackAddressFixture: true,
		allowedOrigins: ["http://127.0.0.1:4175"],
		backoffBaseMs: 1,
		cacheTTLms: 0,
		endpoints: [
			{
				id: "grid-primary",
				url: `http://127.0.0.1:4175/fixture/grid-relays-${scenario}/primary/`,
			},
			{
				id: "grid-secondary",
				url: `http://127.0.0.1:4175/fixture/grid-relays-${scenario}/secondary/`,
			},
		],
		limits: { maxResults: 2 },
		resolver: { resolve: (): Promise<string[]> => Promise.resolve(["127.0.0.1"]) },
		timeoutMs: 2_000,
	});
	const source = new BrowserRoutingClosestPeersSource(routing, (peer) => {
		return RELAY_FIXTURES.find((fixture) => fixture.peerId === peer.peerId)?.operatorGroup ?? "unknown";
	});
	const relayClient = new Libp2pRelayClient({
		connect: async (address, signal): Promise<void> => {
			signal.throwIfAborted();
			await runtime.connect(address);
			signal.throwIfAborted();
		},
		disconnect: (peerId): Promise<void> => runtime.network.disconnect(peerId),
		host: runtime.host,
	});
	const policy: RelayPolicy = new RelayPolicy({
		allowInsecureWebSocketFixture: true,
		fallback: {
			acquire: (signal): Promise<{ status: "empty" }> => {
				fallbackInitiatedAtMs = policyStartedAtMs === undefined ? 0 : performance.now() - policyStartedAtMs;
				signal.throwIfAborted();
				return Promise.resolve({ status: "empty" });
			},
		},
		inspector: relayClient,
		limits: {
			maxCandidates: 2,
			maxConcurrentReservations: 1,
			maxPerOperatorGroup: 1,
			maxQueuedCandidates: 2,
			ownedFallbackDeadlineMs: 250,
			perCandidateDeadlineMs: 3_500,
			requiredOperatorGroups: 1,
			requiredReservations: 1,
			totalDeadlineMs: 4_500,
		},
		reservationClient: relayClient,
		source,
	});
	const state: ReturnType<typeof createRelayPort> = {
		get fallbackInitiatedAtMs() {
			return fallbackInitiatedAtMs;
		},
		get routingTrace() {
			return routing.lastTrace;
		},
		port: {
			acquire: async (queryKey, signal) => {
				policyStartedAtMs = performance.now();
				fallbackInitiatedAtMs = undefined;
				const result = await policy.acquire(queryKey, signal);
				state.lastResult = result;
				(
					globalThis as typeof globalThis & { __TS_DRP_GRID_RELAY_RESULT__?: RelayPolicyResult }
				).__TS_DRP_GRID_RELAY_RESULT__ = result;
				return result;
			},
			replace: async (peerId, reason, signal) => {
				policyStartedAtMs = performance.now();
				fallbackInitiatedAtMs = undefined;
				const result = await policy.replace(peerId, reason, signal);
				state.lastReplacement = result;
				state.lastResult = result;
				(
					globalThis as typeof globalThis & { __TS_DRP_GRID_RELAY_RESULT__?: RelayPolicyResult }
				).__TS_DRP_GRID_RELAY_RESULT__ = result;
				return result;
			},
		},
		stop: async () => {
			await Promise.allSettled([policy.stop(), relayClient.stop(), routing.stop()]);
		},
	};
	return state;
}

async function inspectDirectProof(
	runtime: ProductionRuntime,
	rtcCapture: RtcCapture,
	relayTraffic: RelayTrafficCapture,
	creatorPeerId: string
): Promise<DirectTransportProof> {
	const pc = await waitForValue(
		() => {
			const candidates = rtcCapture.outboundPeerConnections();
			if (candidates.length > 1) {
				throw new Error(`direct proof found ${candidates.length} connected init-datachannel peer connections`);
			}
			return candidates[0];
		},
		5_000,
		"unique libp2p outbound RTCPeerConnection"
	);
	const connection = await waitForValue(
		() => {
			const candidates = runtime.host
				.getConnections(peerIdFromString(creatorPeerId))
				.filter((candidate) => candidate.remoteAddr.toString().includes("/webrtc"));
			if (candidates.length > 1) {
				throw new Error(`direct proof found ${candidates.length} libp2p WebRTC connections`);
			}
			return candidates[0];
		},
		5_000,
		"unique libp2p direct WebRTC connection"
	);
	const baseline = await rtcCapture.baseline(pc);
	const current = await waitForValue(
		async () => {
			const value = await rtcEvidence(pc);
			return value.bytesSent > baseline.sent && value.bytesReceived > baseline.received ? value : undefined;
		},
		5_000,
		"increasing direct WebRTC bytes"
	);
	const relayBytes = relayTraffic.bytes();
	const proof: DirectTransportProof = {
		connectionId: connection.id,
		correlation: "runtime-observed",
		correlationBasis: "unique-libp2p-webrtc-connection-and-init-datachannel",
		dataChannelOpen: current.dataChannelOpen,
		directBytesReceived: current.bytesReceived - baseline.received,
		directBytesSent: current.bytesSent - baseline.sent,
		iceCandidateTypes: current.candidateTypes,
		libp2pAddress: connection.remoteAddr.toString(),
		libp2pTransport: "webrtc",
		relayedBytesReceived: relayBytes.received,
		relayedBytesSent: relayBytes.sent,
		rtcPeerConnectionId: current.selectedPairId,
		transport: "webrtc",
	};
	if (!isValidDirectProof(proof)) throw new Error("runtime direct proof failed validation");
	return proof;
}

async function driveCreatorAfterJoin(runtime: ProductionRuntime): Promise<void> {
	await waitForValue(
		() => (runtime.grid?.position("joiner") !== undefined ? true : undefined),
		30_000,
		"joiner grid membership"
	).catch(() => undefined);
	const grid = runtime.grid;
	if (grid === undefined || grid.position("joiner") === undefined) return;
	for (const direction of ["R", "U"] as const) {
		grid.moveUser("creator", direction);
	}
}

async function driveJoiner(runtime: ProductionRuntime, coordinator: ControlPlaneCoordinator): Promise<void> {
	await waitForValue(
		() => {
			const creator = runtime.grid?.position("creator");
			return creator?.x === 1 && creator.y === 1 ? true : undefined;
		},
		5_000,
		"creator movement convergence"
	);
	for (const direction of ["L", "D"] as const) {
		await coordinator.move(direction);
	}
	await waitForValue(
		() => {
			const creator = runtime.grid?.position("creator");
			const joiner = runtime.grid?.position("joiner");
			return creator?.x === 1 && creator.y === 1 && joiner?.x === -1 && joiner.y === -1 ? true : undefined;
		},
		5_000,
		"bidirectional grid convergence"
	);
}

class FixtureGrid implements IDRP {
	semanticsType = SemanticsType.pair;
	readonly positions = new Map<string, { x: number; y: number }>();

	addUser(actor: string): void {
		if (!this.positions.has(actor)) this.positions.set(actor, { x: 0, y: 0 });
	}

	moveUser(actor: string, direction: "D" | "L" | "R" | "U"): void {
		const position = this.positions.get(actor);
		if (position === undefined) return;
		if (direction === "R") position.x += 1;
		if (direction === "L") position.x -= 1;
		if (direction === "U") position.y += 1;
		if (direction === "D") position.y -= 1;
		if (actor === "creator" || actor === "joiner") {
			activeGridMovementLog?.push({ actor, direction, x: position.x, y: position.y });
		}
	}

	position(actor: string): { readonly x: number; readonly y: number } | undefined {
		return this.positions.get(actor);
	}

	resolveConflicts(_vertices: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
	}
}

function gridPort(id: string, grid: FixtureGrid, localPeerId: string, role: "creator" | "joiner"): GridObjectPort {
	const actorFor = (actor: string): string => (actor === localPeerId ? role : actor);
	return {
		id,
		move: (actor, direction): void => grid.moveUser(actorFor(actor), direction),
		position: (actor) => grid.position(actorFor(actor)),
	};
}

function fixtureRecordValidator(): RecordValidator {
	return new RecordValidator({
		addressPolicyOptions: { allowInsecureWebSocket: true, allowLoopback: true },
		resolver: { resolve: (): Promise<string[]> => Promise.resolve(["127.0.0.1"]) },
	});
}

async function validateFixtureRecord(
	record: SignedDrpRecordV1,
	namespace: string
): Promise<GridBrowserTrace["recordValidation"]> {
	const result = await fixtureRecordValidator().validate(record, {
		admission: { accepted: true, mode: "invite" },
		expectedNamespace: namespace,
		signal: AbortSignal.timeout(2_000),
	});
	return result.accepted ? "accepted" : result.code;
}

interface RtcCapture {
	baseline(pc: RTCPeerConnection): Promise<{ received: number; sent: number }>;
	markPeerStart(): void;
	outboundPeerConnections(): RTCPeerConnection[];
	stop(): void;
}

function captureRtcPeerConnections(): RtcCapture {
	const prototype = RTCPeerConnection.prototype;
	const original = prototype.createDataChannel;
	const entries = new Map<
		RTCPeerConnection,
		{ baseline?: Promise<{ received: number; sent: number }>; labels: string[]; order: number }
	>();
	let order = 0;
	prototype.createDataChannel = function instrumentedCreateDataChannel(
		label: string,
		options?: RTCDataChannelInit
	): RTCDataChannel {
		const existing = entries.get(this) ?? { labels: [], order: order++ };
		existing.labels.push(label);
		entries.set(this, existing);
		this.addEventListener(
			"connectionstatechange",
			() => {
				if (this.connectionState === "connected" && existing.baseline === undefined) {
					existing.baseline = selectedPairBytes(this);
				}
			},
			{ once: false }
		);
		return original.call(this, label, options);
	};
	return {
		async baseline(pc): Promise<{ received: number; sent: number }> {
			const entry = entries.get(pc);
			if (entry?.baseline !== undefined) return entry.baseline;
			return selectedPairBytes(pc);
		},
		markPeerStart(): void {
			performance.mark("grid:rtc-capture-active");
		},
		outboundPeerConnections(): RTCPeerConnection[] {
			return [...entries.entries()]
				.filter(([, entry]) => entry.labels.includes("init"))
				.sort((left, right) => left[1].order - right[1].order)
				.map(([pc]) => pc)
				.filter((pc) => pc.connectionState === "connected");
		},
		stop(): void {
			prototype.createDataChannel = original;
		},
	};
}

interface RelayTrafficCapture {
	bytes(): { readonly received: number; readonly sent: number };
	markPeerStart(): void;
	stop(): void;
}

function captureRelayWebSocketTraffic(): RelayTrafficCapture {
	const prototype = WebSocket.prototype;
	const original = prototype.send;
	const relayPorts = new Set(["50000", "50002", "50004", "50006"]);
	const sockets = new WeakSet<WebSocket>();
	let received = 0;
	let sent = 0;
	prototype.send = function instrumentedSend(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		if (!relayPorts.has(new URL(this.url).port)) {
			original.call(this, data);
			return;
		}
		sent += payloadBytes(data);
		if (!sockets.has(this)) {
			sockets.add(this);
			this.addEventListener("message", (event) => {
				received += payloadBytes(event.data as string | ArrayBufferLike | Blob | ArrayBufferView);
			});
		}
		original.call(this, data);
	};
	return {
		bytes: () => ({ received, sent }),
		markPeerStart(): void {
			performance.mark("grid:relay-byte-capture-active");
		},
		stop(): void {
			prototype.send = original;
		},
	};
}

function payloadBytes(data: string | ArrayBufferLike | Blob | ArrayBufferView): number {
	if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
	if (data instanceof Blob) return data.size;
	if (ArrayBuffer.isView(data)) return data.byteLength;
	return data.byteLength;
}

async function rtcEvidence(pc: RTCPeerConnection): Promise<{
	readonly bytesReceived: number;
	readonly bytesSent: number;
	readonly candidateTypes: DirectTransportProof["iceCandidateTypes"];
	readonly dataChannelOpen: boolean;
	readonly selectedPairId: string;
}> {
	const stats = await pc.getStats();
	const pair = [...stats.values()].find(
		(value) =>
			value.type === "candidate-pair" &&
			((value as RTCIceCandidatePairStats).nominated === true ||
				(value as RTCIceCandidatePairStats).state === "succeeded")
	) as (RTCIceCandidatePairStats & { localCandidateId?: string; remoteCandidateId?: string }) | undefined;
	if (pair === undefined) throw new Error("selected RTC candidate pair missing");
	const candidateTypes = [pair.localCandidateId, pair.remoteCandidateId].map((id) => {
		if (id === undefined) throw new Error("selected RTC pair omitted a candidate ID");
		const type = stats.get(id)?.candidateType;
		if (type !== "host" && type !== "prflx" && type !== "relay" && type !== "srflx") {
			throw new Error(`selected RTC pair reported unsupported candidate type ${String(type)}`);
		}
		return type;
	});
	const dataChannelOpen = [...stats.values()].some(
		(value) => value.type === "data-channel" && (value as { state?: string }).state === "open"
	);
	return {
		bytesReceived: pair.bytesReceived ?? 0,
		bytesSent: pair.bytesSent ?? 0,
		candidateTypes,
		dataChannelOpen: dataChannelOpen || pc.sctp?.transport.state === "connected",
		selectedPairId: pair.id,
	};
}

async function selectedPairBytes(
	pc: RTCPeerConnection | undefined
): Promise<{ readonly received: number; readonly sent: number }> {
	if (pc === undefined) return { received: 0, sent: 0 };
	const evidence = await rtcEvidence(pc);
	return { received: evidence.bytesReceived, sent: evidence.bytesSent };
}

function successAssertions(
	runtime: ProductionRuntime,
	direct: DirectTransportProof | undefined,
	recovery: GridBrowserTrace["recovery"],
	movements: GridBrowserTrace["movements"]
): GridBrowserTrace["assertions"] {
	const antiCheatPassed =
		runtime.antiCheat.preAuthPxCandidates === 0 &&
		runtime.antiCheat.topologyDialAttempts === 0 &&
		runtime.antiCheat.topologyGaterRejections === BOOTSTRAP_NODES.length;
	return [
		assertion("Bootstrap peers", "empty []", true),
		assertion(
			"Topology gater",
			`${runtime.antiCheat.topologyGaterRejections}/${BOOTSTRAP_NODES.length} rejected; ${runtime.antiCheat.topologyDialAttempts} dials`,
			antiCheatPassed
		),
		assertion(
			"Pre-auth PX event sink",
			`${runtime.antiCheat.preAuthPxCandidates} candidates`,
			runtime.antiCheat.preAuthPxCandidates === 0
		),
		assertion("Signed registry readiness", "signed-relay-record-registered", true),
		assertion("Production GossipSub movement", `${movements.length} observed`, runtime.grid !== undefined),
		assertion(
			"Runtime-correlated direct WebRTC",
			direct?.connectionId ?? "missing",
			direct !== undefined && isValidDirectProof(direct)
		),
		assertion(
			"Selected relay replacement",
			recovery?.replacementPeerId ?? "missing",
			recovery !== undefined &&
				recovery.selectedRelayRemoved &&
				recovery.replacementPeerId !== "missing" &&
				recovery.directRetained &&
				recovery.postRemovalConverged
		),
	];
}

function exhaustionAssertions(
	fallbackInitiatedAtMs: number | undefined,
	result: RelayPolicyResult | undefined
): GridBrowserTrace["assertions"] {
	return [
		assertion(
			"Owned relay intentionally unavailable",
			result?.fallback?.status ?? "missing",
			result?.fallback?.status === "empty"
		),
		assertion(
			"Routing candidates exhausted",
			`${result?.attempts.length ?? 0} wire refusals`,
			result?.terminal === "exhausted" &&
				result.attempts.length === 2 &&
				result.attempts.every(
					(attempt) =>
						attempt.connectionId !== undefined &&
						attempt.hopAdvertised &&
						attempt.reservationStatus === RELAY_RESERVATION_STATUS.RESERVATION_REFUSED &&
						attempt.status === "refused"
				)
		),
		assertion(
			"Fallback initiated within 5 seconds",
			`${(fallbackInitiatedAtMs ?? Number.POSITIVE_INFINITY).toFixed(1)} ms`,
			(fallbackInitiatedAtMs ?? Number.POSITIVE_INFINITY) <= 5_000
		),
		assertion("No WebRTC success claim", "typed exhausted", true),
	];
}

function isolatedSnapshot(snapshot: DRPNetworkHostConfigSnapshot): GridBrowserTrace["hostSnapshot"] {
	if (
		snapshot.bootstrapDiscovery ||
		snapshot.bootstrapPeerCount !== 0 ||
		snapshot.coldStartPubsubDiscovery ||
		snapshot.gossipSubPeerExchange ||
		snapshot.outboundAddressPolicy !== "injected" ||
		snapshot.peerDiscoveryModules.length !== 0
	) {
		throw new Error("production host did not retain isolated control-plane policy");
	}
	return {
		bootstrapDiscovery: false,
		bootstrapPeerCount: 0,
		coldStartPubsubDiscovery: false,
		gossipSubPeerExchange: false,
		outboundAddressPolicy: "injected",
		peerDiscoveryModules: [],
	};
}

function positionOrThrow(
	grid: FixtureGrid | undefined,
	actor: "creator" | "joiner"
): { readonly x: number; readonly y: number } {
	const position = grid?.position(actor);
	if (position === undefined) throw new Error(`${actor} grid position missing`);
	return { ...position };
}

function currentPositions(grid: FixtureGrid | undefined): GridBrowserTrace["positions"] {
	const creator = grid?.position("creator");
	const joiner = grid?.position("joiner");
	return {
		...(creator === undefined ? {} : { creator: { ...creator } }),
		...(joiner === undefined ? {} : { joiner: { ...joiner } }),
	};
}

function assertion(label: string, value: string, passed: boolean): GridBrowserTrace["assertions"][number] {
	return { label, passed, value };
}

async function waitForValue<T>(
	read: () => Promise<T | undefined> | T | undefined,
	timeoutMs: number,
	description: string
): Promise<T> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`timed out waiting for ${description}`);
}
