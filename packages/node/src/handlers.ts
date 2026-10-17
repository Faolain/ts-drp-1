import { DRPIntervalDiscovery } from "@ts-drp/interval-discovery";
import { type Message, MessageType } from "@ts-drp/types";

import { type DRPNode } from "./index.js";

/**
 * Handle only retained protocol-neutral discovery transport. Native Node
 * dispatch already applied the sole raw structural eligibility law. Ordinary
 * V3 operation admission belongs to the room/live owner, never this helper.
 * @param node Native current-only transport node.
 * @param message Identity-bound message admitted by native dispatch.
 */
export async function handleMessage(node: DRPNode, message: Message): Promise<void> {
	if (message.type === MessageType.MESSAGE_TYPE_DRP_DISCOVERY)
		await DRPIntervalDiscovery.handleDiscoveryRequest(message.sender, message, node.networkNode);
	// Responses have no obsolete object interval to revive. Current V3 retained
	// history repair and snapshot transfer use their own authenticated room port.
}
