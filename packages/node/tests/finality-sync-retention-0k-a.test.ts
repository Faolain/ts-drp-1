import { type IDRP, Message, MessageType, SemanticsType, Sync, SyncAccept } from "@ts-drp/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleMessage, signFinalityVertices } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";

class SyncRetentionProbeDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: number[] = [];

	append(value: number): void {
		this.values.push(value);
	}
}

async function makeNode(): Promise<DRPNode> {
	const node = new DRPNode({
		network_config: {
			bootstrap_peers: [],
			listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
			log_config: { level: "silent" },
		},
		keychain_config: { private_key_seed: "phase-0k-a-sync-retention" },
		log_config: { level: "silent" },
	});
	await node.start();
	return node;
}

describe("Phase 0k-a ancient finality sync completeness", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	it("includes resident attestations for both the oldest and newest requested vertices in a real SYNC response", async () => {
		const node = await makeNode();
		nodes.push(node);
		const direct: Message[] = [];
		vi.spyOn(node.networkNode, "sendMessage").mockImplementation((_peerId, message) => {
			direct.push(message);
			return Promise.resolve();
		});
		vi.spyOn(node.networkNode, "broadcastMessage").mockResolvedValue();
		const object = await node.createObject({
			id: "phase-0k-a-sync-retention-object",
			drp: new SyncRetentionProbeDRP(),
		});
		object.acl.setKey(node.keychain.blsPublicKey);
		for (let value = 0; value < 32; value++) object.drp?.append(value);
		const requestedVertices = object.vertices.filter(({ operation }) => operation?.opType !== "-1");
		signFinalityVertices(node, object, requestedVertices);
		const oldest = requestedVertices[0];
		const newest = requestedVertices.at(-1);
		if (!oldest || !newest) throw new Error("Expected an old and new retained vertex");

		await handleMessage(
			node,
			Message.create({
				sender: "phase-0k-a-sync-requester",
				type: MessageType.MESSAGE_TYPE_SYNC,
				data: Sync.encode(Sync.create({ vertexHashes: [] })).finish(),
				objectId: object.id,
			})
		);

		const responses = direct.filter(({ type }) => type === MessageType.MESSAGE_TYPE_SYNC_ACCEPT);
		expect(responses).toHaveLength(1);
		const response = SyncAccept.decode(responses[0].data);
		const attestationHashes = response.attestations.map(({ data }) => data);
		expect(response.requested.map(({ hash }) => hash)).toEqual(object.vertices.map(({ hash }) => hash));
		expect(attestationHashes).toContain(oldest.hash);
		expect(attestationHashes).toContain(newest.hash);
		expect(response.attestations.find(({ data }) => data === oldest.hash)?.signature.length).toBeGreaterThan(0);
		expect(response.attestations.find(({ data }) => data === newest.hash)?.signature.length).toBeGreaterThan(0);
	}, 20_000);
});
