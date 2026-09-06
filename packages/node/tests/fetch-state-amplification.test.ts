import { SetDRP } from "@ts-drp/blueprints";
import { DRPObject, HashGraph } from "@ts-drp/object";
import {
	DRPStateOtherTheWire,
	FetchState,
	FetchStateResponse,
	Message,
	MessageType,
	NodeEventName,
} from "@ts-drp/types";
import { describe, expect, it, vi } from "vitest";

import { handleMessage } from "../src/handlers.js";
import { type DRPNode } from "../src/index.js";

const RESPONDER = "phase-1j-responder";
const REQUESTER = "phase-1j-requester";

interface RequestObservation {
	codecDecodes: number;
	codecEncodes: number;
	dispatch: ReturnType<typeof vi.fn>;
	object: DRPObject<SetDRP<number>>;
	response: FetchStateResponse | undefined;
	sent: Message[];
	serializedStateReads: number;
	snapshotPayloadBytes: number;
}

function payloadBytes(response: FetchStateResponse | undefined): number {
	if (response === undefined) return 0;
	return [response.aclState, response.drpState].reduce(
		(total, state) => total + (state === undefined ? 0 : DRPStateOtherTheWire.encode(state).finish().byteLength),
		0
	);
}

function statefulObject(): DRPObject<SetDRP<number>> {
	const object = new DRPObject({ peerId: RESPONDER, drp: new SetDRP<number>() });
	object.drp?.add(7);
	return object;
}

async function requestStoredState(object: DRPObject<SetDRP<number>>, vertexHash: string): Promise<RequestObservation> {
	const sent: Message[] = [];
	const dispatch = vi.fn();
	const node = {
		get: vi.fn((id: string) => (id === object.id ? object : undefined)),
		networkNode: {
			peerId: RESPONDER,
			sendMessage: vi.fn((_recipient: string, message: Message) => {
				sent.push(message);
				return Promise.resolve();
			}),
		},
		safeDispatchEvent: dispatch,
	} as unknown as DRPNode;
	const serializedStateReader = vi.spyOn(object, "getSerializedStates");
	const codecEncode = vi.spyOn(DRPStateOtherTheWire, "encode");
	const codecDecode = vi.spyOn(DRPStateOtherTheWire, "decode");

	await handleMessage(
		node,
		Message.create({
			sender: REQUESTER,
			type: MessageType.MESSAGE_TYPE_FETCH_STATE,
			objectId: object.id,
			data: FetchState.encode(FetchState.create({ vertexHash })).finish(),
		})
	);

	const serializedStateReads = serializedStateReader.mock.calls.length;
	const codecEncodes = codecEncode.mock.calls.length;
	const codecDecodes = codecDecode.mock.calls.length;
	serializedStateReader.mockRestore();
	codecEncode.mockRestore();
	codecDecode.mockRestore();
	const response = sent[0] === undefined ? undefined : FetchStateResponse.decode(sent[0].data);

	return {
		codecDecodes,
		codecEncodes,
		dispatch,
		object,
		response,
		sent,
		serializedStateReads,
		snapshotPayloadBytes: payloadBytes(response),
	};
}

function expectFetchEvent(observation: RequestObservation, vertexHash: string): void {
	expect(observation.dispatch).toHaveBeenCalledExactlyOnceWith(NodeEventName.DRP_FETCH_STATE, {
		detail: {
			id: observation.object.id,
			fetchState: { vertexHash },
		},
	});
}

function expectZeroSnapshotWork(observation: RequestObservation): void {
	expect({
		serializedStateReads: observation.serializedStateReads,
		codecEncodes: observation.codecEncodes,
		codecDecodes: observation.codecDecodes,
		snapshotPayloadBytes: observation.snapshotPayloadBytes,
	}).toEqual({
		serializedStateReads: 0,
		codecEncodes: 0,
		codecDecodes: 0,
		snapshotPayloadBytes: 0,
	});
}

describe("Phase 1j FETCH_STATE amplification", () => {
	it("sends zero stored snapshot payload bytes for an existing non-root hash", async () => {
		const object = statefulObject();
		const nonRootHash = object.vertices.at(-1)?.hash;
		if (nonRootHash === undefined || nonRootHash === HashGraph.rootHash) {
			throw new Error("Expected a stored non-root vertex");
		}
		const [storedACL, storedDRP] = object.getSerializedStates(nonRootHash);
		expect(storedACL?.byteLength).toBeGreaterThan(0);
		expect(storedDRP?.byteLength).toBeGreaterThan(0);

		const observation = await requestStoredState(object, nonRootHash);
		expectFetchEvent(observation, nonRootHash);
		expect(observation.sent.length).toBeLessThanOrEqual(1);
		if (observation.sent[0] !== undefined) {
			expect(observation.sent[0]).toMatchObject({
				sender: RESPONDER,
				type: MessageType.MESSAGE_TYPE_FETCH_STATE_RESPONSE,
				objectId: observation.object.id,
			});
		}
		expectZeroSnapshotWork(observation);
		if (observation.sent[0] !== undefined) {
			expect(observation.response).toEqual({
				vertexHash: nonRootHash,
				aclState: undefined,
				drpState: undefined,
			});
		}
	});

	it("preserves the root-state response used by the join handshake", async () => {
		const object = statefulObject();
		const observation = await requestStoredState(object, HashGraph.rootHash);
		expectFetchEvent(observation, HashGraph.rootHash);
		expect(observation.serializedStateReads).toBe(1);
		expect(observation.codecEncodes).toBeGreaterThan(0);
		expect(observation.codecDecodes).toBeGreaterThan(0);
		expect(observation.snapshotPayloadBytes).toBeGreaterThan(0);
		expect(observation.sent).toHaveLength(1);
		expect(observation.sent[0]).toMatchObject({
			sender: RESPONDER,
			type: MessageType.MESSAGE_TYPE_FETCH_STATE_RESPONSE,
			objectId: observation.object.id,
		});
		expect(observation.response?.vertexHash).toBe(HashGraph.rootHash);
		expect(observation.response?.aclState).toBeDefined();
		expect(observation.response?.drpState).toBeDefined();
	});

	it("preserves the explicit header-only response for a missing hash", async () => {
		const object = statefulObject();
		const missingHash = "phase-1j-missing-hash";
		const observation = await requestStoredState(object, missingHash);
		expectFetchEvent(observation, missingHash);
		expect(observation.sent).toHaveLength(1);
		expect(observation.sent[0]).toMatchObject({
			sender: RESPONDER,
			type: MessageType.MESSAGE_TYPE_FETCH_STATE_RESPONSE,
			objectId: observation.object.id,
		});
		expect(observation.response).toEqual({
			vertexHash: missingHash,
			aclState: undefined,
			drpState: undefined,
		});
		expectZeroSnapshotWork(observation);
	});
});
