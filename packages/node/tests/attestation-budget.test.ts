import { bls } from "@chainsafe/bls/herumi";
import { publicKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { Keychain } from "@ts-drp/keychain";
import { createACL, DRPObject } from "@ts-drp/object";
import {
	type AggregatedAttestation,
	type Attestation,
	AttestationUpdate,
	type FinalityConfig,
	type IACL,
	type IDRP,
	type IDRPObject,
	Message,
	MessageType,
	NodeEventName,
	SemanticsType,
	Sync,
	SyncAccept,
	Update,
	Vertex,
} from "@ts-drp/types";
import { createHash } from "node:crypto";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import {
	drpObjectChangesHandler,
	handleMessage,
	signFinalityVertices,
	signGeneratedVertices,
} from "../src/handlers.js";
import { type DRPNode } from "../src/index.js";

const DISABLED_FINALITY = { enabled: false } satisfies FinalityConfig;
type ExpectedFinalityConfig = FinalityConfig & { enabled?: boolean };

class BudgetProbeDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: number[] = [];

	append(value: number): void {
		this.values.push(value);
	}

	query_values(): number[] {
		return [...this.values];
	}
}

interface Signer {
	keychain: Keychain;
	peerId: string;
}

interface CapturedMessage {
	message: Message;
	to: string;
}

interface HarnessResult {
	broadcasts: CapturedMessage[];
	direct: CapturedMessage[];
	dispatches: Array<{ event: CustomEvent<unknown>; type: NodeEventName }>;
	puts: string[];
	syncs: Array<{ id: string; peerId: string }>;
}

const signers: Signer[] = [];

async function signer(seed: string): Promise<Signer> {
	const keychain = new Keychain({ private_key_seed: seed });
	await keychain.start();
	const publicKey = publicKeyFromRaw(uint8ArrayFromString(keychain.secp256k1PublicKey, "base64"));
	return { keychain, peerId: peerIdFromPublicKey(publicKey).toString() };
}

function roomACL(): IACL {
	const acl = createACL({ admins: signers.map(({ peerId }) => peerId) });
	for (const { keychain, peerId } of signers) {
		acl.context = { caller: peerId };
		acl.setKey(keychain.blsPublicKey);
	}
	acl.context = { caller: "" };
	return acl;
}

function roomObject(local: Signer, id: string, finalityConfig?: ExpectedFinalityConfig): DRPObject<BudgetProbeDRP> {
	return new DRPObject({
		peerId: local.peerId,
		id,
		acl: roomACL(),
		drp: new BudgetProbeDRP(),
		config: finalityConfig === undefined ? undefined : { finality_config: finalityConfig },
	});
}

function harness(local: Signer, objects: readonly IDRPObject<IDRP>[]): { node: DRPNode; result: HarnessResult } {
	const byId = new Map(objects.map((object) => [object.id, object]));
	const result: HarnessResult = { broadcasts: [], direct: [], dispatches: [], puts: [], syncs: [] };
	const node = {
		keychain: local.keychain,
		networkNode: {
			peerId: local.peerId,
			broadcastMessage: (to: string, message: Message): Promise<void> => {
				result.broadcasts.push({ to, message });
				return Promise.resolve();
			},
			sendMessage: (to: string, message: Message): Promise<void> => {
				result.direct.push({ to, message });
				return Promise.resolve();
			},
		},
		get: (id: string): IDRPObject<IDRP> | undefined => byId.get(id),
		put: (id: string): void => {
			result.puts.push(id);
		},
		safeDispatchEvent: (type: NodeEventName, event: CustomEvent<unknown>): void => {
			result.dispatches.push({ type, event });
		},
		syncObject: (id: string, peerId: string): Promise<void> => {
			result.syncs.push({ id, peerId });
			return Promise.resolve();
		},
	} as unknown as DRPNode;
	return { node, result };
}

function appendHistory(object: DRPObject<BudgetProbeDRP>, count: number, offset = 0): Vertex[] {
	const before = object.vertices.length;
	for (let index = 0; index < count; index++) object.drp?.append(offset + index);
	return object.vertices.slice(before);
}

function stateDigest(object: DRPObject<BudgetProbeDRP>): string {
	return createHash("sha256")
		.update(JSON.stringify(object.drp?.query_values() ?? []))
		.digest("hex");
}

function updateMessage(
	sender: string,
	objectId: string,
	vertices: readonly Vertex[],
	attestations: readonly Attestation[]
): Message {
	return Message.create({
		sender,
		type: MessageType.MESSAGE_TYPE_UPDATE,
		objectId,
		data: Update.encode(Update.create({ vertices: [...vertices], attestations: [...attestations] })).finish(),
	});
}

function syncAcceptMessage(
	sender: string,
	objectId: string,
	requested: readonly Vertex[],
	attestations: readonly AggregatedAttestation[] = []
): Message {
	return Message.create({
		sender,
		type: MessageType.MESSAGE_TYPE_SYNC_ACCEPT,
		objectId,
		data: SyncAccept.encode(
			SyncAccept.create({ requested: [...requested], attestations: [...attestations], requesting: [] })
		).finish(),
	});
}

function messagesOfType(result: HarnessResult, type: MessageType): CapturedMessage[] {
	return result.broadcasts.filter(({ message }) => message.type === type);
}

async function waitForBroadcast(result: HarnessResult, objectId: string, type: MessageType): Promise<Message> {
	await vi.waitFor(() => {
		expect(result.broadcasts.some(({ message }) => message.objectId === objectId && message.type === type)).toBe(true);
	});
	const captured = result.broadcasts.find(({ message }) => message.objectId === objectId && message.type === type);
	if (!captured) throw new Error(`Expected message ${type} for ${objectId}`);
	return captured.message;
}

beforeAll(async () => {
	signers.push(await signer("phase-1c-attestation-budget-a"), await signer("phase-1c-attestation-budget-b"));
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Phase 1c legacy attestation budget", () => {
	test("the enabled default preserves legacy initialization, signing, broadcast, and inbound verification", async () => {
		const [author, receiver] = signers;
		const objectId = "phase-1c-enabled-default";
		const source = roomObject(author, objectId);
		const replica = roomObject(receiver, objectId);
		const sourceHarness = harness(author, [source]);
		const receiverHarness = harness(receiver, [replica]);
		const sourceBlsSigns = vi.spyOn(author.keychain, "signWithBls");
		const receiverBlsSigns = vi.spyOn(receiver.keychain, "signWithBls");
		const verifies = vi.spyOn(bls, "verify");

		const vertices = appendHistory(source, 1, 10);
		drpObjectChangesHandler(sourceHarness.node, source, "callFn", vertices);
		const update = await waitForBroadcast(sourceHarness.result, objectId, MessageType.MESSAGE_TYPE_UPDATE);

		expect(source.finalityStore.states.size).toBe(1);
		expect(sourceBlsSigns).toHaveBeenCalledTimes(1);
		expect(Update.decode(update.data).attestations).toHaveLength(1);

		await handleMessage(receiverHarness.node, update);

		expect(replica.finalityStore.states.size).toBe(1);
		expect(verifies).toHaveBeenCalledTimes(1);
		expect(receiverBlsSigns).toHaveBeenCalledTimes(1);
		expect(replica.finalityStore.getNumberOfSignatures(vertices[0].hash)).toBe(2);
		expect(stateDigest(replica)).toBe(stateDigest(source));
		expect(messagesOfType(receiverHarness.result, MessageType.MESSAGE_TYPE_ATTESTATION_UPDATE)).toHaveLength(1);
	});

	test("a disabled local room emits the authenticated UPDATE but does no attestation work and leaves an enabled sibling isolated", async () => {
		const [local] = signers;
		const disabled = roomObject(local, "phase-1c-disabled-local", DISABLED_FINALITY);
		const enabledSibling = roomObject(local, "phase-1c-enabled-sibling");
		const { node, result } = harness(local, [disabled, enabledSibling]);
		const blsSigns = vi.spyOn(local.keychain, "signWithBls");

		const disabledVertices = appendHistory(disabled, 4, 20);
		drpObjectChangesHandler(node, disabled, "callFn", disabledVertices);
		const disabledUpdate = await waitForBroadcast(result, disabled.id, MessageType.MESSAGE_TYPE_UPDATE);
		const decodedDisabledUpdate = Update.decode(disabledUpdate.data);

		expect.soft(disabled.finalityStore.states.size).toBe(0);
		expect.soft(blsSigns).toHaveBeenCalledTimes(0);
		expect(decodedDisabledUpdate.vertices.map(({ hash }) => hash)).toEqual(disabledVertices.map(({ hash }) => hash));
		expect(decodedDisabledUpdate.vertices.every(({ signature }) => signature.length > 0)).toBe(true);
		expect.soft(decodedDisabledUpdate.attestations).toEqual([]);
		expect.soft(messagesOfType(result, MessageType.MESSAGE_TYPE_ATTESTATION_UPDATE)).toHaveLength(0);

		blsSigns.mockClear();
		const enabledVertices = appendHistory(enabledSibling, 1, 30);
		drpObjectChangesHandler(node, enabledSibling, "callFn", enabledVertices);
		const enabledUpdate = await waitForBroadcast(result, enabledSibling.id, MessageType.MESSAGE_TYPE_UPDATE);

		expect(enabledSibling.finalityStore.states.size).toBe(1);
		expect(blsSigns).toHaveBeenCalledTimes(1);
		expect(Update.decode(enabledUpdate.data).attestations).toHaveLength(1);
	});

	test("disabled UPDATE applies the same authenticated history with zero BLS work, finality growth, or attestation broadcast", async () => {
		const [author, receiver] = signers;
		const objectId = "phase-1c-disabled-update";
		const source = roomObject(author, objectId);
		const sourceHarness = harness(author, [source]);
		const history = appendHistory(source, 5, 40);
		await signGeneratedVertices(sourceHarness.node, history);
		const remoteAttestations = signFinalityVertices(sourceHarness.node, source, history);
		const enabled = roomObject(receiver, objectId);
		const disabled = roomObject(receiver, objectId, DISABLED_FINALITY);
		const enabledHarness = harness(receiver, [enabled]);
		const disabledHarness = harness(receiver, [disabled]);
		const forgedHash = "phase-1c-forged-author";
		const forged = Vertex.create({
			...history[0],
			hash: forgedHash,
			peerId: author.peerId,
			signature: await receiver.keychain.signWithSecp256k1(forgedHash),
		});
		const update = updateMessage(author.peerId, objectId, [...history, forged], remoteAttestations);

		await handleMessage(enabledHarness.node, update);
		expect(enabled.finalityStore.states.size).toBe(history.length);

		const blsSigns = vi.spyOn(receiver.keychain, "signWithBls");
		const verifies = vi.spyOn(bls, "verify");
		const aggregateVerifies = vi.spyOn(bls, "verifyAggregate");
		await handleMessage(disabledHarness.node, update);

		expect.soft(disabled.finalityStore.states.size).toBe(0);
		expect.soft(blsSigns).toHaveBeenCalledTimes(0);
		expect.soft(verifies).toHaveBeenCalledTimes(0);
		expect.soft(aggregateVerifies).toHaveBeenCalledTimes(0);
		expect.soft(messagesOfType(disabledHarness.result, MessageType.MESSAGE_TYPE_ATTESTATION_UPDATE)).toHaveLength(0);
		expect(disabled.getVertex(forgedHash)).toBeUndefined();
		expect(disabledHarness.result.puts).toEqual([objectId]);
		expect(disabledHarness.result.dispatches.filter(({ type }) => type === NodeEventName.DRP_UPDATE)).toHaveLength(1);
		expect(stateDigest(disabled)).toBe(stateDigest(enabled));
		expect(stateDigest(disabled)).toBe(stateDigest(source));

		const [missingParent, missingChild] = appendHistory(source, 2, 90);
		await signGeneratedVertices(sourceHarness.node, [missingParent, missingChild]);
		await handleMessage(disabledHarness.node, updateMessage(author.peerId, objectId, [missingChild], []));
		expect(disabled.getVertex(missingChild.hash)).toBeUndefined();
		expect(disabledHarness.result.syncs).toEqual([{ id: objectId, peerId: author.peerId }]);
		expect(disabledHarness.result.dispatches.filter(({ type }) => type === NodeEventName.DRP_UPDATE)).toHaveLength(2);
		expect.soft(disabled.finalityStore.states.size).toBe(0);
	});

	test("disabled SYNC_ACCEPT and SYNC preserve convergence, response bytes, and dispatch while doing zero attestation work", async () => {
		const [author, receiver] = signers;
		const objectId = "phase-1c-disabled-sync";
		const source = roomObject(author, objectId);
		const sourceHarness = harness(author, [source]);
		const history = appendHistory(source, 3, 50);
		await signGeneratedVertices(sourceHarness.node, history);
		const enabled = roomObject(receiver, objectId);
		const disabled = roomObject(receiver, objectId, DISABLED_FINALITY);
		const enabledHarness = harness(receiver, [enabled]);
		const disabledHarness = harness(receiver, [disabled]);
		const accept = syncAcceptMessage(author.peerId, objectId, history);

		await handleMessage(enabledHarness.node, accept);
		expect(enabled.finalityStore.states.size).toBe(history.length);

		const blsSigns = vi.spyOn(receiver.keychain, "signWithBls");
		const verifies = vi.spyOn(bls, "verify");
		const aggregateVerifies = vi.spyOn(bls, "verifyAggregate");
		await handleMessage(disabledHarness.node, accept);

		expect.soft(disabled.finalityStore.states.size).toBe(0);
		expect.soft(blsSigns).toHaveBeenCalledTimes(0);
		expect.soft(verifies).toHaveBeenCalledTimes(0);
		expect.soft(aggregateVerifies).toHaveBeenCalledTimes(0);
		expect.soft(messagesOfType(disabledHarness.result, MessageType.MESSAGE_TYPE_ATTESTATION_UPDATE)).toHaveLength(0);
		expect(disabledHarness.result.puts).toEqual([objectId]);
		expect(
			disabledHarness.result.dispatches.filter(({ type }) => type === NodeEventName.DRP_SYNC_ACCEPTED)
		).toHaveLength(1);
		expect(stateDigest(disabled)).toBe(stateDigest(enabled));

		await handleMessage(
			disabledHarness.node,
			Message.create({
				sender: author.peerId,
				type: MessageType.MESSAGE_TYPE_SYNC,
				objectId,
				data: Sync.encode(Sync.create({ vertexHashes: [] })).finish(),
			})
		);
		const syncResponses = disabledHarness.result.direct.filter(
			({ message }) => message.type === MessageType.MESSAGE_TYPE_SYNC_ACCEPT
		);
		expect(syncResponses).toHaveLength(1);
		const response = SyncAccept.decode(syncResponses[0].message.data);
		expect(response.requested.map(({ hash }) => hash)).toEqual(disabled.vertices.map(({ hash }) => hash));
		expect.soft(response.attestations).toEqual([]);
		expect(disabledHarness.result.dispatches.filter(({ type }) => type === NodeEventName.DRP_SYNC)).toHaveLength(1);
	});

	test("disabled ATTESTATION_UPDATE leaves a defensive pre-existing record byte-for-byte unchanged and performs no verification", async () => {
		const [author, receiver] = signers;
		const objectId = "phase-1c-disabled-residual-single";
		const source = roomObject(author, objectId);
		const sourceHarness = harness(author, [source]);
		const [vertex] = appendHistory(source, 1, 60);
		await signGeneratedVertices(sourceHarness.node, [vertex]);
		const [attestation] = signFinalityVertices(sourceHarness.node, source, [vertex]);
		const donor = roomObject(receiver, objectId);
		const disabled = roomObject(receiver, objectId, DISABLED_FINALITY);
		await donor.applyVertices([vertex]);
		await disabled.applyVertices([vertex]);
		const residual = donor.finalityStore.states.get(vertex.hash);
		if (!residual) throw new Error("Expected an authenticated donor finality record");
		disabled.finalityStore.states.set(vertex.hash, residual);
		const before = {
			bits: residual.aggregation_bits.toBytes(),
			count: residual.numberOfSignatures,
			signature: residual.signature,
		};
		const disabledHarness = harness(receiver, [disabled]);
		const verifies = vi.spyOn(bls, "verify");

		await handleMessage(
			disabledHarness.node,
			Message.create({
				sender: author.peerId,
				type: MessageType.MESSAGE_TYPE_ATTESTATION_UPDATE,
				objectId,
				data: AttestationUpdate.encode(AttestationUpdate.create({ attestations: [attestation] })).finish(),
			})
		);

		expect.soft(verifies).toHaveBeenCalledTimes(0);
		expect.soft(residual.numberOfSignatures).toBe(before.count);
		expect.soft(residual.aggregation_bits.toBytes()).toEqual(before.bits);
		expect.soft(residual.signature).toBe(before.signature);
		expect
			.soft(disabledHarness.result.dispatches.filter(({ type }) => type === NodeEventName.DRP_ATTESTATION_UPDATE))
			.toHaveLength(0);
	});

	test("disabled SYNC_ACCEPT neither verifies nor merges a defensive pre-existing aggregate record", async () => {
		const [author, receiver] = signers;
		const objectId = "phase-1c-disabled-residual-aggregate";
		const source = roomObject(author, objectId);
		const sourceHarness = harness(author, [source]);
		const [vertex] = appendHistory(source, 1, 70);
		await signGeneratedVertices(sourceHarness.node, [vertex]);
		signFinalityVertices(sourceHarness.node, source, [vertex]);
		const aggregate = source.finalityStore.getAttestation(vertex.hash);
		if (!aggregate) throw new Error("Expected a source aggregate attestation");
		const donor = roomObject(receiver, objectId);
		const disabled = roomObject(receiver, objectId, DISABLED_FINALITY);
		await donor.applyVertices([vertex]);
		await disabled.applyVertices([vertex]);
		const residual = donor.finalityStore.states.get(vertex.hash);
		if (!residual) throw new Error("Expected an authenticated donor finality record");
		disabled.finalityStore.states.set(vertex.hash, residual);
		const disabledHarness = harness(receiver, [disabled]);
		const blsSigns = vi.spyOn(receiver.keychain, "signWithBls");
		const aggregateVerifies = vi.spyOn(bls, "verifyAggregate");

		await handleMessage(disabledHarness.node, syncAcceptMessage(author.peerId, objectId, [vertex], [aggregate]));

		expect.soft(aggregateVerifies).toHaveBeenCalledTimes(0);
		expect.soft(blsSigns).toHaveBeenCalledTimes(0);
		expect.soft(residual.numberOfSignatures).toBe(0);
		expect.soft(residual.signature).toBeUndefined();
		expect.soft(messagesOfType(disabledHarness.result, MessageType.MESSAGE_TYPE_ATTESTATION_UPDATE)).toHaveLength(0);
		expect(disabledHarness.result.puts).toEqual([objectId]);
		expect(
			disabledHarness.result.dispatches.filter(({ type }) => type === NodeEventName.DRP_SYNC_ACCEPTED)
		).toHaveLength(0);
	});
});
