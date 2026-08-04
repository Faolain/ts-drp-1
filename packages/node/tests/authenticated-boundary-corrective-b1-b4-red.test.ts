import { publicKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { Signature } from "@noble/secp256k1";
import { SetDRP } from "@ts-drp/blueprints";
import { Keychain } from "@ts-drp/keychain";
import { authenticateVertices, createPermissionlessACL, createVertex, DRPObject, HashGraph } from "@ts-drp/object";
import {
	AggregatedAttestation,
	type Attestation,
	AttestationUpdate,
	DrpType,
	type IDRP,
	type IDRPObject,
	Message,
	MessageType,
	NodeEventName,
	Operation,
	SyncAccept,
	Update,
	type Vertex,
	Vertex as VertexCodec,
} from "@ts-drp/types";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { handleMessage } from "../src/handlers.js";
import { type DRPNode } from "../src/index.js";

interface SigningIdentity {
	keychain: Keychain;
	peerId: string;
}

interface PrivateApplier {
	applyVertices(vertices: Vertex[]): Promise<{
		applied: boolean;
		invalid: string[];
		missing: string[];
	}>;
}

interface HarnessObservations {
	broadcasts: Message[];
	dispatches: NodeEventName[];
	puts: number;
	syncs: number;
}

interface StructuralObservations extends HarnessObservations {
	addedSignatures: Array<{ attestations: Attestation[]; peerId: string; verify: boolean | undefined }>;
	mergeInputs: Vertex[][];
	mergedAttestations: AggregatedAttestation[][];
	ownerLookalikeCalls: { applied: number; trusted: number };
}

const ROOT = HashGraph.rootHash;
const STRUCTURAL_OBJECT_ID = "phase-1e-structural-object";
const LOCAL_PEER_ID = "phase-1e-local-peer";

let author: SigningIdentity;
let otherAuthor: SigningIdentity;

async function identity(seed: string): Promise<SigningIdentity> {
	const keychain = new Keychain({ private_key_seed: seed });
	await keychain.start();
	const publicKey = publicKeyFromRaw(uint8ArrayFromString(keychain.secp256k1PublicKey, "base64"));
	return { keychain, peerId: peerIdFromPublicKey(publicKey).toString() };
}

function candidate(peerId: string, value: number, dependencies: string[] = [ROOT]): Vertex {
	return createVertex(
		peerId,
		Operation.create({ drpType: DrpType.DRP, opType: "add", value: [value] }),
		dependencies,
		1_700_100_000_000 + value
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

function receiver(finalityEnabled = false): DRPObject<SetDRP<number>> {
	return new DRPObject({
		peerId: author.peerId,
		acl: createPermissionlessACL(author.peerId),
		drp: new SetDRP<number>(),
		config: { finality_config: { enabled: finalityEnabled } },
	});
}

function syncAcceptMessage(
	objectId: string,
	requested: readonly Vertex[],
	attestations: AggregatedAttestation[] = []
): Message {
	return Message.create({
		sender: otherAuthor.peerId,
		type: MessageType.MESSAGE_TYPE_SYNC_ACCEPT,
		objectId,
		data: SyncAccept.encode(SyncAccept.create({ requested: [...requested], requesting: [], attestations })).finish(),
	});
}

function updateMessage(
	objectId: string,
	vertices: readonly Vertex[],
	attestations: readonly Attestation[] = []
): Message {
	return Message.create({
		sender: otherAuthor.peerId,
		type: MessageType.MESSAGE_TYPE_UPDATE,
		objectId,
		data: Update.encode(Update.create({ vertices: [...vertices], attestations: [...attestations] })).finish(),
	});
}

function nodeHarness<T extends IDRP>(object: IDRPObject<T>): { node: DRPNode; observations: HarnessObservations } {
	const observations: HarnessObservations = { broadcasts: [], dispatches: [], puts: 0, syncs: 0 };
	const node = {
		get: (): IDRPObject<T> => object,
		keychain: {
			signWithBls: (hash: string): Uint8Array => Uint8Array.of(0xb1, hash.length),
			signWithSecp256k1: (hash: string): Promise<Uint8Array> => author.keychain.signWithSecp256k1(hash),
		},
		networkNode: {
			peerId: LOCAL_PEER_ID,
			broadcastMessage: (_id: string, message: Message): Promise<void> => {
				observations.broadcasts.push(message);
				return Promise.resolve();
			},
			sendMessage: (): Promise<void> => Promise.resolve(),
		},
		put: (): void => {
			observations.puts++;
		},
		safeDispatchEvent: (type: NodeEventName): void => {
			observations.dispatches.push(type);
		},
		syncObject: (): Promise<void> => {
			observations.syncs++;
			return Promise.resolve();
		},
	} as unknown as DRPNode;
	return { node, observations };
}

function structuralObject(options: { canSign: boolean }): {
	object: IDRPObject<IDRP>;
	observations: StructuralObservations;
	stored: Map<string, Vertex>;
} {
	const stored = new Map<string, Vertex>();
	const observations: StructuralObservations = {
		addedSignatures: [],
		broadcasts: [],
		dispatches: [],
		mergeInputs: [],
		mergedAttestations: [],
		ownerLookalikeCalls: { applied: 0, trusted: 0 },
		puts: 0,
		syncs: 0,
	};
	const structural = {
		id: STRUCTURAL_OBJECT_ID,
		acl: { query_isFinalitySigner: (): boolean => true },
		finalityStore: {
			enabled: true,
			addSignatures: (peerId: string, attestations: Attestation[], verify?: boolean): Attestation[] => {
				observations.addedSignatures.push({ peerId, attestations: [...attestations], verify });
				return [...attestations];
			},
			canSign: (): boolean => options.canSign,
			getAttestation: (): undefined => undefined,
			mergeSignatures: (attestations: AggregatedAttestation[]): void => {
				observations.mergedAttestations.push([...attestations]);
			},
			signed: (): boolean => false,
		},
		get vertices(): Vertex[] {
			return [...stored.values()];
		},
		getVertex: (hash: string): Vertex | undefined => stored.get(hash),
		merge: (vertices: Vertex[]): Promise<[boolean, string[], string[]]> => {
			observations.mergeInputs.push([...vertices]);
			for (const vertex of vertices) stored.set(vertex.hash, vertex);
			return Promise.resolve([true, [], []]);
		},
		// These ordinary lookalikes must not be mistaken for module-owned metadata.
		appliedVerticesForMergeResult: (): Vertex[] => {
			observations.ownerLookalikeCalls.applied++;
			return [...stored.values()];
		},
		mergeHadTrustedOrAuthenticatedOffers: (): boolean => {
			observations.ownerLookalikeCalls.trusted++;
			return false;
		},
	} as unknown as IDRPObject<IDRP>;
	return { object: structural, observations, stored };
}

function structuralNode(object: IDRPObject<IDRP>, observations: StructuralObservations): DRPNode {
	return {
		get: (): IDRPObject<IDRP> => object,
		keychain: {
			signWithBls: (hash: string): Uint8Array => Uint8Array.of(0xc1, hash.length),
			signWithSecp256k1: (hash: string): Promise<Uint8Array> => author.keychain.signWithSecp256k1(hash),
		},
		networkNode: {
			peerId: LOCAL_PEER_ID,
			broadcastMessage: (_id: string, message: Message): Promise<void> => {
				observations.broadcasts.push(message);
				return Promise.resolve();
			},
			sendMessage: (): Promise<void> => Promise.resolve(),
		},
		put: (): void => {
			observations.puts++;
		},
		safeDispatchEvent: (type: NodeEventName): void => {
			observations.dispatches.push(type);
		},
		syncObject: (): Promise<void> => {
			observations.syncs++;
			return Promise.resolve();
		},
	} as unknown as DRPNode;
}

async function privateProvenanceResult(vertex: Vertex): Promise<{
	applied: boolean;
	invalid: string[];
	missing: string[];
}> {
	const probe = receiver();
	return (probe as unknown as { _applier: PrivateApplier })._applier.applyVertices([vertex]);
}

beforeAll(async () => {
	[author, otherAuthor] = await Promise.all([
		identity("phase-1e-corrective-author"),
		identity("phase-1e-corrective-other-author"),
	]);
});

describe("Phase 1e corrective authentication boundary", () => {
	it("B1 does not publish an all-auth-invalid SYNC_ACCEPT lifecycle", async () => {
		const invalidObject = receiver();
		const unsigned = candidate(otherAuthor.peerId, 101);
		const invalidHarness = nodeHarness(invalidObject);

		await handleMessage(invalidHarness.node, syncAcceptMessage(invalidObject.id, [unsigned]));

		expect({
			accepted: invalidHarness.observations.dispatches.filter((type) => type === NodeEventName.DRP_SYNC_ACCEPTED)
				.length,
			puts: invalidHarness.observations.puts,
			recovery: invalidHarness.observations.syncs,
			stored: invalidObject.getVertex(unsigned.hash) !== undefined,
		}).toEqual({ accepted: 0, puts: 0, recovery: 0, stored: false });
	});

	it("B1 preserves the valid signed SYNC_ACCEPT lifecycle control", async () => {
		const validObject = receiver();
		const valid = await signedCandidate(otherAuthor, 102);
		const validHarness = nodeHarness(validObject);
		await handleMessage(validHarness.node, syncAcceptMessage(validObject.id, [valid]));

		expect({
			accepted: validHarness.observations.dispatches.filter((type) => type === NodeEventName.DRP_SYNC_ACCEPTED).length,
			puts: validHarness.observations.puts,
			recovery: validHarness.observations.syncs,
			stored: validObject.getVertex(valid.hash) !== undefined,
		}).toEqual({ accepted: 1, puts: 1, recovery: 0, stored: true });
	});

	it("B2 reports a raw known occurrence while committing its genuinely authenticated sibling", async () => {
		const object = receiver();
		const known = await signedCandidate(author, 201);
		await object.applyVertices([known]);
		const rawKnown = VertexCodec.decode(VertexCodec.encode(known).finish());
		const novel = await signedCandidate(author, 202);
		const authenticatedNovel = authenticateVertices([novel]);
		const applier = (object as unknown as { _applier: PrivateApplier })._applier;

		const result = await applier.applyVertices([rawKnown, ...authenticatedNovel]);

		expect.soft(result).toEqual({
			applied: false,
			invalid: [rawKnown.hash],
			missing: [],
		});
		expect.soft(object.getVertex(novel.hash)).toBeDefined();
		expect.soft(object.drp?.query_getValues()).toEqual([201, 202]);
	});

	it.each(["applyVertices", "merge"] as const)(
		"B3 %s preserves equal-hash failure occurrence order",
		async (surface) => {
			const duplicateObject = receiver();
			const validH = await signedCandidate(author, surface === "applyVertices" ? 301 : 311);
			const invalidX = candidate(author.peerId, surface === "applyVertices" ? 302 : 312);
			const invalidH = VertexCodec.decode(VertexCodec.encode(validH).finish());
			invalidH.signature = new Uint8Array();
			const duplicateResult = await duplicateObject[surface]([validH, invalidX, invalidH]);
			const expectedDuplicate =
				surface === "applyVertices"
					? { applied: false, invalid: [invalidX.hash, invalidH.hash], missing: [] }
					: [false, [], [invalidX.hash, invalidH.hash]];

			expect(duplicateResult).toEqual(expectedDuplicate);
			expect(duplicateObject.drp?.query_getValues()).toEqual([surface === "applyVertices" ? 301 : 311]);
		}
	);

	it.each(["applyVertices", "merge"] as const)(
		"B3 %s preserves the distinct-hash ordering control",
		async (surface) => {
			const distinctObject = receiver();
			const valid = await signedCandidate(author, surface === "applyVertices" ? 321 : 331);
			const firstInvalid = candidate(author.peerId, surface === "applyVertices" ? 322 : 332);
			const secondInvalid = candidate(author.peerId, surface === "applyVertices" ? 323 : 333);
			const distinctResult = await distinctObject[surface]([valid, firstInvalid, secondInvalid]);
			const expectedDistinct =
				surface === "applyVertices"
					? { applied: false, invalid: [firstInvalid.hash, secondInvalid.hash], missing: [] }
					: [false, [], [firstInvalid.hash, secondInvalid.hash]];

			expect(distinctResult).toEqual(expectedDistinct);
			expect(distinctObject.drp?.query_getValues()).toEqual([surface === "applyVertices" ? 321 : 331]);
		}
	);

	it("B4 UPDATE verifies structural-object ingress once and preserves valid local finality", async () => {
		const { object, observations, stored } = structuralObject({ canSign: true });
		const node = structuralNode(object, observations);
		const valid = await signedCandidate(otherAuthor, 401);
		const unsigned = candidate(otherAuthor.peerId, 402);
		const remoteAttestation = { data: valid.hash, signature: Uint8Array.of(0xa1) };
		const recover = vi.spyOn(Signature, "fromCompact");
		const originalDecode = Update.decode;
		let decodedInput: Vertex[] | undefined;
		const decode = vi.spyOn(Update, "decode").mockImplementation((input, length) => {
			const decoded = originalDecode(input, length);
			decodedInput = decoded.vertices;
			return decoded;
		});

		try {
			await handleMessage(node, updateMessage(object.id, [valid, unsigned], [remoteAttestation]));

			expect.soft(recover).toHaveBeenCalledOnce();
			expect.soft(observations.mergeInputs).toHaveLength(1);
			expect.soft(observations.mergeInputs[0]).toHaveLength(1);
			const received = observations.mergeInputs[0][0];
			expect.soft(decodedInput).toHaveLength(2);
			expect.soft(received).not.toBe(decodedInput?.[0]);
			expect.soft(VertexCodec.encode(received).finish()).toEqual(VertexCodec.encode(valid).finish());
			expect.soft(await privateProvenanceResult(received)).toEqual({ applied: true, invalid: [], missing: [] });
			expect.soft(stored.has(valid.hash)).toBe(true);
			expect.soft(stored.has(unsigned.hash)).toBe(false);
			expect.soft(observations.ownerLookalikeCalls).toEqual({ applied: 0, trusted: 0 });
			expect.soft(observations.addedSignatures).toEqual([
				{
					peerId: otherAuthor.peerId,
					attestations: [remoteAttestation],
					verify: undefined,
				},
				{
					peerId: LOCAL_PEER_ID,
					attestations: [{ data: valid.hash, signature: Uint8Array.of(0xc1, valid.hash.length) }],
					verify: false,
				},
			]);
			expect.soft(observations.broadcasts).toHaveLength(1);
			const broadcast = observations.broadcasts[0];
			expect.soft(broadcast.type).toBe(MessageType.MESSAGE_TYPE_ATTESTATION_UPDATE);
			expect.soft(AttestationUpdate.decode(broadcast.data).attestations.map(({ data }) => data)).toEqual([valid.hash]);
			expect.soft(observations.puts).toBe(1);
			expect.soft(observations.dispatches).toContain(NodeEventName.DRP_UPDATE);
		} finally {
			decode.mockRestore();
			recover.mockRestore();
		}
	});

	it("B4 SYNC_ACCEPT verifies structural-object ingress once and preserves attestation merge", async () => {
		const { object, observations, stored } = structuralObject({ canSign: false });
		const node = structuralNode(object, observations);
		const valid = await signedCandidate(otherAuthor, 411);
		const unsigned = candidate(otherAuthor.peerId, 412);
		const aggregate = AggregatedAttestation.create({
			data: valid.hash,
			signature: Uint8Array.of(0xd1),
			aggregationBits: Uint8Array.of(0xd2),
		});
		const recover = vi.spyOn(Signature, "fromCompact");
		const originalDecode = SyncAccept.decode;
		let decodedInput: Vertex[] | undefined;
		const decode = vi.spyOn(SyncAccept, "decode").mockImplementation((input, length) => {
			const decoded = originalDecode(input, length);
			decodedInput = decoded.requested;
			return decoded;
		});

		try {
			await handleMessage(node, syncAcceptMessage(object.id, [unsigned, valid], [aggregate]));

			expect.soft(recover).toHaveBeenCalledOnce();
			expect.soft(observations.mergeInputs).toHaveLength(1);
			expect.soft(observations.mergeInputs[0]).toHaveLength(1);
			const received = observations.mergeInputs[0][0];
			expect.soft(decodedInput).toHaveLength(2);
			expect.soft(received).not.toBe(decodedInput?.[1]);
			expect.soft(VertexCodec.encode(received).finish()).toEqual(VertexCodec.encode(valid).finish());
			expect.soft(await privateProvenanceResult(received)).toEqual({ applied: true, invalid: [], missing: [] });
			expect.soft(stored.has(unsigned.hash)).toBe(false);
			expect.soft(stored.has(valid.hash)).toBe(true);
			expect.soft(observations.ownerLookalikeCalls).toEqual({ applied: 0, trusted: 0 });
			expect.soft(observations.mergedAttestations).toEqual([[aggregate]]);
			expect.soft(observations.puts).toBe(1);
			expect.soft(observations.syncs).toBe(0);
			expect.soft(observations.dispatches.filter((type) => type === NodeEventName.DRP_SYNC_ACCEPTED)).toHaveLength(1);
		} finally {
			decode.mockRestore();
			recover.mockRestore();
		}
	});
});
