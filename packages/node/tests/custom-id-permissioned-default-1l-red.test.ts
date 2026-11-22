import { SetDRP } from "@ts-drp/blueprints";
import { createACL, HashGraph } from "@ts-drp/object";
import type { DRPNodeConfig, IDRP, IDRPObject } from "@ts-drp/types";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { DRPNode } from "../src/index.js";

interface GenesisStateReader {
	getSerializedStates(
		vertexHash: string
	): readonly [aclState: Uint8Array | undefined, drpState: Uint8Array | undefined];
}

function rootACLBytes(object: GenesisStateReader): Uint8Array {
	const [bytes] = object.getSerializedStates(HashGraph.rootHash);
	if (bytes === undefined) throw new Error("Product-path object has no genesis ACL snapshot");
	return bytes;
}

describe.sequential("Phase 1l custom-id permissioned default", () => {
	let creator: DRPNode;
	let foreignCreator: DRPNode;
	let joiner: DRPNode;

	beforeAll(async () => {
		const nodeConfig = (private_key_seed: string): DRPNodeConfig => ({
			keychain_config: { private_key_seed },
			log_config: { level: "silent" },
			network_config: {
				bootstrap_peers: [],
				listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
				log_config: { level: "silent" },
			},
		});
		creator = new DRPNode(nodeConfig("phase-1l-custom-id-creator"));
		foreignCreator = new DRPNode(nodeConfig("phase-1l-custom-id-foreign"));
		joiner = new DRPNode(nodeConfig("phase-1l-custom-id-joiner"));
		await Promise.all([creator.start(), foreignCreator.start(), joiner.start()]);
	}, 15_000);

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await Promise.allSettled([creator.stop(), foreignCreator.stop(), joiner.stop()]);
	});

	async function connectWithoutPeer<T extends IDRP>(
		id: string,
		drp: T,
		acl?: ReturnType<typeof createACL>
	): Promise<IDRPObject<T>> {
		vi.useFakeTimers();
		const connecting = joiner.connectObject({ id, drp, ...(acl === undefined ? {} : { acl }) });
		await vi.advanceTimersByTimeAsync(5_000);
		const object = await connecting;
		vi.useRealTimers();
		return object;
	}

	async function expectRejectedBeforePublication(id: string): Promise<void> {
		const subscribe = vi.spyOn(creator.networkNode, "subscribe");
		let rejection: unknown;
		try {
			await creator.createObject({ id, drp: new SetDRP<number>() });
		} catch (error) {
			rejection = error;
		}

		expect.soft(rejection).toBeInstanceOf(Error);
		expect.soft(creator.get(id) === undefined).toBe(true);
		expect.soft(subscribe).not.toHaveBeenCalledWith(id);
		expect.soft(creator.messageQueueManager.hasQueue(id)).toBe(false);
		expect.soft(creator["_intervals"].has(`interval:discovery::${id}`)).toBe(false);
		expect.soft(creator["_intervals"].has(`interval:sync::${id}`)).toBe(false);
	}

	test("omitted acl keeps generated and explicitly self-bound create/connect genesis in agreement", async () => {
		const generated = await creator.createObject({
			drp: new SetDRP<number>(),
			finality_config: { enabled: false },
		});
		const joinedGenerated = await connectWithoutPeer(generated.id, new SetDRP<number>());
		const selfBoundId = `${creator.networkNode.peerId}:phase-1l-self-bound`;
		const selfBound = await creator.createObject({
			id: selfBoundId,
			drp: new SetDRP<number>(),
			finality_config: { enabled: false },
		});
		const joinedSelfBound = await connectWithoutPeer(selfBoundId, new SetDRP<number>());

		expect.soft(rootACLBytes(joinedGenerated)).toEqual(rootACLBytes(generated));
		expect.soft(rootACLBytes(joinedSelfBound)).toEqual(rootACLBytes(selfBound));
		expect.soft(generated.acl.query_isAdmin(creator.networkNode.peerId)).toBe(true);
		expect.soft(joinedGenerated.acl.query_isAdmin(creator.networkNode.peerId)).toBe(true);
		expect.soft(selfBound.acl.query_isAdmin(creator.networkNode.peerId)).toBe(true);
		expect.soft(joinedSelfBound.acl.query_isAdmin(creator.networkNode.peerId)).toBe(true);
	});

	test("omitted acl rejects a plain custom id before object-store or subscription side effects", async () => {
		await expectRejectedBeforePublication("phase-1l-plain-custom-id");
	});

	test("omitted acl rejects a foreign-creator-bound custom id before publication side effects", async () => {
		await expectRejectedBeforePublication(`${foreignCreator.networkNode.peerId}:phase-1l-foreign-bound`);
	});

	test("fresh coordinated explicit ACLs remain the escape hatch for arbitrary custom ids", async () => {
		for (const id of [
			"phase-1l-explicit-plain-id",
			`${foreignCreator.networkNode.peerId}:phase-1l-explicit-foreign-bound`,
		]) {
			const created = await creator.createObject({
				id,
				acl: createACL({ admins: creator.networkNode.peerId }),
				drp: new SetDRP<number>(),
				finality_config: { enabled: false },
			});
			const joined = await connectWithoutPeer(
				id,
				new SetDRP<number>(),
				createACL({ admins: creator.networkNode.peerId })
			);

			expect.soft(rootACLBytes(joined)).toEqual(rootACLBytes(created));
			expect.soft(created.acl).not.toBe(joined.acl);
			expect.soft(joined.acl.query_isAdmin(creator.networkNode.peerId)).toBe(true);
		}
	});
});
