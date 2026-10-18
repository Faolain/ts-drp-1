/* eslint-disable @typescript-eslint/explicit-function-return-type -- Preserve the existing native fixture capability signatures. */
// eslint-disable-next-line import/no-unresolved -- The native launcher resolves this existing node-package dependency from packages/node/package.json.
import * as grpc from "@grpc/grpc-js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssueCommit } from "@ts-drp/issuance-store";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { toCanvasWireOperation } from "../packages/blueprints/src/v3-canvas.js";
import { Keychain } from "../packages/keychain/src/keychain.js";
import { type CanvasProjection, createV3CanvasApplication } from "../packages/node/src/applications/canvas.js";
import { startConfiguredV3CanvasDaemon } from "../packages/node/src/cli/v3-canvas.js";
import { DRPNode } from "../packages/node/src/index.js";
import { startV3NodeDaemon, type V3NodeDaemonHost } from "../packages/node/src/rpc/v3-daemon.js";
import {
	type V3RpcRoomAcquisition,
	type V3RpcRoomOpenReceipt,
	V3RpcRoomRegistry,
} from "../packages/node/src/rpc/v3-room-registry.js";
import {
	loadV3RpcRoomServiceDefinition,
	startV3RpcRoomServer,
	type V3RpcNetworkOptions,
} from "../packages/node/src/rpc/v3-service.js";
import type { V3RetainedHashCursor, V3RetainedHashPage } from "../packages/node/src/v3-live.js";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	waitForV3RoomStartupForDiagnostics,
} from "../packages/node/src/v3-room.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";
import { createNodeV3RoomStorageHost } from "../packages/storage-node/src/v3-room-host.js";

// Real SQLite, signed native-issued bytes and genuine catalog/application owners.
// Existing scripted transport is not real-network, process-crash or device evidence.
const cleanup: (() => Promise<void>)[] = [];
const directories = new Set<string>();
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
async function rpcFixture(
	f: Awaited<ReturnType<typeof fixture>>,
	network?: V3RpcNetworkOptions,
	provided?: { port: number; close(): Promise<void> }
) {
	const startup = {
		registry: f.registry,
		address: "127.0.0.1:0",
		credentials: grpc.ServerCredentials.createInsecure(),
		...(network === undefined ? {} : { network }),
	};
	const server = provided ?? (await startV3RpcRoomServer(startup));
	cleanup.push(() => server.close());
	const client = new grpc.Client(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure());
	cleanup.push(() => Promise.resolve(client.close()));
	const definition = loadV3RpcRoomServiceDefinition();
	const unary = <Response>(
		method:
			| "OpenRoom"
			| "UnsubscribeRoom"
			| "QueryRetainedHashes"
			| "RequestRetainedRepair"
			| "AddCustomGroup"
			| "SendGroupMessage"
			| "SendCustomMessage",
		request: unknown
	) => {
		const wireMethod = required(definition[method]);
		let call!: grpc.ClientUnaryCall;
		const result = new Promise<Response>((accept, reject) => {
			call = client.makeUnaryRequest<unknown, Response>(
				`/drp.node.v2.V3RoomService/${method}`,
				wireMethod.requestSerialize,
				wireMethod.responseDeserialize,
				request,
				{ deadline: Date.now() + 30_000 },
				(error, response) => {
					if (error !== null) reject(error);
					else accept(required(response));
				}
			);
		});
		return { call, result };
	};
	return {
		server,
		startup,
		group: (group: string) => unary<{ kind: string }>("AddCustomGroup", { group }),
		groupMessage: (group: string, data: Uint8Array) => unary<{ kind: string }>("SendGroupMessage", { group, data }),
		customMessage: (peerId: string, data: Uint8Array) => unary<{ kind: string }>("SendCustomMessage", { peerId, data }),
		open: (request = f.request) => unary<V3RpcRoomOpenReceipt>("OpenRoom", request),
		unsubscribe: (subscriptionId: string) => unary<Record<string, never>>("UnsubscribeRoom", { subscriptionId }),
		query: (subscriptionId: string, limit: number, cursor?: V3RetainedHashCursor) =>
			unary<Omit<V3RetainedHashPage, "continuation"> & { continuation?: V3RetainedHashCursor }>("QueryRetainedHashes", {
				subscriptionId,
				limit,
				...(cursor === undefined ? {} : { cursor }),
			}),
		repair: (subscriptionId: string, target?: { peerId?: string }) =>
			unary<{ kind: "scheduled" }>("RequestRetainedRepair", {
				subscriptionId,
				...(target === undefined ? {} : { target }),
			}),
	};
}
function required<Value>(value: Value | null | undefined): Value {
	if (value === undefined || value === null) throw new TypeError("R9_RPC_REQUIRED_FIXTURE_VALUE");
	return value;
}
function gate() {
	let release!: () => void;
	const joined = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { joined, release };
}

function networkFixture(maxPayloadBytes = 200_000, maxCustomGroups = 2, maxNameBytes = 64) {
	// Genuine Node public delegates; only the existing transport completion boundary
	// is controlled. This is not real-network delivery or remote acknowledgment.
	const node = new DRPNode({ log_config: { level: "silent" } });
	node.networkNode.peerId = "rpc-local-node";
	const subscribe = vi.spyOn(node.networkNode, "subscribe").mockImplementation(() => undefined);
	const broadcast = vi.spyOn(node.networkNode, "broadcastMessage").mockResolvedValue(undefined);
	const send = vi.spyOn(node.networkNode, "sendMessage").mockResolvedValue(undefined);
	const policy: V3RpcNetworkOptions = {
		maxPayloadBytes,
		maxCustomGroups,
		maxNameBytes,
		port: {
			addCustomGroup: node.addCustomGroup.bind(node),
			sendGroupMessage: node.sendGroupMessage.bind(node),
			sendCustomMessage: node.sendCustomMessage.bind(node),
		},
	};
	return { node, subscribe, broadcast, send, policy };
}

function headScope(f: Awaited<ReturnType<typeof fixture>>) {
	const invite = decodeCanonical(Uint8Array.from(Buffer.from(f.request.creatorInvite, "hex"))) as Record<
		string,
		unknown
	>;
	return { objectId: f.objectId, pinnedGenesisAnchorDigest: invite.pinnedGenesisAnchorDigest as string };
}

function configuredCanvasNetwork(f: Awaited<ReturnType<typeof fixture>>) {
	// The existing runtime network injection controls transport only. Actual Node
	// message middleware, room-network acquisition/scheduler, SDK authentication,
	// Keychain and configured SQLite owners execute unchanged. Not libp2p evidence.
	const network = fakeNetwork("configured-observer", false);
	let ingress: ((message: Message) => void) | undefined;
	let requests = 0;
	let reply = false;
	const jobs: Promise<void>[] = [];
	Reflect.set(network, "subscribeToMessageQueue", (handler: (message: Message) => void) => {
		ingress = handler;
	});
	Reflect.set(network, "subscribeToGroupPeerChanges", () => () => undefined);
	Reflect.set(network, "getAllPeers", () => ["creator"]);
	Reflect.set(network, "gossipTopicFor", (message: Message) =>
		message.type === MessageType.MESSAGE_TYPE_V3_ENVELOPE ? message.objectId : undefined
	);
	const deliver = async (rows: readonly DurableIssueCommit[]) => {
		const topics = network.getSubscribedTopics();
		const topic = topics.find((value) => !value.startsWith("/ts-drp/room-history/1/"));
		for (const row of rows)
			required(ingress)(
				Message.create({
					objectId: required(topic),
					sender: "creator",
					type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
					data: V3Envelope.encode({
						canonicalPreimage: row.envelope.canonicalPreimageBytes,
						signature: row.envelope.signature,
					}).finish(),
				})
			);
		await tick();
	};
	Reflect.set(network, "sendMessage", (peerId: string, message: Message) => {
		if (message.type === MessageType.MESSAGE_TYPE_CUSTOM && message.objectId.startsWith("/ts-drp/room-history/1/")) {
			expect(peerId).toBe("creator");
			expect(new TextDecoder().decode(message.data)).toBe("ts-drp-room-history-request-v1");
			requests++;
			if (reply) {
				const job = f.issued().then(deliver);
				jobs.push(job);
				return job;
			}
		}
		return Promise.resolve();
	});
	return {
		network,
		deliver,
		requests: () => requests,
		enableReplies: () => {
			reply = true;
		},
		joined: () => Promise.all(jobs),
	};
}

function configuredCanvasConfig(
	f: Awaited<ReturnType<typeof fixture>>,
	directory: string,
	initialization: "create" | "reopen" = "create"
) {
	return {
		node: {
			keychain_config: { private_key_seed: "r9-rpc-observer" },
			log_config: { level: "silent" },
			network_config: { bootstrap_peers: [], listen_addresses: [], log_config: { level: "silent" } },
		},
		rpc: { port: 0, maxActiveEntries: 1, maxCustomGroups: 2, maxPayloadBytes: 200_000, maxNameBytes: 64 },
		canvas: {
			width: 2,
			height: 2,
			directory,
			rooms: [
				{
					...headScope(f),
					localAuthorId: f.observer.localAuthorId,
					databaseName: "configured",
					initialization,
					initialLogicalTime: 3,
				},
			],
		},
	};
}

function configuredDirectory() {
	const directory = mkdtempSync(join(tmpdir(), "r9-configured-canvas-"));
	directories.add(directory);
	return directory;
}

it("native configured Canvas CLI opens authentic native room queries repairs reopens and continues", async () => {
	const f = await fixture();
	const directory = configuredDirectory();
	const n = configuredCanvasNetwork(f);
	const daemon = await startConfiguredV3CanvasDaemon(configuredCanvasConfig(f, directory), {
		node: { networkNode: n.network },
	});
	cleanup.push(() => daemon.close());
	expect(daemon.node.keychain.localAuthorId).toBe(f.observer.localAuthorId);
	const openRoomNetwork = vi.spyOn(daemon.node, "openRoomNetwork");
	const rpc = await rpcFixture(f, undefined, daemon);
	const receipt = await rpc.open().result;
	expect(receipt).toMatchObject({ applicationId: f.applicationId, objectId: f.objectId, receiveOnly: true });
	expect(openRoomNetwork).toHaveBeenCalledWith(f.objectId);
	expect(daemon.node.get(f.objectId)).toBeUndefined();
	expect((await rpc.query(receipt.subscriptionId, 1).result).entries).toEqual([]);
	await expect.poll(n.requests).toBeGreaterThan(0);
	await f.paint("configured-repair-native");
	const before = n.requests();
	n.enableReplies();
	expect(await rpc.repair(receipt.subscriptionId).result).toEqual({ kind: "scheduled" });
	await expect.poll(n.requests).toBeGreaterThan(before);
	const rows = await f.issued();
	await expect.poll(async () => (await rpc.query(receipt.subscriptionId, 128).result).entries.length).toBe(rows.length);
	await n.joined();
	const page = await rpc.query(receipt.subscriptionId, 1).result;
	expect(page.coverage).toBe("current-epoch-retained-accepted-window");
	expect(page.scope.objectId).toBe(f.objectId);
	expect(page.scope.epoch).toBe(0);
	expect(page.entries).toEqual([{ journalSequence: 0, vertexDigest: hex(required(rows[0]).envelope.digest) }]);
	const second = await rpc.query(receipt.subscriptionId, 128, required(page.continuation)).result;
	expect(second.entries).toEqual(
		rows.slice(1).map((row, index) => ({ journalSequence: index + 1, vertexDigest: hex(row.envelope.digest) }))
	);
	expect(second.continuation).toBeUndefined();
	const host = createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" });
	const issuance = await host.openIssuance("configured");
	try {
		expect((await issuance.readLineage({ author: f.observer.localAuthorId, objectId: f.objectId })).next).toBe(0);
	} finally {
		await issuance.close();
	}
	const head = await host.openRoomHead("configured", { kind: "reopen" });
	let beforeHead: Uint8Array;
	try {
		beforeHead = encodeCanonical(await head.readRetirementImage({ scope: headScope(f) }));
	} finally {
		await head.close();
	}
	await daemon.close();
	await expect(rpc.open().result).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE });
	const files = readdirSync(directory)
		.filter((file) => file.endsWith(".sqlite"))
		.sort();
	const reopenedNetwork = configuredCanvasNetwork(f);
	const reopenedDaemon = await startConfiguredV3CanvasDaemon(configuredCanvasConfig(f, directory, "reopen"), {
		node: { networkNode: reopenedNetwork.network },
	});
	cleanup.push(() => reopenedDaemon.close());
	const reopenedRpc = await rpcFixture(f, undefined, reopenedDaemon);
	const reopened = await reopenedRpc.open().result;
	expect((await reopenedRpc.query(reopened.subscriptionId, 128).result).entries).toEqual(
		rows.map((row, index) => ({ journalSequence: index, vertexDigest: hex(row.envelope.digest) }))
	);
	expect(
		readdirSync(directory)
			.filter((file) => file.endsWith(".sqlite"))
			.sort()
	).toEqual(files);
	await f.paint("configured-after-reopen");
	await reopenedNetwork.deliver((await f.issued()).slice(rows.length));
	await expect
		.poll(async () => (await reopenedRpc.query(reopened.subscriptionId, 128).result).entries.length)
		.toBe(rows.length + 1);
	expect(reopenedDaemon.node.get(f.objectId)).toBeUndefined();
	await reopenedDaemon.close();
	const finalHead = await host.openRoomHead("configured", { kind: "reopen" });
	try {
		expect(encodeCanonical(await finalHead.readRetirementImage({ scope: headScope(f) }))).toEqual(beforeHead);
	} finally {
		await finalHead.close();
	}
}, 120_000);

it("native configured Canvas CLI refuses foreign room genesis and bare module path inputs before effects", async () => {
	const f = await fixture();
	const foreign = await fixture();
	const directory = configuredDirectory();
	for (const wrongGenesis of [false, true]) {
		const config = configuredCanvasConfig(f, directory);
		if (wrongGenesis) required(config.canvas.rooms[0]).pinnedGenesisAnchorDigest = "f".repeat(64);
		const network = configuredCanvasNetwork(f);
		const daemon = await startConfiguredV3CanvasDaemon(config, { node: { networkNode: network.network } });
		cleanup.push(() => daemon.close());
		const rpc = await rpcFixture(f, undefined, daemon);
		await expect(rpc.open(foreign.request).result).rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
		for (const creatorInvite of [f.objectId, "../private/native.sqlite", "./application.mjs"])
			await expect(rpc.open({ ...f.request, creatorInvite }).result).rejects.toMatchObject({
				code: grpc.status.INVALID_ARGUMENT,
			});
		await expect(rpc.open({ ...f.request, applicationId: "./application.mjs" }).result).rejects.toMatchObject({
			code: grpc.status.INVALID_ARGUMENT,
		});
		if (wrongGenesis) await expect(rpc.open().result).rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
		expect(readdirSync(directory)).toEqual([]);
		expect(daemon.node.get(f.objectId)).toBeUndefined();
		const client = new grpc.Client(`127.0.0.1:${daemon.port}`, grpc.credentials.createInsecure());
		try {
			await expect(
				new Promise((resolve, reject) =>
					client.makeUnaryRequest(
						"/drp.node.v1.DrpRpcService/SubscribeDRP",
						() => Buffer.alloc(0),
						(value) => value,
						{},
						(error, response) => (error === null ? resolve(response) : reject(error))
					)
				)
			).rejects.toMatchObject({ code: grpc.status.UNIMPLEMENTED });
		} finally {
			client.close();
		}
		await daemon.close();
	}
}, 120_000);

it("native configured Canvas CLI refuses foreign local signing identity before storage effects", async () => {
	const f = await fixture();
	const directory = configuredDirectory();
	const config = configuredCanvasConfig(f, directory);
	required(config.canvas.rooms[0]).localAuthorId = f.creator.localAuthorId;
	const network = configuredCanvasNetwork(f);
	await expect(startConfiguredV3CanvasDaemon(config, { node: { networkNode: network.network } })).rejects.toThrow(
		"LOCAL_IDENTITY_DIFFERS"
	);
	expect(readdirSync(directory)).toEqual([]);
}, 120_000);

it("native configured Canvas CLI missing retained store refuses noncreating reopen", async () => {
	const f = await fixture();
	const directory = configuredDirectory();
	const n = configuredCanvasNetwork(f);
	const daemon = await startConfiguredV3CanvasDaemon(configuredCanvasConfig(f, directory), {
		node: { networkNode: n.network },
	});
	cleanup.push(() => daemon.close());
	const rpc = await rpcFixture(f, undefined, daemon);
	await rpc.open().result;
	await daemon.close();
	const files = readdirSync(directory).filter((file) => file.endsWith(".sqlite"));
	// Match the existing native journal owner's final filename suffix; its
	// mechanical address authenticates nothing. Retain the original bytes.
	const journalFiles = files.filter((file) => file.endsWith(".drp-live-journal-v1.sqlite"));
	expect(journalFiles).toHaveLength(1);
	const missing = required(journalFiles[0]);
	renameSync(join(directory, missing), join(directory, `${missing}.preserved-original`));
	const before = readdirSync(directory).sort();
	const network = configuredCanvasNetwork(f);
	const reopened = await startConfiguredV3CanvasDaemon(configuredCanvasConfig(f, directory, "reopen"), {
		node: { networkNode: network.network },
	});
	cleanup.push(() => reopened.close());
	const reopenRpc = await rpcFixture(f, undefined, reopened);
	await expect(reopenRpc.open().result).rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
	expect(readdirSync(directory).sort()).toEqual(before);
	expect(reopened.node.get(f.objectId)).toBeUndefined();
	await reopened.close();
}, 120_000);

it("native gRPC v2 network preserves Node sender and bytes with separate payload policy", async () => {
	const f = await fixture();
	const n = networkFixture();
	const rpc = await rpcFixture(f, n.policy);
	const opened = await rpc.open().result;
	await f.receive(await f.issued());
	const before = encodeCanonical(await f.floor().read({ scope: headScope(f) }));
	await expect(rpc.group("custom-group").result).resolves.toEqual({ kind: "local-completed" });
	await expect(rpc.group("custom-group").result).resolves.toEqual({ kind: "local-completed" });
	expect(n.subscribe.mock.calls).toEqual([["custom-group"], ["custom-group"]]);
	// Larger than the unchanged invite transport ceiling, still inside explicit
	// host-selected network admission; no transaction-size capacity inference.
	const data = Uint8Array.from({ length: 132_097 }, (_, index) => index % 251);
	await expect(rpc.groupMessage("custom-group", data).result).resolves.toEqual({ kind: "local-completed" });
	const [group, message] = required(n.broadcast.mock.calls[0]);
	expect(group).toBe("custom-group");
	expect(message.sender).toBe("rpc-local-node");
	expect(message.type).toBe(MessageType.MESSAGE_TYPE_CUSTOM);
	expect(Uint8Array.from(message.data)).toEqual(data);
	await expect(rpc.customMessage("peer-b", Uint8Array.of(0, 255, 17)).result).resolves.toEqual({
		kind: "local-completed",
	});
	expect(n.send.mock.calls[0]?.[0]).toBe("peer-b");
	expect(n.send.mock.calls[0]?.[1]).toMatchObject({ sender: "rpc-local-node", type: MessageType.MESSAGE_TYPE_CUSTOM });
	expect(Uint8Array.from(required(n.send.mock.calls[0])[1].data)).toEqual(Uint8Array.of(0, 255, 17));
	await rpc.customMessage("peer-b", new Uint8Array()).result;
	expect(required(n.send.mock.calls[1])[1].data.byteLength).toBe(0);
	expect(encodeCanonical(await f.floor().read({ scope: headScope(f) }))).toEqual(before);
	await expect(f.observerNext()).resolves.toBe(0);
	await rpc.unsubscribe(opened.subscriptionId).result;
}, 120_000);

it("native gRPC v2 network refuses malformed bytes names and distinct group exhaustion before effects", async () => {
	const f = await fixture();
	const n = networkFixture(8, 1, 8);
	const rpc = await rpcFixture(f, n.policy);
	await rpc.group("group-a").result;
	await rpc.group("group-a").result;
	await expect(rpc.group("group-b").result).rejects.toMatchObject({ code: grpc.status.RESOURCE_EXHAUSTED });
	expect(n.subscribe.mock.calls).toEqual([["group-a"], ["group-a"]]);
	await expect(rpc.group("").result).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
	await expect(rpc.group("ééééé").result).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
	await expect(rpc.customMessage("peer", new Uint8Array(9)).result).rejects.toMatchObject({
		code: grpc.status.RESOURCE_EXHAUSTED,
	});
	await expect(rpc.groupMessage("group-a", new Uint8Array(9)).result).rejects.toMatchObject({
		code: grpc.status.RESOURCE_EXHAUSTED,
	});
	expect(n.send).not.toHaveBeenCalled();
	expect(n.broadcast).not.toHaveBeenCalled();
	n.broadcast.mockRejectedValueOnce(new Error("local transport fixture failed"));
	await expect(rpc.groupMessage("group-a", Uint8Array.of(1)).result).rejects.toMatchObject({
		code: grpc.status.FAILED_PRECONDITION,
	});
	n.send.mockRejectedValueOnce(new Error("local direct fixture failed"));
	await expect(rpc.customMessage("peer", Uint8Array.of(2)).result).rejects.toMatchObject({
		code: grpc.status.FAILED_PRECONDITION,
	});
	n.subscribe.mockImplementationOnce(() => {
		throw new Error("local subscribe fixture failed");
	});
	await expect(rpc.group("group-a").result).rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
	await rpc.groupMessage("group-a", Uint8Array.of(3)).result;
	await rpc.customMessage("peer", Uint8Array.of(4)).result;
	expect(f.counts().acquired).toBe(0);
}, 120_000);

it("native gRPC v2 network holds admitted local completions through shared capacity cancellation and shutdown", async () => {
	const f = await fixture();
	const n = networkFixture();
	const rpc = await rpcFixture(f, n.policy);
	const opened = await rpc.open().result;
	await f.receive(await f.issued());
	const before = encodeCanonical(await f.floor().read({ scope: headScope(f) }));
	const held = gate();
	n.send.mockImplementation(() => held.joined);
	const calls = Array.from({ length: 32 }, (_, index) => rpc.customMessage("peer-b", Uint8Array.of(index)));
	const results = calls.map(({ result }) =>
		result.then(
			(value) => ({ value }),
			(error) => ({ error })
		)
	);
	try {
		await expect.poll(() => n.send.mock.calls.length).toBe(32);
		expect(n.send.mock.calls.map((call) => required(call[1].data[0]))).toEqual(
			Array.from({ length: 32 }, (_, index) => index)
		);
		await expect(rpc.customMessage("peer-b", Uint8Array.of(32)).result).rejects.toMatchObject({
			code: grpc.status.RESOURCE_EXHAUSTED,
		});
		await expect(rpc.group("refused").result).rejects.toMatchObject({ code: grpc.status.RESOURCE_EXHAUSTED });
		expect(n.subscribe).not.toHaveBeenCalled();
		// Cancellation ends this wire call, not already admitted Node work.
		calls[0]?.call.cancel();
		await expect.poll(async () => (await results[0])?.error?.code).toBe(grpc.status.CANCELLED);
		let joined = false;
		const stopped = rpc.server.close().then(() => {
			joined = true;
		});
		await tick();
		await tick();
		expect(joined).toBe(false);
		expect(n.send).toHaveBeenCalledTimes(32);
		held.release();
		await stopped;
		const outcomes = await Promise.all(results);
		expect(outcomes.slice(1)).toEqual(Array.from({ length: 31 }, () => ({ value: { kind: "local-completed" } })));
		await expect(rpc.group("late").result).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE });
	} finally {
		held.release();
	}
	const floor = createNodeRoomHeadAuthority({
		filename: join(f.directory, "observer-floor.sqlite"),
		initialization: { kind: "reopen" },
	});
	try {
		expect(encodeCanonical(await floor.read({ scope: headScope(f) }))).toEqual(before);
	} finally {
		await floor.close();
	}
	expect(f.counts()).toEqual({ acquired: 1, released: 1, transportClosed: 1 });
	expect(opened.receiveOnly).toBe(true);
}, 120_000);

it("native gRPC v2 network requires finite host policy and holds uncertain subscribed groups", async () => {
	const f = await fixture();
	const n = networkFixture(16, 1, 16);
	for (const bad of [
		{ ...n.policy, maxCustomGroups: 0 },
		{ ...n.policy, maxPayloadBytes: Number.POSITIVE_INFINITY },
		{ ...n.policy, maxNameBytes: 0 },
		{ ...n.policy, maxPayloadBytes: 2_147_483_647 },
	]) {
		await expect(
			startV3RpcRoomServer({
				registry: f.registry,
				address: "127.0.0.1:0",
				credentials: grpc.ServerCredentials.createInsecure(),
				network: bad,
			})
		).rejects.toThrow("INVALID_NETWORK_POLICY");
	}
	expect(n.subscribe).not.toHaveBeenCalled();
	const rpc = await rpcFixture(f, n.policy);
	// Mutating host inputs after capture cannot widen admission, redirect native
	// ownership, or select a different network capability for future calls.
	const substitutedPort = vi.fn(() => {
		throw new Error("substituted host port");
	});
	Reflect.set(n.policy, "maxCustomGroups", 100);
	Reflect.set(n.policy, "maxPayloadBytes", 1000);
	Reflect.set(n.policy, "maxNameBytes", 1000);
	Reflect.set(n.policy.port, "addCustomGroup", substitutedPort);
	Reflect.set(n.policy.port, "sendGroupMessage", substitutedPort);
	Reflect.set(n.policy.port, "sendCustomMessage", substitutedPort);
	const otherRegistry = new V3RpcRoomRegistry<CanvasProjection>({ maxActiveEntries: 1, applications: [] });
	cleanup.push(() => otherRegistry.close());
	const otherOpen = vi.spyOn(otherRegistry, "open");
	const otherClose = vi.spyOn(otherRegistry, "close");
	Reflect.set(rpc.startup, "registry", otherRegistry);
	await expect(rpc.customMessage("peer", new Uint8Array(17)).result).rejects.toMatchObject({
		code: grpc.status.RESOURCE_EXHAUSTED,
	});
	await expect(rpc.group("a".repeat(17)).result).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
	n.subscribe.mockImplementationOnce(() => {
		throw new Error("subscribe may have effected state");
	});
	await expect(rpc.group("uncertain").result).rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
	await expect(rpc.group("other").result).rejects.toMatchObject({ code: grpc.status.RESOURCE_EXHAUSTED });
	await rpc.group("uncertain").result;
	expect(n.subscribe.mock.calls).toEqual([["uncertain"], ["uncertain"]]);
	await rpc.customMessage("peer", Uint8Array.of(7)).result;
	await rpc.groupMessage("uncertain", Uint8Array.of(8)).result;
	expect(n.send).toHaveBeenCalledOnce();
	expect(n.broadcast).toHaveBeenCalledOnce();
	expect(substitutedPort).not.toHaveBeenCalled();
	const receipt = await rpc.open().result;
	await f.receive(await f.issued());
	expect(otherOpen).not.toHaveBeenCalled();
	await rpc.server.close();
	expect(otherClose).not.toHaveBeenCalled();
	expect(f.counts()).toEqual({ acquired: 1, released: 1, transportClosed: 1 });
	expect(receipt.receiveOnly).toBe(true);
}, 120_000);

it("native gRPC v2 daemon cleans partial startup after network policy refusal without room effects", async () => {
	const f = await fixture();
	const before = readdirSync(f.directory).sort();
	const order: string[] = [];
	await expect(
		startV3NodeDaemon({
			config: {
				keychain_config: { private_key_seed: "r9-rpc-daemon-refused" },
				log_config: { level: "silent" },
				network_config: { bootstrap_peers: [], listen_addresses: [], log_config: { level: "silent" } },
			},
			prepare: (node) => {
				const originalStop = node.stop.bind(node);
				vi.spyOn(node, "stop").mockImplementation(async () => {
					order.push("node-stop");
					await originalStop();
				});
				const originalSigningStop = node.keychain.stop.bind(node.keychain);
				vi.spyOn(node.keychain, "stop").mockImplementation(async () => {
					order.push("signing-stop");
					await originalSigningStop();
				});
				return Promise.resolve({
					registry: {
						maxActiveEntries: 1,
						applications: [{ applicationId: f.applicationId, application: f.application, acquire: f.acquire }],
					},
					rpc: {
						address: "127.0.0.1:0",
						credentials: grpc.ServerCredentials.createInsecure(),
						network: {
							maxCustomGroups: 0,
							maxNameBytes: 64,
							maxPayloadBytes: 200_000,
							port: {
								addCustomGroup: node.addCustomGroup.bind(node),
								sendGroupMessage: node.sendGroupMessage.bind(node),
								sendCustomMessage: node.sendCustomMessage.bind(node),
							},
						},
					},
					close: () => {
						order.push("host-close");
						return Promise.resolve();
					},
				});
			},
		})
	).rejects.toThrow("INVALID_NETWORK_POLICY");
	expect(order).toEqual(["host-close", "node-stop", "signing-stop"]);
	expect(f.counts().acquired).toBe(0);
	expect(readdirSync(f.directory).sort()).toEqual(before);
}, 120_000);

it("native gRPC v2 daemon joins native callbacks before host and actual Node signing shutdown then reopens", async () => {
	const f = await fixture();
	const order: string[] = [];
	let node!: DRPNode;
	let stop!: ReturnType<typeof vi.spyOn>;
	let signingStop!: ReturnType<typeof vi.spyOn>;
	let preparedHost!: V3NodeDaemonHost<CanvasProjection>;
	const start = async () =>
		startV3NodeDaemon({
			config: {
				keychain_config: { private_key_seed: "r9-rpc-daemon-local" },
				log_config: { level: "silent" },
				network_config: { bootstrap_peers: [], listen_addresses: [], log_config: { level: "silent" } },
			},
			prepare: (runtimeNode) => {
				node = runtimeNode;
				const originalStop = node.stop.bind(node);
				stop = vi.spyOn(node, "stop").mockImplementation(async () => {
					order.push("node-stop");
					await originalStop();
				});
				const originalSigningStop = node.keychain.stop.bind(node.keychain);
				signingStop = vi.spyOn(node.keychain, "stop").mockImplementation(async () => {
					order.push("signing-stop");
					await originalSigningStop();
				});
				const host = {
					registry: {
						maxActiveEntries: 1,
						applications: [{ applicationId: f.applicationId, application: f.application, acquire: f.acquire }],
					},
					rpc: {
						address: "127.0.0.1:0",
						credentials: grpc.ServerCredentials.createInsecure(),
						network: {
							maxCustomGroups: 2,
							maxNameBytes: 64,
							maxPayloadBytes: 200_000,
							port: {
								addCustomGroup: node.addCustomGroup.bind(node),
								sendCustomMessage: node.sendCustomMessage.bind(node),
								sendGroupMessage: node.sendGroupMessage.bind(node),
							},
						},
					},
					close: () => {
						order.push("host-close");
						return Promise.resolve();
					},
				};
				preparedHost = host;
				return Promise.resolve(host);
			},
		});
	const daemon = await start();
	cleanup.push(() => daemon.close());
	const substitutedHostClose = vi.fn(() => {
		order.push("substituted-host-close");
		return Promise.resolve();
	});
	Reflect.set(preparedHost, "close", substitutedHostClose);
	// Room author/head remain the genuine existing recipient fixture custody;
	// they differ from daemon Node identity. This proves composition ordering,
	// not fully packaged CLI acquisition or real app transport convergence.
	expect(node.keychain.localAuthorId).not.toBe(f.observer.localAuthorId);
	expect(node.get(f.objectId)).toBeUndefined();
	const rpc = await rpcFixture(f, undefined, daemon);
	const opened = await rpc.open().result;
	const bootstrap = await f.issued();
	await f.receive(bootstrap);
	const before = f.admitted();
	const held = f.blockAdmission();
	await f.paint("daemon-held-native");
	const received = f.receive((await f.issued()).slice(bootstrap.length));
	let closed: Promise<void> | undefined;
	try {
		await expect.poll(() => f.admitted()).toBeGreaterThan(before);
		let joined = false;
		closed = daemon.close().then(() => {
			joined = true;
		});
		expect(daemon.close()).toBe(daemon.close());
		await tick();
		await tick();
		expect(joined).toBe(false);
		expect(stop).not.toHaveBeenCalled();
		expect(signingStop).not.toHaveBeenCalled();
		expect(order).toEqual([]);
		held.release();
		await Promise.all([closed, received]);
	} finally {
		held.release();
		await closed;
	}
	expect(order).toEqual(["host-close", "node-stop", "signing-stop"]);
	expect(substitutedHostClose).not.toHaveBeenCalled();
	expect(node.get(f.objectId)).toBeUndefined();
	expect(f.counts()).toEqual({ acquired: 1, released: 1, transportClosed: 1 });
	f.reopen();
	const reopenedDaemon = await start();
	cleanup.push(() => reopenedDaemon.close());
	const reopenedRpc = await rpcFixture(f, undefined, reopenedDaemon);
	const reopened = await reopenedRpc.open().result;
	expect(reopened.objectId).toBe(opened.objectId);
	expect(node.get(f.objectId)).toBeUndefined();
	expect(f.latest().state.counters[3]).toEqual([7, 8, 9]);
	await reopenedRpc.unsubscribe(reopened.subscriptionId).result;
	await reopenedDaemon.close();
	expect(order.slice(3)).toEqual(["host-close", "node-stop", "signing-stop"]);
}, 120_000);

afterEach(async () => {
	const errors: unknown[] = [];
	for (const close of cleanup.reverse()) {
		try {
			await close();
		} catch (error) {
			errors.push(error);
		}
	}
	cleanup.length = 0;
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
	directories.clear();
	expect(errors, "all native room, floor and author lifetimes join").toEqual([]);
});

async function fixture(maxActiveEntries = 1) {
	const directory = mkdtempSync(join(tmpdir(), "r9-rpc-native-"));
	directories.add(directory);
	const creator = new Keychain({ private_key_seed: "r9-rpc-creator" });
	const observer = new Keychain({ private_key_seed: "r9-rpc-observer" });
	await Promise.all([creator.start(), observer.start()]);
	cleanup.push(
		() => creator.stop(),
		() => observer.stop()
	);
	const application = createV3CanvasApplication(2, 2);
	const applicationId = required(application.catalog.blueprintDigests[0]);
	const objectId = `creator:${hex(hashDomain("r9-rpc-object/v1", new TextEncoder().encode(directory))).slice(0, 32)}`;
	const signers = [{ publicKey: creator.localAuthorId, signerId: "creator" }];
	const material = await createV3RoomCreatorInviteMaterial({
		blueprintDigest: applicationId,
		exactCanonicalApplicationStateBytes: required(application.migration).canonicalStateBytes(
			application.projectAcceptedOperations({
				authenticatedBase: undefined,
				currentEpochOperations: [],
			})
		),
		exactCanonicalLatchedAclBytes: encodeCanonical({
			epoch: 0,
			kind: "drp-v3-latched-acl",
			members: [
				{
					author: creator.localAuthorId,
					finalityKey: creator.localAuthorId,
					groups: ["admin", "finality", "writer"],
				},
			],
			objectId,
			permissionless: false,
			version: 1,
		}),
		exactCanonicalParametersCarrierBytes: encodeCanonical({
			maxDependencies: 16,
			maxEpochBytes: 8_388_608,
			maxEpochVertices: 8192,
			maxPendingBytes: 16_777_216,
			maxPendingEntries: 4096,
			maxSnapshotBytes: 268_435_456,
			snapshotChunkBytes: 131_072,
		}),
		exactCanonicalProfileBytes: encodeCanonical({
			cryptoSuiteId: "ed25519-sha256-v3",
			profileId: "creator-trusted-v1",
			quorum: 1,
			signers,
		}),
		exactCanonicalSignerSetBytes: encodeCanonical(signers),
		objectId,
		signGenesisAnchorDigest: (digest) => creator.signWithLocalAuthor(digest),
	});
	const creatorHead = createNodeRoomHeadAuthority({
		filename: join(directory, "creator-floor.sqlite"),
		initialization: { kind: "create" },
	});
	cleanup.push(() => creatorHead.close());
	const host = createNodeV3RoomStorageHost({
		directory,
		initialization: () => "create",
	});
	const creatorNetwork = fakeNetwork("rpc-creator", false);
	const creatorRoom = await createV3RoomSession({
		application,
		author: creator.localAuthorId,
		creatorInvite: material,
		storageHost: host,
		creatorFinalitySigner: await creator.acquireLocalAuthorFinalitySigner(),
		databaseName: "creator",
		issuanceDatabaseName: "creator",
		initialLogicalTime: 3,
		objectId,
		publicKeyBytes: Uint8Array.from(Buffer.from(creator.localAuthorId, "hex")),
		roomHeadAuthority: creatorHead,
		signRegisteredVertexDigest: (digest) => creator.signWithLocalAuthor(digest),
		onAcceptedVertex: () => undefined,
		onProjection: () => undefined,
		openTransport: () => ({
			networkNode: creatorNetwork,
			close: () => undefined,
			openEphemeral: () => {
				throw new TypeError("ephemeral unused");
			},
			requestRetainedHistory: () => undefined,
			setIngressHandler: () => undefined,
			setRetainedPublisher: () => undefined,
		}),
	});
	cleanup.push(() => creatorRoom.close());
	await waitForV3RoomStartupForDiagnostics(creatorRoom);
	let latest: CanvasProjection | undefined;
	let ingress: ((message: Message) => void) | undefined;
	let topic: string | undefined;
	let floor: ReturnType<typeof createNodeRoomHeadAuthority> | undefined;
	let reopen = false;
	let acquired = 0;
	let repairRequests = 0;
	let repairGate: ReturnType<typeof gate> | undefined;
	const repairJobs: Promise<void>[] = [];
	let released = 0;
	let transportClosed = 0;
	let acquisitionGate: ReturnType<typeof gate> | undefined;
	let admissionGate: ReturnType<typeof gate> | undefined;
	let admitted = 0;
	const accepted = new Set<string>();
	const acquire = async ({
		objectId: selected,
	}: {
		objectId: string;
	}): Promise<V3RpcRoomAcquisition<CanvasProjection>> => {
		acquired++;
		await acquisitionGate?.joined;
		if (selected !== objectId) throw new TypeError("R9_RPC_HOST_FOREIGN_ROOM");
		const head = createNodeRoomHeadAuthority({
			filename: join(directory, "observer-floor.sqlite"),
			initialization: { kind: reopen ? "reopen" : "create" },
		});
		floor = head;
		const network = fakeNetwork("rpc-observer", false);
		Reflect.set(network, "gossipTopicFor", (message: Message) => message.objectId);
		return {
			input: {
				author: observer.localAuthorId,
				storageHost: createNodeV3RoomStorageHost({
					directory,
					initialization: () => (reopen ? "reopen" : "create"),
				}),
				databaseName: "observer",
				issuanceDatabaseName: "observer",
				initialLogicalTime: 3,
				publicKeyBytes: Uint8Array.from(Buffer.from(observer.localAuthorId, "hex")),
				roomHeadAuthority: head,
				signRegisteredVertexDigest: (digest) => observer.signWithLocalAuthor(digest),
				onProjection: (projection) => {
					latest = projection;
				},
				onAcceptedVertex: async (vertex) => {
					admitted++;
					accepted.add(hex(vertex.digest));
					await admissionGate?.joined;
				},
				openTransport: () => ({
					networkNode: network,
					close: () => {
						transportClosed++;
						ingress = undefined;
					},
					openEphemeral: () => {
						throw new TypeError("ephemeral unused");
					},
					requestRetainedHistory: () => {
						repairRequests++;
						const transfer = repairGate;
						if (transfer === undefined) return;
						const job = (async () => {
							await transfer.joined;
							await receive(await issued());
						})();
						repairJobs.push(job);
						void job.catch(() => undefined);
					},
					setIngressHandler: (selectedTopic, handler) => {
						topic = selectedTopic;
						ingress = handler;
					},
					setRetainedPublisher: () => undefined,
				}),
			},
			close: async () => {
				await head.close();
				released++;
			},
		};
	};
	const registry = new V3RpcRoomRegistry({
		maxActiveEntries,
		applications: [{ applicationId, application, acquire }],
	});
	cleanup.push(() => registry.close());
	const request = { applicationId, creatorInvite: creatorRoom.invite };
	const issued = async () => {
		const issuance = await host.openIssuance("creator");
		try {
			const scope = { author: creator.localAuthorId, objectId };
			const next = (await issuance.readLineage(scope)).next;
			const rows: DurableIssueCommit[] = [];
			for (let index = 0; index < next; index++) rows.push(required(await issuance.readIssued(scope, index)));
			return rows;
		} finally {
			await issuance.close();
		}
	};
	const observerNext = async () => {
		const issuance = await createNodeV3RoomStorageHost({
			directory,
			initialization: () => "reopen",
		}).openIssuance("observer");
		try {
			return (await issuance.readLineage({ author: observer.localAuthorId, objectId })).next;
		} finally {
			await issuance.close();
		}
	};
	const receive = async (rows: readonly DurableIssueCommit[], corrupt = false) => {
		for (const row of rows) {
			const signature = new Uint8Array(row.envelope.signature);
			if (corrupt) signature[0] = (signature[0] ?? 0) ^ 1;
			required(ingress)(
				Message.create({
					objectId: required(topic),
					sender: "rpc-creator",
					type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
					data: V3Envelope.encode({
						canonicalPreimage: row.envelope.canonicalPreimageBytes,
						signature,
					}).finish(),
				})
			);
		}
		if (!corrupt)
			await expect
				.poll(() => accepted.has(hex(required(rows.at(-1)).envelope.digest)), {
					timeout: 10_000,
				})
				.toBe(true);
		else {
			await tick();
			await tick();
		}
	};
	const paint = (id: string) =>
		creatorRoom.issue(toCanvasWireOperation({ action: "paint", offset: [1, 1], rgb: [7, 8, 9] }, id));
	return {
		directory,
		creator,
		observer,
		creatorRoom,
		application,
		applicationId,
		objectId,
		request,
		registry,
		acquire,
		issued,
		observerNext,
		receive,
		paint,
		latest: () => required(latest),
		floor: () => required(floor),
		counts: () => ({ acquired, released, transportClosed }),
		reopen: () => {
			reopen = true;
		},
		blockAcquire: () => {
			acquisitionGate = gate();
			return acquisitionGate;
		},
		blockAdmission: () => {
			admissionGate = gate();
			return admissionGate;
		},
		admitted: () => admitted,
		repairRequests: () => repairRequests,
		enableRepair: () => {
			repairGate = gate();
			return repairGate;
		},
		joinRepair: () => Promise.all(repairJobs),
	};
}

it("native RPC replica authenticates remote work, joins close and noncreating reopen without authoring", async () => {
	const f = await fixture();
	const attempt = f.registry.open(f.request);
	expect(await attempt.ready).toEqual({
		subscriptionId: attempt.subscriptionId,
		applicationId: f.applicationId,
		objectId: f.objectId,
		receiveOnly: true,
	});
	expect(await f.observerNext()).toBe(0);
	await f.paint("first");
	await f.receive(await f.issued());
	expect(f.latest().state.counters[3]).toEqual([7, 8, 9]);
	await f.registry.unsubscribe(attempt.subscriptionId);
	expect(f.counts()).toEqual({ acquired: 1, released: 1, transportClosed: 1 });
	f.reopen();
	const resumed = f.registry.open(f.request);
	await resumed.ready;
	expect(f.latest().state.counters[3]).toEqual([7, 8, 9]);
	expect(await f.observerNext()).toBe(0);
	await f.paint("second");
	const second = required((await f.issued()).at(-1));
	const before = encodeCanonical(f.latest().state);
	await f.receive([second], true);
	expect(encodeCanonical(f.latest().state)).toEqual(before);
	await f.receive([second]);
	expect(f.latest().state.counters[3]).toEqual([14, 16, 18]);
	await f.registry.unsubscribe(resumed.subscriptionId);
	expect(await f.observerNext()).toBe(0);
}, 120_000);

it("native RPC refuses unavailable applications and altered signed invites before host acquisition", async () => {
	const f = await fixture();
	const before = readdirSync(f.directory).sort();
	expect(() => f.registry.open({ ...f.request, applicationId: "0".repeat(64) })).toThrow("APPLICATION_UNAVAILABLE");
	expect(() => f.registry.open({ ...f.request, creatorInvite: "a".repeat(131_074) })).toThrow("INVALID_OPEN_REQUEST");
	const decoded = decodeCanonical(Uint8Array.from(Buffer.from(f.request.creatorInvite, "hex"))) as Record<
		string,
		unknown
	>;
	const signature = new Uint8Array(decoded.detachedGenesisSignature as Uint8Array);
	signature[0] = (signature[0] ?? 0) ^ 1;
	const altered = hex(encodeCanonical({ ...decoded, detachedGenesisSignature: signature }));
	await expect(f.registry.open({ ...f.request, creatorInvite: altered }).ready).rejects.toThrow();
	expect(f.counts().acquired).toBe(0);
	expect(readdirSync(f.directory).sort()).toEqual(before);
}, 120_000);

it("native RPC capacity includes pending acquisition; cancellation joins it before reuse", async () => {
	const f = await fixture();
	const blocked = f.blockAcquire();
	const attempt = f.registry.open(f.request);
	const refused = expect(attempt.ready).rejects.toThrow("CANCELLED");
	await expect.poll(() => f.counts().acquired).toBe(1);
	expect(() => f.registry.open(f.request)).toThrow("ROOM_CAPACITY");
	let joined = false;
	const stopped = f.registry.unsubscribe(attempt.subscriptionId).then(() => {
		joined = true;
	});
	await tick();
	expect(joined).toBe(false);
	expect(() => f.registry.open(f.request)).toThrow("ROOM_CAPACITY");
	blocked.release();
	await refused;
	await stopped;
	expect(f.counts()).toEqual({ acquired: 1, released: 1, transportClosed: 0 });
	const fresh = f.registry.open(f.request);
	await fresh.ready;
	await f.registry.unsubscribe(fresh.subscriptionId);
}, 120_000);

it("native RPC unsubscribe revokes transport immediately and waits for admitted authenticated native work", async () => {
	const f = await fixture();
	const attempt = f.registry.open(f.request);
	await attempt.ready;
	const bootstrap = await f.issued();
	await f.receive(bootstrap);
	const priorAdmissions = f.admitted();
	const blocked = f.blockAdmission();
	await f.paint("admitted-work");
	const received = f.receive((await f.issued()).slice(bootstrap.length));
	await expect.poll(() => f.admitted()).toBeGreaterThan(priorAdmissions);
	await received;
	let joined = false;
	const stopped = f.registry.unsubscribe(attempt.subscriptionId).then(() => {
		joined = true;
	});
	try {
		expect(f.counts().transportClosed).toBe(1);
		await tick();
		expect(joined).toBe(false);
		expect(() => f.registry.open(f.request)).toThrow("ROOM_CAPACITY");
	} finally {
		blocked.release();
	}
	await stopped;
	expect(f.counts().released).toBe(1);
	await expect(f.registry.unsubscribe(attempt.subscriptionId)).rejects.toThrow("SUBSCRIPTION_UNAVAILABLE");
}, 120_000);

it("native RPC fresh opens retain FIFO order and queued cancellation does not enter host acquisition", async () => {
	const f = await fixture(2);
	const blocked = f.blockAcquire();
	const first = f.registry.open(f.request);
	await expect.poll(() => f.counts().acquired).toBe(1);
	const signal = new AbortController();
	const second = f.registry.open(f.request, { signal: signal.signal });
	expect(first.subscriptionId).not.toBe(second.subscriptionId);
	expect(first.ready).not.toBe(second.ready);
	const cancelled = expect(second.ready).rejects.toThrow("CANCELLED");
	expect(() => f.registry.open(f.request)).toThrow("ROOM_CAPACITY");
	signal.abort();
	await tick();
	expect(f.counts().acquired).toBe(1);
	blocked.release();
	await first.ready;
	await cancelled;
	expect(f.counts().acquired).toBe(1);
	const duplicate = f.registry.open(f.request);
	await expect(duplicate.ready).rejects.toThrow("ROOM_ALREADY_OWNED");
	expect(f.counts().acquired).toBe(1);
	await f.registry.unsubscribe(first.subscriptionId);
}, 120_000);

it("native RPC foreign valid invite cannot select a host's unrelated room storage", async () => {
	const f = await fixture();
	const foreign = await fixture();
	const before = readdirSync(f.directory).sort();
	await expect(f.registry.open({ ...f.request, creatorInvite: foreign.request.creatorInvite }).ready).rejects.toThrow(
		"HOST_FOREIGN_ROOM"
	);
	expect(f.counts()).toEqual({ acquired: 1, released: 0, transportClosed: 0 });
	expect(readdirSync(f.directory).sort()).toEqual(before);
}, 120_000);

it("native RPC missing external floor refuses noncreating acquisition without creating stores", async () => {
	const f = await fixture();
	f.reopen();
	const before = readdirSync(f.directory).sort();
	await expect(f.registry.open(f.request).ready).rejects.toThrow();
	expect(readdirSync(f.directory).sort()).toEqual(before);
	expect(f.counts().transportClosed).toBe(0);
}, 120_000);

it("native RPC advanced external floor with missing protected successor refuses without lowering it or issuing", async () => {
	const f = await fixture();
	const original = f.registry.open(f.request);
	await original.ready;
	await f.registry.unsubscribe(original.subscriptionId);
	f.reopen();
	const floor = createNodeRoomHeadAuthority({
		filename: join(f.directory, "observer-floor.sqlite"),
		initialization: { kind: "reopen" },
	});
	const decoded = decodeCanonical(Uint8Array.from(Buffer.from(f.request.creatorInvite, "hex"))) as Record<
		string,
		unknown
	>;
	const scope = { objectId: f.objectId, pinnedGenesisAnchorDigest: decoded.pinnedGenesisAnchorDigest as string };
	const observed = await floor.read({ scope });
	if (!observed.ok || observed.state === null) throw new TypeError("R9_RPC_MISSING_NATIVE_FLOOR");
	const next = { objectId: f.objectId, epoch: 1, currentAnchorDigest: "9".repeat(64) };
	const pending = await floor.begin({ scope, expected: observed.state, next });
	if (!pending.ok || pending.state === null) throw new TypeError("R9_RPC_MISSING_NATIVE_PENDING");
	expect(await floor.commit({ scope, expected: pending.state })).toMatchObject({
		ok: true,
		state: { stable: next, pending: null },
	});
	const before = await floor.readRetirementImage({ scope });
	await floor.close();
	await expect(f.registry.open(f.request).ready).rejects.toThrow();
	const check = createNodeRoomHeadAuthority({
		filename: join(f.directory, "observer-floor.sqlite"),
		initialization: { kind: "reopen" },
	});
	try {
		expect(await check.readRetirementImage({ scope })).toEqual(before);
	} finally {
		await check.close();
	}
	expect(await f.observerNext()).toBe(0);
	expect(f.counts().transportClosed).toBe(2);
	expect(f.admitted()).toBe(0);
}, 120_000);

it("native gRPC v2 opens receive-only authenticated rooms, joins unsubscribe and noncreating reopen", async () => {
	const f = await fixture();
	const rpc = await rpcFixture(f);
	const receipt = await rpc.open().result;
	expect(receipt).toEqual({
		applicationId: f.applicationId,
		objectId: f.objectId,
		receiveOnly: true,
		subscriptionId: expect.any(String),
	});
	await f.paint("wire-first");
	await f.receive(await f.issued());
	expect(f.latest().state.counters[3]).toEqual([7, 8, 9]);
	expect(await f.observerNext()).toBe(0);
	await rpc.unsubscribe(receipt.subscriptionId).result;
	expect(f.counts().released).toBe(1);
	f.reopen();
	const reopened = await rpc.open().result;
	expect(reopened.subscriptionId).not.toBe(receipt.subscriptionId);
	expect(f.latest().state.counters[3]).toEqual([7, 8, 9]);
	await f.paint("wire-continued");
	await f.receive(await f.issued());
	expect(f.latest().state.counters[3]).toEqual([14, 16, 18]);
	expect(await f.observerNext()).toBe(0);
	await rpc.unsubscribe(reopened.subscriptionId).result;
	await expect(rpc.unsubscribe(receipt.subscriptionId).result).rejects.toMatchObject({ code: grpc.status.NOT_FOUND });
	await rpc.server.close();
	await expect(rpc.open().result).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE });
	expect(f.counts()).toEqual({ acquired: 2, released: 2, transportClosed: 2 });
}, 120_000);

it("native gRPC v2 refuses open delivery when server revocation follows native readiness", async () => {
	const f = await fixture();
	const rpc = await rpcFixture(f);
	const originalOpen = f.registry.open.bind(f.registry);
	let stopped: Promise<void> | undefined;
	// The native acquisition completes unchanged. Shutdown is scheduled at the
	// real ready-to-wire boundary, before the service's awaiting continuation.
	vi.spyOn(f.registry, "open").mockImplementation((request, options) => {
		const attempt = originalOpen(request, options);
		return {
			...attempt,
			ready: attempt.ready.then((receipt) => {
				stopped = rpc.server.close();
				return receipt;
			}),
		};
	});
	try {
		await expect(rpc.open().result).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE });
	} finally {
		await stopped;
	}
	expect(f.counts()).toEqual({ acquired: 1, released: 1, transportClosed: 1 });
}, 120_000);

it("native gRPC v2 refuses altered authority and unavailable host applications before acquisition", async () => {
	const f = await fixture();
	const rpc = await rpcFixture(f);
	const before = readdirSync(f.directory).sort();
	const decoded = decodeCanonical(Uint8Array.from(Buffer.from(f.request.creatorInvite, "hex")));
	const invite = required(decoded as Record<string, unknown>);
	const altered = new Uint8Array(invite.detachedGenesisSignature as Uint8Array);
	altered[0] = (altered[0] ?? 0) ^ 1;
	const creatorInvite = hex(encodeCanonical({ ...invite, detachedGenesisSignature: altered }));
	await expect(rpc.open({ ...f.request, creatorInvite }).result).rejects.toMatchObject({
		code: grpc.status.FAILED_PRECONDITION,
	});
	await expect(rpc.open({ ...f.request, applicationId: "f".repeat(64) }).result).rejects.toMatchObject({
		code: grpc.status.NOT_FOUND,
	});
	await expect(rpc.open({ ...f.request, creatorInvite: "a".repeat(132_096) }).result).rejects.toMatchObject({
		code: grpc.status.RESOURCE_EXHAUSTED,
	});
	expect(f.counts()).toEqual({ acquired: 0, released: 0, transportClosed: 0 });
	expect(readdirSync(f.directory).sort()).toEqual(before);
	await rpc.server.close();
}, 120_000);

it("native gRPC v2 cancelled opening retains admission until acquisition joins server shutdown", async () => {
	const f = await fixture();
	const blocked = f.blockAcquire();
	const rpc = await rpcFixture(f);
	const opening = rpc.open();
	const cancelled = expect(opening.result).rejects.toMatchObject({ code: grpc.status.CANCELLED });
	await expect.poll(() => f.counts().acquired).toBe(1);
	opening.call.cancel();
	await cancelled;
	await expect(rpc.open().result).rejects.toMatchObject({ code: grpc.status.RESOURCE_EXHAUSTED });
	let joined = false;
	const stopped = rpc.server.close().then(() => {
		joined = true;
	});
	try {
		await tick();
		expect(joined).toBe(false);
		expect(f.counts()).toEqual({ acquired: 1, released: 0, transportClosed: 0 });
	} finally {
		blocked.release();
	}
	await stopped;
	expect(f.counts()).toEqual({ acquired: 1, released: 1, transportClosed: 0 });
	expect(() => f.registry.open(f.request)).toThrow("REGISTRY_CLOSED");
}, 120_000);

it("native gRPC v2 unsubscribe and server handles join admitted authenticated work", async () => {
	const f = await fixture();
	const rpc = await rpcFixture(f);
	const receipt = await rpc.open().result;
	const bootstrap = await f.issued();
	await f.receive(bootstrap);
	const prior = f.admitted();
	const blocked = f.blockAdmission();
	await f.paint("wire-admitted");
	const received = f.receive((await f.issued()).slice(bootstrap.length));
	await expect.poll(() => f.admitted()).toBeGreaterThan(prior);
	await received;
	let unsubscribed = false;
	const unsubscribe = rpc.unsubscribe(receipt.subscriptionId).result.then(() => {
		unsubscribed = true;
	});
	await expect.poll(() => f.counts().transportClosed).toBe(1);
	let serverJoined = false;
	const stopped = rpc.server.close().then(() => {
		serverJoined = true;
	});
	try {
		await tick();
		expect(unsubscribed).toBe(false);
		expect(serverJoined).toBe(false);
		expect(f.counts().released).toBe(0);
	} finally {
		blocked.release();
	}
	await unsubscribe;
	await stopped;
	expect(f.counts()).toEqual({ acquired: 1, released: 1, transportClosed: 1 });
}, 120_000);

it("native gRPC v2 retained query pages genuine hashes and refuses invalid or stale cursors", async () => {
	const f = await fixture();
	const rpc = await rpcFixture(f);
	const receipt = await rpc.open().result;
	await f.paint("query-first");
	await f.paint("query-second");
	await f.paint("query-third");
	const rows = await f.issued();
	await f.receive(rows);
	const first = await rpc.query(receipt.subscriptionId, 1).result;
	expect(first.scope).toMatchObject({ objectId: f.objectId, epoch: 0 });
	expect(first.coverage).toBe("current-epoch-retained-accepted-window");
	expect(first.retainedRowCount).toBe(rows.length);
	expect(first.entries).toHaveLength(1);
	const initialCursor = required(first.continuation);
	expect(initialCursor).toMatchObject({ epoch: 0, afterSequence: 0 });
	const entries = [...first.entries];
	let cursor: V3RetainedHashCursor | undefined = initialCursor;
	while (cursor !== undefined) {
		const page = await rpc.query(receipt.subscriptionId, 2, cursor).result;
		expect(page.scope).toEqual(first.scope);
		expect(page.snapshotDigest).toBe(first.snapshotDigest);
		expect(page.entries.length).toBeLessThanOrEqual(2);
		entries.push(...page.entries);
		cursor = page.continuation;
	}
	expect(entries).toEqual(
		rows.map((row, index) => ({ journalSequence: index, vertexDigest: hex(row.envelope.digest) }))
	);
	await expect(rpc.query(receipt.subscriptionId, 0).result).rejects.toMatchObject({
		code: grpc.status.INVALID_ARGUMENT,
	});
	await expect(rpc.query(receipt.subscriptionId, 129).result).rejects.toMatchObject({
		code: grpc.status.INVALID_ARGUMENT,
	});
	await expect(
		rpc.query(receipt.subscriptionId, 1, { ...initialCursor, afterSequence: Number.MAX_SAFE_INTEGER + 1 }).result
	).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
	await expect(
		rpc.query(receipt.subscriptionId, 1, { ...initialCursor, snapshotDigest: "0".repeat(64) }).result
	).rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
	await expect(
		rpc.query(receipt.subscriptionId, 1, { ...initialCursor, objectId: `creator:${"f".repeat(32)}` }).result
	).rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
	await f.paint("query-changed-window");
	await f.receive([required((await f.issued()).at(-1))]);
	await expect(rpc.query(receipt.subscriptionId, 1, initialCursor).result).rejects.toMatchObject({
		code: grpc.status.FAILED_PRECONDITION,
	});
	expect(f.latest().state.counters[3]).toEqual([28, 32, 36]);
	expect(await f.observerNext()).toBe(0);
	await rpc.unsubscribe(receipt.subscriptionId).result;
	await expect(rpc.query(receipt.subscriptionId, 1).result).rejects.toMatchObject({ code: grpc.status.NOT_FOUND });
	await rpc.server.close();
}, 120_000);

it("native gRPC v2 retained repair makes a real request and admits genuine signed missing work", async () => {
	const f = await fixture();
	const rpc = await rpcFixture(f);
	const receipt = await rpc.open().result;
	await f.paint("repair-missing-work");
	const rows = await f.issued();
	const beforeTransfer = await rpc.query(receipt.subscriptionId, 1).result;
	expect(beforeTransfer.entries).toEqual([]);
	expect(beforeTransfer.retainedRowCount).toBe(0);
	expect(beforeTransfer.continuation).toBeUndefined();
	const requests = f.repairRequests();
	const blocked = f.enableRepair();
	try {
		await expect(rpc.repair(receipt.subscriptionId, {}).result).rejects.toMatchObject({
			code: grpc.status.INVALID_ARGUMENT,
		});
		await expect(rpc.repair(receipt.subscriptionId, { peerId: "foreign-peer" }).result).rejects.toMatchObject({
			code: grpc.status.FAILED_PRECONDITION,
		});
		expect(f.repairRequests()).toBe(requests);
		const result = await rpc.repair(receipt.subscriptionId).result;
		expect(result).toEqual({ kind: "scheduled" });
		expect(f.repairRequests()).toBe(requests + 1);
		expect(f.latest().state.counters[3]).toEqual([0, 0, 0]);
	} finally {
		blocked.release();
	}
	await f.joinRepair();
	expect(f.latest().state.counters[3]).toEqual([7, 8, 9]);
	const page = await rpc.query(receipt.subscriptionId, 128).result;
	expect(page.entries).toEqual(
		rows.map((row, index) => ({ journalSequence: index, vertexDigest: hex(row.envelope.digest) }))
	);
	expect(page.continuation).toBeUndefined();
	expect(await f.observerNext()).toBe(0);
	await rpc.unsubscribe(receipt.subscriptionId).result;
	await expect(rpc.repair(receipt.subscriptionId).result).rejects.toMatchObject({ code: grpc.status.NOT_FOUND });
	await rpc.server.close();
}, 120_000);

it("native gRPC v2 aggregate admission bounds fresh stalled unsubscribe and control tasks", async () => {
	const f = await fixture();
	const rpc = await rpcFixture(f);
	const receipt = await rpc.open().result;
	const bootstrap = await f.issued();
	await f.receive(bootstrap);
	const decoded = decodeCanonical(Uint8Array.from(Buffer.from(f.request.creatorInvite, "hex"))) as Record<
		string,
		unknown
	>;
	const scope = { objectId: f.objectId, pinnedGenesisAnchorDigest: decoded.pinnedGenesisAnchorDigest as string };
	const floorBefore = await f.floor().readRetirementImage({ scope });
	const prior = f.admitted();
	const blocked = f.blockAdmission();
	await f.paint("bounded-close-work");
	const received = f.receive((await f.issued()).slice(bootstrap.length));
	await expect.poll(() => f.admitted()).toBeGreaterThan(prior);
	await received;
	// Observe entry only; the spy calls the original genuine registry/native owner.
	const unsubscriptions = vi.spyOn(f.registry, "unsubscribe");
	const admitted: Promise<Record<string, never>>[] = [];
	let settled = 0;
	admitted.push(
		rpc.unsubscribe(receipt.subscriptionId).result.then((result) => {
			settled++;
			return result;
		})
	);
	await expect.poll(() => f.counts().transportClosed).toBe(1);
	for (let index = 1; index < 32; index++)
		admitted.push(
			rpc.unsubscribe(receipt.subscriptionId).result.then((result) => {
				settled++;
				return result;
			})
		);
	let stopped: Promise<void> | undefined;
	let serverJoined = false;
	try {
		await expect.poll(() => unsubscriptions.mock.calls.length).toBe(32);
		expect(new Set(admitted).size).toBe(32);
		await expect(rpc.unsubscribe(receipt.subscriptionId).result).rejects.toMatchObject({
			code: grpc.status.RESOURCE_EXHAUSTED,
		});
		await expect(rpc.query(receipt.subscriptionId, 1).result).rejects.toMatchObject({
			code: grpc.status.RESOURCE_EXHAUSTED,
		});
		await expect(rpc.repair(receipt.subscriptionId).result).rejects.toMatchObject({
			code: grpc.status.RESOURCE_EXHAUSTED,
		});
		expect(unsubscriptions.mock.calls.length).toBe(32);
		expect(f.counts()).toEqual({ acquired: 1, released: 0, transportClosed: 1 });
		stopped = rpc.server.close().then(() => {
			serverJoined = true;
		});
		await tick();
		expect(settled).toBe(0);
		expect(serverJoined).toBe(false);
	} finally {
		blocked.release();
		unsubscriptions.mockRestore();
	}
	expect(await Promise.all(admitted)).toEqual(Array.from({ length: 32 }, () => ({})));
	await required(stopped);
	expect(settled).toBe(32);
	expect(serverJoined).toBe(true);
	expect(f.counts()).toEqual({ acquired: 1, released: 1, transportClosed: 1 });
	const check = createNodeRoomHeadAuthority({
		filename: join(f.directory, "observer-floor.sqlite"),
		initialization: { kind: "reopen" },
	});
	try {
		expect(await check.readRetirementImage({ scope })).toEqual(floorBefore);
	} finally {
		await check.close();
	}
	expect(await f.observerNext()).toBe(0);
	f.reopen();
	const reopened = new V3RpcRoomRegistry({
		maxActiveEntries: 1,
		applications: [{ applicationId: f.applicationId, application: f.application, acquire: f.acquire }],
	});
	cleanup.push(() => reopened.close());
	const continued = reopened.open(f.request);
	await continued.ready;
	expect(f.latest().state.counters[3]).toEqual([7, 8, 9]);
	await reopened.unsubscribe(continued.subscriptionId);
}, 120_000);
