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
type TransferCapableArrayBuffer = ArrayBuffer & { transfer(newByteLength?: number): ArrayBuffer };

interface TaggedTypeError extends TypeError {
	readonly evidence: "setter-sentinel";
}

const GOVERNED_BUFFER_TRANSFER_ERROR = "Cannot structurally mutate an ArrayBuffer backing a governed Buffer";
const capturedTransfer = Reflect.get(ArrayBuffer.prototype, "transfer") as StructuralMethod | undefined;
const capturedResize = Reflect.get(ArrayBuffer.prototype, "resize") as StructuralMethod | undefined;
let faithfulApplierObservedError: unknown;

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

function defineExposedSetter(
	exposedBacking: ArrayBuffer,
	property: PropertyKey,
	setter: (this: ArrayBuffer, value: unknown) => void
): void {
	const defined = Reflect.defineProperty(exposedBacking, property, {
		configurable: true,
		set: setter,
	});
	expect.soft(defined, "the setter is installed through the exposed tracked backing").toBe(true);
	expect.soft(Reflect.getOwnPropertyDescriptor(exposedBacking, property)?.set).toBe(setter);
}

function invokeSetter(exposedBacking: ArrayBuffer, property: PropertyKey, value: unknown): boolean {
	return Reflect.set(exposedBacking, property, value, exposedBacking);
}

function invokeSetterWithReceiver(
	exposedBacking: ArrayBuffer,
	property: PropertyKey,
	value: unknown,
	receiver: object
): boolean {
	return Reflect.set(exposedBacking, property, value, receiver);
}

function expectClean(tracked: ReturnType<typeof trackMutations>): void {
	expect.soft(tracked.hasChanges(), "setter work on the ignored backing remains clean").toBe(false);
	expect.soft(tracked.hasRawEgress(), "the proxy-only setter path does not report raw egress").toBe(false);
	expect.soft([...tracked.changedKeys()]).toEqual([]);
	expect.soft([...tracked.rawEgressCandidateKeys()]).toEqual([]);
}

function expectGovernedRejection(
	result: Captured<unknown>,
	backing: ArrayBuffer,
	buffer: Buffer,
	expectedBytes: readonly number[]
): void {
	expect.soft(result.ok, "setter-mediated structural mutation must reject").toBe(false);
	expect.soft(result.error).toBeInstanceOf(TypeError);
	expect.soft((result.error as Error | undefined)?.message).toBe(GOVERNED_BUFFER_TRANSFER_ERROR);
	expect.soft(backing.byteLength, "governed backing must remain attached").toBe(expectedBytes.length);
	expect.soft(capture(() => [...new Uint8Array(backing)])).toEqual({ ok: true, value: expectedBytes });
	expect.soft(capture(() => [...buffer])).toEqual({ ok: true, value: expectedBytes });
}

function expectOriginalError(result: Captured<unknown>, expectedError: unknown, expectedMessage: string): void {
	expect.soft(result.ok).toBe(false);
	expect.soft(result.error, "the exact error observed inside the setter must propagate").toBe(expectedError);
	expect.soft((result.error as Error | undefined)?.message).toBe(expectedMessage);
}

function liveProxyReceiverError(method: StructuralMethod): TypeError {
	const result = capture(() => Reflect.apply(method, new Proxy(new ArrayBuffer(1), {}), []));
	expect.soft(result.ok, "the engine rejects a proxy without ArrayBuffer internal slots").toBe(false);
	expect.soft(result.error).toBeInstanceOf(TypeError);
	return result.error as TypeError;
}

class SetterFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context = { caller: "" };
	buffer: Buffer;
	untouched = { marker: "stable" };

	constructor() {
		this.buffer = dedicatedBuffer().buffer;
	}

	transferInSetter(): void {
		const exposedBacking = this.buffer.buffer;
		defineExposedSetter(exposedBacking, "structuralSetter", function (this: ArrayBuffer): void {
			// Invalid length keeps the awaited oracle bounded while proving that
			// proxy receiver fails the native brand check before argument validation.
			try {
				Reflect.apply(capturedTransfer!, this, [-1]);
			} catch (error) {
				faithfulApplierObservedError = error;
				throw error;
			}
		});
		invokeSetter(exposedBacking, "structuralSetter", true);
	}
}

class PublicationProbe {
	readonly publications: PublicationRecord[] = [];

	observe(event: PublicationObserverEvent): unknown {
		if (event.type === "copy") return detachStatePayload(event.value);
		this.publications.push(event.record);
	}
}

function setterHarness(): {
	rawDRP: SetterFixture;
	applier: DRPVertexApplier<SetterFixture>;
	hashGraph: HashGraph;
	probe: PublicationProbe;
	states: DRPObjectStateManager<SetterFixture>;
} {
	const rawDRP = new SetterFixture();
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
	const Applier = DRPVertexApplier as unknown as new (candidate: typeof options) => DRPVertexApplier<SetterFixture>;
	return { rawDRP, applier: new Applier(options), hashGraph, probe, states };
}

describe("Phase 1d(i) D.92.3-P3b backing setter receiver", () => {
	it.skipIf(typeof capturedTransfer !== "function")(
		"rejects direct this.transfer() in a setter before it can detach governed Buffer storage",
		() => {
			const expectedBytes = [11, 12, 13, 14];
			const { backing, buffer } = dedicatedBuffer(expectedBytes);
			const tracked = trackMutations({ buffer, untouched: { marker: "stable" } });
			const exposedBacking = tracked.proxy.buffer.buffer;
			defineExposedSetter(exposedBacking, "directTransfer", function (this: ArrayBuffer): void {
				(this as TransferCapableArrayBuffer).transfer();
			});
			expectClean(tracked);

			const result = capture(() => invokeSetter(exposedBacking, "directTransfer", true));

			expectGovernedRejection(result, backing, buffer, expectedBytes);
			expectClean(tracked);
		}
	);

	it.skipIf(typeof capturedTransfer !== "function")(
		"preserves the engine error from a captured native transfer called with the custom setter receiver",
		() => {
			const expectedBytes = [21, 22, 23, 24];
			const { backing, buffer } = dedicatedBuffer(expectedBytes);
			const tracked = trackMutations({ buffer, untouched: { marker: "stable" } });
			const exposedBacking = tracked.proxy.buffer.buffer;
			let observedError: unknown;
			defineExposedSetter(exposedBacking, "capturedTransfer", function (this: ArrayBuffer): void {
				try {
					Reflect.apply(capturedTransfer!, this, []);
				} catch (error) {
					observedError = error;
					throw error;
				}
			});

			const result = capture(() => invokeSetter(exposedBacking, "capturedTransfer", true));

			expect.soft(observedError).toBeInstanceOf(TypeError);
			expectOriginalError(result, observedError, (observedError as Error).message);
			expect.soft((result.error as Error).message).not.toBe(GOVERNED_BUFFER_TRANSFER_ERROR);
			expect.soft(backing.byteLength).toBe(expectedBytes.length);
			expect.soft([...buffer]).toEqual(expectedBytes);
			expectClean(tracked);
		}
	);

	it.skipIf(typeof capturedTransfer !== "function")(
		"preserves a setter-authored TypeError that coincides with the live engine brand text",
		() => {
			const { backing, buffer } = dedicatedBuffer([25, 26, 27, 28]);
			const tracked = trackMutations({ buffer, untouched: { marker: "stable" } });
			const exposedBacking = tracked.proxy.buffer.buffer;
			const liveEngineError = liveProxyReceiverError(capturedTransfer!);
			const sentinel = Object.assign(new TypeError(liveEngineError.message), {
				evidence: "setter-sentinel" as const,
			});
			defineExposedSetter(exposedBacking, "coincidentError", function (): void {
				throw sentinel;
			});

			const result = capture(() => invokeSetter(exposedBacking, "coincidentError", true));

			expectOriginalError(result, sentinel, liveEngineError.message);
			expect.soft((result.error as TaggedTypeError).evidence).toBe("setter-sentinel");
			expect.soft(backing.byteLength).toBe(4);
			expect.soft([...buffer]).toEqual([25, 26, 27, 28]);
			expectClean(tracked);
		}
	);

	it.skipIf(typeof capturedTransfer !== "function")(
		"preserves the engine error from a captured native applied to a foreign ArrayBuffer proxy receiver",
		() => {
			const { backing, buffer } = dedicatedBuffer([29, 30, 31, 32]);
			const tracked = trackMutations({ buffer, untouched: { marker: "stable" } });
			const exposedBacking = tracked.proxy.buffer.buffer;
			const foreignBacking = new ArrayBuffer(3);
			const foreignProxy = new Proxy(foreignBacking, {});
			let observedError: unknown;
			defineExposedSetter(exposedBacking, "foreignProxy", function (this: ArrayBuffer): void {
				try {
					Reflect.apply(capturedTransfer!, this, []);
				} catch (error) {
					observedError = error;
					throw error;
				}
			});

			const result = capture(() => invokeSetterWithReceiver(exposedBacking, "foreignProxy", true, foreignProxy));

			expect.soft(observedError).toBeInstanceOf(TypeError);
			expectOriginalError(result, observedError, (observedError as Error).message);
			expect.soft(foreignBacking.byteLength).toBe(3);
			expect.soft(backing.byteLength).toBe(4);
			expect.soft([...buffer]).toEqual([29, 30, 31, 32]);
			expectClean(tracked);
		}
	);

	it.skipIf(typeof capturedTransfer !== "function")(
		"does not replay structural natives against a genuine foreign ArrayBuffer receiver after a setter throws",
		() => {
			const { backing, buffer } = dedicatedBuffer([33, 34, 35, 36]);
			const tracked = trackMutations({ buffer, untouched: { marker: "stable" } });
			const exposedBacking = tracked.proxy.buffer.buffer;
			const foreignBacking = new ArrayBuffer(4);
			const foreignBytes = new Uint8Array(foreignBacking);
			foreignBytes.set([91, 92, 93, 94]);
			const sentinel = Object.assign(new TypeError("setter failed before touching its receiver"), {
				evidence: "setter-sentinel" as const,
			});
			defineExposedSetter(exposedBacking, "foreignBacking", function (): void {
				throw sentinel;
			});

			const result = capture(() => invokeSetterWithReceiver(exposedBacking, "foreignBacking", true, foreignBacking));

			expectOriginalError(result, sentinel, sentinel.message);
			expect.soft((result.error as TaggedTypeError).evidence).toBe("setter-sentinel");
			expect.soft(foreignBacking.byteLength, "error classification must not detach the caller's receiver").toBe(4);
			expect.soft(capture(() => [...foreignBytes])).toEqual({ ok: true, value: [91, 92, 93, 94] });
			expect.soft(backing.byteLength).toBe(4);
			expect.soft([...buffer]).toEqual([33, 34, 35, 36]);
			expectClean(tracked);
		}
	);

	it("keeps a benign custom setter using this.byteLength available and clean", () => {
		const { backing, buffer } = dedicatedBuffer([31, 32, 33, 34]);
		const tracked = trackMutations({ buffer, untouched: { marker: "stable" } });
		const exposedBacking = tracked.proxy.buffer.buffer;
		let observation: { byteLength: number; value: unknown } | undefined;
		defineExposedSetter(exposedBacking, "observe", function (this: ArrayBuffer, value: unknown): void {
			observation = { byteLength: this.byteLength, value };
		});

		expect.soft(invokeSetter(exposedBacking, "observe", "sentinel")).toBe(true);
		expect.soft(observation).toEqual({ byteLength: backing.byteLength, value: "sentinel" });
		expectClean(tracked);
	});

	it.skipIf(typeof capturedResize !== "function")(
		"decides setter-mediated resize from context, promotion and final governed-owner removal",
		() => {
			const { backing, buffer } = dedicatedBuffer([41, 42, 43, 44], resizableBacking(4, 8));
			const tracked = trackMutations({ context: { buffer }, promoted: null as Buffer | null });
			const exposedBacking = tracked.proxy.context.buffer.buffer;
			let observedError: unknown;
			defineExposedSetter(exposedBacking, "requestedLength", function (this: ArrayBuffer, value: unknown): void {
				try {
					Reflect.apply(capturedResize!, this, [value as number]);
				} catch (error) {
					observedError = error;
					throw error;
				}
			});

			expect.soft(capture(() => invokeSetter(exposedBacking, "requestedLength", 5))).toMatchObject({ ok: true });
			expect.soft(backing.byteLength, "context-only resize remains available").toBe(5);
			expectClean(tracked);

			tracked.proxy.promoted = tracked.proxy.context.buffer;
			const governedResult = capture(() => invokeSetter(exposedBacking, "requestedLength", 6));
			expect.soft(governedResult.ok, "promotion must activate setter-receiver protection").toBe(false);
			expect.soft(observedError).toBeInstanceOf(TypeError);
			expectOriginalError(governedResult, observedError, (observedError as Error).message);
			expect.soft(backing.byteLength, "governed setter call must not resize").toBe(5);
			expect.soft(tracked.hasRawEgress()).toBe(false);

			tracked.proxy.promoted = null;
			expect.soft(capture(() => invokeSetter(exposedBacking, "requestedLength", 6))).toMatchObject({ ok: true });
			expect(backing.byteLength, "final governed-owner removal restores context-only availability").toBe(6);
		}
	);

	it.skipIf(typeof capturedTransfer !== "function")(
		"rejects awaited local authoring before native validation, detachment, vertex creation or publication",
		async () => {
			const h = setterHarness();
			faithfulApplierObservedError = undefined;
			const backing = h.rawDRP.buffer.buffer;
			const liveBytes = [...h.rawDRP.buffer];
			const rootBefore = DRPStateOtherTheWire.encode(
				serializeDRPState(h.states.getDRPState(HashGraph.rootHash)!)
			).finish();

			const result = await captureAsync(() => h.applier.drp!.transferInSetter());

			expect.soft(result.ok).toBe(false);
			expect.soft(faithfulApplierObservedError).toBeInstanceOf(TypeError);
			expectOriginalError(result, faithfulApplierObservedError, (faithfulApplierObservedError as Error).message);
			expect.soft(h.rawDRP.buffer.buffer === backing).toBe(true);
			expect.soft(backing.byteLength, "live backing remains attached").toBe(liveBytes.length);
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
