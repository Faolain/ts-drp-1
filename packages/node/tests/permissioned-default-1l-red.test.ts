import { publicKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { SetDRP } from "@ts-drp/blueprints";
import { Keychain } from "@ts-drp/keychain";
import { createPermissionlessACL, createVertex, HashGraph } from "@ts-drp/object";
import { ACLGroup, type DRPNodeConfig, DrpType, Operation, type Vertex } from "@ts-drp/types";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { DRPNode } from "../src/index.js";

interface SigningIdentity {
	readonly keychain: Keychain;
	readonly peerId: string;
}

interface GenesisStateReader {
	getSerializedStates(
		vertexHash: string
	): readonly [aclState: Uint8Array | undefined, drpState: Uint8Array | undefined];
}

const SYBIL_COUNT = 100;

async function identity(seed: string): Promise<SigningIdentity> {
	const keychain = new Keychain({ private_key_seed: seed });
	await keychain.start();
	const publicKey = publicKeyFromRaw(uint8ArrayFromString(keychain.secp256k1PublicKey, "base64"));
	return { keychain, peerId: peerIdFromPublicKey(publicKey).toString() };
}

async function signedAdd(
	author: SigningIdentity,
	value: number,
	dependencies: string[] = [HashGraph.rootHash],
	timestamp = Date.now()
): Promise<Vertex> {
	const vertex = createVertex(
		author.peerId,
		Operation.create({ drpType: DrpType.DRP, opType: "add", value: [value] }),
		dependencies,
		timestamp
	);
	vertex.signature = await author.keychain.signWithSecp256k1(vertex.hash);
	return vertex;
}

function rootACLBytes(object: GenesisStateReader): Uint8Array {
	const [bytes] = object.getSerializedStates(HashGraph.rootHash);
	if (bytes === undefined) throw new Error("Product-path object has no genesis ACL snapshot");
	return bytes;
}

describe.sequential("Phase 1l product-path permissioned default", () => {
	let creator: DRPNode;
	let joiner: DRPNode;
	let outsider: SigningIdentity;

	beforeAll(async () => {
		const nodeConfig = (private_key_seed: string): DRPNodeConfig => ({
			keychain_config: { private_key_seed },
			log_config: { level: "silent" as const },
			network_config: {
				bootstrap_peers: [],
				listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
				log_config: { level: "silent" as const },
			},
		});
		creator = new DRPNode(nodeConfig("phase-1l-creator"));
		joiner = new DRPNode(nodeConfig("phase-1l-joiner"));
		await Promise.all([creator.start(), joiner.start()]);
		outsider = await identity("phase-1l-outsider");
	}, 15_000);

	afterEach(() => {
		vi.useRealTimers();
	});

	afterAll(async () => {
		await Promise.allSettled([creator.stop(), joiner.stop()]);
	});

	test("omitting acl makes the creator the sole initial writer without weakening admin or finality", async () => {
		const object = await creator.createObject({
			drp: new SetDRP<number>(),
			finality_config: { enabled: false },
		});
		const creatorId = creator.networkNode.peerId;
		const graphBeforeCreatorWrite = object.vertices.length;

		expect.soft(object.acl.permissionless).toBe(false);
		expect.soft(object.acl.query_isAdmin(creatorId)).toBe(true);
		expect.soft(object.acl.query_isFinalitySigner(creatorId)).toBe(true);
		expect.soft(object.acl.query_isWriter(creatorId)).toBe(true);
		expect.soft(object.acl.query_isWriter(outsider.peerId)).toBe(false);
		expect.soft([...object.acl.query_getFinalitySigners().keys()]).toEqual([creatorId]);

		object.drp?.add(-1);
		expect.soft(object.drp?.query_has(-1)).toBe(true);
		expect.soft(object.vertices).toHaveLength(graphBeforeCreatorWrite + 1);
	});

	test("an authenticated operation from an ungranted peer is rejected without graph or state growth", async () => {
		const object = await creator.createObject({
			drp: new SetDRP<number>(),
			finality_config: { enabled: false },
		});
		const candidate = await signedAdd(outsider, 41);
		const graphBefore = object.vertices.length;
		const stateBefore = object.drp?.query_getValues() ?? [];

		const result = await object.applyVertices([candidate]);

		expect.soft(result).toEqual({ applied: false, invalid: [candidate.hash], missing: [] });
		expect.soft(object.getVertex(candidate.hash)).toBeUndefined();
		expect.soft(object.vertices).toHaveLength(graphBefore);
		expect.soft(object.drp?.query_getValues()).toEqual(stateBefore);
	});

	test("an explicit Writer grant on the omitted-acl object restores that peer's write", async () => {
		const object = await creator.createObject({
			drp: new SetDRP<number>(),
			finality_config: { enabled: false },
		});

		object.acl.grant(outsider.peerId, ACLGroup.Writer);
		const grant = object.vertices.at(-1);
		if (grant === undefined) throw new Error("Writer grant did not create an ACL vertex");
		const candidate = await signedAdd(outsider, 42, [grant.hash], grant.timestamp + 1);

		await expect(object.applyVertices([candidate])).resolves.toEqual({ applied: true, invalid: [], missing: [] });
		expect(object.acl.query_isWriter(outsider.peerId)).toBe(true);
		expect(object.getVertex(candidate.hash)).toEqual(candidate);
		expect(object.drp?.query_has(42)).toBe(true);
	});

	test("100 Sybil authors cause zero accepted graph and state growth without grants", async () => {
		const object = await creator.createObject({
			drp: new SetDRP<number>(),
			finality_config: { enabled: false },
		});
		const graphBefore = object.vertices.length;
		const stateBefore = object.drp?.query_getValues().length ?? 0;
		const authors = await Promise.all(
			Array.from({ length: SYBIL_COUNT }, (_, index) => identity(`phase-1l-sybil-${index}`))
		);
		const timestamp = Date.now();
		const candidates = await Promise.all(
			authors.map((author, index) => signedAdd(author, 1_000 + index, [HashGraph.rootHash], timestamp + index))
		);

		const result = await object.applyVertices(candidates);
		const acceptedGraphGrowth = object.vertices.length - graphBefore;
		const acceptedStateGrowth = (object.drp?.query_getValues().length ?? 0) - stateBefore;

		expect.soft(result).toEqual({
			applied: false,
			invalid: candidates.map(({ hash }) => hash),
			missing: [],
		});
		expect.soft(acceptedGraphGrowth).toBe(0);
		expect.soft(acceptedStateGrowth).toBe(0);
		expect.soft(candidates.every(({ hash }) => object.getVertex(hash) === undefined)).toBe(true);
	}, 10_000);

	test("explicit createPermissionlessACL remains a positive opt-in for arbitrary writers", async () => {
		const explicitACL = createPermissionlessACL(creator.networkNode.peerId);
		const object = await creator.createObject({
			acl: explicitACL,
			drp: new SetDRP<number>(),
			finality_config: { enabled: false },
		});
		const candidate = await signedAdd(outsider, 51);
		const graphBefore = object.vertices.length;

		await expect(object.applyVertices([candidate])).resolves.toEqual({ applied: true, invalid: [], missing: [] });
		expect(object.acl.permissionless).toBe(true);
		expect(object.acl.query_isWriter(outsider.peerId)).toBe(true);
		expect(object.vertices).toHaveLength(graphBefore + 1);
		expect(object.drp?.query_has(51)).toBe(true);
	});

	test("generated creator-bound genesis agrees across restart and join, including explicit permissionless opt-in", async () => {
		const defaultObject = await creator.createObject({
			drp: new SetDRP<number>(),
			finality_config: { enabled: false },
		});
		const defaultRootBeforeRestart = rootACLBytes(defaultObject);

		await creator.restart();
		const restarted = creator.get<SetDRP<number>>(defaultObject.id);
		if (restarted === undefined) throw new Error("Restart discarded the product-path object");

		vi.useFakeTimers();
		const defaultConnection = joiner.connectObject({
			id: defaultObject.id,
			drp: new SetDRP<number>(),
			finality_config: { enabled: false },
		});
		await vi.advanceTimersByTimeAsync(5_000);
		const joinedDefault = await defaultConnection;
		vi.useRealTimers();

		expect.soft(rootACLBytes(restarted)).toEqual(defaultRootBeforeRestart);
		expect.soft(rootACLBytes(joinedDefault)).toEqual(defaultRootBeforeRestart);
		expect.soft(joinedDefault.acl.permissionless).toBe(false);
		expect.soft(joinedDefault.acl.query_isWriter(creator.networkNode.peerId)).toBe(true);
		expect.soft(joinedDefault.acl.query_isWriter(joiner.networkNode.peerId)).toBe(false);

		const permissionlessACL = createPermissionlessACL(creator.networkNode.peerId);
		const permissionlessObject = await creator.createObject({
			acl: permissionlessACL,
			drp: new SetDRP<number>(),
			finality_config: { enabled: false },
		});
		const permissionlessRoot = rootACLBytes(permissionlessObject);

		vi.useFakeTimers();
		const permissionlessConnection = joiner.connectObject({
			acl: createPermissionlessACL(creator.networkNode.peerId),
			id: permissionlessObject.id,
			drp: new SetDRP<number>(),
			finality_config: { enabled: false },
		});
		await vi.advanceTimersByTimeAsync(5_000);
		const joinedPermissionless = await permissionlessConnection;
		vi.useRealTimers();

		expect(rootACLBytes(joinedPermissionless)).toEqual(permissionlessRoot);
		expect(joinedPermissionless.acl.permissionless).toBe(true);
		expect(joinedPermissionless.acl.query_isWriter(outsider.peerId)).toBe(true);
	});
});
