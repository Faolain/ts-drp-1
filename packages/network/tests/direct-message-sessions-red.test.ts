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
		evidence.set(
			message.objectId,
			claimed?.transport.kind === "authenticated-stream" ? claimed.transport.protocol : undefined
		);
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

/**
 * With the receiver's queue held, send one message at a time until a send stays pending: the receiver's
 * queue and the session window are then full, and later sends wait in the sender's queue.
 */
async function fillUntilBlocked(f: Awaited<ReturnType<typeof pair>>) {
	const settled: Settled[] = [];
	const sends: Promise<void>[] = [];
	const written: string[] = [];
	for (let index = 0; index < 5_000; index++) {
		const id = `fill-${index}`;
		const sending = track(id, f.sender.sendMessage(f.receiver.peerId, message(id, 100)), settled);
		sends.push(sending);
		const done = await Promise.race([
			sending.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
		]);
		written.push(id);
		if (!done) return { written, settled, sends };
	}
	throw new Error("the receiver never blocked");
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

	it(
		"bounds a blocked receiver: typed queue-full refusal, abort while queued, FIFO and nothing silently lost",
		{ timeout: 120_000 },
		async () => {
			const f = await pair();
			const release = f.hold();
			const { written, settled, sends } = await fillUntilBlocked(f);
			// The receiver holds its queue (1000) plus one window; the sender's bounded queue takes the next
			// frames (one of them is aborted there), and refuses beyond it.
			expect(written.length).toBeGreaterThan(1_000);
			const queued = Array.from({ length: 40 }, (_, index) => `queued-${index}`);
			for (const id of queued.slice(0, 20))
				sends.push(track(id, f.sender.sendMessage(f.receiver.peerId, message(id, 100)), settled));
			const controller = new AbortController();
			const aborted = f.sender
				.sendMessage(f.receiver.peerId, message("aborted-while-queued", 100), { signal: controller.signal })
				.then(
					() => "resolved",
					(error: unknown) => (error as Error).message
				);
			for (const id of queued.slice(20))
				sends.push(track(id, f.sender.sendMessage(f.receiver.peerId, message(id, 100)), settled));
			const overflow = Array.from({ length: 40 }, (_, index) => `overflow-${index}`);
			for (const id of overflow)
				sends.push(track(id, f.sender.sendMessage(f.receiver.peerId, message(id, 100)), settled));
			expect(await until(() => settled.some(({ status }) => status === "rejected"), 5_000)).toBe(true);
			controller.abort(new Error("caller gave up"));
			expect(await aborted).toBe("caller gave up");
			release();
			await Promise.all(sends);
			const resolved = settled.filter(({ status }) => status === "resolved").map(({ id }) => id);
			const rejected = settled.filter(
				(entry): entry is Extract<Settled, { status: "rejected" }> => entry.status === "rejected"
			);
			expect(rejected.length).toBeGreaterThan(0);
			expect(new Set(rejected.map(({ error }) => JSON.stringify(codeOf(error))))).toEqual(
				new Set([JSON.stringify({ name: "DirectMessageSendError", code: "DIRECT_SEND_QUEUE_FULL" })])
			);
			// Every queued frame was carried once the receiver drained; only overflow was refused.
			expect(resolved).toEqual(expect.arrayContaining(queued));
			expect(rejected.every(({ id }) => id.startsWith("overflow-"))).toBe(true);
			expect(await until(() => f.arrivals.length >= resolved.length, 30_000)).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 200));
			// Every resolved send arrived exactly once, in send order; nothing else arrived.
			expect(f.arrivals).toEqual([...written, ...queued, ...overflow].filter((id) => resolved.includes(id)));
			expect(f.arrivals).not.toContain("aborted-while-queued");
			// The receiver never overflowed and reset the session.
			expect(f.opened.filter((protocol) => protocol === RT)).toHaveLength(1);
		}
	);

	it(
		"rejects queued frames when the connection closes and never delivers them later",
		{ timeout: 60_000 },
		async () => {
			const f = await pair();
			const release = f.hold();
			const { settled, sends } = await fillUntilBlocked(f);
			const queued = Array.from({ length: 20 }, (_, index) => `closing-${index}`);
			for (const id of queued)
				sends.push(track(id, f.sender.sendMessage(f.receiver.peerId, message(id, 100)), settled));
			await new Promise((resolve) => setTimeout(resolve, 100));
			await f.connection().close();
			release();
			await Promise.all(sends);
			const closed = settled.filter(
				(entry) =>
					entry.status === "rejected" &&
					JSON.stringify(codeOf(entry.error)) ===
						JSON.stringify({ name: "DirectMessageSendError", code: "DIRECT_CONNECTION_CLOSED" })
			);
			expect(closed.map(({ id }) => id)).toEqual(expect.arrayContaining(queued));
			await f.sender.connect(f.receiver.getMultiaddrs());
			await f.sender.sendMessage(f.receiver.peerId, message("after-reconnect"));
			expect(await until(() => f.arrivals.includes("after-reconnect"))).toBe(true);
			for (const { id } of closed) expect(f.arrivals).not.toContain(id);
		}
	);

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
		expect(f.arrivals.filter((id) => id.startsWith("after-"))).toEqual([
			"after-0",
			"after-1",
			"after-2",
			"after-3",
			"after-4",
		]);
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

	// Review findings (codex, track 46): each was reproduced before its fix.
	it("resets a session stream whose length prefix never terminates, at either end", { timeout: 30_000 }, async () => {
		const f = await pair();
		// Receiver side: an unterminated frame-length prefix on each session class.
		for (const protocol of [RT, BULK]) {
			const stream = await f.connection().newStream(protocol);
			stream.send(new Uint8Array(64).fill(0x80));
			expect(await until(() => stream.status !== "open", 2_000), protocol).toBe(true);
		}
		// Sender side: a receiver that answers credit with an unterminated prefix loses the session, and
		// the sender reopens it for the next frame.
		await host(f.receiver).unhandle(RT);
		await host(f.receiver).handle(RT, (stream: Stream) => void stream.send(new Uint8Array(64).fill(0x80)), {
			maxInboundStreams: 4,
		});
		await f.sender.sendMessage(f.receiver.peerId, message("first", 100));
		await new Promise((resolve) => setTimeout(resolve, 300));
		await f.sender.sendMessage(f.receiver.peerId, message("second", 100)).catch(() => undefined);
		expect(await until(() => f.opened.filter((protocol) => protocol === RT).length >= 2, 2_000)).toBe(true);
	});

	it(
		"falls back to legacy after consecutive session opens that each run to their deadline",
		{ timeout: 60_000 },
		async () => {
			const f = await pair();
			const watched = f.connection();
			const open = watched.newStream.bind(watched);
			let sessionAttempts = 0;
			// Each attempt fails after 6 s, so no three failures ever fall inside one 10 s window.
			watched.newStream = (async (protocols: string | string[], options?: object) => {
				if (protocols === RT) {
					sessionAttempts++;
					await new Promise((resolve) => setTimeout(resolve, 6_000));
					throw Object.assign(new Error("negotiation deadline"), { name: "TimeoutError" });
				}
				return open(protocols, options);
			}) as Connection["newStream"];
			await expect(f.sender.sendMessage(f.receiver.peerId, message("eventually", 100))).resolves.toBeUndefined();
			expect(sessionAttempts).toBe(3);
			expect(await until(() => f.arrivals.includes("eventually"))).toBe(true);
			expect(f.evidence.get("eventually")).toBe(LEGACY);
		}
	);

	it("a cancelled head waiting for byte credit lets a frame that fits go", { timeout: 120_000 }, async () => {
		const f = await pair();
		const release = f.hold();
		const { sends } = await fillUntilBlocked(f);
		// The receiver's queue is full, so bulk frames stay unadmitted and their credit does not return.
		await f.sender.sendMessage(f.receiver.peerId, message("bulk-3mib", 3 * 1024 * 1024));
		const controller = new AbortController();
		const head = f.sender.sendMessage(f.receiver.peerId, message("bulk-2mib", 2 * 1024 * 1024), {
			signal: controller.signal,
		});
		void head.catch(() => undefined);
		const small = f.sender.sendMessage(f.receiver.peerId, message("bulk-64kib", 64 * 1024));
		const smallState = small.then(
			() => "resolved",
			() => "rejected"
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		controller.abort(new Error("caller gave up"));
		await expect(head).rejects.toThrow("caller gave up");
		const state = await Promise.race([
			smallState,
			new Promise((resolve) => setTimeout(() => resolve("pending"), 3_000)),
		]);
		release();
		await Promise.all(sends);
		expect(state).toBe("resolved");
	});

	it("closing the sessions while a legacy stream negotiates refuses that frame", { timeout: 30_000 }, async () => {
		const f = await pair();
		await host(f.receiver).unhandle([RT, BULK]);
		const watched = f.connection();
		const open = watched.newStream.bind(watched);
		let entered!: () => void;
		const negotiating = new Promise<void>((resolve) => (entered = resolve));
		watched.newStream = (async (protocols: string | string[], options?: object) => {
			if (protocols === LEGACY) {
				entered();
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
			return open(protocols, options);
		}) as Connection["newStream"];
		const sending = f.sender.sendMessage(f.receiver.peerId, message("late-legacy", 100)).then(
			() => "resolved",
			(error: unknown) => codeOf(error)
		);
		await negotiating;
		// What node stop does first (node.ts stop), without closing the connection under the stream.
		(Reflect.get(f.sender, "_directSessions") as { closeAll(): void }).closeAll();
		expect(await sending).not.toBe("resolved");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(f.arrivals).not.toContain("late-legacy");
	});
});

// Acknowledged sends (track 46, admission-rejected root cause): a caller that paces itself by awaiting
// each send (the targeted retained replay) relied on the legacy stream's completion, which came only
// after the receiver read the frame and closed the stream. A session send resolves on the local write,
// so such a caller bursts. `acknowledged` restores the receipt: the send resolves once the receiver
// admitted the frame to its message queue (its credit came back).
describe("direct message acknowledged sends", () => {
	function holdAdmission(receiver: DRPNetworkNode) {
		const sessions = Reflect.get(receiver, "_directSessions") as object;
		const admit = Reflect.get(sessions, "admit") as (...args: unknown[]) => Promise<void>;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		Reflect.set(sessions, "admit", async (...args: unknown[]) => {
			await gate;
			return admit(...args);
		});
		return release;
	}

	function state(sending: Promise<void>) {
		return Promise.race([
			sending.then(
				() => "resolved",
				(error: unknown) => codeOf(error)
			),
			new Promise((resolve) => setTimeout(() => resolve("pending"), 300)),
		]);
	}

	it("resolves only once the receiver admitted the frame", { timeout: 30_000 }, async () => {
		const f = await pair();
		await f.sender.sendMessage(f.receiver.peerId, message("warm"));
		expect(await until(() => f.arrivals.includes("warm"))).toBe(true);
		const release = holdAdmission(f.receiver);
		const acknowledged = f.sender.sendMessage(f.receiver.peerId, message("acked"), { acknowledged: true });
		const plain = f.sender.sendMessage(f.receiver.peerId, message("plain"));
		expect(await state(plain)).toBe("resolved");
		expect(await state(acknowledged)).toBe("pending");
		release();
		await expect(acknowledged).resolves.toBeUndefined();
		expect(await until(() => f.arrivals.includes("acked"))).toBe(true);
	});

	it("rejects when the session resets before the receiver admitted the frame", { timeout: 30_000 }, async () => {
		const f = await pair();
		await f.sender.sendMessage(f.receiver.peerId, message("warm"));
		expect(await until(() => f.arrivals.includes("warm"))).toBe(true);
		holdAdmission(f.receiver);
		const acknowledged = f.sender.sendMessage(f.receiver.peerId, message("acked"), { acknowledged: true });
		expect(await state(acknowledged)).toBe("pending");
		const inbound = host(f.receiver)
			.getConnections(host(f.sender).peerId)
			.flatMap((connection) => connection.streams)
			.find((stream: Stream) => stream.protocol === RT && stream.direction === "inbound");
		inbound?.abort(new Error("receiver reset"));
		expect(await state(acknowledged)).toEqual({ name: "DirectMessageSendError", code: "DIRECT_SESSION_RESET" });
	});

	it("rejects with the abort reason when the caller gives up while waiting for the receipt", { timeout: 30_000 }, async () => {
		const f = await pair();
		await f.sender.sendMessage(f.receiver.peerId, message("warm"));
		expect(await until(() => f.arrivals.includes("warm"))).toBe(true);
		holdAdmission(f.receiver);
		const controller = new AbortController();
		const acknowledged = f.sender.sendMessage(f.receiver.peerId, message("acked"), {
			acknowledged: true,
			signal: controller.signal,
		});
		expect(await state(acknowledged)).toBe("pending");
		controller.abort(new Error("caller gave up"));
		await expect(acknowledged).rejects.toThrow("caller gave up");
	});

	it(
		"over the legacy protocol, resolves only once the receiver closed the stream after admitting",
		{ timeout: 30_000 },
		async () => {
			const f = await pair();
			// An old receiver that reads the frame, then holds before it admits and closes.
			await host(f.receiver).unhandle([RT, BULK, LEGACY]);
			let release!: () => void;
			const gate = new Promise<void>((resolve) => (release = resolve));
			await host(f.receiver).handle(
				LEGACY,
				(stream: Stream) =>
					void (async () => {
						await lpStream(stream).read();
						await gate;
						await stream.close();
					})(),
				{ maxInboundStreams: 8 }
			);
			const plain = f.sender.sendMessage(f.receiver.peerId, message("plain-legacy"));
			const acknowledged = f.sender.sendMessage(f.receiver.peerId, message("acked-legacy"), { acknowledged: true });
			expect(await state(plain)).toBe("resolved");
			expect(await state(acknowledged)).toBe("pending");
			release();
			await expect(acknowledged).resolves.toBeUndefined();
		}
	);
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
