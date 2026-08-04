import { publicKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { SetDRP } from "@ts-drp/blueprints";
import { Keychain } from "@ts-drp/keychain";
import { createPermissionlessACL, createVertex, DRPObject, HashGraph } from "@ts-drp/object";
import { DrpType, MessageType, Operation, type Vertex, Vertex as VertexCodec } from "@ts-drp/types";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { beforeAll, describe, expect, it } from "vitest";

import * as handlerModule from "../src/handlers.js";

interface SigningIdentity {
	keychain: Keychain;
	peerId: string;
}

interface RegistryEntry {
	handler: unknown;
	vertexIngress: false | unknown;
}

type HandlerModuleReflection = typeof handlerModule & {
	messageHandlers?: Readonly<Record<number, RegistryEntry | undefined>>;
};

interface ObjectModuleReflection {
	authenticateVertices?: unknown;
}

const ROOT = HashGraph.rootHash;

let author: SigningIdentity;
let otherAuthor: SigningIdentity;

async function identity(seed: string): Promise<SigningIdentity> {
	const keychain = new Keychain({ private_key_seed: seed });
	await keychain.start();
	const publicKey = publicKeyFromRaw(uint8ArrayFromString(keychain.secp256k1PublicKey, "base64"));
	return { keychain, peerId: peerIdFromPublicKey(publicKey).toString() };
}

function receiver(): DRPObject<SetDRP<number>> {
	return new DRPObject({
		peerId: author.peerId,
		acl: createPermissionlessACL(author.peerId),
		drp: new SetDRP<number>(),
	});
}

function candidate(peerId: string, value: number, dependencies: string[] = [ROOT]): Vertex {
	return createVertex(
		peerId,
		Operation.create({ drpType: DrpType.DRP, opType: "add", value: [value] }),
		dependencies,
		1_700_000_000_000 + value
	);
}

async function signedCandidate(
	identityToClaim: SigningIdentity,
	value: number,
	dependencies: string[] = [ROOT]
): Promise<Vertex> {
	const vertex = candidate(identityToClaim.peerId, value, dependencies);
	vertex.signature = await identityToClaim.keychain.signWithSecp256k1(vertex.hash);
	return vertex;
}

async function rejectedCandidates(): Promise<ReadonlyArray<{ label: string; vertex: Vertex }>> {
	const unsigned = candidate(author.peerId, 11);
	const malformed = candidate(author.peerId, 12);
	malformed.signature = Uint8Array.of(0xff, 0x01, 0x02);
	const claimedAuthorMismatch = candidate(author.peerId, 13);
	claimedAuthorMismatch.signature = await otherAuthor.keychain.signWithSecp256k1(claimedAuthorMismatch.hash);
	return [
		{ label: "unsigned", vertex: unsigned },
		{ label: "malformed signature", vertex: malformed },
		{ label: "claimed-author mismatch", vertex: claimedAuthorMismatch },
	];
}

beforeAll(async () => {
	[author, otherAuthor] = await Promise.all([
		identity("phase-1e-authenticated-author"),
		identity("phase-1e-other-author"),
	]);
});

describe("Phase 1e object-layer authentication boundary", () => {
	it.each([
		["unsigned", 0],
		["malformed signature", 1],
		["claimed-author mismatch", 2],
	] as const)("direct applyVertices rejects %s vertices without a node handler", async (_label, index) => {
		const object = receiver();
		const rejected = (await rejectedCandidates())[index].vertex;

		await expect(object.applyVertices([rejected])).resolves.toEqual({
			applied: false,
			invalid: [rejected.hash],
			missing: [],
		});
		expect(object.getVertex(rejected.hash)).toBeUndefined();
		expect(object.drp?.query_getValues()).toEqual([]);
	});

	it.each([
		["unsigned", 0],
		["malformed signature", 1],
		["claimed-author mismatch", 2],
	] as const)("legacy merge rejects %s vertices without a node handler", async (_label, index) => {
		const object = receiver();
		const rejected = (await rejectedCandidates())[index].vertex;

		await expect(object.merge([rejected])).resolves.toEqual([false, [], [rejected.hash]]);
		expect(object.getVertex(rejected.hash)).toBeUndefined();
		expect(object.drp?.query_getValues()).toEqual([]);
	});

	it("preserves valid signed ordering, state bytes, and wire bytes across public ingest surfaces", async () => {
		const direct = receiver();
		const legacy = receiver();
		const first = await signedCandidate(author, 21);
		const child = await signedCandidate(author, 22, [first.hash]);
		const offered = [first, child];
		const wireBefore = offered.map((vertex) => VertexCodec.encode(vertex).finish());

		await expect(direct.applyVertices(offered)).resolves.toEqual({
			applied: true,
			invalid: [],
			missing: [],
		});
		await expect(legacy.merge(offered)).resolves.toEqual([true, [], []]);

		expect(direct.drp?.query_getValues()).toEqual([21, 22]);
		expect(legacy.drp?.query_getValues()).toEqual([21, 22]);
		expect(direct.getSerializedStates(child.hash)).toEqual(legacy.getSerializedStates(child.hash));
		expect(direct.vertices.map((vertex) => VertexCodec.encode(vertex).finish())).toEqual(
			legacy.vertices.map((vertex) => VertexCodec.encode(vertex).finish())
		);
		expect(offered.map((vertex) => VertexCodec.encode(vertex).finish())).toEqual(wireBefore);
	});

	it("preserves input ordering when a mixed batch classifies authentication failures", async () => {
		const object = receiver();
		const valid = await signedCandidate(author, 25);
		const [unsigned, malformed, mismatch] = await rejectedCandidates();
		const offered = [mismatch.vertex, valid, unsigned.vertex, malformed.vertex];

		await expect(object.applyVertices(offered)).resolves.toEqual({
			applied: true,
			invalid: [mismatch.vertex.hash, unsigned.vertex.hash, malformed.vertex.hash],
			missing: [],
		});
		expect(object.drp?.query_getValues()).toEqual([25]);
	});

	it("keeps a signed missing dependency retryable without changing missing/invalid/quarantine semantics", async () => {
		const object = receiver();
		const parent = await signedCandidate(author, 31);
		const child = await signedCandidate(author, 32, [parent.hash]);

		await expect(object.applyVertices([child])).resolves.toEqual({
			applied: false,
			invalid: [],
			missing: [child.hash],
		});
		await expect(object.applyVertices([parent])).resolves.toEqual({ applied: true, invalid: [], missing: [] });
		await expect(object.applyVertices([child])).resolves.toEqual({ applied: true, invalid: [], missing: [] });
		expect(object.drp?.query_getValues()).toEqual([31, 32]);
	});

	it("reflectively declares the authenticated ingress for every active vertex-carrying handler", async () => {
		const registry = (handlerModule as HandlerModuleReflection).messageHandlers;
		const objectModule = (await import("@ts-drp/object")) as ObjectModuleReflection;
		const authenticateVertices = objectModule.authenticateVertices;
		const numericMessageTypes = [
			...new Set(Object.values(MessageType).filter((value): value is number => typeof value === "number")),
		];

		expect(registry).toBeDefined();
		expect(authenticateVertices).toBeTypeOf("function");
		for (const messageType of numericMessageTypes) expect(registry).toHaveProperty(String(messageType));

		const activeEntries = Object.values(registry ?? {}).filter((entry): entry is RegistryEntry => entry !== undefined);
		for (const entry of activeEntries) {
			expect(entry).toHaveProperty("handler");
			expect(entry).toHaveProperty("vertexIngress");
		}

		const vertexCarryingEntries = activeEntries.filter((entry) => entry.vertexIngress !== false);
		expect(vertexCarryingEntries.length).toBeGreaterThan(0);
		for (const entry of vertexCarryingEntries) expect(entry.vertexIngress).toBe(authenticateVertices);
	});
});
