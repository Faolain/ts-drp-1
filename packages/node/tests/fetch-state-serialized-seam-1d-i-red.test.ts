/* eslint-disable @typescript-eslint/no-non-null-assertion -- decoded presence is asserted by the frozen root fixture */
import { HashGraph } from "@ts-drp/object";
import {
	DRPState,
	DRPStateEntry,
	DRPStateOtherTheWire,
	FetchState,
	FetchStateResponse,
	type IDRP,
	type IDRPObject,
	Message,
	MessageType,
} from "@ts-drp/types";
import { serializeDRPState } from "@ts-drp/utils/serialization";
import { describe, expect, it, vi } from "vitest";

import { handleMessage } from "../src/handlers.js";
import { type DRPNode } from "../src/index.js";

const FROZEN_ACL_NESTED_HEX = "0a160a0361636c120f81a661646d696e7391a56f776e6572";
const FROZEN_DRP_NESTED_HEX = "0a1b0a036472701214c711019192a36b657981a676616c756573920102";
const FROZEN_ROOT_RESPONSE_HEX =
	"0a403432356432623166353234336462663233633638353037383033346230366662666137316463333164636365333066363134653238303233663134306666313312180a160a0361636c120f81a661646d696e7391a56f776e65721a1d0a1b0a036472701214c711019192a36b657981a676616c756573920102";

type SerializedSnapshotReader = IDRPObject<IDRP> & {
	getSerializedStates(vertexHash: string): readonly [Uint8Array | undefined, Uint8Array | undefined];
};

function nestedBytes(entries: Record<string, unknown>): Uint8Array {
	const snapshot = DRPState.create({
		state: Object.entries(entries).map(([key, value]) => DRPStateEntry.create({ key, value })),
	});
	return DRPStateOtherTheWire.encode(serializeDRPState(snapshot)).finish();
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function request(
	serializedPair: readonly [Uint8Array | undefined, Uint8Array | undefined],
	vertexHash: string
): Promise<{
	getSerializedStates: ReturnType<typeof vi.fn>;
	getStates: ReturnType<typeof vi.fn>;
	wire: Uint8Array;
}> {
	const sent: Message[] = [];
	const getStates = vi.fn(() => {
		throw new Error("public getStates must not be used by FetchState");
	});
	const getSerializedStates = vi.fn(() => serializedPair);
	const object = {
		id: "serialized-object",
		getStates,
		getSerializedStates,
		getVertex: vi.fn(() => undefined),
	} as unknown as SerializedSnapshotReader;
	const node = {
		get: vi.fn(() => object),
		networkNode: {
			peerId: "receiver",
			sendMessage: vi.fn((_recipient: string, message: Message) => {
				sent.push(message);
				return Promise.resolve();
			}),
		},
		safeDispatchEvent: vi.fn(),
	} as unknown as DRPNode;
	const message = Message.create({
		sender: "requester",
		type: MessageType.MESSAGE_TYPE_FETCH_STATE,
		objectId: object.id,
		data: FetchState.encode(FetchState.create({ vertexHash })).finish(),
	});

	await handleMessage(node, message);
	return { getStates, getSerializedStates, wire: sent[0].data };
}

describe("Phase 1d(i) serialized snapshot seam", () => {
	it("publishes a mandatory byte-only ACL-first member on IDRPObject", () => {
		type AssertPublished<T extends SerializedSnapshotReader> = T;
		type PublishedSurface = AssertPublished<IDRPObject<IDRP>>;
		const compileTimeOnly: PublishedSurface | undefined = undefined;
		expect(compileTimeOnly).toBeUndefined();
	});

	it("performs one pair read, zero getStates reads, and preserves exact root response bytes", async () => {
		const aclBytes = nestedBytes({ acl: { admins: ["owner"] } });
		const drpBytes = nestedBytes({ drp: new Map([["key", { values: [1, 2] }]]) });
		expect(hex(aclBytes), "frozen pre-1d(i) ACL nested bytes").toBe(FROZEN_ACL_NESTED_HEX);
		expect(hex(drpBytes), "frozen pre-1d(i) DRP nested bytes").toBe(FROZEN_DRP_NESTED_HEX);
		const expected = FetchStateResponse.encode(
			FetchStateResponse.create({
				vertexHash: HashGraph.rootHash,
				aclState: DRPStateOtherTheWire.decode(aclBytes),
				drpState: DRPStateOtherTheWire.decode(drpBytes),
			})
		).finish();
		expect(hex(expected), "frozen pre-1d(i) root FetchStateResponse bytes").toBe(FROZEN_ROOT_RESPONSE_HEX);
		const result = await request([aclBytes, drpBytes], HashGraph.rootHash);

		expect(result.getSerializedStates).toHaveBeenCalledExactlyOnceWith(HashGraph.rootHash);
		expect(result.getStates).not.toHaveBeenCalled();
		expect(result.wire).toEqual(expected);
		const decoded = FetchStateResponse.decode(result.wire);
		expect(DRPStateOtherTheWire.encode(decoded.aclState!).finish()).toEqual(aclBytes);
		expect(DRPStateOtherTheWire.encode(decoded.drpState!).finish()).toEqual(drpBytes);
	});

	it("preserves requesting hash and explicit missing/pruned presence with zero pair reads", async () => {
		const result = await request([undefined, undefined], "pruned-cut");
		const decoded = FetchStateResponse.decode(result.wire);

		expect(result.getSerializedStates).not.toHaveBeenCalled();
		expect(result.getStates).not.toHaveBeenCalled();
		expect(decoded).toEqual({ vertexHash: "pruned-cut", aclState: undefined, drpState: undefined });
	});
});
