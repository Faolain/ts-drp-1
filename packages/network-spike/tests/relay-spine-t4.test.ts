import { type Multiaddr, multiaddr } from "@multiformats/multiaddr";
import { DRPNetworkNode } from "@ts-drp/network";
import type { DRPConnectionBudget, DRPNetworkNodeConfig, DRPPeerSelectionSnapshot } from "@ts-drp/types";
import { describe, expect, test } from "vitest";

interface ExplicitDialTicket {
	release(): void;
}

interface PriorityAdmissionController {
	attach(host: object): void;
	admitDiscoveredPeer(peerId: { toString(): string }, addresses: readonly Multiaddr[]): boolean;
	createExplicitTicket(target: string): ExplicitDialTicket | undefined;
	createPriorityTicket(target: string): ExplicitDialTicket | undefined;
	getSnapshot(
		dependencyDialQueue: number,
		expectedReplicas: number | undefined,
		globalDiscovery: boolean
	): DRPPeerSelectionSnapshot;
	hasActiveRelayPeer(peerId: string): boolean;
	reconcileRelayReservations(reservations: readonly { peerId: string; priorityTicket?: ExplicitDialTicket }[]): void;
	stop(): void;
}

interface T4Snapshot extends DRPPeerSelectionSnapshot {
	readonly priority: number;
	readonly prioritySlots: number;
	readonly replacements: number;
}

type T4ControllerFactory = (
	budget: DRPConnectionBudget,
	options: { readonly prioritySlots: number }
) => PriorityAdmissionController;
const controllerSourceModuleUrl = new URL("../../network/src/connection-budget.ts", import.meta.url).href;
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

describe("D.93.50 deterministic relay-spine controller campaign", () => {
	test("retains the hard connection bound across 5,000 priority-tail replicas", async () => {
		const { createConnectionAdmissionController: createController } = (await import(controllerSourceModuleUrl)) as {
			createConnectionAdmissionController: T4ControllerFactory;
		};
		for (let replica = 0; replica < 5_000; replica++) {
			const maxConnections = 16 + (replica % 17);
			const maxParallelDials = 2 + (replica % 3);
			const prioritySlots = 1 + (replica % 8);
			const controller = createController({ maxConnections, maxParallelDials, role: "node" }, { prioritySlots });
			controller.attach(
				Object.assign(new EventTarget(), {
					getConnections: (): readonly [] => [],
					peerId: { toString: (): string => `campaign-host-${replica}` },
				})
			);
			expect(controller.createPriorityTicket, "T4_PRIORITY_CONTROLLER_ABSENT").toBeTypeOf("function");
			const ordinary: ExplicitDialTicket[] = [];
			const priority: ExplicitDialTicket[] = [];

			for (let index = 0; index < prioritySlots; index++) {
				const selectedPeer = { toString: (): string => `selected-${replica}-${index}` };
				expect(
					controller.admitDiscoveredPeer(selectedPeer, [
						multiaddr(`/ip4/127.0.0.1/tcp/${20_000 + ((replica + index) % 20_000)}`),
					])
				).toBe(true);
			}
			const discovered = controller.getSnapshot(maxParallelDials, 5_000, false) as T4Snapshot;
			expect(discovered.dependencyDialQueue).toBeLessThanOrEqual(maxParallelDials);
			expect(discovered.selected).toBe(prioritySlots);
			expect(discovered.selected).toBeLessThanOrEqual(maxConnections - maxParallelDials);

			for (let index = 0; index < maxConnections - prioritySlots; index++) {
				const ticket = controller.createExplicitTicket(`ordinary-${replica}-${index}`);
				if (ticket === undefined) throw new Error("ordinary controller capacity ended before its bounded prefix");
				ordinary.push(ticket);
			}
			expect(controller.createExplicitTicket(`ordinary-tail-${replica}`)).toBeUndefined();
			for (let index = 0; index < prioritySlots; index++) {
				const operatorGroup = `operator:${index % 3}`;
				const ticket = controller.createPriorityTicket(`relay-${operatorGroup}-${replica}-${index}`);
				if (ticket === undefined) throw new Error("priority tail ended before its configured prefix");
				priority.push(ticket);
			}
			expect(controller.createPriorityTicket(`relay-overflow-${replica}`)).toBeUndefined();
			const activeRelays = priority.map((priorityTicket, index) => ({
				peerId: `relay-operator:${index % 3}-${replica}-${index}`,
				priorityTicket,
			}));
			controller.reconcileRelayReservations(activeRelays);
			for (const { peerId } of activeRelays) {
				expect(controller.hasActiveRelayPeer(peerId)).toBe(true);
			}

			const snapshot = controller.getSnapshot(maxParallelDials, 5_000, false) as T4Snapshot;
			expect(snapshot.prioritySlots).toBe(prioritySlots);
			expect(snapshot.priority).toBe(prioritySlots);
			expect(snapshot.replacements).toBe(prioritySlots);
			expect(snapshot.selected).toBe(0);
			expect(snapshot.dependencyDialQueue).toBeLessThanOrEqual(maxParallelDials);
			expect(snapshot.priority).toBeLessThanOrEqual(snapshot.prioritySlots);
			expect(ordinary.length + priority.length).toBe(maxConnections);
			expect(
				snapshot.queued + snapshot.selected + snapshot.charged + snapshot.upgrade + snapshot.live
			).toBeLessThanOrEqual(snapshot.budget);

			const releasedOrdinary = ordinary.pop();
			releasedOrdinary?.release();
			const churnedOrdinary = controller.createExplicitTicket(`ordinary-churn-${replica}`);
			expect(churnedOrdinary).toBeDefined();
			churnedOrdinary?.release();
			const replaced = activeRelays.shift();
			replaced?.priorityTicket.release();
			const replacementPeerId = `relay-operator:replacement-${replica}`;
			const replacementTicket = controller.createPriorityTicket(replacementPeerId);
			if (replacementTicket === undefined) throw new Error("priority replacement lost its bounded unit");
			activeRelays.push({ peerId: replacementPeerId, priorityTicket: replacementTicket });
			controller.reconcileRelayReservations(activeRelays);
			if (replaced !== undefined) expect(controller.hasActiveRelayPeer(replaced.peerId)).toBe(false);
			expect(controller.hasActiveRelayPeer(replacementPeerId)).toBe(true);
			const replacedSnapshot = controller.getSnapshot(maxParallelDials - 1, 5_000, false) as T4Snapshot;
			expect(replacedSnapshot.dependencyDialQueue).toBeLessThanOrEqual(maxParallelDials);
			expect(replacedSnapshot.priority).toBe(prioritySlots);
			expect(
				replacedSnapshot.queued +
					replacedSnapshot.selected +
					replacedSnapshot.charged +
					replacedSnapshot.upgrade +
					replacedSnapshot.live
			).toBeLessThanOrEqual(replacedSnapshot.budget);
			priority.splice(0, 1, replacementTicket);
			for (const ticket of [...priority, ...ordinary]) ticket.release();
			controller.stop();
		}
	});

	test("closes the campaign through the genuine reserved-versus-neutral GossipSub score owner", async () => {
		const relay = new DRPNetworkNode(
			{
				bootstrap_peers: [],
				connection_budget: { max_connections: 4, max_parallel_dials: 1 },
				control_plane: { address_policy: localAddressPolicy },
				listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
				log_config: { level: "silent" },
				relay_service: { enabled: true },
			} as DRPNetworkNodeConfig,
			{ hostPolicy: quietPolicy }
		);
		let client: DRPNetworkNode | undefined;
		try {
			await relay.start();
			const relayAddress = relay.getMultiaddrs().find((address) => address.includes("/ws/p2p/"));
			if (relayAddress === undefined) throw new Error("relay did not expose a WebSocket address");
			client = new DRPNetworkNode(
				{
					bootstrap_peers: [],
					connection_budget: { max_connections: 4, max_parallel_dials: 1 },
					control_plane: {
						address_policy: localAddressPolicy,
						pubsub_scoring: {
							observed_behavior_reward: { enabled: true, max_application_score: 0.2 },
						},
						relay_policy: { sources: { configured_relays: [relayAddress] }, target_reservations: 1 },
					},
					listen_addresses: [],
					log_config: { level: "silent" },
				} as DRPNetworkNodeConfig,
				{ hostPolicy: quietPolicy }
			);
			await client.start();
			await client.retryRelayPolicyAcquisition();
			const score = (
				client as unknown as {
					_pubsub?: { score: { params: { appSpecificScore(peerId: string): number } } };
				}
			)._pubsub?.score.params.appSpecificScore;
			if (score === undefined) throw new Error("expected genuine GossipSub score owner");
			expect(score(relay.peerId), "T4_PRIORITY_CONTROLLER_ABSENT").toBeGreaterThan(score("neutral-peer"));
		} finally {
			await Promise.allSettled([client?.stop(), relay.stop()]);
		}
	}, 15_000);
});
