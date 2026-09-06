/* eslint-disable @typescript-eslint/no-non-null-assertion -- host-gated methods and genesis state are established by the harness */
import { DRPStateOtherTheWire, type IDRP, SemanticsType } from "@ts-drp/types";
import { serializeDRPState } from "@ts-drp/utils/serialization";
import { describe, expect, it } from "vitest";

import { createACL } from "../src/acl/index.js";
import { DRPVertexApplier } from "../src/drp-applier.js";
import { FinalityStore } from "../src/finality/index.js";
import { HashGraph } from "../src/hashgraph/index.js";
import { trackMutations } from "../src/proxy.js";
import { type PublicationObserverEvent, type PublicationRecord } from "../src/publication/publisher.js";
import { detachStatePayload } from "../src/state-payload.js";
import { DRPObjectStateManager } from "../src/state.js";

interface Captured<T> {
	ok: boolean;
	value?: T;
	error?: unknown;
}

type StructuralMethod = (this: ArrayBuffer, newByteLength?: number) => unknown;

const GOVERNED_BUFFER_TRANSFER_ERROR = "Cannot structurally mutate an ArrayBuffer backing a governed Buffer";
const representativeTransfer = (["transfer", "transferToFixedLength"] as const).flatMap((method) => {
	const member = Reflect.get(ArrayBuffer.prototype, method) as StructuralMethod | undefined;
	return typeof member === "function" ? [{ member, method }] : [];
})[0];
const capturedResize = Reflect.get(ArrayBuffer.prototype, "resize") as StructuralMethod | undefined;

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

function dedicatedBuffer(
	bytes: readonly number[] = [11, 12, 13, 14],
	backing = new ArrayBuffer(bytes.length)
): { backing: ArrayBuffer; buffer: Buffer } {
	const buffer = Buffer.from(backing);
	buffer.set(bytes);
	return { backing, buffer };
}

function resizableBacking(byteLength: number, maxByteLength: number): ArrayBuffer {
	const ResizableArrayBuffer = ArrayBuffer as unknown as new (
		length: number,
		options: { maxByteLength: number }
	) => ArrayBuffer;
	return new ResizableArrayBuffer(byteLength, { maxByteLength });
}

function defineExposedGetter(
	exposedBacking: ArrayBuffer,
	property: PropertyKey,
	getter: (this: ArrayBuffer) => unknown
): void {
	const defined = Reflect.defineProperty(exposedBacking, property, {
		configurable: true,
		get: getter,
	});
	expect.soft(defined, "the accessor is installed through the exposed tracked backing").toBe(true);
	expect.soft(Reflect.getOwnPropertyDescriptor(exposedBacking, property)?.get).toBe(getter);
}

function invokeNativeThroughReceiver(receiver: ArrayBuffer, method: PropertyKey, ...args: number[]): unknown {
	const member = Reflect.get(receiver, method) as StructuralMethod;
	return Reflect.apply(member, receiver, args);
}

function expectIntact(
	backing: ArrayBuffer,
	buffer: Buffer,
	expectedBytes: readonly number[],
	expectedByteLength = expectedBytes.length
): void {
	expect.soft(backing.byteLength, "backing must not detach or resize").toBe(expectedByteLength);
	const expandedBytes =
		expectedByteLength === expectedBytes.length
			? expectedBytes
			: [...expectedBytes, ...Array(expectedByteLength - expectedBytes.length).fill(0)];
	expect.soft(capture(() => [...new Uint8Array(backing)])).toEqual({ ok: true, value: expandedBytes });
	expect.soft(capture(() => [...buffer])).toEqual({ ok: true, value: expandedBytes });
}

class AccessorFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context = { caller: "" };
	buffer: Buffer;
	untouched = { marker: "stable" };

	constructor() {
		this.buffer = dedicatedBuffer().buffer;
	}

	transferInGetter(): void {
		const exposedBacking = this.buffer.buffer;
		defineExposedGetter(exposedBacking, "structuralAccessor", function (this: ArrayBuffer): unknown {
			// Invalid length keeps the awaited applier oracle bounded while proving
			// that P3b policy rejection precedes native argument validation.
			return invokeNativeThroughReceiver(this, representativeTransfer!.method, -1);
		});
		Reflect.get(exposedBacking, "structuralAccessor");
	}
}

class PublicationProbe {
	readonly publications: PublicationRecord[] = [];

	observe(event: PublicationObserverEvent): unknown {
		if (event.type === "copy") return detachStatePayload(event.value);
		this.publications.push(event.record);
	}
}

function accessorHarness(): {
	rawDRP: AccessorFixture;
	applier: DRPVertexApplier<AccessorFixture>;
	hashGraph: HashGraph;
	probe: PublicationProbe;
	states: DRPObjectStateManager<AccessorFixture>;
} {
	const rawDRP = new AccessorFixture();
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
	const Applier = DRPVertexApplier as unknown as new (candidate: typeof options) => DRPVertexApplier<AccessorFixture>;
	return { rawDRP, applier: new Applier(options), hashGraph, probe, states };
}

describe("Phase 1d(i) D.92.3-P3b backing accessor receiver", () => {
	it.skipIf(representativeTransfer === undefined)(
		"rejects a direct transfer getter before it can detach governed Buffer storage",
		() => {
			const expectedBytes = [11, 12, 13, 14];
			const { backing, buffer } = dedicatedBuffer(expectedBytes);
			const tracked = trackMutations({ buffer, untouched: { marker: "stable" } });
			const exposedBacking = tracked.proxy.buffer.buffer;
			defineExposedGetter(exposedBacking, "directTransfer", function (this: ArrayBuffer): unknown {
				return invokeNativeThroughReceiver(this, representativeTransfer!.method);
			});
			expect.soft(tracked.hasChanges(), "installing an ignored-backing accessor remains clean").toBe(false);

			const result = capture(() => Reflect.get(exposedBacking, "directTransfer"));

			expect.soft(result.ok, "lookup-time structural mutation must reject").toBe(false);
			expect.soft(result.error).toBeInstanceOf(TypeError);
			expect.soft((result.error as Error | undefined)?.message).toBe(GOVERNED_BUFFER_TRANSFER_ERROR);
			expectIntact(backing, buffer, expectedBytes);
			expect.soft(tracked.hasChanges(), "rejection remains clean").toBe(false);
			expect([...tracked.changedKeys()]).toEqual([]);
		}
	);

	it.skipIf(representativeTransfer === undefined)(
		"does not let a getter-produced native bound to its lookup receiver detach governed bytes",
		() => {
			const expectedBytes = [21, 22, 23, 24];
			const { backing, buffer } = dedicatedBuffer(expectedBytes);
			const tracked = trackMutations({ buffer, untouched: { marker: "stable" } });
			const exposedBacking = tracked.proxy.buffer.buffer;
			defineExposedGetter(exposedBacking, "boundTransfer", function (this: ArrayBuffer): StructuralMethod {
				return representativeTransfer!.member.bind(this);
			});

			const boundTransfer = Reflect.get(exposedBacking, "boundTransfer") as StructuralMethod;
			const result = capture(() => Reflect.apply(boundTransfer, undefined, []));

			expect.soft(result.ok, "a getter-bound structural native must not run on raw storage").toBe(false);
			expect.soft(result.error).toBeInstanceOf(TypeError);
			expectIntact(backing, buffer, expectedBytes);
			expect.soft(tracked.hasChanges(), "safe bound-call rejection remains clean").toBe(false);
			expect([...tracked.changedKeys()]).toEqual([]);
		}
	);

	it("keeps a benign custom getter using this.byteLength available and clean", () => {
		const { backing, buffer } = dedicatedBuffer([31, 32, 33, 34]);
		const tracked = trackMutations({ buffer, untouched: { marker: "stable" } });
		const exposedBacking = tracked.proxy.buffer.buffer;
		defineExposedGetter(exposedBacking, "observedByteLength", function (this: ArrayBuffer): number {
			return this.byteLength;
		});

		expect.soft(Reflect.get(exposedBacking, "observedByteLength")).toBe(backing.byteLength);
		expect.soft(tracked.hasChanges()).toBe(false);
		expect([...tracked.changedKeys()]).toEqual([]);
	});

	it.skipIf(typeof capturedResize !== "function")(
		"decides getter-mediated resize from call-time context, promotion and final-owner removal",
		() => {
			const expectedBytes = [41, 42, 43, 44];
			const { backing, buffer } = dedicatedBuffer(expectedBytes, resizableBacking(4, 8));
			const tracked = trackMutations({ context: { buffer }, promoted: null as Buffer | null });
			const exposedBacking = tracked.proxy.context.buffer.buffer;
			let requestedLength = 5;
			defineExposedGetter(exposedBacking, "resizeNow", function (this: ArrayBuffer): unknown {
				return invokeNativeThroughReceiver(this, "resize", requestedLength);
			});

			expect.soft(capture(() => Reflect.get(exposedBacking, "resizeNow"))).toMatchObject({ ok: true });
			expect.soft(backing.byteLength, "context-only accessor work remains available").toBe(5);
			expect.soft(tracked.hasChanges(), "context-only resize remains clean").toBe(false);

			tracked.proxy.promoted = tracked.proxy.context.buffer;
			requestedLength = 6;
			const governedResult = capture(() => Reflect.get(exposedBacking, "resizeNow"));
			expect.soft(governedResult.ok, "promotion must activate lookup-time protection").toBe(false);
			expect.soft(governedResult.error).toBeInstanceOf(TypeError);
			expect.soft((governedResult.error as Error | undefined)?.message).toBe(GOVERNED_BUFFER_TRANSFER_ERROR);
			expectIntact(backing, buffer, expectedBytes, 5);

			tracked.proxy.promoted = null;
			expect.soft(capture(() => Reflect.get(exposedBacking, "resizeNow"))).toMatchObject({ ok: true });
			expect(backing.byteLength, "final governed-owner removal restores context-only availability").toBe(6);
		}
	);

	it.skipIf(representativeTransfer === undefined)(
		"rejects awaited local authoring before native validation, detachment, vertex creation or publication",
		async () => {
			const h = accessorHarness();
			const backing = h.rawDRP.buffer.buffer;
			const liveBytes = [...h.rawDRP.buffer];
			const rootBefore = DRPStateOtherTheWire.encode(
				serializeDRPState(h.states.getDRPState(HashGraph.rootHash)!)
			).finish();

			const result = await captureAsync(() => h.applier.drp!.transferInGetter());

			expect.soft(result.ok).toBe(false);
			expect.soft(result.error).toBeInstanceOf(TypeError);
			expect.soft((result.error as Error | undefined)?.message).toBe(GOVERNED_BUFFER_TRANSFER_ERROR);
			expect.soft(h.rawDRP.buffer.buffer === backing).toBe(true);
			expectIntact(backing, h.rawDRP.buffer, liveBytes);
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
