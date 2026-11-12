/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test helpers keep their inferred shapes. */
// Track 46 (network stream reuse): direct messages ride one long-lived, credit-flow-controlled stream
// per (connection, traffic class) instead of one libp2p stream per message, and a failed direct send
// is never silent. Two genuine DRPNetworkNodes on localhost WebSocket.
//
// Protocol ids are spelled out here (not imported) so this file states the wire contract on its own:
//   /drp/message/1.0.0/session/rt    frames <= 16 KiB (moves, room control, ephemeral fallback)
//   /drp/message/1.0.0/session/bulk  larger frames (successor offers, large replay rows)
//   /drp/message/0.0.1               legacy: one frame per stream, kept for old peers
import type { Connection, Libp2p, Stream } from "@libp2p/interface";
import { lpStream } from "@libp2p/utils";
import { Message, MessageType, Sync } from "@ts-drp/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DRPNetworkNode } from "../src/node.js";

const RT = "/drp/message/1.0.0/session/rt";
const BULK = "/drp/message/1.0.0/session/bulk";
const LEGACY = "/drp/message/0.0.1";
const UNREACHABLE = "16Uiu2HAmTY71bbCHtmYD3nvVKUGbk7NWqLBbPFNng4jhaXJHi3W5";

const running: DRPNetworkNode[] = [];
afterEach(async () => {
	await Promise.allSettled(running.splice(0).map((node) => node.stop()));
});

function host(node: DRPNetworkNode): Libp2p {
	return (node as unknown as { _node: Libp2p })._node;
}

async function pair() {
	const nodes = [0, 1].map(
		() =>
			new DRPNetworkNode(
				{ bootstrap_peers: [], listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"], log_config: { level: "silent" } },
				{ hostPolicy: { bootstrapDiscovery: false, coldStartPubsubDiscovery: false, gossipSubPeerExchange: false } }
			)
	);
	running.push(...nodes);
	await Promise.all(nodes.map((node) => node.start()));
	const [sender, receiver] = nodes;
	await sender.connect(receiver.getMultiaddrs());
	const arrivals: string[] = [];
	const evidence = new Map<string, string | undefined>();
	let gate: Promise<void> = Promise.resolve();
	receiver.subscribeToMessageQueue(async (message: Message) => {
		await gate;
		arrivals.push(message.objectId);
		const claimed = receiver.claimIngressEvidence(message);
		evidence.set(message.objectId, claimed?.transport.kind === "authenticated-stream" ? claimed.transport.protocol : undefined);
	});
	const connection = (): Connection => {
		const selected = host(sender).getConnections(host(receiver).peerId)[0];
		if (selected === undefined) throw new Error("no connection");
		return selected;
	};
	// Count every outbound protocol stream the sender opens on this connection.
	const opened: string[] = [];
	const watched = connection();
	const original = watched.newStream.bind(watched);
	watched.newStream = (async (protocols: string | string[], options?: object) => {
		const stream = await original(protocols, options);
		opened.push(stream.protocol);
		return stream;
	}) as Connection["newStream"];
	const hold = () => {
		let release!: () => void;
		gate = new Promise<void>((resolve) => (release = resolve));
		return release;
	};
	return { sender, receiver, arrivals, evidence, opened, connection, hold };
}

function message(id: string, bytes = 200) {
	return Message.create({ type: MessageType.MESSAGE_TYPE_CUSTOM, objectId: id, data: new Uint8Array(bytes).fill(9) });
}

async function until(predicate: () => boolean, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
	return predicate();
}

type Settled = { id: string; status: "resolved" } | { id: string; status: "rejected"; error: unknown };

function track(id: string, sending: Promise<void>, settled: Settled[]) {
	return sending.then(
		() => void settled.push({ id, status: "resolved" }),
		(error: unknown) => void settled.push({ id, status: "rejected", error })
	);
}

function rejections(settled: readonly Settled[]) {
	return settled.flatMap((entry) => (entry.status === "rejected" ? [codeOf(entry.error)] : []));
}

function codeOf(error: unknown) {
	return error instanceof Error ? { name: error.name, code: (error as { code?: unknown }).code } : { error };
}

describe("direct message sessions", () => {
	it("delivers every one of eight concurrent direct messages to one peer", { timeout: 30_000 }, async () => {
		const f = await pair();
		const ids = Array.from({ length: 8 }, (_, index) => `burst-${index}`);
		const settled: Settled[] = [];
		await Promise.all(ids.map((id) => track(id, f.sender.sendMessage(f.receiver.peerId, message(id)), settled)));
		await until(() => f.arrivals.length === 8, 5_000);
		expect(rejections(settled)).toEqual([]);
		expect([...f.arrivals].sort()).toEqual([...ids].sort());
	});

	it("reuses one stream for a hundred sequential messages, in order", { timeout: 30_000 }, async () => {
		const f = await pair();
		const ids = Array.from({ length: 100 }, (_, index) => `seq-${index}`);
		for (const id of ids) await f.sender.sendMessage(f.receiver.peerId, message(id));
		await until(() => f.arrivals.length === 100);
		expect(f.arrivals).toEqual(ids);
		expect(f.opened.filter((protocol) => protocol === RT)).toHaveLength(1);
		expect(f.opened.filter((protocol) => protocol === LEGACY)).toHaveLength(0);
	});

	it("names the session protocol in the ingress evidence and splits classes by size", { timeout: 30_000 }, async () => {
		const f = await pair();
		await f.sender.sendMessage(f.receiver.peerId, message("small", 200));
		await f.sender.sendMessage(f.receiver.peerId, message("large", 64 * 1024));
		await until(() => f.arrivals.length === 2);
		expect(f.evidence.get("small")).toBe(RT);
		expect(f.evidence.get("large")).toBe(BULK);
	});

	it("a small message is not held behind a large one", { timeout: 30_000 }, async () => {
		const f = await pair();
		const large = f.sender.sendMessage(f.receiver.peerId, message("large", 3 * 1024 * 1024));
		const small = f.sender.sendMessage(f.receiver.peerId, message("small", 200));
		await Promise.all([large, small]);
		await until(() => f.arrivals.length === 2);
		expect(f.arrivals).toEqual(["small", "large"]);
	});

	it("a failed send without a signal rejects with a typed error", { timeout: 30_000 }, async () => {
		const f = await pair();
		const outcome = await f.sender.sendMessage(UNREACHABLE, message("nowhere")).then(
			() => "resolved",
			(error: unknown) => codeOf(error)
		);
		expect(outcome).toEqual({ name: "DirectMessageSendError", code: "DIRECT_DIAL_FAILED" });
	});

	it("a failed group send to a random peer rejects with a typed error", { timeout: 30_000 }, async () => {
		const f = await pair();
		vi.spyOn(f.sender, "getGroupPeers").mockReturnValue([UNREACHABLE]);
		const outcome = await f.sender.sendGroupMessageRandomPeer("group", message("group-nowhere")).then(
			() => "resolved",
			(error: unknown) => codeOf(error)
		);
		expect(outcome).toEqual({ name: "DirectMessageSendError", code: "DIRECT_DIAL_FAILED" });
	});

	it("bounds a blocked receiver: typed queue-full refusal, abort while queued, FIFO and nothing silently lost", { timeout: 120_000 }, async () => {
		const f = await pair();
		const release = f.hold();
		const settled: Settled[] = [];
		const ids = Array.from({ length: 1_200 }, (_, index) => `held-${index}`);
		// The receiver's queue (1000) and the session window fill; the next frames wait in the sender's
		// bounded queue (one of them is aborted there); the rest are refused.
		const controller = new AbortController();
		let aborted: Promise<void> | undefined;
		const sends = ids.map((id, index) => {
			if (index === 1_050)
				aborted = f.sender.sendMessage(f.receiver.peerId, message("aborted-while-queued", 100), {
					signal: controller.signal,
				});
			return track(id, f.sender.sendMessage(f.receiver.peerId, message(id, 100)), settled);
		});
		expect(await until(() => settled.some(({ status }) => status === "rejected"), 30_000)).toBe(true);
		const refusedBeforeAbort = settled.filter(({ status }) => status === "rejected").length;
		await new Promise((resolve) => setTimeout(resolve, 200));
		controller.abort(new Error("caller gave up"));
		if (aborted === undefined) throw new Error("aborted send missing");
		const abortOutcome = await aborted.then(
			() => "resolved",
			(error: unknown) => (error as Error).message
		);
		release();
		await Promise.all(sends);
		const resolved = settled.filter(({ status }) => status === "resolved").map(({ id }) => id);
		const rejected = settled.filter((entry): entry is Extract<Settled, { status: "rejected" }> => entry.status === "rejected");
		expect(abortOutcome).toBe("caller gave up");
		expect(refusedBeforeAbort).toBeGreaterThan(0);
		expect(new Set(rejected.map(({ error }) => JSON.stringify(codeOf(error))))).toEqual(
			new Set([JSON.stringify({ name: "DirectMessageSendError", code: "DIRECT_SEND_QUEUE_FULL" })])
		);
		expect(await until(() => f.arrivals.length >= resolved.length, 30_000)).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 200));
		// Every resolved send arrived exactly once, in send order; nothing else arrived.
		expect(f.arrivals).toEqual(ids.filter((id) => resolved.includes(id)));
		expect(f.arrivals).not.toContain("aborted-while-queued");
		// The receiver never overflowed and reset the session.
		expect(f.opened.filter((protocol) => protocol === RT)).toHaveLength(1);
	});

	it("rejects queued frames when the connection closes and never delivers them later", { timeout: 60_000 }, async () => {
		const f = await pair();
		const release = f.hold();
		const settled: Settled[] = [];
		const ids = Array.from({ length: 1_100 }, (_, index) => `closing-${index}`);
		const sends = ids.map((id) => track(id, f.sender.sendMessage(f.receiver.peerId, message(id, 100)), settled));
		await until(() => settled.filter(({ status }) => status === "resolved").length >= 1_000, 30_000);
		await new Promise((resolve) => setTimeout(resolve, 300));
		await f.connection().close();
		release();
		await Promise.all(sends);
		const closed = settled.filter(
			(entry) =>
				entry.status === "rejected" && JSON.stringify(codeOf(entry.error)) === JSON.stringify({ name: "DirectMessageSendError", code: "DIRECT_CONNECTION_CLOSED" })
		);
		expect(closed.length).toBeGreaterThan(0);
		await f.sender.connect(f.receiver.getMultiaddrs());
		await f.sender.sendMessage(f.receiver.peerId, message("after-reconnect"));
		await until(() => f.arrivals.includes("after-reconnect"));
		for (const { id } of closed) expect(f.arrivals).not.toContain(id);
	});

	it("reopens the session after the receiver resets it", { timeout: 30_000 }, async () => {
		const f = await pair();
		await f.sender.sendMessage(f.receiver.peerId, message("before"));
		await until(() => f.arrivals.includes("before"));
		const inbound = host(f.receiver)
			.getConnections(host(f.sender).peerId)
			.flatMap((connection) => connection.streams)
			.find((stream: Stream) => stream.protocol === RT && stream.direction === "inbound");
		expect(inbound).toBeDefined();
		inbound?.abort(new Error("receiver reset"));
		await new Promise((resolve) => setTimeout(resolve, 100));
		for (let index = 0; index < 5; index++) await f.sender.sendMessage(f.receiver.peerId, message(`after-${index}`));
		await until(() => f.arrivals.includes("after-4"));
		expect(f.arrivals.filter((id) => id.startsWith("after-"))).toEqual(["after-0", "after-1", "after-2", "after-3", "after-4"]);
		expect(f.opened.filter((protocol) => protocol === RT)).toHaveLength(2);
	});

	it("refuses a sync-family frame and an oversized frame on the realtime session", { timeout: 30_000 }, async () => {
		const f = await pair();
		const write = async (frame: Uint8Array) => {
			const stream = await f.connection().newStream(RT);
			const lp = lpStream(stream);
			await lp.write(frame).catch(() => undefined);
			await until(() => stream.status !== "open", 2_000);
			return stream.status;
		};
		const sync = Message.create({
			type: MessageType.MESSAGE_TYPE_SYNC,
			objectId: "sync-on-session",
			data: Sync.encode(Sync.create({ vertexHashes: [] })).finish(),
		});
		expect(await write(Message.encode(sync).finish())).not.toBe("open");
		expect(await write(Message.encode(message("oversized-on-rt", 20 * 1024)).finish())).not.toBe("open");
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(f.arrivals).not.toContain("sync-on-session");
		expect(f.arrivals).not.toContain("oversized-on-rt");
	});
});

describe("direct message compatibility", () => {
	it("a new sender delivers a burst to an old receiver over the legacy protocol", { timeout: 30_000 }, async () => {
		const f = await pair();
		await host(f.receiver).unhandle([RT, BULK]);
		const ids = Array.from({ length: 8 }, (_, index) => `old-receiver-${index}`);
		await Promise.all(ids.map((id) => f.sender.sendMessage(f.receiver.peerId, message(id))));
		await until(() => f.arrivals.length === 8, 5_000);
		expect([...f.arrivals].sort()).toEqual([...ids].sort());
		expect(new Set(f.evidence.values())).toEqual(new Set([LEGACY]));
	});

	it("a new receiver accepts an old sender's one-frame legacy stream", { timeout: 30_000 }, async () => {
		const f = await pair();
		const stream = await f.connection().newStream(LEGACY);
		const lp = lpStream(stream);
		await lp.write(Message.encode(message("old-sender")).finish());
		await lp.unwrap().close();
		await until(() => f.arrivals.includes("old-sender"));
		expect(f.evidence.get("old-sender")).toBe(LEGACY);
	});
});
