import { type GossipSub } from "@libp2p/gossipsub";
import { type Libp2p } from "@libp2p/interface";
import { DRPNetworkNode } from "@ts-drp/network";
import { type DRPNetworkNode as DRPNetworkNodeInterface } from "@ts-drp/types";

/**
 * Narrow a structural network to the production implementation in integration-only diagnostics.
 * @param networkNode - Network under test
 * @returns The production implementation
 */
export function defaultNetworkOf(networkNode: DRPNetworkNodeInterface): DRPNetworkNode {
	if (!(networkNode instanceof DRPNetworkNode)) {
		throw new Error("Integration diagnostic requires the production DRPNetworkNode");
	}
	return networkNode;
}

/**
 * Read the started libp2p host from a production network in an integration test.
 * @param networkNode - Network under test
 * @returns Its started libp2p host
 */
export function libp2pOf(networkNode: DRPNetworkNodeInterface): Libp2p {
	const host = defaultNetworkOf(networkNode)["_node"];
	if (!host) throw new Error("DRPNetworkNode has not started its libp2p host");
	return host;
}

/**
 * Read the production GossipSub service in an integration test.
 * @param networkNode - Network under test
 * @returns Its started GossipSub service
 */
export function gossipSubOf(networkNode: DRPNetworkNodeInterface): GossipSub {
	const pubsub = defaultNetworkOf(networkNode)["_pubsub"];
	if (!pubsub) throw new Error("DRPNetworkNode has not started GossipSub");
	return pubsub;
}
