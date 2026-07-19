import {
	AttestationUpdate,
	FetchState,
	FetchStateResponse,
	Message,
	MessageType,
	Sync,
	SyncAccept,
	Update,
} from "@ts-drp/types";
import { describe, expect, test, vi } from "vitest";

import { handleMessage } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";

describe("object message handling", () => {
	test("ignores every object-scoped message type when its object is no longer subscribed", async () => {
		const node = new DRPNode({ log_config: { level: "silent" } });
		const get = vi.spyOn(node, "get");
		const send = vi.spyOn(node.networkNode, "sendMessage").mockResolvedValue();
		const broadcast = vi.spyOn(node.networkNode, "broadcastMessage").mockResolvedValue();
		const dispatch = vi.spyOn(node, "safeDispatchEvent");
		const messages = [
			Message.create({
				sender: "stale-peer",
				type: MessageType.MESSAGE_TYPE_FETCH_STATE,
				objectId: "missing-object",
				data: FetchState.encode(FetchState.create({ vertexHash: "missing-vertex" })).finish(),
			}),
			Message.create({
				sender: "stale-peer",
				type: MessageType.MESSAGE_TYPE_FETCH_STATE_RESPONSE,
				objectId: "missing-object",
				data: FetchStateResponse.encode(FetchStateResponse.create({ vertexHash: "missing-vertex" })).finish(),
			}),
			Message.create({
				sender: "stale-peer",
				type: MessageType.MESSAGE_TYPE_ATTESTATION_UPDATE,
				objectId: "missing-object",
				data: AttestationUpdate.encode(AttestationUpdate.create()).finish(),
			}),
			Message.create({
				sender: "stale-peer",
				type: MessageType.MESSAGE_TYPE_UPDATE,
				objectId: "missing-object",
				data: Update.encode(Update.create()).finish(),
			}),
			Message.create({
				sender: "stale-peer",
				type: MessageType.MESSAGE_TYPE_SYNC,
				objectId: "missing-object",
				data: Sync.encode(Sync.create()).finish(),
			}),
			Message.create({
				sender: "stale-peer",
				type: MessageType.MESSAGE_TYPE_SYNC_ACCEPT,
				objectId: "missing-object",
				data: SyncAccept.encode(SyncAccept.create()).finish(),
			}),
		];

		for (const [index, message] of messages.entries()) {
			await handleMessage(node, message);
			expect(get).toHaveBeenCalledTimes(index + 1);
			expect(get).toHaveBeenLastCalledWith("missing-object");
			expect(send).not.toHaveBeenCalled();
			expect(broadcast).not.toHaveBeenCalled();
			expect(dispatch).not.toHaveBeenCalled();
		}
	});
});
