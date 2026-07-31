import {
	type AggregatedAttestation,
	type IDRP,
	type IDRPObject,
	Message,
	MessageType,
	NodeEventName,
	Sync,
	SyncAccept,
	Vertex,
} from "@ts-drp/types";
import { afterEach, describe, expect, test, vi } from "vitest";

import { handleMessage } from "../src/handlers.js";
import { type DRPNode } from "../src/index.js";

interface LookupObservations {
	candidateComparisons: number;
	keyedLookups: number;
	materializations: number;
}

interface CapturedDispatch {
	type: NodeEventName;
	event: CustomEvent<unknown>;
}

interface HarnessResult {
	dispatches: CapturedDispatch[];
	responses: Message[];
}

const STOP_AFTER_COMPARE = new Error("sync lookup comparison complete");

function vertex(hash: string): Vertex {
	return Vertex.create({
		hash,
		peerId: "remote-author",
		signature: Uint8Array.of(1),
		dependencies: [],
		timestamp: 1,
	});
}

function instrumentFind(vertices: Vertex[], observations: LookupObservations): Vertex[] {
	const nativeFind = vertices.find;
	vertices.find = ((predicate: (candidate: Vertex, index: number, array: Vertex[]) => unknown, thisArg?: unknown) =>
		nativeFind.call(
			vertices,
			(candidate, index, array) => {
				observations.candidateComparisons++;
				return predicate.call(thisArg, candidate, index, array);
			},
			thisArg
		)) as typeof vertices.find;
	return vertices;
}

class InstrumentedSyncObject {
	readonly id = "sync-perf-contract-object";
	readonly finalityStore: { getAttestation(vertexHash: string): AggregatedAttestation | undefined };

	constructor(
		private readonly inventory: Vertex[],
		private readonly observations: LookupObservations,
		stopAfterCompare: boolean
	) {
		this.finalityStore = {
			getAttestation: (): AggregatedAttestation | undefined => {
				if (stopAfterCompare) throw STOP_AFTER_COMPARE;
				return undefined;
			},
		};
	}

	get vertices(): Vertex[] {
		this.observations.materializations++;
		return instrumentFind([...this.inventory], this.observations);
	}
}

function installKeyedLookupProbe(incomingHashes: readonly string[], observations: LookupObservations): void {
	const isIncomingHash = (value: unknown): value is string =>
		typeof value === "string" && incomingHashes.includes(value);
	const nativeSetHas = Set.prototype.has;
	const nativeMapHas = Map.prototype.has;
	const nativeMapGet = Map.prototype.get;

	vi.spyOn(Set.prototype, "has").mockImplementation(function (this: Set<unknown>, value: unknown) {
		if (isIncomingHash(value)) observations.keyedLookups++;
		return nativeSetHas.call(this, value);
	});
	vi.spyOn(Map.prototype, "has").mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
		if (isIncomingHash(key)) observations.keyedLookups++;
		return nativeMapHas.call(this, key);
	});
	vi.spyOn(Map.prototype, "get").mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
		if (isIncomingHash(key)) observations.keyedLookups++;
		return nativeMapGet.call(this, key);
	});
}

function makeHarness(object: InstrumentedSyncObject): { node: DRPNode; result: HarnessResult } {
	const result: HarnessResult = { dispatches: [], responses: [] };
	const node = {
		networkNode: {
			peerId: "local-peer",
			sendMessage: (_recipient: string, message: Message): Promise<void> => {
				result.responses.push(message);
				return Promise.resolve();
			},
		},
		keychain: {
			signWithSecp256k1: (): never => {
				throw new Error("Remote-authored fixture vertices must not be signed locally");
			},
		},
		get: (id: string) => (id === object.id ? (object as unknown as IDRPObject<IDRP>) : undefined),
		put: vi.fn(),
		safeDispatchEvent: (type: NodeEventName, event: CustomEvent<unknown>) => {
			result.dispatches.push({ type, event });
		},
	} as unknown as DRPNode;
	return { node, result };
}

function syncRequest(objectId: string, incomingHashes: readonly string[]): Message {
	return Message.create({
		sender: "requesting-peer",
		type: MessageType.MESSAGE_TYPE_SYNC,
		objectId,
		data: Sync.encode(Sync.create({ vertexHashes: [...incomingHashes] })).finish(),
	});
}

async function observeLookup(localSize: number, incomingCount: number): Promise<LookupObservations> {
	const observations: LookupObservations = {
		candidateComparisons: 0,
		keyedLookups: 0,
		materializations: 0,
	};
	const inventory = Array.from({ length: localSize }, (_, index) => vertex(`local-${index}`));
	const incomingHashes = Array.from({ length: incomingCount }, (_, index) => `missing-${index}`);
	const object = new InstrumentedSyncObject(inventory, observations, true);
	const { node, result } = makeHarness(object);
	installKeyedLookupProbe(incomingHashes, observations);

	await expect(handleMessage(node, syncRequest(object.id, incomingHashes))).rejects.toBe(STOP_AFTER_COMPARE);
	expect(result.responses).toHaveLength(0);
	return observations;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("sync responder lookup performance contract", () => {
	test("uses one candidate probe across 10k, 50k, and 100k local inventories", async () => {
		const rows = [];
		for (const localSize of [10_000, 50_000, 100_000]) {
			rows.push({ localSize, observations: await observeLookup(localSize, 1) });
			vi.restoreAllMocks();
		}

		for (const { localSize, observations } of rows) {
			const probesPerIncomingHash = observations.candidateComparisons + observations.keyedLookups;
			expect.soft(probesPerIncomingHash, `${localSize} local vertices`).toBe(1);
		}
		const materializations = rows.map(({ observations }) => observations.materializations);
		expect(new Set(materializations).size, JSON.stringify(materializations)).toBe(1);
	}, 10_000);

	test("materializes the local inventory a constant number of times as incoming hashes grow", async () => {
		const incomingCounts = [1, 4, 8];
		const rows = [];
		for (const incomingCount of incomingCounts) {
			rows.push({ incomingCount, observations: await observeLookup(512, incomingCount) });
			vi.restoreAllMocks();
		}

		for (const { incomingCount, observations } of rows) {
			const probesPerIncomingHash = (observations.candidateComparisons + observations.keyedLookups) / incomingCount;
			expect.soft(probesPerIncomingHash, `${incomingCount} incoming hashes`).toBe(1);
		}
		const materializations = rows.map(({ observations }) => observations.materializations);
		expect(new Set(materializations).size, JSON.stringify(materializations)).toBe(1);
	});

	test("preserves response bytes, requested Set semantics, and requesting order", async () => {
		const observations: LookupObservations = {
			candidateComparisons: 0,
			keyedLookups: 0,
			materializations: 0,
		};
		const [first, second, third] = [vertex("local-a"), vertex("local-b"), vertex("local-c")];
		const object = new InstrumentedSyncObject([first, second, third], observations, false);
		const { node, result } = makeHarness(object);
		const incoming = ["missing-z", second.hash, "missing-y", first.hash];

		await handleMessage(node, syncRequest(object.id, incoming));

		expect(result.responses).toHaveLength(1);
		const responseMessage = result.responses[0];
		const expectedPayload = SyncAccept.encode(
			SyncAccept.create({ requested: [third], requesting: ["missing-z", "missing-y"], attestations: [] })
		).finish();
		expect(responseMessage).toMatchObject({
			sender: "local-peer",
			type: MessageType.MESSAGE_TYPE_SYNC_ACCEPT,
			objectId: object.id,
		});
		expect(responseMessage.data).toEqual(expectedPayload);
		expect(SyncAccept.decode(responseMessage.data)).toEqual(SyncAccept.decode(expectedPayload));

		const syncDispatch = result.dispatches.find(({ type }) => type === NodeEventName.DRP_SYNC);
		expect(syncDispatch).toBeDefined();
		const detail = syncDispatch?.event.detail as { requested: Set<Vertex>; requesting: string[] };
		expect(detail.requested).toBeInstanceOf(Set);
		expect([...detail.requested]).toEqual([third]);
		expect(detail.requesting).toEqual(["missing-z", "missing-y"]);
	});

	test("sends no response when the peer inventory is already complete", async () => {
		const observations: LookupObservations = {
			candidateComparisons: 0,
			keyedLookups: 0,
			materializations: 0,
		};
		const inventory = [vertex("local-a"), vertex("local-b")];
		const object = new InstrumentedSyncObject(inventory, observations, false);
		const { node, result } = makeHarness(object);

		await handleMessage(
			node,
			syncRequest(
				object.id,
				inventory.map(({ hash }) => hash)
			)
		);

		expect(result.responses).toHaveLength(0);
		expect(result.dispatches).toHaveLength(0);
	});
});
