import { SetDRP } from "@ts-drp/blueprints";
import { DRPObject } from "@ts-drp/object";
import { MessageType } from "@ts-drp/types";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { DRPNode } from "../src/index.js";

describe("DRPNode public messaging and subscription API", () => {
	let node: DRPNode;

	beforeEach(() => {
		node = new DRPNode({ log_config: { level: "silent" } });
		node.networkNode.peerId = "peer-a";
	});

	test("delegates a custom group to the network exactly once", () => {
		const subscribeGroup = vi.spyOn(node.networkNode, "subscribe").mockImplementation(() => undefined);

		node.addCustomGroup("custom-group");

		expect(subscribeGroup).toHaveBeenCalledOnce();
		expect(subscribeGroup).toHaveBeenCalledWith("custom-group");
	});

	test("sends custom group and peer messages with the caller's bytes and node identity", async () => {
		let resolveBroadcast: (() => void) | undefined;
		const broadcastPending = new Promise<void>((resolve) => {
			resolveBroadcast = resolve;
		});
		const broadcast = vi.spyOn(node.networkNode, "broadcastMessage").mockReturnValue(broadcastPending);
		let resolveSend: (() => void) | undefined;
		const sendPending = new Promise<void>((resolve) => {
			resolveSend = resolve;
		});
		const send = vi.spyOn(node.networkNode, "sendMessage").mockReturnValue(sendPending);
		const groupData = Uint8Array.from([1, 2, 3]);
		const peerData = Uint8Array.from([4, 5, 6]);

		let groupSettled = false;
		const groupRequest = node.sendGroupMessage("custom-group", groupData).then(() => {
			groupSettled = true;
		});
		await Promise.resolve();

		expect(broadcast).toHaveBeenCalledOnce();
		expect(send).not.toHaveBeenCalled();
		expect(groupSettled).toBe(false);
		const groupMessage = broadcast.mock.calls[0][1];
		expect(broadcast.mock.calls[0][0]).toBe("custom-group");
		expect(groupMessage.sender).toBe("peer-a");
		expect(groupMessage.type).toBe(MessageType.MESSAGE_TYPE_CUSTOM);
		expect(groupMessage.data).toBe(groupData);
		resolveBroadcast?.();
		await groupRequest;
		expect(groupSettled).toBe(true);

		let peerSettled = false;
		const peerRequest = node.sendCustomMessage("peer-b", peerData).then(() => {
			peerSettled = true;
		});
		await Promise.resolve();

		expect(send).toHaveBeenCalledOnce();
		expect(broadcast).toHaveBeenCalledOnce();
		expect(peerSettled).toBe(false);
		const peerMessage = send.mock.calls[0][1];
		expect(send.mock.calls[0][0]).toBe("peer-b");
		expect(peerMessage.sender).toBe("peer-a");
		expect(peerMessage.type).toBe(MessageType.MESSAGE_TYPE_CUSTOM);
		expect(peerMessage.data).toBe(peerData);
		resolveSend?.();
		await peerRequest;
		expect(peerSettled).toBe(true);
	});

	test("notifies matching object subscribers synchronously with the stored object", () => {
		let putReturned = false;
		const callback = vi.fn(() => {
			expect(putReturned).toBe(false);
		});
		const object = new DRPObject({ peerId: "peer-a", drp: new SetDRP<number>() });
		node.subscribe("object-a", callback);
		node.put("object-a", object);
		putReturned = true;

		expect(callback).toHaveBeenCalledOnce();
		expect(callback).toHaveBeenCalledWith("object-a", object);
	});
});
