// Track 46: a failed direct send is never silent. The discovery response is best effort, but a send
// that fails must reach the handler's error report instead of vanishing in an empty catch.
// (unit.test.ts in this directory cannot load in the sandbox: it imports @libp2p/crypto/keys, which
// this package does not depend on. This file needs nothing outside the package's own imports.)
import { DRPDiscovery, type DRPNetworkNode, Message, MessageType } from "@ts-drp/types";
import { expect, test, vi } from "vitest";

import { DRPIntervalDiscovery } from "../src/index.js";

test("reports a failed discovery response instead of dropping it", async () => {
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
	const failure = Object.assign(new Error("Could not dial direct-message peer"), {
		name: "DirectMessageSendError",
		code: "DIRECT_DIAL_FAILED",
	});
	const networkNode = {
		peerId: "local-peer",
		getGroupPeers: vi.fn().mockReturnValue(["peer1"]),
		getSubscribedTopics: vi.fn().mockReturnValue([]),
		getPeerMultiaddrs: vi
			.fn()
			.mockResolvedValue([{ multiaddr: { toString: (): string => "/ip4/127.0.0.1/tcp/1234" } }]),
		sendMessage: vi.fn().mockRejectedValue(failure),
	} as unknown as DRPNetworkNode;
	try {
		await DRPIntervalDiscovery.handleDiscoveryRequest(
			"sender",
			Message.create({
				sender: "sender",
				type: MessageType.MESSAGE_TYPE_DRP_DISCOVERY,
				data: DRPDiscovery.encode(DRPDiscovery.create({})).finish(),
				objectId: "test-id",
			}),
			networkNode
		);
		expect(networkNode.sendMessage).toHaveBeenCalledOnce();
		expect(consoleError.mock.calls.flat()).toContain(failure);
	} finally {
		consoleError.mockRestore();
	}
});
