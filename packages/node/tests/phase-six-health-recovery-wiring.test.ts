import type { Address, PeerId } from "@libp2p/interface";
import {
	type ControlPlaneMechanismPorts,
	type ControlPlaneScheduler,
	type RecoveryMechanismResult,
} from "@ts-drp/control-plane";
import type {
	ControlPlaneConnectionEvidence,
	ControlPlaneEvent,
	ControlPlaneRelayReservationEvidence,
	DRPNetworkNode,
	DRPNodeConfig,
	GroupPeerChange,
	GroupPeerChangeHandler,
	IDRPIntervalReconnectBootstrap,
} from "@ts-drp/types";
import { IntervalRunnerState } from "@ts-drp/types";
import { describe, expect, it, vi } from "vitest";

import { DRPNode } from "../src/index.js";

const START_MS = 1_750_000_000_000;

describe("Phase 6 DRPNode real-coordinator wiring", () => {
	it.each([
		{ allPeers: ["configured-seed"], groupPeers: [], name: "seed-only transport" },
		{
			allPeers: ["configured-seed", "unauthenticated-stranger"],
			groupPeers: ["unauthenticated-stranger"],
			name: "unauthenticated group stranger",
		},
	])("does not fabricate a healthy mesh from $name and starts recovery", async ({ allPeers, groupPeers }) => {
		const scheduler = new ManualNodeScheduler();
		const fake = createFakeNetwork({ allPeers, groupPeers });
		const ports = createMechanisms();
		const events: ControlPlaneEvent[] = [];
		const node = new DRPNode(config(events, { startup_grace_ms: 50 }), {
			controlPlaneMechanisms: ports,
			controlPlaneScheduler: scheduler,
			networkNode: fake.networkNode,
			reconnect: createReconnect(fake.networkNode),
		});
		seedFreshControlPlane(node);

		await node.start();
		const [firstGroupPeer] = groupPeers;
		if (firstGroupPeer !== undefined) {
			const object = await node.createObject({ id: "local-object" });
			fake.emit({ peerId: firstGroupPeer, subscribed: true, topic: object.id });
			await flushMicrotasks();
		}
		scheduler.advanceBy(50);
		await vi.waitFor(() => expect(ports.rendezvousBootstrap).toHaveBeenCalled());

		expect(events).not.toContainEqual({ kind: "health", state: "healthy" });
		expect(node["_intervals"].has("interval::reconnect")).toBe(false);
		await node.stop();
		expect(scheduler.pendingCount()).toBe(0);
	});

	it("keeps an authenticated sole-writer fresh mesh healthy without recovery churn", async () => {
		const scheduler = new ManualNodeScheduler();
		const fake = createFakeNetwork({ allPeers: ["member-a"], groupPeers: ["member-a"] });
		const ports = createMechanisms();
		const events: ControlPlaneEvent[] = [];
		const reconnect = createReconnect(fake.networkNode);
		const node = new DRPNode(config(events, { startup_grace_ms: 100 }), {
			controlPlaneMechanisms: ports,
			controlPlaneScheduler: scheduler,
			networkNode: fake.networkNode,
			reconnect,
		});
		seedFreshControlPlane(node);

		await node.start();
		const object = await node.createObject({ id: "local-sole-writer-object" });
		fake.emit({ peerId: "member-a", subscribed: true, topic: object.id });
		await flushMicrotasks();
		scheduler.advanceBy(100);
		await flushMicrotasks();
		for (let index = 0; index < 5; index += 1) {
			fake.emit({ peerId: "member-a", subscribed: true, topic: object.id });
		}
		await flushMicrotasks();
		scheduler.advanceBy(5_000);
		await flushMicrotasks();

		expect(events).toContainEqual({ kind: "health", state: "healthy" });
		expect(ports.rendezvousBootstrap).not.toHaveBeenCalled();
		expect(ports.relayReplace).not.toHaveBeenCalled();
		expect(ports.syncFromDifferentPeer).not.toHaveBeenCalled();
		expect(reconnect.start).not.toHaveBeenCalled();
		expect(node["_intervals"].has("interval::reconnect")).toBe(false);
		await node.stop();
		expect(scheduler.pendingCount()).toBe(0);
	});

	it("uses the real default recovery port to redial bootstraps", async () => {
		const scheduler = new ManualNodeScheduler();
		const fake = createFakeNetwork({ allPeers: ["configured-seed"], groupPeers: [] });
		const events: ControlPlaneEvent[] = [];
		const node = new DRPNode(config(events, { startup_grace_ms: 0 }), {
			controlPlaneScheduler: scheduler,
			networkNode: fake.networkNode,
			reconnect: false,
		});
		seedFreshControlPlane(node);

		await node.start();
		await vi.waitFor(() => expect(fake.redialBootstraps).toHaveBeenCalledOnce());

		expect(node["_preservedControlPlaneState"]).toBeInstanceOf(Map);
		expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "recovery" })]));
		await node.stop();
		expect(scheduler.pendingCount()).toBe(0);
	});

	it("fails closed instead of disabling reconnect when default redial support is absent", async () => {
		const scheduler = new ManualNodeScheduler();
		const fake = createFakeNetwork({ allPeers: [], groupPeers: [], redialSupport: false });
		const node = new DRPNode(config([], { startup_grace_ms: 0 }), {
			controlPlaneScheduler: scheduler,
			networkNode: fake.networkNode,
			reconnect: false,
		});

		await expect(node.start()).rejects.toThrow("requires network redial support");
		await node.stop();
	});

	it("completes DRPNode.stop while a real-coordinator recovery port ignores cancellation", async () => {
		const scheduler = new ManualNodeScheduler();
		const fake = createFakeNetwork({ allPeers: ["configured-seed"], groupPeers: [] });
		const ports = createMechanisms();
		ports.rendezvousBootstrap.mockImplementation(() => new Promise(() => {}));
		const events: ControlPlaneEvent[] = [];
		const node = new DRPNode(config(events, { parent_deadline_ms: 100, startup_grace_ms: 0 }), {
			controlPlaneMechanisms: ports,
			controlPlaneScheduler: scheduler,
			networkNode: fake.networkNode,
			reconnect: false,
		});
		seedFreshControlPlane(node);

		await node.start();
		await vi.waitFor(() => expect(ports.rendezvousBootstrap).toHaveBeenCalledOnce());
		const stopping = node.stop();
		scheduler.advanceBy(100);
		await stopping;

		expect(events).toContainEqual({ kind: "terminal", reason: "stopped" });
		expect(scheduler.pendingCount()).toBe(0);
	});

	it("feeds failed operation history into the next observed health snapshot", async () => {
		const scheduler = new ManualNodeScheduler();
		const fake = createFakeNetwork({ allPeers: ["configured-seed"], groupPeers: [] });
		const ports = createMechanisms();
		ports.rendezvousBootstrap.mockResolvedValue({ terminal: "failed" });
		const events: ControlPlaneEvent[] = [];
		const node = new DRPNode(config(events, { recovery_backoff_ms: 500, startup_grace_ms: 0 }), {
			controlPlaneMechanisms: ports,
			controlPlaneScheduler: scheduler,
			networkNode: fake.networkNode,
			reconnect: false,
		});
		seedFreshControlPlane(node);

		await node.start();
		await vi.waitFor(() => expect(events).toContainEqual({ kind: "terminal", reason: "exhausted" }));
		scheduler.advanceBy(500);
		await vi.waitFor(() => expect(events).toContainEqual({ kind: "health", state: "recovering" }));

		await node.stop();
		expect(scheduler.pendingCount()).toBe(0);
	});
});

class ManualNodeScheduler implements ControlPlaneScheduler {
	#nextHandle = 1;
	#nowMs = START_MS;
	readonly #scheduled = new Map<number, { readonly atMs: number; callback(): void }>();

	clear(handle: unknown): void {
		if (typeof handle === "number") this.#scheduled.delete(handle);
	}

	advanceBy(delayMs: number): void {
		const targetMs = this.#nowMs + delayMs;
		while (true) {
			const next = [...this.#scheduled.entries()]
				.filter(([, value]) => value.atMs <= targetMs)
				.sort((left, right) => left[1].atMs - right[1].atMs)[0];
			if (next === undefined) break;
			const [handle, value] = next;
			this.#scheduled.delete(handle);
			this.#nowMs = value.atMs;
			value.callback();
		}
		this.#nowMs = targetMs;
	}

	now(): number {
		return this.#nowMs;
	}

	pendingCount(): number {
		return this.#scheduled.size;
	}

	schedule(delayMs: number, callback: () => void): unknown {
		const handle = this.#nextHandle++;
		this.#scheduled.set(handle, { atMs: this.#nowMs + delayMs, callback });
		return handle;
	}

	sleep(delayMs: number, signal: AbortSignal): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			const abort = (): void => {
				this.clear(handle);
				reject(signal.reason);
			};
			const handle = this.schedule(delayMs, (): void => {
				signal.removeEventListener("abort", abort);
				resolve();
			});
			signal.addEventListener("abort", abort, { once: true });
		});
	}
}

interface FakeNetworkOptions {
	readonly allPeers: readonly string[];
	readonly groupPeers: readonly string[];
	readonly redialSupport?: boolean;
}

function createFakeNetwork(options: FakeNetworkOptions): {
	emit(change: GroupPeerChange): void;
	networkNode: DRPNetworkNode;
	redialBootstraps: ReturnType<typeof vi.fn>;
} {
	const groupHandlers: GroupPeerChangeHandler[] = [];
	const redialBootstraps = vi.fn((_signal: AbortSignal): Promise<boolean> => Promise.resolve(true));
	const connections: readonly ControlPlaneConnectionEvidence[] = options.allPeers.map((peerId) => ({
		multiaddr: `/dns4/peer.example/tcp/443/wss/p2p/${peerId}`,
		peerId,
		transport: "wss",
	}));
	const reservations: readonly ControlPlaneRelayReservationEvidence[] = [
		{ expiresAtMs: START_MS + 60_000, operatorGroup: "operator-a", peerId: "relay-a" },
	];
	const networkNode = {
		broadcastMessage: vi.fn(() => Promise.resolve()),
		changeTopicScoreParams: vi.fn(),
		connect: vi.fn(() => Promise.resolve()),
		connectToBootstraps: vi.fn(() => Promise.resolve()),
		disconnect: vi.fn(() => Promise.resolve()),
		getActiveRelayReservations: vi.fn(() => reservations),
		getAllPeers: vi.fn(() => [...options.allPeers]),
		getBootstrapNodes: vi.fn(() => ["/dns4/seed.example/tcp/443/wss/p2p/configured-seed"]),
		getControlPlaneConnections: vi.fn(() => connections),
		getGroupPeers: vi.fn(() => [...options.groupPeers]),
		getMultiaddrs: vi.fn((): string[] => []),
		getPeerMultiaddrs: vi.fn((_peerId: PeerId | string): Promise<Address[]> => Promise.resolve([])),
		getSubscribedTopics: vi.fn((): string[] => []),
		isDialable: vi.fn(() => Promise.resolve(false)),
		membershipVerifier: {
			verify: vi.fn(
				({ peerId }: { readonly peerId: string }): Promise<{ readonly accepted: boolean }> =>
					Promise.resolve({ accepted: peerId === "member-a" })
			),
		},
		peerId: "local-node",
		...(options.redialSupport === false ? {} : { redialBootstraps }),
		removeTopicScoreParams: vi.fn(),
		replaceRelay: vi.fn(() => Promise.resolve(true)),
		restart: vi.fn(() => Promise.resolve()),
		sendGroupMessageRandomPeer: vi.fn(() => Promise.resolve()),
		sendMessage: vi.fn(() => Promise.resolve()),
		start: vi.fn(() => Promise.resolve()),
		stop: vi.fn(() => Promise.resolve()),
		subscribe: vi.fn(),
		subscribeToGroupPeerChanges: vi.fn((handler: GroupPeerChangeHandler) => {
			groupHandlers.push(handler);
			return (): void => {
				const index = groupHandlers.indexOf(handler);
				if (index >= 0) groupHandlers.splice(index, 1);
			};
		}),
		subscribeToMessageQueue: vi.fn(),
		unsubscribe: vi.fn(),
	} satisfies DRPNetworkNode;
	return {
		emit: (change): void => groupHandlers.forEach((handler) => handler(change)),
		networkNode,
		redialBootstraps,
	};
}

function createMechanisms(): ControlPlaneMechanismPorts & {
	readonly relayReplace: ReturnType<typeof vi.fn>;
	readonly rendezvousBootstrap: ReturnType<typeof vi.fn>;
	readonly syncFromDifferentPeer: ReturnType<typeof vi.fn>;
} {
	const succeeded = (): Promise<RecoveryMechanismResult> => Promise.resolve({ terminal: "succeeded" });
	return {
		continueRelayed: vi.fn(succeeded),
		disconnectPeer: vi.fn(() => Promise.resolve()),
		preserveLocalState: vi.fn(succeeded),
		registryCooldown: vi.fn(),
		relayReplace: vi.fn(succeeded),
		rendezvousBootstrap: vi.fn(succeeded),
		routerFallback: vi.fn(succeeded),
		syncFromDifferentPeer: vi.fn(succeeded),
	};
}

function createReconnect(networkNode: DRPNetworkNode): IDRPIntervalReconnectBootstrap & {
	readonly start: ReturnType<typeof vi.fn>;
} {
	return {
		id: "legacy-reconnect",
		networkNode,
		start: vi.fn(),
		state: IntervalRunnerState.Stopped,
		stop: vi.fn(),
		type: "interval:reconnect",
	};
}

function config(
	events: ControlPlaneEvent[],
	recoveryOverrides: Partial<
		NonNullable<NonNullable<DRPNodeConfig["network_config"]>["control_plane"]>["recovery"]
	> = {}
): DRPNodeConfig {
	return {
		keychain_config: { private_key_seed: "phase-six-real-coordinator" },
		log_config: { level: "silent" },
		network_config: {
			bootstrap_peers: ["/dns4/seed.example/tcp/443/wss/p2p/configured-seed"],
			control_plane: {
				membership: { allowlist: { allowedPeerIds: ["member-a"] }, mode: "allowlist" },
				observability: { sink: (event): void => void events.push(event) },
				recovery: {
					backend_cooldown_ms: 1_000,
					max_attempts: 1,
					parent_deadline_ms: 1_000,
					recovery_backoff_ms: 500,
					retry_delays_ms: [],
					startup_grace_ms: 0,
					...recoveryOverrides,
				},
			},
			listen_addresses: [],
		},
	};
}

function seedFreshControlPlane(node: DRPNode): void {
	node["_rendezvousBackendStates"] = [{ id: "registry-a", status: "succeeded" }];
	node["_rendezvousObservedAtMs"] = START_MS;
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
