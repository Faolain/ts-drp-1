import {
	type DrpCapability,
	type RecordSigner,
	type SignedDrpRecordV1,
	type UnsignedDrpRecordV1,
} from "@ts-drp/rendezvous";
import { describe, expect, it, vi } from "vitest";

import { address, fixtureSigner, NAMESPACE, NOW } from "./fixtures.js";

interface SequenceStore {
	load(): Promise<number>;
	save(next: number): Promise<void>;
}

interface RecordProducer {
	current(): Promise<SignedDrpRecordV1>;
	refresh(): Promise<SignedDrpRecordV1>;
}

interface RecordProducerOptions {
	addressSource(): readonly string[];
	capabilitySource(): readonly DrpCapability[];
	clock?(): number;
	namespace: string;
	peerId: string;
	sequenceStore: SequenceStore;
	signer: Pick<RecordSigner, "sign">;
	ttlMs: number;
}

interface PhaseFourProducerModule {
	InMemorySequenceStore: new (initialSequence?: number) => SequenceStore;
	createRecordProducer(options: RecordProducerOptions): RecordProducer;
}

describe("Phase 4a live signed-record production", () => {
	it("loads persisted state once and never signs at or below the loaded sequence", async () => {
		const phaseFour = await loadProducerModule();
		if (phaseFour === undefined) return;
		const { peerId, signer } = await fixtureSigner(201);
		const sign = vi.spyOn(signer, "sign");
		const sequenceStore: SequenceStore = {
			load: vi.fn(() => Promise.resolve(41)),
			save: vi.fn(() => Promise.resolve()),
		};
		const producer = phaseFour.createRecordProducer(
			options({ peerId, sequenceStore, signer, addresses: [address(peerId, 4201)] })
		);

		const current = await producer.current();
		expect(current.sequence).toBe(42);
		expect(sequenceStore.load).toHaveBeenCalledOnce();
		expect(sequenceStore.save).toHaveBeenCalledWith(42);
		expect(sign.mock.calls.map(([input]) => input.sequence)).toEqual([42]);
		expect(await producer.current()).toBe(current);
		expect(sign).toHaveBeenCalledOnce();
	});

	it("refresh re-reads live addresses and capabilities and yields strictly increasing sequences", async () => {
		const phaseFour = await loadProducerModule();
		if (phaseFour === undefined) return;
		const { peerId, signer } = await fixtureSigner(202);
		const sequenceStore = new phaseFour.InMemorySequenceStore(7);
		let addresses = [address(peerId, 4202)];
		let capabilities: DrpCapability[] = ["drp-gossipsub"];
		let now = NOW;
		const producer = phaseFour.createRecordProducer({
			addressSource: () => addresses,
			capabilitySource: () => capabilities,
			clock: () => now,
			namespace: NAMESPACE,
			peerId,
			sequenceStore,
			signer,
			ttlMs: 60_000,
		});

		const first = await producer.refresh();
		addresses = [address(peerId, 4302)];
		capabilities = ["drp-gossipsub", "webrtc", "relay-client"];
		now += 1_000;
		const second = await producer.refresh();

		expect([first.sequence, second.sequence]).toEqual([8, 9]);
		expect(second).toMatchObject({
			addresses,
			capabilities: [...capabilities].sort(),
			expiresAtMs: now + 60_000,
			issuedAtMs: now,
			peerId,
		});
	});

	it("serializes concurrent refreshes so the in-memory store cannot sign duplicate sequences", async () => {
		const phaseFour = await loadProducerModule();
		if (phaseFour === undefined) return;
		const { peerId, signer } = await fixtureSigner(203);
		const producer = phaseFour.createRecordProducer(
			options({
				peerId,
				sequenceStore: new phaseFour.InMemorySequenceStore(),
				signer,
				addresses: [address(peerId, 4203)],
			})
		);

		const records = await Promise.all([producer.refresh(), producer.refresh()]);
		expect(records.map(({ sequence }) => sequence).sort((left, right) => left - right)).toEqual([1, 2]);
	});

	it("reloads a shared store after losing an atomic save race instead of wedging", async () => {
		const phaseFour = await loadProducerModule();
		if (phaseFour === undefined) return;
		const { peerId, signer } = await fixtureSigner(205);
		let storedSequence = 0;
		const sequenceStore: SequenceStore = {
			load: () => Promise.resolve(storedSequence),
			save: (next) => {
				if (next <= storedSequence) return Promise.reject(new Error("non-monotonic sequence"));
				storedSequence = next;
				return Promise.resolve();
			},
		};
		const producers = [
			phaseFour.createRecordProducer(options({ peerId, sequenceStore, signer, addresses: [address(peerId, 4205)] })),
			phaseFour.createRecordProducer(options({ peerId, sequenceStore, signer, addresses: [address(peerId, 4205)] })),
		] as const;

		const raced = await Promise.allSettled(producers.map((producer) => producer.refresh()));
		expect(raced.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
		expect(raced.filter(({ status }) => status === "rejected")).toHaveLength(1);
		const loser = producers[raced.findIndex(({ status }) => status === "rejected")];
		if (loser === undefined) throw new Error("race fixture did not produce a loser");

		await expect(loser.refresh()).resolves.toMatchObject({ sequence: 2 });
		expect(storedSequence).toBe(2);
	});

	it.each([9_999, 300_001])("rejects ttlMs=%i outside signed-record TTL bounds", async (ttlMs) => {
		const phaseFour = await loadProducerModule();
		if (phaseFour === undefined) return;
		const { peerId, signer } = await fixtureSigner(204);

		expect(() =>
			phaseFour.createRecordProducer({
				...options({ peerId, sequenceStore: new phaseFour.InMemorySequenceStore(), signer }),
				ttlMs,
			})
		).toThrow(/ttl|10_?000|300_?000/iu);
	});
});

async function loadProducerModule(): Promise<PhaseFourProducerModule | undefined> {
	const loaded = (await import("@ts-drp/rendezvous")) as unknown as Partial<PhaseFourProducerModule>;
	expect(loaded.createRecordProducer, "Phase 4a must export createRecordProducer").toBeTypeOf("function");
	expect(loaded.InMemorySequenceStore, "Phase 4a must export the in-memory SequenceStore").toBeTypeOf("function");
	if (loaded.createRecordProducer === undefined || loaded.InMemorySequenceStore === undefined) return undefined;
	return loaded as PhaseFourProducerModule;
}

function options(input: {
	addresses?: readonly string[];
	peerId: string;
	sequenceStore: SequenceStore;
	signer: Pick<RecordSigner, "sign">;
}): RecordProducerOptions {
	return {
		addressSource: () => input.addresses ?? [address(input.peerId, 4200)],
		capabilitySource: () => ["drp-gossipsub"],
		clock: () => NOW,
		namespace: NAMESPACE,
		peerId: input.peerId,
		sequenceStore: input.sequenceStore,
		signer: input.signer,
		ttlMs: 60_000,
	};
}

type _SignerInputContract = UnsignedDrpRecordV1;
const _signerInputContract: _SignerInputContract | undefined = undefined;
void _signerInputContract;
