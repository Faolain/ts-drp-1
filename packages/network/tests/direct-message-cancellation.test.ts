import { Message, MessageType } from "@ts-drp/types";
import { afterEach, expect, it, vi } from "vitest";

import { DRPNetworkNode } from "../src/node.js";

afterEach(() => vi.restoreAllMocks());

it("keeps the direct-message abort signal attached while dialing", async () => {
	const node = new DRPNetworkNode({ bootstrap_peers: [], listen_addresses: [], log_config: { level: "silent" } });
	const controller = new AbortController();
	const failure = new Error("cancel the owned direct-message dial");
	let receivedSignal: AbortSignal | undefined;
	let release: (() => void) | undefined;
	vi.spyOn(node, "safeDial").mockImplementation((_peer, _host, signal) => {
		receivedSignal = signal;
		return new Promise((_resolve, reject) => {
			release = () => reject(failure);
			signal?.addEventListener("abort", release, { once: true });
		});
	});
	const sending = node
		.sendMessage(
			"16Uiu2HAmTY71bbCHtmYD3nvVKUGbk7NWqLBbPFNng4jhaXJHi3W5",
			Message.create({ type: MessageType.MESSAGE_TYPE_CUSTOM, objectId: "room", data: Uint8Array.of(1) }),
			{ signal: controller.signal }
		)
		.catch((error: unknown) => error);
	try {
		expect(receivedSignal).toBe(controller.signal);
		controller.abort(failure);
		expect(await sending).toBe(failure);
	} finally {
		controller.abort(failure);
		release?.();
		await sending;
	}
});
