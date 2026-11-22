/* eslint-disable @typescript-eslint/explicit-function-return-type -- Existing native fixture capability inference. */
import { openTrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { DRPNetworkNode } from "@ts-drp/network";
import { type Message, MessageType, V3Envelope } from "@ts-drp/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import {
	createShippingChatGenesisStateBytes,
	createShippingV3ChatApplication,
	type ShippingChatProjection,
} from "../examples/chat/src/v3-chat-application.js";
import { readCreatorSuccessorExport } from "../packages/node/src/creator-adoption.js";
import { DRPNode } from "../packages/node/src/index.js";
import type { NodeRoomNetworkPort } from "../packages/node/src/room-network.js";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type V3RoomSession,
	waitForV3RoomStartupForDiagnostics,
} from "../packages/node/src/v3-room.js";
import { parseStorageObjectId } from "../packages/storage/src/index.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";
import { createNodeV3RoomStorageHost } from "../packages/storage-node/src/v3-room-host.js";

// Actual local Node CUSTOM and snapshot streams, native SQLite and signing.
// One exact original source is selectively partitioned before creator sealing;
// this is controlled local delivery, not WAN/crash/device/performance evidence.
const DOMAIN = "ts-drp/settlement-source-selection/v1";
const nodes = new Set<DRPNode>();
const rooms = new Set<V3RoomSession<ShippingChatProjection>>();
const heads = new Set<ReturnType<typeof createNodeRoomHeadAuthority>>();
const directories = new Set<string>();
const releases = new Set<() => void>();
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const message = (id: string, text: string) => ({
	action: "message",
	clientOperationId: id,
	displayTimeMs: 1791662400000,
	text,
});

afterEach(async () => {
	for (const release of releases) release();
	releases.clear();
	for (const room of rooms) await room.close();
	rooms.clear();
	for (const head of heads) await head.close();
	heads.clear();
	for (const node of nodes) await node.stop();
	nodes.clear();
	vi.restoreAllMocks();
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
	directories.clear();
});

async function startNode(seed: string) {
	const network = {
		bootstrap_peers: [],
		listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
		log_config: { level: "silent" as const },
	};
	const node = new DRPNode(
		{ keychain_config: { private_key_seed: seed }, network_config: network, log_config: { level: "silent" } },
		{
			networkNode: new DRPNetworkNode(network, {
				hostPolicy: { bootstrapDiscovery: false, coldStartPubsubDiscovery: false, gossipSubPeerExchange: false },
			}),
			reconnect: false,
		}
	);
	nodes.add(node);
	await node.start();
	return node;
}

async function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "r9-selected-chat-"));
	directories.add(directory);
	const catalogDirectory = process.env.SHIPPING_CHAT_CATALOG_DIR;
	if (catalogDirectory === undefined)
		throw new Error("SHIPPING_CHAT_CATALOG_DIR must name the accepted shipping catalog");
	const catalog = openTrustedBlueprintCatalog({ catalogDirectory });
	const blueprintDigest = required(catalog.blueprintDigests[0]);
	expect(catalog.blueprintDigests).toHaveLength(1);
	const creator = await startNode("r9-selected-room-creator"),
		recipient = await startNode("r9-selected-room-recipient");
	await recipient.networkNode.connect(creator.networkNode.getMultiaddrs());
	await expect.poll(() => creator.networkNode.getAllPeers()).toContain(recipient.networkNode.peerId);
	const objectId = `${creator.networkNode.peerId}:${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
	const enrolled = [creator, recipient];
	const exactCanonicalLatchedAclBytes = encodeCanonical({
		epoch: 0,
		kind: "drp-v3-latched-acl",
		objectId,
		permissionless: false,
		version: 3,
		members: enrolled
			.map((node, index) => ({
				author: node.keychain.localAuthorId,
				finalityKey: index === 0 ? node.keychain.localAuthorId : null,
				groups: index === 0 ? ["admin", "finality", "writer"] : ["admin", "writer"],
			}))
			.sort((a, b) => a.author.localeCompare(b.author)),
	});
	const application = await createShippingV3ChatApplication({
		catalog,
		blueprintDigest,
		exactCanonicalGenesisLatchedAclBytes: exactCanonicalLatchedAclBytes,
	});
	const signers = [{ publicKey: creator.keychain.localAuthorId, signerId: "creator" }];
	const invite = await createV3RoomCreatorInviteMaterial({
		blueprintDigest,
		objectId,
		exactCanonicalApplicationStateBytes: createShippingChatGenesisStateBytes({ exactCanonicalLatchedAclBytes }),
		exactCanonicalLatchedAclBytes,
		exactCanonicalParametersCarrierBytes: encodeCanonical({
			maxDependencies: 16,
			maxEpochBytes: 8388608,
			maxEpochVertices: 8192,
			maxPendingBytes: 16777216,
			maxPendingEntries: 4096,
			maxSnapshotBytes: 268435456,
			snapshotChunkBytes: 131072,
		}),
		exactCanonicalProfileBytes: encodeCanonical({
			cryptoSuiteId: "ed25519-sha256-v3",
			profileId: "creator-trusted-settlement-v1",
			quorum: 1,
			signers,
		}),
		exactCanonicalSignerSetBytes: encodeCanonical(signers),
		signGenesisAnchorDigest: (digest) => creator.keychain.signWithLocalAuthor(digest),
	});
	let approval = false;
	let holdApproval: ((signal: AbortSignal) => Promise<boolean>) | undefined;
	const approvals: {
		exactCanonicalSelectionBytes: Uint8Array;
		digest: Uint8Array;
		sourceAuthor: string;
		sourceDigest: string;
		targetObjectId: string;
		targetEpoch: number;
	}[] = [];
	const currentPorts = new Map<number, NodeRoomNetworkPort>();
	const accepted = enrolled.map(() => new Set<string>());
	const host = createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" });
	const open = async (index: number, reopen = false) => {
		const node = required(enrolled[index]),
			name = index === 0 ? "creator" : "recipient";
		const head = createNodeRoomHeadAuthority({
			filename: join(directory, `${name}-floor.sqlite`),
			initialization: { kind: reopen ? "reopen" : "create" },
		});
		heads.add(head);
		const room = await createV3RoomSession({
			application,
			author: node.keychain.localAuthorId,
			creatorInvite: invite,
			objectId,
			storageHost: createNodeV3RoomStorageHost({ directory, initialization: () => (reopen ? "reopen" : "create") }),
			roomHeadAuthority: head,
			databaseName: name,
			issuanceDatabaseName: name,
			migrationDatabaseNamespace: name,
			initialLogicalTime: 3,
			publicKeyBytes: Uint8Array.from(Buffer.from(node.keychain.localAuthorId, "hex")),
			signRegisteredVertexDigest: (digest) => node.keychain.signWithLocalAuthor(digest),
			...(index === 0
				? {
						creatorFinalitySigner: await node.keychain.acquireLocalAuthorFinalitySigner(),
						approveSettlementSourceSelection: async (request) => {
							approvals.push({
								exactCanonicalSelectionBytes: request.exactCanonicalSelectionBytes.slice(),
								digest: request.digest.slice(),
								sourceAuthor: request.preview.sourceAuthor,
								sourceDigest: request.preview.sourceDigest,
								targetObjectId: request.preview.targetObjectId,
								targetEpoch: request.preview.targetEpoch,
							});
							if (holdApproval !== undefined) return holdApproval(request.cancellationSignal);
							return approval;
						},
					}
				: {}),
			createOperationAdmissionPolicy: application.createOperationAdmissionPolicy,
			onProjection: () => undefined,
			onAcceptedVertex: (vertex) => {
				accepted[index]?.add(hex(vertex.digest));
			},
			openTransport: () => {
				const port = node.openRoomNetwork(objectId);
				currentPorts.set(index, port);
				return port;
			},
		});
		rooms.add(room);
		await waitForV3RoomStartupForDiagnostics(room);
		return { room, head, name };
	};
	const rows = async (index: number) => {
		const store = await host.openIssuance(index === 0 ? "creator" : "recipient");
		try {
			return await store.readOutboxPage({
				scope: { objectId, author: required(enrolled[index]).keychain.localAuthorId },
				limit: 128,
			});
		} finally {
			await store.close();
		}
	};
	const plan = async () => {
		const store = await host.openIssuance("recipient");
		try {
			return await store.readSettlementPlan({ author: recipient.keychain.localAuthorId, objectId });
		} finally {
			await store.close();
		}
	};
	const successor = async () => {
		const id = parseStorageObjectId(objectId);
		if (!id.ok) throw new Error("invalid fixture storage ID");
		const store = await host.openAhe("creator--ahe"),
			snapshotStore = await host.openSnapshots("creator");
		try {
			return await readCreatorSuccessorExport({
				store,
				snapshotStore,
				catalog,
				objectId: id.value,
				pinnedGenesisAnchorDigest: invite.pinnedGenesisAnchorDigest,
				exactCanonicalGenesisAnchorPreimageBytes: invite.exactCanonicalGenesisAnchorPreimageBytes,
				detachedGenesisSignature: invite.detachedGenesisSignature,
			});
		} finally {
			await snapshotStore.close();
			await store.close();
		}
	};
	return {
		creator,
		recipient,
		open,
		rows,
		plan,
		successor,
		objectId,
		application,
		approvals,
		accepted,
		currentPorts,
		setApproval(value: boolean) {
			approval = value;
		},
		holdApproval(callback: (signal: AbortSignal) => Promise<boolean>) {
			holdApproval = callback;
		},
	};
}

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("R9_SELECTION_FIXTURE_REQUIRED");
	return value;
}
function isPartitionedOriginal(message: Message): boolean {
	if (message.type !== MessageType.MESSAGE_TYPE_V3_ENVELOPE) return false;
	const envelope = V3Envelope.decode(message.data);
	const vertex = decodeCanonical(envelope.canonicalPreimage) as {
		epoch: number;
		operation?: { clientOperationId?: string };
	};
	return vertex.epoch === 0 && vertex.operation?.clientOperationId === "partitioned-original";
}

it("native shipping Chat creator approval roundtrip uses actual CUSTOM and snapshots, refuses unselected/altered before fence, then reopens and continues", async () => {
	const f = await fixture();
	const creator = await f.open(0);
	let recipient = await f.open(1);
	const originalPublish = f.recipient.networkNode.publishMessage.bind(f.recipient.networkNode),
		originalSend = f.recipient.networkNode.sendMessage.bind(f.recipient.networkNode);
	vi.spyOn(f.recipient.networkNode, "publishMessage").mockImplementation((topic, outgoing) =>
		isPartitionedOriginal(outgoing) ? Promise.resolve(true) : originalPublish(topic, outgoing)
	);
	vi.spyOn(f.recipient.networkNode, "sendMessage").mockImplementation((peer, outgoing, options) =>
		isPartitionedOriginal(outgoing) ? Promise.resolve() : originalSend(peer, outgoing, options)
	);
	await recipient.room.issue(message("partitioned-original", "source-bound genuine Chat message"));
	const original = required(
		(await f.rows(1)).find((row) =>
			isPartitionedOriginal({
				type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
				data: V3Envelope.encode({
					canonicalPreimage: row.commit.envelope.canonicalPreimageBytes,
					signature: row.commit.envelope.signature,
				}).finish(),
			} as Message)
		)
	);
	expect(creator.room.projection().messages).toHaveLength(0);
	await creator.room.issue({
		action: "acl",
		kind: "revoke",
		group: "writer",
		target: f.recipient.keychain.localAuthorId,
	});
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	const exported = await f.successor();
	// No policy approval yet: exact source remains debt, without fence/replacement.
	let refusal: unknown;
	try {
		await recipient.room.installCreatorSuccessor({ offer: exported.offer, peers: [f.creator.networkNode.peerId] });
	} catch (error) {
		refusal = error;
	}
	expect(f.approvals).toHaveLength(1);
	expect(refusal).toBeDefined();
	const held = required(await f.plan());
	expect(held.fenceSequence).toBe(null);
	expect(
		required(held.entries.find((row) => row.sourceSequence === original.commit.authorSequence)).replacementSequence
	).toBe(null);
	const proposal = required(f.approvals[0]);
	expect(proposal.sourceAuthor).toBe(f.recipient.keychain.localAuthorId);
	expect(proposal.sourceDigest).toBe(hex(original.commit.envelope.digest));
	expect(proposal.targetObjectId).toBe(f.objectId);
	expect(proposal.targetEpoch).toBe(1);
	await recipient.room.close();
	rooms.delete(recipient.room);
	await recipient.head.close();
	heads.delete(recipient.head);
	// A refused install closes that SDK's transport. A fresh same-node control
	// handle must actually deliver these negative requests to the creator owner.
	const control = f.recipient.openRoomNetwork(f.objectId);
	// Same actual stream owner, foreign target alteration: refuse before policy,
	// signing, ordinal/journal/fence effects. No raw-digest signing fixture.
	const decoded = decodeCanonical(proposal.exactCanonicalSelectionBytes) as Record<string, unknown>;
	const altered = encodeCanonical({ ...decoded, targetObjectId: "foreign:00112233445566778899aabbccddeeff" });
	const beforeRows = await f.rows(0),
		beforeRecipient = await f.rows(1),
		beforePlan = await f.plan(),
		beforeApprovals = f.approvals.length;
	const sign = vi.spyOn(f.creator.keychain, "signWithLocalAuthor");
	await expect(
		control.requestSettlementSourceAuthorization({
			exactCanonicalSelectionBytes: altered,
			digest: hashDomain(DOMAIN, altered),
		})
	).rejects.toThrow("room creator approval was refused or malformed");
	expect(sign).not.toHaveBeenCalled();
	expect(f.approvals).toHaveLength(beforeApprovals);
	expect(await f.rows(0)).toEqual(beforeRows);
	expect(await f.rows(1)).toEqual(beforeRecipient);
	expect(await f.plan()).toEqual(beforePlan);
	sign.mockRestore();
	await control.close();
	f.setApproval(true);
	recipient = await f.open(1, true);
	expect(f.approvals).toHaveLength(2);
	const settled = required(await f.plan());
	expect(settled.fenceSequence).not.toBe(null);
	expect(
		required(settled.entries.find((row) => row.sourceSequence === original.commit.authorSequence)).replacementSequence
	).not.toBe(null);
	expect(recipient.room.projection().messages).toEqual([
		{
			author: f.recipient.keychain.localAuthorId,
			clientOperationId: "partitioned-original",
			displayTimeMs: 1791662400000,
			text: "source-bound genuine Chat message",
		},
	]);
	await expect.poll(() => creator.room.projection().messages).toEqual(recipient.room.projection().messages);
	await recipient.room.close();
	rooms.delete(recipient.room);
	await recipient.head.close();
	heads.delete(recipient.head);
	recipient = await f.open(1, true);
	expect(f.approvals).toHaveLength(2);
	expect(recipient.room.projection().messages).toEqual(creator.room.projection().messages);
	await creator.room.issue(message("continued-creator", "genuine current Writer continuation"));
	await expect.poll(() => recipient.room.projection().messages).toEqual(creator.room.projection().messages);
	await expect(recipient.room.issue(message("revoked-new", "not portable Writer authority"))).rejects.toThrow();
}, 90000);

it("native Chat room health reports lifecycle but never invents a peer-author roster", async () => {
	const f = await fixture();
	const creator = await f.open(0);
	const recipient = await f.open(1);
	const observations = () => f.creator["_roomNetwork"].readControlPlaneObservations();
	expect(creator.room.projection().transportPeerAuthors).toEqual([]);
	expect(observations()[0]).toMatchObject({ objectId: f.objectId, epoch: 0, authenticatedPeerIds: [] });
	const nativeRows = await f.rows(0);
	const originalPeers = f.creator.networkNode.getGroupPeers.bind(f.creator.networkNode);
	const advertiseStranger = vi
		.spyOn(f.creator.networkNode, "getGroupPeers")
		.mockImplementation((topic) => [...originalPeers(topic), "unmapped-transport-stranger"]);
	try {
		expect(observations()[0]?.authenticatedPeerIds).toEqual([]);
	} finally {
		advertiseStranger.mockRestore();
	}
	expect(await f.rows(0)).toEqual(nativeRows);
	await creator.room.issue({
		action: "acl",
		kind: "revoke",
		group: "writer",
		target: f.recipient.keychain.localAuthorId,
	});
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	const exported = await f.successor();
	await recipient.room.installCreatorSuccessor({ offer: exported.offer, peers: [f.creator.networkNode.peerId] });
	expect(observations()[0]).toMatchObject({
		objectId: f.objectId,
		epoch: 1,
		localState: "installed",
		authenticatedPeerIds: [],
	});
	await expect(
		recipient.room.issue(message("admin-not-writer", "membership is not write authority"))
	).rejects.toThrow();
	await creator.room.close();
	rooms.delete(creator.room);
	expect(observations()).toEqual([]);
}, 90000);

it("native shipping Chat actual creator approval cancellation joins source custody before Node signing shutdown", async () => {
	const f = await fixture();
	const creator = await f.open(0),
		recipient = await f.open(1);
	const originalPublish = f.recipient.networkNode.publishMessage.bind(f.recipient.networkNode),
		originalSend = f.recipient.networkNode.sendMessage.bind(f.recipient.networkNode);
	vi.spyOn(f.recipient.networkNode, "publishMessage").mockImplementation((topic, outgoing) =>
		isPartitionedOriginal(outgoing) ? Promise.resolve(true) : originalPublish(topic, outgoing)
	);
	vi.spyOn(f.recipient.networkNode, "sendMessage").mockImplementation((peer, outgoing, options) =>
		isPartitionedOriginal(outgoing) ? Promise.resolve() : originalSend(peer, outgoing, options)
	);
	await recipient.room.issue(message("partitioned-original", "native cancellation retains the exact source"));
	await creator.room.issue({
		action: "acl",
		kind: "revoke",
		group: "writer",
		target: f.recipient.keychain.localAuthorId,
	});
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	const exported = await f.successor();
	await expect(
		recipient.room.installCreatorSuccessor({ offer: exported.offer, peers: [f.creator.networkNode.peerId] })
	).rejects.toThrow();
	const proposal = required(f.approvals[0]),
		beforePlan = await f.plan(),
		beforeRows = await f.rows(1);
	await recipient.room.close();
	rooms.delete(recipient.room);
	await recipient.head.close();
	heads.delete(recipient.head);
	const control = f.recipient.openRoomNetwork(f.objectId);
	let enteredSignal: AbortSignal | undefined;
	let release!: () => void;
	const heldApproval = new Promise<void>((resolve) => {
		release = resolve;
	});
	releases.add(release);
	f.holdApproval(async (signal) => {
		enteredSignal = signal;
		await heldApproval;
		return true;
	});
	const requester = new AbortController();
	const requested = control.requestSettlementSourceAuthorization(
		{ exactCanonicalSelectionBytes: proposal.exactCanonicalSelectionBytes, digest: proposal.digest },
		{ signal: requester.signal }
	);
	void requested.catch(() => undefined);
	await expect.poll(() => enteredSignal !== undefined).toBe(true);
	expect(enteredSignal?.aborted).toBe(false);
	const stopSigning = vi.spyOn(f.creator.keychain, "stop");
	let roomClosed = false,
		nodeStopped = false;
	const roomClose = creator.room.close().then(() => {
		roomClosed = true;
	});
	const nodeStop = f.creator.stop().then(() => {
		nodeStopped = true;
	});
	try {
		await expect.poll(() => enteredSignal?.aborted).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(roomClosed).toBe(false);
		expect(nodeStopped).toBe(false);
		expect(stopSigning).not.toHaveBeenCalled();
		expect(await f.plan()).toEqual(beforePlan);
		expect(await f.rows(1)).toEqual(beforeRows);
	} finally {
		release();
	}
	await Promise.all([roomClose, nodeStop]);
	expect(stopSigning).toHaveBeenCalledTimes(1);
	requester.abort(new Error("creator approval unavailable after joined shutdown"));
	await expect(requested).rejects.toThrow();
	await control.close();
	expect(await f.plan()).toEqual(beforePlan);
	expect(await f.rows(1)).toEqual(beforeRows);
	rooms.delete(creator.room);
	nodes.delete(f.creator);
}, 90000);
