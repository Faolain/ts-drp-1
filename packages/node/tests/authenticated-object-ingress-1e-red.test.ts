import { publicKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { Signature } from "@noble/secp256k1";
import { SetDRP } from "@ts-drp/blueprints";
import { Keychain } from "@ts-drp/keychain";
import { createPermissionlessACL, createVertex, DRPObject, HashGraph } from "@ts-drp/object";
import { DrpType, Message, MessageType, Operation, Update, type Vertex, Vertex as VertexCodec } from "@ts-drp/types";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { beforeAll, describe, expect, it, vi } from "vitest";

import * as handlerModule from "../src/handlers.js";
import { type DRPNode } from "../src/index.js";

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

interface PrivateApplierReflection {
	applyVertices(vertices: Vertex[]): Promise<{
		applied: boolean;
		invalid: string[];
		missing: string[];
		quarantined?: string[];
	}>;
}

interface PrivateObjectReflection {
	_applier: PrivateApplierReflection;
	hashGraph: { vertices: Map<string, Vertex> };
}

interface NodeHarnessResult {
	broadcasts: Message[];
	puts: number;
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

function receiver(finalityEnabled = false): DRPObject<SetDRP<number>> {
	return new DRPObject({
		peerId: author.peerId,
		acl: createPermissionlessACL(author.peerId),
		drp: new SetDRP<number>(),
		config: { finality_config: { enabled: finalityEnabled } },
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

function updateMessage(vertices: readonly Vertex[]): Message {
	return Message.create({
		data: Update.encode(Update.create({ vertices: [...vertices] })).finish(),
		objectId: "phase-1e-object",
		sender: otherAuthor.peerId,
		type: MessageType.MESSAGE_TYPE_UPDATE,
	});
}

function nodeHarness(object: DRPObject<SetDRP<number>>): { node: DRPNode; result: NodeHarnessResult } {
	const result: NodeHarnessResult = { broadcasts: [], puts: 0 };
	const node = {
		get: (): DRPObject<SetDRP<number>> => object,
		keychain: {
			signWithBls: (hash: string): Uint8Array => Uint8Array.of(0xb1, hash.length),
			signWithSecp256k1: (hash: string): Promise<Uint8Array> => author.keychain.signWithSecp256k1(hash),
		},
		networkNode: {
			broadcastMessage: (_objectId: string, message: Message): Promise<void> => {
				result.broadcasts.push(message);
				return Promise.resolve();
			},
			peerId: author.peerId,
			sendMessage: (): Promise<void> => Promise.resolve(),
		},
		put: (): void => {
			result.puts++;
		},
		safeDispatchEvent: (): void => undefined,
		syncObject: (): Promise<void> => Promise.resolve(),
	} as unknown as DRPNode;
	return { node, result };
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
			applied: false,
			invalid: [mismatch.vertex.hash, unsigned.vertex.hash, malformed.vertex.hash],
			missing: [],
		});
		expect(object.drp?.query_getValues()).toEqual([25]);
	});

	it("preserves legacy merge classification and input order for a partially committed mixed batch", async () => {
		const object = receiver();
		const valid = await signedCandidate(author, 26);
		const [unsigned, malformed, mismatch] = await rejectedCandidates();
		const offered = [malformed.vertex, valid, mismatch.vertex, unsigned.vertex];

		await expect(object.merge(offered)).resolves.toEqual([
			false,
			[],
			[malformed.vertex.hash, mismatch.vertex.hash, unsigned.vertex.hash],
		]);
		expect(object.drp?.query_getValues()).toEqual([26]);
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

	it("preserves signed transient quarantine semantics after authentication", async () => {
		const object = receiver();
		const graph = (object as unknown as PrivateObjectReflection).hashGraph;
		const originalGet = graph.vertices.get.bind(graph.vertices);
		const graphGet = vi.spyOn(graph.vertices, "get").mockImplementation((hash) => {
			if (hash === ROOT) throw new Error("phase-1e-transient-graph-read");
			return originalGet(hash);
		});
		const transient = await signedCandidate(author, 33);

		try {
			await expect(object.applyVertices([transient])).resolves.toEqual({
				applied: false,
				invalid: [],
				missing: [],
				quarantined: [transient.hash],
			});
			expect(object.getVertex(transient.hash)).toBeUndefined();
		} finally {
			graphGet.mockRestore();
		}
	});

	it("does not poison a hash when an unsigned offer is retried with the correct signature", async () => {
		const object = receiver();
		const unsigned = candidate(author.peerId, 35);
		const signed = VertexCodec.decode(VertexCodec.encode(unsigned).finish());
		signed.signature = await author.keychain.signWithSecp256k1(signed.hash);

		const unsignedResult = await object.applyVertices([unsigned]);
		const signedResult = await object.applyVertices([signed]);

		expect({ signedResult, unsignedResult, values: object.drp?.query_getValues() }).toEqual({
			signedResult: { applied: true, invalid: [], missing: [] },
			unsignedResult: { applied: false, invalid: [unsigned.hash], missing: [] },
			values: [35],
		});
	});

	it("verifies and applies the same one-read detached submitted snapshot", async () => {
		const object = receiver();
		const stable = await signedCandidate(author, 41);
		const hostileOperation = Operation.create({ drpType: DrpType.DRP, opType: "add", value: [999] });
		let peerId = stable.peerId;
		let operation = stable.operation;
		let dependencies = [...stable.dependencies];
		let timestamp = stable.timestamp;
		const reads = { dependencies: 0, hash: 0, operation: 0, peerId: 0, signature: 0, timestamp: 0 };
		const submitted = {} as Vertex;
		Object.defineProperties(submitted, {
			dependencies: {
				enumerable: true,
				get: (): string[] => {
					reads.dependencies++;
					return dependencies;
				},
			},
			hash: {
				enumerable: true,
				get: (): string => {
					reads.hash++;
					return stable.hash;
				},
			},
			operation: {
				enumerable: true,
				get: (): Vertex["operation"] => {
					reads.operation++;
					return operation;
				},
			},
			peerId: {
				enumerable: true,
				get: (): string => {
					reads.peerId++;
					return peerId;
				},
			},
			signature: {
				enumerable: true,
				get: (): Uint8Array => {
					reads.signature++;
					peerId = otherAuthor.peerId;
					operation = hostileOperation;
					dependencies = ["mutated-after-authentication"];
					timestamp++;
					return stable.signature;
				},
			},
			timestamp: {
				enumerable: true,
				get: (): number => {
					reads.timestamp++;
					return timestamp;
				},
			},
		});

		await expect(object.applyVertices([submitted])).resolves.toEqual({ applied: true, invalid: [], missing: [] });
		expect(reads).toEqual({ dependencies: 1, hash: 1, operation: 1, peerId: 1, signature: 1, timestamp: 1 });
		expect(object.drp?.query_getValues()).toEqual([41]);
		expect(object.getVertex(stable.hash)).toMatchObject({
			dependencies: [ROOT],
			peerId: author.peerId,
			timestamp: stable.timestamp,
		});
	});

	it("trusts root and already-known hashes without authentication or invalid classification", async () => {
		const object = receiver();
		const known = await signedCandidate(author, 45);
		await object.applyVertices([known]);
		const root = object.getVertex(ROOT);
		if (!root) throw new Error("root vertex missing");
		const forgedKnown = VertexCodec.decode(VertexCodec.encode(known).finish());
		forgedKnown.peerId = otherAuthor.peerId;
		forgedKnown.signature = Uint8Array.of(0xff);
		const recover = vi.spyOn(Signature, "fromCompact");

		try {
			await expect(object.applyVertices([root, forgedKnown])).resolves.toEqual({
				applied: true,
				invalid: [],
				missing: [],
			});
			expect(recover).not.toHaveBeenCalled();
			expect(object.drp?.query_getValues()).toEqual([45]);
		} finally {
			recover.mockRestore();
		}
	});

	it("routes a forged UPDATE through the object boundary with exactly one cryptographic verification", async () => {
		const object = receiver(true);
		const mismatch = (await rejectedCandidates())[2].vertex;
		const recover = vi.spyOn(Signature, "fromCompact");
		const { node, result } = nodeHarness(object);

		try {
			await handlerModule.handleMessage(node, updateMessage([mismatch]));
			expect(recover).toHaveBeenCalledOnce();
			expect(object.getVertex(mismatch.hash)).toBeUndefined();
			expect(object.drp?.query_getValues()).toEqual([]);
			expect(result).toEqual({ broadcasts: [], puts: 1 });
		} finally {
			recover.mockRestore();
		}
	});

	it("does not reauthenticate or attest a forged duplicate of an already-known hash from UPDATE", async () => {
		const object = receiver(true);
		const known = await signedCandidate(author, 51);
		await object.applyVertices([known]);
		const forgedDuplicate = VertexCodec.decode(VertexCodec.encode(known).finish());
		forgedDuplicate.peerId = otherAuthor.peerId;
		forgedDuplicate.signature = await otherAuthor.keychain.signWithSecp256k1(forgedDuplicate.hash);
		const finality = object.finalityStore;
		const canSign = vi.spyOn(finality, "canSign").mockReturnValue(true);
		const signed = vi.spyOn(finality, "signed").mockReturnValue(false);
		const addSignatures = vi
			.spyOn(finality, "addSignatures")
			.mockImplementation((_peerId, attestations) => attestations);
		const recover = vi.spyOn(Signature, "fromCompact");
		const { node, result } = nodeHarness(object);

		try {
			await handlerModule.handleMessage(node, updateMessage([forgedDuplicate]));
			expect(recover).not.toHaveBeenCalled();
			expect(result.broadcasts).toEqual([]);
			expect(object.drp?.query_getValues()).toEqual([51]);
		} finally {
			addSignatures.mockRestore();
			canSign.mockRestore();
			recover.mockRestore();
			signed.mockRestore();
		}
	});

	it("fails closed when the exported applier receives a signed vertex without verifier provenance", async () => {
		const object = receiver();
		const rawSigned = await signedCandidate(author, 55);
		const applier = (object as unknown as PrivateObjectReflection)._applier;
		const outcome = await applier.applyVertices([rawSigned]).then(
			(result) => ({ failedClosed: result.invalid.includes(rawSigned.hash), rejected: false }),
			() => ({ failedClosed: true, rejected: true })
		);

		expect(outcome.failedClosed).toBe(true);
		expect(object.getVertex(rawSigned.hash)).toBeUndefined();
		expect(object.drp?.query_getValues()).toEqual([]);
	});

	it("accepts the verifier-issued detached snapshot at the private applier boundary", async () => {
		const object = receiver();
		const rawSigned = await signedCandidate(author, 56);
		const objectModule = (await import("@ts-drp/object")) as ObjectModuleReflection;
		const authenticateVertices = objectModule.authenticateVertices;
		expect(authenticateVertices).toBeTypeOf("function");
		if (typeof authenticateVertices !== "function") return;
		const verified = (authenticateVertices as (vertices: Vertex[]) => Vertex[])([rawSigned]);

		expect(verified).toHaveLength(1);
		expect(verified[0]).not.toBe(rawSigned);
		expect(VertexCodec.encode(verified[0]).finish()).toEqual(VertexCodec.encode(rawSigned).finish());
		await expect((object as unknown as PrivateObjectReflection)._applier.applyVertices(verified)).resolves.toEqual({
			applied: true,
			invalid: [],
			missing: [],
		});
		expect(object.drp?.query_getValues()).toEqual([56]);
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
