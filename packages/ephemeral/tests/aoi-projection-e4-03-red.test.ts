import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const OWNER_PATH = "packages/ephemeral/src/aoi-projection.ts";
const PUBLIC_PATH = "packages/ephemeral/src/index.ts";
const ZONE_PATH = "examples/grid/src/v3-zone.ts";
const ownerExists = existsSync(OWNER_PATH);

interface Entity {
	readonly entityId: number;
	readonly sequence: number;
	readonly x: number;
	readonly y: number;
}

interface Sender {
	encode(input: Readonly<{ readonly entities: readonly Entity[]; readonly sequence: number }>): readonly Uint8Array[];
}

interface ReceiverSnapshot {
	readonly authorityGeneration: number;
	readonly baseKeyframeId: number | null;
	readonly baseKeyframeSequence: number | null;
	readonly entities: readonly Entity[];
	readonly generation: number | null;
	readonly lastSequence: number | null;
	readonly pendingAssemblies: number;
	readonly pendingBytes: number;
	readonly waitingForKeyframe: boolean;
}

interface Receiver {
	expire(nowMs: number): void;
	ingest(
		input: Readonly<{ readonly authorityGeneration: number; readonly bytes: Uint8Array; readonly receivedAtMs: number }>
	): boolean;
	resetAuthority(authorityGeneration: number): void;
	snapshot(): ReceiverSnapshot;
}

interface ProjectionModule {
	readonly AOI_PROJECTION_ASSEMBLY_LIFETIME_MS: number;
	readonly AOI_PROJECTION_HEADER_BYTES: number;
	readonly AOI_PROJECTION_KEYFRAME_INTERVAL: number;
	readonly AOI_PROJECTION_MAX_ASSEMBLIES: number;
	readonly AOI_PROJECTION_MAX_BUFFERED_BYTES: number;
	readonly AOI_PROJECTION_MAX_CHUNKS: number;
	readonly AOI_PROJECTION_RECORD_BYTES: number;
	readonly AOI_PROJECTION_VERSION: number;
	createAoiProjectionReceiver(input: Readonly<{ readonly authorityGeneration: number }>): Receiver;
	createAoiProjectionSender(input: Readonly<{ readonly generation: number; readonly maxPayloadBytes: number }>): Sender;
}

interface DecodedPacket {
	readonly baseKeyframeId: number;
	readonly baseKeyframeSequence: number;
	readonly batchId: number;
	readonly chunkCount: number;
	readonly chunkIndex: number;
	readonly generation: number;
	readonly kind: 1 | 2;
	readonly records: readonly Readonly<{ readonly entity: Entity; readonly operation: 1 | 2 }>[];
	readonly sequence: number;
}

async function loadModule(path: string): Promise<ProjectionModule> {
	return (await import(pathToFileURL(path).href)) as ProjectionModule;
}

function entity(entityId: number, sequence: number, x: number, y: number): Entity {
	return { entityId, sequence, x, y };
}

function u32(view: DataView, offset: number): number {
	return view.getUint32(offset, false);
}

function decodeExpected(bytes: Uint8Array): DecodedPacket {
	if (bytes.byteLength < 25) throw new TypeError("E403_EXPECTED_TRUNCATED_HEADER");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint8(0) !== 1) throw new TypeError("E403_EXPECTED_VERSION");
	const kind = view.getUint8(1);
	if (kind !== 1 && kind !== 2) throw new TypeError("E403_EXPECTED_KIND");
	const recordCount = view.getUint8(24);
	if (bytes.byteLength !== 25 + recordCount * 17) throw new TypeError("E403_EXPECTED_LENGTH");
	const records = Array.from({ length: recordCount }, (_, index) => {
		const offset = 25 + index * 17;
		const operation = view.getUint8(offset);
		if (operation !== 1 && operation !== 2) throw new TypeError("E403_EXPECTED_OPERATION");
		const x = view.getInt32(offset + 9, false);
		const y = view.getInt32(offset + 13, false);
		if (operation === 2 && (x !== 0 || y !== 0)) throw new TypeError("E403_EXPECTED_NONCANONICAL_LEAVE");
		return {
			entity: entity(u32(view, offset + 1), u32(view, offset + 5), x, y),
			operation,
		} as const;
	});
	return {
		baseKeyframeId: u32(view, 14),
		baseKeyframeSequence: u32(view, 18),
		batchId: u32(view, 6),
		chunkCount: view.getUint8(23),
		chunkIndex: view.getUint8(22),
		generation: u32(view, 2),
		kind,
		records,
		sequence: u32(view, 10),
	};
}

function receiveBatch(
	receiver: Receiver,
	packets: readonly Uint8Array[],
	authorityGeneration: number,
	receivedAtMs: number
): readonly boolean[] {
	return packets.map((bytes, index) =>
		receiver.ingest({ authorityGeneration, bytes, receivedAtMs: receivedAtMs + index })
	);
}

function mutate(bytes: Uint8Array, offset: number, value: number): Uint8Array {
	const copy = bytes.slice();
	copy[offset] = value;
	return copy;
}

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new TypeError(`E403_EXPECTED_${label}`);
	return value;
}

it("E4-03 RED exposes the missing loss-tolerant AOI projection owner", () => {
	expect(ownerExists).toBe(true);
});

describe.skipIf(!ownerExists)("E4-03 bounded loss-tolerant AOI projection", () => {
	it("publishes one owner with the frozen wire and resource contract", async () => {
		const owner = await loadModule(OWNER_PATH);
		const publicModule = await loadModule(PUBLIC_PATH);

		expect(publicModule.createAoiProjectionSender).toBe(owner.createAoiProjectionSender);
		expect(publicModule.createAoiProjectionReceiver).toBe(owner.createAoiProjectionReceiver);
		expect(owner).toMatchObject({
			AOI_PROJECTION_ASSEMBLY_LIFETIME_MS: 1_000,
			AOI_PROJECTION_HEADER_BYTES: 25,
			AOI_PROJECTION_KEYFRAME_INTERVAL: 30,
			AOI_PROJECTION_MAX_ASSEMBLIES: 4,
			AOI_PROJECTION_MAX_BUFFERED_BYTES: 32_768,
			AOI_PROJECTION_MAX_CHUNKS: 32,
			AOI_PROJECTION_RECORD_BYTES: 17,
			AOI_PROJECTION_VERSION: 1,
		});
	});

	it("encodes exact big-endian metadata and canonical fixed records", async () => {
		const { createAoiProjectionSender } = await loadModule(OWNER_PATH);
		const [bytes] = createAoiProjectionSender({ generation: 7, maxPayloadBytes: 256 }).encode({
			entities: [entity(0x0102_0304, 0x0506_0708, -2, 3)],
			sequence: 9,
		});
		const packet = required(bytes, "PACKET");
		expect([...packet]).toEqual([
			1, 1, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 9, 0, 1, 1, 1, 1, 2, 3, 4, 5, 6, 7, 8, 255, 255,
			255, 254, 0, 0, 0, 3,
		]);
		expect(decodeExpected(packet)).toMatchObject({
			baseKeyframeId: 0,
			baseKeyframeSequence: 9,
			batchId: 0,
			chunkCount: 1,
			chunkIndex: 0,
			generation: 7,
			kind: 1,
			sequence: 9,
		});
	});

	it("emits a complete keyframe at least every 30 batches and keeps deltas relative to the installed base", async () => {
		const { createAoiProjectionSender } = await loadModule(OWNER_PATH);
		const sender = createAoiProjectionSender({ generation: 3, maxPayloadBytes: 256 });
		const first = sender.encode({ entities: [entity(1, 0, 0, 0), entity(2, 0, 1, 0)], sequence: 0 });
		const delta = sender.encode({ entities: [entity(1, 1, 4, 0)], sequence: 1 });
		expect(first.map(decodeExpected)).toEqual([
			expect.objectContaining({
				baseKeyframeId: 0,
				baseKeyframeSequence: 0,
				batchId: 0,
				chunkCount: 1,
				chunkIndex: 0,
				generation: 3,
				kind: 1,
				sequence: 0,
			}),
		]);
		expect(delta.map(decodeExpected)).toEqual([
			expect.objectContaining({
				baseKeyframeId: 0,
				baseKeyframeSequence: 0,
				batchId: 1,
				chunkCount: 1,
				chunkIndex: 0,
				generation: 3,
				kind: 2,
				sequence: 1,
			}),
		]);
		expect(delta.flatMap((bytes) => decodeExpected(bytes).records)).toEqual([
			{ entity: entity(1, 1, 4, 0), operation: 1 },
			{ entity: entity(2, 0, 0, 0), operation: 2 },
		]);
		for (let sequence = 2; sequence < 30; sequence += 1) {
			expect(
				sender
					.encode({ entities: [entity(1, sequence, sequence, 0)], sequence })
					.map(decodeExpected)
					.every(({ kind }) => kind === 2)
			).toBe(true);
		}
		expect(sender.encode({ entities: [entity(1, 30, 30, 0)], sequence: 30 }).map(decodeExpected)).toEqual([
			expect.objectContaining({
				baseKeyframeId: 30,
				baseKeyframeSequence: 30,
				batchId: 30,
				chunkCount: 1,
				chunkIndex: 0,
				generation: 3,
				kind: 1,
				sequence: 30,
			}),
		]);
	});

	it("is permutation-deterministic, chunks below the caller route capacity, and detaches output", async () => {
		const { createAoiProjectionSender } = await loadModule(OWNER_PATH);
		const entities = Array.from({ length: 12 }, (_, index) => entity(12 - index, index, index, -index));
		const first = createAoiProjectionSender({ generation: 1, maxPayloadBytes: 76 }).encode({
			entities,
			sequence: 4,
		});
		const second = createAoiProjectionSender({ generation: 1, maxPayloadBytes: 76 }).encode({
			entities: [...entities].reverse(),
			sequence: 4,
		});
		expect(first).toEqual(second);
		expect(first.length).toBeGreaterThan(1);
		expect(first.every(({ byteLength }) => byteLength <= 76)).toBe(true);
		expect(first.map(decodeExpected)).toEqual(
			Array.from({ length: first.length }, (_, index) =>
				expect.objectContaining({
					baseKeyframeId: 0,
					baseKeyframeSequence: 4,
					batchId: 0,
					chunkCount: first.length,
					chunkIndex: index,
					generation: 1,
					kind: 1,
					sequence: 4,
				})
			)
		);
		const saved = first.map((bytes) => bytes.slice());
		(entities[0] as { x: number }).x = 999;
		expect(first).toEqual(saved);
	});

	it("applies only a complete consistent batch and loses no installed state on first, interior, or last chunk loss", async () => {
		const { createAoiProjectionReceiver, createAoiProjectionSender } = await loadModule(OWNER_PATH);
		const baseline = [entity(1, 0, 0, 0)];
		const sender = createAoiProjectionSender({ generation: 5, maxPayloadBytes: 59 });
		const initial = sender.encode({ entities: baseline, sequence: 0 });
		const update = sender.encode({
			entities: Array.from({ length: 6 }, (_, index) => entity(index + 1, 1, index, index)),
			sequence: 1,
		});
		expect(update.length).toBeGreaterThan(2);
		for (const missing of [0, Math.floor(update.length / 2), update.length - 1]) {
			const receiver = createAoiProjectionReceiver({ authorityGeneration: 11 });
			receiveBatch(receiver, initial, 11, 0);
			receiveBatch(receiver, update.filter((_packet, index) => index !== missing).reverse(), 11, 10);
			expect(receiver.snapshot().entities).toEqual(baseline);
			expect(receiver.snapshot().pendingAssemblies).toBe(1);
		}
		const receiver = createAoiProjectionReceiver({ authorityGeneration: 11 });
		receiveBatch(receiver, initial, 11, 0);
		expect(
			receiver.ingest({
				authorityGeneration: 11,
				bytes: required(update[0], "UPDATE_FIRST_CHUNK"),
				receivedAtMs: 10,
			})
		).toBe(false);
		const conflicting = mutate(required(update[1], "UPDATE_SECOND_CHUNK"), 17, 1);
		expect(receiver.ingest({ authorityGeneration: 11, bytes: conflicting, receivedAtMs: 11 })).toBe(false);
		expect(receiver.snapshot()).toMatchObject({ entities: baseline, pendingAssemblies: 0, waitingForKeyframe: true });
	});

	it("recovers deterministically after 30 percent loss and reordering on the next complete keyframe", async () => {
		const { createAoiProjectionReceiver, createAoiProjectionSender } = await loadModule(OWNER_PATH);
		const sender = createAoiProjectionSender({ generation: 8, maxPayloadBytes: 59 });
		const receiver = createAoiProjectionReceiver({ authorityGeneration: 21 });
		for (let sequence = 0; sequence < 30; sequence += 1) {
			const packets = sender.encode({
				entities: Array.from({ length: 6 }, (_, index) => entity(index + 1, sequence, sequence + index, index)),
				sequence,
			});
			const delivered = packets.filter((_packet, index) => (sequence * 7 + index * 3) % 10 >= 3).reverse();
			receiveBatch(receiver, delivered, 21, sequence * 33);
		}
		const finalEntities = Array.from({ length: 6 }, (_, index) => entity(index + 1, 30, 30 + index, index));
		const recovery = sender.encode({ entities: finalEntities, sequence: 30 });
		expect(receiveBatch(receiver, [...recovery].reverse(), 21, 1_000).at(-1)).toBe(true);
		expect(receiver.snapshot()).toMatchObject({
			entities: finalEntities,
			lastSequence: 30,
			pendingAssemblies: 0,
			waitingForKeyframe: false,
		});
	});

	it("fails closed on malformed, noncanonical, duplicate, stale, and mixed evidence without state mutation", async () => {
		const { createAoiProjectionReceiver, createAoiProjectionSender } = await loadModule(OWNER_PATH);
		const sender = createAoiProjectionSender({ generation: 1, maxPayloadBytes: 256 });
		const [valid] = sender.encode({ entities: [entity(1, 0, 0, 0)], sequence: 0 });
		const validPacket = required(valid, "VALID_PACKET");
		for (const hostile of [
			new Uint8Array(),
			validPacket.subarray(0, 24),
			mutate(validPacket, 0, 2),
			mutate(validPacket, 1, 0),
			mutate(validPacket, 22, 1),
			mutate(validPacket, 23, 0),
			mutate(validPacket, 24, 2),
		]) {
			const receiver = createAoiProjectionReceiver({ authorityGeneration: 9 });
			expect(receiver.ingest({ authorityGeneration: 9, bytes: hostile, receivedAtMs: 0 })).toBe(false);
			expect(receiver.snapshot().entities).toEqual([]);
		}
		const duplicate = new Uint8Array(25 + 34);
		duplicate.set(validPacket.subarray(0, 25));
		duplicate[24] = 2;
		duplicate.set(validPacket.subarray(25), 25);
		duplicate.set(validPacket.subarray(25), 42);
		const receiver = createAoiProjectionReceiver({ authorityGeneration: 9 });
		expect(receiver.ingest({ authorityGeneration: 9, bytes: duplicate, receivedAtMs: 0 })).toBe(false);
		expect(receiver.ingest({ authorityGeneration: 8, bytes: validPacket, receivedAtMs: 0 })).toBe(false);
		expect(receiver.snapshot().entities).toEqual([]);
	});

	it("rejects unsafe sender inputs, missing bases, and replay without advancing accepted projection", async () => {
		const { createAoiProjectionReceiver, createAoiProjectionSender } = await loadModule(OWNER_PATH);
		for (const input of [
			{ entities: [entity(-1, 0, 0, 0)], sequence: 0 },
			{ entities: [entity(1, 0.5, 0, 0)], sequence: 0 },
			{ entities: [entity(1, 0, 2_147_483_648, 0)], sequence: 0 },
			{ entities: [entity(1, 0, 0, 0), entity(1, 1, 1, 1)], sequence: 0 },
			{ entities: [entity(1, 0, 0, 0)], sequence: -1 },
		]) {
			expect(() => createAoiProjectionSender({ generation: 1, maxPayloadBytes: 256 }).encode(input)).toThrow();
		}
		expect(() => createAoiProjectionSender({ generation: -1, maxPayloadBytes: 256 })).toThrow();
		expect(() => createAoiProjectionSender({ generation: 1, maxPayloadBytes: 41 })).toThrow();

		const sender = createAoiProjectionSender({ generation: 4, maxPayloadBytes: 256 });
		const keyframe = sender.encode({ entities: [entity(1, 0, 0, 0)], sequence: 0 });
		const delta = sender.encode({ entities: [entity(1, 1, 1, 0)], sequence: 1 });
		const missingBase = createAoiProjectionReceiver({ authorityGeneration: 7 });
		expect(receiveBatch(missingBase, delta, 7, 0).every((accepted) => !accepted)).toBe(true);
		expect(missingBase.snapshot()).toMatchObject({ entities: [], waitingForKeyframe: true });

		const receiver = createAoiProjectionReceiver({ authorityGeneration: 7 });
		expect(receiveBatch(receiver, keyframe, 7, 0).at(-1)).toBe(true);
		expect(receiveBatch(receiver, delta, 7, 10).at(-1)).toBe(true);
		const accepted = receiver.snapshot();
		expect(receiveBatch(receiver, delta, 7, 20).every((result) => !result)).toBe(true);
		expect(receiveBatch(receiver, keyframe, 7, 30).every((result) => !result)).toBe(true);
		expect(receiver.snapshot()).toEqual(accepted);
	});

	it("pins the exact chunk, assembly, and buffered-byte resource boundaries", async () => {
		const { createAoiProjectionReceiver, createAoiProjectionSender } = await loadModule(OWNER_PATH);
		const exactly32 = createAoiProjectionSender({ generation: 1, maxPayloadBytes: 42 }).encode({
			entities: Array.from({ length: 32 }, (_, index) => entity(index, 0, index, 0)),
			sequence: 0,
		});
		expect(exactly32).toHaveLength(32);
		expect(exactly32.every((bytes) => decodeExpected(bytes).chunkCount === 32)).toBe(true);
		expect(() =>
			createAoiProjectionSender({ generation: 1, maxPayloadBytes: 42 }).encode({
				entities: Array.from({ length: 33 }, (_, index) => entity(index, 0, index, 0)),
				sequence: 0,
			})
		).toThrow();

		const receiver = createAoiProjectionReceiver({ authorityGeneration: 4 });
		const assemblySender = createAoiProjectionSender({ generation: 1, maxPayloadBytes: 59 });
		expect(
			receiveBatch(receiver, assemblySender.encode({ entities: [entity(1, 0, 0, 0)], sequence: 0 }), 4, 0).at(-1)
		).toBe(true);
		for (let sequence = 1; sequence <= 5; sequence += 1) {
			const packets = assemblySender.encode({
				entities: [
					entity(1, sequence, sequence, 0),
					entity(2, sequence, sequence + 1, 1),
					entity(3, sequence, sequence + 2, 2),
				],
				sequence,
			});
			expect(packets.length).toBeGreaterThan(1);
			const partial = required(packets[0], "PARTIAL_CHUNK");
			expect(receiver.ingest({ authorityGeneration: 4, bytes: partial, receivedAtMs: sequence })).toBe(false);
		}
		expect(receiver.snapshot().pendingAssemblies).toBe(4);

		const byteBoundReceiver = createAoiProjectionReceiver({ authorityGeneration: 4 });
		const byteBoundSender = createAoiProjectionSender({ generation: 10, maxPayloadBytes: 2_048 });
		const byteBoundBaseline = Array.from({ length: 596 }, (_value, index) => entity(index, 0, index, 0));
		expect(
			receiveBatch(byteBoundReceiver, byteBoundSender.encode({ entities: byteBoundBaseline, sequence: 0 }), 4, 0).at(-1)
		).toBe(true);
		const byteBoundBatches = Array.from({ length: 4 }, (_value, batchIndex) => {
			const sequence = batchIndex + 1;
			return byteBoundSender.encode({
				entities: Array.from({ length: 596 }, (_entry, index) => entity(index, sequence, index, sequence)),
				sequence,
			});
		});
		for (const packets of byteBoundBatches) {
			expect(packets).toHaveLength(6);
			for (const packet of packets.slice(0, 4)) {
				expect(byteBoundReceiver.ingest({ authorityGeneration: 4, bytes: packet, receivedAtMs: 0 })).toBe(false);
			}
		}
		expect(byteBoundReceiver.snapshot()).toMatchObject({ pendingAssemblies: 4, pendingBytes: 32_768 });
		expect(
			byteBoundReceiver.ingest({
				authorityGeneration: 4,
				bytes: required(byteBoundBatches[0]?.[4], "OVER_BUFFER_BOUNDARY_CHUNK"),
				receivedAtMs: 1,
			})
		).toBe(false);
		expect(byteBoundReceiver.snapshot()).toMatchObject({ pendingAssemblies: 4, pendingBytes: 32_768 });
		byteBoundReceiver.expire(999);
		expect(byteBoundReceiver.snapshot()).toMatchObject({ pendingAssemblies: 4, pendingBytes: 32_768 });
		byteBoundReceiver.expire(1_000);
		expect(byteBoundReceiver.snapshot()).toMatchObject({
			entities: byteBoundBaseline,
			pendingAssemblies: 0,
			pendingBytes: 0,
			waitingForKeyframe: true,
		});

		byteBoundReceiver.resetAuthority(5);
		expect(byteBoundReceiver.snapshot()).toMatchObject({
			authorityGeneration: 5,
			baseKeyframeId: null,
			entities: [],
			lastSequence: null,
			waitingForKeyframe: true,
		});

		receiver.expire(1_006);
		expect(receiver.snapshot()).toMatchObject({ pendingAssemblies: 0, pendingBytes: 0, waitingForKeyframe: true });
		receiver.resetAuthority(5);
		expect(receiver.snapshot()).toMatchObject({
			authorityGeneration: 5,
			baseKeyframeId: null,
			entities: [],
			lastSequence: null,
			waitingForKeyframe: true,
		});
	});

	it("detaches ingress and snapshots and composes through targeted raw-only zone publication", async () => {
		const { createAoiProjectionReceiver, createAoiProjectionSender } = await loadModule(OWNER_PATH);
		const [packet] = createAoiProjectionSender({ generation: 1, maxPayloadBytes: 256 }).encode({
			entities: [entity(1, 0, 4, 5)],
			sequence: 0,
		});
		const ownedPacket = required(packet, "OWNED_PACKET");
		const receiver = createAoiProjectionReceiver({ authorityGeneration: 1 });
		expect(receiver.ingest({ authorityGeneration: 1, bytes: ownedPacket, receivedAtMs: 0 })).toBe(true);
		ownedPacket.fill(0);
		const snapshot = receiver.snapshot();
		(snapshot.entities[0] as { x: number }).x = 999;
		expect(receiver.snapshot().entities).toEqual([entity(1, 0, 4, 5)]);

		const zone = readFileSync(ZONE_PATH, "utf8");
		expect(zone).toContain("createAoiProjectionSender");
		expect(zone).toContain("createAoiProjectionReceiver");
		expect(zone).toContain("maxEnvelopeBytes");
		expect(zone).toContain("ephemeral.publishTo(");
		expect(zone).toContain('class: "unreliable-unordered"');
		expect(zone).not.toContain("JSON.stringify");
		expect(zone).not.toContain("AOI_PROJECTION_ROUTE_BYTES = 1200");
	});
});
