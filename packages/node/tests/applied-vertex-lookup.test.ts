import { publicKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { Keychain } from "@ts-drp/keychain";
import { authenticateVertices } from "@ts-drp/object";
import {
	AggregatedAttestation,
	type Attestation,
	AttestationUpdate,
	type IDRP,
	type IDRPObject,
	Message,
	MessageType,
	NodeEventName,
	SyncAccept,
	Update,
	Vertex,
} from "@ts-drp/types";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { beforeAll, describe, expect, test } from "vitest";

import { handleMessage } from "../src/handlers.js";
import { type DRPNode } from "../src/index.js";

interface LookupObservations {
	candidateComparisons: number;
	directLookups: number;
	materializations: number;
}

interface CapturedDispatch {
	event: CustomEvent<unknown>;
	type: NodeEventName;
}

interface CapturedMessage {
	message: Message;
	to: string;
}

interface HarnessResult {
	broadcasts: CapturedMessage[];
	direct: CapturedMessage[];
	dispatches: CapturedDispatch[];
	puts: Array<{ id: string; object: InstrumentedAppliedVertexObject }>;
	syncs: Array<{ id: string; peerId: string }>;
}

interface InstrumentedObjectOptions {
	canSign?: boolean;
	dropHashes?: readonly string[];
	missing?: readonly string[];
	responseAttestations?: readonly AggregatedAttestation[];
	senderIsFinalitySigner?: boolean;
}

const LOCAL_PEER_ID = "local-peer";
const OBJECT_ID = "applied-vertex-lookup-object";
const POST_SIGNING_SIGNATURE = Uint8Array.of(0xa5, 0x5a);

let remoteKeychain: Keychain;
let remotePeerId: string;

function observations(): LookupObservations {
	return { candidateComparisons: 0, directLookups: 0, materializations: 0 };
}

function localVertex(hash: string, signed = true): Vertex {
	return Vertex.create({
		hash,
		peerId: LOCAL_PEER_ID,
		dependencies: [],
		timestamp: 1,
		signature: signed ? Uint8Array.of(0x11) : new Uint8Array(),
	});
}

async function remoteVertex(hash: string): Promise<Vertex> {
	return Vertex.create({
		hash,
		peerId: remotePeerId,
		dependencies: [],
		timestamp: 2,
		signature: await remoteKeychain.signWithSecp256k1(hash),
	});
}

function aggregate(hash: string, marker: number): AggregatedAttestation {
	return AggregatedAttestation.create({
		data: hash,
		signature: Uint8Array.of(marker),
		aggregationBits: Uint8Array.of(marker + 1),
	});
}

function updateMessage(vertices: readonly Vertex[], attestations: readonly Attestation[] = []): Message {
	return Message.create({
		sender: remotePeerId,
		type: MessageType.MESSAGE_TYPE_UPDATE,
		objectId: OBJECT_ID,
		data: Update.encode(Update.create({ vertices: [...vertices], attestations: [...attestations] })).finish(),
	});
}

function syncAcceptMessage(
	requested: readonly Vertex[],
	requesting: readonly string[],
	attestations: readonly AggregatedAttestation[] = []
): Message {
	return Message.create({
		sender: remotePeerId,
		type: MessageType.MESSAGE_TYPE_SYNC_ACCEPT,
		objectId: OBJECT_ID,
		data: SyncAccept.encode(
			SyncAccept.create({ requested: [...requested], requesting: [...requesting], attestations: [...attestations] })
		).finish(),
	});
}

class InstrumentedAppliedVertexObject {
	readonly id = OBJECT_ID;
	readonly acl: { query_isFinalitySigner(peerId: string): boolean };
	readonly finalityStore: {
		addSignatures(peerId: string, attestations: Attestation[], verify?: boolean): Attestation[];
		canSign(peerId: string, hash: string): boolean;
		getAttestation(hash: string): AggregatedAttestation | undefined;
		mergeSignatures(attestations: AggregatedAttestation[]): void;
		signed(peerId: string, hash: string): boolean;
	};
	readonly addedSignatureCalls: Array<{ attestations: Attestation[]; peerId: string; verify: boolean | undefined }> =
		[];
	readonly mergedAttestationCalls: AggregatedAttestation[][] = [];
	readonly mergedVertexCalls: Vertex[][] = [];
	private readonly mergeMetadata = new WeakMap<
		[boolean, string[], string[]],
		{ applied: readonly Vertex[]; hasTrustedOrAuthenticatedOffers: boolean }
	>();

	private readonly directIndex = new Map<string, Vertex>();
	private readonly dropHashes: Set<string>;
	private readonly inventory: Vertex[];
	private readonly missing: string[];
	private readonly responseAttestations = new Map<string, AggregatedAttestation>();

	constructor(
		inventory: readonly Vertex[],
		readonly lookupObservations: LookupObservations,
		options: InstrumentedObjectOptions = {}
	) {
		this.inventory = [...inventory];
		for (const vertex of this.inventory) this.directIndex.set(vertex.hash, vertex);
		this.dropHashes = new Set(options.dropHashes);
		this.missing = [...(options.missing ?? [])];
		for (const attestation of options.responseAttestations ?? []) {
			this.responseAttestations.set(attestation.data, attestation);
		}
		this.acl = {
			query_isFinalitySigner: (): boolean => options.senderIsFinalitySigner ?? true,
		};
		this.finalityStore = {
			addSignatures: (peerId, attestations, verify): Attestation[] => {
				this.addedSignatureCalls.push({ peerId, attestations: [...attestations], verify });
				return [...attestations];
			},
			canSign: (): boolean => options.canSign ?? true,
			getAttestation: (hash): AggregatedAttestation | undefined => this.responseAttestations.get(hash),
			mergeSignatures: (attestations): void => {
				this.mergedAttestationCalls.push([...attestations]);
			},
			signed: (): boolean => false,
		};
	}

	get vertices(): Vertex[] {
		this.lookupObservations.materializations++;
		const materialized = [...this.inventory];
		const nativeFind = materialized.find;
		materialized.find = ((
			predicate: (candidate: Vertex, index: number, array: Vertex[]) => unknown,
			thisArg?: unknown
		) =>
			nativeFind.call(
				materialized,
				(candidate, index, array) => {
					this.lookupObservations.candidateComparisons++;
					return predicate.call(thisArg, candidate, index, array);
				},
				thisArg
			)) as typeof materialized.find;
		return materialized;
	}

	/**
	 * Semantic direct-lookup control for the future required public method.
	 * @param hash - Vertex hash to resolve.
	 * @returns The stored vertex reference, when present.
	 */
	getVertex(hash: string): Vertex | undefined {
		this.lookupObservations.directLookups++;
		return this.directIndex.get(hash);
	}

	merge(vertices: Vertex[]): Promise<[boolean, string[], string[]]> {
		this.mergedVertexCalls.push([...vertices]);
		const invalid: string[] = [];
		const verified = authenticateVertices(vertices);
		const verifiedHashes = new Set(verified.map(({ hash }) => hash));
		for (const vertex of vertices) if (!verifiedHashes.has(vertex.hash)) invalid.push(vertex.hash);
		const applied: Vertex[] = [];
		for (const vertex of verified) {
			if (this.dropHashes.has(vertex.hash)) {
				invalid.push(vertex.hash);
				continue;
			}
			if (this.directIndex.has(vertex.hash)) continue;
			this.inventory.push(vertex);
			this.directIndex.set(vertex.hash, vertex);
			applied.push(vertex);
		}
		const result: [boolean, string[], string[]] = [true, [...this.missing], invalid];
		this.mergeMetadata.set(result, {
			applied,
			hasTrustedOrAuthenticatedOffers: verified.length !== 0,
		});
		return Promise.resolve(result);
	}

	appliedVerticesForMergeResult(result: [boolean, string[], string[]]): readonly Vertex[] | undefined {
		return this.mergeMetadata.get(result)?.applied;
	}

	mergeHadTrustedOrAuthenticatedOffers(result: [boolean, string[], string[]]): boolean | undefined {
		return this.mergeMetadata.get(result)?.hasTrustedOrAuthenticatedOffers;
	}
}

function makeHarness(object: InstrumentedAppliedVertexObject): { node: DRPNode; result: HarnessResult } {
	const result: HarnessResult = { broadcasts: [], direct: [], dispatches: [], puts: [], syncs: [] };
	const node = {
		networkNode: {
			peerId: LOCAL_PEER_ID,
			broadcastMessage: (to: string, message: Message): Promise<void> => {
				result.broadcasts.push({ to, message });
				return Promise.resolve();
			},
			sendMessage: (to: string, message: Message): Promise<void> => {
				result.direct.push({ to, message });
				return Promise.resolve();
			},
		},
		keychain: {
			signWithBls: (hash: string): Uint8Array => Uint8Array.of(0xb0, hash.length),
			signWithSecp256k1: (): Promise<Uint8Array> => Promise.resolve(POST_SIGNING_SIGNATURE),
		},
		get: (id: string) => (id === object.id ? (object as unknown as IDRPObject<IDRP>) : undefined),
		put: (id: string, storedObject: InstrumentedAppliedVertexObject) => {
			result.puts.push({ id, object: storedObject });
		},
		safeDispatchEvent: (type: NodeEventName, event: CustomEvent<unknown>) => {
			result.dispatches.push({ type, event });
		},
		syncObject: (id: string, peerId: string): Promise<void> => {
			result.syncs.push({ id, peerId });
			return Promise.resolve();
		},
	} as unknown as DRPNode;
	return { node, result };
}

function dispatchDetails<T>(result: HarnessResult, type: NodeEventName): T[] {
	return result.dispatches.filter((dispatch) => dispatch.type === type).map((dispatch) => dispatch.event.detail as T);
}

beforeAll(async () => {
	remoteKeychain = new Keychain({ private_key_seed: "applied-vertex-lookup-remote" });
	await remoteKeychain.start();
	const publicKey = publicKeyFromRaw(uint8ArrayFromString(remoteKeychain.secp256k1PublicKey, "base64"));
	remotePeerId = peerIdFromPublicKey(publicKey).toString();
});

describe("applied-vertex lookup pre-change semantic and wire baselines", () => {
	test("UPDATE preserves verified present-after-merge membership, finality, recovery, persistence, and dispatch", async () => {
		const known = await remoteVertex("update-known");
		const added = await remoteVertex("update-added");
		const dropped = await remoteVertex("update-dropped");
		const unauthenticated = Vertex.create({ ...localVertex("update-unsigned"), signature: new Uint8Array() });
		const remoteAttestation = { data: known.hash, signature: Uint8Array.of(0x31) };
		const object = new InstrumentedAppliedVertexObject([known], observations(), {
			dropHashes: [dropped.hash],
			missing: ["update-missing-parent"],
		});
		const { node, result } = makeHarness(object);
		const message = updateMessage([known, added, dropped, unauthenticated], [remoteAttestation]);

		await handleMessage(node, message);

		expect(object.mergedVertexCalls).toHaveLength(1);
		expect(object.mergedVertexCalls[0].map(({ hash }) => hash)).toEqual([
			known.hash,
			added.hash,
			dropped.hash,
			unauthenticated.hash,
		]);
		expect(object.getVertex(known.hash)).toBe(known);
		expect(object.getVertex(added.hash)?.hash).toBe(added.hash);
		expect(object.getVertex(dropped.hash)).toBeUndefined();
		expect(result.syncs).toEqual([{ id: OBJECT_ID, peerId: remotePeerId }]);
		expect(result.puts).toEqual([{ id: OBJECT_ID, object }]);

		expect(object.addedSignatureCalls[0]).toEqual({
			peerId: remotePeerId,
			attestations: [remoteAttestation],
			verify: undefined,
		});
		// Known hashes are trusted skips at the object boundary. They are not
		// reauthenticated and therefore cannot trigger a new local attestation.
		const generated = [added.hash].map((hash) => ({
			data: hash,
			signature: Uint8Array.of(0xb0, hash.length),
		}));
		expect(object.addedSignatureCalls[1]).toEqual({
			peerId: LOCAL_PEER_ID,
			attestations: generated,
			verify: false,
		});
		expect(result.broadcasts).toHaveLength(1);
		expect(result.broadcasts[0].to).toBe(OBJECT_ID);
		expect(result.broadcasts[0].message).toMatchObject({
			sender: LOCAL_PEER_ID,
			type: MessageType.MESSAGE_TYPE_ATTESTATION_UPDATE,
			objectId: OBJECT_ID,
		});
		expect(result.broadcasts[0].message.data).toEqual(
			AttestationUpdate.encode(AttestationUpdate.create({ attestations: generated })).finish()
		);

		const updates = dispatchDetails<{ id: string; update: Update }>(result, NodeEventName.DRP_UPDATE);
		expect(updates).toHaveLength(1);
		expect(updates[0]).toEqual({ id: OBJECT_ID, update: Update.decode(message.data) });
	});

	test("SYNC_ACCEPT pins exact response bytes, duplicates, stored identity, signing, finality, and events", async () => {
		const first = localVertex("accept-first", false);
		const second = localVertex("accept-second");
		const learned = await remoteVertex("accept-learned");
		const firstAggregate = aggregate(first.hash, 0x41);
		const secondAggregate = aggregate(second.hash, 0x51);
		const incomingAggregate = aggregate(learned.hash, 0x61);
		const object = new InstrumentedAppliedVertexObject([first, second], observations(), {
			responseAttestations: [firstAggregate, secondAggregate],
		});
		const { node, result } = makeHarness(object);
		const requesting = [second.hash, "accept-absent", first.hash, second.hash];

		await handleMessage(node, syncAcceptMessage([learned], requesting, [incomingAggregate]));

		expect(first.signature).toEqual(POST_SIGNING_SIGNATURE);
		expect(object.mergedAttestationCalls).toEqual([[incomingAggregate]]);
		expect(result.puts).toEqual([{ id: OBJECT_ID, object }]);
		expect(result.syncs).toHaveLength(0);
		expect(dispatchDetails(result, NodeEventName.DRP_SYNC_ACCEPTED)).toEqual([{ id: OBJECT_ID }]);

		expect(result.broadcasts).toHaveLength(1);
		const expectedGeneratedAttestations = [first, second, learned].map(({ hash }) => ({
			data: hash,
			signature: Uint8Array.of(0xb0, hash.length),
		}));
		expect(result.broadcasts[0].message.data).toEqual(
			AttestationUpdate.encode(AttestationUpdate.create({ attestations: expectedGeneratedAttestations })).finish()
		);
		expect(object.addedSignatureCalls.at(-1)).toEqual({
			peerId: LOCAL_PEER_ID,
			attestations: expectedGeneratedAttestations,
			verify: false,
		});

		expect(result.direct).toHaveLength(1);
		const response = result.direct[0];
		const expectedRequested = [second, first, second];
		const expectedPayload = SyncAccept.encode(
			SyncAccept.create({
				requested: expectedRequested,
				requesting: [],
				attestations: [secondAggregate, firstAggregate, secondAggregate],
			})
		).finish();
		expect(response).toMatchObject({ to: remotePeerId });
		expect(response.message).toMatchObject({
			sender: LOCAL_PEER_ID,
			type: MessageType.MESSAGE_TYPE_SYNC_ACCEPT,
			objectId: OBJECT_ID,
		});
		expect(response.message.data).toEqual(expectedPayload);
		const decoded = SyncAccept.decode(response.message.data);
		expect(decoded.requested.map(({ hash }) => hash)).toEqual([second.hash, first.hash, second.hash]);
		expect(decoded.requested[1].signature).toEqual(POST_SIGNING_SIGNATURE);
		expect(decoded.attestations).toEqual([secondAggregate, firstAggregate, secondAggregate]);

		const missingDispatches = dispatchDetails<{ id: string; requested: Vertex[]; requesting: string[] }>(
			result,
			NodeEventName.DRP_SYNC_MISSING
		);
		expect(missingDispatches).toHaveLength(1);
		expect(missingDispatches[0].id).toBe(OBJECT_ID);
		expect(missingDispatches[0].requesting).toEqual([]);
		expect(missingDispatches[0].requested).toEqual(expectedRequested);
		expect(missingDispatches[0].requested[0]).toBe(second);
		expect(missingDispatches[0].requested[1]).toBe(first);
		expect(missingDispatches[0].requested[2]).toBe(second);
	});

	test("SYNC_ACCEPT preserves missing recovery and suppresses accepted until recovery is complete", async () => {
		const stored = localVertex("recovery-stored");
		const learned = await remoteVertex("recovery-learned");
		const object = new InstrumentedAppliedVertexObject([stored], observations(), {
			missing: ["recovery-parent"],
			canSign: false,
		});
		const { node, result } = makeHarness(object);

		await handleMessage(node, syncAcceptMessage([learned], [stored.hash]));

		expect(result.syncs).toEqual([{ id: OBJECT_ID, peerId: remotePeerId }]);
		expect(result.puts).toEqual([{ id: OBJECT_ID, object }]);
		expect(dispatchDetails(result, NodeEventName.DRP_SYNC_ACCEPTED)).toHaveLength(0);
		expect(dispatchDetails(result, NodeEventName.DRP_SYNC_MISSING)).toHaveLength(1);
		expect(result.direct).toHaveLength(1);
	});

	test("SYNC_ACCEPT preserves attestation merge for an authenticated offer rejected after authentication", async () => {
		const rejected = await remoteVertex("authenticated-sync-rejected-after-auth");
		const incoming = aggregate(rejected.hash, 0x71);
		const object = new InstrumentedAppliedVertexObject([], observations(), {
			canSign: false,
			dropHashes: [rejected.hash],
		});
		const { node } = makeHarness(object);

		await handleMessage(node, syncAcceptMessage([rejected], [], [incoming]));

		expect(object.getVertex(rejected.hash)).toBeUndefined();
		expect(object.mergedAttestationCalls).toEqual([[incoming]]);
	});

	test("empty SYNC_ACCEPT keeps both inventory sweeps but sends, persists, recovers, and dispatches nothing", async () => {
		const object = new InstrumentedAppliedVertexObject([localVertex("empty-stored")], observations(), {
			canSign: false,
		});
		const { node, result } = makeHarness(object);

		await handleMessage(node, syncAcceptMessage([], []));

		expect(object.lookupObservations).toEqual({
			candidateComparisons: 0,
			directLookups: 0,
			materializations: 2,
		});
		expect(result).toEqual({ broadcasts: [], direct: [], dispatches: [], puts: [], syncs: [] });
		expect(object.mergedVertexCalls).toHaveLength(0);
		expect(object.mergedAttestationCalls).toHaveLength(0);
	});
});

describe("applied-vertex direct-lookup causal contracts", () => {
	test("UPDATE consumes object-owned merge metadata without inventory or raw-offer lookups", async () => {
		const known = await remoteVertex("causal-update-known");
		const lookup = observations();
		const object = new InstrumentedAppliedVertexObject([known], lookup, { canSign: false });
		const { node } = makeHarness(object);

		await handleMessage(node, updateMessage([known]));

		expect.soft(lookup.materializations).toBe(0);
		expect.soft(lookup.directLookups).toBe(0);
	});

	test("SYNC_ACCEPT keeps exactly two sweeps and makes response comparison work independent of V", async () => {
		// As in D.86, cached private primitive entries could hide repeated index
		// rebuilds from representation-neutral probes. We deliberately do not add
		// a Map.prototype.set or wall-clock gate to close that accepted limitation.
		const rows: Array<{ h: number; lookup: LookupObservations; v: number }> = [];
		for (const [v, h] of [
			[64, 1],
			[64, 4],
			[64, 8],
			[256, 4],
		] as const) {
			const inventory = Array.from({ length: v }, (_, index) => localVertex(`causal-accept-${v}-${index}`));
			const lookup = observations();
			const object = new InstrumentedAppliedVertexObject(inventory, lookup, { canSign: false });
			const { node } = makeHarness(object);
			const requesting = Array.from({ length: h }, (_, index) => inventory[v - 1 - index].hash);

			await handleMessage(node, syncAcceptMessage([], requesting));
			rows.push({ v, h, lookup });
		}

		for (const { v, h, lookup } of rows) {
			expect.soft(lookup.materializations, `V=${v}, H=${h}`).toBe(2);
			expect.soft(lookup.directLookups, `V=${v}, H=${h}`).toBe(h);
			expect.soft(lookup.candidateComparisons, `V=${v}, H=${h}`).toBe(0);
		}
	});
});
