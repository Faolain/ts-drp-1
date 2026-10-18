import { publicKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { Signature } from "@noble/secp256k1";
import { SetDRP } from "@ts-drp/blueprints";
import { Keychain } from "@ts-drp/keychain";
import {
	createPermissionlessACL,
	createVertex,
	DRPObject,
	HashGraph,
	mergeAuthenticatedVertices,
} from "@ts-drp/object";
import { DrpType, type MergeResult, Operation, type Vertex } from "@ts-drp/types";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { beforeAll, describe, expect, it, vi } from "vitest";

interface SigningIdentity {
	keychain: Keychain;
	peerId: string;
}

class OverriddenMergeObject extends DRPObject<SetDRP<number>> {
	readonly mergeEffects: string[] = [];
	readonly mergeInputs: Vertex[][] = [];

	override merge(vertices: Vertex[]): Promise<MergeResult> {
		this.mergeInputs.push([...vertices]);
		this.mergeEffects.push("override-ran");
		return Promise.resolve([true, [], []]);
	}
}

let author: SigningIdentity;

async function identity(seed: string): Promise<SigningIdentity> {
	const keychain = new Keychain({ private_key_seed: seed });
	await keychain.start();
	const publicKey = publicKeyFromRaw(uint8ArrayFromString(keychain.secp256k1PublicKey, "base64"));
	return { keychain, peerId: peerIdFromPublicKey(publicKey).toString() };
}

function objectOptions(): ConstructorParameters<typeof DRPObject<SetDRP<number>>>[0] {
	return {
		peerId: author.peerId,
		acl: createPermissionlessACL(author.peerId),
		drp: new SetDRP<number>(),
	};
}

function candidate(peerId: string, value: number): Vertex {
	return createVertex(
		peerId,
		Operation.create({ drpType: DrpType.DRP, opType: "add", value: [value] }),
		[HashGraph.rootHash],
		1_700_300_000_000 + value
	);
}

async function signedCandidate(value: number): Promise<Vertex> {
	const vertex = candidate(author.peerId, value);
	vertex.signature = await author.keychain.signWithSecp256k1(vertex.hash);
	return vertex;
}

beforeAll(async () => {
	author = await identity("phase-1e-concrete-execution-capability");
});

describe("Phase 1e concrete execution capability", () => {
	it("does not dispatch raw unauthenticated input to a DRPObject subclass merge override", async () => {
		const object = new OverriddenMergeObject(objectOptions());
		const unsigned = candidate("claimed-remote-subclass-author", 101);

		await mergeAuthenticatedVertices(object, [unsigned]).catch(() => undefined);

		expect({
			effects: object.mergeEffects,
			inputCount: object.mergeInputs.length,
			receivedRawReference: object.mergeInputs[0]?.[0] === unsigned,
		}).toEqual({ effects: [], inputCount: 0, receivedRawReference: false });
	});

	it("does not dispatch raw unauthenticated input to a post-construction merge replacement", async () => {
		const object = new DRPObject(objectOptions());
		const mergeEffects: string[] = [];
		const mergeInputs: Vertex[][] = [];
		object.merge = (vertices: Vertex[]): Promise<MergeResult> => {
			mergeInputs.push([...vertices]);
			mergeEffects.push("replacement-ran");
			return Promise.resolve([true, [], []]);
		};
		const unsigned = candidate("claimed-remote-replacement-author", 102);

		await mergeAuthenticatedVertices(object, [unsigned]).catch(() => undefined);

		expect({
			effects: mergeEffects,
			inputCount: mergeInputs.length,
			receivedRawReference: mergeInputs[0]?.[0] === unsigned,
		}).toEqual({ effects: [], inputCount: 0, receivedRawReference: false });
	});

	it("preserves exactly-once authentication and valid merge behavior for an unmodified concrete object", async () => {
		const object = new DRPObject(objectOptions());
		const signed = await signedCandidate(103);
		const recover = vi.spyOn(Signature, "fromCompact");

		try {
			const outcome = await mergeAuthenticatedVertices(object, [signed]);

			expect(recover).toHaveBeenCalledOnce();
			expect({
				committed: outcome.committed.map(({ hash }) => hash),
				hasTrustedOrAuthenticatedOffers: outcome.hasTrustedOrAuthenticatedOffers,
				result: outcome.result,
				values: object.drp?.query_getValues(),
			}).toEqual({
				committed: [signed.hash],
				hasTrustedOrAuthenticatedOffers: true,
				result: [true, [], []],
				values: [103],
			});
		} finally {
			recover.mockRestore();
		}
	});
});
