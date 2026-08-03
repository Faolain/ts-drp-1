/* eslint-disable @typescript-eslint/no-non-null-assertion -- committed vertices and stored snapshots are narrowed by positive controls */
import { DRPStateOtherTheWire, DrpType, type IDRP, Operation, SemanticsType, type Vertex } from "@ts-drp/types";
import { computeHash } from "@ts-drp/utils/hash";
import { serializeDRPState, serializeValue } from "@ts-drp/utils/serialization";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { DRPVertexApplier } from "../src/drp-applier.js";
import { FinalityStore } from "../src/finality/index.js";
import { HashGraph } from "../src/hashgraph/index.js";
import { trackMutations } from "../src/proxy.js";
import { type PublicationObserverEvent, type PublicationRecord } from "../src/publication/publisher.js";
import { detachStatePayload } from "../src/state-payload.js";
import { DRPObjectStateManager, stateFromDRP } from "../src/state.js";

interface DetachmentWorkEvent {
	type: "state-payload-detachment";
	counters: {
		typedArrayViewsDetached: number;
		typedArrayCanonicalIndexEnumerations: number;
		typedArrayElementsRecursivelyDetached: number;
		backingStoresCopied: number;
		backingBytesCopied: number;
	};
}

interface Captured<T> {
	ok: boolean;
	value?: T;
	error?: unknown;
}

type StructuralTransferMethod = "transfer" | "transferToFixedLength";

const GOVERNED_BUFFER_TRANSFER_ERROR = "Cannot structurally mutate an ArrayBuffer backing a governed Buffer";
const structuralTransferMethods = (["transfer", "transferToFixedLength"] as const).filter(
	(method): method is StructuralTransferMethod => typeof Reflect.get(ArrayBuffer.prototype, method) === "function"
);
const representativeStructuralTransferMethod = structuralTransferMethods[0];

function capture<T>(run: () => T): Captured<T> {
	try {
		return { ok: true, value: run() };
	} catch (error) {
		return { ok: false, error };
	}
}

async function captureAsync<T>(run: () => T | Promise<T>): Promise<Captured<T>> {
	try {
		return { ok: true, value: await run() };
	} catch (error) {
		return { ok: false, error };
	}
}

function transferBacking(backing: ArrayBuffer, method: StructuralTransferMethod): ArrayBuffer {
	const transfer = Reflect.get(backing, method) as (newByteLength?: number) => ArrayBuffer;
	return Reflect.apply(transfer, backing, []);
}

function dedicatedBuffer(bytes: readonly number[] = [1, 2, 3, 4]): { backing: ArrayBuffer; buffer: Buffer } {
	const backing = new ArrayBuffer(bytes.length);
	const buffer = Buffer.from(backing);
	buffer.set(bytes);
	return { backing, buffer };
}

function bytesByKey(value: object): Map<string, Uint8Array> {
	return new Map(
		stateFromDRP(value as IDRP).state.map(({ key, value: entry }) => [key, Uint8Array.from(serializeValue(entry))])
	);
}

function byteDeltaKeys(before: ReadonlyMap<string, Uint8Array>, value: object): string[] {
	const after = bytesByKey(value);
	return [...new Set([...before.keys(), ...after.keys()])]
		.filter((key) => {
			const left = before.get(key);
			const right = after.get(key);
			return (
				left === undefined ||
				right === undefined ||
				left.byteLength !== right.byteLength ||
				left.some((byte, index) => byte !== right[index])
			);
		})
		.sort();
}

function encodedState(value: IDRP): Uint8Array {
	return DRPStateOtherTheWire.encode(serializeDRPState(stateFromDRP(value))).finish();
}

function expectViewAliases(value: ViewGraph, label: string): void {
	expect.soft(value.alias, `${label}: repeated view identity`).toBe(value.primary);
	expect
		.soft(
			new Set([value.backing, value.primary.buffer, value.overlap.buffer, value.data.buffer]),
			`${label}: one backing`
		)
		.toHaveLength(1);
	expect
		.soft(
			[
				[value.primary.byteOffset, value.primary.length],
				[value.overlap.byteOffset, value.overlap.length],
				[value.data.byteOffset, value.data.byteLength],
			],
			`${label}: subview layout`
		)
		.toEqual([
			[2, 8],
			[5, 4],
			[5, 4],
		]);
}

interface ViewGraph {
	backing: ArrayBuffer;
	primary: Uint8Array;
	alias: Uint8Array;
	overlap: Int8Array;
	data: DataView;
}

function viewGraph(): ViewGraph {
	const backing = new ArrayBuffer(16);
	const primary = new Uint8Array(backing, 2, 8);
	new Uint8Array(backing).set(Array.from({ length: 16 }, (_, index) => index + 10));
	return {
		backing,
		primary,
		alias: primary,
		overlap: new Int8Array(backing, 5, 4),
		data: new DataView(backing, 5, 4),
	};
}

class TypedArrayFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context = { caller: "", scratch: new Uint8Array([1, 2, 3]) };
	payload = viewGraph();
	untouched = { marker: "stable" };

	numericWrite(value: number): void {
		this.payload.primary[3] = value;
	}

	bulkSubviewWrite(value: number): void {
		this.payload.primary.subarray(3, 5).set([value, value + 1]);
	}
}

class BufferBackingFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context = { caller: "" };
	buffer: Buffer;
	untouched = { marker: "stable" };

	constructor() {
		this.buffer = dedicatedBuffer([11, 12, 13, 14]).buffer;
	}

	transferBacking(method: StructuralTransferMethod): void {
		transferBacking(this.buffer.buffer, method);
	}
}

class PublicationProbe {
	readonly publications: PublicationRecord[] = [];

	observe(event: PublicationObserverEvent): unknown {
		if (event.type === "copy") return detachStatePayload(event.value);
		this.publications.push(event.record);
	}
}

interface Harness {
	rawDRP: TypedArrayFixture;
	applier: DRPVertexApplier<TypedArrayFixture>;
	hashGraph: HashGraph;
	probe: PublicationProbe;
	states: DRPObjectStateManager<TypedArrayFixture>;
}

function harness(peerId: "local" | "remote"): Harness {
	const rawDRP = new TypedArrayFixture();
	const rawACL = createACL({ admins: ["local", "remote"] });
	const hashGraph = new HashGraph(peerId, rawACL.resolveConflicts?.bind(rawACL), undefined, rawDRP.semanticsType);
	const states = new DRPObjectStateManager(rawACL, rawDRP);
	const probe = new PublicationProbe();
	const options = {
		drp: rawDRP,
		acl: rawACL,
		hashGraph,
		states,
		finalityStore: new FinalityStore(),
		notify: (): void => {},
		publicationObserver: probe.observe.bind(probe),
	};
	const Applier = DRPVertexApplier as unknown as new (candidate: typeof options) => DRPVertexApplier<TypedArrayFixture>;
	return { rawDRP, applier: new Applier(options), hashGraph, probe, states };
}

function bufferHarness(): {
	rawDRP: BufferBackingFixture;
	applier: DRPVertexApplier<BufferBackingFixture>;
	hashGraph: HashGraph;
	probe: PublicationProbe;
	states: DRPObjectStateManager<BufferBackingFixture>;
} {
	const rawDRP = new BufferBackingFixture();
	const rawACL = createACL({ admins: ["local"] });
	const hashGraph = new HashGraph("local", rawACL.resolveConflicts?.bind(rawACL), undefined, rawDRP.semanticsType);
	const states = new DRPObjectStateManager(rawACL, rawDRP);
	const probe = new PublicationProbe();
	const options = {
		drp: rawDRP,
		acl: rawACL,
		hashGraph,
		states,
		finalityStore: new FinalityStore(),
		notify: (): void => {},
		publicationObserver: probe.observe.bind(probe),
	};
	const Applier = DRPVertexApplier as unknown as new (
		candidate: typeof options
	) => DRPVertexApplier<BufferBackingFixture>;
	return { rawDRP, applier: new Applier(options), hashGraph, probe, states };
}

function vertexFor(h: Harness, opType: string): Vertex {
	const vertex = h.hashGraph.getAllVertices().find((candidate) => candidate.operation?.opType === opType);
	expect(vertex, `positive control: ${opType} must commit`).toBeDefined();
	return vertex!;
}

function remoteVertex(opType: string, value: unknown[]): Vertex {
	const operation = Operation.create({ drpType: DrpType.DRP, opType, value });
	return {
		hash: computeHash("remote", operation, [HashGraph.rootHash], 1),
		peerId: "remote",
		dependencies: [HashGraph.rootHash],
		operation,
		timestamp: 1,
		signature: new Uint8Array(),
	};
}

function expectPublicationTruth(h: Harness, vertex: Vertex, expectedKeys: readonly string[]): void {
	const publication = h.probe.publications.find(
		(candidate) =>
			candidate.kind === "vertex" && candidate.targetHash === vertex.hash && candidate.outcome === "published"
	);
	expect(publication, "positive control: the mutation must publish").toBeDefined();
	expect.soft(publication).toMatchObject({ mode: "incremental", changed: { acl: [], drp: expectedKeys } });
	const stored = h.states.getDRPState(vertex.hash)!;
	expect
		.soft(DRPStateOtherTheWire.encode(serializeDRPState(stored)).finish(), "stored bytes must match the live state")
		.toEqual(encodedState(h.rawDRP));
	const storedPayload = stored.state.find(({ key }) => key === "payload")!.value as ViewGraph;
	expectViewAliases(storedPayload, "stored snapshot");
	const [reconstructed] = h.states.fromHash(vertex.hash);
	expect.soft(encodedState(reconstructed!), "reconstruction must match the live state").toEqual(encodedState(h.rawDRP));
	expectViewAliases(reconstructed!.payload, "reconstruction");
}

describe("Phase 1d(i) D.92.3-P3b native receiver boundary", () => {
	it("keeps TypedArray metadata, backing identity, iteration and derived subviews available", () => {
		const state = new TypedArrayFixture();
		const tracked = trackMutations(state);
		const nativeSubview = state.payload.primary.subarray(1, 4);
		const native = {
			metadata: [state.payload.primary.length, state.payload.primary.byteLength, state.payload.primary.byteOffset],
			bufferIdentity: state.payload.primary.buffer === state.payload.backing,
			iteration: [...state.payload.primary],
			subarray: [...nativeSubview],
			subarraySharesBacking: nativeSubview.buffer === state.payload.backing,
		};

		expect(native).toEqual({
			metadata: [8, 8, 2],
			bufferIdentity: true,
			iteration: [12, 13, 14, 15, 16, 17, 18, 19],
			subarray: [13, 14, 15],
			subarraySharesBacking: true,
		});
		expect
			.soft(
				capture(() => [
					tracked.proxy.payload.primary.length,
					tracked.proxy.payload.primary.byteLength,
					tracked.proxy.payload.primary.byteOffset,
				])
			)
			.toEqual({
				ok: true,
				value: native.metadata,
			});
		expect.soft(capture(() => tracked.proxy.payload.primary.buffer === tracked.proxy.payload.backing)).toEqual({
			ok: true,
			value: true,
		});
		expect.soft(capture(() => [...tracked.proxy.payload.primary])).toEqual({ ok: true, value: native.iteration });
		expect
			.soft(
				capture(() => {
					const subarray = tracked.proxy.payload.primary.subarray(1, 4);
					return { bytes: [...subarray], sharesBacking: subarray.buffer === tracked.proxy.payload.backing };
				})
			)
			.toEqual({ ok: true, value: { bytes: native.subarray, sharesBacking: native.subarraySharesBacking } });
		expect.soft(tracked.hasChanges(), "read-only receiver-safe work remains clean").toBe(false);
	});

	it("keeps DataView, Node Buffer and BigInt TypedArray operations receiver-safe and exactly attributed", () => {
		const backing = new ArrayBuffer(8);
		const state = {
			data: new DataView(backing),
			buffer: Buffer.from([1, 2, 3]),
			bigints: new BigInt64Array([BigInt(1), BigInt(2)]),
			untouched: { marker: "stable" },
		};
		const before = bytesByKey(state);
		const tracked = trackMutations(state);

		expect
			.soft(
				capture(() => {
					tracked.proxy.data.setUint8(0, 9);
					return [tracked.proxy.data.byteLength, tracked.proxy.data.getUint8(0)];
				})
			)
			.toEqual({ ok: true, value: [8, 9] });
		expect
			.soft(
				capture(() => {
					tracked.proxy.buffer.fill(7, 1);
					return [tracked.proxy.buffer.length, ...tracked.proxy.buffer];
				})
			)
			.toEqual({ ok: true, value: [3, 1, 7, 7] });
		expect
			.soft(
				capture(() => {
					tracked.proxy.bigints.set([BigInt(5)], 1);
					return [...tracked.proxy.bigints];
				})
			)
			.toEqual({ ok: true, value: [BigInt(1), BigInt(5)] });
		expect.soft([...tracked.changedKeys()].sort()).toEqual(byteDeltaKeys(before, state));
		expect.soft([...tracked.changedKeys()].sort()).toEqual(["bigints", "buffer", "data"]);
	});

	it("allows replica-local TypedArray methods without charging governed state", () => {
		const state = new TypedArrayFixture();
		const tracked = trackMutations(state);

		expect(
			capture(() => {
				tracked.proxy.context.scratch.set([8, 9], 1);
				return [...tracked.proxy.context.scratch];
			})
		).toEqual({ ok: true, value: [1, 8, 9] });
		expect(tracked.hasChanges()).toBe(false);
		expect([...tracked.changedKeys()]).toEqual([]);
	});
});

describe("Phase 1d(i) D.92.3-P3b mutation attribution and publication", () => {
	it("attributes a receiver-independent numeric write to the exact governed owner of the shared backing graph", () => {
		const state = { payload: viewGraph(), untouched: { marker: "stable" } };
		const before = bytesByKey(state);
		const tracked = trackMutations(state);

		tracked.proxy.payload.primary[3] = 91;

		const groundTruth = byteDeltaKeys(before, state);
		expect.soft(state.payload.alias[3]).toBe(91);
		expect.soft(state.payload.overlap[0]).toBe(91);
		expect.soft(state.payload.data.getUint8(0)).toBe(91);
		expect.soft(groundTruth).toEqual(["payload"]);
		expect([...tracked.changedKeys()].sort()).toEqual(groundTruth);
	});

	it("publishes and reconstructs the complete numeric-write byte delta on local authoring", () => {
		const h = harness("local");
		const before = bytesByKey(h.rawDRP);

		h.applier.drp!.numericWrite(92);

		const vertex = vertexFor(h, "numericWrite");
		const groundTruth = byteDeltaKeys(before, h.rawDRP);
		expect(groundTruth).toEqual(["payload"]);
		expectPublicationTruth(h, vertex, groundTruth);
	});

	it("publishes a derived-subview bulk mutation with its shared backing aliases intact", () => {
		const h = harness("local");
		const before = bytesByKey(h.rawDRP);

		expect(capture(() => h.applier.drp!.bulkSubviewWrite(93))).toMatchObject({ ok: true });
		expect.soft(h.rawDRP.payload.alias[3]).toBe(93);
		expect.soft(h.rawDRP.payload.overlap[0]).toBe(93);
		expect.soft(h.rawDRP.payload.data.getUint8(0)).toBe(93);

		const vertex = vertexFor(h, "bulkSubviewWrite");
		const groundTruth = byteDeltaKeys(before, h.rawDRP);
		expect(groundTruth).toEqual(["payload"]);
		expectPublicationTruth(h, vertex, groundTruth);
	});

	it("stores a byte-exact reconstruction for numeric mutation at an exact remote cut", async () => {
		const h = harness("remote");
		const before = bytesByKey(h.rawDRP);
		const vertex = remoteVertex("numericWrite", [94]);

		await expect(h.applier.applyVertices([vertex])).resolves.toEqual({ applied: true, missing: [], invalid: [] });

		const groundTruth = byteDeltaKeys(before, h.rawDRP);
		expect(groundTruth).toEqual(["payload"]);
		expectPublicationTruth(h, vertex, groundTruth);
	});
});

describe("Phase 1d(i) D.92.3-P3b governed Buffer backing transfer", () => {
	it("keeps ordinary backing reads available, extensible and clean", () => {
		const { backing, buffer } = dedicatedBuffer();
		const tracked = trackMutations({ buffer, untouched: { marker: "stable" } });

		const exposed = tracked.proxy.buffer.buffer;

		expect.soft(exposed).toBe(tracked.proxy.buffer.buffer);
		expect.soft(exposed.byteLength).toBe(4);
		expect.soft(Object.isExtensible(exposed)).toBe(true);
		expect.soft(buffer.buffer).toBe(backing);
		expect.soft([...buffer]).toEqual([1, 2, 3, 4]);
		expect.soft(tracked.hasChanges()).toBe(false);
		expect([...tracked.changedKeys()]).toEqual([]);
	});

	it.each(structuralTransferMethods)("rejects %s atomically before it can detach governed Buffer bytes", (method) => {
		const { backing, buffer } = dedicatedBuffer();
		const bufferBytes = [...buffer];
		const backingBytes = [...new Uint8Array(backing)];
		const tracked = trackMutations({ buffer, untouched: { marker: "stable" } });
		const bufferExtensible = Object.isExtensible(buffer);
		const backingExtensible = Object.isExtensible(backing);

		const result = capture(() => transferBacking(tracked.proxy.buffer.buffer, method));

		expect.soft(result.ok, "structural backing mutation must reject").toBe(false);
		expect.soft(result.error).toBeInstanceOf(TypeError);
		expect.soft((result.error as Error | undefined)?.message).toBe(GOVERNED_BUFFER_TRANSFER_ERROR);
		expect.soft(buffer.buffer === backing, "Buffer/backing identity must survive rejection").toBe(true);
		expect.soft(capture(() => [...buffer])).toEqual({ ok: true, value: bufferBytes });
		expect.soft(capture(() => [...new Uint8Array(backing)])).toEqual({ ok: true, value: backingBytes });
		expect.soft(Object.isExtensible(buffer)).toBe(bufferExtensible);
		expect.soft(Object.isExtensible(backing)).toBe(backingExtensible);
		expect.soft(tracked.hasChanges(), "rejection must not dirty governed state").toBe(false);
		expect([...tracked.changedKeys()]).toEqual([]);
	});

	it.skipIf(representativeStructuralTransferMethod === undefined)(
		"keeps native transfer available and exactly attributed for a bare governed ArrayBuffer",
		() => {
			const backing = new ArrayBuffer(4);
			new Uint8Array(backing).set([5, 6, 7, 8]);
			const tracked = trackMutations({ backing, untouched: { marker: "stable" } });

			const result = capture(() => transferBacking(tracked.proxy.backing, representativeStructuralTransferMethod!));

			expect.soft(result.ok).toBe(true);
			expect.soft(result.value?.byteLength).toBe(4);
			expect.soft(backing.byteLength, "the governed source backing follows native transfer semantics").toBe(0);
			expect.soft(tracked.hasChanges()).toBe(true);
			expect([...tracked.changedKeys()]).toEqual(["backing"]);
		}
	);

	it.skipIf(representativeStructuralTransferMethod === undefined)(
		"rejects local authoring before detachment, vertex creation or publication",
		async () => {
			const h = bufferHarness();
			const backing = h.rawDRP.buffer.buffer;
			const liveBytes = [...h.rawDRP.buffer];
			const rootBefore = DRPStateOtherTheWire.encode(
				serializeDRPState(h.states.getDRPState(HashGraph.rootHash)!)
			).finish();

			const result = await captureAsync(() => h.applier.drp!.transferBacking(representativeStructuralTransferMethod!));

			expect.soft(result.ok).toBe(false);
			expect.soft(result.error).toBeInstanceOf(TypeError);
			expect.soft((result.error as Error | undefined)?.message).toBe(GOVERNED_BUFFER_TRANSFER_ERROR);
			expect.soft(h.rawDRP.buffer.buffer === backing).toBe(true);
			expect.soft(capture(() => [...h.rawDRP.buffer])).toEqual({ ok: true, value: liveBytes });
			expect.soft(capture(() => [...new Uint8Array(backing)])).toEqual({ ok: true, value: liveBytes });
			expect.soft(h.hashGraph.getAllVertices()).toHaveLength(1);
			expect.soft(h.probe.publications).toEqual([]);
			expect
				.soft(
					capture(() =>
						DRPStateOtherTheWire.encode(serializeDRPState(h.states.getDRPState(HashGraph.rootHash)!)).finish()
					),
					"stored root bytes must remain readable and unchanged"
				)
				.toEqual({ ok: true, value: rootBefore });
		}
	);
});

describe("Phase 1d(i) D.92.3-P3b P3a accounting firewall", () => {
	it("retains bulk backing copy, exact enumeration and zero recursive element detachment", () => {
		const backing = new ArrayBuffer(32);
		const source = {
			wide: new Uint8Array(backing, 4, 16),
			overlap: new Int8Array(backing, 8, 4),
			data: new DataView(backing, 10, 6),
		};
		const events: DetachmentWorkEvent[] = [];
		const detach = detachStatePayload as <T>(value: T, observer?: (event: DetachmentWorkEvent) => unknown) => T;
		const copy = detach(source, (event) => events.push(event));

		expect(new Set([copy.wide.buffer, copy.overlap.buffer, copy.data.buffer])).toHaveLength(1);
		expect(events).toEqual([
			{
				type: "state-payload-detachment",
				counters: {
					typedArrayViewsDetached: 2,
					typedArrayCanonicalIndexEnumerations: 2,
					typedArrayElementsRecursivelyDetached: 0,
					backingStoresCopied: 1,
					backingBytesCopied: 32,
				},
			},
		]);
	});
});
