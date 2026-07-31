import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { type Address, type PeerId } from "@libp2p/interface";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { createACL } from "@ts-drp/object";
import {
	type DRPNetworkNode,
	type GroupPeerChangeHandler,
	type IDRP,
	type Message,
	MessageType,
	type NodeConnectObjectOptions,
	type NodeCreateObjectOptions,
	SemanticsType,
	Update,
} from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { verifyACLIncomingVertices } from "../src/handlers.js";
import { DRPNode } from "../src/index.js";

class ProductPathDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: number[] = [];

	append(value: number): void {
		this.values.push(value);
	}

	query_values(): number[] {
		return [...this.values];
	}
}

interface FakeNetworkControls {
	broadcastMessage: ReturnType<typeof vi.fn>;
	networkNode: DRPNetworkNode;
	subscribe: ReturnType<typeof vi.fn>;
}

function createFakeNetwork(): FakeNetworkControls {
	const messageHandlers: Array<(message: Message) => Promise<void>> = [];
	const groupHandlers: GroupPeerChangeHandler[] = [];
	const subscribe = vi.fn();
	const broadcastMessage = vi.fn(() => Promise.resolve());
	const networkNode = {
		membershipVerifier: undefined,
		peerId: "",
		start: vi.fn(function (this: DRPNetworkNode, rawPrivateKey?: Uint8Array): Promise<void> {
			if (rawPrivateKey === undefined) throw new Error("Expected the node identity key");
			this.peerId = peerIdFromPublicKey(privateKeyFromRaw(rawPrivateKey).publicKey).toString();
			return Promise.resolve();
		}),
		stop: vi.fn(() => Promise.resolve()),
		restart: vi.fn(() => Promise.resolve()),
		isDialable: vi.fn(() => Promise.resolve(false)),
		changeTopicScoreParams: vi.fn(),
		removeTopicScoreParams: vi.fn(),
		subscribe,
		unsubscribe: vi.fn(),
		connectToBootstraps: vi.fn(() => Promise.resolve()),
		connect: vi.fn(() => Promise.resolve()),
		disconnect: vi.fn(() => Promise.resolve()),
		getPeerMultiaddrs: vi.fn((_peerId: PeerId | string): Promise<Address[]> => Promise.resolve([])),
		getBootstrapNodes: vi.fn((): string[] => []),
		getSubscribedTopics: vi.fn((): string[] => []),
		getMultiaddrs: vi.fn((): string[] => []),
		getAllPeers: vi.fn((): string[] => []),
		getGroupPeers: vi.fn((): string[] => []),
		broadcastMessage,
		sendMessage: vi.fn(() => Promise.resolve()),
		sendGroupMessageRandomPeer: vi.fn(() => Promise.resolve()),
		subscribeToMessageQueue: vi.fn((handler) => {
			messageHandlers.push(handler);
		}),
		subscribeToGroupPeerChanges: vi.fn((handler) => {
			groupHandlers.push(handler);
			return (): void => {
				const index = groupHandlers.indexOf(handler);
				if (index !== -1) groupHandlers.splice(index, 1);
			};
		}),
	} satisfies DRPNetworkNode;
	return { broadcastMessage, networkNode, subscribe };
}

async function productNode(seed: string): Promise<{ controls: FakeNetworkControls; node: DRPNode }> {
	const controls = createFakeNetwork();
	const node = new DRPNode(
		{
			keychain_config: { private_key_seed: seed },
			log_config: { level: "silent" },
		},
		{ networkNode: controls.networkNode, reconnect: false }
	);
	await node.start();
	return { controls, node };
}

function updatesFor(controls: FakeNetworkControls, objectId: string): Message[] {
	return controls.broadcastMessage.mock.calls
		.map(([, message]) => message as Message)
		.filter(({ objectId: id, type }) => id === objectId && type === MessageType.MESSAGE_TYPE_UPDATE);
}

function attestationUpdatesFor(controls: FakeNetworkControls, objectId: string): Message[] {
	return controls.broadcastMessage.mock.calls
		.map(([, message]) => message as Message)
		.filter(({ objectId: id, type }) => id === objectId && type === MessageType.MESSAGE_TYPE_ATTESTATION_UPDATE);
}

async function latestUpdate(controls: FakeNetworkControls, objectId: string, count: number): Promise<Update> {
	await vi.waitFor(() => expect(updatesFor(controls, objectId)).toHaveLength(count));
	const message = updatesFor(controls, objectId).at(-1);
	if (message === undefined) throw new Error(`Expected UPDATE for ${objectId}`);
	return Update.decode(message.data);
}

describe("Phase 1c public node finality configuration", () => {
	const nodes: DRPNode[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		await Promise.allSettled(nodes.splice(0).map((node) => node.stop()));
	});

	test("createObject forwards a room-scoped disabled finality config without weakening vertex handling", async () => {
		const { controls, node } = await productNode("phase-1c-public-create");
		nodes.push(node);
		const acl = createACL({ admins: [node.networkNode.peerId] });
		acl.context = { caller: node.networkNode.peerId };
		acl.setKey(node.keychain.blsPublicKey);
		acl.context = { caller: "" };
		const options = {
			acl,
			drp: new ProductPathDRP(),
			finality_config: { enabled: false },
			id: "phase-1c-public-create-disabled",
		} satisfies NodeCreateObjectOptions<ProductPathDRP>;

		const disabled = await node.createObject(options);
		const enabledSibling = await node.createObject({
			drp: new ProductPathDRP(),
			id: "phase-1c-public-create-enabled",
		});
		const blsSigns = vi.spyOn(node.keychain, "signWithBls");

		disabled.drp?.append(7);
		const update = await latestUpdate(controls, disabled.id, 1);

		expect.soft(node.get(disabled.id)).toBe(disabled);
		expect.soft(node.messageQueueManager.hasQueue(disabled.id)).toBe(true);
		expect.soft(controls.subscribe).toHaveBeenCalledWith(disabled.id);
		expect.soft(disabled.finalityStore.enabled).toBe(false);
		expect.soft(enabledSibling.finalityStore.enabled).toBe(true);
		expect.soft(disabled.finalityStore.states.size).toBe(0);
		expect.soft(blsSigns).toHaveBeenCalledTimes(0);
		expect.soft(update.attestations).toEqual([]);
		expect.soft(attestationUpdatesFor(controls, disabled.id)).toEqual([]);
		expect.soft(update.vertices).toHaveLength(1);
		expect.soft(update.vertices[0]?.signature).toHaveLength(65);
		expect.soft(verifyACLIncomingVertices(update.vertices)).toHaveLength(1);
		expect(disabled.drp?.query_values()).toEqual([7]);
	});

	test("connectObject independently forwards disabled finality config and keeps a default sibling enabled", async () => {
		const { controls, node } = await productNode("phase-1c-public-connect");
		nodes.push(node);
		vi.useFakeTimers();
		const disabledId = `${node.networkNode.peerId}:phase-1c-public-connect-disabled`;
		const enabledId = `${node.networkNode.peerId}:phase-1c-public-connect-enabled`;
		const options = {
			drp: new ProductPathDRP(),
			finality_config: { enabled: false },
			id: disabledId,
		} satisfies NodeConnectObjectOptions<ProductPathDRP>;
		const disabledConnection = node.connectObject(options);
		const enabledConnection = node.connectObject({ drp: new ProductPathDRP(), id: enabledId });
		await vi.advanceTimersByTimeAsync(5_000);
		const [disabled, enabledSibling] = await Promise.all([disabledConnection, enabledConnection]);
		vi.useRealTimers();
		const blsSigns = vi.spyOn(node.keychain, "signWithBls");

		disabled.acl.context = { caller: node.networkNode.peerId };
		disabled.acl.setKey(node.keychain.blsPublicKey);
		await latestUpdate(controls, disabled.id, 1);
		disabled.drp?.append(11);
		const update = await latestUpdate(controls, disabled.id, 2);

		expect.soft(node.get(disabled.id)).toBe(disabled);
		expect.soft(node.messageQueueManager.hasQueue(disabled.id)).toBe(true);
		expect.soft(controls.subscribe).toHaveBeenCalledWith(disabled.id);
		expect.soft(disabled.finalityStore.enabled).toBe(false);
		expect.soft(enabledSibling.finalityStore.enabled).toBe(true);
		expect.soft(disabled.finalityStore.states.size).toBe(0);
		expect.soft(blsSigns).toHaveBeenCalledTimes(0);
		expect.soft(update.attestations).toEqual([]);
		expect.soft(attestationUpdatesFor(controls, disabled.id)).toEqual([]);
		expect.soft(update.vertices[0]?.signature).toHaveLength(65);
		expect.soft(verifyACLIncomingVertices(update.vertices)).toHaveLength(1);
		expect(disabled.drp?.query_values()).toEqual([11]);
	});
});
