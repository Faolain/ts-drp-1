/* eslint-disable @typescript-eslint/explicit-function-return-type -- Existing native fixture capability inference. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { openTrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { DRPNetworkNode } from "@ts-drp/network";
import { MessageType, V3Envelope } from "@ts-drp/types";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";

import {
	createShippingChatGenesisStateBytes,
	createShippingV3ChatApplication,
	type ShippingChatProjection,
} from "../examples/chat/src/v3-chat-application.js";
import { readCreatorSuccessorExport } from "../packages/node/src/creator-adoption.js";
import { DRPNode } from "../packages/node/src/index.js";
import {
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type V3RoomSession,
	waitForV3RoomStartupForDiagnostics,
} from "../packages/node/src/v3-room.js";
import { parseStorageObjectId } from "../packages/storage/src/index.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";
import { createNodeV3RoomStorageHost } from "../packages/storage-node/src/v3-room-host.js";

// Original two role shapes on the current genuine shipping catalog/profile.
// Real local libp2p delivery and snapshot streams, not WAN/device/UI evidence.
const nodes = new Set<DRPNode>();
const rooms = new Set<V3RoomSession<ShippingChatProjection>>();
const heads = new Set<ReturnType<typeof createNodeRoomHeadAuthority>>();
const directories = new Set<string>();
const releases = new Set<() => void>();
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const message = (id: string) => ({ action: "message", clientOperationId: id, displayTimeMs: 1791662400000, text: id });
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("R9_ROLE_NETWORK_FIXTURE_REQUIRED");
	return value;
}

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

async function fixture(shape: "same-target" | "distinct-target") {
	const catalogDirectory = process.env.SHIPPING_CHAT_CATALOG_DIR;
	if (catalogDirectory === undefined) throw new Error("SHIPPING_CHAT_CATALOG_DIR must name the accepted catalog");
	const catalog = openTrustedBlueprintCatalog({ catalogDirectory });
	expect(catalog.blueprintDigests).toHaveLength(1);
	const blueprintDigest = required(catalog.blueprintDigests[0]);
	const directory = mkdtempSync(join(tmpdir(), "r9-chat-role-network-"));
	directories.add(directory);
	const creator = await startNode(`r9-role-network-${shape}-creator`),
		recipient = await startNode(`r9-role-network-${shape}-recipient`);
	await recipient.networkNode.connect(creator.networkNode.getMultiaddrs());
	await expect
		.poll(() => creator.networkNode.getAllPeers(), { timeout: 15000 })
		.toContain(recipient.networkNode.peerId);
	const enrolled = [creator, recipient];
	const objectId = `${creator.networkNode.peerId}:${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
	const acl = {
		epoch: 0,
		kind: "drp-v3-latched-acl",
		objectId,
		permissionless: false,
		version: 3,
		members: enrolled
			.map((node, index) => ({
				author: node.keychain.localAuthorId,
				finalityKey: index === 0 ? node.keychain.localAuthorId : null,
				groups:
					index === 0
						? shape === "same-target"
							? ["admin", "finality"]
							: ["admin", "finality", "writer"]
						: shape === "same-target"
							? ["admin", "writer"]
							: ["admin"],
			}))
			.sort((a, b) => a.author.localeCompare(b.author)),
	};
	const exactCanonicalLatchedAclBytes = encodeCanonical(acl);
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
	const accepted = enrolled.map(() => new Set<string>());
	const host = createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" });
	const signing = enrolled.map((node) => vi.spyOn(node.keychain, "signWithLocalAuthor"));
	const publications = enrolled.map((node) => vi.spyOn(node.networkNode, "publishMessage"));
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
			...(index === 0 ? { creatorFinalitySigner: await node.keychain.acquireLocalAuthorFinalitySigner() } : {}),
			createOperationAdmissionPolicy: application.createOperationAdmissionPolicy,
			onProjection: () => undefined,
			onAcceptedVertex: (vertex) => {
				accepted[index]?.add(hex(vertex.digest));
			},
			openTransport: () => node.openRoomNetwork(objectId),
		});
		rooms.add(room);
		await waitForV3RoomStartupForDiagnostics(room);
		return { room, head };
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
	const successor = async () => {
		const id = parseStorageObjectId(objectId);
		if (!id.ok) throw new Error("invalid fixture object ID");
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
	const nativeImage = () =>
		encodeCanonical(
			readdirSync(directory)
				.filter((name) => name.endsWith(".sqlite"))
				.sort()
				.map((name) => {
					const db = new DatabaseSync(join(directory, name), { readOnly: true });
					try {
						return {
							name,
							tables: db
								.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
								.all()
								.map((row) => {
									const table = row.name as string,
										escaped = '"' + table.replaceAll('"', '""') + '"';
									const order = db
										.prepare("PRAGMA table_info(" + escaped + ")")
										.all()
										.map((column) => '"' + (column.name as string).replaceAll('"', '""') + '"')
										.join(",");
									return { table, rows: db.prepare("SELECT * FROM " + escaped + " ORDER BY " + order).all() };
								}),
						};
					} finally {
						db.close();
					}
				})
		);
	const effects = () => ({
		native: nativeImage(),
		signing: signing.map((spy) => spy.mock.calls.length),
	});
	const refusedPublications = (ids: readonly string[]) =>
		publications
			.flatMap((spy) => spy.mock.calls)
			.filter(([, outgoing]) => {
				if (outgoing.type !== MessageType.MESSAGE_TYPE_V3_ENVELOPE) return false;
				const envelope = V3Envelope.decode(outgoing.data);
				const vertex = decodeCanonical(envelope.canonicalPreimage) as {
					operation?: { clientOperationId?: string; action?: string; group?: string; kind?: string };
				};
				return (
					ids.includes(vertex.operation?.clientOperationId ?? "") ||
					(vertex.operation?.action === "acl" &&
						vertex.operation.group === "admin" &&
						vertex.operation.kind === "grant")
				);
			});
	return { creator, recipient, objectId, acl, invite, accepted, open, rows, successor, effects, refusedPublications };
}

it.each(["same-target", "distinct-target"] as const)(
	"native actual-network original concurrent Writer grant and Finality revoke installs recipient roles and reopens (%s)",
	async (shape) => {
		const f = await fixture(shape),
			creator = await f.open(0);
		let recipient = await f.open(1);
		const granted = shape === "same-target" ? creator : recipient;
		const grantedAuthor =
			shape === "same-target" ? f.creator.keychain.localAuthorId : f.recipient.keychain.localAuthorId;
		const before = f.effects();
		await expect(granted.room.issue(message("not-yet-writer"))).rejects.toThrow();
		// Exact causalJoin is a v1 settlement control. Gameplay fields must not
		// convert a malformed control into a non-Writer admission bypass.
		await expect(
			granted.room.issue({ action: "causalJoin", clientOperationId: "forged-control", text: "gameplay" })
		).rejects.toThrow();
		expect(f.effects()).toEqual(before);
		expect(f.refusedPublications(["not-yet-writer", "forged-control"])).toEqual([]);
		// Hold only the two actual outgoing candidates until both native signed
		// rows exist; release delivers unchanged bytes over real libp2p. Retained
		// repair joins this barrier, with no fake ACK or direct recipient ingress.
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		releases.add(release);
		const concurrentControl = (outgoing: { type: number; data: Uint8Array }) => {
			if (outgoing.type !== MessageType.MESSAGE_TYPE_V3_ENVELOPE) return false;
			const vertex = decodeCanonical(V3Envelope.decode(outgoing.data).canonicalPreimage) as {
				operation?: { action?: string; group?: string; kind?: string };
			};
			return (
				vertex.operation?.action === "acl" &&
				((vertex.operation.group === "writer" && vertex.operation.kind === "grant") ||
					(vertex.operation.group === "finality" && vertex.operation.kind === "revoke"))
			);
		};
		for (const node of [f.creator, f.recipient]) {
			const publish = node.networkNode.publishMessage.bind(node.networkNode),
				send = node.networkNode.sendMessage.bind(node.networkNode);
			vi.spyOn(node.networkNode, "publishMessage").mockImplementation(async (topic, outgoing) => {
				if (concurrentControl(outgoing)) await barrier;
				return publish(topic, outgoing);
			});
			vi.spyOn(node.networkNode, "sendMessage").mockImplementation(async (peer, outgoing, options) => {
				if (concurrentControl(outgoing)) await barrier;
				return send(peer, outgoing, options);
			});
		}
		let concurrentCompleted = false;
		const concurrent = Promise.all([
			recipient.room.issue({ action: "acl", group: "writer", kind: "grant", target: grantedAuthor }),
			creator.room.issue({
				action: "acl",
				group: "finality",
				kind: "revoke",
				target: f.creator.keychain.localAuthorId,
			}),
		]).then(() => {
			concurrentCompleted = true;
		});
		void concurrent.catch(() => undefined);
		try {
			for (const index of [0, 1])
				await expect
					.poll(
						async () =>
							(await f.rows(index)).some((row) =>
								concurrentControl({
									type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
									data: V3Envelope.encode({
										canonicalPreimage: row.commit.envelope.canonicalPreimageBytes,
										signature: row.commit.envelope.signature,
									}).finish(),
								})
							),
						{ timeout: 15000 }
					)
					.toBe(true);
			const grant = required((await f.rows(1)).at(-1)),
				revoke = required((await f.rows(0)).at(-1));
			const grantPreimage = decodeCanonical(grant.commit.envelope.canonicalPreimageBytes) as { dependencies: string[] },
				revokePreimage = decodeCanonical(revoke.commit.envelope.canonicalPreimageBytes) as { dependencies: string[] };
			expect(grantPreimage.dependencies).not.toContain(hex(revoke.commit.envelope.digest));
			expect(revokePreimage.dependencies).not.toContain(hex(grant.commit.envelope.digest));
			expect(required(f.accepted[0]).has(hex(grant.commit.envelope.digest))).toBe(false);
			expect(required(f.accepted[1]).has(hex(revoke.commit.envelope.digest))).toBe(false);
			expect(concurrentCompleted).toBe(false);
		} finally {
			release();
			releases.delete(release);
		}
		await concurrent;
		const grant = required((await f.rows(1)).at(-1)),
			revoke = required((await f.rows(0)).at(-1));
		const grantPreimage = decodeCanonical(grant.commit.envelope.canonicalPreimageBytes) as { dependencies: string[] },
			revokePreimage = decodeCanonical(revoke.commit.envelope.canonicalPreimageBytes) as { dependencies: string[] };
		expect(grantPreimage.dependencies).not.toContain(hex(revoke.commit.envelope.digest));
		expect(revokePreimage.dependencies).not.toContain(hex(grant.commit.envelope.digest));
		await Promise.all([
			creator.room.requestRetainedRepair({ targetPeerId: f.recipient.networkNode.peerId }),
			recipient.room.requestRetainedRepair({ targetPeerId: f.creator.networkNode.peerId }),
		]);
		await expect
			.poll(() => required(f.accepted[0]).has(hex(grant.commit.envelope.digest)), { timeout: 15000 })
			.toBe(true);
		await expect
			.poll(() => required(f.accepted[1]).has(hex(revoke.commit.envelope.digest)), { timeout: 15000 })
			.toBe(true);
		expect(creator.room.previewLatchedAcl().current).toEqual(f.acl);
		expect(recipient.room.previewLatchedAcl().current).toEqual(f.acl);
		await creator.room.issue({
			action: "acl",
			group: "admin",
			kind: "revoke",
			target: f.recipient.keychain.localAuthorId,
		});
		const expectedAcl = {
			...f.acl,
			epoch: 1,
			members: [
				{ author: f.creator.keychain.localAuthorId, finalityKey: null, groups: ["admin", "writer"] },
				{ author: f.recipient.keychain.localAuthorId, finalityKey: null, groups: ["writer"] },
			].sort((a, b) => a.author.localeCompare(b.author)),
		};
		await expect.poll(() => recipient.room.previewLatchedAcl().next, { timeout: 15000 }).toEqual(expectedAcl);
		expect(creator.room.previewLatchedAcl().next).toEqual(expectedAcl);
		expect(creator.room.previewLatchedAcl().nextSigners).toEqual([]);
		const sealed = await creator.room.sealEpoch();
		expect(sealed).toMatchObject({ ok: true, successorEpoch: 1 });
		if (!sealed.ok) throw new Error("role epoch failed to seal");
		await creator.room.adoptCreatorSuccessor();
		const exported = await f.successor();
		const trust = decodeCanonical(exported.offer.exactCanonicalTrustStateRecordBytes) as Record<string, unknown>;
		expect(trust.currentEpoch).toBe(1);
		expect(trust.exactCanonicalSignerSetBytes).toEqual(f.invite.exactCanonicalSignerSetBytes);
		expect(trust.exactCanonicalProfileBytes).toEqual(f.invite.exactCanonicalProfileBytes);
		expect(
			ed25519.verify(
				trust.detachedCurrentAnchorSignature as Uint8Array,
				Buffer.from(sealed.successorAnchorDigest, "hex"),
				Buffer.from(f.creator.keychain.localAuthorId, "hex"),
				{ zip215: false }
			)
		).toBe(true);
		const qc = decodeCanonical(exported.offer.exactCanonicalCommitQcBytes) as Record<string, unknown>;
		expect(qc).toMatchObject({ epoch: 0, objectId: f.objectId, phase: "commit" });
		const votes = qc.votes as { signerId: string; signature: string; voteDigest: string }[];
		expect(votes).toHaveLength(1);
		for (const vote of votes) {
			expect(vote.signerId).toBe("creator");
			const digest = hashDomain(
				"ts-drp/seal-vote/v3",
				encodeCanonical({
					epoch: qc.epoch,
					kind: "drp-seal-vote",
					objectId: qc.objectId,
					phase: qc.phase,
					proposalDigest: qc.proposalDigest,
					proposalHash: qc.proposalHash,
					round: qc.round,
					signerId: vote.signerId,
				})
			);
			expect(hex(digest)).toBe(vote.voteDigest);
			expect(
				ed25519.verify(
					Buffer.from(vote.signature, "hex"),
					digest,
					Buffer.from(f.creator.keychain.localAuthorId, "hex"),
					{ zip215: false }
				)
			).toBe(true);
		}
		await recipient.room.installCreatorSuccessor({ offer: exported.offer, peers: [f.creator.networkNode.peerId] });
		expect(recipient.room.previewLatchedAcl().current).toEqual(expectedAcl);
		expect(recipient.room.authority()?.aclDigest).toBe(
			hex(hashDomain("ts-drp/latched-acl/v3", encodeCanonical(expectedAcl)))
		);
		const refuseRevoked = async () => {
			const before = f.effects(),
				projection = recipient.room.projection();
			await expect(
				recipient.room.issue({
					action: "acl",
					group: "admin",
					kind: "grant",
					target: f.recipient.keychain.localAuthorId,
				})
			).rejects.toThrow();
			expect(f.effects()).toEqual(before);
			expect(f.refusedPublications(["not-yet-writer", "forged-control"])).toEqual([]);
			expect(recipient.room.projection()).toEqual(projection);
		};
		await refuseRevoked();
		await recipient.room.issue(message("writer-after-recipient-activation"));
		await expect
			.poll(() => creator.room.projection().messages, { timeout: 15000 })
			.toEqual(recipient.room.projection().messages);
		await recipient.room.close();
		rooms.delete(recipient.room);
		await recipient.head.close();
		heads.delete(recipient.head);
		recipient = await f.open(1, true);
		expect(recipient.room.previewLatchedAcl().current).toEqual(expectedAcl);
		expect(recipient.room.projection().messages.map((entry) => entry.clientOperationId)).toEqual([
			"writer-after-recipient-activation",
		]);
		await refuseRevoked();
		await recipient.room.issue(message("writer-after-recipient-reopen"));
		await expect
			.poll(() => creator.room.projection().messages, { timeout: 15000 })
			.toEqual(recipient.room.projection().messages);
		expect(recipient.room.projection().messages.map((entry) => entry.clientOperationId)).toEqual([
			"writer-after-recipient-activation",
			"writer-after-recipient-reopen",
		]);
	},
	120000
);
