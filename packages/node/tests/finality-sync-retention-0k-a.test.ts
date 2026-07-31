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

	it("includes exactly every signed requested non-root vertex attestation in a real SYNC response", async () => {
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
		if (requestedVertices.length === 0) throw new Error("Expected signed non-root vertices");

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
		const signedRequestedHashes = requestedVertices.map(({ hash }) => hash);
		expect(response.requested.map(({ hash }) => hash)).toEqual(object.vertices.map(({ hash }) => hash));
		expect(new Set(attestationHashes)).toEqual(new Set(signedRequestedHashes));
		expect(attestationHashes).toHaveLength(signedRequestedHashes.length);
		for (const attestation of response.attestations) expect(attestation.signature.length).toBeGreaterThan(0);
	}, 20_000);
});
