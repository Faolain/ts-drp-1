/* eslint-disable @typescript-eslint/explicit-function-return-type -- Opt-in measurement harness; native capability inference. */
// Creator restore currency: how long after a reopened creator's node starts does its first room peer
// connect, on genuine libp2p (DRPNetworkNode, localhost WebSocket + noise + yamux, in one process)?
// The connectivity-unresolved hold bound comes from this distribution.
//
//   direct    : the member knows the creator's address and redials it as soon as it listens (best case;
//               the shape of the in-process scorecard/fixture networks). Also records whether a frame the
//               creator sends on the connection event itself arrives, and its round trip.
//   bootstrap : the legacy page wiring (examples/grid network-config without the modular env): a
//               bootstrap node, global pubsub peer discovery (expected_replicas 50, interval
//               CREATOR_CONNECT_DISCOVERY_MS, default the node's 5000 ms) and the node's own discovery
//               dialling. Nothing is dialled by hand except the restarted creator's bootstrap.
//
// HARNESS LIMIT: one process, loopback; no WebRTC, relay, NAT or real RTT. Real links only add time.
import { generateKeyPair } from "@libp2p/crypto/keys";
import { type Message, MessageType, Message as MessageValue } from "@ts-drp/types";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { DRPNetworkNode } from "../packages/network/src/node.js";

const env = process.env;
const enabled = env.CREATOR_CONNECT_MEASURE === "1";
const output = env.CREATOR_CONNECT_OUT ?? join(tmpdir(), `creator-connect-${Date.now()}`);
const samples = Number(env.CREATOR_CONNECT_SAMPLES ?? 20);
const modes = (env.CREATOR_CONNECT_MODES ?? "direct,bootstrap").split(",");
const discoveryMs = env.CREATOR_CONNECT_DISCOVERY_MS === undefined ? undefined : Number(env.CREATOR_CONNECT_DISCOVERY_MS);
const giveUpMs = Number(env.CREATOR_CONNECT_GIVE_UP_MS ?? 15_000);
const QUEUE = "creator-connect-probe";

const pct = (values: readonly number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? null;
	return { n: sorted.length, min: sorted[0] ?? null, p50: at(0.5), p90: at(0.9), p99: at(0.99), max: sorted.at(-1) ?? null };
};

const quiet = { log_config: { level: "silent" as const } };
const loopback = { denyDialMultiaddr: () => false };

function probe(sender: string, data: Uint8Array): Message {
	return MessageValue.create({ sender, type: MessageType.MESSAGE_TYPE_CUSTOM, objectId: QUEUE, data });
}

function directNode() {
	return new DRPNetworkNode(
		{ bootstrap_peers: [], listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"], ...quiet },
		{ hostPolicy: { bootstrapDiscovery: false, coldStartPubsubDiscovery: false, gossipSubPeerExchange: false, ...loopback } }
	);
}

function pageNode(bootstrap: readonly string[], seed = false) {
	return new DRPNetworkNode(
		{
			bootstrap_peers: [...bootstrap],
			listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
			control_plane: { peer_selection: { expected_replicas: 50 } },
			...(discoveryMs === undefined ? {} : { pubsub: { peer_discovery_interval: discoveryMs } }),
			...(seed ? { seed: true } : {}),
			...quiet,
		} as never,
		{ hostPolicy: loopback }
	);
}

/** Echo every probe back to its sender (the member's handler is up before the creator restarts). */
function echo(node: DRPNetworkNode) {
	node.subscribeToMessageQueue((message: Message) => {
		if (message.type !== MessageType.MESSAGE_TYPE_CUSTOM || message.objectId !== QUEUE) return;
		void node.sendMessage(message.sender, probe(node.peerId, message.data)).catch(() => undefined);
	});
}

it.skipIf(!enabled)(
	"creator restore connect: open to first room peer connected on genuine libp2p",
	async () => {
		mkdirSync(output, { recursive: true });
		const record = (value: Record<string, unknown>) => {
			appendFileSync(join(output, "connect.jsonl"), JSON.stringify(value) + "\n");
			console.info("[creator connect]", JSON.stringify(value));
		};
		const creatorKey = (await generateKeyPair("Ed25519")).raw;
		const results: Record<string, unknown>[] = [];
		for (const mode of modes) {
			const running: DRPNetworkNode[] = [];
			try {
				let bootstrapAddress: string[] = [];
				if (mode === "bootstrap") {
					const seed = pageNode([], true);
					running.push(seed);
					await seed.start();
					bootstrapAddress = seed.getMultiaddrs().filter((address) => address.includes("/p2p/"));
				}
				const member = mode === "direct" ? directNode() : pageNode(bootstrapAddress);
				running.push(member);
				await member.start();
				echo(member);
				for (let sample = 0; sample < samples; sample++) {
					const creator = mode === "direct" ? directNode() : pageNode(bootstrapAddress);
					const marks: Record<string, number | boolean | string> = { mode, sample };
					const started = performance.now();
					const at = () => Math.round((performance.now() - started) * 10) / 10;
					let memberConnected!: () => void;
					const connectedToMember = new Promise<void>((resolve) => (memberConnected = resolve));
					let echoed!: () => void;
					const echoArrived = new Promise<void>((resolve) => (echoed = resolve));
					creator.subscribeToPeerConnections((peerId) => {
						if (peerId === member.peerId) {
							if (marks.memberConnectedAt !== undefined) return;
							marks.memberConnectedAt = at();
							memberConnected();
							// The ask goes out on the connection event itself, as the creator's view does.
							const sentAt = performance.now();
							void creator.sendMessage(member.peerId, probe(creator.peerId, new Uint8Array([sample & 255]))).then(
								() => (marks.firstSendResolvedMs = Math.round((performance.now() - sentAt) * 10) / 10),
								(error: unknown) => (marks.firstSendError = String(error).slice(0, 120))
							);
							const echoStart = sentAt;
							void echoArrived.then(() => (marks.firstEchoRttMs = Math.round((performance.now() - echoStart) * 10) / 10));
						} else marks.otherConnectedAt ??= at();
					});
					creator.subscribeToMessageQueue((message: Message) => {
						if (message.type === MessageType.MESSAGE_TYPE_CUSTOM && message.objectId === QUEUE && message.sender === member.peerId)
							echoed();
					});
					running.push(creator);
					await creator.start(creatorKey);
					marks.startedAt = at();
					if (mode === "direct") void member.connect(creator.getMultiaddrs()).catch(() => undefined);
					const outcome = await Promise.race([
						connectedToMember.then(() => "connected"),
						new Promise<string>((resolve) => setTimeout(() => resolve("gave-up"), giveUpMs)),
					]);
					marks.outcome = outcome;
					if (outcome === "connected")
						await Promise.race([echoArrived, new Promise((resolve) => setTimeout(resolve, 3_000))]);
					marks.echoed = marks.firstEchoRttMs !== undefined;
					results.push({ ...marks });
					record(marks);
					running.splice(running.indexOf(creator), 1);
					await creator.stop();
					// The member notices the disconnect before the next reopen.
					await new Promise((resolve) => setTimeout(resolve, 200));
				}
			} finally {
				await Promise.allSettled(running.map((node) => node.stop()));
			}
		}
		const pick = (mode: string, key: string) =>
			results.filter((value) => value.mode === mode && typeof value[key] === "number").map((value) => value[key] as number);
		const summary = Object.fromEntries(
			modes.map((mode) => [
				mode,
				{
					...Object.fromEntries(
						["startedAt", "otherConnectedAt", "memberConnectedAt", "firstEchoRttMs", "firstSendResolvedMs"].map((key) => [
							key,
							pct(pick(mode, key)),
						])
					),
					gaveUp: results.filter((value) => value.mode === mode && value.outcome === "gave-up").length,
					firstSendLost: results.filter((value) => value.mode === mode && value.outcome === "connected" && value.echoed !== true)
						.length,
				},
			])
		);
		writeFileSync(join(output, "summary.json"), JSON.stringify({ samples, discoveryMs, giveUpMs, summary }, null, 2));
		console.info("[creator connect summary]", JSON.stringify(summary));
		expect(results.length).toBe(samples * modes.length);
	},
	3_600_000
);
