import { publicKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { Signature } from "@noble/secp256k1";
import { Keychain } from "@ts-drp/keychain";
import { type IDRP, type IDRPObject, Message, MessageType, NodeEventName, Update, Vertex } from "@ts-drp/types";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { handleMessage } from "../src/handlers.js";
import { type DRPNode } from "../src/index.js";
import { log } from "../src/logger.js";

// Normal local publication enqueues one committed vertex per UPDATE. At the
// plan's measured ~1.3 ms/recovery, 32 is already ~42 ms of synchronous work;
// it is therefore a conservative compatibility headroom below the 50 ms wall.
// SYNC_ACCEPT has a different producer and remains owned by Phase 1o.
const MAX_UPDATE_VERTICES = 32;
const OBJECT_ID = "phase-1g-update-cap";
let remote: { keychain: Keychain; peerId: string };

beforeAll(async () => {
	const keychain = new Keychain({ private_key_seed: "phase-1g-update-cap-remote" });
	await keychain.start();
	const publicKey = publicKeyFromRaw(uint8ArrayFromString(keychain.secp256k1PublicKey, "base64"));
	remote = { keychain, peerId: peerIdFromPublicKey(publicKey).toString() };
});

function forgedVertex(index: number): Vertex {
	return Vertex.create({
		dependencies: [],
		hash: `phase-1g-forged-${index}`,
		peerId: remote.peerId,
		signature: new Uint8Array(65).fill(0x41),
		timestamp: 1_700_200_000_000 + index,
	});
}

async function signedVertex(): Promise<Vertex> {
	const vertex = Vertex.create({
		dependencies: [],
		hash: "phase-1g-valid-control",
		peerId: remote.peerId,
		timestamp: 1_700_200_000_000,
	});
	vertex.signature = await remote.keychain.signWithSecp256k1(vertex.hash);
	return vertex;
}

async function updateMessage(count: number): Promise<Message> {
	const vertices = [await signedVertex(), ...Array.from({ length: count - 1 }, (_, index) => forgedVertex(index + 1))];
	return Message.create({
		data: Update.encode(Update.create({ vertices })).finish(),
		objectId: OBJECT_ID,
		sender: remote.peerId,
		type: MessageType.MESSAGE_TYPE_UPDATE,
	});
}

interface Harness {
	node: DRPNode;
	observations: {
		broadcasts: number;
		dispatches: NodeEventName[];
		getVertexCalls: number;
		mergeCalls: number;
		puts: number;
		syncs: number;
	};
}

function harness(): Harness {
	const observations = {
		broadcasts: 0,
		dispatches: [] as NodeEventName[],
		getVertexCalls: 0,
		mergeCalls: 0,
		puts: 0,
		syncs: 0,
	};
	const object = {
		id: OBJECT_ID,
		getVertex: (): undefined => {
			observations.getVertexCalls++;
			return undefined;
		},
		merge: (): Promise<[boolean, string[], string[]]> => {
			observations.mergeCalls++;
			return Promise.resolve([true, [], []]);
		},
	} as unknown as IDRPObject<IDRP>;
	const node = {
		get: vi.fn(() => object),
		networkNode: {
			broadcastMessage: (): Promise<void> => {
				observations.broadcasts++;
				return Promise.resolve();
			},
			peerId: "phase-1g-local",
		},
		put: (): void => {
			observations.puts++;
		},
		safeDispatchEvent: (event: NodeEventName): void => {
			observations.dispatches.push(event);
		},
		syncObject: (): Promise<void> => {
			observations.syncs++;
			return Promise.resolve();
		},
	} as unknown as DRPNode;
	return { node, observations };
}

describe("Phase 1g UPDATE batch cap", () => {
	it("rejects an oversized decoded batch before authentication or side effects", async () => {
		const out = harness();
		const decode = vi.spyOn(Update, "decode");
		const recovery = vi.spyOn(Signature, "fromCompact");
		const errorLog = vi.spyOn(log, "error");

		try {
			await handleMessage(out.node, await updateMessage(MAX_UPDATE_VERTICES + 1)).catch(() => undefined);

			expect.soft(decode).toHaveBeenCalledOnce();
			expect
				.soft((decode.mock.results[0]?.value as Update | undefined)?.vertices)
				.toHaveLength(MAX_UPDATE_VERTICES + 1);
			expect.soft(recovery.mock.calls.length).toBe(0);
			expect.soft(out.observations).toEqual({
				broadcasts: 0,
				dispatches: [],
				getVertexCalls: 0,
				mergeCalls: 0,
				puts: 0,
				syncs: 0,
			});
			expect.soft(errorLog.mock.calls.length).toBeLessThanOrEqual(1);
		} finally {
			errorLog.mockRestore();
			recovery.mockRestore();
			decode.mockRestore();
		}
	});

	it("admits the exact boundary to the existing authentication path", async () => {
		const out = harness();
		const decode = vi.spyOn(Update, "decode");
		const recovery = vi.spyOn(Signature, "fromCompact");
		const errorLog = vi.spyOn(log, "error");

		try {
			await handleMessage(out.node, await updateMessage(MAX_UPDATE_VERTICES));

			expect.soft(decode).toHaveBeenCalledOnce();
			expect.soft((decode.mock.results[0]?.value as Update | undefined)?.vertices).toHaveLength(MAX_UPDATE_VERTICES);
			expect.soft(recovery.mock.calls.length).toBe(MAX_UPDATE_VERTICES);
			expect.soft(out.observations).toEqual({
				broadcasts: 0,
				dispatches: [NodeEventName.DRP_UPDATE],
				getVertexCalls: MAX_UPDATE_VERTICES + 1,
				mergeCalls: 1,
				puts: 1,
				syncs: 0,
			});
			expect.soft(errorLog).not.toHaveBeenCalled();
		} finally {
			errorLog.mockRestore();
			recovery.mockRestore();
			decode.mockRestore();
		}
	});
});
