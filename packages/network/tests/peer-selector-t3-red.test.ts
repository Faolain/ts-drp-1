import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import {
	type Connection,
	KEEP_ALIVE,
	type Libp2p,
	type OpenConnectionProgressEvents,
	type PeerDiscovery,
	peerDiscoverySymbol,
	type PeerId,
	type PeerInfo,
	type PeerUpdate,
} from "@libp2p/interface";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";
import { type DRPNetworkNodeConfig, Message, MessageType } from "@ts-drp/types";
import { raceEvent } from "race-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import { type DRPNetworkHostFactory, DRPNetworkNode } from "../src/node.js";

interface PeerSelectionSnapshot {
	readonly budget: number;
	readonly charged: number;
	readonly denied: number;
	readonly dependencyDialQueue: number;
	readonly expectedReplicas: number | undefined;
	readonly globalDiscovery: boolean;
	readonly live: number;
	readonly queued: number;
	readonly selected: number;
	readonly upgrade: number;
}

interface T3Node extends DRPNetworkNode {
	getPeerSelectionSnapshot(): PeerSelectionSnapshot;
}

interface InspectableHost extends Libp2p {
	components: {
		connectionGater: {
			denyOutboundUpgradedConnection?(
				peer: PeerId,
				connection: Readonly<{ remoteAddr: Multiaddr; remotePeer: PeerId }>
			): boolean | Promise<boolean>;
		};
		connectionManager: {
			getDialQueue(): readonly unknown[];
			openConnection(
				peer: Multiaddr | PeerId | readonly Multiaddr[],
				options?: Readonly<{
					onProgress?(event: OpenConnectionProgressEvents): void;
					signal?: AbortSignal;
				}>
			): Promise<unknown>;
		};
	};
	services: Libp2p["services"] & {
		dcutr?: { attemptUnilateralConnectionUpgrade(connection: Connection): Promise<boolean> };
	};
}

class ControlledDiscovery extends EventTarget {
	readonly [peerDiscoverySymbol] = this as unknown as PeerDiscovery;

	discover(info: PeerInfo): void {
		this.dispatchEvent(new CustomEvent("peer", { detail: info }));
	}
}

const selectorRuntimeInstalled =
	typeof Object.getOwnPropertyDescriptor(DRPNetworkNode.prototype, "getPeerSelectionSnapshot")?.value === "function";
const quietPolicy = {
	bootstrapDiscovery: false,
	coldStartPubsubDiscovery: false,
	gossipSubPeerExchange: false,
};

function privatePeer(index: number): ReturnType<typeof privateKeyFromRaw> {
	return privateKeyFromRaw(privateBytes(index));
}

function privateBytes(index: number): Uint8Array {
	const bytes = new Uint8Array(32);
	bytes[0] = 0x49;
	new DataView(bytes.buffer).setUint32(28, index + 1, false);
	return bytes;
}

function peer(index: number): PeerId {
	return peerIdFromPublicKey(privatePeer(index).publicKey);
}

function address(id: PeerId, port: number): Multiaddr {
	return multiaddr(`/ip4/127.0.0.1/tcp/${port}/p2p/${id}`);
}

function config(maxConnections = 8, maxParallelDials = 2, expectedReplicas = 8): DRPNetworkNodeConfig {
	return {
		bootstrap_peers: [],
		connection_budget: {
			max_connections: maxConnections,
			max_parallel_dials: maxParallelDials,
		},
		control_plane: {
			peer_selection: { expected_replicas: expectedReplicas },
		},
		listen_addresses: [],
		log_config: { level: "silent" },
	} as unknown as DRPNetworkNodeConfig;
}

function snapshot(node: DRPNetworkNode): PeerSelectionSnapshot {
	return (node as T3Node).getPeerSelectionSnapshot();
}

function assertClosedSnapshot(value: PeerSelectionSnapshot): void {
	expect(Object.keys(value).sort()).toEqual([
		"budget",
		"charged",
		"denied",
		"dependencyDialQueue",
		"expectedReplicas",
		"globalDiscovery",
		"live",
		"queued",
		"selected",
		"upgrade",
	]);
	expect(value.queued + value.selected + value.charged + value.upgrade + value.live).toBeLessThanOrEqual(value.budget);
	expect(value.dependencyDialQueue).toBeLessThanOrEqual(value.budget);
}

async function expectDirectPrequeueDenied(host: InspectableHost, target: Multiaddr | PeerId): Promise<void> {
	const progress: string[] = [];
	await host.components.connectionManager
		.openConnection(target, {
			onProgress: (event) => progress.push(event.type),
			signal: AbortSignal.timeout(100),
		})
		.catch(() => undefined);
	expect(progress).not.toContain("dial-queue:add-to-dial-queue");
	expect(host.components.connectionManager.getDialQueue()).toHaveLength(0);
}

describe("D.93.49 T3 bounded discovery-to-dial peer selection", () => {
	const running: DRPNetworkNode[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		await Promise.allSettled(
			running.splice(0).map(async (node) => {
				if (node["_node"]?.status !== "stopped") await node.stop();
			})
		);
	});

	test("fails RED at the real pre-queue boundary before an unselected native dial is inserted", async () => {
		let host: InspectableHost | undefined;
		const hostFactory: DRPNetworkHostFactory = async (context) => {
			host = (await context.createHost()) as InspectableHost;
			return host;
		};
		const node = new DRPNetworkNode(config(), { hostFactory, hostPolicy: quietPolicy });
		running.push(node);
		await node.start();
		if (host === undefined) throw new Error("expected production host");

		const progress: string[] = [];
		await host.components.connectionManager
			.openConnection(peer(1), {
				onProgress: (event) => progress.push(event.type),
				signal: AbortSignal.timeout(250),
			})
			.catch(() => undefined);

		expect(progress, "T3_PREQUEUE_SELECTOR_ABSENT").not.toContain("dial-queue:add-to-dial-queue");
		expect(
			Object.getOwnPropertyDescriptor(DRPNetworkNode.prototype, "getPeerSelectionSnapshot")?.value,
			"T3_SNAPSHOT_ABSENT"
		).toBeTypeOf("function");
		const value = snapshot(node);
		assertClosedSnapshot(value);
		expect(value).toMatchObject({ charged: 0, denied: 1, selected: 0 });
		expect(host.components.connectionManager.getDialQueue()).toHaveLength(0);
	});

	test.skipIf(!selectorRuntimeInstalled)(
		"selects exactly the first 42 of 1,000 unique records synchronously and reserves explicit headroom",
		async () => {
			const node = new DRPNetworkNode(config(48, 6, 50), { hostPolicy: quietPolicy });
			running.push(node);
			await node.start();
			const host = node["_node"] as InspectableHost;
			const explicitAttempt = node
				.safeDial(address(peer(9_999), 19_999), undefined, AbortSignal.timeout(50))
				.catch(() => undefined);

			for (let index = 0; index < 1_000; index += 1) {
				const id = peer(index + 10_000);
				host.dispatchEvent(
					new CustomEvent("peer:discovery", {
						detail: { id, multiaddrs: [address(id, 20_000 + index)], protocols: [] },
					})
				);
			}
			await explicitAttempt;

			const value = snapshot(node);
			assertClosedSnapshot(value);
			expect(value).toMatchObject({ budget: 48, charged: 1, denied: 958, selected: 42 });
			expect(host.components.connectionManager.getDialQueue()).toHaveLength(0);
		}
	);

	test.skipIf(!selectorRuntimeInstalled)(
		"keeps duplicate, self, malformed and addressless records out of the first/interior/last census",
		async () => {
			const node = new DRPNetworkNode(config(4, 1, 4), { hostPolicy: quietPolicy });
			running.push(node);
			await node.start();
			const host = node["_node"] as InspectableHost;
			const candidates = [peer(10), peer(11), peer(12), peer(13)];
			for (const [index, id] of candidates.entries()) {
				host.dispatchEvent(
					new CustomEvent("peer:discovery", {
						detail: { id, multiaddrs: [address(id, 30_000 + index)], protocols: [] },
					})
				);
			}
			const atCeiling = snapshot(node);
			expect(atCeiling).toMatchObject({ denied: 1, selected: 3 });

			for (const detail of [
				{ id: candidates[0], multiaddrs: [address(candidates[0], 30_000)], protocols: [] },
				{ id: host.peerId, multiaddrs: [address(host.peerId, 30_010)], protocols: [] },
				{ id: peer(14), multiaddrs: [], protocols: [] },
				{ id: undefined, multiaddrs: [multiaddr("/ip4/127.0.0.1/tcp/30011")], protocols: [] },
			]) {
				host.dispatchEvent(new CustomEvent("peer:discovery", { detail }) as never);
			}
			const afterInvalid = snapshot(node);
			assertClosedSnapshot(afterInvalid);
			expect(afterInvalid.selected).toBe(3);
		}
	);

	test.skipIf(!selectorRuntimeInstalled)(
		"installs extension discovery synchronously and transfers one selected authorization into the native queue",
		async () => {
			const configuredDiscovery = new ControlledDiscovery();
			const serviceDiscovery = new ControlledDiscovery();
			let host: InspectableHost | undefined;
			const node = new DRPNetworkNode(config(3, 1, 3), {
				hostFactory: async (context): Promise<InspectableHost> => {
					host = (await context.createHost({
						peerDiscovery: [(): PeerDiscovery => configuredDiscovery as unknown as PeerDiscovery],
						services: {
							controlledDiscovery: (): unknown => serviceDiscovery,
						} as never,
					})) as InspectableHost;
					return host;
				},
				hostPolicy: quietPolicy,
			});
			running.push(node);
			await node.start();
			if (host === undefined) throw new Error("expected extension host");
			const id = peer(30);
			const serviceId = peer(31);
			const peerAddress = address(id, 31_030);

			configuredDiscovery.discover({ id, multiaddrs: [peerAddress] });
			serviceDiscovery.discover({ id: serviceId, multiaddrs: [address(serviceId, 31_031)] });
			expect(snapshot(node)).toMatchObject({ charged: 0, selected: 2 });
			const progress: string[] = [];
			await host.components.connectionManager
				.openConnection(id, {
					onProgress: (event) => progress.push(event.type),
					signal: AbortSignal.timeout(250),
				})
				.catch(() => undefined);
			expect(progress).toContain("dial-queue:add-to-dial-queue");
			expect(snapshot(node)).toMatchObject({ charged: 1, selected: 1 });

			const repeatProgress: string[] = [];
			await host.components.connectionManager
				.openConnection(id, {
					onProgress: (event) => repeatProgress.push(event.type),
					signal: AbortSignal.timeout(250),
				})
				.catch(() => undefined);
			expect(repeatProgress).not.toContain("dial-queue:add-to-dial-queue");

			const livePeer = new DRPNetworkNode(
				{
					bootstrap_peers: [],
					listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
					log_config: { level: "silent" },
				} as never,
				{ hostPolicy: quietPolicy }
			);
			running.push(livePeer);
			await livePeer.start();
			await node.safeDial(livePeer.getMultiaddrs()[0]);
			const beforeLiveRediscovery = snapshot(node);
			serviceDiscovery.discover({
				id: livePeer["_node"]?.peerId as PeerId,
				multiaddrs: livePeer.getMultiaddrs().map((value) => multiaddr(value)),
			});
			expect(snapshot(node)).toEqual(beforeLiveRediscovery);
			assertClosedSnapshot(snapshot(node));
		}
	);

	test.skipIf(!selectorRuntimeInstalled)(
		"authorizes genuine first and updated signed peer records while replayed and unsigned PX remain inert",
		async () => {
			const signerConfig = {
				bootstrap_peers: [],
				listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
				log_config: { level: "silent" as const },
			};
			const signer = new DRPNetworkNode(signerConfig, { hostPolicy: quietPolicy });
			const source = new DRPNetworkNode(signerConfig, { hostPolicy: quietPolicy });
			const target = new DRPNetworkNode(config(4, 1, 4), { hostPolicy: quietPolicy });
			running.push(signer, source, target);
			await signer.start(privateBytes(40));
			await source.start();
			await target.start();
			const sourceHost = source["_node"] as InspectableHost;
			const targetHost = target["_node"] as InspectableHost;
			const signerHost = signer["_node"] as InspectableHost;
			const firstUpdate = raceEvent<CustomEvent<PeerUpdate>>(sourceHost, "peer:update", AbortSignal.timeout(2_000), {
				filter: (event) =>
					event.detail.peer.id.equals(signerHost.peerId) && event.detail.peer.peerRecordEnvelope !== undefined,
			});
			await source.safeDial(signer.getMultiaddrs()[0]);
			const firstRecord = (await firstUpdate).detail.peer;
			const firstEnvelope = firstRecord.peerRecordEnvelope;
			if (firstEnvelope === undefined) throw new Error("identify did not produce a signed peer record");
			await expect(
				targetHost.peerStore.consumePeerRecord(firstEnvelope, { expectedPeer: signerHost.peerId })
			).resolves.toBe(true);
			expect(snapshot(target)).toMatchObject({ selected: 1 });

			await expect(
				targetHost.peerStore.consumePeerRecord(firstEnvelope, { expectedPeer: signerHost.peerId })
			).resolves.toBe(false);
			await targetHost.peerStore.merge(peer(41), {
				addresses: [{ isCertified: false, multiaddr: address(peer(41), 32_041) }],
			});
			await targetHost.peerStore.merge(signerHost.peerId, {
				addresses: [{ isCertified: false, multiaddr: address(signerHost.peerId, 32_042) }],
			});
			expect(snapshot(target)).toMatchObject({ selected: 1 });

			await targetHost.components.connectionManager.openConnection(signerHost.peerId);
			expect(snapshot(target)).toMatchObject({ selected: 0 });
			const signerStopTime = Date.now();
			await signer.stop();
			await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(signerStopTime), { interval: 1, timeout: 100 });
			await signer.start(privateBytes(40));
			const restartedSigner = signer["_node"] as InspectableHost;
			const updatedRecordPromise = raceEvent<CustomEvent<PeerUpdate>>(
				sourceHost,
				"peer:update",
				AbortSignal.timeout(2_000),
				{
					filter: (event) =>
						event.detail.peer.id.equals(restartedSigner.peerId) &&
						event.detail.peer.peerRecordEnvelope !== undefined &&
						!event.detail.peer.peerRecordEnvelope.every(
							(byte, index) => byte === firstRecord.peerRecordEnvelope?.[index]
						),
				}
			);
			await source.safeDial(signer.getMultiaddrs()[0]);
			const updatedRecord = (await updatedRecordPromise).detail.peer;
			const updatedEnvelope = updatedRecord.peerRecordEnvelope;
			if (updatedEnvelope === undefined) throw new Error("identify update did not include a signed peer record");
			await expect(
				targetHost.peerStore.consumePeerRecord(updatedEnvelope, { expectedPeer: restartedSigner.peerId })
			).resolves.toBe(true);
			expect(snapshot(target)).toMatchObject({ selected: 1 });

			const failedTarget = new DRPNetworkNode(config(2, 1, 2), {
				hostPolicy: { ...quietPolicy, denyDialMultiaddr: (): true => true },
			});
			running.push(failedTarget);
			await failedTarget.start();
			const failedHost = failedTarget["_node"] as InspectableHost;
			vi.useFakeTimers();
			await expect(
				failedHost.peerStore.consumePeerRecord(firstEnvelope, { expectedPeer: signerHost.peerId })
			).resolves.toBe(true);
			await failedHost.components.connectionManager.openConnection(signerHost.peerId).catch(() => undefined);
			expect(snapshot(failedTarget)).toMatchObject({ charged: 1, selected: 0 });
			await expect(
				failedHost.peerStore.consumePeerRecord(firstEnvelope, { expectedPeer: signerHost.peerId })
			).resolves.toBe(false);
			await vi.advanceTimersByTimeAsync(60_000);
			vi.useRealTimers();
			expect(snapshot(failedTarget)).toMatchObject({ charged: 0, selected: 0 });
			await expectDirectPrequeueDenied(failedHost, signerHost.peerId);
			await expect(
				failedHost.peerStore.consumePeerRecord(firstEnvelope, { expectedPeer: signerHost.peerId })
			).resolves.toBe(false);
			expect(snapshot(failedTarget)).toMatchObject({ charged: 0, selected: 0 });
			assertClosedSnapshot(snapshot(target));
		}
	);

	test.skipIf(!selectorRuntimeInstalled)(
		"retains charged failures through the existing deadline and clears all transient state on restart",
		async () => {
			vi.useFakeTimers();
			const node = new DRPNetworkNode(config(3, 1, 3), {
				hostPolicy: { ...quietPolicy, denyDialMultiaddr: (): true => true },
			});
			running.push(node);
			await node.start();
			const id = peer(50);
			await node.safeDial(address(id, 33_050)).catch(() => undefined);
			expect(snapshot(node)).toMatchObject({ charged: 1 });
			await vi.advanceTimersByTimeAsync(59_999);
			expect(snapshot(node)).toMatchObject({ charged: 1 });
			await vi.advanceTimersByTimeAsync(1);
			expect(snapshot(node)).toMatchObject({ charged: 0 });
			vi.useRealTimers();

			await node.restart(config(2, 1, 2));
			expect(snapshot(node)).toMatchObject({ budget: 2, charged: 0, queued: 0, selected: 0, upgrade: 0 });
		}
	);

	test.skipIf(!selectorRuntimeInstalled)(
		"keeps explicit ticket cleanup bounded across success, denial, signal and timeout",
		async () => {
			const node = new DRPNetworkNode(config(8, 2, 8), { hostPolicy: quietPolicy });
			running.push(node);
			await node.start();
			const host = node["_node"] as InspectableHost;
			const dial = vi.spyOn(host, "dial");
			const routes = [51, 52, 53, 54].map((index) => multiaddr(`/ip4/127.0.0.1/tcp/${33_000 + index}`));

			dial.mockResolvedValueOnce({} as Connection);
			await expect(node.safeDial(routes[0], host)).resolves.toBeDefined();
			await expectDirectPrequeueDenied(host, routes[0]);

			dial.mockRejectedValueOnce(new Error("controlled dial denial"));
			await expect(node.safeDial(routes[1], host)).rejects.toThrow("controlled dial denial");
			await expectDirectPrequeueDenied(host, routes[1]);

			dial.mockImplementationOnce((_target, options) => Promise.reject(options?.signal?.reason));
			await expect(
				node.safeDial(routes[2], host, AbortSignal.abort(new DOMException("cancelled", "AbortError")))
			).rejects.toThrow();
			await expectDirectPrequeueDenied(host, routes[2]);

			dial.mockImplementationOnce(
				(_target, options) =>
					new Promise<Connection>((_resolve, reject) => {
						const signal = options?.signal;
						if (signal?.aborted === true) return reject(signal.reason);
						signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
					})
			);
			await expect(node.safeDial(routes[3], host, AbortSignal.timeout(5))).rejects.toThrow();
			await expectDirectPrequeueDenied(host, routes[3]);

			const afterCleanup = snapshot(node);
			assertClosedSnapshot(afterCleanup);
			expect(afterCleanup).toMatchObject({ queued: 0, selected: 0 });
		}
	);

	test.skipIf(!selectorRuntimeInstalled)(
		"routes room, sync, peerless-upgrade and ordered circuit calls through exact explicit custody",
		async () => {
			let host: InspectableHost | undefined;
			const node = new DRPNetworkNode(config(8, 2, 8), {
				hostFactory: async (context): Promise<InspectableHost> => {
					host = (await context.createHost()) as InspectableHost;
					return host;
				},
				hostPolicy: { ...quietPolicy, denyDialMultiaddr: (): true => true },
			});
			running.push(node);
			await node.start();
			if (host === undefined) throw new Error("expected explicit-path host");

			await node.sendMessage(
				peer(70).toString(),
				Message.create({ data: new Uint8Array(), objectId: "t3-room", sender: node.peerId, type: 0 })
			);
			await node
				.sendSyncMessage(
					peer(71).toString(),
					() =>
						Message.create({
							data: new Uint8Array(),
							objectId: "t3-sync",
							sender: node.peerId,
							type: MessageType.MESSAGE_TYPE_SYNC,
						}),
					{ signal: AbortSignal.timeout(100) }
				)
				.catch(() => undefined);

			const relay = peer(72);
			const destination = peer(73);
			const circuitRoute = multiaddr(`/ip4/127.0.0.1/tcp/35072/p2p/${relay}/p2p-circuit/p2p/${destination}`);
			await node.safeDial(circuitRoute, host, AbortSignal.timeout(100)).catch(() => undefined);
			expect(snapshot(node)).toMatchObject({ charged: 3, selected: 0 });

			const outbound = host.components.connectionGater.denyOutboundUpgradedConnection;
			if (outbound === undefined) throw new Error("expected final outbound upgrade gate");
			const peerlessRoute = multiaddr("/ip4/127.0.0.1/tcp/35074");
			const peerlessDestination = peer(74);
			let upgradeDenied: boolean | undefined;
			const upgradedConnection = {
				remoteAddr: peerlessRoute,
				remotePeer: peerlessDestination,
			} as Connection;
			const controlledHost = {
				dial: async (): Promise<Connection> => {
					upgradeDenied = await outbound(peerlessDestination, upgradedConnection);
					return upgradedConnection;
				},
			} as unknown as Libp2p;
			await expect(node.safeDial(peerlessRoute, controlledHost)).resolves.toBe(upgradedConnection);
			expect(upgradeDenied).toBe(false);
			expect(snapshot(node)).toMatchObject({ charged: 3, selected: 0, upgrade: 1 });
			assertClosedSnapshot(snapshot(node));
		}
	);

	test.skipIf(!selectorRuntimeInstalled)(
		"authorizes native bootstrap, genuine already-live DCUtR and KEEP_ALIVE reconnect without raw queue access",
		async () => {
			const remote = new DRPNetworkNode(
				{
					bootstrap_peers: [],
					listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
					log_config: { level: "silent" },
				} as never,
				{ hostPolicy: quietPolicy }
			);
			running.push(remote);
			await remote.start();
			const target = new DRPNetworkNode(
				{
					...config(4, 1, 4),
					bootstrap_peers: remote.getMultiaddrs(),
				} as never,
				{
					hostPolicy: { ...quietPolicy, bootstrapDiscovery: true },
				}
			);
			running.push(target);
			const configuredBootstrapDial = vi.spyOn(target, "safeDial");
			await target.start();
			const targetHost = target["_node"] as InspectableHost;
			const remoteId = remote["_node"]?.peerId;
			if (remoteId === undefined) throw new Error("expected remote peer");
			await raceEvent(targetHost, "connection:open", AbortSignal.timeout(2_500), {
				filter: (event: CustomEvent<{ remotePeer: PeerId }>) => event.detail.remotePeer.equals(remoteId),
			});
			expect(configuredBootstrapDial).toHaveBeenCalledWith(
				multiaddr(remote.getMultiaddrs()[0]),
				expect.anything(),
				expect.any(AbortSignal)
			);
			expect(snapshot(target)).toMatchObject({ live: 1 });

			const remotePort = /\/tcp\/(\d+)/u.exec(remote.getMultiaddrs()[0])?.[1];
			if (remotePort === undefined) throw new Error("expected remote TCP port");
			await targetHost.peerStore.merge(remoteId, {
				multiaddrs: [multiaddr(`/dns4/localhost/tcp/${remotePort}/ws/p2p/${remoteId}`)],
			});
			const directConnection = targetHost.getConnections(remoteId)[0];
			if (directConnection === undefined) throw new Error("expected bootstrap connection");
			const closeRelayed = vi.fn(() => Promise.resolve());
			const relayedConnection = new Proxy(directConnection, {
				get(targetConnection, property, receiver): unknown {
					if (property === "close") return closeRelayed;
					if (property === "remoteAddr") {
						return multiaddr(`/p2p/${peer(55)}/p2p-circuit/p2p/${remoteId}`);
					}
					return Reflect.get(targetConnection, property, receiver) as unknown;
				},
			});
			const dcutr = targetHost.services.dcutr;
			if (dcutr === undefined) throw new Error("expected genuine DCUtR service");
			await expect(dcutr.attemptUnilateralConnectionUpgrade(relayedConnection)).resolves.toBe(true);
			expect(closeRelayed).toHaveBeenCalledOnce();
			expect(targetHost.getConnections(remoteId)).toHaveLength(2);
			expect(snapshot(target)).toMatchObject({ live: 2 });
			await targetHost.peerStore.merge(remoteId, { tags: { [KEEP_ALIVE]: { value: 100 } } });
			await remote.stop();
			await vi.waitFor(() => expect(snapshot(target).charged).toBe(1), { timeout: 2_000 });
			assertClosedSnapshot(snapshot(target));
		}
	);

	test.skipIf(!selectorRuntimeInstalled)(
		"routes the real default relay-policy client through one explicit candidate lease",
		async () => {
			const relay = new DRPNetworkNode(
				{
					bootstrap_peers: [],
					listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
					log_config: { level: "silent" },
					relay_service: { enabled: true },
				} as never,
				{ hostPolicy: quietPolicy }
			);
			running.push(relay);
			await relay.start();
			const relayAddress = relay.getMultiaddrs()[0];
			const defaultClientDialTargets: string[] = [];
			const node = new DRPNetworkNode(
				{
					...config(4, 1, 4),
					control_plane: {
						peer_selection: { expected_replicas: 4 },
						relay_policy: {
							per_candidate_deadline_ms: 2_000,
							sources: { configured_relays: [relayAddress] },
							target_reservations: 1,
							total_deadline_ms: 4_000,
						},
					},
				} as never,
				{
					hostFactory: async (context): Promise<InspectableHost> => {
						const host = (await context.createHost()) as InspectableHost;
						const dial = host.dial.bind(host);
						vi.spyOn(host, "dial").mockImplementation(async (target, options) => {
							defaultClientDialTargets.push(target.toString());
							return dial(target, options);
						});
						return host;
					},
					hostPolicy: quietPolicy,
				}
			);
			running.push(node);
			await node.start();
			await node.retryRelayPolicyAcquisition();
			expect(defaultClientDialTargets).toContain(relayAddress);
			expect(node.getMultiaddrs().some((candidate) => candidate.includes(`/p2p/${relay.peerId}/p2p-circuit`))).toBe(
				true
			);
			const value = snapshot(node);
			assertClosedSnapshot(value);
			expect(value).toMatchObject({ live: 1 });
		}
	);

	test.skipIf(!selectorRuntimeInstalled)(
		"keeps the installed circuit-relay reservation dial inside the same selector and connection census",
		async () => {
			const relay = new DRPNetworkNode(
				{
					bootstrap_peers: [],
					listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
					log_config: { level: "silent" },
					relay_service: { enabled: true },
				} as never,
				{ hostPolicy: quietPolicy }
			);
			running.push(relay);
			await relay.start();
			const relayAddress = relay.getMultiaddrs().find((candidate) => candidate.includes("/ws/p2p/"));
			if (relayAddress === undefined) throw new Error("relay did not expose a WebSocket address");

			const client = new DRPNetworkNode(
				{
					...config(4, 1, 4),
					listen_addresses: [`${relayAddress}/p2p-circuit`],
				} as never,
				{ hostPolicy: quietPolicy }
			);
			running.push(client);
			await client.start();
			await vi.waitFor(
				() =>
					expect(
						client.getMultiaddrs().some((candidate) => candidate.includes(`/p2p/${relay.peerId}/p2p-circuit`))
					).toBe(true),
				{ timeout: 3_000 }
			);
			const value = snapshot(client);
			assertClosedSnapshot(value);
			expect(value).toMatchObject({ live: 1 });
		}
	);

	test.skipIf(!selectorRuntimeInstalled)(
		"partitions remote records by terminal peer while malformed and peerless groups remain denied",
		async () => {
			const node = new DRPNetworkNode(config(4, 1, 4), {
				hostPolicy: { ...quietPolicy, denyDialMultiaddr: (): true => true },
			});
			running.push(node);
			await node.start();
			const first = peer(60);
			const second = peer(61);
			const relay = peer(62);
			await node.connect([
				multiaddr(`/ip4/127.0.0.1/tcp/34060/p2p/${relay}/p2p-circuit/p2p/${first}`),
				multiaddr(`/ip4/127.0.0.1/tcp/34061/p2p/${relay}/p2p-circuit/p2p/${second}`),
				multiaddr("/ip4/127.0.0.1/tcp/34062"),
			]);

			const value = snapshot(node);
			assertClosedSnapshot(value);
			expect(value.charged).toBe(2);
			expect(value.denied).toBeGreaterThan(0);
		}
	);
});
