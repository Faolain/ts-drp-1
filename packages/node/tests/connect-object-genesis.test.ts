/**
 * RED contracts for creator-bound object ids. A joining replica must derive
 * genesis authority locally from the id, before any object-topic peer exists.
 * Legacy field 4 below models the vulnerable rootAclState SYNC_ACCEPT payload;
 * GREEN removes that field and ignores it as unknown protobuf data.
 */
import {
	ActionType,
	DRPStateOtherTheWire,
	type IDRP,
	type IDRPObject,
	type Message,
	MessageType,
	type ResolveConflictsType,
	SemanticsType,
	SyncAccept,
	type Vertex,
} from "@ts-drp/types";
import { serializeDRPState } from "@ts-drp/utils/serialization";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DRPObject, HashGraph } from "@ts-drp/object";

import { handleMessage } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";

class CounterDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	value = 0;

	increment(): void {
		this.value += 1;
	}

	resolveConflicts(_: Vertex[]): ResolveConflictsType {
		return { action: ActionType.Nop };
	}
}

async function makeNode(seed: string, intervalSync?: number): Promise<DRPNode> {
	const node = new DRPNode({
		network_config: {
			bootstrap_peers: [],
			listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
			log_config: { level: "silent" },
		},
		keychain_config: { private_key_seed: seed },
		interval_sync_options: intervalSync === undefined ? undefined : { interval: intervalSync },
		log_config: { level: "silent" },
	});
	await node.start();
	return node;
}

/** Encode the removed rootAclState field as legacy protobuf field 4. */
function maliciousSyncAccept(rootACLState: ReturnType<typeof serializeDRPState>): Uint8Array {
	const writer = SyncAccept.encode(
		SyncAccept.create({
			requested: [],
			attestations: [],
			requesting: [],
		})
	);
	DRPStateOtherTheWire.encode(rootACLState, writer.uint32(34).fork()).join();
	return writer.finish();
}

describe("connectObject creator-bound genesis", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	test("an attacker cannot hijack genesis authority with the first SYNC_ACCEPT", async () => {
		const creator = await makeNode("id-binding-creator");
		const attacker = await makeNode("id-binding-attacker");
		const joiner = await makeNode("id-binding-joiner");
		nodes.push(creator, attacker, joiner);

		const creatorObject = await creator.createObject({ drp: new CounterDRP() });
		const attackerObject = new DRPObject({ peerId: attacker.networkNode.peerId });
		const [attackerRootACL] = attackerObject.getStates(HashGraph.rootHash);
		if (!attackerRootACL) throw new Error("Expected attacker's root ACL state");

		// Fresh joiner state is installed without calling connectObject so the test
		// can deliver the adversarial first response deterministically.
		const joinedObject = new DRPObject({
			peerId: joiner.networkNode.peerId,
			id: creatorObject.id,
			drp: new CounterDRP(),
		});
		joiner.put(joinedObject.id, joinedObject);

		await handleMessage(
			joiner,
			{
				sender: attacker.networkNode.peerId,
				type: MessageType.MESSAGE_TYPE_SYNC_ACCEPT,
				data: maliciousSyncAccept(serializeDRPState(attackerRootACL)),
				objectId: creatorObject.id,
			} as Message
		);

		expect(joinedObject.acl.query_isAdmin(attacker.networkNode.peerId)).toBe(false);
		expect(joinedObject.acl.query_isFinalitySigner(attacker.networkNode.peerId)).toBe(false);
		expect(joinedObject.acl.query_isAdmin(creator.networkNode.peerId)).toBe(true);
		expect(joinedObject.acl.query_isFinalitySigner(creator.networkNode.peerId)).toBe(true);
		expect([...joinedObject.acl.query_getFinalitySigners().keys()]).toEqual([creator.networkNode.peerId]);
	});

	test("join-before-peer converges using locally derived creator authority", async () => {
		const creator = await makeNode("join-before-peer-creator");
		const joiner = await makeNode("join-before-peer-joiner", 100);
		nodes.push(creator, joiner);

		const creatorObject = await creator.createObject({ drp: new CounterDRP() });
		creatorObject.acl.setKey(creator.keychain.blsPublicKey);
		creatorObject.drp?.increment();

		const groupPeers = vi.spyOn(joiner.networkNode, "getGroupPeers").mockReturnValue([]);
		vi.spyOn(joiner.networkNode, "sendGroupMessageRandomPeer").mockResolvedValue();
		vi.spyOn(joiner.networkNode, "sendMessage").mockResolvedValue();
		vi.spyOn(creator.networkNode, "sendMessage").mockResolvedValue();

		// connectObject completes its whole no-peer window before A becomes visible.
		vi.useFakeTimers();
		const connecting = joiner.connectObject({ id: creatorObject.id, drp: new CounterDRP() });
		await vi.advanceTimersByTimeAsync(5_000);
		const joinedObject = (await connecting) as IDRPObject<CounterDRP>;

		// Genesis is already correct; no FETCH_STATE or SYNC responder supplied it.
		expect(joinedObject.acl.query_isAdmin(creator.networkNode.peerId)).toBe(true);
		expect(joinedObject.acl.query_isFinalitySigner(creator.networkNode.peerId)).toBe(true);
		expect(joinedObject.acl.query_isAdmin(joiner.networkNode.peerId)).toBe(false);

		groupPeers.mockReturnValue([creator.networkNode.peerId]);
		vi.mocked(joiner.networkNode.sendMessage).mockImplementation(async (_peerId, message) => {
			if (message.type === MessageType.MESSAGE_TYPE_SYNC) await handleMessage(creator, message);
		});
		vi.mocked(creator.networkNode.sendMessage).mockImplementation(async (_peerId, message) => {
			if (message.type === MessageType.MESSAGE_TYPE_SYNC_ACCEPT) await handleMessage(joiner, message);
		});

		await vi.advanceTimersByTimeAsync(100);
		await vi.waitFor(() => expect(joinedObject.drp?.value).toBe(creatorObject.drp?.value));

		expect(new Set(joinedObject.vertices.map(({ hash }) => hash))).toEqual(
			new Set(creatorObject.vertices.map(({ hash }) => hash))
		);
		expect(joinedObject.acl.query_getPeerKey(creator.networkNode.peerId)).toBe(creator.keychain.blsPublicKey);
	}, 15_000);
});
