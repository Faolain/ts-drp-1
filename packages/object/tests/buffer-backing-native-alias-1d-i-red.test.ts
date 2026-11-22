/* eslint-disable @typescript-eslint/no-non-null-assertion -- genesis state is established by the harness */
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
const capturedTransfers = (["transfer", "transferToFixedLength"] as const).flatMap((method) => {
	const member = Reflect.get(ArrayBuffer.prototype, method) as StructuralMethod | undefined;
	return typeof member === "function" ? [{ member, method }] : [];
});
const representativeTransfer = capturedTransfers[0];
const capturedResize = Reflect.get(ArrayBuffer.prototype, "resize") as StructuralMethod | undefined;

function resizableBacking(byteLength: number, maxByteLength: number): ArrayBuffer {
	const ResizableArrayBuffer = ArrayBuffer as unknown as new (
		length: number,
		options: { maxByteLength: number }
	) => ArrayBuffer;
	return new ResizableArrayBuffer(byteLength, { maxByteLength });
}

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

function setOwnMethod(backing: ArrayBuffer, property: PropertyKey, member: StructuralMethod): void {
	const assigned = Reflect.set(backing, property, member);
	expect.soft(assigned, "the ordinary own-method assignment remains available").toBe(true);
	expect.soft(Reflect.getOwnPropertyDescriptor(backing, property)?.value).toBe(member);
}

function callOwnMethod(backing: ArrayBuffer, property: PropertyKey, ...args: number[]): unknown {
	const member = Reflect.get(backing, property) as StructuralMethod;
	return Reflect.apply(member, backing, args);
}

function expectGovernedRejection(
	result: Captured<unknown>,
	backing: ArrayBuffer,
	buffer: Buffer,
	expectedBytes: readonly number[],
	expectedByteLength = expectedBytes.length
): void {
	expect.soft(result.ok, "captured structural native must reject").toBe(false);
	expect.soft(result.error).toBeInstanceOf(TypeError);
	expect.soft((result.error as Error | undefined)?.message).toBe(GOVERNED_BUFFER_TRANSFER_ERROR);
	expect.soft(backing.byteLength, "backing must not detach or resize").toBe(expectedByteLength);
	expect.soft(capture(() => [...new Uint8Array(backing)])).toEqual({
		ok: true,
		value: expectedByteLength === expectedBytes.length ? expectedBytes : [...expectedBytes, 0],
	});
	expect.soft(capture(() => [...buffer])).toEqual({
		ok: true,
		value: expectedByteLength === expectedBytes.length ? expectedBytes : [...expectedBytes, 0],
	});
}

class CapturedAliasFixture implements IDRP {
	semanticsType = SemanticsType.pair;
	context = { caller: "" };
	buffer: Buffer;
	untouched = { marker: "stable" };

	constructor() {
		this.buffer = dedicatedBuffer().buffer;
	}

	transferThroughCapturedAlias(): void {
		const backing = this.buffer.buffer;
		Reflect.set(backing, "structuralAlias", representativeTransfer!.member);
		// The direct REDs above prove that a valid call detaches. An invalid native
		// length keeps this applier mirror physically intact while distinguishing
		// the required pre-native policy error from the current native RangeError.
		callOwnMethod(backing, "structuralAlias", -1);
	}
}

class PublicationProbe {
	readonly publications: PublicationRecord[] = [];

	observe(event: PublicationObserverEvent): unknown {
		if (event.type === "copy") return detachStatePayload(event.value);
		this.publications.push(event.record);
	}
}

function aliasHarness(): {
	rawDRP: CapturedAliasFixture;
	applier: DRPVertexApplier<CapturedAliasFixture>;
	hashGraph: HashGraph;
	probe: PublicationProbe;
	states: DRPObjectStateManager<CapturedAliasFixture>;
} {
	const rawDRP = new CapturedAliasFixture();
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
	) => DRPVertexApplier<CapturedAliasFixture>;
	return { rawDRP, applier: new Applier(options), hashGraph, probe, states };
}

describe("Phase 1d(i) D.92.3-P3b captured native backing aliases", () => {
	it.each(capturedTransfers)("rejects a captured native $method installed under its own key", ({ member, method }) => {
		const expectedBytes = [11, 12, 13, 14];
		const { backing, buffer } = dedicatedBuffer(expectedBytes);
		const tracked = trackMutations({ buffer, untouched: { marker: "stable" } });
		const exposedBacking = tracked.proxy.buffer.buffer;
		setOwnMethod(exposedBacking, method, member);
		expect.soft(tracked.hasChanges(), "installing an ignored backing method is not a state write").toBe(false);

		const result = capture(() => callOwnMethod(exposedBacking, method));

		expectGovernedRejection(result, backing, buffer, expectedBytes);
		expect.soft(tracked.hasChanges(), "rejection remains clean").toBe(false);
		expect([...tracked.changedKeys()]).toEqual([]);
	});

	it.skipIf(representativeTransfer === undefined)(
		"rejects a captured native transfer installed under a representative alternate key",
		() => {
			const expectedBytes = [21, 22, 23, 24];
			const { backing, buffer } = dedicatedBuffer(expectedBytes);
			const tracked = trackMutations({ buffer, untouched: { marker: "stable" } });
			const exposedBacking = tracked.proxy.buffer.buffer;
			setOwnMethod(exposedBacking, "structuralAlias", representativeTransfer!.member);

			const result = capture(() => callOwnMethod(exposedBacking, "structuralAlias"));

			expectGovernedRejection(result, backing, buffer, expectedBytes);
			expect.soft(tracked.hasChanges()).toBe(false);
			expect([...tracked.changedKeys()]).toEqual([]);
		}
	);

	it.skipIf(typeof capturedResize !== "function")(
		"rejects captured native resize on a resizable backing shared with a governed Buffer",
		() => {
			const expectedBytes = [31, 32, 33, 34];
			const { backing, buffer } = dedicatedBuffer(
				expectedBytes,
				resizableBacking(expectedBytes.length, expectedBytes.length + 4)
			);
			const tracked = trackMutations({ buffer, untouched: { marker: "stable" } });
			const exposedBacking = tracked.proxy.buffer.buffer;
			setOwnMethod(exposedBacking, "resize", capturedResize!);

			const result = capture(() => callOwnMethod(exposedBacking, "resize", expectedBytes.length + 1));

			expectGovernedRejection(result, backing, buffer, expectedBytes);
			expect.soft(tracked.hasChanges()).toBe(false);
			expect([...tracked.changedKeys()]).toEqual([]);
		}
	);

	it.skipIf(typeof capturedResize !== "function")(
		"decides captured structural aliases from call-time context, promotion and last-owner removal",
		() => {
			const { backing, buffer } = dedicatedBuffer([41, 42, 43, 44], resizableBacking(4, 8));
			const tracked = trackMutations({ context: { buffer }, promoted: null as Buffer | null });
			const exposedBacking = tracked.proxy.context.buffer.buffer;
			setOwnMethod(exposedBacking, "structuralAlias", capturedResize!);

			expect.soft(capture(() => callOwnMethod(exposedBacking, "structuralAlias", 5))).toMatchObject({ ok: true });
			expect.soft(backing.byteLength, "context-only structural work remains available").toBe(5);
			expect.soft(tracked.hasChanges()).toBe(false);

			tracked.proxy.promoted = tracked.proxy.context.buffer;
			const governedResult = capture(() => callOwnMethod(exposedBacking, "structuralAlias", 6));
			expectGovernedRejection(governedResult, backing, buffer, [41, 42, 43, 44], 5);

			tracked.proxy.promoted = null;
			expect.soft(capture(() => callOwnMethod(exposedBacking, "structuralAlias", 6))).toMatchObject({ ok: true });
			expect(backing.byteLength, "removing the final governed owner restores context-only availability").toBe(6);
		}
	);

	it.skipIf(representativeTransfer === undefined)(
		"keeps benign custom backing methods usable without handing a dangerous wrapper the raw receiver",
		() => {
			const expectedBytes = [51, 52, 53, 54];
			const { backing, buffer } = dedicatedBuffer(expectedBytes);
			Object.defineProperties(backing, {
				benign: {
					configurable: true,
					value(this: ArrayBuffer): number {
						return this.byteLength;
					},
				},
				structuralWrapper: {
					configurable: true,
					value(this: ArrayBuffer): unknown {
						return callOwnMethod(this, representativeTransfer!.method);
					},
				},
			});
			const tracked = trackMutations({ buffer, untouched: { marker: "stable" } });
			const exposedBacking = tracked.proxy.buffer.buffer;

			expect.soft(callOwnMethod(exposedBacking, "benign")).toBe(expectedBytes.length);
			expect.soft(tracked.hasChanges(), "benign custom receiver work stays clean").toBe(false);
			const result = capture(() => callOwnMethod(exposedBacking, "structuralWrapper"));

			expectGovernedRejection(result, backing, buffer, expectedBytes);
			expect.soft(tracked.hasChanges(), "rejected wrapper remains clean").toBe(false);
			expect([...tracked.changedKeys()]).toEqual([]);
		}
	);

	it.skipIf(representativeTransfer === undefined)(
		"rejects real local authoring before alias detachment, vertex creation or publication",
		async () => {
			const h = aliasHarness();
			const backing = h.rawDRP.buffer.buffer;
			const liveBytes = [...h.rawDRP.buffer];
			const rootBefore = DRPStateOtherTheWire.encode(
				serializeDRPState(h.states.getDRPState(HashGraph.rootHash)!)
			).finish();

			const result = await captureAsync(() => h.applier.drp!.transferThroughCapturedAlias());

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
