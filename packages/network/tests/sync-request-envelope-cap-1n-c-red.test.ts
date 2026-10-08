/**
 * Phase 1n-c corrective RED: the request-byte ceiling covers the complete
 * encoded Message envelope, not only its inner Sync bytes. The oversized
 * object id below is malformed hostile input, not a supported identity form.
 */
import { Message, MessageType, Sync } from "@ts-drp/types";
import { type Libp2p } from "libp2p";
import { afterEach, describe, expect, test } from "vitest";

import {
	DRP_HEADS_CHUNK_PROTOCOL,
	DRP_MESSAGE_PROTOCOL,
	DRPNetworkNode,
	type NegotiatedSyncSender,
	type SelectedSyncProtocol,
	SYNC_REQUEST_BYTE_CAP,
} from "../src/node.js";

interface DirectSyncIngress {
	readonly message: Message;
	readonly mode: "fallback" | "heads-chunk";
	readonly peerId: string;
	readonly protocol: string;
	readonly transport: "direct";
}

const config = {
	bootstrap_peers: [],
	listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
	log_config: { level: "silent" as const },
};

function makeNode(): DRPNetworkNode {
	return new DRPNetworkNode(config, {
		hostPolicy: {
			bootstrapDiscovery: false,
			coldStartPubsubDiscovery: false,
			gossipSubPeerExchange: false,
		},
	});
}

function host(node: DRPNetworkNode): Libp2p {
	const value = node["_node"];
	if (value === undefined) throw new Error("Expected a started production libp2p host");
	return value;
}

function subscribeToAdmission(node: DRPNetworkNode, admissions: DirectSyncIngress[]): void {
	const productionQueue = node as unknown as {
		subscribeToMessageQueue(handler: (ingress: DirectSyncIngress) => void): void;
	};
	productionQueue.subscribeToMessageQueue((ingress) => admissions.push(ingress));
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function requestFor(selection: SelectedSyncProtocol, objectId: string): Message {
	const sync =
		selection.mode === "heads-chunk"
			? Sync.create({ heads: ["ordinary-head"] })
			: Sync.create({ vertexHashes: ["ordinary-fallback-hash"] });
	return Message.create({
		data: Sync.encode(sync).finish(),
		objectId,
		type: MessageType.MESSAGE_TYPE_SYNC,
	});
}

describe("Phase 1n-c complete encoded sync request cap", () => {
	const running: DRPNetworkNode[] = [];

	afterEach(async () => {
		await Promise.allSettled(running.splice(0).map((node) => node.stop()));
	});

	test.each([
		{ expectedCode: "SYNC_REQUEST_LIMIT", mode: "heads-chunk" },
		{ expectedCode: "SYNC_FALLBACK_LIMIT", mode: "fallback" },
	] as const)(
		"rejects an oversized $mode request envelope before central admission",
		async ({ expectedCode, mode }) => {
			const sender = makeNode();
			const receiver = makeNode();
			running.push(sender, receiver);
			await Promise.all(running.map((node) => node.start()));
			if (mode === "fallback") {
				await host(receiver).unhandle(DRP_HEADS_CHUNK_PROTOCOL);
				expect(host(receiver).getProtocols()).toContain(DRP_MESSAGE_PROTOCOL);
			}
			await sender.connect(receiver.getMultiaddrs());
			const admissions: DirectSyncIngress[] = [];
			subscribeToAdmission(receiver, admissions);

			let builtMessage: Message | undefined;
			let failure: unknown;
			try {
				await (sender as NegotiatedSyncSender).sendSyncMessage(receiver.peerId, (selection) => {
					expect(selection.mode).toBe(mode);
					// Deliberately malformed adversarial envelope input; no identity semantics are asserted.
					builtMessage = requestFor(selection, `malformed-envelope-${"x".repeat(70_000)}`);
					return builtMessage;
				});
			} catch (error) {
				failure = error;
			}

			if (builtMessage === undefined) throw new Error("Expected the selected-mode payload factory to run");
			expect(builtMessage.data.byteLength).toBeLessThanOrEqual(SYNC_REQUEST_BYTE_CAP);
			expect(Message.encode(builtMessage).finish().byteLength).toBeGreaterThan(SYNC_REQUEST_BYTE_CAP);
			if (failure === undefined) {
				await expect
					.poll(() => admissions.length, { interval: 10, timeout: 10_000, message: "causal central admission" })
					.toBe(1);
			}
			expect({ admissionCalls: admissions.length, failureCode: errorCode(failure) }).toEqual({
				admissionCalls: 0,
				failureCode: expectedCode,
			});
		}
	);

	test("admits an ordinary complete encoded request within the ceiling", async () => {
		const sender = makeNode();
		const receiver = makeNode();
		running.push(sender, receiver);
		await Promise.all(running.map((node) => node.start()));
		await sender.connect(receiver.getMultiaddrs());
		const admissions: DirectSyncIngress[] = [];
		subscribeToAdmission(receiver, admissions);

		let encodedBytes = 0;
		await (sender as NegotiatedSyncSender).sendSyncMessage(receiver.peerId, (selection) => {
			expect(selection).toEqual({ mode: "heads-chunk", protocol: DRP_HEADS_CHUNK_PROTOCOL });
			const message = requestFor(selection, `${sender.peerId}:${"04".repeat(16)}`);
			encodedBytes = Message.encode(message).finish().byteLength;
			return message;
		});

		expect(encodedBytes).toBeLessThanOrEqual(SYNC_REQUEST_BYTE_CAP);
		expect(admissions).toHaveLength(1);
		expect(admissions[0]).toMatchObject({
			mode: "heads-chunk",
			peerId: sender.peerId,
			protocol: DRP_HEADS_CHUNK_PROTOCOL,
			transport: "direct",
		});
	});
});
