import type { Libp2p } from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";
import type { RelayPolicyResult, RelayReplacementResult } from "@ts-drp/relay-policy";
import type { DRPNetworkNodeConfig } from "@ts-drp/types";
import { afterEach, describe, expect, it } from "vitest";

import { DRPNetworkNode, type RelayPolicyDriver } from "../src/node.js";

const PEER_ID = "QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN";
const RELAY_ADDRESS = `/dns4/configured-public.example.test/tcp/443/wss/p2p/${PEER_ID}`;
const LEGACY_DEFAULT_LISTEN = ["/p2p-circuit", "/webrtc"];

interface ListenAddressHost extends Libp2p {
	components: {
		addressManager: {
			getListenAddrs(): Multiaddr[];
		};
	};
}

describe("DRPNetworkNode relay-policy listen addresses", () => {
	const startedNodes: DRPNetworkNode[] = [];

	afterEach(async () => {
		await Promise.allSettled(startedNodes.splice(0).map((node) => node.stop()));
	});

	it("omits the generic circuit listener from defaults when relay policy will run", async () => {
		const node = createNode(policyConfig());
		startedNodes.push(node);

		await node.start();

		expect(listenAddresses(node)).toEqual(["/webrtc"]);
	});

	it("preserves legacy default listeners when relay policy will not run", async () => {
		const node = createNode({ bootstrap_peers: [], log_config: { level: "silent" } });
		startedNodes.push(node);

		await node.start();

		expect(listenAddresses(node)).toEqual(LEGACY_DEFAULT_LISTEN);
	});

	it("respects explicit listeners verbatim when relay policy will run", async () => {
		const explicitListen = ["/webrtc", "/p2p-circuit"];
		const node = createNode({ ...policyConfig(), listen_addresses: explicitListen });
		startedNodes.push(node);

		await node.start();

		expect(listenAddresses(node)).toEqual(explicitListen);
	});
});

function createNode(config: DRPNetworkNodeConfig): DRPNetworkNode {
	return new DRPNetworkNode(config, { relayPolicyFactory: (): RelayPolicyDriver => idlePolicy() });
}

function listenAddresses(node: DRPNetworkNode): string[] {
	const host = node["_node"] as ListenAddressHost | undefined;
	if (host === undefined) throw new Error("expected a started libp2p host");
	return host.components.addressManager.getListenAddrs().map((address) => address.toString());
}

function policyConfig(): DRPNetworkNodeConfig {
	return {
		bootstrap_peers: [],
		control_plane: {
			relay_policy: {
				sources: { configured_relays: [RELAY_ADDRESS] },
				target_reservations: 1,
			},
		},
		log_config: { level: "silent" },
	};
}

function idlePolicy(): RelayPolicyDriver {
	return {
		acquire: (): Promise<RelayPolicyResult> => Promise.resolve(exhausted()),
		refresh: (): Promise<RelayPolicyResult> => Promise.resolve(exhausted()),
		replace: (peerId, reason): Promise<RelayReplacementResult> =>
			Promise.resolve({ ...exhausted(), reason, replacedPeerId: peerId }),
		stop: (): Promise<void> => Promise.resolve(),
	};
}

function exhausted(): RelayPolicyResult {
	return {
		attempts: [],
		candidatesObserved: 0,
		durationMs: 0,
		operatorGroups: [],
		reservations: [],
		terminal: "exhausted",
	};
}
