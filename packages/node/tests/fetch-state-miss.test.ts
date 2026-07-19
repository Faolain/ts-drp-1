import { FetchState, FetchStateResponse, Message, MessageType, NodeEventName } from "@ts-drp/types";
import { describe, expect, test, vi } from "vitest";

import { handleMessage } from "../src/handlers.js";
import { type DRPNode } from "../src/index.js";

describe("fetch-state snapshot misses", () => {
	test("returns absent optional states for a pruned non-root hash", async () => {
		const sent: Message[] = [];
		const sendMessage = vi.fn((_recipient: string, message: Message) => {
			sent.push(message);
			return Promise.resolve();
		});
		const object = { id: "object", getStates: vi.fn(() => [undefined, undefined]) };
		const node = {
			get: vi.fn(() => object),
			networkNode: { peerId: "receiver", sendMessage },
			safeDispatchEvent: vi.fn(),
		} as unknown as DRPNode;
		const request = Message.create({
			sender: "requester",
			type: MessageType.MESSAGE_TYPE_FETCH_STATE,
			objectId: object.id,
			data: FetchState.encode(FetchState.create({ vertexHash: "pruned-hash" })).finish(),
		});

		await handleMessage(node, request);
		expect(sendMessage).toHaveBeenCalledOnce();
		const responseMessage = sent[0];
		const response = FetchStateResponse.decode(responseMessage.data);
		expect(response.vertexHash).toBe("pruned-hash");
		expect(response.aclState).toBeUndefined();
		expect(response.drpState).toBeUndefined();
		expect(node.safeDispatchEvent).toHaveBeenCalledWith(NodeEventName.DRP_FETCH_STATE, expect.any(Object));
	});
});
