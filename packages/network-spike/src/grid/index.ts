import type { Multiaddr } from "@multiformats/multiaddr";
import type { DRPNetworkHostConfigSnapshot, DRPNetworkHostFactory, DRPNetworkHostPolicy } from "@ts-drp/network";
import type { RelayPolicyResult } from "@ts-drp/relay-policy";
import type {
	AddressPolicy,
	RendezvousDirectory,
	Resolver,
	SignedDrpRecordV1,
	ValidatedDrpRecord,
} from "@ts-drp/rendezvous";

const encoder = new TextEncoder();

export type GridRole = "creator" | "joiner";
export type GridTerminal = "exhausted" | "owned-fallback" | "success";
export type GridPhase =
	| "idle"
	| "starting"
	| "discovering-relay"
	| "reserved"
	| "registered"
	| "discovering-creator"
	| "dialing-creator"
	| "mesh-ready"
	| "synced"
	| "direct"
	| "terminal";

export interface GridControlEvent {
	readonly atMs: number;
	readonly kind:
		| "host-started"
		| "relay-discovery"
		| "relay-reservation"
		| "registry-register"
		| "registry-discover"
		| "record-validated"
		| "creator-dial"
		| "mesh-ready"
		| "object-sync"
		| "movement"
		| "direct-proof"
		| "relay-recovery"
		| "terminal";
	readonly detail: string;
}

export interface DirectTransportProof {
	readonly connectionId: string;
	readonly correlation: "runtime-observed";
	readonly correlationBasis: "unique-libp2p-webrtc-connection-and-init-datachannel";
	readonly dataChannelOpen: boolean;
	readonly directBytesReceived: number;
	readonly directBytesSent: number;
	readonly iceCandidateTypes: readonly ("host" | "prflx" | "relay" | "srflx")[];
	readonly libp2pAddress: string;
	readonly libp2pTransport: "webrtc";
	readonly relayedBytesReceived: number;
	readonly relayedBytesSent: number;
	readonly rtcPeerConnectionId: string;
	readonly transport: "webrtc";
}

export interface GridObjectPort {
	readonly id: string;
	move(actor: string, direction: "D" | "L" | "R" | "U"): void | Promise<void>;
	position(actor: string): { readonly x: number; readonly y: number } | undefined;
}

export interface GridNetworkPort {
	peerId: string;
	connect(address: string | readonly string[]): Promise<void>;
	getAllPeers(): string[];
	getGroupPeers(topic: string): string[];
}

export interface GridNodePort {
	readonly networkNode: GridNetworkPort;
	createObject(options: { readonly id?: string }): Promise<GridObjectPort>;
	connectObject(options: {
		readonly id: string;
		readonly sync?: { readonly peerId?: string };
	}): Promise<GridObjectPort>;
	start(): Promise<void>;
	stop(): Promise<void>;
}

export interface GridRelayPolicyPort {
	acquire(queryKey: Uint8Array, signal: AbortSignal): Promise<RelayPolicyResult>;
	replace?(peerId: string, reason: "relay-disconnected", signal: AbortSignal): Promise<RelayPolicyResult>;
}

export interface GridRecordFactory {
	create(input: {
		readonly addresses: readonly string[];
		readonly namespace: string;
		readonly nowMs: number;
		readonly peerId: string;
	}): Promise<SignedDrpRecordV1>;
}

export interface DirectProofInspector {
	inspect(input: {
		readonly creatorPeerId: string;
		readonly objectId: string;
		readonly role: GridRole;
	}): Promise<DirectTransportProof>;
}

export interface GridCoordinatorOptions {
	readonly bootstrapPeers: readonly string[];
	readonly directory: RendezvousDirectory;
	readonly directProof: DirectProofInspector;
	readonly namespace: string;
	readonly node: GridNodePort;
	now?(): number;
	readonly recordFactory: GridRecordFactory;
	readonly relayPolicy: GridRelayPolicyPort;
	readonly role: GridRole;
}

export interface GridCoordinatorSnapshot {
	readonly creatorPeerKnownBeforeDiscovery: boolean;
	readonly direct?: DirectTransportProof;
	readonly events: readonly GridControlEvent[];
	readonly objectId?: string;
	readonly phase: GridPhase;
	readonly provenance: readonly string[];
	readonly relayPeerIds: readonly string[];
	readonly role: GridRole;
	readonly terminal?: GridTerminal;
}

/** Typed terminal failure from the grid control-plane state machine. */
export class GridCoordinatorError extends Error {
	readonly code:
		| "BOOTSTRAP_CONFIGURATION_FORBIDDEN"
		| "CREATOR_RECORD_MISSING"
		| "DIRECT_PROOF_INVALID"
		| "MESH_NOT_READY"
		| "RELAY_EXHAUSTED";

	/**
	 * @param code - Stable machine-readable failure code.
	 * @param message - Human-readable diagnostic.
	 */
	constructor(code: GridCoordinatorError["code"], message: string) {
		super(message);
		this.name = "GridCoordinatorError";
		this.code = code;
	}
}

/**
 * Owns the Phase 07 cold-start sequence while delegating all DRP replication
 * to the injected production node and all discovery to prior-phase seams.
 */
export class ControlPlaneCoordinator {
	readonly #directory: RendezvousDirectory;
	readonly #directProof: DirectProofInspector;
	readonly #events: GridControlEvent[] = [];
	readonly #namespace: string;
	readonly #node: GridNodePort;
	readonly #now: () => number;
	readonly #provenance: string[] = [];
	readonly #recordFactory: GridRecordFactory;
	readonly #relayPolicy: GridRelayPolicyPort;
	readonly #role: GridRole;
	#creatorPeerKnownBeforeDiscovery = false;
	#direct?: DirectTransportProof;
	#object?: GridObjectPort;
	#phase: GridPhase = "idle";
	#relayPeerIds: string[] = [];
	#terminal?: GridTerminal;

	/** @param options - Explicit discovery, relay, node, and proof owners. */
	constructor(options: GridCoordinatorOptions) {
		if (options.bootstrapPeers.length !== 0) {
			throw new GridCoordinatorError(
				"BOOTSTRAP_CONFIGURATION_FORBIDDEN",
				"grid control plane requires an explicit empty bootstrap_peers array"
			);
		}
		this.#directory = options.directory;
		this.#directProof = options.directProof;
		this.#namespace = options.namespace;
		this.#node = options.node;
		this.#now = options.now ?? Date.now;
		this.#recordFactory = options.recordFactory;
		this.#relayPolicy = options.relayPolicy;
		this.#role = options.role;
	}

	/** @returns An immutable copy of current milestone evidence. */
	get snapshot(): GridCoordinatorSnapshot {
		return {
			creatorPeerKnownBeforeDiscovery: this.#creatorPeerKnownBeforeDiscovery,
			...(this.#direct === undefined ? {} : { direct: this.#direct }),
			events: this.#events.map((event) => ({ ...event })),
			...(this.#object === undefined ? {} : { objectId: this.#object.id }),
			phase: this.#phase,
			provenance: [...this.#provenance],
			relayPeerIds: [...this.#relayPeerIds],
			role: this.#role,
			...(this.#terminal === undefined ? {} : { terminal: this.#terminal }),
		};
	}

	/**
	 * @param signal - Parent cold-start deadline.
	 * @returns Created object identity and signed participant record.
	 */
	async startCreator(signal: AbortSignal): Promise<{ readonly objectId: string; readonly record: SignedDrpRecordV1 }> {
		if (this.#role !== "creator") throw new Error("joiner coordinator cannot create a grid");
		await this.#startNode();
		const relay = await this.#acquireRelay(signal);
		const object = await this.#node.createObject({});
		this.#object = object;
		const relayAddresses = relay.reservations.flatMap(({ candidate }) =>
			candidate.addresses.map((address) => `${address}/p2p-circuit/p2p/${this.#node.networkNode.peerId}`)
		);
		const record = await this.#recordFactory.create({
			addresses: relayAddresses,
			namespace: this.#namespace,
			nowMs: this.#now(),
			peerId: this.#node.networkNode.peerId,
		});
		await this.#directory.register(record, signal);
		this.#phase = "registered";
		this.#provenance.push("rendezvous register");
		this.#event("registry-register", "short-TTL signed creator record accepted");
		return { objectId: object.id, record };
	}

	/**
	 * @param objectId - Opaque grid identity supplied to the joiner.
	 * @param signal - Parent cold-start deadline.
	 * @returns Synchronized production grid object.
	 */
	async startJoiner(objectId: string, signal: AbortSignal): Promise<GridObjectPort> {
		if (this.#role !== "joiner") throw new Error("creator coordinator cannot join a grid");
		this.#creatorPeerKnownBeforeDiscovery = false;
		this.#provenance.push("rendezvous register");
		await this.#startNode();
		this.#phase = "discovering-creator";
		this.#provenance.push("discover");
		this.#event("registry-discover", "opaque namespace queried");
		const records = await this.#directory.discover(this.#namespace, signal);
		const creator = selectCreatorRecord(records);
		if (creator === undefined) {
			throw new GridCoordinatorError("CREATOR_RECORD_MISSING", "no fresh validated creator record");
		}
		this.#provenance.push("validate");
		this.#event("record-validated", "signature, namespace, TTL, and admission accepted");
		const relay = await this.#acquireRelay(signal);
		const creatorAddress = circuitAddressFor(creator, relay);
		this.#phase = "dialing-creator";
		this.#provenance.push("reservation", "dial");
		await this.#node.networkNode.connect(creatorAddress);
		this.#event("creator-dial", "creator reached only through validated record and selected relay");
		await waitUntil(
			() => this.#node.networkNode.getAllPeers().includes(creator.record.peerId),
			5_000,
			"creator connection"
		);
		this.#phase = "mesh-ready";
		this.#event("mesh-ready", "authenticated creator connection precedes object subscription");
		const object = await this.#node.connectObject({ id: objectId, sync: { peerId: creator.record.peerId } });
		this.#object = object;
		await waitUntil(
			() => this.#node.networkNode.getGroupPeers(objectId).includes(creator.record.peerId),
			15_000,
			"object GossipSub mesh"
		);
		this.#phase = "synced";
		this.#event("object-sync", "initial state synchronized over production DRP data plane");
		await this.#proveDirect(creator.record.peerId);
		this.#terminal = "success";
		this.#event("terminal", "grid synchronized with correlated direct WebRTC evidence");
		return object;
	}

	/** @param direction - One bounded grid movement. */
	async move(direction: "D" | "L" | "R" | "U"): Promise<void> {
		if (this.#object === undefined) throw new Error("grid object is not ready");
		await this.#object.move(this.#node.networkNode.peerId, direction);
		const position = this.#object.position(this.#node.networkNode.peerId);
		this.#event("movement", `${direction}:${position?.x ?? "?"},${position?.y ?? "?"}`);
	}

	/**
	 * @param peerId - Lost selected relay identity.
	 * @param signal - Parent replacement deadline.
	 */
	async recoverRelay(peerId: string, signal: AbortSignal): Promise<void> {
		if (this.#relayPolicy.replace === undefined) throw new Error("relay replacement is unavailable");
		const result = await this.#relayPolicy.replace(peerId, "relay-disconnected", signal);
		if (result.terminal !== "reserved") {
			this.#terminal = result.terminal === "owned-fallback" ? "owned-fallback" : "exhausted";
			throw new GridCoordinatorError("RELAY_EXHAUSTED", `relay replacement ended ${result.terminal}`);
		}
		this.#relayPeerIds = result.reservations.map(({ candidate }) => candidate.peerId);
		this.#event("relay-recovery", "replacement reservation acquired without a fixed seed");
	}

	/** Stops the injected production node. */
	async stop(): Promise<void> {
		await this.#node.stop();
	}

	async #startNode(): Promise<void> {
		this.#phase = "starting";
		await this.#node.start();
		this.#event("host-started", "bootstrap_peers=[]; reconnect owner disabled");
	}

	async #acquireRelay(signal: AbortSignal): Promise<RelayPolicyResult> {
		this.#phase = "discovering-relay";
		if (this.#role === "joiner") this.#provenance.push("routing-backed relay candidate");
		this.#event("relay-discovery", "routing-backed candidates requested");
		const result = await this.#relayPolicy.acquire(encoder.encode(this.#namespace), signal);
		if (result.terminal !== "reserved") {
			this.#terminal = result.terminal === "owned-fallback" ? "owned-fallback" : "exhausted";
			this.#phase = "terminal";
			this.#event("terminal", `relay policy ${result.terminal} in ${result.durationMs} ms`);
			throw new GridCoordinatorError("RELAY_EXHAUSTED", `relay policy ended ${result.terminal}`);
		}
		this.#relayPeerIds = result.reservations.map(({ candidate }) => candidate.peerId);
		this.#phase = "reserved";
		this.#event("relay-reservation", `${result.reservations.length} reservation(s) active`);
		return result;
	}

	async #proveDirect(creatorPeerId: string): Promise<void> {
		if (this.#object === undefined) throw new Error("grid object is not ready");
		const proof = await this.#directProof.inspect({
			creatorPeerId,
			objectId: this.#object.id,
			role: this.#role,
		});
		if (!isValidDirectProof(proof)) {
			throw new GridCoordinatorError("DIRECT_PROOF_INVALID", "direct transport proof did not meet the oracle");
		}
		this.#direct = proof;
		this.#phase = "direct";
		this.#event("direct-proof", `${proof.connectionId} ↔ ${proof.rtcPeerConnectionId}`);
	}

	#event(kind: GridControlEvent["kind"], detail: string): void {
		this.#events.push({ atMs: this.#now(), detail, kind });
	}
}

/**
 * Strictly validates the once-per-browser direct-transport oracle.
 * @param proof - Correlated libp2p, RTC, ICE, channel, and byte evidence.
 * @returns Whether every direct-transport requirement is satisfied.
 */
export function isValidDirectProof(proof: DirectTransportProof): boolean {
	return (
		proof.transport === "webrtc" &&
		proof.correlation === "runtime-observed" &&
		proof.correlationBasis === "unique-libp2p-webrtc-connection-and-init-datachannel" &&
		proof.dataChannelOpen &&
		proof.libp2pTransport === "webrtc" &&
		proof.libp2pAddress.includes("/webrtc") &&
		proof.iceCandidateTypes.length === 2 &&
		proof.iceCandidateTypes.every((type) => type === "host" || type === "srflx" || type === "prflx") &&
		proof.directBytesReceived > 0 &&
		proof.directBytesSent > 0 &&
		proof.connectionId.length > 0 &&
		proof.rtcPeerConnectionId.length > 0
	);
}

export interface ControlPlaneHostFactoryOptions {
	readonly addressPolicy: AddressPolicy;
	readonly resolver: Resolver;
}

/**
 * Spike-local factory that fail-closes on any production option which could
 * reintroduce a fixed seed or pre-authenticated peer exchange.
 */
export class ControlPlaneHostFactory {
	readonly #addressPolicy: AddressPolicy;
	readonly #resolver: Resolver;
	#snapshot?: DRPNetworkHostConfigSnapshot;

	/** @param options - Address classifier and DNS resolver dependencies. */
	constructor(options: ControlPlaneHostFactoryOptions) {
		this.#addressPolicy = options.addressPolicy;
		this.#resolver = options.resolver;
	}

	readonly factory: DRPNetworkHostFactory = async (context) => {
		assertIsolatedHostSnapshot(context.snapshot);
		this.#snapshot = context.snapshot;
		return context.createHost();
	};

	readonly policy: DRPNetworkHostPolicy = {
		bootstrapDiscovery: false,
		coldStartPubsubDiscovery: false,
		denyDialMultiaddr: async (address: Multiaddr): Promise<boolean> => {
			try {
				const decision = await this.#addressPolicy.evaluate(
					address.toString(),
					this.#resolver,
					AbortSignal.timeout(2_000)
				);
				return !decision.dialable;
			} catch {
				return true;
			}
		},
		gossipSubPeerExchange: false,
	};

	/** @returns The last production host isolation snapshot. */
	get snapshot(): DRPNetworkHostConfigSnapshot | undefined {
		return this.#snapshot;
	}
}

/** @param snapshot - Production options to validate before host construction. */
export function assertIsolatedHostSnapshot(snapshot: DRPNetworkHostConfigSnapshot): void {
	if (
		snapshot.bootstrapDiscovery ||
		snapshot.bootstrapPeerCount !== 0 ||
		snapshot.coldStartPubsubDiscovery ||
		snapshot.gossipSubPeerExchange ||
		snapshot.outboundAddressPolicy !== "injected" ||
		snapshot.peerDiscoveryModules.length !== 0
	) {
		throw new Error("production host isolation snapshot is not fail-closed");
	}
}

function selectCreatorRecord(records: readonly ValidatedDrpRecord[]): ValidatedDrpRecord | undefined {
	return [...records].sort((left, right) => right.record.sequence - left.record.sequence)[0];
}

function circuitAddressFor(record: ValidatedDrpRecord, relay: RelayPolicyResult): string {
	if (relay.reservations.length === 0) {
		throw new GridCoordinatorError("RELAY_EXHAUSTED", "reservation omitted relay address");
	}
	const creatorAddress = record.record.addresses.find((address) => address.includes("/p2p-circuit/"));
	if (creatorAddress === undefined) {
		throw new GridCoordinatorError("CREATOR_RECORD_MISSING", "creator record omitted a relay address");
	}
	return creatorAddress;
}

async function waitUntil(check: () => boolean, timeoutMs: number, description: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new GridCoordinatorError("MESH_NOT_READY", `timed out waiting for ${description}`);
}
